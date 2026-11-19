/**
 * ChatHub —— 群聊枢纽(daemon 侧,2026-11-19 agent-group S1 底座)。
 *
 * 架构:daemon 持有 relay WS 与群状态;`ce chat` 是薄 CLI(读 ~/.ce/daemon.json 找到本地
 * daemon,POST /chat/op)。信任边缘在 daemon:agent 零网络凭据,群钥经手机隧道 RPC
 * (chat.setKey)下发,relay 永不见群钥。设计见 ce-platform docs/plans/2026-11-19-agent-group-chat-design.md §4。
 *
 * 职责:
 *   - 本机 agent 注册表(~/.ce/chat-state.json,0600):name → 各群成员身份 + 已读游标;
 *   - 群钥保管(groupId → key,仅本地);
 *   - GroupFrame 收发:发 = 信封 JSON 直出(正文群钥密文);收 = 应答配对 + 群事件消化;
 *   - 发送纪律(协议层):未读拒发(new_messages 时 relay 已替标读并附未读,这里解密回给
 *     调用方,更新游标 —— agent 读完重发即可过,与 Pachat 同款体验)、opKey 幂等。
 *
 * 投递(S2 范围:hook 边界捎带/安全闸)不在本模块;S1 由 agent 主动轮询 inbox/read。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { open, seal, sharedSecret } from '../shared/crypto'
import {
  GROUP_LIMITS,
  type GroupEnvelope,
  type GroupMetaEvent,
  type GroupOp,
  type GroupPlaintext,
  type GroupResult,
  type GroupStoredMsg,
} from '../shared/group'

/** 单 agent 的群成员身份(一 agent 可入多群)。 */
interface AgentGroupRec {
  memberId: string
  groupName: string
  lastReadSeq: number
}

interface AgentRec {
  platform?: string
  cwd?: string
  joinedAt: number
  groups: Record<string, AgentGroupRec> // groupId → 身份
}

interface ChatState {
  v: 1
  keys: Record<string, string> // groupId → 群钥 base64(经隧道下发,仅本地)
  agents: Record<string, AgentRec> // name → 身份
}

/** 群消息的明文形态(解密后给 CLI/fake-agent 的形状)。 */
export interface ChatMsg {
  seq: number
  ts: number
  fromName: string
  fromHuman?: boolean
  text: string
  mentions?: string[]
  replyTo?: number
}

/** RPC 式群操作的默认超时(relay 未应答 → 报错不挂死 CLI)。 */
const RPC_TIMEOUT_MS = 10_000

export interface ChatHubOpts {
  /** 本机被控机标识(identity.cid;join 时作 member.machineId,relay 鉴权依据)。 */
  cid: string
  /** 本机身份密钥对:私钥开群钥密文槽;公钥 join 时上报(手机封槽目标)。 */
  privKey: Uint8Array
  pubKey: Uint8Array
  /** 状态文件(~/.ce/chat-state.json;0600,含群钥)。 */
  statePath: string
  /** 把一条群信封发上 relay(main.ts 注入:GroupFrame 直出,正文已密文)。 */
  sendEnvelope(env: GroupEnvelope): void
}

export class ChatHub {
  private state: ChatState = { v: 1, keys: {}, agents: {} }
  /** reqId → 等待中的应答(群操作是 relay req/resp,与 RPCReq 同款关联法)。 */
  private pending = new Map<string, { resolve: (r: GroupResult) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly opts: ChatHubOpts) {
    this.load()
  }

  // ─── 状态(0600;含群钥,等同凭据对待)──────────────────────────────────────────

  private load(): void {
    try {
      const raw = readFileSync(this.opts.statePath, 'utf8')
      const o = JSON.parse(raw) as ChatState
      if (o.v === 1 && o.keys && o.agents) this.state = o
    } catch {
      /* 无文件/损坏 → 空状态 */
    }
  }

  private save(): void {
    try {
      mkdirSync(join(this.opts.statePath, '..'), { recursive: true })
      writeFileSync(this.opts.statePath, JSON.stringify(this.state))
      chmodSync(this.opts.statePath, 0o600)
    } catch {
      /* 写失败 → 本次内存有效 */
    }
  }

  // ─── relay 入向 ────────────────────────────────────────────────────────────

