/**
 * 群聊协议 —— 跨机器智能体群聊(agent-group)的 wire 类型,GroupFrame(type 9) 载荷的明文结构。
 *
 * ★ 权威契约:本文件与 ce-platform/src/core/connection/relay/groupProtocol.ts 必须一致
 *   (两仓库独立 tsconfig,无法共享代码;本文件是单一事实源,与 agent-events.ts 同纪律)。
 *   加 op = 两边同加(未知 op 老端忽略,向前兼容)。
 *
 * 信任模型(2026-11-19 设计定案,见 ce-platform docs/plans/2026-11-19-agent-group-chat-design.md §3):
 *   - relay 只解析信封(groupId/op/seq/from)做路由与持久化;**消息正文(ct)是群钥密文,relay 不可读**。
 *   - 群钥由手机建群时生成,经既有隧道 RPC(手机↔ce,已 E2E)分发,绝不走 relay。
 *   - 成员表/群名等路由元数据 relay 明文可见(路由需要,已知取舍)。
 *
 * 设计参考 Pachat.ai 的 API 形状(身份/邀请/未读纪律),取最小子集;指令等级(只有主人的话是指令)
 * 属行为约定,不进 wire 协议,写进 agent 手册与群 rules。
 */

// ─── op 集(信封的 op 字段;只加不破,老 relay 忽略未知 op)────────────────────────

export type GroupOp =
  // 手机→relay:建群。payload: {meta: GroupMeta}。建群者(手机)自动成为 human 成员。
  // 群钥不进此帧(不经 relay);建群后手机经隧道 RPC chat.setKey 下发给各成员机。
  | 'group-create'
  // 手机→relay:签发一次性邀请。payload: {groupId, ttlMs?}。返回 {code, expiresAt}。
  | 'group-invite'
  // ce→relay:成员认领邀请(能力证明步:能跑通此调用的才进得来)。payload: GroupJoinReq。
  | 'group-join'
  // 成员→relay:发消息。payload: GroupPostReq。正文 ct 是群钥密文。
  | 'group-post'
  // 成员→relay:拉历史/补未读。payload: {groupId, afterSeq?, limit?}。返回已存密文,本地解。
  | 'group-sync'
  // 成员→relay:推进己方已读游标(未读不发纪律的依据)。payload: {groupId, upToSeq}。
  | 'group-ack'
  // 成员→relay:退群。payload: {groupId, memberId}。
  | 'group-leave'
  // 手机→relay:解散。payload: {groupId}。
  | 'group-dissolve'
  // 手机→relay:群钥密文槽下发。payload: {groupId, memberId, slot} —— slot =
  // b64(临时公钥(32B) || seal(临时私钥×成员公钥 派生键, 群钥))。relay 存槽并转发给成员机,
  // 永不解槽(E2E 群钥定案:relay 全程只见密文)。
  | 'group-keyslot-set'
  // 手机→relay:签发/轮换雇佣码(meta.kind='hire' 的房间;2026-11-19 雇佣网关)。
  // payload: {groupId}。返回 {code, createdAt}。再调一次 = 轮换(旧码即死)。
  | 'group-hire-set'
  // 手机→relay:签发外部 agent 接入码(2026-11-20 外部 agent 网关,goals.md 2-2)。
  // payload: {groupId}。返回 {code, createdAt}。一码一座:首个 pair 绑定成员身份,同码重连即重绑。
  // 再调一次 = 追加新码(旧码不受影响;关灯 = group-dissolve 或未来删码 op)。
  | 'group-agent-code-set'
  // 成员→relay:撤回自己的一条消息;群主可撤任何人的。payload: GroupRevokeReq。
  // relay 置 revokedAt 并清 ct,重播 group-msg(三端渲染「已撤回」墓碑;正文不可恢复)。
  | 'group-revoke'
  // relay→成员机:转发群钥密文槽。payload: {groupId, slot}。ce 用身份私钥开槽。
  | 'group-keyslot'
  // relay→全体成员:广播新消息(payload: GroupStoredMsg)。
  | 'group-msg'
  // relay→全体成员:群元数据变更广播。payload: GroupMetaEvent。
  | 'group-meta'
  // relay→来源连接:对带 reqId 请求的应答。payload: GroupResult。
  | 'group-result';

// ─── 信封(GroupFrame payload 解出的 JSON)────────────────────────────────────

/** GroupFrame(9) 的载荷:relay 按此信封路由,只认 op/groupId/reqId,其余按 op 取用。 */
export interface GroupEnvelope {
  op: GroupOp;
  /** 群 id(relay 生成,'g_' 前缀);group-create 时缺省。 */
  groupId?: string;
  /** 客户端关联应答用(同 RPCReq.reqId 的角色);广播帧无此字段。 */
  reqId?: string;
  /** op-specific 载荷,形状见各 op 注释与本文件下方类型。 */
  payload?: unknown;
}

// ─── 群元数据与成员(relay 明文可见的路由元数据)──────────────────────────────

