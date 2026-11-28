import { MEMORY_LIMITS, MEMORY_QUERY_SCHEMA, memorySummary, memoryText, scopeMatches, type MemoryAudience, type MemoryQuery, type MemorySummary } from './memory'
import { MemoryLibrary, memoryHash } from './memory-library'
import type { RuntimeMemory } from './types'

export interface MemoryEmbedding { key: string; embed(texts: string[]): Promise<number[][]> }
const validVector = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v.some(n => n !== 0)
/** OpenAI-compatible endpoint; no SDK, model service or credentials are added to prompts. */
export function createMemoryEmbedding(env: Record<string, string | undefined> = process.env): MemoryEmbedding | undefined {
  const url = env.CE_MEMORY_EMBEDDING_URL ?? (env.OPENAI_API_KEY ? `${(env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/embeddings` : undefined)
  if (!url) return undefined
  const model = env.CE_MEMORY_EMBEDDING_MODEL ?? 'text-embedding-3-small'
  const key = env.CE_MEMORY_EMBEDDING_API_KEY ?? (env.CE_MEMORY_EMBEDDING_URL ? undefined : env.OPENAI_API_KEY)
  return { key: memoryHash([url, model]), async embed(input) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw new Error('Embedding service unavailable')
    const body = await response.json() as { data?: Array<{ index: number; embedding: unknown }> }
    const rows = [...(body.data ?? [])].sort((a, b) => a.index - b.index)
    if (rows.length !== input.length || rows.some((r, i) => r.index !== i || !validVector(r.embedding)) || new Set(rows.map(r => (r.embedding as number[]).length)).size !== 1) throw new Error('Invalid embedding response')
    return rows.map(r => r.embedding as number[])
  } }
}
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !validVector(a) || !validVector(b)) return 0
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
  return dot / Math.sqrt(aa * bb)
}
export interface MemoryRetrievalStatus { mode: 'hybrid' | 'keyword'; warning?: string }
export interface MemoryDisclosure { long: MemorySummary[]; mid: MemorySummary[]; overflow: number; revision: string; retrieval: MemoryRetrievalStatus }

