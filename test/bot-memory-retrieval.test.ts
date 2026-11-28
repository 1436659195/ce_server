import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { MemoryRetrieval, createMemoryEmbedding } from '../src/cli/bot-runtime/memory-retrieval'
import type { RuntimeMemory } from '../src/cli/bot-runtime/types'
const cleanups: Array<() => void> = []
afterEach(() => { for (const c of cleanups.splice(0)) c() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-search-')); const store = new BotRuntimeStore(join(dir, 'state.sqlite'))
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const audience = { botId: 'b', channel: 'dm', senderId: 'owner', project: '/project' }
  const put = (id: string, prompt: string, extra: Partial<RuntimeMemory> = {}) => store.saveMemory({ id, prompt, ...audience, tier: 'mid', status: 'active', topic: id, source: { inboxId: 'm', quote: prompt, context: '', sentAt: 1 }, triggers: { count: 0 }, format: 2, version: 1, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 86400000, ...extra })
  return { store, audience, put }
}

test('semantic recall finds paraphrases; small libraries never bypass relevance or scope', async () => {
  const f = fixture(); f.put('brief', '回答别啰嗦'); f.put('weather', '只报告晴雨'); f.put('foreign', '回答别啰嗦', { senderId: 'other' }); f.put('other-project', '回答别啰嗦', { scope: { project: '/elsewhere' } })
  const calls: string[][] = []
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary, { key: 'test', embed: async texts => { calls.push(texts); return texts.map(t => t.includes('啰嗦') || t.includes('简短') ? [1, 0] : [0, 1]) } })
  await retrieval.index(f.audience)
  const result = await retrieval.disclose(f.audience, '请简短回答')
  expect(result.mid.map(m => m.id)).toEqual(['brief'])
  expect(result.retrieval.mode).toBe('hybrid')
  expect(calls.flat()).not.toContain('foreign')
})

test('only explicitly global core rules are resident; budgets never pad unrelated memories', async () => {
  const f = fixture(); f.put('core', '称呼用户老王', { tier: 'long', core: true }); f.put('conditional', '发布前先给计划', { tier: 'long', core: false }); f.put('mid', '这周只报晴雨')
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary)
  const result = await retrieval.disclose(f.audience, '你好')
  expect(result.long.map(m => m.id)).toEqual(['core'])
  expect(result.mid).toEqual([])
  expect(result.retrieval.mode).toBe('keyword')
  expect(result.retrieval.warning).toBeTruthy()
})

test('query time filters, topic, pagination and history are independent from chat search', async () => {
  const f = fixture(); for (let i = 0; i < 7; i++) f.put(`m${i}`, `报告格式要求${i}`, { topic: '交付格式', createdAt: i + 1 })
  f.put('revoked', '报告格式旧要求', { topic: '交付格式', status: 'revoked' })
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary)
  const first = await retrieval.search(f.audience, { topic: '交付格式', limit: 2, from: 2, to: 6 })
  expect(first.items).toHaveLength(2); expect(first.total).toBe(5)
  const next = await retrieval.search(f.audience, { topic: '交付格式', limit: 2, from: 2, to: 6, offset: first.nextOffset, revision: first.revision, cursor: first.cursor })
  expect(next.items.map(m => m.id).some(id => first.items.some(m => m.id === id))).toBe(false)
  const historical = await retrieval.search(f.audience, { topic: '交付格式', history: true, limit: 20 })
  expect(historical.items.some(m => m.id === 'revoked')).toBe(true)
})

test('query embedding errors fall back visibly and cache is invalidated by content changes', async () => {
  const f = fixture(); f.put('brief', '回答简短')
  let down = false
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary, { key: 'test', embed: async texts => { if (down) throw new Error('secret API key must never leak'); return texts.map(() => [1, 0]) } })
  await retrieval.index(f.audience); down = true
  const result = await retrieval.disclose(f.audience, '简短')
  expect(result.mid.map(m => m.id)).toEqual(['brief']); expect(result.retrieval.warning).not.toContain('secret')
  f.put('brief', '回答详细', { version: 2 })
  const changed = await retrieval.disclose(f.audience, '简短')
  expect(changed.mid).toEqual([])
})

test('embedding adapter uses compatible HTTP, validates vectors and supports out-of-order indexes', async () => {
  const server = Bun.serve({ port: 0, fetch: async req => { const b = await req.json() as { input: string[] }; return Response.json({ data: b.input.map((_, i) => ({ index: i, embedding: [i + 1, 1] })).reverse() }) } })
  cleanups.push(() => { server.stop(true) })
  const embedding = createMemoryEmbedding({ CE_MEMORY_EMBEDDING_URL: `${server.url}v1/embeddings`, CE_MEMORY_EMBEDDING_MODEL: 'test' })!
  expect(await embedding.embed(['a', 'b'])).toEqual([[1, 1], [2, 1]])
})

