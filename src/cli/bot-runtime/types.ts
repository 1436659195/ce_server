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
  experiences: Array<{ id: string; summary: string; detail: string; source: string; active: boolean }>
  error?: string
}
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
  platform: string
}
export interface RuntimeInbox {
  id: string; botId: string; groupId: string; seq: number; senderId: string; memberId: string
  text: string; createdAt: number; state: 'pending' | 'routed' | 'failed'; error?: string; decision?: unknown
  /** 本机持久化接收时间，收消息等待不信任客户端时钟。 */
  receivedAt?: number
  targetTaskId?: string; questionId?: string
  attachments?: RuntimeAttachment[]
}
export interface RuntimeCase {
  id: string; botId: string; title: string; object: string; goal: string; summary: string
  threadId?: string; fingerprint?: string; createdAt: number; updatedAt: number
}
export interface RuntimeMandate {
  ownerPhoneId: string; policyRevision: number; directory: string
  allowedOps: BotOperation[]; exclusions: string[]; mode: 'execute' | 'assess'
}
export type RuntimeTaskState = 'queued' | 'running' | 'waiting_user' | 'completed' | 'stopping' | 'stopped' | 'recovering' | 'failed'
export interface RuntimeTask {
  id: string; botId: string; caseId: string; originInputId: string; groupId: string; requesterMemberId: string
  goal: string; acceptance: string[]; mandate: RuntimeMandate; state: RuntimeTaskState; revision: number
  summary: string; createdAt: number; updatedAt: number; latestRunId?: string; error?: string
  /** 摘要本身的记录时间；普通状态/需求变更不刷新它。旧账本可能没有。 */
  summaryUpdatedAt?: number
  question?: { id: string; text: string; options: string[]; createdAt: number }
  /** Router 选定的前序附件消息；宿主校验同一 owner、Bot 和私聊。 */
  attachmentInputIds?: string[]
  /** 同一轮接单的所有原始气泡；旧工单使用 originInputId。 */
  originInputIds?: string[]
  /** 旧工单可缺省；新文件交付任务必须附成果才能完成。 */
  delivery?: 'chat' | 'files'
}
export interface RuntimeTaskInput {
  id: string; botId: string; taskId: string; inboxId: string; kind: 'append' | 'ask_worker' | 'answer' | 'correction'
  text: string; revision: number; delivery: 'pending' | 'accepted' | 'unknown'; consumedAt?: number
  resolution?: string; createdAt: number
  inboxIds?: string[]
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
  id: string; key: string; botId: string; groupId: string; inputId?: string; taskId?: string; runId?: string
  author: 'router' | 'worker'; purpose: 'chat' | 'ack' | 'answer' | 'question' | 'result' | 'unable'
  text: string; artifactIds?: string[]; policyRevision: number; state: 'pending' | 'sent' | 'cancelled'; createdAt: number
  taskRevision?: number; questionId?: string
  /** 发送已开始但没有成功回执时，保留同一 ID 重试，不假定从未发出。 */
  attemptedAt?: number; sentAt?: number; sentOrder?: number
  cancelReason?: string; supersededBy?: string
  /** 一次模型回复的气泡分组，发送间隔从上一泡实际送达起算。 */
  replyGroupId?: string; bubbleIndex?: number
}
export interface RuntimeArtifact {
  id: string; botId: string; caseId: string; taskId: string; title: string; mime: string
  path: string; size: number; hash: string; revision: number; createdAt: number
  name?: string
}
export interface RuntimeView {
  protocol: 1; settings: RuntimeSettings; capabilities: { activeInput: boolean; runtime: string; limitations: string[] }
  cases: RuntimeCase[]; tasks: RuntimeTask[]; inputs: RuntimeTaskInput[]; artifacts: Array<Omit<RuntimeArtifact, 'path'>>
  operations: Array<{ id: string; taskId: string; tool: string; state: RuntimeOperation['state']; summary: string; error?: string; canReconcile: boolean }>
  recoveries: Array<{ taskId: string; runIds: string[]; canReconcile: boolean }>
  failedInputs: Array<{ id: string; text: string; error?: string; createdAt: number }>
  updatedAt: number
}
