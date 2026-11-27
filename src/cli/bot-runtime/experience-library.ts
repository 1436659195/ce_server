import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import type { ExperienceMaterial, ExperienceRef, ExperienceSaveCommand, ExperienceScope, ExperienceSource, ExperienceStats, ExperienceUsageReport, RuntimeArtifact, RuntimeExperience, RuntimeInbox, RuntimeReply, RuntimeTask } from './types'

const text = (max: number) => z.string().trim().min(1).max(max)
const texts = (max = 20) => z.array(text(500)).max(max)
export const EXPERIENCE_SCOPE_SCHEMA = z.strictObject({ project: text(200).optional(), service: text(100).optional(), os: text(40).optional(), versionRange: text(100).nullable().optional(), version: text(100).optional() })
export const EXPERIENCE_CONTENT_SCHEMA = z.strictObject({
  title: text(160), object: text(200), goal: text(500), applicability: text(500), scope: EXPERIENCE_SCOPE_SCHEMA.optional(),
  pitfalls: texts(), steps: texts().min(1), verification: texts(), detail: z.string().max(12000).optional(), artifactIds: z.array(text(150)).max(8).optional(),
})
export const EXPERIENCE_SAVE_SCHEMA = z.strictObject({ requestId: text(200), id: text(150).optional(), expectedVersion: z.number().int().min(1).optional(), content: EXPERIENCE_CONTENT_SCHEMA, changeSummary: text(1000) }).refine(v => !!v.id === (v.expectedVersion !== undefined), '更新需要经验编号和当前版本')
export const EXPERIENCE_USAGE_SCHEMA = z.array(z.strictObject({ experienceId: text(150), version: z.number().int().min(1), status: z.enum(['applied', 'adapted', 'skipped', 'failed']), appliedSteps: texts(), result: text(1000) })).max(3)
export interface ExperienceReceipt { id: string; version: number; created: boolean; duplicate?: true }
export interface ExperienceSearchItem { id: string; version: number; title: string; approach: string; applicability: string; scope: ExperienceScope; verified: boolean; warnings: string[] }
export interface ExperienceSearchResult { items: ExperienceSearchItem[]; total: number; nextOffset?: number; mode: 'catalog' | 'keyword' }
const zeroStats = (): ExperienceStats => ({ displays: 0, reads: 0, adopted: 0, succeeded: 0, legacyExposures: 0 })
const canonical = (v: unknown): string => JSON.stringify(v && typeof v === 'object' ? Array.isArray(v) ? v.map(x => JSON.parse(canonical(x))) : Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, JSON.parse(canonical(x))])) : v ?? null)
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex')
const normalized = (v: string) => v.normalize('NFKC').trim().toLowerCase()
const segments = new Intl.Segmenter('zh', { granularity: 'word' })
/** Stable tokens indexed identically at write and query time; Chinese punctuation never joins two words. */
export function experienceTokens(value: string): string[] {
  const value0 = normalized(value); const words = new Set<string>()
  for (const item of segments.segment(value0)) if (item.isWordLike) words.add(item.segment)
  for (const chunk of value0.match(/[\p{Script=Han}]+/gu) ?? []) { const chars = [...chunk]; for (let i = 1; i < chars.length; i++) words.add(chars[i - 1] + chars[i]) }
  return [...words].filter(w => /[\p{L}\p{N}]/u.test(w))
}
function normalizeScope(scope: ExperienceScope = {}): ExperienceScope {
  const value = Object.fromEntries(Object.entries(scope).filter(([, v]) => v != null).map(([k, v]) => [k, normalized(String(v))])) as ExperienceScope
  if (value.os === 'win32') value.os = 'windows'
  if (value.os === 'macos' || value.os === 'osx') value.os = 'darwin'
  return value
}
function versionMatches(version: string, range: string): boolean | undefined {
  const parse = (v: string) => { const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v); return m ? [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)] : undefined }
  const current = parse(version); if (!current) return undefined
  const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]); return 0 }
  let unknown = false
  for (const group of range.split('||')) {
    const parts = group.trim().replace(/([<>]=?|=|~|\^)\s+/g, '$1').split(/\s+/); let match = true
    for (const part of parts) {
      const m = /^(>=|<=|>|<|=|~|\^)?(v?\d+(?:\.\d+){0,2})$/.exec(part); const target = m && parse(m[2])
      if (!m || !target) { unknown = true; match = false; break }
      const n = cmp(current, target); const op = m[1] ?? '='
      if (!(op === '>=' ? n >= 0 : op === '<=' ? n <= 0 : op === '>' ? n > 0 : op === '<' ? n < 0 : op === '~' ? n >= 0 && current[0] === target[0] && current[1] === target[1] : op === '^' ? n >= 0 && (target[0] ? current[0] === target[0] : target[1] ? current[0] === 0 && current[1] === target[1] : current[0] === 0 && current[1] === 0 && current[2] === target[2]) : n === 0)) match = false
    }
    if (match) return true
  }
  return unknown ? undefined : false
}
function scopeMatch(required: ExperienceScope = {}, actual: ExperienceScope = {}): { compatible: boolean; warnings: string[]; specificity: number } {
  const r = normalizeScope(required), a = normalizeScope(actual); const warnings: string[] = []; let specificity = 0
  for (const key of ['project', 'service', 'os'] as const) {
    if (!r[key]) continue
    if (!a[key]) warnings.push(`${key} 未核实`)
    else if (r[key] !== a[key]) return { compatible: false, warnings, specificity }
    else specificity++
  }
  if (r.versionRange) {
    const matches = a.version ? versionMatches(a.version, r.versionRange) : undefined
    if (matches === false) return { compatible: false, warnings, specificity }
    if (matches === undefined) warnings.push('versionRange 未核实')
    else specificity++
  }
  return { compatible: true, warnings, specificity }
}