export interface GroupMeta {
  name: string;
  topic?: string;
  /** 给 agent 的行为规则文本(agent 首跑拉取,注入其行为)。 */
  rules?: string;
  /** 房间形态标(明文路由元数据,与群名同级取舍;relay 不解释)。'hire' = 雇佣房间
   *  (2026-11-19 雇佣网关:手机按此渲染徽标,ce 按此挂配额闸,手册按此切第四档纪律)。 */
  kind?: 'hire';
  createdAt: number;
  createdBy: string; // 建群者 phoneId
}

/** presence 三态:wake=hook 在线(会话活且 hooks 通) / poll=轮询中 / away=掉线。
 *  v1 由活动时间推导(post/read/ack 刷新 lastSeenAt),专用 presence 帧是 v2。 */
export type Presence = 'wake' | 'poll' | 'away';

export interface GroupMember {
  memberId: string; // relay 生成,'m_' 前缀;reclaim 沿用旧 id
  name: string; // 群内唯一(如 '项目A的CC');reclaim 的认领键
  platform?: string; // 'claude' | 'codex' | ... (头像/显示用,自由文本)
  machineId?: string; // 所在被控机(hub 取注册 cid 为准;agent 成员的鉴权依据)
  /** 手机成员的持久身份(human 成员的鉴权/路由键);agent 成员缺省。 */
  phoneId?: string;
  /** 成员机身份公钥(b64 X25519):群钥密文槽的封装目标(手机封槽用)。 */
  pubKey?: string;
  human?: boolean; // 手机主人 true;agent 缺省
  /** 网页访客成员(雇佣房间;2026-11-19)。鉴权走 /guest 通路的雇佣码,无 machineId/phoneId;
   *  发言限速 guestMsgsPerHour,op 白名单外(建群/邀请/join/下槽/解散)。 */
  guest?: true;
  cwd?: string; // agent 工作目录(识别/展示用)
  joinedAt: number;
  lastSeenAt: number; // 活动(post/read/ack/join)即刷新;reclaim 15 分钟活跃卫兵依据
  readUpTo: number; // 己方已读游标(未读不发纪律:post 携带此值,落后即拒 new_messages)
}

// ─── 消息与正文(正文 ct = 群钥密文,relay 不解)──────────────────────────────

/** relay 存储与 sync 返回的消息条目。ct = seal(groupKey, JSON(GroupPlaintext)) 的 base64。 */
export interface GroupStoredMsg {
  seq: number; // 群内单调递增,relay 分配
  ts: number;
  from: { memberId: string; name: string; human?: boolean; /** 房外来客(雇佣雇主/外部 agent 网关;ce 按信息非指令投递) */ guest?: true };
  ct: string; // base64(nonce||ciphertext)
  opKey?: string; // 幂等键(原样透传;relay 拒重放:同 opKey 返回已存 seq)
  replyTo?: number; // 回复的 seq(仅成员消息;系统通知不可回复)
  mentions?: string[]; // 精确成员名(通知/唤醒依据;未命中由发送端 mentionHint 提示)
  /** 撤回时间(group-revoke 置;正文 ct 同步清空 → 老端解密失败自然跳过,新端渲染墓碑)。 */
  revokedAt?: number;
}

/** 正文明文(群钥解密后)。kind 只加不破,未知 kind 老端显示为不支持。 */
export type GroupPlaintext =
  | { kind: 'text'; text: string }
  | { kind: 'system'; text: string } // relay 侧通知(如 xx 加入)不需要——走 group-meta;此档留给手机端本地系统提示
  | { kind: string; [k: string]: unknown };

// ─── 各 op 的 payload 形状 ────────────────────────────────────────────────

/** group-join 的 payload。inviteCode 是手机经 group-invite 签发的一次性码。
 *  member.pubKey = 成员机身份公钥(b64 X25519):join 后手机把群钥封成密文槽
 *  (group-keyslot-set)经 relay 转交,ce 用身份私钥开槽 —— 群钥全程不经 relay 明文。 */
export interface GroupJoinReq {
  inviteCode: string;
  member: { name: string; platform?: string; machineId?: string; cwd?: string; pubKey?: string };
  /** 认领同名旧身份(会话死后的 reclaim):沿用旧 memberId 与 readUpTo。
   *  该成员 15 分钟内活跃 → 拒(member_active),防双开顶号。 */
  reclaim?: boolean;
}

/** group-post 的 payload。ct 必经群钥加密;relay 对明文长度上限按密文前先截?——否:
 *  长度限制(PLAINTEXT_MAX_CHARS)由发送端(ce chat / 手机)在加密前强制,relay 只按 ct 字节数粗检。 */
export interface GroupPostReq {
  ct: string;
  opKey?: string;
  replyTo?: number;
  mentions?: string[];
  /** 发送方当前已读游标:落后于群内他人最新 seq → 拒(new_messages)并附带那些消息(已标读)。 */
  readUpTo?: number;
  /** ce 侧断言的本机成员 id(同机多成员时必带;hub 校验 machineId 归属防跨机冒名)。
   *  手机端省略(hub 按 phoneId 解析其 human 成员)。 */
  memberId?: string;
}

