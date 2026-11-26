import { test, expect, afterEach } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket as Sock } from 'ws'
import { generateKeyPair, open, seal, sharedSecret } from '../src/shared/crypto'
import { decodeFrame, encodeFrame, FrameType, type Frame } from '../src/shared/frame'
import { grantMac } from '../src/cli/remote-grants'
import { RemotePeer, type RemoteTicket } from '../src/cli/remote-peer'

// RemotePeer:本机 ce 以「带凭证的设备」身份连到另一台机器。
// 这里起一个假的「中继 + 对端 ce」:校验 token、按 hub 的规矩注入来源、按 ce 的规矩握手和回话,全程真加密。

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))
const KEY = Buffer.alloc(32, 9).toString('base64')
const PEER = 'grant-abc123def456'

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

function fakeTarget(opts: { reject?: boolean; silent?: boolean; drop?: boolean } = {}) {
  const cli = generateKeyPair()
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const state = {
    shared: null as Uint8Array | null,
    previous: null as Uint8Array | null,
    handshakes: [] as Array<{ k: string; g: { id: string; mac: string } }>,
    phoneIds: [] as string[],
    received: [] as unknown[],
    sockets: [] as Sock[],
  }
  const send = (ws: Sock, frame: Frame) => ws.send(encodeFrame(frame))
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url!, 'http://localhost')
    state.phoneIds.push(url.searchParams.get('phoneId') ?? '')
    if (url.searchParams.get('token') !== 'tok-1') {
      ws.close()
      return
    }
    state.sockets.push(ws)
    ws.on('message', (raw) => {
      let frame: Frame
      try {
        frame = decodeFrame(new Uint8Array(raw as ArrayBuffer))
      } catch {
        return
      }
      if (frame.type === FrameType.Control) {
        // 明文握手可解析;密文的 resize 解不开成 JSON,落到下面按密文处理
        let hs: { k?: string; g?: { id: string; mac: string } } | undefined
        try {
          hs = JSON.parse(dec.decode(frame.payload))
        } catch {
          hs = undefined
        }
        if (hs?.k && hs.g) {
          // 明文握手:证明 = 密钥对本次临时公钥的 HMAC
          state.handshakes.push(hs as { k: string; g: { id: string; mac: string } })
          if (opts.reject || hs.g.id !== 'grant_abc' || hs.g.mac !== grantMac(KEY, hs.k)) {
            send(ws, { type: FrameType.PairReject, targetPhoneId: PEER, payload: enc.encode(JSON.stringify({ reason: 'grant_invalid' })) })
            return
          }
          state.previous = state.shared
          state.shared = sharedSecret(cli.privateKey, unb64(hs.k))
          return
        }
      }
      if (!state.shared) return
      const text = dec.decode(open(state.shared, frame.payload))
      if (frame.type === FrameType.RPCReq) {
        const plain = JSON.parse(text) as { op: string }
        state.received.push({ kind: 'rpc', op: plain.op })
        if (opts.drop) {
          ws.close()
          return
        }
        if (!opts.silent && frame.reqId) send(ws, { type: FrameType.RPCResp, reqId: frame.reqId, targetPhoneId: PEER, payload: seal(state.shared, enc.encode(JSON.stringify({ ok: true, echo: plain.op }))) })
      } else {
        // stdin 是裸文本,resize 是 JSON
        state.received.push({ kind: frame.type === FrameType.Control ? 'control' : 'stdin', sid: frame.sid, plain: frame.type === FrameType.Control ? JSON.parse(text) : text })
      }
    })
  })
  return {
    state,
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
    },
    cliPub: b64(cli.publicKey),
    pushOutput: (sid: string, text: string, key = state.shared!) => send(state.sockets.at(-1)!, { type: FrameType.TermOutput, sid, targetPhoneId: PEER, payload: seal(key, enc.encode(text)) }),
    pushControl: (msg: Record<string, unknown>) => send(state.sockets.at(-1)!, { type: FrameType.Control, targetPhoneId: PEER, payload: seal(state.shared!, enc.encode(JSON.stringify(msg))) }),
    pushText: (text: string) => state.sockets.at(-1)!.send(text),
    async close(): Promise<void> {
      for (const c of wss.clients) c.terminate()
      server.closeAllConnections()
      await new Promise<void>((r) => {
        server.close(() => r())
        setTimeout(r, 500) // 兜底:被 terminate 的连接偶发不回调,不让清理挂住
      })
    },
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c() // 后建的先关:先关客户端,再关服务端
})

