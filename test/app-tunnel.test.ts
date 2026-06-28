/**
 * App 传输层端到端测试(无需真机):
 *   真实中继 + 模拟 ce(用 ce-server 真实 crypto/frame)+ App 的 Tunnel
 *   → 验证 握手 / RPC / 终端流 全链路,证明 App↔ce 的 E2E 互通。
 *
 * 注:此测试跨项目 import App 的 src/(含浏览器 DOM 全局如 WebSocket/btoa),
 * 故从 ce-server 的 tsconfig 排除(由 bun test 运行,不进 ce-server 的 tsc)。
 */
import { test, expect } from 'bun:test'
import WebSocket from 'ws'
import { createRelayServer } from '../src/relay/server'
import { Hub } from '../src/relay/hub'
// ce 侧:真实 crypto + frame
import { generateKeyPair, sharedSecret, seal, open } from '../src/shared/crypto'
import { encodeFrame as ceEncode, decodeFrame as ceDecode, FrameType as CeFT } from '../src/shared/frame'
// App 侧:被测的 Tunnel
import { Tunnel, type WSFactory } from '../../src/composables/tunnel'

const enc = new TextEncoder()
const dec = new TextDecoder()

// Node ws → Tunnel 的 WSFactory 适配(测试用;App 里用 browserWS)
const nodeWS: WSFactory = (url, h) => {
  const ws = new WebSocket(url)
  ws.on('error', (e) => h.onerror(e)) // WSHandlers 需 onerror
  ws.on('open', () => h.onopen())
  ws.on('message', (data) => h.onmessage(data.toString()))
  ws.on('close', () => h.onclose())
  return { send: (d) => ws.send(d), close: () => ws.close() }
}

test('App Tunnel ↔ 中继 ↔ ce:握手 + RPC + 终端流 全链路', async () => {
  const { server, close } = createRelayServer(new Hub())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base = `ws://127.0.0.1:${port}`

  // ── 模拟 ce:连中继注册,拿 sid+token ──
  const cliKp = generateKeyPair()
  const cliWs = new WebSocket(base + '/')
  cliWs.on('error', () => {})
  const reg = await new Promise<{ sid: string; token: string }>((resolve) => {
    cliWs.on('message', function h(raw) {
      const m = JSON.parse(raw.toString())
      if (m.type === 'registered') {
        cliWs.off('message', h)
        resolve({ sid: m.sid, token: m.token })
      }
    })
  })
  const qr = {
    r: base,
    s: reg.sid,
    k: Buffer.from(cliKp.publicKey).toString('base64'),
    t: reg.token,
  }

  // ce 桥接状态
  let cliSharedKey: Uint8Array | null = null
  const stdinReceived: Record<string, string> = {}
  cliWs.on('message', (raw) => {
    const data = raw.toString()
    let m: { type: unknown }
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    if (typeof m.type === 'string') return // 中继控制消息(registered 等),忽略
    const frame = ceDecode(raw as Uint8Array) // ce 的 decodeFrame 接 Uint8Array/Buffer
    if (!cliSharedKey) {
      // 握手 Control 帧:phone 公钥(明文 b64)
      if (frame.type === CeFT.Control) {
        const phonePub = new Uint8Array(Buffer.from(dec.decode(frame.payload), 'base64'))
        cliSharedKey = sharedSecret(cliKp.privateKey, phonePub)
      }
      return
    }
    let pt: Uint8Array
    try {
      pt = open(cliSharedKey, frame.payload)
    } catch {
      return
    }
    if (frame.type === CeFT.RPCReq) {
      const req = JSON.parse(dec.decode(pt))
      const resp = { ok: true, data: { op: req.op, echoed: true } }
      cliWs.send(
        ceEncode({
          type: CeFT.RPCResp,
          reqId: frame.reqId,
          payload: seal(cliSharedKey, enc.encode(JSON.stringify(resp))),
        })
      )
    } else if (frame.type === CeFT.TermStdin && frame.sid) {
      stdinReceived[frame.sid] = (stdinReceived[frame.sid] ?? '') + dec.decode(pt)
    }
  })

  // ── App 侧 Tunnel(phone)──
  const tunnel = new Tunnel(qr, nodeWS)
  tunnel.connect()
  await tunnel.readyPromise

  // 1) RPC:phone(app crypto)发 → ce(ce crypto)解密+回 → phone 解密
  const resp = await tunnel.rpc({ op: 'listDir', path: '/' })
  expect(resp).toEqual({ ok: true, data: { op: 'listDir', echoed: true } })

  // 2) 终端 stdin:phone 发 → ce 收到明文
  tunnel.sendStdin('term-1', 'ls -la\n')
  await new Promise((r) => setTimeout(r, 50))
  expect(stdinReceived['term-1']).toBe('ls -la\n')

  // 3) 终端 stdout:ce 发 → phone onOutput 收到
  let output = ''
  tunnel.onOutput((_sid, text) => {
    output += text
  })
  if (cliSharedKey) {
    cliWs.send(
      ceEncode({
        type: CeFT.TermOutput,
        sid: 'term-1',
        payload: seal(cliSharedKey, enc.encode('hello $ ')),
      })
    )
  }
  await new Promise((r) => setTimeout(r, 50))
  expect(output).toBe('hello $ ')

  tunnel.close()
  cliWs.close()
  await close()
})