test('active overrides inherit relevance and residency from the rule they replace', async () => {
  const f = fixture(); f.put('base', '默认回答简短', { tier: 'long', core: true })
  f.put('override', '本周详细解释', { overrides: ['base'] })
  const result = await new MemoryRetrieval(f.store.memoryLibrary).disclose(f.audience, '你好')
  expect([...result.long, ...result.mid].map(m => m.id)).toEqual(['override'])
})

test('topic conflict queries inspect all scopes without leaking other users', async () => {
  const f = fixture(); f.put('local', '当前项目回复简短', { topic: '回复长度', scope: { project: '/project' } })
  f.put('other', '另外项目回复详细', { topic: '回复长度', scope: { project: '/other' } })
  f.put('foreign', '其他用户回复详细', { topic: '回复长度', senderId: 'another' })
  const result = await new MemoryRetrieval(f.store.memoryLibrary).search(f.audience, { topic: '回复长度' })
  expect(result.items.map(m => m.id).sort()).toEqual(['local','other'])
})

test('ordinary search follows current overrides while topic inspection exposes checked bases', async () => {
  const f = fixture(); f.put('base', '默认回答简短', { tier: 'long', core: true, topic: '回复长度' }); f.put('override', '本周充分展开', { overrides: ['base'], topic: '回复长度' })
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary)
  const ordinary = await retrieval.search(f.audience, { query: '回答简短' })
  expect(ordinary.items.map(m => m.id)).toEqual(['override'])
  const conflict = await retrieval.search(f.audience, { topic: '回复长度' })
  expect(conflict.items.map(m => m.id).sort()).toEqual(['base','override'])
})

test('disclosure enforces both count and serialized character budgets', async () => {
  const f = fixture()
  for (let i = 0; i < 35; i++) f.put(`core-${i}`, '称呼规则'.repeat(100), { tier: 'long', core: true })
  const result = await new MemoryRetrieval(f.store.memoryLibrary).disclose(f.audience, '你好')
  expect(result.long.length).toBeLessThanOrEqual(30)
  expect(JSON.stringify([...result.long, ...result.mid]).length).toBeLessThanOrEqual(6100)
  expect(result.overflow).toBeGreaterThan(0)
})

test('conditional temporary overrides retain their base outside known structural conditions', async () => {
  const f = fixture(); f.put('base', '默认简短', { tier: 'long', core: true })
  f.put('override', '故障排查详细解释', { appliesTo: '只有故障排查时', overrides: ['base'] })
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary)
  const unrelated = await retrieval.disclose(f.audience, '你好')
  expect(unrelated.long.map(m => m.id)).toEqual(['base'])
  const troubleshooting = await retrieval.disclose(f.audience, '故障排查')
  expect(troubleshooting.mid[0]).toMatchObject({ id: 'override', overrides: ['base'], appliesTo: '只有故障排查时' })
})

test('normal search reorders effective overrides by inherited scores before pagination', async () => {
  const f = fixture(); f.put('base', '回答简短', { tier: 'long' }); f.put('override', '本周充分展开', { overrides: ['base'] }); f.put('other', '另一项要求')
  const r = new MemoryRetrieval(f.store.memoryLibrary, { key: 'rank', embed: async texts => texts.map(t => t.includes('回答简短') ? [1, 0] : t.includes('另一项') ? [0.8, 0.6] : [0, 1]) })
  await r.index(f.audience)
  const found = await r.search(f.audience, { query: '回答简短', limit: 1 })
  expect(found.items[0].id).toBe('override')
})

test('history search never returns purged text after an awaited embedding', async () => {
  const f = fixture(); f.put('secret', '必须删除的秘密正文')
  let release!: (vectors: number[][]) => void
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary, { key: 'pending', embed: () => new Promise(resolve => { release = resolve }) })
  const pending = retrieval.search(f.audience, { query: '秘密正文', history: true })
  f.store.memoryLibrary.control(f.audience, 'secret', 'purge')
  release([[1, 0]])
  const result = await pending
  expect(JSON.stringify(result)).not.toContain('必须删除的秘密正文')
  expect(result.items).toEqual([])
  expect(result.revision).toBe(f.store.memoryLibrary.revision(f.audience))
})

