import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { experienceTokens } from './experience-library'
import { MEMORY_WRITE_SCHEMA, MID_TTL_MS, memorySummary, memoryText, memoryVersion, sameScope, scopeMatches, type MemoryAudience, type MemoryChange } from './memory'
import type { MemoryLogAction, MemoryScope, RuntimeInbox, RuntimeMemory, RuntimeMemoryLog } from './types'

export const memoryHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface MemoryAuthority extends MemoryAudience { actor: 'router' | 'memory'; batch: RuntimeInbox[] }
export interface MemoryReceipt { items: Array<{ id: string; version: number; action: string }>; revision: string }
const tokens = (text: string) => experienceTokens(text).join(' ')
const scopesOverlap = (a: MemoryScope = {}, b: MemoryScope = {}) => (['project', 'caseId', 'taskId'] as const).every(k => a[k] === undefined || b[k] === undefined || a[k] === b[k])

/** One transaction boundary for Router, background extraction and owner controls. */
export class MemoryLibrary {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_receipts (bot_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bot_id,request_id));
      CREATE TABLE IF NOT EXISTS memory_phase_ends (bot_id TEXT NOT NULL, channel TEXT NOT NULL, sender_id TEXT NOT NULL, kind TEXT NOT NULL, phase_id TEXT NOT NULL, through_seq INTEGER NOT NULL, PRIMARY KEY(bot_id,channel,sender_id,kind,phase_id));
      CREATE TABLE IF NOT EXISTS memory_events (bot_id TEXT NOT NULL, event_key TEXT NOT NULL, PRIMARY KEY(bot_id,event_key));
      CREATE TABLE IF NOT EXISTS memory_tombstones (bot_id TEXT NOT NULL, source_key TEXT NOT NULL, PRIMARY KEY(bot_id,source_key));
      CREATE TABLE IF NOT EXISTS memory_embeddings (memory_id TEXT NOT NULL, provider TEXT NOT NULL, digest TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(memory_id,provider));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,bot_id UNINDEXED,content,tokenize='unicode61');`)
    this.db.transaction(() => {
      // Conservative migration: old records are searchable, never guessed to be global core rules.
      for (const m of this.rows<RuntimeMemory>('SELECT body FROM memories')) {
        if (!m.prompt || !m.source) continue
        if (!m.version) this.db.query('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify({ ...m, version: 1, needsReview: true }), m.id)
        this.index(m)
      }
      const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version < 6) this.db.exec('PRAGMA user_version=6')
    })()
  }
  private rows<T>(sql: string, ...params: (string | number)[]): T[] {
    return (this.db.query(sql).all(...params) as { body: string }[]).map(r => JSON.parse(r.body))
  }
  private get(id: string): RuntimeMemory | undefined { return this.rows<RuntimeMemory>('SELECT body FROM memories WHERE id=?', id)[0] }
  all(a: MemoryAudience): RuntimeMemory[] {
    return this.rows<RuntimeMemory>('SELECT body FROM memories WHERE bot_id=? ORDER BY rowid', a.botId).filter(m => m.channel === a.channel && m.senderId === a.senderId)
  }
  revision(a: MemoryAudience): string { return memoryHash([this.all(a).map(m => [m.id, memoryVersion(m), m.status]), this.db.query('SELECT kind,phase_id,through_seq FROM memory_phase_ends WHERE bot_id=? AND channel=? AND sender_id=? ORDER BY kind,phase_id').all(a.botId, a.channel, a.senderId)]) }
  private phaseClosed(a: MemoryAudience, end: RuntimeMemory['end'], seq: number): boolean {
    return !!end && !!this.db.query('SELECT 1 FROM memory_phase_ends WHERE bot_id=? AND channel=? AND sender_id=? AND kind=? AND phase_id=? AND through_seq>=?').get(a.botId, a.channel, a.senderId, end.kind, end.id, seq)
  }
  private ended(m: RuntimeMemory): boolean {
    if (!m.end) return false
    const table = m.end.kind === 'task' ? 'tasks' : 'cases'
    const item = this.rows<{ state: string; review?: { state: string } }>(`SELECT body FROM ${table} WHERE id=? AND bot_id=?`, m.end.id, m.botId)[0]
    // Missing/unknown state is not evidence that a phase has ended.
    return !!item && (m.end.kind === 'task' ? item.state === 'completed' && item.review?.state === 'approved' : ['closed','archived'].includes(item.state))
  }
  alive(m: RuntimeMemory, now: number): boolean { return m.status === 'active' && (m.startsAt ?? -Infinity) <= now && (m.expiresAt ?? Infinity) > now && !this.ended(m) }
  candidates(a: MemoryAudience, now = Date.now()): RuntimeMemory[] { return this.all(a).filter(m => ['active','suppressed'].includes(m.status) && (m.expiresAt ?? Infinity) > now && !this.ended(m)) }
  effective(a: MemoryAudience, now = Date.now()): RuntimeMemory[] {
    const candidates = this.all(a).filter(m => this.alive(m, now) && scopeMatches(m.scope, a))
    // A semantic situation cannot be evaluated by IDs. Keep its explicit relation for Router.
    const hidden = new Set(candidates.filter(m => !m.appliesTo).flatMap(m => m.overrides ?? []))
    return candidates.filter(m => !hidden.has(m.id))
  }
  private index(m: RuntimeMemory): void {
    this.db.query('DELETE FROM memory_fts WHERE id=?').run(m.id)
    if (m.prompt) this.db.query('INSERT INTO memory_fts(id,bot_id,content) VALUES(?,?,?)').run(m.id, m.botId, tokens(memoryText(m)))
  }
  /** Also used by legacy store helpers; all indexing follows the authoritative record. */
  indexRecord(m: RuntimeMemory): void { this.index(m); this.db.query('DELETE FROM memory_embeddings WHERE memory_id=?').run(m.id) }
  private persist(next: RuntimeMemory, action: MemoryLogAction, actor: RuntimeMemoryLog['actor'], now: number, before?: RuntimeMemory): void {
    const m = { ...next, version: before ? memoryVersion(before) + 1 : memoryVersion(next), updatedAt: now }
    this.db.query('INSERT INTO memories(id,bot_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(m.id, m.botId, JSON.stringify(m))
    this.indexRecord(m)
    const entry: RuntimeMemoryLog = { id: `mlog_${randomUUID()}`, botId: m.botId, memoryId: m.id, action, actor, before, after: m, at: now }
    this.db.query('INSERT INTO memory_log(id,bot_id,body) VALUES(?,?,?)').run(entry.id, m.botId, JSON.stringify(entry))
  }
  private source(change: MemoryChange, a: MemoryAuthority): RuntimeInbox {
    const candidate = a.batch.find(m => m.id === change.sourceInboxId)
    const current = candidate && this.rows<RuntimeInbox>('SELECT body FROM inbox WHERE id=?', candidate.id)[0]
    if (!current || current.revokedAt || current.botId !== a.botId || current.groupId !== a.channel || current.senderId !== a.senderId || !current.text.includes(change.quote)) throw new Error('记忆来源必须是本批身份一致且未撤回的用户原话')
    return current
  }
  private sourceKey(m: Pick<RuntimeMemory, 'channel' | 'senderId' | 'topic' | 'source'>): string { return memoryHash([m.channel, m.senderId, m.source.inboxId, m.topic]) }
  private latestSourceSeq(m: RuntimeMemory): number | undefined {
    const sources = [m.source, ...(m.extraSources ?? [])].map(s => this.rows<RuntimeInbox>('SELECT body FROM inbox WHERE id=?', s.inboxId)[0])
    if (sources.some(s => !s || s.botId !== m.botId || s.groupId !== m.channel || s.senderId !== m.senderId)) return undefined
    return Math.max(...sources.map(s => s!.seq))
  }
  private checkSourceOrder(m: RuntimeMemory, source: RuntimeInbox): void {
    const seq = this.latestSourceSeq(m)
    if (m.prompt && (seq === undefined || source.seq < seq)) throw new Error('来源先后未核实或已有较新用户要求，旧消息不能覆盖或遗忘新要求')
  }
  private require(a: MemoryAudience, id: string, version?: number): RuntimeMemory {
    const m = this.get(id)
    if (!m || m.botId !== a.botId || m.channel !== a.channel || m.senderId !== a.senderId) throw new Error('记忆不存在或不属于当前用户/Bot')
    if (version !== undefined && memoryVersion(m) !== version) throw new Error('记忆版本变化，请重新查询并检查冲突')
    return m
  }
  private validateScope(a: MemoryAudience, c: Extract<MemoryChange, { action: 'save' }>): void {
    if (c.scope?.project && c.scope.project !== a.project) throw new Error('项目范围未在当前宿主目录核实')
    for (const [kind, key] of [['task','taskId'], ['case','caseId']] as const) {
      for (const id of [c.scope?.[key], c.end?.kind === kind ? c.end.id : undefined]) {
        if (id && !this.rows(`SELECT body FROM ${kind === 'task' ? 'tasks' : 'cases'} WHERE id=? AND bot_id=?`, id, a.botId).length) throw new Error('范围或阶段编号不存在')
      }
    }
    if (c.core && (c.tier !== 'long' || c.appliesTo || Object.keys(c.scope ?? {}).length)) throw new Error('核心规则必须是整个Bot适用的长期规则')
  }
  write(raw: unknown, a: MemoryAuthority, now = Date.now()): MemoryReceipt {
    const command = MEMORY_WRITE_SCHEMA.parse(raw)
    const request = memoryHash([a.channel, a.senderId, command.requestId])
    const digest = memoryHash(command.changes)
    return this.db.transaction(() => {
      const prior = this.db.query('SELECT digest,body FROM memory_receipts WHERE bot_id=? AND request_id=?').get(a.botId, request) as { digest: string; body: string } | null
      if (prior) { if (prior.digest !== digest) throw new Error('请求编号已用于不同的记忆修改'); return JSON.parse(prior.body) as MemoryReceipt }
      if (this.revision(a) !== command.expectedRevision) throw new Error('记忆库版本变化，请重新查询并检查冲突')
      const items: MemoryReceipt['items'] = []; const touched = new Set<string>(); const created = new Set<string>()
      for (const change of command.changes) {
        const source = this.source(change, a)
        if (change.action === 'end') {
          const table = change.kind === 'task' ? 'tasks' : 'cases'
          if (!this.rows(`SELECT body FROM ${table} WHERE id=? AND bot_id=?`, change.id, a.botId).length) throw new Error('阶段编号不存在')
          this.db.query('INSERT INTO memory_phase_ends VALUES(?,?,?,?,?,?) ON CONFLICT(bot_id,channel,sender_id,kind,phase_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)').run(a.botId, a.channel, a.senderId, change.kind, change.id, source.seq)
          for (const m of this.all(a).filter(m => m.tier === 'mid' && ['active','suppressed'].includes(m.status) && m.end?.kind === change.kind && m.end.id === change.id)) {
            const latest = this.latestSourceSeq(m)
            if (latest === undefined || latest > source.seq) continue
            this.persist({ ...m, status: 'expired' }, 'expire', a.actor, now, m)
            items.push({ id: m.id, version: memoryVersion(m) + 1, action: 'end' })
          }
          continue
        }
        if (change.action !== 'save') {
          const old = this.require(a, change.id, change.expectedVersion)
          this.checkSourceOrder(old, source)
          if (touched.has(old.id)) throw new Error('同次提交不能重复修改同一记忆')
          touched.add(old.id)
          this.retire(old, change.action, a.actor, now)
          items.push({ id: old.id, version: memoryVersion(old) + 1, action: change.action }); continue
        }
        this.validateScope(a, change)
        if (this.phaseClosed(a, change.end, source.seq)) throw new Error('该阶段已经结束，不能从结束前的消息重新提炼恢复')
        const startsAt = change.startsAt ?? source.createdAt
        const expiresAt = change.expiresAt ?? (change.tier === 'mid' && !change.end ? source.createdAt + MID_TTL_MS : undefined)
        if (expiresAt !== undefined && expiresAt <= startsAt) throw new Error('结束时间必须晚于生效时间')
        const topic = change.topic.normalize('NFKC').trim().toLowerCase()
        const relevant = this.candidates(a, now).filter(m => m.topic === topic)
        const replay = relevant.find(m => m.source.inboxId === source.id && sameScope(m.scope, change.scope) && m.appliesTo === change.appliesTo && m.tier === change.tier
          && m.prompt === change.prompt && m.kind === change.kind && m.core === (change.core ?? false) && m.startsAt === startsAt && m.expiresAt === expiresAt && m.end?.kind === change.end?.kind && m.end?.id === change.end?.id)
        if (replay) { items.push({ id: replay.id, version: memoryVersion(replay), action: 'duplicate' }); continue }
        const conflicts = change.conflicts ?? []
        if (new Set(conflicts.map(c => c.memoryId)).size !== conflicts.length) throw new Error('不能重复报告同一记忆的冲突关系')
        const checked = new Map(conflicts.map(c => [c.memoryId, this.require(a, c.memoryId, c.version)]))
        if (relevant.some(m => !created.has(m.id) && !checked.has(m.id))) throw new Error(`同主题记忆尚未全部检查冲突，请memory_search查询topic=${topic}`)
        // New IDs are not available to the caller yet; prove batch rules disjoint instead of requesting them.
        if (relevant.some(m => created.has(m.id) && scopesOverlap(m.scope, change.scope)
          && Math.max(m.startsAt ?? -Infinity, startsAt) < Math.min(m.expiresAt ?? Infinity, expiresAt ?? Infinity))) throw new Error('同批同主题规则的范围与时间重叠，请拆分时间窗口或先保存后明确检查关系')
        const relationTargets = conflicts.filter(c => c.relation !== 'related')
        if (relationTargets.some(c => !this.candidates(a, now).some(m => m.id === c.memoryId))) throw new Error('不能更新失效记忆，请重新查询')
        if (relationTargets.some(c => touched.has(c.memoryId))) throw new Error('同次提交不能重复修改同一记忆')
        const duplicates = conflicts.filter(c => c.relation === 'duplicate')
        if (duplicates.length > 1 || (duplicates.length && relationTargets.length > 1)) throw new Error('重复、替代和覆盖关系不能混用')
        const duplicate = duplicates[0] && checked.get(duplicates[0].memoryId)
        if (duplicate) {
          if (duplicate.tier !== change.tier || !sameScope(duplicate.scope, change.scope) || duplicate.appliesTo !== change.appliesTo || duplicate.expiresAt !== expiresAt && change.expiresAt !== undefined
            || change.startsAt !== undefined && duplicate.startsAt !== startsAt || duplicate.end?.kind !== change.end?.kind || duplicate.end?.id !== change.end?.id) throw new Error('范围或期限改变不能作为重复记忆')
          touched.add(duplicate.id)
          if (duplicate.source.inboxId !== source.id && !duplicate.extraSources?.some(s => s.inboxId === source.id && s.quote === change.quote)) this.persist({ ...duplicate, extraSources: [...(duplicate.extraSources ?? []), { inboxId: source.id, quote: change.quote }] }, 'duplicate', a.actor, now, duplicate)
          items.push({ id: duplicate.id, version: memoryVersion(this.get(duplicate.id)!), action: 'duplicate' }); continue
        }
        const id = `memory_${randomUUID()}`
        const m: RuntimeMemory = { id, botId: a.botId, channel: a.channel, senderId: a.senderId, format: 2, version: 1, topic, kind: change.kind, core: change.core ?? false,
          tier: change.tier, prompt: change.prompt, appliesTo: change.appliesTo, scope: change.scope ?? {}, startsAt, expiresAt, end: change.end,
          source: { inboxId: source.id, quote: change.quote, context: '', sentAt: source.createdAt },
          status: 'active', triggers: { count: 0 }, recalls: 0, uses: 0, createdAt: now, updatedAt: now }
        if (this.db.query('SELECT 1 FROM memory_tombstones WHERE bot_id=? AND source_key=?').get(a.botId, this.sourceKey(m))) throw new Error('此来源的记忆已被遗忘，不能重新提炼恢复')
        for (const conflict of relationTargets) {
          const old = checked.get(conflict.memoryId)!
          this.checkSourceOrder(old, source)
          if (conflict.relation === 'supersedes') {
            if (m.tier === 'mid' && old.tier === 'long' || !sameScope(m.scope, old.scope) || m.appliesTo !== old.appliesTo || m.startsAt! > now || m.expiresAt !== undefined || m.end) throw new Error('永久替代必须同范围、已生效且无结束条件；中期不能永久取代长期；临时或局部要求用overrides')
            this.persist({ ...old, status: 'superseded', supersededBy: id }, 'supersede', a.actor, now, old); m.supersedes = old.id
            touched.add(old.id)
          } else if (conflict.relation === 'overrides') {
            if (!scopeMatches(old.scope, m.scope)) throw new Error('临时覆盖范围必须在旧规则范围以内')
            m.overrides = [...(m.overrides ?? []), old.id]
          }
        }
        this.persist(m, m.overrides?.length ? 'override' : 'create', a.actor, now)
        created.add(id)
        items.push({ id, version: 1, action: 'save' })
      }
      const receipt = { items, revision: this.revision(a) }
      this.db.query('INSERT INTO memory_receipts(bot_id,request_id,digest,body) VALUES(?,?,?,?)').run(a.botId, request, digest, JSON.stringify(receipt))
      return receipt
    })()
  }
  private retire(old: RuntimeMemory, action: 'revoke' | 'purge', actor: RuntimeMemoryLog['actor'], now: number): void {
    for (const source of [old.source, ...(old.extraSources ?? [])]) this.db.query('INSERT OR IGNORE INTO memory_tombstones(bot_id,source_key) VALUES(?,?)').run(old.botId, this.sourceKey({ ...old, source: { ...old.source, ...source } }))
    if (action === 'purge') {
      const ids = new Set([old.source.inboxId, ...(old.extraSources ?? []).map(s => s.inboxId)])
      const scrub = (m: Partial<RuntimeMemory> | undefined) => m?.source && ids.has(m.source.inboxId) ? { ...m, source: { ...m.source, context: '' } } : m
      for (const m of this.rows<RuntimeMemory>('SELECT body FROM memories WHERE bot_id=?', old.botId)) {
        if (ids.has(m.source.inboxId)) this.db.query('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(scrub(m)), m.id)
      }
      for (const entry of this.rows<RuntimeMemoryLog>('SELECT body FROM memory_log WHERE bot_id=?', old.botId)) {
        this.db.query('UPDATE memory_log SET body=? WHERE id=?').run(JSON.stringify({ ...entry, before: scrub(entry.before), after: scrub(entry.after) }), entry.id)
      }
    }
    const next: RuntimeMemory = action === 'purge' ? { id: old.id, botId: old.botId, channel: old.channel, senderId: old.senderId, tier: old.tier, format: 2, version: memoryVersion(old) + 1, status: 'revoked', prompt: '', source: { inboxId: '', quote: '', context: '', sentAt: 0 }, triggers: { count: 0 }, createdAt: old.createdAt, updatedAt: now } : { ...old, status: 'revoked' }
    if (action === 'purge') this.db.query('DELETE FROM memory_log WHERE bot_id=? AND (json_extract(body,\'$.memoryId\')=? OR instr(body,?)>0)').run(old.botId, old.id, old.id)
    this.persist(next, action, actor, now, action === 'purge' ? undefined : old)
  }
  control(a: MemoryAudience, id: string, action: 'suppress' | 'unsuppress' | 'revoke' | 'purge', now = Date.now()): void {
    if (!['suppress','unsuppress','revoke','purge'].includes(action)) throw new Error('记忆管理动作无效')
    this.db.transaction(() => {
      const old = this.require(a, id)
      if (action === 'revoke' || action === 'purge') this.retire(old, action, 'owner', now)
      else {
        if (!['active','suppressed'].includes(old.status) || (old.expiresAt ?? Infinity) <= now || this.ended(old)) throw new Error('失效记忆不能恢复，请基于新的用户原话重新保存')
        this.persist({ ...old, status: action === 'suppress' ? 'suppressed' : 'active', suppressedBy: action === 'suppress' ? a.senderId : undefined }, action, 'owner', now, old)
      }
    })()
  }
  history(a: MemoryAudience, id: string): RuntimeMemory[] {
    const current = this.require(a, id); const versions = new Map<number, RuntimeMemory>()
    for (const row of this.rows<RuntimeMemoryLog>("SELECT body FROM memory_log WHERE bot_id=? AND json_extract(body,'$.memoryId')=? ORDER BY rowid", a.botId, id)) {
      for (const m of [row.before, row.after]) if (m?.id) versions.set(memoryVersion(m as RuntimeMemory), m as RuntimeMemory)
    }
    versions.set(memoryVersion(current), current)
    return [...versions.values()].sort((a, b) => memoryVersion(b) - memoryVersion(a))
  }
  read(a: MemoryAudience, id: string) { return this.require(a, id) }
  keyword(a: MemoryAudience, query: string, candidateIds: string[]): Map<string, number> {
    const words = experienceTokens(query).slice(0, 60)
    if (!words.length || !candidateIds.length) return new Map()
    const match = words.map(w => `"${w.replaceAll('"', '""')}"`).join(' OR ')
    const rows = this.db.query('SELECT id,bm25(memory_fts) AS score FROM memory_fts WHERE memory_fts MATCH ? AND bot_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY score,id').all(match, a.botId, JSON.stringify(candidateIds)) as { id: string; score: number }[]
    return new Map(rows.map((r, i) => [r.id, 1 / (1 + i / 10)]))
  }
  record(a: MemoryAudience, ids: string[], kind: 'recall' | 'used', event: string, now = Date.now()): void {
    this.db.transaction(() => {
      if (!this.db.query('INSERT OR IGNORE INTO memory_events(bot_id,event_key) VALUES(?,?) RETURNING event_key').get(a.botId, memoryHash([a.channel, a.senderId, kind, event]))) return
      for (const id of new Set(ids)) {
        const m = this.require(a, id)
        if (!this.alive(m, now)) continue
        const next = kind === 'recall' ? { ...m, recalls: (m.recalls ?? 0) + 1 } : { ...m, uses: (m.uses ?? 0) + 1, lastUsedAt: now, triggers: { count: (m.uses ?? 0) + 1, lastTriggeredAt: now } }
        this.db.query('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(next), m.id)
      }
    })()
  }
  withdrawSource(a: MemoryAudience, sourceId: string, now = Date.now()): void {
    this.db.transaction(() => {
      for (const m of this.all(a)) {
        if (!['active','suppressed'].includes(m.status)) continue
        if (m.source.inboxId !== sourceId && !m.extraSources?.some(s => s.inboxId === sourceId)) continue
        const sources = [m.source, ...(m.extraSources ?? [])].filter(s => s.inboxId !== sourceId)
        if (!sources.length) this.retire(m, 'revoke', 'host', now)
        else this.persist({ ...m, source: { ...m.source, ...sources[0], context: sources[0].inboxId === m.source.inboxId ? m.source.context : '', sentAt: this.rows<RuntimeInbox>('SELECT body FROM inbox WHERE id=?', sources[0].inboxId)[0]?.createdAt ?? m.source.sentAt }, extraSources: sources.slice(1).map(s => ({ inboxId: s.inboxId, quote: s.quote })) }, 'update', 'host', now, m)
      }
    })()
  }
  sweep(botId: string, now = Date.now()): void {
    this.db.transaction(() => {
      for (const m of this.rows<RuntimeMemory>('SELECT body FROM memories WHERE bot_id=?', botId)) {
        if (!['active','suppressed'].includes(m.status)) continue
        if ((m.expiresAt ?? Infinity) <= now || this.ended(m)) this.persist({ ...m, status: 'expired' }, 'expire', 'host', now, m)
        else if (m.tier === 'long' && !m.needsReview && now - (m.lastUsedAt ?? m.createdAt) > 30 * 86400000) this.persist({ ...m, needsReview: true }, 'review', 'host', now, m)
      }
    })()
  }
  cached(id: string, provider: string, digest: string): number[] | undefined {
    const row = this.db.query('SELECT vector FROM memory_embeddings WHERE memory_id=? AND provider=? AND digest=?').get(id, provider, digest) as { vector: string } | null
    return row ? JSON.parse(row.vector) : undefined
  }
  cache(id: string, provider: string, digest: string, vector: number[]): void {
    const current = this.get(id)
    if (current?.status !== 'active' || memoryHash(memoryText(current)) !== digest) return
    this.db.query('INSERT INTO memory_embeddings(memory_id,provider,digest,vector) VALUES(?,?,?,?) ON CONFLICT(memory_id,provider) DO UPDATE SET digest=excluded.digest,vector=excluded.vector').run(id, provider, digest, JSON.stringify(vector))
  }
  summaries(a: MemoryAudience) { return this.all(a).map(memorySummary) }
}
