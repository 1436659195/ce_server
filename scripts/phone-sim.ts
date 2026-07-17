/**
 * phone-sim —— 调试用「假手机」。连中继 → 握手 → 收 AgentEvent → 回 resolveApproval。
 * 复用 ce-server 的 crypto/frame/ws(与真手机同原语 → E2E 互通)。验证 ce→中继→手机 审批 round-trip。
 *
 * 用法:bun run scripts/phone-sim.ts
 *   收到 PreToolUse 自动 allow 回传;60s 后退出。
 */
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, sharedSecret, seal, open } from '../src/shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../src/shared/frame'

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')

const code = JSON.parse(readFileSync(join(homedir(), '.ce', 'connection-code.json'), 'utf8')) as {
  r: string; s: string; k: string; t: string
}
const phoneKp = generateKeyPair()
const sharedKey = sharedSecret(phoneKp.privateKey, Buffer.from(code.k, 'base64'))
const phoneId = 'phone-sim-' + Math.random().toString(36).slice(2, 8)

const ws = new WebSocket(`${code.r}/${code.s}?token=${code.t}&phoneId=${phoneId}`)
ws.on('open', () => {
  // 握手:明文 Control{ phonePub(b64), id, n } —— ce 据此派生 sharedKey 存进 phoneKeys
  const payload = enc.encode(JSON.stringify({ k: b64(phoneKp.publicKey), id: phoneId, n: 'phone-sim' }))
  ws.send(dec.decode(encodeFrame({ type: FrameType.Control, payload })))
  console.log(`[phone-sim] 已连中继 sid=${code.s.slice(0, 8)}… phoneId=${phoneId},握手已发,等 AgentEvent…`)
})
ws.on('message', (raw) => {
  let frame: Frame
  try {
    frame = decodeFrame(raw as Uint8Array)
  } catch {
    console.log('[phone-sim] 非帧消息(hub 明文通知):', dec.decode(raw as Uint8Array).slice(0, 100))
    return
  }
  let pt: Uint8Array
  try {
    pt = open(sharedKey, frame.payload)
  } catch {
    console.log('[phone-sim] 解密失败(可能错 key / 未配对)')
    return
  }
  const text = dec.decode(pt)
  if (frame.type === FrameType.AgentEvent) {
    const ev = JSON.parse(text) as { kind: string; reqId?: string; tool?: string; input?: unknown }
    console.log('[phone-sim] ← AgentEvent:', JSON.stringify(ev).slice(0, 200))
    if (ev.kind === 'PreToolUse' && ev.reqId) {
      // 自动 allow:回 resolveApproval RPC(payload.reqId = ce 的审批 id;frame.reqId = RPC 信封 id)
      const rpcReqId = Math.random().toString(36).slice(2, 10)
      const body = seal(sharedKey, enc.encode(JSON.stringify({ op: 'resolveApproval', reqId: ev.reqId, decision: 'allow' })))
      ws.send(dec.decode(encodeFrame({ type: FrameType.RPCReq, reqId: rpcReqId, payload: body })))
      console.log(`[phone-sim] → resolveApproval approvalReqId=${ev.reqId} allow`)
    }
  } else {
    console.log(`[phone-sim] 帧 type=${frame.type}:`, text.slice(0, 100))
  }
})
ws.on('close', () => {
  console.log('[phone-sim] 断开')
  process.exit(0)
})
ws.on('error', (e) => console.error('[phone-sim] ws 错:', (e as Error).message))

setTimeout(() => {
  console.log('[phone-sim] 60s 到,退出')
  process.exit(0)
}, 60000)
