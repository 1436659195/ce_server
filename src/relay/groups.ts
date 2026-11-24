/**
 * GroupRegistry —— 群聊注册表(relay 侧纯逻辑,可假 WS 单测,与 Hub 同哲学)。
 *
 * 职责:群/成员/邀请/密文消息的登记与路由。GroupFrame(9) 的所有 op 在此处理:
 *   - **信封可读,正文不可读**:只解析 GroupEnvelope(groupId/op/reqId)与路由元数据
 *     (成员表/群名),消息正文 ct 是群钥密文,本模块从不解密(E2E 定案,见
 *     ce-platform docs/plans/2026-11-19-agent-group-chat-design.md §3)。
 *   - **from 由 hub 钳定,不信客户端**:phone 发帖 → 按连接 phoneId 解析其 human 成员;
 *     ce 发帖 → 校验 memberId 的 machineId 归属(防跨机冒名;同机进程互信与 ce 现状一致)。
 *   - **seq 单调**:relay 统一分配;消息按 seq 追加存储,成员断线靠 group-sync 按 seq 补,
 *     不做离线缓冲(msgs 库即真源)。
 *   - **未读不发纪律**:post 携带发送方 readUpTo,落后于他人最新 → 拒 new_messages
 *     并附带那些消息(已替其标读)。
 *
 * 持久化经 Hub 注入的 load/save 回调(加密落盘,与 sid/token state 同机制);
 * wire 编解码复用 shared/frame(本模块只见信封 JSON 串)。
 */
import { randomBytes } from 'node:crypto'
import {
  GROUP_LIMITS,
  type GroupAckReq,
  type GroupEnvelope,
  type GroupAgentCodeInfo,
  type GroupHireInfo,
  type GroupInvite,
  type GroupJoinReq,
  type GroupLeaveReq,
  type GroupMember,
  type GroupMeta,
  type GroupMetaEvent,
  type GroupPostReq,
  type GroupRevokeReq,
  type GroupResult,
  type GroupSnapshot,
  type GroupStoredMsg,
  type GroupSyncReq,
} from '../shared/group'

/** 群成员连接的最小 WS 接口(与 hub.RelayWS 结构兼容;本地重声明避免循环依赖)。 */
interface GroupWS {
  send(data: string): void
}

/** Hub 提供的上下文(连接身份 + 发送 + 持久化回调)。 */
export interface GroupRegistryCtx {
  /** 连接身份(未注册 ws → undefined)。cid 即被控机标识(register(cid) 的同一标识)。 */
  meta(src: GroupWS): { role: 'cli' | 'phone' | 'guest'; phoneId?: string; cid?: string } | undefined
  /** 发原始 wire 字符串(实现内自 try/catch)。 */
  send(ws: GroupWS, data: string): void
  /** 读持久化全文(无 → null);写全文(明文,由 Hub 负责加密)。 */
  loadState(): string | null
  saveState(plain: string): void
}

/** 内存中的群状态(成员/opKeys 用 Map,持久化时转数组)。 */
interface GroupStore {
  meta: GroupMeta
  ownerPhoneId: string
  members: Map<string, GroupMember>
  msgs: GroupStoredMsg[]
  seq: number
  /** 消息库裁剪后剩余的最小 seq(sync 早于此的按 baseSeq 钳制)。 */
  baseSeq: number
  opKeys: Map<string, number>
  invites: GroupInvite[]
  /** 群钥密文槽(memberId → slot;成员机离线时暂存,连上即转,转达即焚)。relay 不解槽。 */
  slots: Map<string, string>
  /** 雇佣码(网页访客凭据;随房间存续,group-hire-set 轮换即换)。缺省 = 未开门。 */
  hire?: { code: string; createdAt: number }
  /** 外部 agent 接入码(2026-11-20 2-2):一码一座 —— 首个 pair 绑定 memberId,同码重连即重绑。 */
  agentCodes: Array<{ code: string; memberId?: string; createdAt: number }>
}

/** 单群存量上限(防无限增长;裁剪只掉最旧,seq 连续性由 baseSeq 记录)。 */
const MAX_STORED_MSGS = 5000

/** 邀请码字符集(去易混淆 I/L/O/0/1),8 位 XXXX-XXXX。 */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function randId(n = 8): string {
  return randomBytes(n).toString('hex')
}