  /** relay 广播/应答帧(main.ts 帧分发委托)。 */
  onEnvelope(env: GroupEnvelope): void {
    if (env.op === 'group-result') {
      const r = env.payload as GroupResult | undefined
      const reqId = r?.reqId ?? env.reqId
      const p = reqId ? this.pending.get(reqId) : undefined
      if (!p) return // 无人等的应答(超时已弃)→ 丢
      clearTimeout(p.timer)
      this.pending.delete(reqId!)
      p.resolve(r ?? { reqId: reqId!, ok: false, error: { code: 'no_group', message: '空应答' } })
      return
    }
    if (env.op === 'group-meta') this.onMeta(env)
    if (env.op === 'group-keyslot') this.onKeySlot(env)
    // group-msg:relay 广播的密文消息 —— 本地不缓存(read/inbox 都是 sync 拉 relay 真源),S1 只忽略
  }

  /** 群钥密文槽:slot = b64(临时公钥(32B) || seal(临时私钥×本机公钥, 群钥))。开槽落盘。 */
  private onKeySlot(env: GroupEnvelope): void {
    const p = env.payload as { groupId?: string; slot?: string } | undefined
    if (!p?.groupId || !p.slot) return
    try {
      const raw = Buffer.from(p.slot, 'base64')
      const ephPub = new Uint8Array(raw.subarray(0, 32))
      const sealed = new Uint8Array(raw.subarray(32))
      const sk = sharedSecret(this.opts.privKey, ephPub)
      const key = open(sk, sealed)
      this.setKey(p.groupId, Buffer.from(key).toString('base64'))
      console.log(`[ce] 群钥已收(${p.groupId}),群聊收发就绪`)
    } catch (e) {
      console.error('[ce] 群钥槽开启失败(密钥不匹配?):', (e as Error).message)
    }
  }

  private onMeta(env: GroupEnvelope): void {
    const ev = env.payload as GroupMetaEvent | undefined
    if (!ev?.groupId) return
    let dirty = false
    if (ev.event === 'dissolved') {
      delete this.state.keys[ev.groupId]
      for (const rec of Object.values(this.state.agents)) {
        if (rec.groups[ev.groupId]) {
          delete rec.groups[ev.groupId]
          dirty = true
        }
      }
    } else if (ev.event === 'member-left' && ev.member?.machineId === this.opts.cid && ev.member.name) {
      const rec = this.state.agents[ev.member.name]
      if (rec?.groups[ev.groupId]) {
        delete rec.groups[ev.groupId]
        dirty = true
      }
    }
    if (dirty) this.save()
  }

  // ─── 手机 RPC:群钥下发(chat.setKey;E2E 隧道,relay 永不见)────────────────────

  setKey(groupId: string, keyB64: string): void {
    if (!groupId || !keyB64) return
    this.state.keys[groupId] = keyB64
    this.save()
  }

  // ─── 本地 op(daemon HTTP /chat/op ←→ ce chat CLI)────────────────────────────

