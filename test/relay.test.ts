import { test, expect } from 'bun:test'
import WebSocket, { type RawData } from 'ws'
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net'
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

// ── 心跳:沉默客户端被判死 ───────────────────────────────────────────────
test('心跳:客户端不回 pong → 判死 terminate,cli 置空 + phone 收到 cliLeft', async () => {
  const { server, close } = createRelayServer(new Hub(), {
    heartbeat: { intervalMs: 50, maxMissed: 2 },
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base = `ws://127.0.0.1:${port}`

  // 注:Bun 自带 ws shim 不支持 autoPong:false(无脑自动回 pong),客户端侧造不出沉默连接。
  // 改用 raw TCP 停转代理:握手/注册后停掉 server→client 方向转发,后续 ping 帧到不了真客户端
  // → 无人回 pong,效果等同 half-open 死连接(能建连、无应答)。
  let upSock: Socket | null = null // 代理 ↔ relay
  const proxy = createNetServer((down) => {
    upSock = netConnect(port, '127.0.0.1')
    down.on('data', (d) => upSock?.write(d)) // client → relay:一直转发(注册帧能到)
    upSock.on('data', (d) => down.write(d)) // relay → client:仅代理停转前转发
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  const pport = (proxy.address() as { port: number }).port

  const cli = new WebSocket(`ws://127.0.0.1:${pport}/?cid=hb1`)
  cli.on('error', () => {})
  const reg = await waitForJson(cli, (m) => m.type === 'registered')
  // 停转 relay→client:server 侧 socket 停读(不 RST、不 FIN,连接"看起来还在")
  upSock?.pause()

  const phone = connect(`${base}/${reg.sid}?token=${reg.token}`)
  await waitForJson(phone, (m) => m.type === 'joined')

  // 2 次无 pong(50ms × 2 + 余量)→ 服务端 terminate cli → hub.onClose → phone 收 cliLeft
  const left = waitForJson(phone, (m) => m.type === 'cliLeft')
  expect(await left).toEqual({ type: 'cliLeft' })
  // 注:此处不 close-code 断言。实测经停转代理(upSock.pause)后,服务端 terminate 的
  // close 帧永远到不了客户端 → cli 的 'close' 事件不触发,await 即 5s 超时炸弹。
  // 判死的真断言是 phone 收到 cliLeft(上行方向仍通),足够。

  await shutdown(close, phone) // cli 已被服务端 terminate,只关 phone
  proxy.close(); upSock?.destroy()
})

// ── 心跳:正常回 pong 不误杀 ───────────────────────────────────────────
test('心跳:正常客户端(自动回 pong)跨多个心跳周期仍活', async () => {
  const { server, close } = createRelayServer(new Hub(), {
    heartbeat: { intervalMs: 30, maxMissed: 2 }, // 30ms × 5 周期 = 150ms
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const cli = connect(`ws://127.0.0.1:${port}/?cid=hb2`) // connect() 辅助:默认 autoPong 开
  const reg = await waitForJson(cli, (m) => m.type === 'registered')
  expect(reg.sid).toBeTruthy()

  // 跨 5+ 个心跳周期(默认 ws 客户端自动回 pong);若误杀,close 事件触发、发送抛错
  await new Promise((r) => setTimeout(r, 250))
  expect(cli.readyState).toBe(WebSocket.OPEN) // 仍活 = 未被误杀

  await shutdown(close, cli)
})
