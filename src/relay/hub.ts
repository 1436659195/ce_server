import { randomBytes } from 'node:crypto'

/** 中继需要的最小 WS 接口(只用 send)。真实 ws.WebSocket 满足;测试用假对象。 */
export interface RelayWS {
  send(data: string): void
}

interface Session {
  sid: string
  token: string
  cli: RelayWS | null
  phone: RelayWS | null
  phoneBuffer: string[] // phone 未连时,cli 发来的消息暂存;phone 连上即补发
  cliBuffer: string[] // cli 断线时,phone 发来的消息暂存(防御性;cli 通常常驻)
}

function randId(n = 16): string {
  return randomBytes(n).toString('hex')
}

/**
 * Hub:中继的纯逻辑核心。按 sessionId 把 cli 与 phone 配对,互转密文。
 *
 * **零信任**:只读连接元数据(sessionId/token)做路由,**从不解析也不触碰消息负载**
 * (负载是密文,中继没密钥也看不懂)。这使得它可被单元测试(假 WS 对象)完整覆盖,
 * 真实 WS 的接线在 server.ts。
 */
export class Hub {
  private sessions = new Map<string, Session>()
  private wsMeta = new Map<RelayWS, { sid: string; role: 'cli' | 'phone' }>()

  /** cli 连入:新建会话,返回 {sid, token}(token 进二维码供 phone 鉴权)。 */
  register(cli: RelayWS): { sid: string; token: string } {
    const sid = randId()
    const token = randId(12)
    const session: Session = { sid, token, cli, phone: null, phoneBuffer: [], cliBuffer: [] }
    this.sessions.set(sid, session)
    this.wsMeta.set(cli, { sid, role: 'cli' })
    return { sid, token }
  }

  /** phone 连入:校验 token 后绑定;绑定前缓冲的消息补发给 phone。token 错返回 false。 */
  joinPhone(sid: string, token: string, phone: RelayWS): boolean {
    const s = this.sessions.get(sid)
    if (!s || s.token !== token) return false
    s.phone = phone
    this.wsMeta.set(phone, { sid, role: 'phone' })
    for (const m of s.phoneBuffer) phone.send(m)
    s.phoneBuffer = []
    return true
  }

  /** src 发来一条消息:转给同 session 的对端(对端断线则缓冲)。负载透传,不解析。 */
  onMessage(src: RelayWS, data: string): void {
    const meta = this.wsMeta.get(src)
    if (!meta) return
    const s = this.sessions.get(meta.sid)
    if (!s) return
    if (meta.role === 'cli') {
      if (s.phone) s.phone.send(data)
      else s.phoneBuffer.push(data)
    } else {
      if (s.cli) s.cli.send(data)
      else s.cliBuffer.push(data)
    }
  }

  /** 某方断开:从 session 解绑(对端重连可重新绑定)。 */
  onClose(src: RelayWS): void {
    const meta = this.wsMeta.get(src)
    if (!meta) return
    const s = this.sessions.get(meta.sid)
    if (s) {
      if (meta.role === 'cli') s.cli = null
      else s.phone = null
    }
    this.wsMeta.delete(src)
  }
}
