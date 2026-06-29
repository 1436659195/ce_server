import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

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

interface PersistEntry {
  sid: string
  token: string
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
 *
 * **cid 持久化**:cli 注册带 cid(机器标识)。同一 cid 复用同一 sid/token(持久到 state 文件),
 * 中继重启后 cli 重连仍拿到同一 sid → 手机存的配对码长期有效、不用重扫。
 */
export class Hub {
  private sessions = new Map<string, Session>()
  private wsMeta = new Map<RelayWS, { sid: string; role: 'cli' | 'phone' }>()
  private cidToEntry = new Map<string, PersistEntry>()
  private statePath: string | null

  constructor(statePath?: string) {
    this.statePath = statePath ?? null
    this.loadState()
  }

  private loadState(): void {
    if (!this.statePath) return
    try {
      if (existsSync(this.statePath)) {
        const arr = JSON.parse(readFileSync(this.statePath, 'utf8')) as [string, PersistEntry][]
        for (const [cid, e] of arr) this.cidToEntry.set(cid, e)
      }
    } catch {
      /* 损坏→空 */
    }
  }

  private saveState(): void {
    if (!this.statePath) return
    try {
      writeFileSync(this.statePath, JSON.stringify(Array.from(this.cidToEntry.entries())))
    } catch {
      /* 写失败→忽略(本次内存有效) */
    }
  }

  /**
   * cli 连入:按 cid 复用或分配 sid+token(持久),绑定 cli ws。
   * - cid 已知(曾注册过)→ 复用其 sid/token;session 仍在则更新 cli socket(ce 重连),
   *   不在(中继重启后内存空)则按持久 sid/token 重建 session。
   * - cid 未知 → 分配新 sid/token + 持久化。
   */
  register(cid: string, cli: RelayWS): { sid: string; token: string } {
    let entry = this.cidToEntry.get(cid)
    if (!entry) {
      entry = { sid: randId(), token: randId(12) }
      this.cidToEntry.set(cid, entry)
      this.saveState()
    }
    const sid = entry.sid
    const token = entry.token
    let s = this.sessions.get(sid)
    if (!s) {
      s = { sid, token, cli, phone: null, phoneBuffer: [], cliBuffer: [] }
      this.sessions.set(sid, s)
    } else {
      s.cli = cli // ce 重连:更新 socket
      // 补发 phone 在 ce 断线期间发的消息(含握手 phonePub);否则 ce 错过握手 → 后续解密全失败
      for (const m of s.cliBuffer) {
        try {
          cli.send(m)
        } catch {
          /* 客户端 ws 已关 */
        }
      }
      s.cliBuffer = []
    }
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
