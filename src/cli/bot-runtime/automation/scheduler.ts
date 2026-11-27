import { randomUUID } from 'node:crypto'
import { AutomationStore } from './store'
import { collectHostMetric } from './collectors'
import { evaluateMetric } from './conditions'
import { computeNextRunAtMs, computePreviousRunAtMs } from './schedule'
import { ACTIVE_OCCURRENCE_STATES, AUTOMATION_LIMITS, type AutomationJob, type AutomationOccurrence, type RuntimeAutomationTrigger } from './types'
import { resolveCronExecutionRetryHint } from './openclaw-retry-hint'

interface Options {
  checkTimeoutMs?: number
  store: AutomationStore; now?: () => number
  authorized(job: AutomationJob): boolean
  available?(botId: string): boolean
  onWake(botId: string): void
  collect?: typeof collectHostMetric
}
/** Host-owned scheduler: deterministic checks never call an agent. */
export class AutomationScheduler {
  private readonly now: () => number
  private ticking?: Promise<void>
  private stopped = false
  private readonly checks = new Map<string, AbortController>()
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now }
  private get store() { return this.options.store }
  private available(botId: string) { return !this.stopped && (this.options.available?.(botId) ?? true) }
  private authorized(job: AutomationJob): boolean {
    if (job.expiresAt !== undefined && job.expiresAt <= this.now()) return false
    try { return this.options.authorized(job) } catch { return false }
  }
  private assertAuthorized(job: AutomationJob): void {
    if (!this.available(job.botId) || !this.authorized(job)) throw new Error('事件源委托授权或运行状态已失效')
  }
  recover(): void {
    for (const job of this.store.jobs()) {
      if (job.checkToken) this.store.saveJob({ ...job, checkToken: undefined, checkUntil: undefined })
      for (const r of this.store.active(job.botId, job.id)) {
        if (r.state === 'routing' && !r.taskId) this.store.transition(r.id, 'queued', this.now(), { retryAt: undefined })
      }
    }
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.ticking) return this.ticking
    this.ticking = this.sweep().finally(() => { this.ticking = undefined })
    return this.ticking
  }
  private async sweep(): Promise<void> {
    const now = this.now()
    const jobs = this.store.jobs(undefined, 'enabled').filter(j => this.available(j.botId))
    for (const job of jobs) {
      if (job.expiresAt !== undefined && job.expiresAt <= now) { this.store.setStatus(job.botId, job.id, job.revision, 'paused', now, '事件有效期已结束'); continue }
      if (!this.authorized(job)) { this.store.setStatus(job.botId, job.id, job.revision, 'paused', now, '原委托、身份、目录或权限已失效'); continue }
    }
    const due = this.store.jobs(undefined, 'enabled').filter(j => this.available(j.botId) && j.nextCheckAt !== undefined && j.nextCheckAt <= now && (j.checkUntil ?? 0) <= now)
      .sort((a, b) => a.nextCheckAt! - b.nextCheckAt!)
    // A check can take up to30s; separate bounded slots from long-running Worker tasks.
    for (let i = 0; i < due.length && !this.stopped; i += AUTOMATION_LIMITS.checkConcurrency) {
      await Promise.allSettled(due.slice(i, i + AUTOMATION_LIMITS.checkConcurrency).map(job => this.check(job)))
    }
  }
  private async check(snapshot: AutomationJob, manualKey?: string): Promise<AutomationOccurrence | undefined> {
    const now = this.now(); const token = randomUUID(); const manual = manualKey !== undefined
    const admitted = this.store.transaction(() => {
      const job = this.store.get(snapshot.botId, snapshot.id)
      if (job.status !== 'enabled' || job.revision !== snapshot.revision || (job.checkUntil ?? 0) > now || !this.available(job.botId)) return false
      this.assertAuthorized(job)
      this.store.saveJob({ ...job, checkToken: token, checkUntil: now + AUTOMATION_LIMITS.checkTimeoutMs })
      return true
    })
    if (!admitted) return
    const controller = new AbortController(); this.checks.set(snapshot.id, controller)
    let timeout: ReturnType<typeof setTimeout> | undefined; let timedOut = false
    const validIdentity = () => {
      const job = this.store.get(snapshot.botId, snapshot.id)
      return this.available(job.botId) && job.status === 'enabled' && job.revision === snapshot.revision && job.checkToken === token && this.authorized(job)
    }
    const isCurrent = () => !controller.signal.aborted && validIdentity()
    try {
      let scheduledAt = manual ? now : snapshot.nextCheckAt ?? now
      if (!manual && !snapshot.condition) {
        if (snapshot.schedule.kind === 'every') scheduledAt = snapshot.schedule.anchorMs + Math.floor((now - snapshot.schedule.anchorMs) / snapshot.schedule.everyMs) * snapshot.schedule.everyMs
        if (snapshot.schedule.kind === 'cron') scheduledAt = computePreviousRunAtMs(snapshot.schedule, now + 1) ?? scheduledAt
      }
      let result: ReturnType<typeof evaluateMetric> | undefined
      if (snapshot.condition) {
        const sample = await Promise.race([
          (this.options.collect ?? collectHostMetric)(snapshot.condition, controller.signal),
          new Promise<never>((_, reject) => {
            const abort = () => reject(new Error(timedOut ? '事件条件检查timeout' : '事件条件检查已取消'))
            controller.signal.addEventListener('abort', abort, { once: true })
            timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('事件条件检查timeout')) }, this.options.checkTimeoutMs ?? AUTOMATION_LIMITS.checkTimeoutMs)
            timeout.unref?.()
          }),
        ])
        if (!isCurrent()) return
        const expectedInterval = snapshot.schedule.kind === 'every' ? snapshot.schedule.everyMs
          : Math.max(30_000, (computeNextRunAtMs(snapshot.schedule, scheduledAt) ?? scheduledAt + 30_000) - scheduledAt)
        // Delivery may commit a fired state while collection awaits I/O. Re-read it.
        const latest = this.store.get(snapshot.botId, snapshot.id)
        result = evaluateMetric(snapshot.condition, latest.state, sample, this.now(), expectedInterval)
        if (Buffer.byteLength(JSON.stringify(result.state)) > 16 * 1024) throw new Error('条件状态超过16KB上限')
      }
      if (!isCurrent()) return
      const occurrence = this.store.transaction(() => {
        if (!isCurrent()) return
        const job = this.store.get(snapshot.botId, snapshot.id)
        const next = manual ? job.nextCheckAt : computeNextRunAtMs(job.schedule, this.now())
        const nextJob: AutomationJob = { ...job, checks: job.checks + 1, nextCheckAt: next, checkToken: undefined, checkUntil: undefined, error: undefined, failures: 0, failureNotified: false,
          ...(!result?.fire && result ? { state: result.state } : {}), updatedAt: this.now() }
        // Conditions never sample faster than30s, even if cron has second fields.
        if (result && nextJob.nextCheckAt !== undefined) nextJob.nextCheckAt = Math.max(nextJob.nextCheckAt, this.now() + 30_000)
        this.store.saveJob(nextJob)
        if (result && !result.fire) return
        const r = this.store.enqueue(job.id, job.revision, manualKey ?? String(scheduledAt), scheduledAt, result?.message ?? `计划「${job.name}」到期；执行已保存委托。`, this.now(), { pendingState: result?.state })
        if (r && !manual && !job.condition && now - scheduledAt > job.misfireMs) {
          this.store.transition(r.id, 'needs_attention', this.now(), { error: '计划已过期，未自动补做' })
          if (job.schedule.kind === 'at') this.store.saveJob({ ...nextJob, status: 'paused', error: '一次性计划已过期，待人工处理' })
          return
        }
        return r
      })
      if (occurrence) this.options.onWake(snapshot.botId)
      return occurrence
    } catch (error) {
      if ((timedOut || !controller.signal.aborted) && validIdentity()) this.store.transaction(() => {
        const job = this.store.get(snapshot.botId, snapshot.id)
        const failures = job.failures + 1; const message = String(error).slice(0, 1000)
        this.store.saveJob({ ...job, checkToken: undefined, checkUntil: undefined, failures, error: message, updatedAt: this.now(), nextCheckAt: this.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 6)), failureNotified: job.failureNotified || failures >= 3 })
        if (failures >= 3 && !job.failureNotified) {
          const r = this.store.enqueue(job.id, job.revision, `monitor-error:${now}`, now, `监测「${job.name}」连续失败：${message}。请说明监测异常，不得报告正常。`, this.now(), { diagnostic: true })
          if (r) this.options.onWake(job.botId)
        }
      })
      return
    } finally {
      clearTimeout(timeout)
      if (this.checks.get(snapshot.id) === controller) this.checks.delete(snapshot.id)
    }
  }
  claim(botId: string): RuntimeAutomationTrigger | undefined {
    if (!this.available(botId)) return
    return this.store.transaction(() => {
      const active = this.store.active(botId)
      for (const r of active.filter(r => r.state === 'queued' && (r.retryAt ?? 0) <= this.now())) {
        const job = this.store.get(botId, r.jobId)
        if (!this.store.current(r)) { this.store.transition(r.id, 'cancelled', this.now(), { error: '事件版本已变化' }); continue }
        if (!this.authorized(job)) { this.store.setStatus(botId, job.id, job.revision, 'paused', this.now(), '原委托授权已失效'); continue }
        if (active.some(other => other.jobId === job.id && other.id !== r.id && ['routing', 'working', 'delivery_pending'].includes(other.state))) continue
        return { job, occurrence: this.store.transition(r.id, 'routing', this.now(), { attempts: r.attempts + 1, retryAt: undefined }) }
      }
    })
  }
  hasReady(botId: string): boolean {
    const active = this.store.active(botId)
    return this.available(botId) && active.some(r => r.state === 'queued' && (r.retryAt ?? 0) <= this.now() && this.store.current(r)
      && !active.some(other => other.jobId === r.jobId && other.id !== r.id && ['routing', 'working', 'delivery_pending'].includes(other.state)))
  }
  release(id: string): void {
    const r = this.store.occurrence(id)
    if (r?.state === 'routing') this.store.transition(id, 'queued', this.now())
  }
  complete(id: string): void {
    this.store.transaction(() => {
      const r = this.store.occurrence(id); if (!r || !this.store.current(r)) return
      const job = this.store.get(r.botId, r.jobId)
      this.store.transition(id, 'completed', this.now())
      const successes = job.successes + Number(!r.diagnostic)
      const done = !r.diagnostic && (job.schedule.kind === 'at' || successes >= (job.maxRuns ?? Infinity))
      const state = r.pendingState && job.state && job.state.lastSampleAt > r.pendingState.lastSampleAt
        ? { ...job.state, lastFiredAt: Math.max(job.state.lastFiredAt ?? 0, r.pendingState.lastFiredAt ?? 0) } : r.pendingState
      this.store.saveJob({ ...job, successes, ...(state ? { state } : {}), ...(done ? { status: 'completed', nextCheckAt: undefined } : {}), updatedAt: this.now() })
      if (done) this.store.cancelJob(job.id, this.now(), '事件已完成')
    })
  }
  fail(id: string, error: string): void {
    const r = this.store.occurrence(id); if (!r || !ACTIVE_OCCURRENCE_STATES.includes(r.state)) return
    const hint = resolveCronExecutionRetryHint({ error, executionStarted: !!r.taskId })
    if (!r.taskId && r.attempts < AUTOMATION_LIMITS.maxAttempts && hint.retryable) this.store.transition(id, 'queued', this.now(), { error: error.slice(0, 1000), retryAt: this.now() + 5000 * Math.max(1, r.attempts) })
    else {
      this.store.transition(id, r.taskId ? 'needs_attention' : 'failed', this.now(), { error: error.slice(0, 1000) })
      const job = this.store.get(r.botId, r.jobId)
      if (job.schedule.kind === 'at') this.store.saveJob({ ...job, status: 'paused', error: error.slice(0, 1000), nextCheckAt: undefined })
    }
  }
  run(botId: string, jobId: string, requestKey: string): Promise<AutomationOccurrence | undefined> {
    const job = this.store.get(botId, jobId)
    if (job.status !== 'enabled') throw new Error('事件已暂停或未启用，不能执行')
    this.assertAuthorized(job)
    return this.check(job, `manual:${requestKey}`)
  }
  publishTaskCompleted(botId: string, taskId: string, eventKey: string, message: string): void {
    if (!this.available(botId)) return
    for (const job of this.store.jobs(botId, 'enabled').filter(j => j.schedule.kind === 'event' && j.schedule.taskId === taskId && j.lastEventKey !== eventKey)) {
      if (!this.authorized(job)) continue
      this.store.transaction(() => {
        this.store.saveJob({ ...job, lastEventKey: eventKey, updatedAt: this.now() })
        if (this.store.enqueue(job.id, job.revision, `event:${eventKey}`, this.now(), message, this.now())) this.options.onWake(botId)
      })
    }
  }
  cancelChecks(botId?: string): void {
    for (const [id, controller] of this.checks) if (!botId || this.store.jobs(botId).some(j => j.id === id)) controller.abort()
  }
  cancelCheck(jobId: string): void { this.checks.get(jobId)?.abort() }
  async stop(): Promise<void> { this.stopped = true; this.cancelChecks(); await this.ticking }
}
