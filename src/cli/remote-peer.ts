/**
 * 远程对端客户端 —— 本机 ce 以「带凭证的设备」身份,连到另一台机器在中继上的会话。
 * 与手机同一套协议(shared/crypto + shared/frame),照 scripts/diag-phone.ts 的假手机:
 *  - 每次连接生成新的 X25519 密钥对;握手 Control{k, g:{id, mac}} 是明文,只带证明不带凭证密钥;
 *  - 握手成不成功以第一个请求的响应为准(同一条连接上帧有序,不必等固定时间);
 *  - 断线由调用方重连(重新握手);上一条连接的旧密钥封的帧解不开即丢弃,中继补发的旧帧天然失效。
 * 只做通道:发请求、收响应、收终端输出。凭证和「在哪台机器上干活」由 remote-shell.ts 管。
 */
import WebSocket from 'ws'
import { generateKeyPair, open, seal, sharedSecret, type KeyPair } from '../shared/crypto'
import { decodeFrame, encodeFrame, FrameType, type Frame } from '../shared/frame'
import { Heartbeat } from './heartbeat'
import { grantMac } from './remote-grants'

/** 连到对端要用的票据(由对端开凭证时给出,本机只保存、不改)。 */
export interface RemoteTicket {
  grantId: string
  key: string
  peerId: string
  /** 给人看的标签:哪台机器的哪个数字人(B 开凭证时定)。 */
  label?: string
  directory?: string
  directoryAbs?: string
  platform?: string
  relayUrl: string
  sid: string
  cliPub: string
  token: string
}

export type RemotePeerState = 'connected' | 'closed' | 'offline'

