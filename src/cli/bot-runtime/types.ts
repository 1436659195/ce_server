import type { BotOperation, BotPermissions } from '../bot-permissions'

/** 聊天中仅传引用；路径和操作者身份由本机账本保存。 */
export interface RuntimeAttachment {
  id: string; kind: 'upload' | 'artifact'; botId: string; name: string; mime: string; size: number; hash: string
}
export interface RuntimeUpload {
  id: string; botId: string; groupId: string; ownerPhoneId: string; requestId: string
  name: string; mime: string; size: number; hash?: string; path: string; offset: number
  state: 'uploading' | 'ready' | 'cancelled'; createdAt: number; claimed?: boolean
}
export type RuntimeUploadRequest =
  | { action: 'begin'; requestId: string; name: string; mime: string; size: number }
  | { action: 'chunk'; uploadId: string; offset: number; data: string }
  | { action: 'finish'; uploadId: string; hash: string }
  | { action: 'cancel'; uploadId: string }

export interface RuntimeSettings {
  botId: string
  mode: 'legacy' | 'router-worker'
  revision: number
  profile: string
  model: string
  error?: string
  /** 有主人消息的前台轮次累计数；中期记忆按它数「管 10 轮」。 */
  rounds?: number
}
/** Reusable content is separate from the delivery report and belongs to one Bot. */
export interface ExperienceScope { project?: string; service?: string; os?: string; versionRange?: string | null; version?: string }
export interface ExperienceRef { experienceId: string; version: number }
export interface ExperienceContent {
  title: string; object: string; goal: string; applicability: string; scope?: ExperienceScope
  pitfalls: string[]; steps: string[]; verification: string[]; detail?: string; artifactIds?: string[]
}
export interface ExperienceSaveCommand {
  requestId: string; id?: string; expectedVersion?: number; content: ExperienceContent; changeSummary: string
}
export interface ExperienceSource { taskId?: string; inboxId?: string; replyId?: string }
export interface ExperienceUsageReport extends ExperienceRef {
  status: 'applied' | 'adapted' | 'skipped' | 'failed'; appliedSteps: string[]; result: string
}
export interface ExperienceStats { displays: number; reads: number; adopted: number; succeeded: number; legacyExposures: number }
export interface ExperienceMaterial { artifactId: string; hash: string; revision: number; name: string; mime: string }
export interface RuntimeExperience {
  id: string; botId: string; state: 'active' | 'needs_review' | 'retired'
  object: string; goal: string; approach: string; detail: string; checks: string[]; verified: boolean
  sourceTaskId: string; sourceCaseId: string
  /** Compatibility alias for actual adoption only; historical impressions live in stats.legacyExposures. */
  uses: number; lastUsedAt?: number
  platform: string; toolFingerprint: string; migrated?: true; createdAt: number; updatedAt: number
  format?: 2; kind?: 'lesson' | 'report'; version?: number; title?: string; applicability?: string; scope?: ExperienceScope
  pitfalls?: string[]; steps?: string[]; verification?: string[]; materials?: ExperienceMaterial[]; stats?: ExperienceStats
  changeSummary?: string; source?: ExperienceSource
}
/** 主人的偏好或规矩。按渠道（groupId）和对话角色（senderId）分开存。 */
export type MemoryTier = 'mid' | 'long'
export type MemoryStatus = 'active' | 'superseded' | 'suppressed' | 'revoked' | 'expired'
export interface RuntimeMemory {
  id: string; botId: string
  channel: string; senderId: string
  tier: MemoryTier; status: MemoryStatus
  /** 规矩本身，一句话。 */
  prompt: string
  /** 什么时候适用；不写表示对每轮都适用。 */
  appliesTo?: string
  /** 原话：哪条消息、引文、上下文。该消息被撤回 → 本条作废。 */
  source: { inboxId: string; quote: string; context: string; sentAt: number }
  extraSources?: Array<{ inboxId: string; quote: string }>
  triggers: { count: number; lastTriggeredAt?: number }
  /** 中期：从第几轮算起、何时到期（10 轮或 7 天，先到为准）。 */
  bornRound?: number; expiresAt?: number
  promotedAt?: number
  supersedes?: string; supersededBy?: string; suppressedBy?: string; revokedReason?: string
  /** 长期 30 天没被触发：进「待你看一眼」，只提示不删。 */
  needsReview?: boolean
  createdAt: number; updatedAt: number
}
export type MemoryLogAction = 'create' | 'duplicate' | 'supersede' | 'promote' | 'expire' | 'suppress' | 'unsuppress' | 'revoke' | 'review'
/** 记忆的变更流水，只增不改。 */
export interface RuntimeMemoryLog {
  id: string; botId: string; memoryId: string; action: MemoryLogAction
  actor: 'memory' | 'owner' | 'host'
  before?: Partial<RuntimeMemory>; after?: Partial<RuntimeMemory>; note?: string; at: number
}
export interface MemoryJob { state: 'queued' | 'running' | 'done' | 'failed'; scheduledAt: number; finishedAt?: number; error?: string }
export interface MemoryProposal {
  intent: 'none' | 'preference'; tier?: MemoryTier; prompt?: string; appliesTo?: string
  sourceInboxId?: string; quote?: string
  conflicts?: Array<{ memoryId: string; relation: 'duplicate' | 'supersedes' | 'related' }>
}
/** 主人对一条记忆或经验的管理动作；只有 owner 能用。 */
export interface RuntimeMemoryControl { requestId: string; action: 'suppress' | 'unsuppress' | 'revoke'; id: string; note?: string; target?: 'memory' | 'experience' }
/** 身份、目录与权限均由 ChatHub 生成，不接受模型或手机声称的 owner。 */
export interface RuntimeBot {
  botId: string
  name: string
  groupId: string
  ownerPhoneId: string
  sourceCwd: string
  directory: string
  permissions: BotPermissions
  policyRevision: number
  commandSandbox: boolean
  /** 新版宿主默认提供全权限 Worker；缺省兼容旧的受控工具运行方式。 */
  workerAccessMode?: 'full-access'
  platform: string
  /** 其他电脑连接:这台数字人被授权操作的另外几台电脑(不带任何密钥)。 */
  computers?: RuntimeComputer[]
}
/** 一台「其他电脑」:数字人可用的远程终端。密钥留在宿主,不进运行时。 */
export interface RuntimeComputer {
  id: string
  label: string
  /** 授权目录的逻辑路径(相对对端文件根目录,以 / 开头)。 */
  directory: string
  directoryAbs: string
  platform?: string
}
/** 一条远程命令的审计记录。 */
export interface RuntimeRemoteOp {
  id: string
  botId: string
  taskId: string
  runId: string
  computerId: string
  computerLabel: string
  directory: string
  command: string
  state: 'running' | 'done' | 'failed' | 'unknown'
  exitCode?: number
  /** 清理后输出的开头一段(给人看)。 */
  outputHead: string
  /** 清理后输出总字数。 */
  outputChars: number
  error?: string
  createdAt: number
  finishedAt?: number
}
export interface RuntimeInbox {
  id: string; botId: string; groupId: string; seq: number; senderId: string; memberId: string
  text: string; createdAt: number; state: 'pending' | 'routed' | 'failed'; error?: string; decision?: unknown
  /** 本机持久化接收时间，收消息等待不信任客户端时钟。 */
  receivedAt?: number
  targetTaskId?: string; questionId?: string
  attachments?: RuntimeAttachment[]
  /** 主人撤回了这条消息：本地原文清空，以它为来源的规矩作废。 */
  revokedAt?: number
  /** 慢路记忆整理挂在锚点消息上：同一批只整理一次。 */
  memoryJob?: MemoryJob
}
export interface RuntimeCase {
  id: string; botId: string; title: string; object: string; goal: string; summary: string
  /** goal 是累计工作范围，summary 是最近进展；改名不改变身份或执行会话。 */
  aliases?: string[]; revision?: number
  threadId?: string; fingerprint?: string; createdAt: number; updatedAt: number
}
export interface RuntimeCaseUpdate { expectedRevision: number; title?: string; goal?: string }
export interface RuntimeCaseDecision { kind: 'new' | 'existing'; reason: string; relation?: 'follow_up' | 'revision' | 'next_step' }
export interface RuntimeMandate {
  ownerPhoneId: string; policyRevision: number; directory: string
  allowedOps: BotOperation[]; exclusions: string[]; mode: 'execute' | 'assess'
  executionMode?: 'full-access'
  directoryIsolation?: 'soft'
  safetyInstructions?: string
}
export type RuntimeTaskState = 'queued' | 'running' | 'waiting_user' | 'completed' | 'stopping' | 'stopped' | 'recovering' | 'failed'
export interface RuntimeTask {
  /** A scheduled task references its actual source message and a separately persisted trigger. */
  automationOccurrenceId?: string
  id: string; botId: string; caseId: string; originInputId: string; groupId: string; requesterMemberId: string
  goal: string; acceptance: string[]; mandate: RuntimeMandate; state: RuntimeTaskState; revision: number
  summary: string; createdAt: number; updatedAt: number; latestRunId?: string; error?: string
  executionGuidance?: string
  experienceRefs?: ExperienceRef[]
  review?: { state: 'pending' | 'approved' | 'changes_requested'; rounds: number; feedback?: string }
  caseDecision?: RuntimeCaseDecision
  sessionOrigin?: 'inherited' | 'new'; sessionReason?: string
  /** owner 明确继续后更新目录授权；旧工单内容保留，首次执行必须新建 Session。 */
  directoryContinuation?: {
    fromDirectory: string; toDirectory: string; previousPolicyRevision: number; policyRevision: number
    actor: string; requestId: string; confirmedAt: number; confirmationText: string
    previousQuestion?: RuntimeTask['question']; sessionRunId?: string
  }
  /** 摘要本身的记录时间；普通状态/需求变更不刷新它。旧账本可能没有。 */
  summaryUpdatedAt?: number
  question?: { id: string; text: string; options: string[]; createdAt: number; directoryChange?: { fromDirectory: string; toDirectory: string; policyRevision: number } }
  /** Worker 不阻塞的提问：问题已发出，任务继续；没人答时按跟进规则最多再提一次。 */
  followup?: { questionId: string; text: string; askedAt: number; askCount: number }
  /** Router 选定的前序附件消息；宿主校验同一 owner、Bot 和私聊。 */
  attachmentInputIds?: string[]
  /** 同一轮接单的所有原始气泡；旧工单使用 originInputId。 */
  originInputIds?: string[]
  /** 旧工单可缺省；新文件交付任务必须附成果才能完成。 */
  delivery?: 'chat' | 'files'
  /** 「继续」来的时候任务还在停止过程中：记下意图，真正停下后由宿主自动恢复。 */
  resumeIntent?: { requestId: string; actor: string; requestedAt: number; expiresAt: number; expired?: true; inputIds?: string[] }
}
export interface RuntimeTaskInput {
  id: string; botId: string; taskId: string; inboxId: string; kind: 'append' | 'ask_worker' | 'answer' | 'correction'
  text: string; revision: number; delivery: 'pending' | 'accepted' | 'unknown'; consumedAt?: number
  resolution?: string; createdAt: number
  inboxIds?: string[]
  executionGuidance?: string
  experienceRefs?: ExperienceRef[]
  attachments?: RuntimeAttachment[]
}
export interface RuntimeRun {
  id: string; botId: string; taskId: string; threadId?: string; turnId?: string
  state: 'starting' | 'running' | 'draining' | 'exited' | 'unknown'; createdAt: number; updatedAt: number
  reconciliation?: { actor: string; at: number; note: string; confirmedStopped: true }
}
export interface RuntimeOperation {
  id: string; botId: string; taskId: string; runId: string; callId: string; tool: string
  arguments: Record<string, unknown>; operation: BotOperation; policyRevision: number
  state: 'pending_approval' | 'approved' | 'running' | 'completed' | 'failed' | 'unknown' | 'reconciled'
  createdAt: number; expiresAt?: number; result?: string; error?: string
  reconciliation?: { actor: string; at: number; note: string; confirmedStopped: true }
}
export interface RuntimeReply {
  lesson?: Omit<ExperienceSaveCommand, 'requestId'>
  experienceUsage?: ExperienceUsageReport[]
  automationOccurrenceId?: string
  id: string; key: string; botId: string; groupId: string; inputId?: string; taskId?: string; runId?: string
  author: 'router' | 'worker'; purpose: 'chat' | 'ack' | 'answer' | 'question' | 'result' | 'unable'
  text: string; format?: 'plain' | 'markdown'; artifactIds?: string[]; artifactSummaries?: RuntimeArtifactSummary[]; checks?: string[]; policyRevision: number; state: 'pending' | 'routed' | 'sent' | 'cancelled'; createdAt: number
  taskRevision?: number; questionId?: string
  /** 发送已开始但没有成功回执时，保留同一 ID 重试，不假定从未发出。 */
  attemptedAt?: number; sentAt?: number; sentOrder?: number
  cancelReason?: string; supersededBy?: string
  /** 一次模型回复的气泡分组，发送间隔从上一泡实际送达起算。 */
  replyGroupId?: string; bubbleIndex?: number
  /** Worker原文是内部消息；只有关联它的Router表达可以对外发送。 */
  sourceReplyId?: string
  routingAttempts?: number; nextRoutingAt?: number; routingError?: string
  routingBasis?: string
  /** 仅v1升级迁移标记：旧版本已经开始发送的消息，保持原ID/正文完成传输重试。 */
  legacyDeliveryRecovery?: true
  /** 不阻塞提问的再次提醒：前台可以决定不再提（0 个气泡并写依据）。 */
  followupReminder?: true
}
export interface RuntimeArtifactSummaryInput {
  artifactId: string; summary: string; requirements: string[]; checks: string[]; limitations: string[]
}
/** 摘要关联宿主保存的不可变文件版本，不能使用模型自报的 hash。 */
export interface RuntimeArtifactSummary extends RuntimeArtifactSummaryInput { hash: string; revision: number }
export interface RuntimeArtifact {
  id: string; botId: string; caseId: string; taskId: string; title: string; mime: string
  path: string; size: number; hash: string; revision: number; createdAt: number
  name?: string
}
export interface RuntimeView {
  protocol: 1; settings: RuntimeSettings; capabilities: { activeInput: boolean; runtime: string; limitations: string[]; executionMode?: 'full-access'; directoryIsolation?: 'soft'; directoryApproval?: boolean }
  cases: RuntimeCase[]; tasks: RuntimeTask[]; inputs: RuntimeTaskInput[]; artifacts: Array<Omit<RuntimeArtifact, 'path'>>
  operations: Array<{ id: string; taskId: string; tool: string; state: RuntimeOperation['state']; summary: string; error?: string; canReconcile: boolean }>
  recoveries: Array<{ taskId: string; runIds: string[]; canReconcile: boolean }>
  failedInputs: Array<{ id: string; text: string; error?: string; createdAt: number }>
  memory: { active: RuntimeMemory[]; review: RuntimeMemory[]; failedJobs: Array<{ id: string; text: string; error?: string }>; log: RuntimeMemoryLog[] }
  experiences: RuntimeExperience[]
  updatedAt: number
  /** 最近的远程命令审计(其他电脑连接)。 */
  remoteOps?: RuntimeRemoteOp[]
}