test('disclosure loads a new override and its revision after awaiting an embedding', async () => {
  const f = fixture(); f.put('base', '默认回答简短', { tier: 'long', core: true })
  let release!: (vectors: number[][]) => void
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary, { key: 'pending', embed: () => new Promise(resolve => { release = resolve }) })
  const pending = retrieval.disclose(f.audience, '你好')
  f.put('override', '本周详细解释', { overrides: ['base'] })
  release([[1, 0]])
  const result = await pending
  expect([...result.long, ...result.mid].map(m => m.id)).toEqual(['override'])
  expect(result.revision).toBe(f.store.memoryLibrary.revision(f.audience))
})

test('search rechecks a supplied revision after awaiting an embedding', async () => {
  const f = fixture(); f.put('secret', '旧规则')
  let release!: (vectors: number[][]) => void
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary, { key: 'pending', embed: () => new Promise(resolve => { release = resolve }) })
  const pending = retrieval.search(f.audience, { query: '旧规则', history: true, revision: f.store.memoryLibrary.revision(f.audience) })
  f.store.memoryLibrary.control(f.audience, 'secret', 'purge')
  release([[1, 0]])
  await expect(pending).rejects.toThrow(/变化|重新/)
})

test('ineligible keyword matches cannot exhaust the recall limit', async () => {
  for (const excluded of [{ status: 'revoked' }, { expiresAt: 1 }, { senderId: 'another' }, { scope: { project: '/elsewhere' } }, { createdAt: 100 }]) {
    const f = fixture()
    for (let i = 0; i < 201; i++) f.put(`old-${i}`, '报告格式', { topic: '格式', ...excluded } as Partial<RuntimeMemory>)
    f.put('valid', '报告格式', { topic: '格式', createdAt: 1 })
    const retrieval = new MemoryRetrieval(f.store.memoryLibrary)
    const result = await retrieval.search(f.audience, { query: '报告格式', to: 10 })
    expect(result.items.map(m => m.id)).toEqual(['valid'])
    if (!('createdAt' in excluded)) expect((await retrieval.disclose(f.audience, '报告格式')).mid.map(m => m.id)).toEqual(['valid'])
  }
})

test('pagination detects index-induced reorder and requires a result cursor', async () => {
  const f = fixture(); f.put('a', '报告格式'); f.put('b', '格式报告')
  const retrieval = new MemoryRetrieval(f.store.memoryLibrary, { key: 'index', embed: async texts => texts.map(t => t.startsWith('a ') ? [0, 1] : [1, 0]) })
  const first = await retrieval.search(f.audience, { query: '报告', limit: 1 })
  expect(first.items[0].id).toBe('a')
  await retrieval.index(f.audience)
  expect(f.store.memoryLibrary.revision(f.audience)).toBe(first.revision)
  await expect(retrieval.search(f.audience, { query: '报告', limit: 1, offset: 1, revision: first.revision })).rejects.toThrow(/游标|cursor|重新/)
  await expect(retrieval.search(f.audience, { query: '报告', limit: 1, offset: 1, revision: first.revision, cursor: first.cursor })).rejects.toThrow(/变化|重新/)
  const fresh = await retrieval.search(f.audience, { query: '报告', limit: 1 })
  const next = await retrieval.search(f.audience, { query: '报告', limit: 1, offset: 1, revision: fresh.revision, cursor: fresh.cursor })
  expect([fresh.items[0].id, next.items[0].id]).toEqual(['b', 'a'])
})


test('rules expiring during an embedding request are no longer disclosed or searched', async () => {
  const f = fixture(); const start = Date.now()
  f.put('brief', '回答简短', { tier: 'long', core: true, expiresAt: start + 1000 })
  const clock = spyOn(Date, 'now').mockReturnValue(start)
  try {
    let release!: (vectors: number[][]) => void
    const retrieval = new MemoryRetrieval(f.store.memoryLibrary, { key: 'clock', embed: () => new Promise(resolve => { release = resolve }) })
    const search = retrieval.search(f.audience, { query: '回答简短' })
    const disclosure = retrieval.disclose(f.audience, '回答简短')
    clock.mockReturnValue(start + 2000); release([[1, 0]])
    expect((await search).items).toEqual([])
    expect((await disclosure).long).toEqual([])
  } finally { clock.mockRestore() }
})

test('other tiers cannot consume all keyword matches before the requested tier is selected', async () => {
  const f = fixture()
  for (let i = 0; i < 201; i++) f.put(`mid-${i}`, '报告格式', { topic: '格式' })
  f.put('z-long', '报告格式', { topic: '格式', tier: 'long' })
  const result = await new MemoryRetrieval(f.store.memoryLibrary).search(f.audience, { query: '报告格式', tier: 'long' })
  expect(result.items.map(m => m.id)).toEqual(['z-long'])
})
