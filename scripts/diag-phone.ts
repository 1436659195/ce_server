/**
 * 假手机诊断工具 —— 排查"中继终端重连后内容重复"。
 *
 * 直连本机中继 → ce → Jupyter(全程 E2E,与真手机同协议),自己 createTerminal 建测试终端
 * (不碰用户正在用的终端,避免 tryAcquire 抢占),脚本化"断开 → 重连 → resize",
 * 把【重连后收到的每一段字节】原样 dump(ANSI 转义可见),判断重画是"光标归位覆盖"还是"裸追加"。
 *
 * 用法:bun ce-server/scripts/diag-phone.ts
 *   配对码自动从 ~/.ce/connection-code.json 读(r/s/k/t)。
 */
import WebSocket from 'ws'
import { generateKeyPair, sharedSecret, seal, open, type KeyPair } from '../src/shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../src/shared/frame'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 配对码(= 二维码内容)
const QR = JSON.parse(readFileSync(`${homedir()}/.ce/connection-code.json`, 'utf8')) as {
  r: string; s: string; k: string; t: string
}
const RELAY = QR.r
const SID = QR.s
const CLI_PUB = unb64(QR.k)
const TOKEN = QR.t

/** 把字节渲染成可读:转义/控制符命名,可打印原样。便于看"光标归位 vs 追加"。 */
function annotate(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!
    if (c === 0x1b) out += '<ESC>'
    else if (c === 0x0d) out += '<CR>'
    else if (c === 0x0a) out += '<LF>\n'
    else if (c === 0x07) out += '<BEL>'
    else if (c === 0x08) out += '<BS>'
    else if (c === 0x09) out += '<TAB>'
    else if (c < 0x20) out += `<0x${c.toString(16).padStart(2, '0')}>`
    else if (c === 0x7f) out += '<DEL>'
    else out += String.fromCharCode(c)
  }
  return out
}

class FakePhone {
  ws: WebSocket | null = null
  kp: KeyPair = generateKeyPair()
  sharedKey!: Uint8Array
  gen = 0
  phoneId = 'diag-0'
  private rpcResolvers = new Map<string, (v: unknown) => void>()
  onOutput: (text: string, bytes: Uint8Array) => void = () => {}

  /** 开一条 WS(每次重连用新 keypair,对齐真手机)。resolve 握手已发(不等 ce 确认)。 */
  connect(phoneId: string): Promise<void> {
    this.phoneId = phoneId
    this.gen++
    this.kp = generateKeyPair()
    this.sharedKey = sharedSecret(this.kp.privateKey, CLI_PUB)
    return new Promise((resolve, reject) => {
      const url = `${RELAY}/${SID}?token=${TOKEN}&phoneId=${encodeURIComponent(phoneId)}`
      this.ws = new WebSocket(url)
      const to = setTimeout(() => reject(new Error('连接中继超时(10s)')), 10000)
      this.ws.on('open', () => {
        clearTimeout(to)
        // 握手:明文送 phonePub。ce 收到不可解密的 Control → 当握手 → 派生 sharedKey 存 phoneKeys。
        this.ws!.send(dec.decode(encodeFrame({
          type: FrameType.Control,
          payload: enc.encode(JSON.stringify({ k: b64(this.kp.publicKey), id: phoneId, n: 'diag' })),
        })))
        resolve()
      })
      this.ws.on('message', (raw) => this.onMessage(raw as Uint8Array))
      this.ws.on('error', (e) => { clearTimeout(to); reject(e) })
    })
  }

  close(): void {
    try { this.ws?.close() } catch { /* */ }
    this.ws = null
  }

  private onMessage(raw: Uint8Array): void {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
    let frame: Frame
    try { frame = decodeFrame(bytes) } catch {
      // hub 明文控制通知(phoneLeft 等)→ 非 Frame,忽略
      return
    }
    if (frame.type === FrameType.RPCResp && frame.reqId) {
      const p = this.rpcResolvers.get(frame.reqId)
      if (p) {
        this.rpcResolvers.delete(frame.reqId)
        try { p(JSON.parse(dec.decode(open(this.sharedKey, frame.payload)))) } catch { /* */ }
      }
      return
    }
    if (frame.type === FrameType.TermOutput && frame.sid) {
      try {
        const text = dec.decode(open(this.sharedKey, frame.payload))
        this.onOutput(text, enc.encode(text))
      } catch { /* 解密失败忽略 */ }
      return
    }
    // Control(attachDenied 等)忽略
  }