  /**
   * 处理本地 CLI 调用。入参 {agent?, op, ...params};返回 {ok, data?, error?}。
   * agent 缺省:恰有一个 agent 时自动取它(单 agent 机器零参数 DX),多于一个 → 报错列出。
   */
  async localOp(body: { agent?: string; op: string } & Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const op = body.op
    try {
      switch (op) {
        case 'join':
          return await this.opJoin(body)
        case 'send':
          return await this.withAgent(body, (name, rec) => this.opSend(name, rec, body))
        case 'read':
          return await this.withAgent(body, (name, rec) => this.opSync(name, rec, body, true))
        case 'inbox':
          return await this.withAgent(body, (name, rec) => this.opInbox(name, rec, body))
        case 'leave':
          return await this.withAgent(body, (name, rec) => this.opLeave(name, rec, body))
        case 'groups':
          return await this.withAgent(body, (_name, rec) => ({
            ok: true,
            data: Object.entries(rec.groups).map(([groupId, g]) => ({ groupId, groupName: g.groupName, memberId: g.memberId })),
          }))
        case 'whoami':
          return {
            ok: true,
            data: {
              cid: this.opts.cid,
              agents: Object.entries(this.state.agents).map(([name, rec]) => ({
                name,
                platform: rec.platform,
                cwd: rec.cwd,
                groups: Object.entries(rec.groups).map(([groupId, g]) => ({ groupId, groupName: g.groupName })),
              })),
            },
          }
        default:
          return { ok: false, error: `未知 op: ${op}` }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** 解析 agent 名(显式 --agent 或唯一 agent 兜底)。 */
  private resolveAgent(explicit?: string): { name: string; rec: AgentRec } {
    const names = Object.keys(this.state.agents)
    const name = explicit ?? (names.length === 1 ? names[0] : undefined)
    if (!name || !this.state.agents[name]) {
      throw new Error(names.length === 0 ? '本机还没有已接入的 agent(先 ce chat join)' : `指定 --agent(本机有:${names.join(', ')})`)
    }
    return { name, rec: this.state.agents[name] }
  }

  /** groupId 或群名 → 群记录(CLI DX:两种写法都收)。 */
  private resolveGroup(rec: AgentRec, idOrName?: string): { groupId: string; g: AgentGroupRec } {
    if (!idOrName) throw new Error('缺 groupId(或群名)')
    if (rec.groups[idOrName]) return { groupId: idOrName, g: rec.groups[idOrName] }
    for (const [gid, g] of Object.entries(rec.groups)) {
      if (g.groupName === idOrName) return { groupId: gid, g }
    }
    throw new Error(`agent 不在群「${idOrName}」里(ce chat groups 看在哪些群)`)
  }

  private async withAgent(
    body: { agent?: string },
    fn: (name: string, rec: AgentRec, body: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }> | { ok: boolean; data?: unknown; error?: string },
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const { name, rec } = this.resolveAgent(body.agent)
    return await fn(name, rec, body)
  }

  // ─── 各 op ──────────────────────────────────────────────────────────────────

  private async opJoin(body: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const code = String(body.code ?? '')
    const name = String(body.name ?? '').trim()
    if (!code || !name) return { ok: false, error: 'join 需要 code 与 --name' }
    const cwd = body.cwd ? String(body.cwd) : process.cwd()
    const platform = body.platform ? String(body.platform) : undefined
    const reclaim = body.reclaim === true
    const r = await this.rpc('group-join', undefined, {
      inviteCode: code,
      member: {
        name,
        platform,
        machineId: this.opts.cid,
        cwd,
        pubKey: Buffer.from(this.opts.pubKey).toString('base64'),
      },
      reclaim,
    })
    if (!r.ok) return { ok: false, error: `${r.error?.code}: ${r.error?.message}` }
    const data = r.data as { groupId: string; snapshot: import('../shared/group').GroupSnapshot }
    const gid = data.groupId
    const me = data.snapshot.members.find((m) => m.name === name && !m.human)
    if (!me) return { ok: false, error: 'join 应答里找不到自己的成员记录(异常)' }
    let rec = this.state.agents[name]
    if (!rec) {
      rec = { platform, cwd, joinedAt: Date.now(), groups: {} }
      this.state.agents[name] = rec
    }
    rec.groups[gid] = { memberId: me.memberId, groupName: data.snapshot.meta.name, lastReadSeq: data.snapshot.seq }
    this.save()
    return { ok: true, data: { groupId: gid, groupName: data.snapshot.meta.name, memberId: me.memberId, members: data.snapshot.members } }
  }

  private async opSend(_name: string, rec: AgentRec, body: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    let gid = String(body.groupId ?? '')
    const text = String(body.text ?? '')
    let g: AgentGroupRec
    try {
      const r = this.resolveGroup(rec, gid || undefined)
      gid = r.groupId
      g = r.g
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    if (!text.trim()) return { ok: false, error: '空消息' }
    if (text.length > GROUP_LIMITS.plaintextMaxChars) return { ok: false, error: `超限(>${GROUP_LIMITS.plaintextMaxChars} 字符)` }
    const key = this.keyOf(gid)
    if (!key) return { ok: false, error: '群钥未下发:等手机端分发(成员刚加入会有一次延迟)' }
    const mentions = Array.isArray(body.mentions) ? (body.mentions as string[]).map(String) : undefined
    const r = await this.rpc('group-post', gid, {
      // ct 走 base64(协议:字符串;裸 Uint8Array 经 JSON.stringify 会变对象 —— L2 管道测试抓的断层)
      ct: Buffer.from(seal(key, new TextEncoder().encode(JSON.stringify({ kind: 'text', text } satisfies GroupPlaintext)))).toString('base64'),
      opKey: 'ok_' + randomBytes(6).toString('hex'),
      replyTo: typeof body.replyTo === 'number' ? body.replyTo : undefined,
      mentions,
      readUpTo: g.lastReadSeq,
      memberId: g.memberId,
    })
    if (r.ok) {
      const seq = (r.data as { seq?: number }).seq ?? 0
      g.lastReadSeq = Math.max(g.lastReadSeq, seq)
      this.save()
      return { ok: true, data: { seq } }
    }
    const code = r.error?.code
    if (code === 'new_messages') {
      // relay 已替我们标读并附带未读密文 → 解密回给调用方,更新游标(读完重发即可过)
      const unread = this.decryptAll(key, ((r.data as { msgs?: GroupStoredMsg[] }).msgs ?? []) as GroupStoredMsg[])
      g.lastReadSeq = Math.max(g.lastReadSeq, ...unread.map((m) => m.seq), 0)
      this.save()
      return { ok: false, error: 'new_messages: 有未读消息(已替你标读),读完再发', data: { msgs: unread } }
    }
    return { ok: false, error: `${code}: ${r.error?.message}` }
  }

  /** read(markRead=true)/偷看(markRead=false)共用。 */
  private async opSync(_name: string, rec: AgentRec, body: Record<string, unknown>, markRead: boolean): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    let gid = String(body.groupId ?? '')
    let g: AgentGroupRec
    try {
      const r = this.resolveGroup(rec, gid || undefined)
      gid = r.groupId
      g = r.g
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    const key = this.keyOf(gid)
    if (!key) return { ok: false, error: '群钥未下发:等手机端分发' }
    const r = await this.rpc('group-sync', gid, {
      groupId: gid,
      memberId: g.memberId,
      afterSeq: markRead ? g.lastReadSeq : 0, // 偷看(inbox)从头粗拉,自行过滤未读
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      markRead,
    })
    if (!r.ok) return { ok: false, error: `${r.error?.code}: ${r.error?.message}` }
    const data = r.data as { msgs: GroupStoredMsg[]; seq: number }
    const msgs = this.decryptAll(key, data.msgs ?? [])
    if (markRead) {
      g.lastReadSeq = Math.max(g.lastReadSeq, data.seq ?? 0)
      this.save()
    }
    return { ok: true, data: { groupId: gid, groupName: g.groupName, seq: data.seq, msgs } }
  }

  private async opInbox(name: string, rec: AgentRec, body: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const items: Array<{ groupId: string; groupName: string; unread: number; previews: ChatMsg[]; mentionsMe: boolean }> = []
    for (const [gid, g] of Object.entries(rec.groups)) {
      const key = this.keyOf(gid)
      if (!key) continue // 钥未下发:等手机分发,不算未读
      const r = await this.rpc('group-sync', gid, { groupId: gid, memberId: g.memberId, afterSeq: 0, markRead: false, limit: 200 })
      if (!r.ok) continue
      const data = r.data as { msgs: GroupStoredMsg[]; seq: number }
      const unreadMsgs = (data.msgs ?? []).filter((m) => m.seq > g.lastReadSeq && m.from.memberId !== g.memberId)
      const msgs = this.decryptAll(key, unreadMsgs)
      items.push({
        groupId: gid,
        groupName: g.groupName,
        unread: msgs.length,
        previews: msgs.slice(-3),
        mentionsMe: msgs.some((m) => m.mentions?.includes(name)),
      })
    }
    void body
    return { ok: true, data: { items } }
  }

  private async opLeave(_name: string, rec: AgentRec, body: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    let gid = String(body.groupId ?? '')
    let g: AgentGroupRec
    try {
      const r = this.resolveGroup(rec, gid || undefined)
      gid = r.groupId
      g = r.g
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    const r = await this.rpc('group-leave', gid, { groupId: gid, memberId: g.memberId })
    if (!r.ok) return { ok: false, error: `${r.error?.code}: ${r.error?.message}` }
    delete rec.groups[gid]
    this.save()
    return { ok: true }
  }

  // ─── 工具 ──────────────────────────────────────────────────────────────────

  private keyOf(gid: string): Uint8Array | null {
    const b64 = this.state.keys[gid]
    if (!b64) return null
    return new Uint8Array(Buffer.from(b64, 'base64'))
  }

  private decryptAll(key: Uint8Array, msgs: GroupStoredMsg[]): ChatMsg[] {
    const out: ChatMsg[] = []
    for (const m of msgs) {
      try {
        const pt = JSON.parse(new TextDecoder().decode(open(key, new Uint8Array(Buffer.from(m.ct, 'base64'))))) as GroupPlaintext
        if (pt.kind !== 'text' || typeof (pt as { text?: unknown }).text !== 'string') continue
        out.push({
          seq: m.seq,
          ts: m.ts,
          fromName: m.from.name,
          fromHuman: m.from.human,
          text: (pt as { text: string }).text,
          mentions: m.mentions,
          replyTo: m.replyTo,
        })
      } catch {
        /* 解密失败(钥不齐/被篡改):跳过该条,不拖死整批 */
      }
    }
    return out
  }

  /** 群操作 req/resp:发信封,等 group-result(reqId 配对),超时抛。 */
  private rpc(op: GroupOp, groupId: string | undefined, payload: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<GroupResult> {
    const reqId = 'qc_' + randomBytes(6).toString('hex')
    return new Promise<GroupResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error('群操作超时(中继未应答;确认 ce 已连上中继)'))
      }, timeoutMs)
      this.pending.set(reqId, { resolve, timer })
      this.opts.sendEnvelope({ op, groupId, reqId, payload })
    })
  }
}