async function setup(opts: Parameters<typeof fakeTarget>[0] = {}) {
  const t = fakeTarget(opts)
  const relayUrl = await t.listen()
  cleanups.push(() => t.close())
  const ticket: RemoteTicket = { grantId: 'grant_abc', key: KEY, peerId: PEER, relayUrl, sid: 'sess-1', cliPub: t.cliPub, token: 'tok-1' }
  return { t, ticket }
}

test('连接:握手带临时公钥和 HMAC 证明,不带密钥;第一个请求的响应确认握手成功', async () => {
  const { t, ticket } = await setup()
  const peer = await RemotePeer.connect(ticket)
  cleanups.push(async () => peer.close())
  expect(t.state.phoneIds).toEqual([PEER])
  expect(t.state.handshakes).toHaveLength(1)
  expect(JSON.stringify(t.state.handshakes[0])).not.toContain(KEY)
  expect(t.state.handshakes[0].g.id).toBe('grant_abc')
  expect(t.state.handshakes[0].k).toBe(peer.phonePubB64)
  expect(await peer.rpc<{ ok: boolean; echo: string }>({ op: 'listTerminals' })).toEqual({ ok: true, echo: 'listTerminals' })
})

test('凭证被拒:连接失败并说明原因,不留半开的通道', async () => {
  const { ticket } = await setup({ reject: true })
  await expect(RemotePeer.connect(ticket)).rejects.toThrow(/grant_invalid/)
})

test('握手后对端不回话:按超时报错;对端直接断开:按断开报错', async () => {
  const silent = await setup({ silent: true })
  await expect(RemotePeer.connect(silent.ticket, { timeoutMs: 200 })).rejects.toThrow(/超时/)
  const drop = await setup({ drop: true })
  await expect(RemotePeer.connect(drop.ticket)).rejects.toThrow(/断开|中断/)
})

test('终端输出和控制通知分路上报;对端离线通知也上报', async () => {
  const { t, ticket } = await setup()
  const peer = await RemotePeer.connect(ticket)
  cleanups.push(async () => peer.close())
  const out: string[] = []
  const controls: Record<string, unknown>[] = []
  const states: string[] = []
  peer.onOutput = (sid, text) => out.push(`${sid}:${text}`)
  peer.onControl = (msg) => controls.push(msg)
  peer.onState = (state) => states.push(state)
  t.pushOutput('term-1', 'hello')
  t.pushControl({ op: 'grantRevoked', grantId: 'grant_abc' })
  t.pushText(JSON.stringify({ type: 'cliLeft' }))
  await waitFor(() => out.length === 1 && controls.length === 1 && states.includes('offline'))
  expect(out).toEqual(['term-1:hello'])
  expect(controls[0]).toMatchObject({ op: 'grantRevoked' })
})

test('重连换新密钥:上一条连接的旧密钥封的帧解不开,直接丢弃', async () => {
  const { t, ticket } = await setup()
  const first = await RemotePeer.connect(ticket)
  const stale = t.state.shared!
  first.close()
  await Bun.sleep(30)
  const second = await RemotePeer.connect(ticket)
  cleanups.push(async () => second.close())
  expect(second.phonePubB64).not.toBe(first.phonePubB64)
  expect(Buffer.from(t.state.previous!).equals(Buffer.from(stale))).toBe(true)
  const out: string[] = []
  second.onOutput = (_sid, text) => out.push(text)
  t.pushOutput('term-1', 'stale', stale)
  t.pushOutput('term-1', 'fresh')
  await waitFor(() => out.length === 1)
  await Bun.sleep(30)
  expect(out).toEqual(['fresh'])
})

test('接上终端和敲字都是密文帧,带上终端名和实例指纹', async () => {
  const { t, ticket } = await setup()
  const peer = await RemotePeer.connect(ticket)
  cleanups.push(async () => peer.close())
  peer.attach('term-1', 'finger-1', 24, 200)
  peer.stdin('term-1', 'echo hi\r')
  await waitFor(() => t.state.received.length === 3)
  expect(t.state.received[1]).toEqual({ kind: 'control', sid: 'term-1', plain: { op: 'resize', rows: 24, cols: 200, finger: 'finger-1' } })
  expect(t.state.received[2]).toEqual({ kind: 'stdin', sid: 'term-1', plain: 'echo hi\r' })
})

test('关闭后再发请求:立即报错,不会一直挂着', async () => {
  const { ticket } = await setup()
  const peer = await RemotePeer.connect(ticket)
  peer.close()
  await expect(peer.rpc({ op: 'listTerminals' })).rejects.toThrow(/断开|中断/)
})
