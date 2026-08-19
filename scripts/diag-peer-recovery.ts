/**
 * diag-peer-recovery —— 用一个"模拟手机"(独立 phoneId,不影响真机)打真实中继,
 * 验证掉线恢复链路的每一跳:cliLeft 送达 / 重握手补发 / 探活 RPC 应答。
 *
 * 用法(三段交互):
 *   bun run scripts/diag-peer-recovery.ts <pin>
 * 阶段①连上即握手 + listTerminals(验 E2E+RPC 通);
 *   之后常驻,收到 cliLeft 打时间戳,并立即【重握手 + 探活】(模拟 app 的 onPeerOffline 行为:
 *   帧进中继 cliBuffer 缓冲,daemon 回来补发)——探活 resolve 即打印恢复耗时。
 */
import WebSocket from 'ws'
import { sharedSecret, seal, open, generateKeyPair } from '../src/shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../src/shared/frame'

const RELAY = 'ws://101.132.161.59:8606'
const SID = '755eb9c8dd0a1ced27d7a3f60ace42cd'
const TOKEN = '58a5dbabb4a5d3c28d391634'
const CLIPUB_B64 = 'RDx4zKFUU0wtD6PLiRUCWAOUxSB6j5QVVNaD+6pQcE8='
const PHONE_ID = 'diag-peer-recovery'
const PIN = process.argv[2] ?? ''

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const b64d = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))
const t0 = Date.now()
const log = (...a: unknown[]): void => console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a)

const kp = generateKeyPair()
const shared = sharedSecret(kp.privateKey, b64d(CLIPUB_B64))
const pending = new Map<string, { res: (v: unknown) => void; rej: (e: Error) => void; to: ReturnType<typeof setTimeout> }>()
let reqSeq = 0
let droppedAt = 0

const ws = new WebSocket(`${RELAY}/${SID}?token=${TOKEN}&phoneId=${PHONE_ID}`)

function sendHandshake(): void {
  ws.send(encodeFrame({ type: FrameType.Control, payload: enc.encode(JSON.stringify({ k: b64(kp.publicKey), id: PHONE_ID, n: 'diag', ...(PIN ? { pin: PIN } : {}) })) }))
  log('→ 握手(含 pin:' + (PIN ? 'yes' : 'no') + ')')
}

function rpc(op: string, timeoutMs = 4000): Promise<unknown> {
  const reqId = `diag${++reqSeq}`
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(reqId); rej(new Error(`${op} ${timeoutMs}ms 超时`)) }, timeoutMs)
    pending.set(reqId, { res, rej, to })
    ws.send(encodeFrame({ type: FrameType.RPCReq, reqId, payload: seal(shared, enc.encode(JSON.stringify({ op }))) }))
    log(`→ RPC ${op} (reqId=${reqId})`)
  })
}

ws.on('open', () => {
  log(`已连中继(phoneId=${PHONE_ID})`)
  sendHandshake()
  // 给握手一点落地时间再探
  setTimeout(() => {
    rpc('listTerminals')
      .then((r) => {
        const n = (r as { data?: { terminals?: unknown[] } })?.data?.terminals?.length
        log(`✓ 阶段①探活成功:listTerminals 返回 ${n} 个终端(E2E+RPC 全通,常驻等 cliLeft…)`)
      })
      .catch((e: Error) => log(`✗ 阶段①探活失败:${e.message}`))
  }, 800)
})

ws.on('message', (raw) => {
  const s = raw.toString()
  // 明文中继控制通知(解密前识别 —— 与 app tunnel 同款)
  if (s.includes('cliLeft')) {
    droppedAt = Date.now()
    log('⟵⟵ 收到 cliLeft!(ce 掉线)→ 立即重握手 + 探活(帧将进中继 cliBuffer 缓冲)')
    sendHandshake()
    void rpc('listTerminals', 14000)
      .then((r) => {
        const n = (r as { data?: { terminals?: unknown[] } })?.data?.terminals?.length
        log(`✓✓ 恢复!探活成功(掉线后 ${((Date.now() - droppedAt) / 1000).toFixed(2)}s),listTerminals=${n} 个终端`)
      })
      .catch((e: Error) => log(`✗✗ 探活 14s 仍失败:${e.message}(app 会在此判离线)`))
    return
  }
  if (s.includes('phoneLeft')) return // 与本 diag 无关(真机的)
  let f: Frame
  try {
    f = decodeFrame(new TextEncoder().encode(s)) // ce-server 版 decodeFrame 收字节,别传 string
  } catch {
    log('  (不可解码帧:', s.slice(0, 60) + ')')
    return
  }
  if (f.type === FrameType.RPCResp && f.reqId) {
    const p = pending.get(f.reqId)
    if (p) {
      pending.delete(f.reqId)
      clearTimeout(p.to)
      try {
        p.res(JSON.parse(dec.decode(open(shared, f.payload))))
      } catch (e) {
        p.rej(e as Error)
      }
    }
  }
})

ws.on('close', () => log('ws 关闭'))
ws.on('error', (e: Error) => log('ws 错误:', e.message))
