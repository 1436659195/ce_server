import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { queryChatHistory, readChatMessage } from '../src/cli/bot-runtime/history'

const databases: Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = new Database(':memory:'); databases.push(db)
  for (const table of ['inbox', 'outbox', 'tasks', 'cases', 'artifacts']) db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, body TEXT NOT NULL)`)
  function put(table: string, row: Record<string, unknown>) {
    db.query(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(row.id as string, (row.botId ?? 'bot-a') as string, JSON.stringify({ botId: 'bot-a', ...row }))
  }
  function owner(id: string, createdAt: number, text = id, extra = {}) { put('inbox', { id, groupId: 'dm-a', createdAt, text, state: 'routed', ...extra }) }
  function router(id: string, createdAt: number, text = id, extra = {}) { put('outbox', { id, groupId: 'dm-a', createdAt, sentAt: createdAt, text, author: 'router', state: 'sent', ...extra }) }
  return { db, put, owner, router }
}

test('searches saved history older than the latest 100 messages and matches full text', () => {
  const { db, owner } = fixture()
  owner('old', 1, 'x'.repeat(3000) + 'old needle')
  for (let i = 0; i < 120; i++) owner(`recent-${i}`, i + 2)
  const page = queryChatHistory(db, 'bot-a', { query: 'OLD NEEDLE' })
  expect(page.messages.map(m => m.id)).toEqual(['old'])
  expect(page.messages[0]).toMatchObject({ truncated: true, textLength: 3010 })
  const tail = readChatMessage(db, 'bot-a', { messageId: 'old', offset: 3000, length: 10 })
  expect(tail).toMatchObject({ text: 'old needle', offset: 3000, hasMore: false })
})

test('combines owner and delivered router messages with inclusive time and author filters', () => {
  const { db, owner, router } = fixture()
  const base = Date.parse('2026-11-26T00:00:00+08:00')
  owner('before', base - 1); owner('start', base); router('reply', base + 1000)
  router('pending', base + 500, 'not sent', { state: 'pending' })
  router('worker', base + 500, 'internal', { author: 'worker' })
  owner('after', base + 2001)
  const options = { from: '2026-11-26T00:00:00+08:00', to: base + 1000, order: 'asc' as const, limit: 2 }
  expect(queryChatHistory(db, 'bot-a', options).messages.map(m => m.id)).toEqual(['start', 'reply'])
  expect(queryChatHistory(db, 'bot-a', { ...options, author: 'router' }).messages.map(m => m.id)).toEqual(['reply'])
})

test('paginates equal timestamps in stable order and scopes cursors to bot and filters', () => {
  const { db, owner, router } = fixture()
  owner('a', 100); router('b', 100); owner('c', 100); owner('d', 101)
  const first = queryChatHistory(db, 'bot-a', { limit: 2, order: 'asc' })
  expect(first.messages.map(m => m.id)).toEqual(['a', 'b'])
  expect(first.hasMore).toBe(true)
  owner('older-inserted-later', 1)
  const second = queryChatHistory(db, 'bot-a', { limit: 2, order: 'asc', cursor: first.nextCursor })
  expect(second.messages.map(m => m.id)).toEqual(['c', 'd'])
  expect(second.hasMore).toBe(false)
  expect(second.nextCursor).toBeUndefined()
  expect(() => queryChatHistory(db, 'bot-b', { order: 'asc', cursor: first.nextCursor })).toThrow(/cursor/)
  expect(() => queryChatHistory(db, 'bot-a', { order: 'asc', query: 'other', cursor: first.nextCursor })).toThrow(/cursor/)
  expect(queryChatHistory(db, 'bot-a', { limit: 2 }).messages.map(m => m.id)).toEqual(['d', 'c'])
})

test('never exposes revoked or other bot messages, including direct message reads', () => {
  const { db, owner, router } = fixture()
  owner('revoked', 1, 'secret', { revokedAt: 2 }); owner('foreign', 2, 'foreign secret', { botId: 'bot-b' })
  router('foreign-reply', 3, 'secret', { botId: 'bot-b' }); owner('valid', 4)
  expect(queryChatHistory(db, 'bot-a').messages.map(m => m.id)).toEqual(['valid'])
  for (const messageId of ['revoked', 'foreign', 'foreign-reply', 'missing']) expect(readChatMessage(db, 'bot-a', { messageId })).toBeUndefined()
})

test('returns validated task, case and attachment references without local artifact paths', () => {
  const { db, put, owner, router } = fixture()
  put('cases', { id: 'case', title: 'report' })
  put('tasks', { id: 'task', caseId: 'case', originInputId: 'request' })
  put('tasks', { id: 'other-task', botId: 'bot-b', caseId: 'other-case', originInputId: 'request' })
  const attachment = { id: 'upload', kind: 'upload', botId: 'bot-a', name: 'brief.txt', mime: 'text/plain', size: 10, hash: 'abc' }
  owner('request', 1, 'report', { attachments: [attachment] })
  put('artifacts', { id: 'artifact', botId: 'bot-a', taskId: 'task', caseId: 'case', title: 'report', name: 'report.md', mime: 'text/markdown', size: 20, hash: 'def', path: '/private/path' })
  router('delivery', 2, 'done', { taskId: 'task', artifactIds: ['artifact'] })
  owner('bad-link', 3, 'bad', { targetTaskId: 'other-task' })
  const messages = queryChatHistory(db, 'bot-a', { order: 'asc' }).messages
  expect(messages[0]).toMatchObject({ taskId: 'task', caseId: 'case', attachments: [attachment] })
  expect(messages[1]).toMatchObject({ taskId: 'task', caseId: 'case', attachments: [{ id: 'artifact', name: 'report.md' }] })
  expect(JSON.stringify(messages)).not.toContain('/private/path')
  expect(messages[2]).not.toHaveProperty('taskId')
})

test('bounded JSON pages preserve cursor continuation even for oversized escaped text and attachments', () => {
  const { db, owner } = fixture()
  for (let i = 0; i < 4; i++) owner(`msg-${i}`, i, '\n"'.repeat(10000), { attachments: Array.from({ length: 40 }, (_, j) => ({ id: `up-${j}`, kind: 'upload', botId: 'bot-a', name: 'n'.repeat(300), mime: 'text/plain', size: 1, hash: 'a' })) })
  const ids: string[] = []; let cursor: string | undefined
  do {
    const page = queryChatHistory(db, 'bot-a', { limit: 20, maxChars: 1200, cursor })
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(1200)
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.messages[0].truncated).toBe(true)
    ids.push(...page.messages.map(m => m.id)); cursor = page.nextCursor
  } while (cursor)
  expect(ids).toEqual(['msg-3', 'msg-2', 'msg-1', 'msg-0'])
  const chunk = readChatMessage(db, 'bot-a', { messageId: 'msg-0', length: 4000, maxChars: 1200 })!
  expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(1200)
  expect(chunk.text.length).toBeGreaterThan(0)
  expect(chunk.nextOffset).toBe(chunk.text.length)
  expect(chunk.hasMore).toBe(true)
})

test('custom limits are capped and long messages can be read without gaps', () => {
  const { db, owner } = fixture()
  for (let i = 0; i < 30; i++) owner(`msg-${i}`, i, 'tiny')
  expect(queryChatHistory(db, 'bot-a').messages).toHaveLength(5)
  expect(queryChatHistory(db, 'bot-a', { limit: 500, maxChars: 16000 }).messages).toHaveLength(20)
  owner('long', 100, '🐈'.repeat(2500))
  let offset = 0; let accumulated = ''; let hasMore = true
  while (hasMore) {
    const chunk = readChatMessage(db, 'bot-a', { messageId: 'long', offset, length: 333 })!
    accumulated += chunk.text; offset = chunk.nextOffset; hasMore = chunk.hasMore
  }
  expect(accumulated).toBe('🐈'.repeat(2500))
})

test('rejects ambiguous dates, invalid ranges and malformed cursors', () => {
  const { db } = fixture()
  for (const from of ['yesterday', '2026-11-26', '2026-11-26T08:00:00', Number.NaN]) expect(() => queryChatHistory(db, 'bot-a', { from })).toThrow()
  expect(() => queryChatHistory(db, 'bot-a', { from: 20, to: 10 })).toThrow()
  expect(() => queryChatHistory(db, 'bot-a', { cursor: 'not a cursor' })).toThrow(/cursor/)
})

test('keywords match full owner attachment names and delivered Router artifact names or titles', () => {
  const { db, owner, router, put } = fixture()
  const upload = { id: 'upload', kind: 'upload', botId: 'bot-a', name: 'x'.repeat(3000) + 'BRIEF.pdf', mime: 'application/pdf', size: 1, hash: 'a' }
  owner('request', 1, '', { attachments: [upload] })
  owner('foreign-ref', 2, '', { attachments: [{ ...upload, botId: 'bot-b', name: 'secret.pdf' }] })
  put('artifacts', { id: 'report', taskId: 'task', caseId: 'case', name: 'Weather-report.md', title: 'Weekly analysis', mime: 'text/markdown', size: 2, hash: 'b', path: '/private/secret-path.md' })
  put('artifacts', { id: 'foreign-artifact', botId: 'bot-b', name: 'secret.pdf', title: 'secret' })
  router('delivery', 3, 'done', { artifactIds: ['report'] })
  router('foreign-delivery', 4, '', { artifactIds: ['foreign-artifact'] })
  router('pending-delivery', 5, '', { artifactIds: ['report'], state: 'pending' })
  for (let i = 0; i < 110; i++) owner(`recent-${i}`, i + 10)
  expect(queryChatHistory(db, 'bot-a', { query: 'brief.pdf' }).messages.map(m => m.id)).toEqual(['request'])
  expect(queryChatHistory(db, 'bot-a', { query: 'weather-report' }).messages.map(m => m.id)).toEqual(['delivery'])
  expect(queryChatHistory(db, 'bot-a', { query: 'weekly analysis' }).messages.map(m => m.id)).toEqual(['delivery'])
  expect(queryChatHistory(db, 'bot-a', { query: 'secret' }).messages).toEqual([])
})

test('host group scoping excludes prior private chats from queries, direct reads and cursor reuse', () => {
  const { db, owner, router } = fixture()
  owner('old-owner', 1, 'needle', { groupId: 'old-dm' }); router('old-router', 2, 'needle', { groupId: 'old-dm' })
  owner('current-owner', 3, 'needle'); router('current-router', 4, 'needle')
  const options = { groupId: 'dm-a', query: 'needle', order: 'asc' as const, limit: 1 }
  const first = queryChatHistory(db, 'bot-a', options)
  expect(first.messages.map(m => m.id)).toEqual(['current-owner'])
  const last = queryChatHistory(db, 'bot-a', { ...options, cursor: first.nextCursor })
  expect(last.messages.map(m => m.id)).toEqual(['current-router'])
  expect(last.hasMore).toBe(false)
  for (const messageId of ['old-owner', 'old-router']) expect(readChatMessage(db, 'bot-a', { messageId, groupId: 'dm-a' })).toBeUndefined()
  expect(readChatMessage(db, 'bot-a', { messageId: 'current-owner', groupId: 'dm-a' })?.text).toBe('needle')
  expect(() => queryChatHistory(db, 'bot-a', { ...options, groupId: 'old-dm', cursor: first.nextCursor })).toThrow(/cursor/)
  expect(() => queryChatHistory(db, 'bot-a', { ...options, groupId: undefined, cursor: first.nextCursor })).toThrow(/cursor/)
})
