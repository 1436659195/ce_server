import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { computeNextRunAtMs, validateSchedule } from './schedule'
import { validateCondition } from './conditions'
import type { AutomationDefinition, AutomationJob, AutomationOccurrence, AutomationSource, OccurrenceState } from './types'
import { ACTIVE_OCCURRENCE_STATES, AUTOMATION_LIMITS } from './types'

const uuid = (prefix: string) => `${prefix}_${randomUUID()}`
const text = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`事件文字需要1至${max}字符`)
  return v.trim()
}
const integer = (v: unknown, fallback: number, min: number, max: number) => {
  const n = v ?? fallback
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new Error('事件次数或时间预算无效')
  return n
}
export function validateDefinition(input: Record<string, unknown>, now: number): AutomationDefinition {
  const allowed = ['name', 'payload', 'schedule', 'condition', 'expiresAt', 'maxRuns', 'timeoutMs', 'misfireMs']
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('事件定义包含未知参数')
  const schedule = validateSchedule(input.schedule, now)
  const condition = input.condition == null ? undefined : validateCondition(input.condition)
  if (condition && schedule.kind !== 'every' && schedule.kind !== 'cron') throw new Error('指标条件需要every或cron检查计划')
  if (condition?.targetId !== undefined && condition.targetId !== 'host') throw new Error('当前仅支持host宿主指标，其他监测目标尚未接入')
  const expiresAt = input.expiresAt == null ? undefined : integer(input.expiresAt, 0, now + 1, 8.64e15)
  return { name: text(input.name, 100), payload: text(input.payload, 2000), schedule, ...(condition ? { condition } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }), ...(input.maxRuns == null ? {} : { maxRuns: integer(input.maxRuns, 1, 1, 10000) }),
    timeoutMs: integer(input.timeoutMs, AUTOMATION_LIMITS.runTimeoutMs, 10_000, 30 * 60_000), misfireMs: integer(input.misfireMs, AUTOMATION_LIMITS.misfireMs, 0, 7 * 86_400_000) }
}
function nextCheck(d: AutomationDefinition, now: number): number | undefined {
  return d.schedule.kind === 'at' ? Date.parse(d.schedule.at) : computeNextRunAtMs(d.schedule, now)
}
/** Uses the runtime's SAME connection so accepting work and consuming an occurrence commit together. */
export class AutomationStore {
  constructor(private readonly db: Database) {
    for (const table of ['automation_jobs', 'automation_occurrences']) db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body))); CREATE INDEX IF NOT EXISTS ${table}_bot ON ${table}(bot_id);`)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS automation_creation ON automation_jobs(bot_id,json_extract(body,'$.creationKey'));
      CREATE UNIQUE INDEX IF NOT EXISTS automation_occurrence_key ON automation_occurrences(bot_id,json_extract(body,'$.key'));
      CREATE INDEX IF NOT EXISTS automation_due ON automation_jobs(json_extract(body,'$.status'),json_extract(body,'$.nextCheckAt'));
      CREATE INDEX IF NOT EXISTS automation_occurrence_job ON automation_occurrences(bot_id,json_extract(body,'$.jobId'),json_extract(body,'$.state'));`)
    db.exec(`CREATE TABLE IF NOT EXISTS automation_receipts(key TEXT PRIMARY KEY,bot_id TEXT NOT NULL,occurrence_id TEXT NOT NULL REFERENCES automation_occurrences(id));
      CREATE INDEX IF NOT EXISTS automation_receipts_occurrence ON automation_receipts(occurrence_id);`)
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate() }
  private read<T>(table: string, id: string): T | undefined {
    const row = this.db.query(`SELECT body FROM ${table} WHERE id=?`).get(id) as { body: string } | null
    return row ? JSON.parse(row.body) : undefined
  }
  saveJob(job: AutomationJob): void { this.write('automation_jobs', job) }
  private write(table: string, record: { id: string; botId: string }): void {
    this.db.query(`INSERT INTO ${table}(id,bot_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE bot_id=excluded.bot_id`).run(record.id, record.botId, JSON.stringify(record))
  }
  jobs(botId?: string, status?: AutomationJob['status']): AutomationJob[] {
    const clauses: string[] = []; const args: string[] = []
    if (botId !== undefined) { clauses.push('bot_id=?'); args.push(botId) }
    if (status !== undefined) { clauses.push("json_extract(body,'$.status')=?"); args.push(status) }
    const rows = this.db.query(`SELECT body FROM automation_jobs${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY rowid`).all(...args) as { body: string }[]
    return rows.map(r => JSON.parse(r.body))
  }
  get(botId: string, jobId: string): AutomationJob {
    const job = this.read<AutomationJob>('automation_jobs', jobId)
    if (!job || job.botId !== botId) throw new Error('事件不存在或归属不匹配')
    return job
  }
  list(botId: string, p: { limit?: number; offset?: number; includeRemoved?: boolean } = {}) {
    const limit = integer(p.limit, 5, 1, 20); const offset = integer(p.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const jobs = this.jobs(botId).filter(j => p.includeRemoved || j.status !== 'removed').reverse()
    return { jobs: jobs.slice(offset, offset + limit), ...(jobs.length > offset + limit ? { nextOffset: offset + limit } : {}) }
  }
  create(source: AutomationSource, input: Record<string, unknown>, creationKey: string, now: number): AutomationJob {
    return this.transaction(() => {
      const prior = this.jobs(source.botId).find(j => j.creationKey === creationKey)
      const definition = validateDefinition(input, prior?.createdAt ?? now)
      const hash = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
      if (prior) { if (prior.creationHash !== hash) throw new Error('重复槽位参数已变化，请核对已保存事件'); return prior }
      if (!source.inputIds.length || source.ownerId !== source.mandate.ownerPhoneId) throw new Error('缺少真实委托来源')
      if (source.depth > AUTOMATION_LIMITS.maxDepth) throw new Error('事件后续链已达上限')
      if (source.parentJobId && (definition.schedule.kind !== 'at' || Date.parse(definition.schedule.at) > source.createdAt + AUTOMATION_LIMITS.followupHorizonMs)) throw new Error('事件自建后续仅支持原委托7天内的一次性待办')
      if (this.jobs(source.botId).filter(j => j.status !== 'removed' && j.status !== 'completed').length >= AUTOMATION_LIMITS.jobsPerBot) throw new Error('事件数量已达上限')
      const job: AutomationJob = { ...definition, id: uuid('automation'), botId: source.botId, groupId: source.groupId, source: structuredClone(source), creationKey, creationHash: hash,
        status: 'enabled', revision: 1, createdAt: now, updatedAt: now, nextCheckAt: nextCheck(definition, now), checks: 0, successes: 0, failures: 0 }
      this.saveJob(job); return job
    })
  }
  update(botId: string, jobId: string, revision: number, patch: Record<string, unknown>, now: number): AutomationJob {
    return this.transaction(() => {
      const job = this.get(botId, jobId); this.assertEditable(job, revision)
      const previous = { name: job.name, payload: job.payload, schedule: job.schedule, condition: job.condition, expiresAt: job.expiresAt, maxRuns: job.maxRuns, timeoutMs: job.timeoutMs, misfireMs: job.misfireMs }
      // Names/payload edits must not reject a valid already elapsed at definition.
      const validationNow = patch.schedule === undefined ? Math.min(now, job.createdAt) : now
      const definition = validateDefinition({ ...previous, ...patch }, validationNow)
      if (job.source.parentJobId && (definition.schedule.kind !== 'at' || Date.parse(definition.schedule.at) > job.source.createdAt + AUTOMATION_LIMITS.followupHorizonMs)) throw new Error('事件自建后续不能扩大到周期任务或超过原期限')
      this.cancelJob(job.id, now, '事件定义已修改')
      const next: AutomationJob = { ...job, ...definition, condition: definition.condition, expiresAt: definition.expiresAt, maxRuns: definition.maxRuns, revision: job.revision + 1, updatedAt: now, nextCheckAt: nextCheck(definition, now), checkToken: undefined, checkUntil: undefined,
        ...(patch.condition !== undefined || patch.schedule !== undefined ? { state: undefined } : {}), error: undefined, failures: 0 }
      this.saveJob(next); return next
    })
  }
  private assertEditable(job: AutomationJob, revision: number): void {
    if (job.revision !== revision) throw new Error('事件版本已变化，请重新读取')
    if (job.status === 'removed') throw new Error('事件已删除，不能复活')
  }
  setStatus(botId: string, jobId: string, revision: number, status: AutomationJob['status'], now: number, error?: string): AutomationJob {
    return this.transaction(() => {
      const job = this.get(botId, jobId); this.assertEditable(job, revision)
      this.cancelJob(job.id, now, error ?? `事件${status}`)
      const next = { ...job, status, revision: job.revision + 1, updatedAt: now, checkToken: undefined, checkUntil: undefined, error,
        nextCheckAt: status === 'enabled' ? nextCheck(job, now) : undefined }
      this.saveJob(next); return next
    })
  }
  occurrences(botId: string, jobId?: string): AutomationOccurrence[] {
    const rows = (jobId ? this.db.query("SELECT body FROM automation_occurrences WHERE bot_id=? AND json_extract(body,'$.jobId')=? ORDER BY rowid").all(botId, jobId)
      : this.db.query('SELECT body FROM automation_occurrences WHERE bot_id=? ORDER BY rowid').all(botId)) as { body: string }[]
    return rows.map(r => JSON.parse(r.body))
  }
  occurrence(id: string): AutomationOccurrence | undefined { return this.read('automation_occurrences', id) }
  active(botId: string, jobId?: string): AutomationOccurrence[] {
    const rows = this.db.query(`SELECT body FROM automation_occurrences WHERE bot_id=?${jobId ? " AND json_extract(body,'$.jobId')=?" : ''}
      AND json_extract(body,'$.state') IN ('queued','routing','working','delivery_pending') ORDER BY rowid`).all(...(jobId ? [botId, jobId] : [botId])) as { body: string }[]
    return rows.map(r => JSON.parse(r.body))
  }
  history(botId: string, jobId: string, p: { limit?: number; offset?: number } = {}) {
    this.get(botId, jobId)
    const limit = integer(p.limit, 5, 1, 20); const offset = integer(p.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const rows = this.db.query("SELECT body FROM automation_occurrences WHERE bot_id=? AND json_extract(body,'$.jobId')=? ORDER BY rowid DESC LIMIT ? OFFSET ?").all(botId, jobId, limit + 1, offset) as { body: string }[]
    return { runs: rows.slice(0, limit).map(r => JSON.parse(r.body) as AutomationOccurrence), ...(rows.length > limit ? { nextOffset: offset + limit } : {}) }
  }
  saveOccurrence(occurrence: AutomationOccurrence): void { this.write('automation_occurrences', occurrence) }
  current(r: AutomationOccurrence): boolean {
    const job = this.get(r.botId, r.jobId)
    return job.status === 'enabled' && job.revision === r.jobRevision && ACTIVE_OCCURRENCE_STATES.includes(this.occurrence(r.id)?.state as OccurrenceState)
  }
  enqueue(jobId: string, revision: number, key: string, scheduledAt: number, message: string, now: number, extra: Pick<AutomationOccurrence, 'pendingState' | 'diagnostic'> = {}): AutomationOccurrence | undefined {
    return this.transaction(() => {
      const job = this.read<AutomationJob>('automation_jobs', jobId)
      if (!job || job.status !== 'enabled' || job.revision !== revision) return
      const uniqueKey = `${jobId}:${revision}:${key}`
      const receipt = this.db.query('SELECT occurrence_id FROM automation_receipts WHERE key=? AND bot_id=?').get(uniqueKey, job.botId) as { occurrence_id: string } | null
      if (receipt) return this.occurrence(receipt.occurrence_id)
      const priorRow = this.db.query("SELECT body FROM automation_occurrences WHERE bot_id=? AND json_extract(body,'$.key')=?").get(job.botId, uniqueKey) as { body: string } | null
      const prior: AutomationOccurrence | undefined = priorRow ? JSON.parse(priorRow.body) : undefined
      if (prior) return prior
      const active = this.active(job.botId, job.id)
      const queued = active.find(r => r.state === 'queued')
      if (queued) {
        const merged = { ...queued, message: message.slice(0, 4000), scheduledAt, updatedAt: now, diagnostic: extra.diagnostic ?? false, pendingState: extra.pendingState }
        this.saveOccurrence(merged); this.db.query('INSERT INTO automation_receipts VALUES(?,?,?)').run(uniqueKey, job.botId, merged.id); return merged
      }
      if (active.length && job.condition && !extra.diagnostic) return
      const r: AutomationOccurrence = { id: uuid('occurrence'), botId: job.botId, jobId, jobRevision: revision, key: uniqueKey, scheduledAt, message: message.slice(0, 4000), state: 'queued', attempts: 0, createdAt: now, updatedAt: now, ...extra }
      this.saveOccurrence(r); this.db.query('INSERT INTO automation_receipts VALUES(?,?,?)').run(uniqueKey, job.botId, r.id); return r
    })
  }
  transition(id: string, state: OccurrenceState, now: number, patch: Partial<Pick<AutomationOccurrence, 'taskId' | 'error' | 'retryAt' | 'attempts'>> = {}): AutomationOccurrence {
    return this.transaction(() => {
      const r = this.occurrence(id)
      if (!r || !ACTIVE_OCCURRENCE_STATES.includes(r.state)) throw new Error('事件触发已消费或状态失效')
      const next = { ...r, ...patch, state, updatedAt: now, ...(!ACTIVE_OCCURRENCE_STATES.includes(state) ? { finishedAt: now } : {}) }
      this.saveOccurrence(next); return next
    })
  }
  cancelJob(jobId: string, now: number, reason: string): void {
    const job = this.read<AutomationJob>('automation_jobs', jobId); if (!job) return
    for (const r of this.active(job.botId, jobId)) this.transition(r.id, 'cancelled', now, { error: reason })
  }
}