/** Shared SQLite transaction boundary; identities and sources are supplied by the host, never inferred from model text. */
export class ExperienceLibrary {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS experience_versions (experience_id TEXT NOT NULL, version INTEGER NOT NULL, bot_id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(experience_id,version));
      CREATE INDEX IF NOT EXISTS experience_versions_bot ON experience_versions(bot_id,experience_id);
      CREATE TABLE IF NOT EXISTS experience_receipts (bot_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bot_id,request_id));
      CREATE TABLE IF NOT EXISTS experience_events (bot_id TEXT NOT NULL, event_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bot_id,event_key));
      CREATE TABLE IF NOT EXISTS experience_usage (bot_id TEXT NOT NULL, task_id TEXT NOT NULL, experience_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bot_id,task_id,experience_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(id UNINDEXED,bot_id UNINDEXED,title,applicability,pitfalls,steps,detail,tokenize='unicode61');`)
    this.atomic(() => {
      const old = this.rows<RuntimeExperience>('SELECT body FROM experiences')
      for (const item of old) {
        if (item.format !== 2) this.migrate(item)
        else if (item.kind === 'lesson') this.index(item)
      }
      const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version < 5) db.exec('PRAGMA user_version=5')
    })
  }
  private atomic<T>(fn: () => T): T { return this.db.transaction(fn)() }
  private rows<T>(sql: string, ...args: (string | number)[]): T[] { return (this.db.query(sql).all(...args) as { body: string }[]).map(r => JSON.parse(r.body)) }
  private row<T>(table: 'inbox' | 'tasks' | 'outbox' | 'artifacts', id: string): T | undefined { return this.rows<T>(`SELECT body FROM ${table} WHERE id=?`, id)[0] }
  private put(item: RuntimeExperience, index = true): void { this.db.query('INSERT INTO experiences(id,bot_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(item.id, item.botId, JSON.stringify(item)); if (index) this.index(item) }
  private index(item: RuntimeExperience): void {
    this.db.query('DELETE FROM experience_fts WHERE id=?').run(item.id)
    if (item.kind !== 'lesson') return
    const tokens = (s: string) => experienceTokens(s).join(' ')
    this.db.query('INSERT INTO experience_fts(id,bot_id,title,applicability,pitfalls,steps,detail) VALUES(?,?,?,?,?,?,?)').run(item.id, item.botId, tokens(`${item.title ?? ''} ${item.object} ${item.goal}`), tokens(item.applicability ?? ''), tokens((item.pitfalls ?? []).join(' ')), tokens((item.steps ?? []).join(' ')), tokens(item.detail))
  }
  private snapshot(item: RuntimeExperience): void { this.db.query('INSERT INTO experience_versions(experience_id,version,bot_id,body) VALUES(?,?,?,?)').run(item.id, item.version!, item.botId, JSON.stringify(item)) }
  private migrate(old: RuntimeExperience): void {
    const lesson = old.migrated || /经验.*(?:总结|复盘)|(?:总结|复盘).*(?:经验|踩坑)|踩坑.*(?:总结|复盘)/.test(old.goal)
    const material = this.rows<RuntimeArtifact>("SELECT body FROM artifacts WHERE bot_id=? AND json_extract(body,'$.taskId')=?", old.botId, old.sourceTaskId)
    const title = old.migrated ? old.goal : old.goal.trim() || old.object
    const e: RuntimeExperience = { ...old, format: 2, kind: lesson ? 'lesson' : 'report', version: 1, title: title.slice(0, 160), applicability: `${old.object}；${old.goal}`.slice(0, 500), scope: {}, pitfalls: [], steps: old.detail ? [old.detail.slice(0, 500)] : [old.approach], verification: old.checks, materials: material.map(this.material), stats: { ...zeroStats(), legacyExposures: old.uses }, uses: 0, changeSummary: '迁移旧记录；历史使用数只代表展示或读取', source: old.sourceTaskId ? { taskId: old.sourceTaskId } : {} }
    this.put(e); this.db.query('INSERT OR IGNORE INTO experience_versions(experience_id,version,bot_id,body) VALUES(?,?,?,?)').run(e.id, 1, e.botId, JSON.stringify(e))
  }
  private material(a: RuntimeArtifact): ExperienceMaterial { return { artifactId: a.id, hash: a.hash, revision: a.revision, name: a.name ?? a.title, mime: a.mime } }
  private source(botId: string, source: ExperienceSource): { task?: RuntimeTask; reply?: RuntimeReply; verified: boolean } {
    if (!source.taskId && !source.inboxId && !source.replyId) throw new Error('经验缺少真实来源')
    let task: RuntimeTask | undefined, reply: RuntimeReply | undefined
    if (source.inboxId) { const input = this.row<RuntimeInbox>('inbox', source.inboxId); if (!input || input.botId !== botId || input.revokedAt) throw new Error('经验来源消息不存在、已撤回或归属不匹配') }
    if (source.taskId) { task = this.row<RuntimeTask>('tasks', source.taskId); if (!task || task.botId !== botId) throw new Error('经验来源工单不存在或归属不匹配') }
    if (source.replyId) {
      reply = this.row<RuntimeReply>('outbox', source.replyId)
      if (!reply || reply.botId !== botId || reply.author !== 'worker' || reply.purpose !== 'result' || !reply.taskId || (source.taskId && source.taskId !== reply.taskId)) throw new Error('经验来源结果归属不匹配')
      task ??= this.row<RuntimeTask>('tasks', reply.taskId)
      if (!task || task.botId !== botId || task.review?.state !== 'approved' || task.state !== 'completed' || !['routed', 'sent'].includes(reply.state) || reply.taskRevision !== task.revision) throw new Error('经验来源结果尚未通过验收接受或已过期')
    }
    return { task, reply, verified: !!reply?.checks?.some(value => typeof value === 'string' && value.trim()) }
  }
  private receipt<T>(botId: string, requestId: string, command: unknown, run: () => T): T {
    const digest = hash(command); const prior = this.db.query('SELECT digest,body FROM experience_receipts WHERE bot_id=? AND request_id=?').get(botId, requestId) as { digest: string; body: string } | null
    if (prior) { if (prior.digest !== digest) throw new Error('重复请求编号对应不同内容'); return JSON.parse(prior.body) }
    const result = run(); this.db.query('INSERT INTO experience_receipts(bot_id,request_id,digest,body) VALUES(?,?,?,?)').run(botId, requestId, digest, JSON.stringify(result)); return result
  }
  save(botId: string, args: ExperienceSaveCommand, source: ExperienceSource): ExperienceReceipt {
    const parsed = EXPERIENCE_SAVE_SCHEMA.safeParse(args)
    if (!parsed.success) throw new Error(`经验参数格式错误：${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.code}`).join('；')}`)
    const cmd = parsed.data
    return this.atomic(() => this.receipt(botId, cmd.requestId, { cmd, source }, () => {
      const evidence = this.source(botId, source)
      const materials = (cmd.content.artifactIds ?? []).map(id => { const a = this.row<RuntimeArtifact>('artifacts', id); if (!a || a.botId !== botId) throw new Error('经验材料成果不存在或归属不匹配'); return this.material(a) })
      const previous = cmd.id ? this.get(botId, cmd.id) : undefined
      if (cmd.id && (!previous || previous.version !== cmd.expectedVersion)) throw new Error('经验不存在或版本已变化，请读取后重试')
      const key = (e: { title?: string; object?: string; goal?: string; applicability?: string; scope?: ExperienceScope }) => canonical([normalized(e.title ?? ''), normalized(e.object ?? ''), normalized(e.goal ?? ''), normalized(e.applicability ?? ''), normalizeScope(e.scope)])
      const duplicate = this.rows<RuntimeExperience>('SELECT body FROM experiences WHERE bot_id=?', botId).find(e => e.kind === 'lesson' && e.id !== cmd.id && key(e) === key(cmd.content))
      if (duplicate) {
        if (cmd.id) throw new Error(`经验主题已存在：${duplicate.id}，请明确合并或更新目标`)
        return { id: duplicate.id, version: duplicate.version!, created: false, duplicate: true }
      }
      const now = Date.now(), c = cmd.content
      const item: RuntimeExperience = { id: previous?.id ?? `exp_${randomUUID()}`, botId, format: 2, kind: 'lesson', state: previous?.state ?? 'active', version: (previous?.version ?? 0) + 1,
        title: c.title, object: c.object, goal: c.goal, applicability: c.applicability, scope: normalizeScope(c.scope), pitfalls: c.pitfalls, steps: c.steps, verification: c.verification, detail: c.detail ?? '', materials,
        approach: c.steps[0].slice(0, 200), checks: evidence.reply?.checks ?? [], verified: evidence.verified, sourceTaskId: evidence.task?.id ?? '', sourceCaseId: evidence.task?.caseId ?? '',
        uses: previous?.uses ?? 0, stats: previous?.stats ?? zeroStats(), platform: previous?.platform ?? '', toolFingerprint: previous?.toolFingerprint ?? '', createdAt: previous?.createdAt ?? now, updatedAt: now, changeSummary: cmd.changeSummary, source }
      this.put(item); this.snapshot(item)
      return { id: item.id, version: item.version!, created: !previous }
    }))
  }
  get(botId: string, id: string, version?: number): RuntimeExperience | undefined {
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error('经验版本无效')
    return version === undefined ? this.rows<RuntimeExperience>('SELECT body FROM experiences WHERE bot_id=? AND id=?', botId, id)[0] : this.rows<RuntimeExperience>('SELECT body FROM experience_versions WHERE bot_id=? AND experience_id=? AND version=?', botId, id, version)[0]
  }
  history(botId: string, id: string): RuntimeExperience[] { return this.rows('SELECT body FROM experience_versions WHERE bot_id=? AND experience_id=? ORDER BY version', botId, id) }
  search(botId: string, opts: { query?: string; scope?: ExperienceScope; limit?: number; offset?: number } = {}): ExperienceSearchResult {
    const limit = opts.limit ?? 20, offset = opts.offset ?? 0
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('经验检索条数范围为 1～20')
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('经验检索偏移范围无效')
    if (opts.query !== undefined && (typeof opts.query !== 'string' || opts.query.length > 2000)) throw new Error('经验检索关键词过长')
    const scope = EXPERIENCE_SCOPE_SCHEMA.safeParse(opts.scope ?? {}); if (!scope.success) throw new Error('经验检索适用范围无效')
    const all = this.rows<RuntimeExperience>("SELECT body FROM experiences WHERE bot_id=? AND json_extract(body,'$.kind')='lesson' AND json_extract(body,'$.state')='active'", botId)
    const found = all.map(item => ({ item, match: scopeMatch(item.scope, scope.data) })).filter(v => v.match.compatible)
    let candidates = found; const mode = found.length <= 20 ? 'catalog' : 'keyword'
    if (mode === 'keyword' && opts.query?.trim()) {
      const tokens = experienceTokens(opts.query).slice(0, 48)
      if (!tokens.length) candidates = []
      else {
        const query = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
        const ranked = this.db.query('SELECT id,bm25(experience_fts,0,0,8,6,4,3,1) AS rank FROM experience_fts WHERE experience_fts MATCH ? AND bot_id=? ORDER BY rank,id').all(query, botId) as { id: string; rank: number }[]
        const scores = new Map(ranked.map((r, i) => [r.id, i])); candidates = found.filter(e => scores.has(e.item.id)).sort((a, b) => scores.get(a.item.id)! - scores.get(b.item.id)!)
      }
    } else candidates.sort((a, b) => b.match.specificity - a.match.specificity || Number(b.item.verified) - Number(a.item.verified) || (a.item.title ?? '').localeCompare(b.item.title ?? '') || a.item.id.localeCompare(b.item.id))
    const items = candidates.slice(offset, offset + limit).map(({ item, match }) => ({ id: item.id, version: item.version!, title: item.title ?? item.goal, approach: item.approach.slice(0, 200), applicability: (item.applicability ?? '').slice(0, 200), scope: item.scope ?? {}, verified: item.verified, warnings: match.warnings }))
    return { items, total: candidates.length, ...(offset + items.length < candidates.length ? { nextOffset: offset + items.length } : {}), mode }
  }
  changeState(botId: string, args: { requestId: string; id: string; expectedVersion: number; state: RuntimeExperience['state']; reason: string }, source: ExperienceSource): ExperienceReceipt {
    const schema = z.strictObject({ requestId: text(200), id: text(150), expectedVersion: z.number().int().min(1), state: z.enum(['active', 'needs_review', 'retired']), reason: text(1000) }); const parsed = schema.safeParse(args)
    if (!parsed.success) throw new Error('经验状态参数无效')
    return this.atomic(() => this.receipt(botId, args.requestId, { args, source }, () => {
      this.source(botId, source); const previous = this.get(botId, args.id)
      if (!previous || previous.kind !== 'lesson' || previous.version !== args.expectedVersion) throw new Error('经验不存在或版本已变化')
      const item = { ...previous, state: args.state, version: previous.version + 1, changeSummary: args.reason, source, updatedAt: Date.now() }
      this.put(item); this.snapshot(item); return { id: item.id, version: item.version, created: false }
    }))
  }
  recordExposure(botId: string, refs: ExperienceRef[], kind: 'display' | 'read', eventId: string): void {
    if (!eventId || !['display', 'read'].includes(kind)) throw new Error('经验展示事件无效')
    this.atomic(() => { for (const ref of refs) {
      const item = this.get(botId, ref.experienceId), pinned = this.get(botId, ref.experienceId, ref.version); if (!item || !pinned) throw new Error('经验展示来源不存在或归属不匹配')
      const key = `${kind}:${eventId}:${ref.experienceId}:${ref.version}`
      const changed = this.db.query('INSERT OR IGNORE INTO experience_events(bot_id,event_key,body) VALUES(?,?,?)').run(botId, key, JSON.stringify({ kind, ref, at: Date.now() })).changes
      if (changed) { const stats = { ...(item.stats ?? zeroStats()) }; stats[kind === 'display' ? 'displays' : 'reads']++; this.put({ ...item, stats }, false) }
    } })
  }
  recordUsage(botId: string, taskId: string, reports: ExperienceUsageReport[], selectedRefs: ExperienceRef[]): void {
    const parsed = EXPERIENCE_USAGE_SCHEMA.safeParse(reports); if (!parsed.success) throw new Error('经验采用反馈格式无效')
    const task = this.row<RuntimeTask>('tasks', taskId); if (!task || task.botId !== botId) throw new Error('经验采用工单归属不匹配')
    this.atomic(() => { for (const report of parsed.data) {
      if (!selectedRefs.some(r => r.experienceId === report.experienceId && r.version === report.version)) throw new Error('只能反馈当前任务已选定关联的经验版本')
      const item = this.get(botId, report.experienceId), pinned = this.get(botId, report.experienceId, report.version)
      if (!item || !pinned) throw new Error('经验采用来源不存在')
      const adopted = report.status !== 'skipped'
      if (adopted && !report.appliedSteps.length) throw new Error('经验采用需要具体执行步骤')
      const previous = this.rows<{ report: ExperienceUsageReport; adopted: boolean; succeeded: boolean }>('SELECT body FROM experience_usage WHERE bot_id=? AND task_id=? AND experience_id=?', botId, taskId, item.id)[0]
      const entry = { report, adopted: adopted || !!previous?.adopted, succeeded: !!previous?.succeeded, at: Date.now() }
      this.db.query('INSERT OR IGNORE INTO experience_events(bot_id,event_key,body) VALUES(?,?,?)').run(botId, `usage:${taskId}:${item.id}:${hash(report)}`, JSON.stringify({ taskId, ...report, at: entry.at }))
      this.db.query('INSERT INTO experience_usage(bot_id,task_id,experience_id,body) VALUES(?,?,?,?) ON CONFLICT(bot_id,task_id,experience_id) DO UPDATE SET body=excluded.body').run(botId, taskId, item.id, JSON.stringify(entry))
      if (adopted && !previous?.adopted) this.put({ ...item, uses: (item.stats?.adopted ?? 0) + 1, stats: { ...(item.stats ?? zeroStats()), adopted: (item.stats?.adopted ?? 0) + 1 }, lastUsedAt: Date.now() }, false)
      if (report.status === 'failed' && item.state === 'active' && item.version === report.version) {
        const current = this.get(botId, item.id)!
        this.changeState(botId, { requestId: `usage-failed:${taskId}:${item.id}:${report.version}`, id: item.id, expectedVersion: current.version!, state: 'needs_review', reason: `采用后发现问题：${report.result}`.slice(0, 1000) }, { taskId })
      }
    } })
  }
  acceptUsage(botId: string, taskId: string, replyId: string, reports?: ExperienceUsageReport[]): void {
    this.atomic(() => {
      const source = this.source(botId, { taskId, replyId }); if (!source.verified) return
      const actual = reports ?? source.reply?.experienceUsage
      const entries = this.db.query('SELECT experience_id,body FROM experience_usage WHERE bot_id=? AND task_id=?').all(botId, taskId) as { experience_id: string; body: string }[]
      for (const row of entries) {
        const entry = JSON.parse(row.body) as { report: ExperienceUsageReport; adopted: boolean; succeeded: boolean }
        const report = actual?.find(r => r.experienceId === row.experience_id && r.version === entry.report.version)
        if (!report || !['applied', 'adapted'].includes(report.status) || entry.succeeded || !entry.adopted) continue
        const item = this.get(botId, row.experience_id); if (!item) continue
        entry.succeeded = true; this.db.query('UPDATE experience_usage SET body=? WHERE bot_id=? AND task_id=? AND experience_id=?').run(JSON.stringify(entry), botId, taskId, item.id)
        this.put({ ...item, stats: { ...(item.stats ?? zeroStats()), succeeded: (item.stats?.succeeded ?? 0) + 1 } }, false)
      }
    })
  }
  usage(botId: string, experienceId: string): Array<ExperienceUsageReport & { taskId: string; successful: boolean }> {
    const rows = this.db.query('SELECT task_id,body FROM experience_usage WHERE bot_id=? AND experience_id=? ORDER BY rowid').all(botId, experienceId) as { task_id: string; body: string }[]
    return rows.map(row => { const e = JSON.parse(row.body); return { ...e.report, taskId: row.task_id, successful: e.succeeded } })
  }
  usageHistory(botId: string, taskId: string): Array<ExperienceUsageReport & { taskId: string; at: number }> { return this.rows("SELECT body FROM experience_events WHERE bot_id=? AND event_key LIKE 'usage:%' AND json_extract(body,'$.taskId')=? ORDER BY rowid", botId, taskId) }
}
