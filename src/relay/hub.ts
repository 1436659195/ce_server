import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { decodeFrame, encodeFrame } from '../shared/frame'

/** 中继需要的最小 WS 接口(只用 send)。真实 ws.WebSocket 满足;测试用假对象。 */
export interface RelayWS {
  send(data: string): void
}

interface Session {
  sid: string
  token: string
  cli: RelayWS | null
  // 多 phone 共连:一台被控机可被多台手机同时连(各自 E2E 通道)。
  // Map:phone WS → phoneId(手机持久身份,来自 URL query)。
  phones: Map<RelayWS, string>
  phoneBuffer: string[] // 无 phone 在线时,cli 发来的消息暂存;首个 phone 连上即补发给它
  cliBuffer: string[] // cli 断线时,phone 发来的消息暂存(防御性;cli 通常常驻)
}

interface PersistEntry {
  sid: string
  token: string
}

function randId(n = 16): string {
  return randomBytes(n).toString('hex')
}

/** phoneLeft 明文控制通知(hub 生成,非用户负载)。cli 收到后清对应的 E2E 通道与 owner。 */
function phoneLeftNotice(phoneId: string): string {
  return JSON.stringify({ type: 'phoneLeft', phoneId })
}

/**
 * Hub:中继的纯逻辑核心。按 sessionId 把 cli 与(多台)phone 配对,互转密文。
 *
 * **零信任**:只读连接元数据(sessionId/token)与路由元数据(targetPhoneId/sourcePhoneId,
 * 类比 IP 头)做路由,**从不解密也不触碰消息负载**(负载是 base64 密文,中继没密钥也看不懂)。
 * 这使得它可被单元测试(假 WS 对象)完整覆盖,真实 WS 的接线在 server.ts。
 *
 * **多 phone 路由(Task 2)**:
 *   - cli→phone:读帧头 targetPhoneId(不读 payload)定向;无 targetPhoneId 则广播给所有 phone。
 *   - phone→cli:hub 在帧头注入 sourcePhoneId(该 phone 的 id),cli 按 sourcePhoneId 选 E2E 密钥解密。
 *   - phone 断:hub 给 cli 发明文控制通知 `{type:'phoneLeft',phoneId}`(非加密帧,零信任边界不变)。
 *
 * **cid 持久化**:cli 注册带 cid(机器标识)。同一 cid 复用同一 sid/token(持久到 state 文件),
 * 中继重启后 cli 重连仍拿到同一 sid → 手机存的配对码长期有效、不用重扫。
 */
export class Hub {
  private sessions = new Map<string, Session>()
  private wsMeta = new Map<RelayWS, { sid: string; role: 'cli' | 'phone'; phoneId?: string }>()
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
      s = { sid, token, cli, phones: new Map(), phoneBuffer: [], cliBuffer: [] }
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

  /**
   * phone 连入:校验 token 后绑定(多 phone 共连);绑定前 cli 缓冲的消息补发给该 phone。
   * phoneId 为手机持久身份(来自 URL query),用于 cli→phone 定向与 phone→cli 来源标注。
   * token 错返回 false。
   */
  joinPhone(sid: string, token: string, phone: RelayWS, phoneId: string): boolean {
    const s = this.sessions.get(sid)
    if (!s || s.token !== token) return false
    s.phones.set(phone, phoneId)
    this.wsMeta.set(phone, { sid, role: 'phone', phoneId })
    for (const m of s.phoneBuffer) {
      try {
        phone.send(m)
      } catch {
        /* 客户端 ws 已关 */
      }
    }
    s.phoneBuffer = []
    return true
  }

  /** src 发来一条消息:按 role 路由(负载透传,不解密)。 */
  onMessage(src: RelayWS, data: string): void {
    const meta = this.wsMeta.get(src)
    if (!meta) return
    const s = this.sessions.get(meta.sid)
    if (!s) return
    if (meta.role === 'cli') {
      // cli→phone:读帧头 targetPhoneId(不读 payload 密文)定向;无则广播。
      let targetPhoneId: string | undefined
      try {
        targetPhoneId = decodeFrame(new TextEncoder().encode(data)).targetPhoneId
      } catch {
        /* 非法/非 JSON 帧(含历史裸字符串):视为无 targetPhoneId → 广播(向后兼容) */
      }
      if (targetPhoneId) {
        // 定向:找到 phoneId 匹配的 phone 转发(透传原 data,不改路由字段)
        for (const [ws, pid] of s.phones) {
          if (pid === targetPhoneId) {
            try {
              ws.send(data)
            } catch {
              /* 客户端 ws 已关 */
            }
            return
          }
        }
        // 目标 phone 不在线:丢弃(瞬态竞态;按 targetPhoneId 缓冲会泄露给后来的非目标 phone,YAGNI)
      } else {
        // 广播给所有 phone;无 phone 在线则缓冲(首个 phone 连上补发)
        if (s.phones.size > 0) {
          for (const ws of s.phones.keys()) {
            try {
              ws.send(data)
            } catch {
              /* 客户端 ws 已关 */
            }
          }
        } else {
          s.phoneBuffer.push(data)
        }
      }
    } else {
      // phone→cli:在帧头注入 sourcePhoneId(该 phone 的 id),cli 按 sourcePhoneId 选密钥解密
      let out = data
      if (meta.phoneId !== undefined) {
        try {
          const f = decodeFrame(new TextEncoder().encode(data))
          f.sourcePhoneId = meta.phoneId
          out = new TextDecoder().decode(encodeFrame(f))
        } catch {
          /* 非法/非 JSON 帧:原样透传(无法注入,不阻塞) */
        }
      }
      if (s.cli) {
        try {
          s.cli.send(out)
        } catch {
          /* 客户端 ws 已关 */
        }
      } else {
        s.cliBuffer.push(out)
      }
    }
  }

  /** 某方断开:从 session 解绑(对端重连可重新绑定)。phone 断则通知 cli 清状态。 */
  onClose(src: RelayWS): void {
    const meta = this.wsMeta.get(src)
    if (!meta) return
    const s = this.sessions.get(meta.sid)
    if (s) {
      if (meta.role === 'cli') {
        s.cli = null
      } else {
        s.phones.delete(src)
        // phone 断:给 cli 发明文控制通知(hub 生成,非加密帧),cli 据此清该 phone 的 E2E 通道与 owner
        if (meta.phoneId !== undefined && s.cli) {
          try {
            s.cli.send(phoneLeftNotice(meta.phoneId))
          } catch {
            /* cli ws 已关 */
          }
        }
      }
    }
    this.wsMeta.delete(src)
  }
}
