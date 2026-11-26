/**
 * 「其他电脑连接」真实链路剧本:两台各自独立的 ce(模拟 A/B 机)+ 一台测试中继。
 *   用法:bun scripts/remote-computer-integration.ts --live --relay=ws://127.0.0.1:18711 \
 *           --home-b=<B机HOME> --pin-b=<PIN> [--home-a=<A机HOME>] [--pin-a=<PIN>]
 *   (模拟环境的起停见 docs/plans/ 的验收文档;脚本只连不改,不碰生产 ce/中继)
 * 验证:开授权 → 远程执行带退出码 → 越权逐个被拒 → 主人可旁观 → 撤销后连不上 → 不带凭证被拒。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { generateKeyPair, open, seal, sharedSecret } from '../src/shared/crypto'
import { decodeFrame, encodeFrame, FrameType } from '../src/shared/frame'
import { RemotePeer, type RemoteTicket } from '../src/cli/remote-peer'

if (!process.argv.includes('--live')) throw new Error('真实链路验证需要 --live')
const arg = (key: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3)
const relay = arg('relay') ?? 'ws://127.0.0.1:18711'
const homeB = arg('home-b') ?? join(homedir(), '..', 'tmp', 'ce-remote-sim', 'homeB')
const pinB = arg('pin-b') ?? ''
const trace: string[] = []
const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`) }

const enc = new TextEncoder(); const dec = new TextDecoder()
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64'); const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 扮演一部手机:连接码 + PIN 配对,握手后可以发 RPC。 */
class FakePhone {
  readonly kp = generateKeyPair()
  readonly shared: Uint8Array
  private pending = new Map<string, (v: any) => void>()
  readonly outputs: Array<{ sid: string; text: string }> = []
  readonly controls: any[] = []
  lastPairReject = ''
  onFrame: (f: ReturnType<typeof decodeFrame>) => void = () => {}
  constructor(readonly code: { r: string; s: string; k: string; t: string }, readonly phoneId: string, readonly pin: string) {
    this.shared = sharedSecret(this.kp.privateKey, unb64(code.k))
    this.ws = new WebSocket(`${code.r}/${code.s}?token=${encodeURIComponent(code.t)}&phoneId=${encodeURIComponent(phoneId)}`)
  }
  ws: WebSocket
  async connect(): Promise<void> {
    await new Promise<void>((ok, no) => { this.ws.on('open', () => ok()); this.ws.on('error', no) })
    this.ws.on('message', raw => this.onMessage(raw as Uint8Array))
    this.ws.send(dec.decode(encodeFrame({ type: FrameType.Control, payload: enc.encode(JSON.stringify({ k: b64(this.kp.publicKey), n: this.phoneId, ...(this.pin ? { pin: this.pin } : {}) })) })))
    await sleep(600)
  }
  private onMessage(raw: Uint8Array): void {
    let frame: ReturnType<typeof decodeFrame>
    try { frame = decodeFrame(raw) } catch { return }
    this.onFrame(frame)
    if (frame.type === FrameType.PairReject) { this.lastPairReject = dec.decode(frame.payload); for (const [, p] of this.pending) p({ ok: false, pairReject: this.lastPairReject }); this.pending.clear(); return }
    let text: string
    try { text = dec.decode(open(this.shared, frame.payload)) } catch { return }
    if (frame.type === FrameType.RPCResp && frame.reqId) { this.pending.get(frame.reqId)?.(JSON.parse(text)); this.pending.delete(frame.reqId) }
    else if (frame.type === FrameType.TermOutput) this.outputs.push({ sid: frame.sid ?? '', text })
    else if (frame.type === FrameType.Control) this.controls.push(JSON.parse(text))
  }
  rpc<T = any>(req: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    const reqId = `q${Math.random().toString(36).slice(2, 9)}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(`RPC 超时:${String(req.op)}`)) }, timeoutMs)
      this.pending.set(reqId, v => { clearTimeout(timer); resolve(v) })
      this.ws.send(dec.decode(encodeFrame({ type: FrameType.RPCReq, reqId, payload: seal(this.shared, enc.encode(JSON.stringify(req))) })))
    })
  }
  resize(name: string, finger: string | undefined, rows: number, cols: number): void {
    this.ws.send(dec.decode(encodeFrame({ type: FrameType.Control, sid: name, payload: seal(this.shared, enc.encode(JSON.stringify({ op: 'resize', rows, cols, ...(finger ? { finger } : {}) }))) })))
  }
  stdin(name: string, text: string): void {
    this.ws.send(dec.decode(encodeFrame({ type: FrameType.TermStdin, sid: name, payload: seal(this.shared, enc.encode(text)) })))
  }
  close(): void { this.ws.close() }
}

const codeOf = (home: string) => JSON.parse(readFileSync(join(home, '.ce', 'connection-code.json'), 'utf8')) as { r: string; s: string; k: string; t: string }
const pinOf = (home: string) => JSON.parse(readFileSync(join(home, '.ce', 'pin.json'), 'utf8')).pin

async function main(): Promise<void> {
  const ownerB = new FakePhone(codeOf(homeB), 'owner-phone-b', pinOf(homeB) || pinB)
  await ownerB.connect()
  // ① 开授权
  const grant = await ownerB.rpc({ op: 'remoteGrant', label: '运维@机器A', directory: '/proj' })
  check('主人能在 B 上开远程授权', grant.ok === true && /^grant_/.test(grant.data?.grantId ?? '') && grant.data?.directory === '/proj', grant.error ?? `peer=${grant.data?.peerId}`)
  const ticket = grant.data as RemoteTicket & { directoryAbs: string }
  // ② 对端连上并执行
  const peer = await RemotePeer.connect(ticket)
  const opened = await peer.rpc<any>({ op: 'createTerminal', cwd: '/proj' })
  check('对端能在授权目录里开终端', opened.ok === true && typeof opened.data?.name === 'string', opened.error)
  peer.attach(opened.data.name, opened.data.finger, 24, 200)
  await sleep(400)
  let out = ''; peer.onOutput = (_sid, text) => { out += text }
  peer.stdin(opened.data.name, 'echo marker-$((21+21)) && pwd\r')
  await sleep(1200)
  check('远程命令拿到输出和正确目录', out.includes('marker-42') && out.includes(ticket.directoryAbs), out.slice(0, 120).replace(/\n/g, ' / '))
  // ③ 越权逐个被拒
  const denied = async (req: Record<string, unknown>, label: string) => {
    const r = await peer.rpc<any>(req)
    check(`越权被拒:${label}`, r.ok === false && typeof r.error === 'string', r.error)
  }
  await denied({ op: 'exec', command: 'id' }, 'exec')
  await denied({ op: 'listDir', path: '/' }, '列文件')
  await denied({ op: 'chat.roster' }, '花名册')
  await denied({ op: 'kernelStart' }, '内核')
  await denied({ op: 'createTerminal', cwd: '/outside' }, '目录外的终端')
  await denied({ op: 'createTerminal', type: 'cc' }, 'cc 会话')
  // 关别人的终端
  const all = await peer.rpc<any>({ op: 'listTerminals' })
  check('对端只看得见自己的终端', all.ok && Array.isArray(all.data?.terminals) && all.data.terminals.every((t: any) => t.ownedByMe === true), `共 ${all.data?.terminals?.length ?? 0} 条`)
  // ④ 主人旁观:列表里带 agentOwned;接上收得到输出;stdin 允许
  const seen = await ownerB.rpc<any>({ op: 'listTerminals' })
  const agentTerm = seen.data?.terminals?.find((t: any) => t.agentOwned === true)
  check('主人看得见数字人的终端(agentOwned)', !!agentTerm, agentTerm ? `occupiedBy=${agentTerm.occupiedBy}` : '列表里没有')
  if (agentTerm) {
    ownerB.outputs.length = 0
    ownerB.resize(agentTerm.name, agentTerm.finger, 30, 120)
    await sleep(300)
    peer.stdin(opened.data.name, 'echo view-check-ok\r')
    for (let i = 0; i < 10 && !ownerB.outputs.some(o => o.sid === agentTerm.name && o.text.includes('view-check-ok')); i++) await sleep(500)
    check('主人旁观:收得到输出', ownerB.outputs.some(o => o.sid === agentTerm.name && o.text.includes('view-check-ok')), `共 ${ownerB.outputs.length} 段;最新段:${(ownerB.outputs.at(-1)?.text ?? '').slice(0, 80).replace(/\n/g, ' / ')}`)
    const stg = ownerB.controls.find(c => c.op === 'attachDenied')
    check('主人旁观:不被拒(无 attachDenied)', !stg, stg ? `被 ${stg.occupiedBy} 拒` : undefined)
  }
  // ⑤ 不带凭证的握手被拒(同 peerId 强制走凭证)
  const naked = new FakePhone(codeOf(homeB), ticket.peerId, pinOf(homeB))
  await naked.connect()
  await sleep(800)
  check('登记过的对端不带凭证被拒', naked.lastPairReject.includes('grant_invalid'), naked.lastPairReject || '(没有收到拒绝,静默丢帧)')
  naked.close()
  // ⑥ 撤销:对端收到通知,终端被关,再连被拒
  const revoked = await ownerB.rpc({ op: 'remoteGrantRevoke', grantId: ticket.grantId })
  check('撤销授权', revoked.ok === true, revoked.error)
  await sleep(600)
  let revokedNotice = false
  peer.onControl = msg => { if (msg.op === 'grantRevoked') revokedNotice = true }
  await sleep(300)
  const after = await peer.rpc({ op: 'listTerminals' }).catch((e: Error) => ({ ok: false, error: e.message }))
  check('撤销后对端不再可用', revokedNotice || after.ok === false, revokedNotice ? '对端收到 grantRevoked' : after.error)
  const seen2 = await ownerB.rpc<any>({ op: 'listTerminals' })
  check('撤销后数字人的终端被关掉', !seen2.data?.terminals?.some((t: any) => t.name === opened.data.name), `数字人那台终端已不在(其余 ${seen2.data?.terminals?.length ?? 0} 条与本次无关)`)
  const again = await RemotePeer.connect(ticket).then(() => null, (e: Error) => e)
  check('撤销后凭旧票据连不上', again !== null, again?.message)
  peer.close(); ownerB.close()
  const failed = checks.filter(c => !c.ok)
  console.log(`\n通过 ${checks.length - failed.length}/${checks.length}`)
  if (failed.length) { console.log('未通过:', failed.map(c => c.name).join('；')); process.exit(1) }
}

main().catch((e) => { console.error('剧本异常:', e); process.exit(1) })
