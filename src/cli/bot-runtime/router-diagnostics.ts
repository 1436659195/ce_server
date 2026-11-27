import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexTurn } from './codex'
import { runtimeFailure } from './compatibility'

type Phase = 'initial' | 'nudge'
type Origin = 'model' | 'host'
type Stage = 'validation' | 'commit'
interface Decision {
  phase: Phase; origin: Origin; stage: Stage; accepted: boolean
  action?: string; replyCount?: number; replyChars?: number[]; reason?: string
}
const actions = new Set(['reply', 'start', 'append', 'ask_worker', 'answer', 'stop', 'resume', 'approve_directory', 'request_access', 'revise'])

/** Validation messages are host-generated. Zod may quote unknown keys: never retain those values. */
function validationReason(error: unknown): string {
  if (!(error instanceof Error)) return '决策校验失败，未返回错误类型'
  return error.message
    // Zod does not escape quotes or separators inside unknown field names.
    // Drop the whole tail before processing quoted text.
    .replace(/Unrecognized keys?:[\s\S]*/g, '存在未定义字段（字段名已隐藏）')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, '[已隐藏]')
    .replace(/(?:https?|wss?):\/\/\S+/gi, '[地址已隐藏]')
    .replace(/\b(?:Bearer\s+\S+|(?:api[_-]?key|token|password|secret|pin)\s*[=:]\s*\S+)/gi, '[凭据已隐藏]')
    .replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 600)
}

/** A bounded, local trace. Text bodies, argument values, SDK errors and credentials are not stored. */
export class RouterDiagnostics {
  readonly id = `router_${randomUUID()}`
  private readonly startedAt = Date.now()
  phase: Phase = 'initial'
  nudged = false
  private decisions: Decision[] = []
  private turns: Array<{ phase: Phase; status: string; textChars: number }> = []
  private droppedDecisions = 0
  private failure?: string
  constructor(private readonly source: { botId: string; inputIds: string[]; workerReplyId?: string; automationOccurrenceId?: string }) {}

  decision(args: Record<string, unknown>, origin: Origin, stage: Stage, accepted: boolean, error?: unknown): void {
    const action = (args?.decision as { action?: unknown } | undefined)?.action
    const replies = Array.isArray(args?.replies) ? args.replies : undefined
    const entry: Decision = { phase: this.phase, origin, stage, accepted,
      ...(typeof action === 'string' && actions.has(action) ? { action } : {}),
      ...(replies ? { replyCount: replies.length, replyChars: replies.slice(0, 3).map(r => typeof r === 'string' ? r.length : 0) } : {}),
      ...(!accepted ? { reason: validationReason(error) } : {}) }
    if (this.decisions.length === 8) { this.decisions.shift(); this.droppedDecisions++ }
    this.decisions.push(entry)
  }

  turn(result: CodexTurn): void {
    const last = [...(result.items ?? [])].reverse().find(item => item.type === 'agentMessage')
    this.turns.push({ phase: this.phase, status: ['completed', 'failed', 'interrupted'].includes(result.status) ? result.status : 'unknown', textChars: typeof last?.text === 'string' ? last.text.length : 0 })
  }

  nudge(): string {
    this.nudged = true
    this.phase = 'nudge'
    const last = this.decisions.findLast(d => !d.accepted)
    return last?.reason ? `\n宿主最近一次拒绝原因：${last.reason}。请修正后重新提交；没有提交成功的决策不会对外发送。` : ''
  }

  failed(error: unknown): void {
    this.failure = error instanceof Error && error.message === '前台未提交有效决策；原消息已保存，可重试'
      ? error.message : runtimeFailure('Router', error).message
  }

  write(rootDir: string, committed: boolean, superseded: boolean): void {
    if (!this.failure && !this.nudged && !this.decisions.some(d => !d.accepted)) return
    try {
      const directory = join(rootDir, 'bot-runtime'); mkdirSync(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, 'router-diagnostics.jsonl')
      try { if (statSync(path).size >= 1_000_000) renameSync(path, `${path}.1`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return }
      const entry = { id: this.id, ...this.source, startedAt: this.startedAt, finishedAt: Date.now(), outcome: committed ? 'recovered' : superseded ? 'superseded' : 'failed',
        nudged: this.nudged, reason: this.failure, decisions: this.decisions, droppedDecisions: this.droppedDecisions, turns: this.turns }
      appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 }); chmodSync(path, 0o600)
    } catch { /* Diagnostics must not change task acceptance, delivery or retry behavior. */ }
  }
}
