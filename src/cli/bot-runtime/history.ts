import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import type { RuntimeArtifact, RuntimeAttachment, RuntimeInbox, RuntimeReply, RuntimeTask } from './types'

export interface ChatHistoryOptions {
  /** Host-supplied current private chat; never accept this scope from model arguments. */
  groupId?: string
  query?: string
  from?: number | string
  to?: number | string
  limit?: number
  order?: 'asc' | 'desc'
  author?: 'owner' | 'router'
  cursor?: string
  /** Maximum serialized page size, including metadata and the continuation cursor. */
  maxChars?: number
}
export interface ChatHistoryMessage {
  id: string; author: 'owner' | 'router'; text: string; createdAt: number
  textLength: number; truncated: boolean; nextOffset: number
  taskId?: string; caseId?: string
  attachments?: RuntimeAttachment[]; attachmentCount?: number; attachmentsTruncated?: boolean
}
export interface ChatHistoryPage { messages: ChatHistoryMessage[]; hasMore: boolean; nextCursor?: string }
type HistoryRow = { id: string; author: 'owner' | 'router'; at: number; body: string }

// Both sources use the same clock and deterministic tie breakers. Worker outbox
// entries are internal, and only successfully delivered Router replies are history.
const historySql = `WITH history AS (
  SELECT id, 'owner' AS author, json_extract(body, '$.createdAt') AS at, body FROM inbox
  WHERE bot_id = ? AND json_extract(body, '$.revokedAt') IS NULL
  UNION ALL
  SELECT id, 'router' AS author, COALESCE(json_extract(body, '$.sentAt'), json_extract(body, '$.createdAt')) AS at, body FROM outbox
  WHERE bot_id = ? AND json_extract(body, '$.state') = 'sent' AND json_extract(body, '$.author') = 'router'
)`