function inviteCode(): string {
  const bytes = randomBytes(8)
  const chars = Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

function now(): number {
  return Date.now()
}

function err(code: string, message: string): GroupResult {
  return { reqId: '', ok: false, error: { code, message } }
}

/** 客户端可发起的 op(relay 单向下发的四个排除在外)。 */
type ClientOp = Exclude<
  import('../shared/group').GroupOp,
  'group-msg' | 'group-meta' | 'group-result' | 'group-keyslot'
>

/** 连接身份(hub wsMeta 的形状;本地重声明避免循环依赖)。 */
type Ctx = { role: 'cli' | 'phone' | 'guest'; phoneId?: string; cid?: string }

export class GroupRegistry {
  private groups = new Map<string, GroupStore>()
  /** 群 → 在线成员连接(任何 op 触达即挂上;断开即摘除;离线靠 sync 补)。 */
  private fanout = new Map<string, Set<GroupWS>>()
  /** 连接 → 它代表的成员键([groupId, memberId]):断开时反查清理 + 群钥槽定向转发。 */
  private connMembers = new Map<GroupWS, Array<[string, string]>>()
  /** 内存已退群但尚未确认落盘的成员；只供原身份重试，不参与收发鉴权。 */
  private pendingLeaves = new Map<string, Map<string, GroupMember>>()
  private readonly ctx: GroupRegistryCtx

  constructor(ctx: GroupRegistryCtx) {
    this.ctx = ctx
    this.load()
  }

  // ─── 持久化(v1 groups-state,键 = groupId;复用 hub 的加密落盘)────────────────

  private load(): void {
    try {
      const raw = this.ctx.loadState()
      if (!raw) return
      const o = JSON.parse(raw) as { v?: number; groups?: Array<{ id: string } & Record<string, unknown>> }
      if (o.v !== 1 || !Array.isArray(o.groups)) return
      for (const s of o.groups) {
        if (!s?.id) continue
        const hire = s.hire as { code: string; createdAt: number } | undefined
        this.groups.set(s.id, {
          meta: s.meta as GroupMeta,
          ownerPhoneId: s.ownerPhoneId as string,
          members: new Map(s.members as [string, GroupMember][]),
          msgs: (s.msgs as GroupStoredMsg[]) ?? [],
          seq: (s.seq as number) ?? 0,
          baseSeq: (s.baseSeq as number) ?? (s.msgs as GroupStoredMsg[])?.[0]?.seq ?? 1,
          opKeys: new Map((s.opKeys as [string, number][]) ?? []),
          invites: (s.invites as GroupInvite[]) ?? [],
          slots: new Map((s.slots as [string, string][]) ?? []),
          hire,
          agentCodes: (s.agentCodes as Array<{ code: string; memberId?: string; createdAt: number }>) ?? [],
        })
      }
    } catch {
      /* 损坏 → 空(与 hub.loadState 同兜底) */
    }
  }

  private save(): boolean {
    try {
      const groups = Array.from(this.groups.entries()).map(([id, g]) => ({
        id,
        meta: g.meta,
        ownerPhoneId: g.ownerPhoneId,
        members: Array.from(g.members.entries()),
        msgs: g.msgs,
        seq: g.seq,
        baseSeq: g.baseSeq,
        opKeys: Array.from(g.opKeys.entries()),
        invites: g.invites,
        slots: Array.from(g.slots.entries()),
        hire: g.hire,
        agentCodes: g.agentCodes,
      }))
      this.ctx.saveState(JSON.stringify({ v: 1, groups }))
      return true
    } catch {
      /* 本次内存仍有效；需要持久化确认的操作据 false 返回可重试错误。 */
      return false
    }
  }

  // ─── 生命周期 ──────────────────────────────────────────────────────────────

  /** 连接断开:从所有群扇出集摘除(成员资格与消息保留;presence 由 lastSeenAt 推导)。 */
  onClose(ws: GroupWS): void {
    for (const set of this.fanout.values()) set.delete(ws)
    this.connMembers.delete(ws)
  }

  /** 供测试断言的只读视图。 */
  groupIds(): string[] {
    return Array.from(this.groups.keys())
  }

  // ─── 入口 ──────────────────────────────────────────────────────────────────

  /**
   * 处理一条 GroupFrame 载荷(信封 JSON 串,hub 已从帧 payload 解出)。
   * 返回 true=已按群帧处理(含错误应答);false=不是合法群帧(交回 hub 兜底路由)。
   */
  handle(src: GroupWS, envelopeJson: string): boolean {
    let env: GroupEnvelope
    try {
      env = JSON.parse(envelopeJson) as GroupEnvelope
    } catch {
      this.reply(src, err('no_group', '信封不是合法 JSON'))
      return true
    }
    if (!env.op || typeof env.op !== 'string') {
      this.reply(src, err('no_group', '缺 op'))
      return true
    }
    // relay→客户端方向的 op 不收(防伪造广播/伪造群钥槽)
    if (env.op === 'group-msg' || env.op === 'group-meta' || env.op === 'group-result' || env.op === 'group-keyslot') {
      this.reply(src, err('no_group', `${env.op} 是 relay 单向下发 op`))
      return true
    }
    const id = this.metaOverride ? this.metaOverride(src) : this.ctx.meta(src)
    if (!id) {
      this.reply(src, err('not_member', '连接未注册'), env.reqId)
      return true
    }
    const fn = (this.ops as Record<string, (src: GroupWS, id: Ctx, env: GroupEnvelope) => void>)[env.op]
    if (!fn) {
      this.reply(src, err('no_group', `未知 op=${env.op}`), env.reqId)
      return true
    }
    fn.call(this, src, id, env)
    return true
  }

  private reply(src: GroupWS, result: GroupResult, reqId?: string): void {
    result.reqId = reqId ?? result.reqId
    this.send(src, { op: 'group-result', payload: result })
  }

  private broadcast(groupId: string, env: GroupEnvelope): void {
    const set = this.fanout.get(groupId)
    if (!set) return
    const wire = this.wire(env)
    for (const ws of set) {
      try {
        this.ctx.send(ws, wire)
      } catch {
        /* ws 已关 */
      }
    }
  }

  private send(ws: GroupWS, env: GroupEnvelope): void {
    try {
      this.ctx.send(ws, this.wire(env))
    } catch {
      /* ws 已关 */
    }
  }

  /** 信封 → wire 字符串(与 frame.ts 同形:{type:9,payload:base64(json)};此处直接产串省一次编解码)。 */
  private wire(env: GroupEnvelope): string {
    return JSON.stringify({ type: 9, payload: Buffer.from(JSON.stringify(env), 'utf8').toString('base64') })
  }

  // ─── 成员解析(hub 钳定 from)────────────────────────────────────────────────

  /** phone → 其 human 成员;guest → 断言 memberId(须 guest 成员);cli → 断言 memberId 校验
   *  machineId,或按 cid 唯一成员。 */
  private member(id: Ctx, g: GroupStore, asserted?: string, src?: GroupWS, members = g.members): GroupMember | undefined {
    if (id.role === 'phone') {
      if (!id.phoneId) return undefined
      for (const m of members.values()) if (m.phoneId === id.phoneId) return m
      return undefined
    }
    if (id.role === 'guest') {
      const m = asserted ? members.get(asserted) : undefined
      // HTTP shim 的身份已由接入码验证；真实 WS 必须只使用自己已绑定的座位。
      const bound = this.metaOverride || (src && this.connMembers.get(src)?.some(([gid, mid]) => this.groups.get(gid) === g && mid === asserted))
      return m && m.guest && bound ? m : undefined
    }
    if (asserted) {
      const m = members.get(asserted)
      return m && m.machineId && m.machineId === id.cid ? m : undefined
    }
    for (const m of members.values()) if (!m.human && m.machineId === id.cid) return m
    return undefined
  }

  private fanoutAdd(groupId: string, ws: GroupWS): void {
    let set = this.fanout.get(groupId)
    if (!set) {
      set = new Set()
      this.fanout.set(groupId, set)
    }
    set.add(ws)
  }

  /** 记录「这条连接代表哪个成员」(断开清理 + 群钥槽定向转发用);flush 该成员的待转槽。 */
  private bindMember(groupId: string, memberId: string, ws: GroupWS): void {
    const list = this.connMembers.get(ws) ?? []
    if (!list.some(([g, m]) => g === groupId && m === memberId)) list.push([groupId, memberId])
    this.connMembers.set(ws, list)
    // 成员机连上瞬间,补投还没送到的群钥槽(转达即焚)
    const g = this.groups.get(groupId)
    const slot = g?.slots.get(memberId)
    if (g && slot) {
      this.send(ws, { op: 'group-keyslot', groupId, payload: { groupId, slot } })
      g.slots.delete(memberId)
      this.save()
    }
  }

  /** 只摘除该座位；同连接仍代表的其他房间/身份继续接收。 */
  private unbindMember(groupId: string, memberId: string): void {
    for (const [ws, bindings] of this.connMembers) {
      if (!bindings.some(([gid, mid]) => gid === groupId && mid === memberId)) continue
      const remaining = bindings.filter(([gid, mid]) => gid !== groupId || mid !== memberId)
      if (remaining.length) this.connMembers.set(ws, remaining)
      else this.connMembers.delete(ws)
      if (!remaining.some(([gid]) => gid === groupId)) this.fanout.get(groupId)?.delete(ws)
    }
  }

  /** save 保存全表；确认成功后，补发此前因持久化失败而暂缓的退群通知。 */
  private finishPendingLeaves(): void {
    const pending = this.pendingLeaves
    this.pendingLeaves = new Map()
    for (const [groupId, members] of pending) {
      if (!this.groups.has(groupId)) continue
      for (const member of members.values()) {
        this.broadcast(groupId, { op: 'group-meta', groupId, payload: { event: 'member-left', groupId, member } satisfies GroupMetaEvent })
        this.unbindMember(groupId, member.memberId)
        for (const cb of this.memberRemovedListeners) {
          try { cb(groupId, member.memberId) } catch { /* 观察者失败不回滚已保存的退群 */ }
        }
      }
    }
  }

  // ─── op 实现(表驱动,与 handle 的分发对齐)────────────────────────────────────

  private ops: { [K in ClientOp]: (src: GroupWS, id: Ctx, env: GroupEnvelope) => void } = {
    'group-create': (src, id, env) => {
      if (id.role !== 'phone' || !id.phoneId) {
        this.reply(src, err('not_member', '只有手机能建群'), env.reqId)
        return
      }
      const p = env.payload as { meta?: Partial<GroupMeta>; ownerName?: string } | undefined
      const name = p?.meta?.name?.trim()
      const ownerName = p?.ownerName?.trim()
      if (!name || !ownerName) {
        this.reply(src, err('no_group', '缺群名/主人名'), env.reqId)
        return
      }
      for (const g of this.groups.values()) {
        if (g.ownerPhoneId === id.phoneId && g.meta.name === name) {
          this.reply(src, err('group_exists', `已有同名群「${name}」`), env.reqId)
          return
        }
      }
      const t = now()
      const g: GroupStore = {
        meta: { name, topic: p?.meta?.topic, rules: p?.meta?.rules, createdAt: t, createdBy: id.phoneId },
        ownerPhoneId: id.phoneId,
        members: new Map(),
        msgs: [],
        seq: 0,
        baseSeq: 1,
        opKeys: new Map(),
        invites: [],
        slots: new Map(),
        agentCodes: [],
      }
      const owner: GroupMember = {
        memberId: 'm_' + randId(4),
        name: ownerName,
        human: true,
        phoneId: id.phoneId,
        joinedAt: t,
        lastSeenAt: t,
        readUpTo: 0,
      }
      g.members.set(owner.memberId, owner)
      const groupId = 'g_' + randId(6)
      this.groups.set(groupId, g)
      this.fanoutAdd(groupId, src)
      this.save()
      this.reply(src, { reqId: env.reqId ?? '', ok: true, data: { groupId, snapshot: this.snapshot(g) } })
    },

    'group-invite': (src, id, env) => {
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      if (id.role !== 'phone' || id.phoneId !== g.ownerPhoneId) {
        this.reply(src, err('not_member', '只有群主能发邀请'), env.reqId)
        return
      }
      const ttl = (env.payload as { ttlMs?: number } | undefined)?.ttlMs ?? GROUP_LIMITS.inviteTtlMs
      const inv: GroupInvite = { code: inviteCode(), groupId: env.groupId!, expiresAt: now() + ttl, usesLeft: GROUP_LIMITS.inviteUses }
      g.invites.push(inv)
      this.save()
      this.reply(src, { reqId: env.reqId ?? '', ok: true, data: inv })
    },

    'group-join': (src, id, env) => {
      if (id.role !== 'cli' || !id.cid) {
        this.reply(src, err('not_member', '只有被控机 ce 能 join'), env.reqId)
        return
      }
      const p = env.payload as GroupJoinReq | undefined
      if (!p?.inviteCode || !p.member?.name) {
        this.reply(src, err('code_invalid', '缺 inviteCode/name'), env.reqId)
        return
      }
      this.doJoin(src, p, id.cid, env)
    },

    'group-post': (src, id, env) => {
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      const p = env.payload as GroupPostReq | undefined
      if (!p?.ct) {
        this.reply(src, err('no_group', '缺正文'), env.reqId)
        return
      }
      const m = this.member(id, g, p.memberId, src)
      if (!m) {
        this.reply(src, err('not_member', '发送方不在群内(或 machineId 不符)'), env.reqId)
        return
      }
      this.doPost(src, g, m, p, env)
    },

    'group-sync': (src, id, env) => {
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      const p = env.payload as GroupSyncReq | undefined
      const m = this.member(id, g, p?.memberId, src)
      if (!m) {
        this.reply(src, err('not_member', '不在群内'), env.reqId)
        return
      }
      // markRead=false(心跳/偷看)不刷 lastSeenAt(2026-11-20 真机抓出的卫兵污染):
      // daemon bootSync 对所有注册群周期发 markRead:false 的 sync,若无条件刷新,
      // CC 死后身份也永远「活跃」→ reclaim 15 分钟卫兵永久失效(agent 搬不了家)。
      // presence 语义同步修正:没真读就不算在场。
      if (p?.markRead !== false) m.lastSeenAt = now()
      this.fanoutAdd(env.groupId!, src)
      const after = Math.max(p?.afterSeq ?? 0, g.baseSeq - 1)
      const limit = p?.limit ?? GROUP_LIMITS.syncDefaultLimit
      const msgs = g.msgs.filter((msg) => msg.seq > after).slice(0, limit)
      // markRead=false 是「偷看」(inbox 预览):不推进已读游标(缺省 true,读即标读)
      if (p?.markRead !== false) m.readUpTo = Math.max(m.readUpTo, msgs.length ? msgs[msgs.length - 1].seq : 0)
      this.save()
      // members 随行(2026-11-20):手机/客户端成员名单不能只靠实时广播 —— 掉线错过
      // member-joined 就永久陈旧;sync 是重连自愈路,顺手对齐名单(只加不破)。
      this.reply(src, { reqId: env.reqId ?? '', ok: true, data: { msgs, seq: g.seq, members: Array.from(g.members.values()), meta: g.meta } })
    },

    'group-ack': (src, id, env) => {
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      const p = env.payload as GroupAckReq | undefined
      const m = this.member(id, g, p?.memberId, src)
      if (!m) {
        this.reply(src, err('not_member', '不在群内'), env.reqId)
        return
      }
      m.readUpTo = Math.max(m.readUpTo, p?.upToSeq ?? 0)
      m.lastSeenAt = now()
      this.save()
      this.reply(src, { reqId: env.reqId ?? '', ok: true })
    },

    'group-leave': (src, id, env) => {
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      const p = env.payload as GroupLeaveReq | undefined
      const pending = this.pendingLeaves.get(env.groupId!)
      const m = this.member(id, g, p?.memberId, src) ?? (pending && this.member(id, g, p?.memberId, src, pending))
      if (!m) {
        // 内存缺席不足以证明持久退群；botRetire 将 not_member 视为幂等完成。
        if (!this.save()) {
          this.reply(src, err('storage_error', '退群状态保存失败，请保持连接并重试'), env.reqId)
          return
        }
        this.finishPendingLeaves()
        this.reply(src, err('not_member', '不在群内'), env.reqId)
        return
      }
      if (m.human && m.phoneId === g.ownerPhoneId) {
        this.reply(src, err('owner_leave', '群主不能退群(v1 请解散)'), env.reqId)
        return
      }
      g.members.delete(m.memberId)
      g.slots.delete(m.memberId)
      const leaving = pending ?? new Map<string, GroupMember>()
      leaving.set(m.memberId, m)
      this.pendingLeaves.set(env.groupId!, leaving)
      if (!this.save()) {
        this.reply(src, err('storage_error', '退群状态保存失败，请保持连接并重试'), env.reqId)
        return
      }
      this.finishPendingLeaves()
      this.reply(src, { reqId: env.reqId ?? '', ok: true })
    },

    'group-dissolve': (src, id, env) => {
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      if (id.role !== 'phone' || id.phoneId !== g.ownerPhoneId) {
        this.reply(src, err('not_member', '只有群主能解散'), env.reqId)
        return
      }
      this.broadcast(env.groupId!, { op: 'group-meta', groupId: env.groupId, payload: { event: 'dissolved', groupId: env.groupId! } satisfies GroupMetaEvent })
      this.groups.delete(env.groupId!)
      this.fanout.delete(env.groupId!)
      this.save()
      this.reply(src, { reqId: env.reqId ?? '', ok: true })
    },

    'group-keyslot-set': (src, id, env) => {
      // 群钥密文槽:只存转,永不解(E2E 定案)。群主限定 —— 槽是手机封的。
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      if (id.role !== 'phone' || id.phoneId !== g.ownerPhoneId) {
        this.reply(src, err('not_member', '只有群主能下发群钥槽'), env.reqId)
        return
      }
      const p = env.payload as { memberId?: string; slot?: string } | undefined
      if (!p?.memberId || !p.slot || !g.members.has(p.memberId)) {
        this.reply(src, err('not_member', '槽需要有效 memberId'), env.reqId)
        return
      }
      // 在线即转,转达即焚;离线暂存,bindMember(重连/同步触达)补投
      const list = Array.from(this.connMembers.entries()).find(([, members]) =>
        members.some(([gid, mid]) => gid === env.groupId && mid === p.memberId),
      )
      if (list) {
        try {
          this.ctx.send(list[0], this.wire({ op: 'group-keyslot', groupId: env.groupId, payload: { groupId: env.groupId, slot: p.slot } }))
          g.slots.delete(p.memberId)
        } catch {
          g.slots.set(p.memberId, p.slot)
        }
      } else {
        g.slots.set(p.memberId, p.slot)
      }
      this.save()
      this.reply(src, { reqId: env.reqId ?? '', ok: true })
    },

    'group-hire-set': (src, id, env) => {
      // 雇佣码签发/轮换:群主限定;再调一次 = 轮换(旧码即死)。relay 不看 meta.kind ——
      // kind 是手机/ce 的语义标签,relay 只管凭据(哑管道)。
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      if (id.role !== 'phone' || id.phoneId !== g.ownerPhoneId) {
        this.reply(src, err('not_member', '只有群主能签发雇佣码'), env.reqId)
        return
      }
      g.hire = { code: inviteCode(), createdAt: now() }
      this.save()
      const info: GroupHireInfo = { code: g.hire.code, groupId: env.groupId!, createdAt: g.hire.createdAt }
      this.reply(src, { reqId: env.reqId ?? '', ok: true, data: info })
    },

    'group-agent-code-set': (src, id, env) => {
      // 外部 agent 接入码(2-2):群主限定;追加制(一码一座),存活上限 20,满了拒 too_large。
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      if (id.role !== 'phone' || id.phoneId !== g.ownerPhoneId) {
        this.reply(src, err('not_member', '只有群主能签发外部 agent 接入码'), env.reqId)
        return
      }
      if (g.agentCodes.length >= 20) {
        this.reply(src, err('too_large', '接入码已达上限(20),请先关闭不用的'), env.reqId)
        return
      }
      const entry = { code: inviteCode(), createdAt: now() }
      g.agentCodes.push(entry)
      this.save()
      const info: GroupAgentCodeInfo = { code: entry.code, groupId: env.groupId!, createdAt: entry.createdAt }
      this.reply(src, { reqId: env.reqId ?? '', ok: true, data: info })
    },

    'group-agent-code-revoke': (src, id, env) => {
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      if (id.role !== 'phone' || id.phoneId !== g.ownerPhoneId) {
        this.reply(src, err('not_member', '只有群主能撤销外部 agent 接入码'), env.reqId)
        return
      }
      const p = env.payload as { code?: unknown } | undefined
      if (typeof p?.code !== 'string' || !p.code.trim()) {
        this.reply(src, err('code_invalid', '缺接入码'), env.reqId)
        return
      }
      const entry = g.agentCodes.find(c => c.code === p.code)
      g.agentCodes = g.agentCodes.filter(c => c.code !== p.code)
      const member = entry?.memberId ? g.members.get(entry.memberId) : undefined
      if (entry?.memberId) {
        g.members.delete(entry.memberId)
        g.slots.delete(entry.memberId)
        this.unbindMember(env.groupId!, entry.memberId)
      }
      const persisted = this.save()
      if (member) {
        for (const cb of this.memberRemovedListeners) {
          try { cb(env.groupId!, member.memberId) } catch { /* 观察者失败不回滚撤销 */ }
        }
        this.broadcast(env.groupId!, { op: 'group-meta', groupId: env.groupId, payload: { event: 'member-left', groupId: env.groupId!, member } satisfies GroupMetaEvent })
      }
      this.reply(src, persisted ? { reqId: env.reqId ?? '', ok: true, data: { revoked: true } } : err('storage_error', '接入已暂时停止，但撤销状态保存失败，请保持连接并重试'), env.reqId)
    },

    'group-revoke': (src, id, env) => {
      // 撤回(宪法 #3):作者本人或群主。relay 置 revokedAt 清 ct,重播 group-msg —— 正文不可恢复。
      const g = env.groupId ? this.groups.get(env.groupId) : undefined
      if (!g) {
        this.reply(src, err('no_group', '群不存在'), env.reqId)
        return
      }
      const p = env.payload as GroupRevokeReq | undefined
      if (!p || typeof p.seq !== 'number') {
        this.reply(src, err('no_group', '缺 seq'), env.reqId)
        return
      }
      const msg = g.msgs.find((m) => m.seq === p.seq)
      if (!msg || msg.revokedAt) {
        this.reply(src, err('no_group', '消息不存在或已撤回'), env.reqId)
        return
      }
      const sender = this.member(id, g, p.memberId, src)
      const isOwner = id.role === 'phone' && id.phoneId === g.ownerPhoneId
      const isAuthor = sender ? sender.memberId === msg.from.memberId : false
      if (!isOwner && !isAuthor) {
        this.reply(src, err('not_member', '只有作者本人或群主能撤回'), env.reqId)
        return
      }
      msg.revokedAt = now()
      msg.ct = ''
      delete msg.opKey
      this.save()
      this.broadcast(env.groupId!, { op: 'group-msg', groupId: env.groupId, payload: msg })
      this.reply(src, { reqId: env.reqId ?? '', ok: true })
    },
  }

  /** /guest 通路的雇佣码验证 + guest 成员绑定(server.ts 的 guest 升级路径调;hub 不经手)。 */
  guestHello(code: string, ws: GroupWS): { ok: true; groupId: string; memberId: string; groupName: string } | { ok: false; error: string } {
    const hit = Array.from(this.groups.entries()).find(([, g]) => g.hire?.code === code)
    if (!hit) return { ok: false, error: '雇佣码不存在(确认链接完整;错 3 次将锁定 24 小时)' }
    const groupId = hit[0]
    const g = hit[1]
    let m = Array.from(g.members.values()).find((x) => x.guest)
    if (!m) {
      if (g.members.size >= GROUP_LIMITS.membersPerGroup) return { ok: false, error: '房间已满' }
      const t = now()
      m = { memberId: 'm_' + randId(4), name: '雇主', human: true, guest: true, joinedAt: t, lastSeenAt: t, readUpTo: g.seq }
      g.members.set(m.memberId, m)
      // 先广播再挂扇出:guest 不收自己的加入事件(与 join 的顺序约定一致)
      this.broadcast(groupId, { op: 'group-meta', groupId, payload: { event: 'member-joined', groupId, member: m } satisfies GroupMetaEvent })
    }
    m.lastSeenAt = now()
    this.fanoutAdd(groupId, ws)
    this.bindMember(groupId, m.memberId, ws)
    this.save()
    return { ok: true, groupId, memberId: m.memberId, groupName: g.meta.name }
  }

  // ─── 外部 agent 网关(2026-11-20 2-2;goals.md 定案三第 3 步)────────────────────

  /**
   * 外部 agent pair(HTTP /guest/api/pair 适配):接入码 → 一码一座成员身份。
   * 同码重连 = 重绑同一成员(与雇佣访客的「复用雇主成员」同语义);成员已退群则重新建座。
   * 名字与 Pachat 对齐:必填,群内唯一(member_exists 时 agent 自己换名或 --reclaim 语义 = 换码)。
   */
  guestHelloAgent(
    code: string,
    name: string,
    platform: string | undefined,
    ws: GroupWS,
  ): { ok: true; groupId: string; memberId: string; groupName: string } | { ok: false; error: string } {
    const hit = Array.from(this.groups.entries()).find(([, g]) => g.agentCodes.some((c) => c.code === code))
    if (!hit) return { ok: false, error: '接入码不存在(检查接入文本块是否完整)' }
    const groupId = hit[0]
    const g = hit[1]
    if (!name?.trim()) return { ok: false, error: '缺名字(--name,群里怎么称呼你)' }
    const clean = name.trim().slice(0, 40)
    const entry = g.agentCodes.find((c) => c.code === code)!
    const t = now()
    let m = entry.memberId ? g.members.get(entry.memberId) : undefined
    if (m && (m.guest === true && !m.human)) {
      // 同码重连:刷新在场,身份不变
      m.lastSeenAt = t
      if (platform) m.platform = platform
    } else {
      // 新座(或旧座已退群):名字占用检查 → member_exists
      if (Array.from(g.members.values()).some((x) => x.name === clean)) {
        return { ok: false, error: `名字「${clean}」已被占用,换一个(--name)` }
      }
      if (g.members.size >= GROUP_LIMITS.membersPerGroup) return { ok: false, error: '房间已满' }
      m = {
        memberId: 'm_' + randId(4),
        name: clean,
        platform,
        human: false,
        guest: true,
        joinedAt: t,
        lastSeenAt: t,
        readUpTo: g.seq,
      }
      g.members.set(m.memberId, m)
      entry.memberId = m.memberId
      this.broadcast(groupId, { op: 'group-meta', groupId, payload: { event: 'member-joined', groupId, member: m } satisfies GroupMetaEvent })
    }
    this.fanoutAdd(groupId, ws)
    this.bindMember(groupId, m.memberId, ws)
    this.save()
    return { ok: true, groupId, memberId: m.memberId, groupName: g.meta.name }
  }

  /**
   * HTTP guest API 的适配入口(2026-11-20):以 guest 身份执行一条信封,同步拿回应答。
   * WS 访客页与 HTTP 外部 agent 走同一套 op/纪律/限速/持久化 —— 零协议分叉。
   * 不落任何连接状态(shim 即弃);op 白名单/未读纪律全由 handle 原路径执行。
   */
  callAsGuest(env: GroupEnvelope): GroupResult {
    const sent: string[] = []
    const shim: GroupWS = { send: (d) => sent.push(d) }
    this.metaOverride = () => ({ role: 'guest' })
    try {
      this.handle(shim, JSON.stringify(env))
    } finally {
      this.metaOverride = undefined
      this.onClose(shim)
    }
    for (const w of sent) {
      try {
        const f = JSON.parse(w) as { type: number; payload: string }
        if (f.type !== 9) continue
        const inner = JSON.parse(Buffer.from(f.payload, 'base64').toString('utf8')) as GroupEnvelope
        const r = inner.payload as GroupResult | undefined
        if (inner.op === 'group-result' && r && r.reqId === env.reqId) return r
      } catch {
        /* 忽略非应答帧 */
      }
    }
    return { reqId: env.reqId ?? '', ok: false, error: { code: 'no_group', message: '无应答' } }
  }

  private metaOverride?: (src: GroupWS) => Ctx | undefined

  /** 外部 agent HTTP API 的凭据解析:接入码 → 房间 + 绑定成员(校验调用方断言的 memberId)。 */
  resolveAgentSeat(
    code: string,
    memberId?: string,
  ): { ok: true; groupId: string; memberId: string; groupName: string } | { ok: false; error: string } {
    const hit = Array.from(this.groups.entries()).find(([, g]) => g.agentCodes.some((c) => c.code === code))
    if (!hit) return { ok: false, error: '接入码不存在(检查接入文本块是否完整)' }
    const g = hit[1]
    const entry = g.agentCodes.find((c) => c.code === code)!
    if (!entry.memberId) return { ok: false, error: '该码还没有 pair 过(先走 pair)' }
    if (memberId && memberId !== entry.memberId) return { ok: false, error: 'memberId 与该码绑定的身份不符(凭据拿错了?)' }
    const m = g.members.get(entry.memberId!)
    if (!m) return { ok: false, error: '绑定成员已不在房间' }
    return { ok: true, groupId: hit[0], memberId: m.memberId, groupName: g.meta.name }
  }

  // ─── post 钩子(HTTP 长轮询用;server.ts 注册)──────────────────────────────────

  private postListeners = new Set<(groupId: string, msg: GroupStoredMsg) => void>()
  private memberRemovedListeners = new Set<(groupId: string, memberId: string) => void>()

  /** HTTP 长轮询在座位撤销时立即结束，不能等待后续消息或超时。 */
  onMemberRemoved(cb: (groupId: string, memberId: string) => void): () => void {
    this.memberRemovedListeners.add(cb)
    return () => this.memberRemovedListeners.delete(cb)
  }

  /** 注册「有新消息」回调(返回注销函数)。HTTP guest 长轮询靠它在有新货时立刻返回。 */
  onPosted(cb: (groupId: string, msg: GroupStoredMsg) => void): () => void {
    this.postListeners.add(cb)
    return () => this.postListeners.delete(cb)
  }

  private doJoin(src: GroupWS, p: GroupJoinReq, cid: string, env: GroupEnvelope): void {
    const inv = this.findInvite(p.inviteCode)
    if (!inv) {
      this.reply(src, err('code_invalid', '邀请码不存在'), env.reqId)
      return
    }
    if (inv.expiresAt < now()) {
      this.reply(src, err('code_expired', '邀请已过期,请群主重发'), env.reqId)
      return
    }
    if (inv.usesLeft <= 0) {
      this.reply(src, err('code_used', '邀请次数已用完,请群主重发'), env.reqId)
      return
    }
    const g = this.groups.get(inv.groupId)
    if (!g) {
      this.reply(src, err('no_group', '群不存在'), env.reqId)
      return
    }
    const t = now()
    let member: GroupMember
    if (p.reclaim) {
      const old = Array.from(g.members.values()).find((m) => m.name === p.member.name && !m.human)
      if (!old) {
        this.reply(src, err('member_exists', `群里没有叫「${p.member.name}」的 agent 身份`), env.reqId)
        return
      }
      if (t - old.lastSeenAt < GROUP_LIMITS.reclaimActiveGuardMs) {
        this.reply(src, err('member_active', '该身份 15 分钟内仍活跃,疑似双开;请在手机端处理'), env.reqId)
        return
      }
      old.machineId = cid
      old.cwd = p.member.cwd ?? old.cwd
      old.platform = p.member.platform ?? old.platform
      member = old
    } else {
      if (Array.from(g.members.values()).some((m) => m.name === p.member.name)) {
        this.reply(src, err('member_exists', `名字「${p.member.name}」已被占用(同名旧身份用 reclaim 认领)`), env.reqId)
        return
      }
      if (g.members.size >= GROUP_LIMITS.membersPerGroup) {
        this.reply(src, err('too_many_members', '群已满'), env.reqId)
        return
      }
      member = {
        memberId: 'm_' + randId(4),
        name: p.member.name,
        platform: p.member.platform,
        machineId: cid,
        cwd: p.member.cwd,
        joinedAt: t,
        lastSeenAt: t,
        readUpTo: g.seq, // 快照带尾巴,视为已看到
      }
      g.members.set(member.memberId, member)
    }
    // 限次:用一次减一次(顺手清过期的;用尽的保留到过期,join 才能报出 code_used 而非不存在)
    inv.usesLeft--
    g.invites = g.invites.filter((i) => i.expiresAt >= t)
    member.lastSeenAt = t
    if (p.member.pubKey) member.pubKey = p.member.pubKey
    this.fanoutAdd(inv.groupId, src)
    this.bindMember(inv.groupId, member.memberId, src)
    this.save()
    this.broadcast(inv.groupId, { op: 'group-meta', groupId: inv.groupId, payload: { event: 'member-joined', groupId: inv.groupId, member } satisfies GroupMetaEvent })
    this.reply(src, { reqId: env.reqId ?? '', ok: true, data: { groupId: inv.groupId, snapshot: this.snapshot(g) } })
  }

  private findInvite(code: string): GroupInvite | undefined {
    for (const g of this.groups.values()) {
      for (const inv of g.invites) if (inv.code === code) return inv
    }
    return undefined
  }

  private doPost(src: GroupWS, g: GroupStore, m: GroupMember, p: GroupPostReq, env: GroupEnvelope): void {
    // 幂等:同 opKey 直接回已存 seq
    if (p.opKey) {
      const seen = g.opKeys.get(p.opKey)
      if (seen !== undefined) {
        this.reply(src, { reqId: env.reqId ?? '', ok: true, data: { seq: seen, dedup: true } })
        return
      }
    }
    // 未读不发纪律:他人最新 seq > 己方 readUpTo → 拒发并附带那些消息(替其标读)
    // guest 先过发言限速(雇佣房间防刷;按近 1h 该成员条数计)
    if (m.guest) {
      const hourAgo = now() - 3_600_000
      if (g.msgs.filter((x) => x.from.memberId === m.memberId && x.ts > hourAgo).length >= GROUP_LIMITS.guestMsgsPerHour) {
        this.reply(src, err('rate_limited', '发言太频繁,稍后再试'))
        return
      }
    }
    const othersLatest = [...g.msgs].reverse().find((msg) => msg.from.memberId !== m.memberId)?.seq ?? 0
    if (othersLatest > (p.readUpTo ?? 0)) {
      const unread = g.msgs.filter((msg) => msg.seq > (p.readUpTo ?? 0) && msg.from.memberId !== m.memberId)
      m.readUpTo = Math.max(m.readUpTo, othersLatest)
      m.lastSeenAt = now()
      this.save()
      this.reply(src, {
        reqId: env.reqId ?? '',
        ok: false,
        error: { code: 'new_messages', message: '有未读消息,先 read 再 send' },
        data: { msgs: unread },
      })
      return
    }
    if (p.ct.length > GROUP_LIMITS.plaintextMaxChars * 2) {
      this.reply(src, err('too_large', '正文超限'))
      return
    }
    const msg: GroupStoredMsg = {
      seq: ++g.seq,
      ts: now(),
      from: { memberId: m.memberId, name: m.name, human: m.human, guest: m.guest || undefined },
      ct: p.ct,
      opKey: p.opKey,
      replyTo: p.replyTo,
      mentions: p.mentions,
    }
    g.msgs.push(msg)
    if (g.msgs.length > MAX_STORED_MSGS) {
      g.msgs.splice(0, g.msgs.length - MAX_STORED_MSGS)
      g.baseSeq = g.msgs[0].seq
    }
    if (p.opKey) g.opKeys.set(p.opKey, msg.seq)
    m.readUpTo = Math.max(m.readUpTo, msg.seq)
    m.lastSeenAt = now()
    this.save()
    this.broadcast(env.groupId!, { op: 'group-msg', groupId: env.groupId, payload: msg })
    for (const cb of this.postListeners) {
      try {
        cb(env.groupId!, msg)
      } catch {
        /* 单个监听者异常不拖累 */
      }
    }
    const hint = p.mentions?.filter((n) => !Array.from(g.members.values()).some((mm) => mm.name === n))
    this.reply(src, { reqId: env.reqId ?? '', ok: true, data: { seq: msg.seq, ...(hint?.length ? { mentionHint: hint } : {}) } })
  }

  private snapshot(g: GroupStore): GroupSnapshot {
    return {
      meta: g.meta,
      members: Array.from(g.members.values()),
      seq: g.seq,
      msgs: g.msgs.slice(-GROUP_LIMITS.snapshotTail),
    }
  }
}