/** Index maintenance is background work; the reply path only embeds its bounded query. */
export class MemoryRetrieval {
  private readonly queries = new Map<string, Promise<number[]>>()
  private readonly jobs = new Map<string, Promise<void>>()
  private retryAt = 0
  private closed = false
  constructor(private readonly library: MemoryLibrary, private readonly embedding?: MemoryEmbedding) {}
  async index(a: MemoryAudience): Promise<void> {
    if (!this.embedding || this.closed || Date.now() < this.retryAt) return
    const key = memoryHash(a)
    if (this.jobs.has(key)) return this.jobs.get(key)
    const job = (async () => {
      const missing = this.library.all(a).filter(m => m.status === 'active' && !this.library.cached(m.id, this.embedding!.key, memoryHash(memoryText(m))))
      for (let i = 0; i < missing.length && !this.closed; i += 32) {
        const batch = missing.slice(i, i + 32)
        const vectors = await this.embedding!.embed(batch.map(memoryText))
        if (vectors.length !== batch.length || vectors.some(v => !validVector(v))) throw new Error('Invalid vectors')
        if (!this.closed) batch.forEach((m, i) => this.library.cache(m.id, this.embedding!.key, memoryHash(memoryText(m)), vectors[i]))
      }
    })().catch(() => { this.retryAt = Date.now() + 60_000 }).finally(() => { this.jobs.delete(key) })
    this.jobs.set(key, job); return job
  }
  private async queryVector(query: string) {
    let vector: number[] | undefined; let warning: string | undefined = this.embedding ? undefined : '语义检索未配置，当前仅关键词检索；未命中不代表没有相关记忆'
    if (query && this.embedding) {
      try {
        const key = memoryHash([this.embedding.key, query])
        let request = this.queries.get(key)
        if (!request) { request = this.embedding.embed([query]).then(rows => { if (rows.length !== 1 || !validVector(rows[0])) throw new Error('Invalid query vector'); return rows[0] }); this.queries.set(key, request); request.catch(() => this.queries.delete(key)); if (this.queries.size > 64) this.queries.delete(this.queries.keys().next().value!) }
        vector = await request
      } catch { warning = '语义检索暂不可用，已降级关键词检索；未命中不代表没有相关记忆' }
    }
    return { vector, warning }
  }
  private rank(a: MemoryAudience, records: RuntimeMemory[], query: string, { vector, warning }: Awaited<ReturnType<MemoryRetrieval['queryVector']>>) {
    const lexical = this.library.keyword(a, query, records.map(m => m.id))
    if (vector && records.some(m => !this.library.cached(m.id, this.embedding!.key, memoryHash(memoryText(m))))) warning = '部分记忆尚未建立语义索引，可用关键词或主题补查'
    const ranked = records.map(memory => {
      const stored = vector && this.embedding && this.library.cached(memory.id, this.embedding.key, memoryHash(memoryText(memory)))
      const semantic = stored && vector ? Math.max(0, cosine(vector, stored)) : 0
      const keyword = lexical.get(memory.id) ?? 0
      return { memory, score: (semantic >= 0.5 ? 0.7 * semantic : 0) + 0.3 * keyword }
    }).sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt || a.memory.id.localeCompare(b.memory.id))
    const retrieval: MemoryRetrievalStatus = { mode: vector ? 'hybrid' : 'keyword', ...(warning ? { warning } : {}) }
    return { ranked, retrieval }
  }
  private inherit(ranked: Array<{ memory: RuntimeMemory; score: number }>) {
    const byId = new Map(ranked.map(r => [r.memory.id, r]))
    const inherited = (id: string, seen = new Set<string>()): { score: number; resident: boolean } => {
      const r = byId.get(id)
      if (!r || seen.has(id)) return { score: 0, resident: false }
      seen.add(id)
      const parents = r.memory.appliesTo ? [] : (r.memory.overrides ?? []).map(id => inherited(id, new Set(seen)))
      return { score: Math.max(r.score, ...parents.map(p => p.score)), resident: r.memory.core === true && r.memory.tier === 'long' && !r.memory.appliesTo && !Object.keys(r.memory.scope ?? {}).length || parents.some(p => p.resident) }
    }
    return ranked.map(r => ({ memory: r.memory, ...inherited(r.memory.id) }))
  }
  async search(a: MemoryAudience, raw: MemoryQuery = {}, now?: number) {
    const q = MEMORY_QUERY_SCHEMA.parse(raw)
    const { offset = 0, limit = 5, revision: expectedRevision, cursor: previousCursor, ...filters } = q
    if (q.from !== undefined && q.to !== undefined && q.from > q.to) throw new Error('时间区间无效')
    if (offset && !previousCursor) throw new Error('翻页需要上一页cursor游标，请从第一页重新查询')
    const query = q.query ?? '', vector = await this.queryVector(query)
    // Read all authoritative content after the only async boundary, including revision checks.
    now ??= Date.now()
    const revision = this.library.revision(a)
    if (expectedRevision && expectedRevision !== revision) throw new Error('记忆库已变化，请从第一页重新查询')
    const candidates = new Set(this.library.candidates(a, now).map(m => m.id))
    const records = this.library.all(a).filter(m => (q.history || (q.topic ? candidates.has(m.id) : this.library.alive(m, now))) && (q.topic ? m.topic === q.topic.normalize('NFKC').toLowerCase() : true)
      && (q.scope ? scopeMatches(q.scope, m.scope) : q.topic ? true : scopeMatches(m.scope, a))
      && (q.from === undefined || m.createdAt >= q.from) && (q.to === undefined || m.createdAt <= q.to))
    const { ranked, retrieval } = this.rank(a, records, query, vector)
    const effective = new Set(this.library.effective(a, now).map(m => m.id))
    const resolved = q.history || q.topic ? ranked : this.inherit(ranked).filter(r => effective.has(r.memory.id))
    const matches = resolved.filter(r => (!q.query || r.score > 0) && (!q.tier || r.memory.tier === q.tier)).sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt || a.memory.id.localeCompare(b.memory.id))
    // No cached body snapshots: verify both the query and the actual ranked set on every page.
    const cursor = memoryHash([a, filters, revision, retrieval.mode, matches.map(r => [r.memory.id, r.score, effective.has(r.memory.id)])])
    if (previousCursor && previousCursor !== cursor) throw new Error('查询结果或排序已变化，请从第一页重新查询')
    const page = matches.slice(offset, offset + limit)
    return { items: page.map(r => ({ ...memorySummary(r.memory), status: r.memory.status, effective: effective.has(r.memory.id), score: r.score })), total: matches.length, revision, cursor, retrieval, ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}) }
  }
  async disclose(a: MemoryAudience, query: string, now?: number): Promise<MemoryDisclosure> {
    query = query.slice(0, 2000)
    const vector = await this.queryVector(query)
    now ??= Date.now()
    const records = this.library.all(a).filter(m => this.library.alive(m, now) && scopeMatches(m.scope, a))
    const { ranked, retrieval } = this.rank(a, records, query, vector)
    const effective = new Set(this.library.effective(a, now).map(m => m.id))
    const selected = this.inherit(ranked).filter(r => effective.has(r.memory.id) && (r.resident || r.score > 0))
      .sort((a, b) => Number(b.resident) - Number(a.resident) || b.score - a.score || a.memory.id.localeCompare(b.memory.id))
    const result: MemoryDisclosure = { long: [], mid: [], overflow: 0, revision: this.library.revision(a), retrieval }
    let chars = 0
    for (const { memory } of selected) {
      const summary = memorySummary(memory); const size = JSON.stringify(summary).length
      const list = result[memory.tier]
      if (list.length >= MEMORY_LIMITS[memory.tier] || chars + size > MEMORY_LIMITS.chars) { result.overflow++; continue }
      list.push(summary); chars += size
    }
    return result
  }
  invalidate(): void { this.queries.clear() }
  close(): void { this.closed = true; this.invalidate() }
}
