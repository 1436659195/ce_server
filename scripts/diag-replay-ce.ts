import WebSocket from 'ws'
import { generateKeyPair, sharedSecret, seal, open, type KeyPair } from '../src/shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../src/shared/frame'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
const enc = new TextEncoder(), dec = new TextDecoder()
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const QR = JSON.parse(readFileSync(`${homedir()}/.ce/connection-code.json`, 'utf8')) as { r: string; s: string; k: string; t: string }
const kp: KeyPair = generateKeyPair()
const sk = sharedSecret(kp.privateKey, unb64(QR.k))
let ws: WebSocket
let rpcId = 0
const rpcResolvers = new Map<string, (v: unknown) => void>()
let outBuf = ''
function send(f: Frame) { ws.send(dec.decode(encodeFrame(f))) }
function rpc(req: Record<string, unknown>): Promise<unknown> {
  const id = `r${rpcId++}`
  return new Promise(resolve => {
    rpcResolvers.set(id, resolve)
    send({ type: FrameType.RPCReq, reqId: id, payload: seal(sk, enc.encode(JSON.stringify(req))) })
    setTimeout(() => { if (rpcResolvers.has(id)) { rpcResolvers.delete(id); resolve(undefined) } }, 8000)
  })
}
await new Promise<void>((resolve, reject) => {
  ws = new WebSocket(`${QR.r}/${QR.s}?token=${QR.t}&phoneId=diag-replay`)
  ws.on('open', () => { send({ type: FrameType.Control, payload: enc.encode(JSON.stringify({ k: b64(kp.publicKey), id: 'diag-replay', n: 'diag' })) }); resolve() })
  ws.on('message', (raw) => {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
    let f: Frame; try { f = decodeFrame(bytes) } catch { return }
    if (f.type === FrameType.RPCResp && f.reqId) { const p = rpcResolvers.get(f.reqId); if (p) { rpcResolvers.delete(f.reqId); try { p(JSON.parse(dec.decode(open(sk, f.payload)))) } catch {} } return }
    if (f.type === FrameType.TermOutput) { try { outBuf += dec.decode(open(sk, f.payload)) } catch {} }
  })
  ws.on('error', reject)
})
await sleep(800)
const r = (await rpc({ op: 'createTerminal', cwd: '/' })) as { ok: boolean; data?: { name: string } }
const name = r.data!.name
console.log('终端:', name)
send({ type: FrameType.Control, sid: name, payload: seal(sk, enc.encode(JSON.stringify({ op: 'resize', rows: 24, cols: 80 }))) })
await sleep(800)
send({ type: FrameType.TermStdin, sid: name, payload: seal(sk, enc.encode('seq 1 50\r')) })
await sleep(1500)
outBuf = ''
console.log('1) detachTerminal(ce 关 terminado WS)...')
await rpc({ op: 'detachTerminal', name })
await sleep(500)
console.log('2) 再 resize(ce ensureTerm 重开 WS → 应触发 terminado 回放)...')
send({ type: FrameType.Control, sid: name, payload: seal(sk, enc.encode(JSON.stringify({ op: 'resize', rows: 24, cols: 80 }))) })
await sleep(2500)
const nums = outBuf.match(/^\d+$/gm) || []
console.log(`回放收到 ${outBuf.length} 字节,行号 ${nums.length} 个`)
console.log(nums.length >= 50 ? '✅ ce 路径回放成功!历史经 ce 回到手机' : '❌ 没回放(或只部分)')
await rpc({ op: 'deleteTerminal', name }).catch(() => {})
ws.close()