function bounded(value: number | undefined, fallback: number, max: number, min = 1): number {
  if (value !== undefined && !Number.isFinite(value)) throw new Error('Invalid history limit')
  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)))
}
function timestamp(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error('History time must be epoch milliseconds or ISO time with timezone')
}
function record<T>(db: Database, table: 'tasks' | 'cases' | 'artifacts', botId: string, id: string): T | undefined {
  const row = db.query(`SELECT body FROM ${table} WHERE bot_id = ? AND id = ?`).get(botId, id) as { body: string } | null
  return row ? JSON.parse(row.body) : undefined
}
function sliceText(text: string, start: number, length: number): string {
  let end = Math.min(text.length, start + length)
  // Offsets are UTF-16 indices, just like JS string slicing; keep surrogate pairs intact.
  if (end < text.length && end > start && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
  return text.slice(start, end)
}
function message(db: Database, botId: string, row: HistoryRow, textLimit: number): ChatHistoryMessage {
  const body = JSON.parse(row.body) as RuntimeInbox & RuntimeReply
  const fullText = body.text ?? ''
  const text = sliceText(fullText, 0, textLimit)
  const result: ChatHistoryMessage = { id: row.id, author: row.author, text, createdAt: row.at, textLength: fullText.length, truncated: text.length < fullText.length, nextOffset: text.length }
  const decision = body.decision as { taskId?: string } | undefined
  const directTaskId = body.targetTaskId ?? body.taskId ?? decision?.taskId
  let task = directTaskId ? record<RuntimeTask>(db, 'tasks', botId, directTaskId) : undefined
  if (!directTaskId && row.author === 'owner') {
    const found = db.query(`SELECT body FROM tasks WHERE bot_id = ? AND (json_extract(body, '$.originInputId') = ? OR EXISTS (SELECT 1 FROM json_each(tasks.body, '$.originInputIds') WHERE value = ?)) ORDER BY id LIMIT 1`).get(botId, row.id, row.id) as { body: string } | null
    if (found) task = JSON.parse(found.body)
  }
  if (task) {
    result.taskId = task.id
    if (record(db, 'cases', botId, task.caseId)) result.caseId = task.caseId
  }
  const attachments: RuntimeAttachment[] = []
  if (row.author === 'owner') {
    for (const attachment of body.attachments ?? []) {
      if (attachment.botId === botId) {
        const { id, kind, name, mime, size, hash } = attachment
        attachments.push({ id, kind, botId, name, mime, size, hash })
      }
    }
  } else {
    for (const id of body.artifactIds ?? []) {
      const artifact = record<RuntimeArtifact>(db, 'artifacts', botId, id)
      if (artifact) attachments.push({ id, kind: 'artifact', botId, name: artifact.name ?? artifact.title, mime: artifact.mime, size: artifact.size, hash: artifact.hash })
    }
  }
  if (attachments.length) result.attachments = attachments
  return result
}

/** Search the complete persisted conversation; keyword filtering precedes excerpting. */
export function queryChatHistory(db: Database, botId: string, options: ChatHistoryOptions = {}): ChatHistoryPage {
  const limit = bounded(options.limit, 5, 20)
  const maxChars = bounded(options.maxChars, 4000, 16000, 512)
  const order = options.order ?? 'desc'
  if (order !== 'asc' && order !== 'desc') throw new Error('Invalid history order')
  if (options.author !== undefined && options.author !== 'owner' && options.author !== 'router') throw new Error('Invalid history author')
  const from = timestamp(options.from); const to = timestamp(options.to)
  if (from !== undefined && to !== undefined && from > to) throw new Error('Invalid history time range')
  const scope = createHash('sha256').update(JSON.stringify([botId, options.groupId, order, options.query ?? '', from, to, options.author])).digest('hex').slice(0, 24)
  const clauses: string[] = []; const bindings: SQLQueryBindings[] = [botId, botId]
  if (options.groupId !== undefined) { clauses.push("json_extract(history.body, '$.groupId') = ?"); bindings.push(options.groupId) }
  if (from !== undefined) { clauses.push('at >= ?'); bindings.push(from) }
  if (to !== undefined) { clauses.push('at <= ?'); bindings.push(to) }
  if (options.author) { clauses.push('author = ?'); bindings.push(options.author) }
  if (options.query) {
    clauses.push(`(
      instr(lower(json_extract(history.body, '$.text')), lower(?)) > 0
      OR (author = 'owner' AND EXISTS (
        SELECT 1 FROM json_each(history.body, '$.attachments') AS attachment
        WHERE json_extract(attachment.value, '$.botId') = ?
          AND instr(lower(json_extract(attachment.value, '$.name')), lower(?)) > 0
      ))
      OR (author = 'router' AND EXISTS (
        SELECT 1 FROM json_each(history.body, '$.artifactIds') AS reference
        JOIN artifacts AS artifact ON artifact.id = reference.value AND artifact.bot_id = ?
        WHERE instr(lower(json_extract(artifact.body, '$.name')), lower(?)) > 0
          OR instr(lower(json_extract(artifact.body, '$.title')), lower(?)) > 0
      ))
    )`)
    bindings.push(options.query, botId, options.query, botId, options.query, options.query)
  }
  if (options.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()) as unknown[]
      if (!Array.isArray(cursor) || cursor.length !== 5 || cursor[0] !== 1 || cursor[1] !== scope || typeof cursor[2] !== 'number' || !Number.isFinite(cursor[2]) || typeof cursor[3] !== 'string' || !['owner', 'router'].includes(cursor[4] as string)) throw new Error()
      clauses.push(`(at, id, author) ${order === 'asc' ? '>' : '<'} (?, ?, ?)`)
      bindings.push(cursor[2], cursor[3], cursor[4] as string)
    } catch { throw new Error('Invalid or mismatched history cursor') }
  }
  bindings.push(limit + 1)
  const rows = db.query(`${historySql} SELECT * FROM history ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY at ${order}, id ${order}, author ${order} LIMIT ?`).all(...bindings) as HistoryRow[]
  let page: ChatHistoryPage = { messages: [], hasMore: false }
  const frame = (items: ChatHistoryMessage[], index: number): ChatHistoryPage => {
    const hasMore = index < rows.length - 1
    const row = rows[index]!
    return { messages: items, hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify([1, scope, row.at, row.id, row.author])).toString('base64url') } : {}) }
  }
  for (const [index, row] of rows.slice(0, limit).entries()) {
    const item = message(db, botId, row, 1000)
    let candidate = frame([...page.messages, item], index)
    if (JSON.stringify(candidate).length > maxChars) {
      if (page.messages.length) break
      // An enormous first message must still advance the cursor. Preserve reference
      // counts and identifiers while shrinking the preview to the actual JSON budget.
      if (item.attachments) {
        item.attachmentCount = item.attachments.length
        while (item.attachments.length && JSON.stringify(candidate).length > maxChars - 80) {
          item.attachments.pop(); item.attachmentsTruncated = true
        }
        if (!item.attachments.length) delete item.attachments
      }
      const preview = item.text
      let low = 0; let high = preview.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        item.text = sliceText(preview, 0, mid); item.nextOffset = item.text.length; item.truncated = item.text.length < item.textLength
        if (JSON.stringify(candidate).length <= maxChars) low = mid
        else high = mid - 1
      }
      item.text = sliceText(preview, 0, low); item.nextOffset = item.text.length; item.truncated = item.text.length < item.textLength
      candidate = frame([item], index)
    }
    page = candidate
  }
  return page
}