  rpc(req: Record<string, unknown>): Promise<unknown> {
    const reqId = Math.random().toString(36).slice(2, 10)
    return new Promise((resolve) => {
      this.rpcResolvers.set(reqId, resolve)
      this.ws!.send(dec.decode(encodeFrame({
        type: FrameType.RPCReq,
        reqId,
        payload: seal(this.sharedKey, enc.encode(JSON.stringify(req))),
      })))
      setTimeout(() => { if (this.rpcResolvers.has(reqId)) { this.rpcResolvers.delete(reqId); resolve(undefined) } }, 8000)
    })
  }

  resize(name: string, rows: number, cols: number): void {
    this.ws!.send(dec.decode(encodeFrame({
      type: FrameType.Control,
      sid: name,
      payload: seal(this.sharedKey, enc.encode(JSON.stringify({ op: 'resize', rows, cols }))),
    })))
  }

  stdin(name: string, text: string): void {
    this.ws!.send(dec.decode(encodeFrame({
      type: FrameType.TermStdin,
      sid: name,
      payload: seal(this.sharedKey, enc.encode(text)),
    })))
  }
}

/** 收集 ms 毫秒内的所有输出,返回拼接 + 每段明细。 */
async function collect(phone: FakePhone, ms: number, label: string): Promise<{ chunks: { t: number; len: number; head: string }[]; total: number }> {
  const chunks: { t: number; len: number; head: string }[] = []
  let buf = ''
  const t0 = Date.now()
  phone.onOutput = (text) => { chunks.push({ t: Date.now() - t0, len: text.length, head: annotate(enc.encode(text)).slice(0, 60) }); buf += text }
  await sleep(ms)
  phone.onOutput = () => {}
  console.log(`\n----- [${label}] 收到 ${chunks.length} 段 / 共 ${buf.length} 字节 -----`)
  chunks.forEach((c, i) => console.log(`  #${i} +${c.t}ms len=${c.len}  ${c.head.replace(/\n/g, '\\n')}`))
  if (buf.length) console.log('  完整内容(转义可见):\n' + annotate(enc.encode(buf)))
  else console.log('  (无输出)')
  return { chunks, total: buf.length }
}

async function main(): Promise<void> {
  console.log(`中继=${RELAY} sid=${SID.slice(0, 8)}… token=${TOKEN.slice(0, 6)}…`)
  const phone = new FakePhone()

  // 1) 首连
  await phone.connect('diag-1')
  console.log('✓ 首连 + 握手已发')
  await sleep(800) // 等 ce 处理握手 phoneKeys 就绪

  // 2) 建测试终端
  const r = (await phone.rpc({ op: 'createTerminal', cwd: '/' })) as { ok: boolean; data?: { name: string }; error?: string }
  if (!r?.ok || !r.data?.name) throw new Error('createTerminal 失败:' + (r?.error ?? JSON.stringify(r)))
  const name = r.data.name
  console.log(`✓ 建测试终端 name=${name}`)

  // 3) resize 起 shell
  phone.resize(name, 24, 80)
  await collect(phone, 1500, '初始:resize(24,80) 起 shell 后的 prompt/banner')

  // 4) 打 marker,留在屏上
  phone.stdin(name, 'echo __MARK_A__; seq 1 3; echo __MARK_B__\r')
  await collect(phone, 1500, '发 marker 命令后的输出(应见 __MARK_A__/1/2/3/__MARK_B__)')

  // 5) 断开(模拟手机后台 WS 冻结/关闭)
  console.log('\n===== 断开 WS(模拟手机进后台)=====')
  phone.close()
  await sleep(1500)

  // 6) 重连(新 keypair + 握手),然后【同尺寸】resize(= 真手机 onReady 的 syncSize(force))
  await phone.connect('diag-2')
  console.log('✓ 重连 + 握手已发')
  await sleep(800)
  phone.resize(name, 24, 80) // 同尺寸
  await collect(phone, 2500, '关键 A:重连后【同尺寸 24×80】resize 收到的输出')

  // 7) 再 resize【变尺寸】(看 SIGWINCH 是否触发重画)
  phone.resize(name, 24, 100) // 变宽
  await collect(phone, 2500, '关键 B:重连后【变尺寸 24×100】resize 收到的输出')

  // 8) 再断再连一次(看"多次重连"是否每次都重发)
  console.log('\n===== 再次断开 → 重连 =====')
  phone.close()
  await sleep(1500)
  await phone.connect('diag-3')
  await sleep(800)
  phone.resize(name, 24, 80)
  await collect(phone, 2500, '关键 C:第二次重连后同尺寸 resize 收到的输出(看是否又重发一遍)')

  // 清理:删测试终端
  await phone.rpc({ op: 'deleteTerminal', name }).catch(() => {})
  phone.close()
  console.log('\n✓ 测试终端已删,结束。')
}

main().catch((e) => { console.error('诊断异常:', e); process.exit(1) })