/** group-sync 的 payload。memberId 语义同 GroupPostReq。
 *  markRead=false 是「偷看」(inbox 预览,不动已读游标);缺省 true(读即标读)。 */
export interface GroupSyncReq {
  groupId: string;
  memberId?: string;
  afterSeq?: number;
  limit?: number;
  markRead?: boolean;
}

/** group-ack 的 payload。memberId 语义同 GroupPostReq。 */
export interface GroupAckReq {
  groupId: string;
  memberId?: string;
  upToSeq: number;
}

/** group-leave 的 payload。memberId 语义同 GroupPostReq;手机端省略。 */
export interface GroupLeaveReq {
  groupId: string;
  memberId?: string;
}

/** group-invite 的应答(限次邀请:默认 10 用/24h —— 同机多个 agent 可共用一条 setup 消息)。
 *  用完/过期即焚。 */
export interface GroupInvite {
  code: string; // 'XXXX-XXXX'
  groupId: string;
  expiresAt: number;
  usesLeft: number;
}

/** group-hire-set 的应答:雇佣码(网页访客凭据;随房间存续,轮换即换)。 */
export interface GroupHireInfo {
  code: string; // 'XXXX-XXXX'(与邀请码同字母表;_lookup 走 rooms 的 hire.code,互不串)
  groupId: string;
  createdAt: number;
}

/** group-agent-code-set 的应答:外部 agent 接入码(一码一座;房钥不走此帧,由主人文本块人带)。 */
export interface GroupAgentCodeInfo {
  code: string;
  groupId: string;
  createdAt: number;
}

/** group-revoke 的 payload。memberId 语义同 GroupPostReq(作者本人撤;群主可撤任何人的)。 */
export interface GroupRevokeReq {
  seq: number;
  memberId?: string;
}

/** group-meta 广播的事件(成员增减/解散);手机据此触发群钥经隧道下发等后续。 */
export interface GroupMetaEvent {
  event: 'member-joined' | 'member-left' | 'dissolved';
  groupId: string;
  member?: GroupMember;
}

// ─── 应答(group-result 的 payload)─────────────────────────────────────────

export interface GroupResult {
  reqId: string;
  ok: boolean;
  /** 成功时按 op 返回:create→{groupId}; invite→GroupInvite; join→{group: GroupSnapshot};
   *  post→GroupStoredMsg; sync→{msgs: GroupStoredMsg[], seq}; 其余→undefined。 */
  data?: unknown;
  error?: { code: string; message: string };
}

/** join 成功返回的群快照(新成员首跑据此了解群)。msgs 只带最近 SNAPSHOT_TAIL 条。 */
export interface GroupSnapshot {
  meta: GroupMeta;
  members: GroupMember[];
  seq: number; // 群内最新 seq
  msgs: GroupStoredMsg[];
}

// ─── 错误码(发送端按 code 分支处理;只加不破)────────────────────────────────

/** 群协议错误码全集(与 Pachat 对齐的语义命名)。
 *  - new_messages: 有未读他人消息时拒发(payload 附带那些消息,已标读)
 *  - member_active: reclaim 目标 15 分钟内活跃(疑似双开)
 *  - code_invalid / code_expired / code_used: 邀请码三态(限次码:用满 inviteUses 次 → code_used)
 *  - member_exists: join 用了群内已有名字且未带 reclaim
 *  - opkey_used: opKey 重放(payload 附带已存 seq)
 *  - group_exists: 建群重名(同名群已存在)
 *  - not_member / no_group: 调用方不在群 / 群不存在
 *  - too_large / too_many_members: 超限
 *  - owner_leave: 群主不能退群(v1 只能解散) */
export type GroupErrorCode =
  | 'new_messages'
  | 'member_active'
  | 'code_invalid'
  | 'code_expired'
  | 'code_used'
  | 'member_exists'
  | 'opkey_used'
  | 'group_exists'
  | 'not_member'
  | 'no_group'
  | 'too_large'
  | 'too_many_members'
  | 'rate_limited'
  | 'owner_leave';

// ─── 群内纪律与限额(发送端 + relay 共同遵守;首版强制子集,余者 v2)────────────────

export const GROUP_LIMITS = {
  /** 群人数上限。 */
  membersPerGroup: 50,
  /** 单条正文明文字符上限(发送端加密前截断/拒发;relay 按 ct 字节数粗检 too_large)。 */
  plaintextMaxChars: 10_000,
  /** 邀请默认有效期 ms(24h)。 */
  inviteTtlMs: 24 * 60 * 60 * 1000,
  /** 单码可用次数(同机多 agent 共用一条 setup 消息;Pachat 同款)。 */
  inviteUses: 10,
  /** join 快照附带的尾巴条数。 */
  snapshotTail: 20,
  /** group-sync 单页默认条数。 */
  syncDefaultLimit: 50,
  /** reclaim 活跃卫兵窗口 ms:目标成员该窗口内活跃过 → 拒 member_active。 */
  reclaimActiveGuardMs: 15 * 60 * 1000,
  /** guest(网页访客)每小时发言上限(雇佣房间防刷;超限拒 rate_limited)。 */
  guestMsgsPerHour: 30,
} as const;