/** Read a full message in bounded chunks, subject to the same visibility rules. */
export function readChatMessage(db: Database, botId: string, options: { messageId: string; groupId?: string; offset?: number; length?: number; maxChars?: number }): (ChatHistoryMessage & { offset: number; hasMore: boolean }) | undefined {
  const groupFilter = options.groupId !== undefined ? "AND json_extract(history.body, '$.groupId') = ?" : ''
  const bindings: SQLQueryBindings[] = [botId, botId, options.messageId]
  if (options.groupId !== undefined) bindings.push(options.groupId)
  const row = db.query(`${historySql} SELECT * FROM history WHERE id = ? ${groupFilter} LIMIT 1`).get(...bindings) as HistoryRow | null
  if (!row) return undefined
  const offset = bounded(options.offset, 0, Number.MAX_SAFE_INTEGER, 0)
  const length = bounded(options.length, 1000, 4000, 2)
  const maxChars = bounded(options.maxChars, 4000, 16000, 512)
  const body = JSON.parse(row.body) as { text: string }
  const fullText = body.text ?? ''
  if (offset > fullText.length || offset > 0 && /[\uDC00-\uDFFF]/.test(fullText[offset] ?? '')) throw new Error('Invalid history message offset')
  const result = message(db, botId, row, 0)
  result.text = sliceText(fullText, offset, length)
  result.nextOffset = offset + result.text.length
  result.truncated = offset > 0 || result.nextOffset < fullText.length
  const chunk = { ...result, offset, hasMore: result.nextOffset < fullText.length }
  if (JSON.stringify(chunk).length > maxChars) {
    if (chunk.attachments) {
      chunk.attachmentCount = chunk.attachments.length
      while (chunk.attachments.length && JSON.stringify(chunk).length > maxChars - 80) {
        chunk.attachments.pop(); chunk.attachmentsTruncated = true
      }
      if (!chunk.attachments.length) delete chunk.attachments
    }
    const preview = chunk.text
    let low = 0; let high = preview.length
    const update = (size: number) => {
      chunk.text = sliceText(preview, 0, size)
      chunk.nextOffset = offset + chunk.text.length
      chunk.hasMore = chunk.nextOffset < fullText.length
      chunk.truncated = offset > 0 || chunk.hasMore
    }
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      update(mid)
      if (JSON.stringify(chunk).length <= maxChars) low = mid
      else high = mid - 1
    }
    update(low)
  }
  return chunk
}
