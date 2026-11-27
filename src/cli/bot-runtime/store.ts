import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RuntimeExperience, MemoryJob, RuntimeArtifact, RuntimeCase, RuntimeInbox, RuntimeMandate, RuntimeMemory, RuntimeMemoryLog, RuntimeOperation, RuntimeReply, RuntimeRun, RuntimeSettings, RuntimeTask, RuntimeTaskInput, RuntimeUpload, RuntimeRemoteOp } from './types'
import { EXPERIENCE_ESTABLISHED_USES } from './experience'
import { relevance } from './cases'
import { validateRouterReply } from './reply-policy'
import { queryChatHistory, readChatMessage } from './history'
import type { RuntimeArtifactSummaryInput } from './types'
import type { RuntimeCaseUpdate, RuntimeCaseDecision } from './types'
import { AutomationStore } from './automation/store'

type Table = 'settings' | 'inbox' | 'cases' | 'tasks' | 'task_inputs' | 'runs' | 'tool_operations' | 'outbox' | 'artifacts' | 'controls' | 'uploads' | 'memories' | 'memory_log' | 'experiences' | 'remote_ops'
const tables: Table[] = ['settings', 'inbox', 'cases', 'tasks', 'task_inputs', 'runs', 'tool_operations', 'outbox', 'artifacts', 'controls', 'uploads', 'memories', 'memory_log', 'experiences', 'remote_ops']
const id = (prefix: string) => `${prefix}_${randomUUID()}`
const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' })
export function validateChatText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('回复不能为空')
  const text = value.trim()
  if ([...segments.segment(text)].length > 100) throw new Error('专业聊天正文最多 100 个可见字符，请重写，不能拆分规避；长内容放成果文件')
  return text
}

/** Worker提供事实和依据给前台，不再把内部说明压缩成用户气泡。 */
function validateWorkerText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('Worker内部结果需要1～4000字符，详细内容放成果文件')
  return value.trim()
}

