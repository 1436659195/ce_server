import { test, expect } from 'bun:test'
import WebSocket, { type RawData } from 'ws'
import { createRelayServer } from '../src/relay/server'
import { Hub } from '../src/relay/hub'

// 等一条 JSON 控制消息(匹配 predicate),解析返回;非 JSON(如纯文本数据)忽略
function waitForJson(ws: WebSocket, predicate: (m: { type: string }) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const h = (raw: RawData) => {
      try {
        const m = JSON.parse((raw as Buffer).toString())
        if (predicate(m)) {
          ws.off('message', h)
          resolve(m)
        }
      } catch {
        /* 非控制帧,忽略 */
      }
    }
    ws.on('message', h)
  })
}

// 等一条原始文本消息(密文透传的内容)
function waitForText(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    const h = (raw: RawData) => {
      ws.off('message', h)
      resolve((raw as Buffer).toString())
    }
    ws.on('message', h)
  })
}

// 建 client 并挂空 'error' 处理器:close() 强制 terminate 服务端连接时,client 侧可能触发
// 'error',不处理会变成未捕获异常 → 测试假失败。
function connect(url: string): WebSocket {
  const ws = new WebSocket(url)
  ws.on('error', () => {})
  return ws
}

// 关掉所有 client 并留出 close 握手时间,再关 server。
// 关键:必须让 client 自行 close 并等握手走完,否则服务端主动关掉、客户端未回 ack 的连接
// 会让 server.close 的回调永不触发 → 测试 hang。
async function shutdown(
  close: () => Promise<void>,
  ...clients: WebSocket[]
): Promise<void> {
  for (const c of clients) {
    try {
      c.close()
    } catch {
      /* 已关闭 */
    }
  }
  await new Promise((r) => setTimeout(r, 150))
  await close()
}

test('端到端:cli ↔ phone 经中继互发密文(真实 ws)', async () => {
  const { server, close } = createRelayServer(new Hub())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base = `ws://127.0.0.1:${port}`

  const cli = connect(base + '/?cid=t1')
  const reg = await waitForJson(cli, (m) => m.type === 'registered')
  expect(reg.sid).toBeTruthy()
  expect(reg.token).toBeTruthy()

  const phone = connect(`${base}/${reg.sid}?token=${reg.token}`)
  await waitForJson(phone, (m) => m.type === 'joined')

  const phoneGot = waitForText(phone)
  cli.send('密文X')
  expect(await phoneGot).toBe('密文X')

  const cliGot = waitForText(cli)
  phone.send('密文Y')
  expect(await cliGot).toBe('密文Y')

  await shutdown(close, cli, phone)
})

test('错误 token 加入被拒', async () => {
  const { server, close } = createRelayServer(new Hub())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base = `ws://127.0.0.1:${port}`

  const cli = connect(base + '/?cid=t1')
  const reg = await waitForJson(cli, (m) => m.type === 'registered')

  // 错误 token(ASCII,避免裸中文进 WS URL 导致连接异常)
  const phone = connect(`${base}/${reg.sid}?token=wrong-token`)
  const err = await waitForJson(phone, (m) => m.type === 'error')
  expect(err.reason).toBeTruthy()

  await shutdown(close, cli, phone)
})