export class RemotePeerError extends Error {
  constructor(message: string, readonly code: 'connect' | 'timeout' | 'closed' | 'rejected') {
    super(message)
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

export class RemotePeer {
  private readonly kp: KeyPair
  private readonly sharedKey: Uint8Array
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private seq = 0
  private heartbeat: Heartbeat | null = null
  private closed = false
  /** 终端输出:终端名 + 这一段文本。 */
  onOutput: (sid: string, text: string) => void = () => {}
  /** 对端发来的控制通知:grantRevoked(授权被撤销)、attachDenied、termGone。 */
  onControl: (msg: Record<string, unknown>) => void = () => {}
  /** 连接状态:对端离线(中继通知)、连接断开。 */
  onState: (state: Exclude<RemotePeerState, 'connected'>) => void = () => {}

  private constructor(private readonly ws: WebSocket, kp: KeyPair, cliPub: Uint8Array) {
    this.kp = kp
    this.sharedKey = sharedSecret(kp.privateKey, cliPub)
    ws.on('message', (raw) => this.onMessage(raw))
    ws.on('close', () => this.shutdown('连接已断开'))
    ws.on('error', () => this.shutdown('连接出错'))
    this.heartbeat = new Heartbeat(ws)
  }

  /** 本次连接的临时公钥(base64)。 */
  get phonePubB64(): string {
    return b64(this.kp.publicKey)
  }
  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN
  }

  /** 连上、握手,并等第一个请求的响应确认握手成功。 */
  static async connect(ticket: RemoteTicket, opts: { timeoutMs?: number } = {}): Promise<RemotePeer> {
    const timeoutMs = opts.timeoutMs ?? 15_000
    const url = `${ticket.relayUrl}/${ticket.sid}?token=${encodeURIComponent(ticket.token)}&phoneId=${encodeURIComponent(ticket.peerId)}`
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new RemotePeerError('连接中继超时', 'connect'))
      }, timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', () => {
        clearTimeout(timer)
        reject(new RemotePeerError('连不上中继', 'connect'))
      })
    })
    const peer = new RemotePeer(ws, generateKeyPair(), unb64(ticket.cliPub))
    // 握手:明文,只带临时公钥和证明
    ws.send(dec.decode(encodeFrame({
      type: FrameType.Control,
      payload: enc.encode(JSON.stringify({ k: peer.phonePubB64, g: { id: ticket.grantId, mac: grantMac(ticket.key, peer.phonePubB64) } })),
    })))
    try {
      await peer.rpc({ op: 'listTerminals' }, timeoutMs)
    } catch (error) {
      peer.close()
      throw error
    }
    return peer
  }

  /** 发一个请求,等对端响应。超时、断开、被拒都会报错,不会一直挂着。 */
  rpc<T = unknown>(req: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new RemotePeerError('连接已断开', 'closed'))
    const reqId = `r${++this.seq}${Math.random().toString(36).slice(2, 8)}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new RemotePeerError(`请求超时:${String(req.op)}`, 'timeout'))
      }, timeoutMs)
      this.pending.set(reqId, { resolve: (v) => resolve(v as T), reject, timer })
      this.ws.send(dec.decode(encodeFrame({ type: FrameType.RPCReq, reqId, payload: seal(this.sharedKey, enc.encode(JSON.stringify(req))) })))
    })
  }

  /** 接上终端:发尺寸(对端据此开转发),带上实例指纹。 */
  attach(name: string, finger: string | undefined, rows: number, cols: number): void {
    if (!this.isOpen) return
    this.ws.send(dec.decode(encodeFrame({
      type: FrameType.Control,
      sid: name,
      payload: seal(this.sharedKey, enc.encode(JSON.stringify({ op: 'resize', rows, cols, ...(finger ? { finger } : {}) }))),
    })))
  }

  /** 往终端里敲字。 */
  stdin(name: string, text: string): void {
    if (!this.isOpen) return
    this.ws.send(dec.decode(encodeFrame({ type: FrameType.TermStdin, sid: name, payload: seal(this.sharedKey, enc.encode(text)) })))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.heartbeat?.stop()
    try {
      this.ws.close()
    } catch {
      /* 已关 */
    }
    this.rejectAll(new RemotePeerError('连接已断开', 'closed'))
  }

  private shutdown(reason: string): void {
    if (this.closed) {
      this.rejectAll(new RemotePeerError(reason, 'closed'))
      return
    }
    this.closed = true
    this.heartbeat?.stop()
    this.rejectAll(new RemotePeerError(reason, 'closed'))
    this.onState('closed')
  }

  private rejectAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }

  private onMessage(raw: unknown): void {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
    let frame: Frame
    try {
      frame = decodeFrame(bytes)
    } catch {
      // 中继的明文通知:cliLeft = 对端离线
      try {
        const notice = JSON.parse(dec.decode(bytes)) as { type?: string }
        if (notice.type === 'cliLeft' && !this.closed) this.onState('offline')
      } catch {
        /* 非法帧 → 忽略 */
      }
      return
    }
    if (frame.type === FrameType.PairReject) {
      const reason = (() => {
        try {
          return (JSON.parse(dec.decode(frame.payload)) as { reason?: string }).reason ?? ''
        } catch {
          return ''
        }
      })()
      this.rejectAll(new RemotePeerError(`远程授权被拒绝(${reason})`, 'rejected'))
      return
    }
    if (frame.type === FrameType.RPCResp && frame.reqId) {
      const p = this.pending.get(frame.reqId)
      if (!p) return
      this.pending.delete(frame.reqId)
      clearTimeout(p.timer)
      try {
        p.resolve(JSON.parse(dec.decode(open(this.sharedKey, frame.payload))))
      } catch (error) {
        p.reject(error instanceof Error ? error : new Error('响应解不开'))
      }
      return
    }
    if (frame.type === FrameType.TermOutput && frame.sid) {
      try {
        this.onOutput(frame.sid, dec.decode(open(this.sharedKey, frame.payload)))
      } catch {
        /* 旧密钥封的帧 → 丢弃 */
      }
      return
    }
    if (frame.type === FrameType.Control) {
      try {
        this.onControl(JSON.parse(dec.decode(open(this.sharedKey, frame.payload))) as Record<string, unknown>)
      } catch {
        /* 解不开 → 忽略 */
      }
    }
  }
}