/** 小型本地账本；JSON 是记录正文，SQL 表达式索引负责唯一性。所有业务写入经本类事务。 */
export class BotRuntimeStore {
  readonly automations: AutomationStore
  private db: Database
  private closed = false
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body))); CREATE INDEX IF NOT EXISTS ${table}_bot ON ${table}(bot_id);`)
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_source ON inbox(bot_id,json_extract(body,'$.groupId'),json_extract(body,'$.seq'));
      CREATE UNIQUE INDEX IF NOT EXISTS input_source ON task_inputs(json_extract(body,'$.taskId'),json_extract(body,'$.inboxId'));
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_key ON outbox(bot_id,json_extract(body,'$.key'));
      CREATE UNIQUE INDEX IF NOT EXISTS operation_call ON tool_operations(json_extract(body,'$.runId'),json_extract(body,'$.callId'));
    `)
    // 与按卷宗/状态读取配套；旧数据库启动时幂等建立，不改JSON正文。
    for (const table of ['tasks', 'artifacts']) this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_case ON ${table}(bot_id,json_extract(body,'$.caseId'));`)
    for (const table of ['tasks', 'runs', 'tool_operations']) this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_state ON ${table}(bot_id,json_extract(body,'$.state'));`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS inputs_task ON task_inputs(json_extract(body,'$.taskId'));
      CREATE INDEX IF NOT EXISTS inbox_memory_state ON inbox(bot_id,json_extract(body,'$.memoryJob.state'));
      CREATE INDEX IF NOT EXISTS memories_status ON memories(bot_id,json_extract(body,'$.status'),json_extract(body,'$.needsReview'));`)
    this.transaction(() => {
      const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version < 2) {
        // 只续传升级前已经开始发送的旧内容；新Worker来源永不获得直发资格。
        this.db.exec(`UPDATE outbox SET body=json_set(body,'$.legacyDeliveryRecovery',json('true'))
          WHERE json_extract(body,'$.author')='worker' AND json_extract(body,'$.state')='pending'
          AND json_extract(body,'$.attemptedAt') IS NOT NULL; PRAGMA user_version=2;`)
      }
      if (version < 3) {
        // 旧设置里的手写经验迁进经验表：免指纹校验、直接算常驻；设置里不再保留该字段。
        for (const settings of this.all<RuntimeSettings & { experiences?: Array<{ id: string; summary: string; detail: string; source: string; active: boolean }> }>('settings')) {
          if (!Array.isArray(settings.experiences)) continue
          const now = Date.now()
          for (const e of settings.experiences) this.put('experiences', { id: e.id, botId: settings.botId, state: e.active ? 'active' : 'retired', object: '经验', goal: e.summary.slice(0, 300), approach: e.summary.slice(0, 200), detail: String(e.detail ?? '').slice(0, 4000), checks: [], verified: false, sourceTaskId: '', sourceCaseId: '', uses: EXPERIENCE_ESTABLISHED_USES, platform: '', toolFingerprint: 'legacy', migrated: true, createdAt: now, updatedAt: now } satisfies RuntimeExperience)
          const { experiences: _dropped, ...rest } = settings
          this.put('settings', { ...rest, id: rest.botId })
        }
        this.db.exec('PRAGMA user_version=3')
      }
    })
    this.automations = this.transaction(() => {
      const automations = new AutomationStore(this.db)
      const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version < 4) this.db.exec('PRAGMA user_version=4')
      return automations
    })
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private get<T>(table: Table, key: string): T | undefined {
    const row = this.db.query(`SELECT body FROM ${table} WHERE id=?`).get(key) as { body: string } | null
    return row ? JSON.parse(row.body) as T : undefined
  }
  private all<T>(table: Table, botId?: string): T[] {
    const rows = (botId ? this.db.query(`SELECT body FROM ${table} WHERE bot_id=? ORDER BY rowid`).all(botId) : this.db.query(`SELECT body FROM ${table} ORDER BY rowid`).all()) as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as T)
  }
  /** 条件和限量在SQLite执行；返回仍按插入顺序，兼容既有列表语义。 */
  private queryRows<T>(table: Table, botId: string | undefined, options: { caseIds?: string[]; taskId?: string; state?: string; limit?: number; offset?: number } = {}): T[] {
    if (options.caseIds?.length === 0) return []
    const clauses: string[] = []; const args: (string | number)[] = []
    if (botId !== undefined) { clauses.push('bot_id=?'); args.push(botId) }
    if (options.caseIds) { clauses.push(`json_extract(body,'$.caseId') IN (${options.caseIds.map(() => '?').join(',')})`); args.push(...options.caseIds) }
    if (options.taskId !== undefined) { clauses.push("json_extract(body,'$.taskId')=?"); args.push(options.taskId) }
    if (options.state !== undefined) { clauses.push("json_extract(body,'$.state')=?"); args.push(options.state) }
    const limit = options.limit === undefined ? -1 : Math.max(0, Math.floor(options.limit))
    const rows = this.db.query(`SELECT body FROM ${table}${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, Math.max(0, Math.floor(options.offset ?? 0))) as { body: string }[]
    return rows.reverse().map(row => JSON.parse(row.body))
  }
  queryTasks(botId: string, options: { caseIds?: string[]; state?: string; limit?: number; offset?: number } = {}): RuntimeTask[] { return this.queryRows('tasks', botId, options) }
  viewTasks(botId: string): RuntimeTask[] {
    const rows = this.db.query(`SELECT body FROM tasks WHERE rowid IN (
      SELECT rowid FROM (SELECT rowid FROM tasks WHERE bot_id=? ORDER BY rowid DESC LIMIT 30)
      UNION SELECT rowid FROM tasks WHERE bot_id=? AND (json_extract(body,'$.state') IN ('queued','running','waiting_user','stopping','recovering') OR (json_extract(body,'$.state')='completed' AND json_extract(body,'$.review.state')='pending'))
    ) ORDER BY rowid`).all(botId, botId) as { body: string }[]
    return rows.map(row => JSON.parse(row.body))
  }

  queryArtifacts(botId: string, options: { caseIds?: string[]; limit?: number; offset?: number } = {}): RuntimeArtifact[] { return this.queryRows('artifacts', botId, options) }
  queryCases(botId: string, ids: string[]): RuntimeCase[] {
    return [...new Set(ids)].flatMap(id => { const c = this.case(id); return c?.botId === botId ? [c] : [] })
  }
  unknownRuns(botId: string): RuntimeRun[] { return this.queryRows('runs', botId, { state: 'unknown' }) }
  unknownOperations(botId: string): RuntimeOperation[] { return this.queryRows('tool_operations', botId, { state: 'unknown', limit: 30 }) }
  private put<T extends { id: string; botId: string }>(table: Table, value: T): void {
    this.db.query(`INSERT INTO ${table}(id,bot_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE bot_id=excluded.bot_id`).run(value.id, value.botId, JSON.stringify(value))
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate() }

  settings(botId: string): RuntimeSettings {
    return this.get<RuntimeSettings>('settings', botId) ?? { botId, mode: 'legacy', revision: 0, profile: '', model: '' }
  }
  saveSettings(value: RuntimeSettings): void { this.put('settings', { ...value, id: value.botId }) }
  enabledBots(): string[] { return this.all<RuntimeSettings>('settings').filter(s => s.mode === 'router-worker').map(s => s.botId) }
  receive(input: Omit<RuntimeInbox, 'id' | 'state'>): RuntimeInbox {
    return this.transaction(() => {
      const row = this.db.query("SELECT body FROM inbox WHERE bot_id=? AND json_extract(body,'$.groupId')=? AND json_extract(body,'$.seq')=?").get(input.botId, input.groupId, input.seq) as { body: string } | null
      if (row) return JSON.parse(row.body)
      const message: RuntimeInbox = { ...input, id: id('msg'), state: 'pending', receivedAt: Date.now() }
      this.put('inbox', message); return message
    })
  }
  inbox(inputId: string): RuntimeInbox | undefined { return this.get('inbox', inputId) }
  messages(botId: string, limit = 20): RuntimeInbox[] {
    const rows = this.db.query('SELECT body FROM inbox WHERE bot_id=? ORDER BY rowid DESC LIMIT ?').all(botId, Math.max(1, Math.min(100, Math.floor(limit)))) as Array<{ body: string }>
    return rows.reverse().map(row => JSON.parse(row.body))
  }
  failedInputs(botId: string): RuntimeInbox[] {
    const rows = this.db.query("SELECT body FROM inbox WHERE bot_id=? AND json_extract(body,'$.state')='failed' ORDER BY rowid DESC LIMIT 10").all(botId) as Array<{ body: string }>
    return rows.reverse().map(row => JSON.parse(row.body))
  }
  pendingInbox(botId: string): RuntimeInbox[] { return this.all<RuntimeInbox>('inbox', botId).filter(i => i.state === 'pending') }
  inboxBySeq(botId: string, groupId: string, seq: number): RuntimeInbox | undefined {
    const row = this.db.query("SELECT body FROM inbox WHERE bot_id=? AND json_extract(body,'$.groupId')=? AND json_extract(body,'$.seq')=?").get(botId, groupId, seq) as { body: string } | null
    return row ? JSON.parse(row.body) as RuntimeInbox : undefined
  }
  /** 主人撤回：原文和附件在本地清空，账本记录保留。 */
  revokeInbox(inputId: string, at: number): void {
    const input = this.requireInbox(inputId)
    this.put('inbox', { ...input, text: '', attachments: undefined, revokedAt: at })
  }
  setMemoryJob(inputId: string, job: MemoryJob): void {
    const input = this.requireInbox(inputId); this.put('inbox', { ...input, memoryJob: job })
  }
  pendingMemoryJobs(botId: string): RuntimeInbox[] { return this.all<RuntimeInbox>('inbox', botId).filter(i => i.memoryJob?.state === 'queued') }
  runningMemoryJobs(): RuntimeInbox[] { return this.all<RuntimeInbox>('inbox').filter(i => i.memoryJob?.state === 'running') }
  failedMemoryJobs(botId: string): Array<{ id: string; text: string; error?: string }> {
    const rows = this.db.query("SELECT body FROM inbox WHERE bot_id=? AND json_extract(body,'$.memoryJob.state')='failed' ORDER BY rowid DESC LIMIT 10").all(botId) as { body: string }[]
    return rows.reverse().map(row => JSON.parse(row.body) as RuntimeInbox).map(i => ({ id: i.id, text: i.text.slice(0, 200), error: i.memoryJob?.error }))
  }
  markInput(inputId: string, state: RuntimeInbox['state'], decision?: unknown, error?: string): void {
    const input = this.requireInbox(inputId); this.put('inbox', { ...input, state, decision, error })
  }
  private requireInbox(inputId: string, pending = false): RuntimeInbox {
    const input = this.inbox(inputId)
    if (!input) throw new Error('原消息不存在')
    if (pending && input.state !== 'pending') throw new Error('原消息已处理，不重复接单')
    return input
  }
  cases(botId: string): RuntimeCase[] { return this.all('cases', botId) }
  case(caseId: string): RuntimeCase | undefined { return this.get('cases', caseId) }
  saveCase(value: RuntimeCase): void { this.put('cases', value) }
  /** 显式历史搜索：数据库投影可搜索字段，保留原Unicode分词排序，仅解析最终候选的JSON。
   * 包含匹配仍会扫描本Bot历史；不把它误称全文索引或有界搜索。
   */
  findCases(botId: string, query: string, options: { taskId?: string; artifactId?: string; offset?: number } = {}): RuntimeCase[] {
    const offset = options.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0 || offset > 29) throw new Error('卷宗搜索 offset 必须为0至29的整数')
    // ID只认账本归属；不能借关键词回退把无权/失效的引用伪装成有效关联。
    if (options.taskId || options.artifactId) {
      const refs = [...(options.taskId ? [this.task(options.taskId)] : []), ...(options.artifactId ? [this.artifact(options.artifactId)] : [])]
      if (refs.some(ref => !ref || ref.botId !== botId) || new Set(refs.map(ref => ref!.caseId)).size !== 1) return []
      const dossier = this.case(refs[0]!.caseId)
      return dossier?.botId === botId && offset === 0 ? [dossier] : []
    }
    // 显式TEXT亲和性使聚合关联可使用自动覆盖索引，避免逐卷扫描全部分组。
    const rows = this.db.query(`WITH
      work AS (SELECT CAST(json_extract(body,'$.caseId') AS TEXT) AS cid,
        group_concat(coalesce(json_extract(body,'$.goal'),'') || ' ' || coalesce(json_extract(body,'$.summary'),''), char(10)) AS text,
        max(json_extract(body,'$.updatedAt')) AS updated FROM (SELECT body FROM tasks WHERE bot_id=? ORDER BY rowid) GROUP BY cid),
      files AS (SELECT CAST(json_extract(body,'$.caseId') AS TEXT) AS cid,
        group_concat(coalesce(json_extract(body,'$.title'),'') || ' ' || coalesce(json_extract(body,'$.name'),''), char(10)) AS text
        FROM (SELECT body FROM artifacts WHERE bot_id=? ORDER BY rowid) GROUP BY cid),
      ranked AS (SELECT c.id, c.rowid AS ordinal, json_extract(c.body,'$.createdAt') AS created,
        max(json_extract(c.body,'$.updatedAt'), coalesce(work.updated, json_extract(c.body,'$.updatedAt'))) AS updated,
        coalesce(json_extract(c.body,'$.title'),'') || char(10) ||
          coalesce((SELECT group_concat(value,char(10)) || char(10) FROM json_each(c.body,'$.aliases')),'') ||
          coalesce(json_extract(c.body,'$.object'),'') || char(10) || coalesce(json_extract(c.body,'$.goal'),'') || char(10) ||
          coalesce(json_extract(c.body,'$.summary'),'') || coalesce(char(10) || work.text,'') || coalesce(char(10) || files.text,'') AS text
      FROM cases c LEFT JOIN work ON work.cid=c.id LEFT JOIN files ON files.cid=c.id WHERE c.bot_id=?)
      SELECT id, text, updated, created, ordinal FROM ranked`).all(botId, botId, botId) as { id: string; text: string; updated: number; created: number; ordinal: number }[]
    return rows.map(row => ({ ...row, score: relevance(query, row.text) })).filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || b.updated - a.updated || b.created - a.created || a.ordinal - b.ordinal)
      .slice(0, 30).slice(offset, offset + 5).flatMap(row => { const c = this.case(row.id); return c?.botId === botId ? [c] : [] })
  }
  updateCase(botId: string, caseId: string, patch?: RuntimeCaseUpdate): RuntimeCase {
    const dossier = this.case(caseId)
    if (!dossier || dossier.botId !== botId) throw new Error('卷宗归属不匹配')
    const revision = dossier.revision ?? 1
    if (patch && patch.expectedRevision !== revision) throw new Error('卷宗版本已变化，请重新核对')
    const text = (value: string | undefined, fallback: string, max: number) => {
      if (value === undefined) return fallback
      if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error('卷宗名称或范围长度无效')
      return value.trim()
    }
    const title = text(patch?.title, dossier.title, 100); const goal = text(patch?.goal, dossier.goal, 1000)
    const changed = title !== dossier.title || goal !== dossier.goal
    const aliases = [...new Set([...(dossier.aliases ?? []), ...(title !== dossier.title ? [dossier.title] : [])])].filter(name => name !== title)
    const updated = { ...dossier, title, goal, aliases, revision: revision + Number(changed), updatedAt: Date.now() }
    this.saveCase(updated); return updated
  }
  tasks(botId?: string): RuntimeTask[] { return this.all('tasks', botId) }
  task(taskId: string): RuntimeTask | undefined { return this.get('tasks', taskId) }
  updateTask(taskId: string, patch: Partial<Pick<RuntimeTask, 'state' | 'summary' | 'error' | 'question' | 'latestRunId' | 'mandate' | 'resumeIntent' | 'followup' | 'sessionOrigin' | 'sessionReason' | 'revision' | 'directoryContinuation' | 'executionGuidance' | 'review' | 'delivery' | 'automationOccurrenceId'>>): RuntimeTask {
    const task = this.task(taskId); if (!task) throw new Error('工单不存在')
    const now = Date.now()
    const next = { ...task, ...patch, ...(patch.summary !== undefined ? { summaryUpdatedAt: now } : {}), updatedAt: now }
    // 任务结束或停下后，不阻塞的提问不再提醒。
    if (['completed', 'stopped', 'failed', 'recovering'].includes(next.state)) next.followup = undefined
    this.put('tasks', next); return next
  }
  /** 主人任何一条回复到达：不阻塞提问的跟进清零。 */
  clearFollowups(botId: string): void { for (const task of this.tasks(botId)) if (task.followup) this.updateTask(task.id, { followup: undefined }) }
  private attachmentSources(input: RuntimeInbox, ids: string[] = []): RuntimeInbox[] {
    if (ids.length > 4) throw new Error('最多引用 4 条附件来源消息')
    const order = new Map(this.all<RuntimeInbox>('inbox', input.botId).map((m, index) => [m.id, index]))
    return [...new Set(ids)].map(sourceId => {
      const source = this.inbox(sourceId)
      if (!source || source.botId !== input.botId || source.groupId !== input.groupId || source.senderId !== input.senderId || (order.get(source.id) ?? Infinity) > order.get(input.id)! || source.state === 'failed' || !source.attachments?.length) throw new Error('附件来源不存在或消息归属不匹配')
      return source
    })
  }
  requireBatch(inputId: string, inputIds: string[] = [inputId]): RuntimeInbox[] {
    const anchor = this.requireInbox(inputId, true)
    if (!inputIds.length || inputIds.length > 12 || new Set(inputIds).size !== inputIds.length || inputIds.at(-1) !== inputId) throw new Error('批次需要 1～12 条消息，并以最后一条为锚点')
    const batch = inputIds.map(id => this.requireInbox(id, true))
    const order = new Map(this.all<RuntimeInbox>('inbox', anchor.botId).map((m, index) => [m.id, index]))
    if (batch.some((m, i) => m.botId !== anchor.botId || m.groupId !== anchor.groupId || m.senderId !== anchor.senderId || m.memberId !== anchor.memberId || i > 0 && order.get(m.id)! <= order.get(batch[i - 1].id)!)) throw new Error('批次消息归属或顺序不匹配')
    return batch
  }
  routerBubbles(p: Omit<RuntimeReply, 'id' | 'createdAt' | 'state' | 'text'>, replies: string[]): void {
    const format = validateRouterReply(replies)
    const texts = replies.map(t => t.trim())
    for (const [index, text] of texts.entries()) this.reply({ ...p, ...(index ? { artifactIds: undefined } : {}), text, format, key: index ? `${p.key}:${index}` : p.key, replyGroupId: p.key, bubbleIndex: index })
  }
  acceptWork(p: { inputId: string; inputIds?: string[]; caseId?: string; caseUpdate?: RuntimeCaseUpdate; caseDecision?: RuntimeCaseDecision; newCase?: { title: string; object: string; goal: string }; goal: string; acceptance: string[]; mandate: RuntimeMandate; replyText?: string; replies?: string[]; sourceInputIds?: string[]; delivery?: RuntimeTask['delivery']; executionGuidance?: string }): RuntimeTask {
    return this.transaction(() => {
      const batch = this.requireBatch(p.inputId, p.inputIds); const input = batch.at(-1)!
      if (input.senderId !== p.mandate.ownerPhoneId) throw new Error('原消息与授权 owner 不一致')
      const attachmentInputIds = [...new Set([...this.attachmentSources(input, p.sourceInputIds), ...batch.filter(m => m.attachments?.length)].map(source => source.id))]
      if (Boolean(p.caseId) === Boolean(p.newCase)) throw new Error('已有卷宗和新卷宗必须二选一')
      let dossier = p.caseId ? this.case(p.caseId) : undefined
      if (p.caseId && (!dossier || dossier.botId !== input.botId)) throw new Error('卷宗归属不匹配')
      if (dossier) dossier = this.updateCase(input.botId, dossier.id, p.caseUpdate)
      else if (p.caseUpdate) throw new Error('新卷宗不能更新已有卷宗')
      if (!dossier) {
        dossier = { ...p.newCase!, id: id('case'), botId: input.botId, summary: '', revision: 1, aliases: [], createdAt: Date.now(), updatedAt: Date.now() }
        this.saveCase(dossier)
      }
      const task: RuntimeTask = { id: id('task'), botId: input.botId, caseId: dossier.id, originInputId: input.id, groupId: input.groupId, requesterMemberId: input.memberId, goal: p.goal, acceptance: p.acceptance, mandate: structuredClone(p.mandate), state: 'queued', revision: 1, summary: '', createdAt: Date.now(), updatedAt: Date.now() }
      task.originInputIds = batch.map(m => m.id)
      task.attachmentInputIds = attachmentInputIds
      task.delivery = p.delivery
      task.executionGuidance = p.executionGuidance
      task.caseDecision = p.caseDecision
      this.put('tasks', task)
      this.routerBubbles({ botId: input.botId, groupId: input.groupId, inputId: input.id, taskId: task.id, taskRevision: task.revision, author: 'router', purpose: 'ack', key: `${input.id}:router`, policyRevision: p.mandate.policyRevision }, p.replies ?? [p.replyText!])
      for (const m of batch) this.markInput(m.id, 'routed', { action: 'start', taskId: task.id, inputIds: batch.map(m => m.id) })
      return task
    })
  }
  acceptAutomationWork(p: { occurrenceId: string; caseId?: string; caseUpdate?: RuntimeCaseUpdate; caseDecision?: RuntimeCaseDecision; newCase?: { title: string; object: string; goal: string }; goal: string; acceptance: string[]; mandate: RuntimeMandate; replies: string[]; delivery?: RuntimeTask['delivery']; executionGuidance?: string }): RuntimeTask {
    return this.transaction(() => {
      const occurrence = this.automations.occurrence(p.occurrenceId)
      if (!occurrence || occurrence.state !== 'routing' || !this.automations.current(occurrence)) throw new Error('事件触发已消费或状态失效')
      const job = this.automations.get(occurrence.botId, occurrence.jobId); const source = job.source
      if (occurrence.diagnostic) throw new Error('监测异常只能通知，不能代替用户派工')
      if (p.mandate.ownerPhoneId !== source.ownerId || p.mandate.policyRevision !== source.mandate.policyRevision || p.mandate.directory !== source.mandate.directory || p.mandate.allowedOps.some(op => !source.mandate.allowedOps.includes(op))) throw new Error('事件工单不能扩大源委托授权权限')
      const inputs = source.inputIds.map(id => this.requireInbox(id))
      if (inputs.some(m => m.revokedAt || m.botId !== job.botId || m.groupId !== source.groupId || m.senderId !== source.ownerId)) throw new Error('事件原委托已失效')
      if (Boolean(p.caseId) === Boolean(p.newCase)) throw new Error('已有卷宗和新卷宗必须二选一')
      let dossier = p.caseId ? this.case(p.caseId) : undefined
      if (p.caseId && (!dossier || dossier.botId !== job.botId)) throw new Error('卷宗归属不匹配')
      if (dossier) dossier = this.updateCase(job.botId, dossier.id, p.caseUpdate)
      if (!dossier) { dossier = { ...p.newCase!, id: id('case'), botId: job.botId, summary: '', revision: 1, aliases: [], createdAt: Date.now(), updatedAt: Date.now() }; this.saveCase(dossier) }
      const task: RuntimeTask = { id: id('task'), botId: job.botId, caseId: dossier.id, originInputId: source.inputIds.at(-1)!, originInputIds: source.inputIds,
        automationOccurrenceId: occurrence.id, attachmentInputIds: inputs.filter(m => m.attachments?.length).map(m => m.id), groupId: job.groupId, requesterMemberId: source.memberId, goal: p.goal, acceptance: p.acceptance,
        mandate: structuredClone(p.mandate), state: 'queued', revision: 1, summary: '', createdAt: Date.now(), updatedAt: Date.now(), delivery: p.delivery, executionGuidance: p.executionGuidance, caseDecision: p.caseDecision }
      this.put('tasks', task)
      this.automations.transition(occurrence.id, 'working', Date.now(), { taskId: task.id })
      if (!job.source.caseId) this.automations.saveJob({ ...job, source: { ...job.source, caseId: dossier.id } })
      this.routerBubbles({ botId: job.botId, groupId: job.groupId, taskId: task.id, taskRevision: task.revision, automationOccurrenceId: occurrence.id, author: 'router', purpose: 'ack', key: `${occurrence.id}:router`, policyRevision: p.mandate.policyRevision }, p.replies)
      return task
    })
  }
  acceptInput(p: { inputId: string; inputIds?: string[]; taskId: string; expectedRevision: number; kind: RuntimeTaskInput['kind']; replyText?: string; replies?: string[]; sourceInputIds?: string[]; delivery?: RuntimeTask['delivery']; executionGuidance?: string }): RuntimeTaskInput {
    return this.transaction(() => {
      const batch = this.requireBatch(p.inputId, p.inputIds); const input = batch.at(-1)!; const task = this.task(p.taskId)
      if (!task || task.botId !== input.botId || task.groupId !== input.groupId || task.mandate.ownerPhoneId !== input.senderId) throw new Error('工单与消息归属不匹配')
      if (!['queued', 'running', 'waiting_user'].includes(task.state)) throw new Error('工单状态已改变，请重新判断或建后续工单')
      if (task.revision !== p.expectedRevision) throw new Error('工单版本已改变，请重新读取')
      const revision = task.revision + 1
      const attachments = [...batch.flatMap(m => m.attachments ?? []), ...this.attachmentSources(input, p.sourceInputIds).flatMap(source => source.attachments ?? [])].filter((a, i, all) => all.findIndex(b => b.id === a.id) === i)
      const addition: RuntimeTaskInput = { id: id('input'), botId: task.botId, taskId: task.id, inboxId: input.id, inboxIds: batch.map(m => m.id), kind: p.kind, executionGuidance: p.executionGuidance, text: batch.map(m => m.text).join('\n'), ...(attachments.length ? { attachments } : {}), revision, delivery: 'pending', createdAt: Date.now() }
      this.put('task_inputs', addition)
      this.put('tasks', { ...task, revision, ...(p.delivery === 'files' ? { delivery: 'files' } : {}), ...(p.kind === 'answer' ? { state: task.state === 'waiting_user' ? 'queued' : task.state, question: undefined, followup: undefined } : {}), updatedAt: Date.now() })
      this.routerBubbles({ botId: input.botId, groupId: input.groupId, inputId: input.id, taskId: task.id, taskRevision: revision, author: 'router', purpose: 'ack', key: `${input.id}:router`, policyRevision: task.mandate.policyRevision }, p.replies ?? [p.replyText!])
      for (const m of batch) this.markInput(m.id, 'routed', { action: p.kind, taskId: task.id, inputIds: batch.map(m => m.id) })
      return addition
    })
  }
  inputs(taskId: string, limit?: number): RuntimeTaskInput[] { return this.queryRows('task_inputs', undefined, { taskId, limit }) }
  /** 目录确认本身也是当前需求补充；不提前消费聊天批次，待 Router 正常提交。 */
  recordDirectoryConfirmation(task: RuntimeTask, inputIds: string[]): void {
    if (!inputIds.length) return
    const batch = inputIds.map(id => this.requireInbox(id))
    if (batch.some(m => m.botId !== task.botId || m.groupId !== task.groupId || m.senderId !== task.mandate.ownerPhoneId || m.revokedAt)) throw new Error('目录确认原话归属已失效')
    const inboxId = batch.at(-1)!.id
    if (this.inputs(task.id).some(i => i.inboxId === inboxId)) return
    this.put('task_inputs', { id: id('input'), botId: task.botId, taskId: task.id, inboxId, inboxIds: inputIds, kind: 'correction', text: batch.map(m => m.text).join('\n'), attachments: batch.flatMap(m => m.attachments ?? []), revision: task.revision, delivery: 'pending', createdAt: Date.now() } satisfies RuntimeTaskInput)
  }
  input(inputId: string): RuntimeTaskInput | undefined { return this.get('task_inputs', inputId) }
  delivered(inputId: string, delivery: RuntimeTaskInput['delivery']): void {
    const input = this.input(inputId); if (!input) throw new Error('补充不存在'); this.put('task_inputs', { ...input, delivery })
  }
  consumeInput(inputId: string, taskId: string): void {
    const input = this.input(inputId); if (!input || input.taskId !== taskId) throw new Error('输入归属不匹配')
    this.put('task_inputs', { ...input, consumedAt: input.consumedAt ?? Date.now() })
  }
  resolveInput(inputId: string, taskId: string, resolution: string): void {
    const input = this.input(inputId); if (!input || input.taskId !== taskId || !input.consumedAt) throw new Error('请先确认读取本任务输入')
    if (!resolution.trim()) throw new Error('处理结论不能为空')
    this.put('task_inputs', { ...input, resolution })
  }
  finishTask(taskId: string, revision: number, text: string, artifactIds: string[], runId?: string, summaries?: RuntimeArtifactSummaryInput[], checks?: string[]): RuntimeTask {
    return this.transaction(() => {
      const task = this.task(taskId); if (!task || task.state !== 'running') throw new Error('工单不处于执行状态')
      if (task.revision !== revision) throw new Error('需求版本已变化，请先处理新输入')
      if (this.inputs(taskId).some(i => !i.consumedAt || !i.resolution)) throw new Error('仍有未处理输入，不能宣称完成')
      if (this.operations(taskId).some(o => ['running', 'pending_approval', 'approved', 'unknown'].includes(o.state))) throw new Error('仍有未结束或状态未知的工具操作')
      for (const artifactId of artifactIds) if (this.artifact(artifactId)?.taskId !== taskId) throw new Error('成果归属不匹配')
      if (artifactIds.length > 4) throw new Error('一次交付最多 4 个附件，请整理交付成果')
      if (task.delivery === 'files' && !artifactIds.length) throw new Error('本任务要求文件交付，必须导出并附上实际附件，不能只说写好了')
      if (!artifactIds.length && this.artifacts(task.botId).some(a => a.taskId === task.id)) throw new Error('已生成交付附件，必须在 artifactIds 中引用，不能只说写好了')
      const artifactSummaries = this.bindArtifactSummaries(taskId, artifactIds, summaries)
      this.reply({ botId: task.botId, groupId: task.groupId, inputId: task.originInputId, taskId, taskRevision: revision, runId, author: 'worker', purpose: 'result', text, artifactIds, artifactSummaries, checks, key: `${task.id}:result:${revision}`, policyRevision: task.mandate.policyRevision })
      return this.updateTask(taskId, { state: 'completed', summary: text, question: undefined, review: { state: 'pending', rounds: task.review?.rounds ?? 0 } })
    })
  }
  private bindArtifactSummaries(taskId: string, artifactIds: string[], summaries?: RuntimeArtifactSummaryInput[]) {
    // Legacy in-process callers may omit summaries. New Worker tool submissions always provide this array.
    if (summaries === undefined) return undefined
    if (!Array.isArray(summaries) || summaries.length !== artifactIds.length || new Set(artifactIds).size !== artifactIds.length) throw new Error('每个交付附件必须有且只有一份摘要')
    const text = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max
    const list = (v: unknown) => Array.isArray(v) && v.length <= 12 && v.every(s => text(s, 400))
    if (JSON.stringify(summaries).length > 8000) throw new Error('文件摘要合计最多8000字符，请精炼内容')
    const seen = new Set<string>()
    return summaries.map(s => {
      const artifact = this.artifact(s.artifactId)
      if (!artifact || artifact.taskId !== taskId || !artifactIds.includes(s.artifactId) || seen.has(s.artifactId) || !text(s.summary, 1200) || !list(s.requirements) || !list(s.checks) || !list(s.limitations)) throw new Error('文件摘要内容或关联无效')
      seen.add(s.artifactId)
      return { artifactId: s.artifactId, summary: s.summary.trim(), requirements: s.requirements, checks: s.checks, limitations: s.limitations, hash: artifact.hash, revision: artifact.revision }
    })
  }
  reviseWorkerResult(botId: string, replyId: string, taskId: string, expectedRevision: number, feedback: string, executionGuidance?: string, delivery?: RuntimeTask['delivery']): RuntimeTaskInput {
    return this.transaction(() => {
      const source = this.get<RuntimeReply>('outbox', replyId); const task = this.task(taskId)
      if (!source || source.botId !== botId || source.taskId !== taskId || source.author !== 'worker' || source.purpose !== 'result' || source.state !== 'pending' || source.attemptedAt !== undefined || !task || task.botId !== botId || task.state !== 'completed' || task.revision !== expectedRevision || source.taskRevision !== task.revision) throw new Error('只能返工当前待验收的Worker结果')
      if ((task.review?.rounds ?? 0) >= 3) throw new Error('已达三轮返工上限，请向用户说明尚未解决的问题，不能继续自动返工')
      if (!feedback.trim() || feedback.length > 2000) throw new Error('请提供明确、有限的返工意见')
      const revision = task.revision + 1
      const input: RuntimeTaskInput = { id: id('input'), botId, taskId, inboxId: `review:${source.id}`, kind: 'correction', text: feedback.trim(), executionGuidance, revision, delivery: 'pending', createdAt: Date.now() }
      this.put('task_inputs', input)
      this.cancelReplies(botId, taskId)
      this.updateTask(taskId, { state: 'queued', revision, error: undefined, ...(delivery === 'files' ? { delivery: 'files' } : {}), review: { state: 'changes_requested', rounds: (task.review?.rounds ?? 0) + 1, feedback: feedback.trim() } })
      return input
    })
  }
  chatHistory(botId: string, options: Parameters<typeof queryChatHistory>[2]) { return queryChatHistory(this.db, botId, options) }
  chatMessage(botId: string, options: Parameters<typeof readChatMessage>[2]) { return readChatMessage(this.db, botId, options) }
  saveRun(run: RuntimeRun): void { this.put('runs', run) }
  run(runId: string): RuntimeRun | undefined { return this.get('runs', runId) }
  runs(botId?: string): RuntimeRun[] { return this.all('runs', botId) }
  operation(operationId: string): RuntimeOperation | undefined { return this.get('tool_operations', operationId) }
  operations(taskId?: string): RuntimeOperation[] { return this.all<RuntimeOperation>('tool_operations').filter(o => !taskId || o.taskId === taskId) }
  saveOperation(operation: RuntimeOperation): void { this.put('tool_operations', operation) }
  reply(p: Omit<RuntimeReply, 'id' | 'createdAt' | 'state'>): RuntimeReply {
    const occurrenceId = p.taskId ? this.task(p.taskId)?.automationOccurrenceId : undefined
    if (occurrenceId) p = { ...p, automationOccurrenceId: occurrenceId }
    let text: string
    if (p.author === 'worker') text = validateWorkerText(p.text)
    else {
      const source = p.sourceReplyId ? this.get<RuntimeReply>('outbox', p.sourceReplyId) : undefined
      const worker = !!source && source.botId === p.botId && source.author === 'worker' && source.state === 'pending'
      const format = validateRouterReply([p.text], { worker, files: worker && !!source.artifactIds?.length })
      p = { ...p, format }; text = p.text.trim()
    }
    const row = this.db.query("SELECT body FROM outbox WHERE bot_id=? AND json_extract(body,'$.key')=?").get(p.botId, p.key) as { body: string } | null
    if (row) return JSON.parse(row.body)
    const reply: RuntimeReply = { ...p, text, id: id('reply'), createdAt: Date.now(), state: 'pending' }
    this.put('outbox', reply); return reply
  }
  replies(botId: string): RuntimeReply[] { return this.all('outbox', botId) }
  sentReplies(botId: string): RuntimeReply[] {
    return this.replies(botId).filter(r => r.state === 'sent').sort((a, b) =>
      a.sentOrder !== undefined && b.sentOrder !== undefined ? a.sentOrder - b.sentOrder
        : (a.sentAt ?? a.createdAt) - (b.sentAt ?? b.createdAt))
  }
  pendingReplies(botId: string): RuntimeReply[] { return this.replies(botId).filter(r => r.state === 'pending') }
  presentWorkerReply(botId: string, replyId: string, texts: string[], basis: string, mixed?: { indexes: number[]; user: Omit<RuntimeReply, 'id' | 'createdAt' | 'state' | 'text'> }): void {
    this.transaction(() => {
      const source = this.get<RuntimeReply>('outbox', replyId)
      if (!source || source.botId !== botId || source.author !== 'worker' || source.state !== 'pending' || source.attemptedAt !== undefined) throw new Error('Worker结果已处理或归属不匹配')
      const indexes = mixed?.indexes ?? texts.map((_, i) => i)
      if (texts.length > 3 || indexes.some(i => !Number.isInteger(i) || i < 0 || i >= texts.length) || new Set(indexes).size !== indexes.length) throw new Error('气泡索引无效')
      const format = validateRouterReply(texts, { worker: indexes.length > 0, files: indexes.length > 0 && !!source.artifactIds?.length })
      const validated = texts.map(t => t.trim())
      if (!indexes.length && source.purpose === 'question' && !source.followupReminder) throw new Error('必要问题不能被前台静默丢弃')
      if (!indexes.length && source.artifactIds?.length) throw new Error('文件交付必须保留附件，不能静默丢弃')
      if (!indexes.length && !basis.trim()) throw new Error('省略Worker结果需要说明依据')
      const { id: _id, createdAt: _created, state: _state, text: _text, routingAttempts: _attempts, nextRoutingAt: _next, routingError: _error, ...metadata } = source
      const group = `${source.id}:router`
      for (const [i, text] of validated.entries()) {
        const belongsToWorker = indexes.includes(i)
        this.reply({ ...(belongsToWorker ? { ...metadata, sourceReplyId: source.id, artifactIds: i === Math.min(...indexes) ? source.artifactIds : undefined } : mixed!.user),
          author: 'router', format, key: i ? `${group}:${i}` : group, replyGroupId: group, bubbleIndex: i, text })
      }
      if (source.purpose === 'result' && source.taskId) {
        const task = this.task(source.taskId)
        if (!task || task.state !== 'completed' || source.taskRevision !== task.revision) throw new Error('Worker交付版本已失效')
        this.updateTask(task.id, { review: { state: 'approved', rounds: task.review?.rounds ?? 0 } })
      }
      this.put('outbox', { ...source, state: 'routed', routingBasis: basis.slice(0, 1000), routingError: undefined, nextRoutingAt: undefined })
    })
  }
  deferWorkerReply(replyId: string, error: string): void {
    const source = this.get<RuntimeReply>('outbox', replyId)
    if (!source || source.author !== 'worker' || source.state !== 'pending') return
    const attempts = (source.routingAttempts ?? 0) + 1
    this.put('outbox', { ...source, routingAttempts: attempts, routingError: error, nextRoutingAt: attempts >= 3 ? Number.MAX_SAFE_INTEGER : Date.now() + 5000 * attempts })
  }
  retryWorkerReplies(botId: string): void {
    for (const source of this.pendingReplies(botId).filter(r => r.author === 'worker' && r.routingError)) this.put('outbox', { ...source, routingAttempts: 0, nextRoutingAt: undefined, routingError: undefined })
  }
  markReplyAttempted(replyId: string): void { const r = this.get<RuntimeReply>('outbox', replyId); if (r?.state === 'pending') this.put('outbox', { ...r, attemptedAt: r.attemptedAt ?? Date.now() }) }
  markReplySent(replyId: string): void {
    this.transaction(() => {
      const r = this.get<RuntimeReply>('outbox', replyId)
      if (!r || r.state === 'sent') return
      const sent = this.sentReplies(r.botId)
      const sentOrder = sent.reduce((max, reply) => Math.max(max, reply.sentOrder ?? 0), sent.length) + 1
      this.put('outbox', { ...r, state: 'sent', sentAt: Date.now(), sentOrder })
    })
  }
  cancelReply(replyId: string, cancelReason: string, supersededBy?: string): void {
    const r = this.get<RuntimeReply>('outbox', replyId)
    if (r?.state === 'pending') this.put('outbox', { ...r, state: 'cancelled', cancelReason, ...(supersededBy ? { supersededBy } : {}) })
  }
  cancelReplies(botId: string, taskId?: string): void { for (const r of this.pendingReplies(botId)) if (!taskId || r.taskId === taskId) this.put('outbox', { ...r, state: 'cancelled' }) }
  saveArtifact(artifact: RuntimeArtifact): void { this.put('artifacts', artifact) }
  artifact(artifactId: string): RuntimeArtifact | undefined { return this.get('artifacts', artifactId) }
  artifacts(botId: string): RuntimeArtifact[] { return this.all('artifacts', botId) }
  saveUpload(upload: RuntimeUpload): void { this.put('uploads', upload) }
  upload(uploadId: string): RuntimeUpload | undefined { return this.get('uploads', uploadId) }
  uploads(botId: string): RuntimeUpload[] { return this.all('uploads', botId) }
  viewMemories(botId: string): { active: RuntimeMemory[]; review: RuntimeMemory[] } {
    const active = this.db.query("SELECT body FROM memories WHERE bot_id=? AND json_extract(body,'$.status')='active' ORDER BY rowid DESC LIMIT 50").all(botId) as { body: string }[]
    const review = this.db.query("SELECT body FROM memories WHERE bot_id=? AND json_extract(body,'$.status')='active' AND json_extract(body,'$.needsReview')=1 ORDER BY rowid").all(botId) as { body: string }[]
    return { active: active.reverse().map(row => JSON.parse(row.body)), review: review.map(row => JSON.parse(row.body)) }
  }
  recentExperiences(botId: string): RuntimeExperience[] { return this.queryRows('experiences', botId, { limit: 50 }) }
  memories(botId: string): RuntimeMemory[] { return this.all('memories', botId) }
  memory(memoryId: string): RuntimeMemory | undefined { return this.get('memories', memoryId) }
  saveMemory(memory: RuntimeMemory): void { this.put('memories', memory) }
  memoriesBySource(botId: string, inboxId: string): RuntimeMemory[] { return this.memories(botId).filter(m => m.source.inboxId === inboxId) }
  /** 被相关度命中的记忆记一次触发；这是升降和「30 天没用到」的依据。 */
  triggerMemories(ids: string[], now: number): void {
    for (const id of new Set(ids)) { const memory = this.memory(id); if (memory && memory.status === 'active') this.saveMemory({ ...memory, triggers: { count: memory.triggers.count + 1, lastTriggeredAt: now }, updatedAt: now }) }
  }
  /** 流水只增不改：同一编号写第二次直接报错。 */
  saveRemoteOp(op: RuntimeRemoteOp): void { this.put('remote_ops', op) }
  remoteOps(botId: string, limit = 40): RuntimeRemoteOp[] {
    const rows = this.db.query('SELECT body FROM remote_ops WHERE bot_id=? ORDER BY rowid DESC LIMIT ?').all(botId, Math.max(1, Math.floor(limit))) as Array<{ body: string }>
    return rows.map(r => JSON.parse(r.body) as RuntimeRemoteOp).reverse()
  }
  /** 启动恢复:进行中的远程命令结果未知。botId 缺省 = 全部。 */
  markRemoteOpsUnknown(botId: string, note: string): void {
    const rows = botId === '__all__'
      ? this.db.query("SELECT body FROM remote_ops WHERE json_extract(body,'$.state')='running'").all() as Array<{ body: string }>
      : this.db.query("SELECT body FROM remote_ops WHERE bot_id=? AND json_extract(body,'$.state')='running'").all(botId) as Array<{ body: string }>
    for (const row of rows) {
      const op0 = JSON.parse(row.body) as RuntimeRemoteOp
      this.put('remote_ops', { ...op0, state: 'unknown', error: note, finishedAt: Date.now() })
    }
  }

  appendMemoryLog(log: RuntimeMemoryLog): void { this.db.query('INSERT INTO memory_log(id,bot_id,body) VALUES(?,?,?)').run(log.id, log.botId, JSON.stringify(log)) }
  applyMemoryOps(ops: RuntimeMemory[], logs: RuntimeMemoryLog[]): void { this.transaction(() => { for (const op of ops) this.saveMemory(op); for (const log of logs) this.appendMemoryLog(log) }) }
  memoryLog(botId: string, limit = 30): RuntimeMemoryLog[] {
    const rows = this.db.query('SELECT body FROM memory_log WHERE bot_id=? ORDER BY rowid DESC LIMIT ?').all(botId, Math.max(1, Math.floor(limit))) as Array<{ body: string }>
    return rows.reverse().map(row => JSON.parse(row.body) as RuntimeMemoryLog)
  }
  experiences(botId: string): RuntimeExperience[] { return this.all('experiences', botId) }
  experience(experienceId: string): RuntimeExperience | undefined { return this.get('experiences', experienceId) }
  saveExperience(experience: RuntimeExperience): void { this.put('experiences', experience) }
  /** 进过摘要或被前台读过都算用过一次；用满次数才常驻。 */
  useExperiences(ids: string[], now: number): void {
    for (const id of new Set(ids)) { const experience = this.experience(id); if (experience && experience.state === 'active') this.saveExperience({ ...experience, uses: experience.uses + 1, lastUsedAt: now, updatedAt: now }) }
  }
  /** 控制请求记账避免双击/重连重复执行。 */
  hasControl(botId: string, requestId: string): boolean { return this.get('controls', `${botId}:${requestId}`) !== undefined }
  control<T>(botId: string, requestId: string, fn: () => T): T {
    return this.transaction(() => {
      const key = `${botId}:${requestId}`
      const previous = this.get<{ result: T }>('controls', key)
      if (previous) return previous.result
      const result = fn(); this.put('controls', { id: key, botId, result }); return result
    })
  }
}
