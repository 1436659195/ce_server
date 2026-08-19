/**
 * diag-relay-restart —— 模拟手机的【中继断开恢复】行为(与 app Tunnel 同节奏),
 * 验证 relay 重启场景:WS 断 → 2s 重试环 → 被拒(session 未建)再重试 → 加入成功 →
 * 握手 + 探活 → 恢复。全程打时间戳,与中继侧 '[relay] phone …' 日志对照定位卡点。
 *
 * 用法:bun run scripts/diag-relay-restart.ts <pin>
 */
import WebSocket from 'ws'
import { sharedSecret, seal, open, generateKeyPair } from '../src/shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../src/shared/frame'

const RELAY = 'ws://101.132.161.59:8606'
const SID = '755eb9c8dd0a1ced27d7a3f60ace42cd'
const TOKEN = '58a5dbabb4a5d3c28d391634'
const CLIPUB_B64 = 'RDx4zKFUU0wtD6PLiRUCWAOUxSB6j5QVVNaD+6pQcE8='
const PHONE_ID = 'diag-relay-restart'
const PIN = process.argv[2] ?? ''

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const b64d = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))
const t0 = Date.now()
const log = (...a: unknown[]): void => console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a)

const kp = generateKeyPair()
const shared = sharedSecret(kp.privateKey, b64d(CLIPUB_B64))
let ws: WebSocket | null = null
let probeSeq = 0
let waitingProbe = false
let disconnectedAt = 0

function sendHandshake(): void {
  ws?.send(encodeFrame({ type: FrameType.Control, payload: enc.encode(JSON.stringify({ k: b64(kp.publicKey), id: PHONE_ID, n: 'diag', ...(PIN ? { pin: PIN } : {}) })) }))
}

function probe(timeoutMs = 4000): void {
  const reqId = `diag${++probeSeq}`
  let settled = false
  const onResp = (f: Frame): void => {
    if (f.type === FrameType.RPCResp && f.reqId === reqId && !settled) {
      settled = true
      log(`✓ 探活 ${reqId} 成功${disconnectedAt ? `(断开后 ${((Date.now() - disconnectedAt) / 1000).toFixed(2)}s)` : ''} → 恢复!`)
      disconnectedAt = 0
      waitingProbe = false
    }
  }
  messageHooks.push(onResp)
  setTimeout(() => {
    if (!settled) {
      settled = true
      log(`✗ 探活 ${reqId} 超时(${timeoutMs}ms)`)
      if (waitingProbe) setTimeout(() => probe(), 2000) // 探活轮换,同 app store 节奏
    }
  }, timeoutMs)
  ws?.send(encodeFrame({ type: FrameType.RPCReq, reqId, payload: seal(shared, enc.encode(JSON.stringify({ op: 'listTerminals' }))) }))
}

const messageHooks: Array<(f: Frame) => void> = []

function connect(): void {
  ws = new WebSocket(`${RELAY}/${SID}?token=${TOKEN}&phoneId=${PHONE_ID}`)
  ws.on('open', () => {
    log('WS open → 发握手')
    sendHandshake()
    if (disconnectedAt) probe() // 断线重开:立即探活(同 app onReady 钩子)
    else setTimeout(() => probe(), 800) // 首连:验通
  })
  ws.on('message', (raw) => {
    const s = raw.toString()
    if (s.includes('cliLeft')) {
      disconnectedAt = Date.now()
      waitingProbe = true
      log('⟵ cliLeft(ce 掉线)')
      return
    }
    if (s.includes('"error"')) {
      log(`⟵ relay 拒绝:${s.slice(0, 80)}`)
      return
    }
    if (s.includes('"joined"')) return
    let f: Frame
    try {
      f = decodeFrame(new TextEncoder().encode(s))
    } catch {
      return
    }
    for (const h of messageHooks) h(f)
  })
  ws.on('close', () => {
    if (!disconnectedAt) {
      disconnectedAt = Date.now()
      waitingProbe = true
      log('⟵ WS 断(中继断开!)→ 进等待,2s 后重试(同 app Tunnel 节奏)')
    } else {
      log('⟵ WS 又断(被拒后关闭)→ 2s 后重试')
    }
    setTimeout(connect, 2000)
  })
  ws.on('error', (e: Error) => log('WS error:', e.message))
}

connect()
