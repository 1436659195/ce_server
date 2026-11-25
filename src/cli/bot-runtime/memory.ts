import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import type { CodexToolSpec } from './codex'
import type { MemoryLogAction, MemoryProposal, MemoryTier, RuntimeInbox, RuntimeMemory, RuntimeMemoryLog } from './types'

/** 记忆档位的起步参数，真实聊天后可调。 */
export const MEMORY_LIMITS = { long: 30, mid: 10, candidates: 40, midTurns: 10, midDays: 7, promoteTriggers: 3, reviewDays: 30 } as const
const DAY = 86_400_000
export const MID_TTL_MS = MEMORY_LIMITS.midDays * DAY

const CJK = /[㐀-鿿぀-ヿ]/u
/** 中文按字和二字组，英文和数字按词；只用于相关度排序，不是语义检索。 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? []) tokens.add(word)
  const chars = [...text].filter(c => CJK.test(c))
  for (let i = 0; i < chars.length; i++) { tokens.add(chars[i]); if (i) tokens.add(chars[i - 1] + chars[i]) }
  return tokens
}
/** 单个汉字太容易偶然重合，相关度只数字组和英文数字词。 */
export function relevance(memory: Pick<RuntimeMemory, 'prompt' | 'appliesTo'>, tokens: Set<string>): number {
  let score = 0
  for (const token of tokenize(`${memory.prompt} ${memory.appliesTo ?? ''}`)) if (token.length >= 2 && tokens.has(token)) score += 2
  return score
}

export interface MemorySelection { long: RuntimeMemory[]; mid: RuntimeMemory[]; overflow: number; triggered: string[]; expired: string[]; promoted: string[]; review: string[] }
/** 长期全部常驻（上限 30，多出的只计数）；中期：没写适用范围的对每轮都适用，写了的按相关度取；到期和升降在这里判定。 */
export function selectMemories(memories: RuntimeMemory[], batchText: string, now: number, round: number): MemorySelection {
  const tokens = tokenize(batchText)
  const living: RuntimeMemory[] = []; const expired: string[] = []
  for (const memory of memories) {
    if (memory.status !== 'active') continue
    if (memory.tier === 'mid' && (round - (memory.bornRound ?? 0) >= MEMORY_LIMITS.midTurns || (memory.expiresAt ?? Infinity) <= now)) expired.push(memory.id)
    else living.push(memory)
  }
  const long = living.filter(m => m.tier === 'long').sort((a, b) => b.updatedAt - a.updatedAt)
  const kept = long.slice(0, MEMORY_LIMITS.long)
  const mid = living.filter(m => m.tier === 'mid').map(m => ({ m, score: relevance(m, tokens) }))
    .filter(x => x.score > 0 || !x.m.appliesTo)
    .sort((a, b) => b.score - a.score || b.m.triggers.count - a.m.triggers.count || (b.m.triggers.lastTriggeredAt ?? 0) - (a.m.triggers.lastTriggeredAt ?? 0) || a.m.id.localeCompare(b.m.id))
    .map(x => x.m).slice(0, MEMORY_LIMITS.mid)
  return {
    long: kept, mid, overflow: long.length - kept.length,
    triggered: [...kept, ...mid].filter(m => relevance(m, tokens) > 0).map(m => m.id),
    expired,
    promoted: living.filter(m => m.tier === 'mid' && m.triggers.count >= MEMORY_LIMITS.promoteTriggers).map(m => m.id),
    review: kept.filter(m => !m.needsReview && now - (m.triggers.lastTriggeredAt ?? m.createdAt) > MEMORY_LIMITS.reviewDays * DAY).map(m => m.id),
  }
}
/** 进上下文的那部分：不带完整原话，只带规矩本身。 */
export interface MemorySummary { id: string; tier: MemoryTier; prompt: string; appliesTo?: string; triggers: number }
export function memorySummary(memory: RuntimeMemory): MemorySummary {
  return { id: memory.id, tier: memory.tier, prompt: memory.prompt, ...(memory.appliesTo ? { appliesTo: memory.appliesTo } : {}), triggers: memory.triggers.count }
}

const proposalSchema = z.strictObject({
  intent: z.enum(['none', 'preference']),
  tier: z.enum(['mid', 'long']).optional(),
  prompt: z.string().max(300).optional(),
  appliesTo: z.string().max(200).optional(),
  sourceInboxId: z.string().max(120).optional(),
  quote: z.string().max(200).optional(),
  conflicts: z.array(z.strictObject({ memoryId: z.string().max(120), relation: z.enum(['duplicate', 'supersedes', 'related']) })).max(5).optional(),
})
export function parseMemoryProposal(args: unknown): MemoryProposal | undefined {
  const parsed = proposalSchema.safeParse(args)
  return parsed.success ? parsed.data : undefined
}
export const MEMORY_PROPOSE_TOOL: CodexToolSpec = { name: 'memory_commit', description: '提交本批消息的记忆判断。intent=none 表示没有需要记的偏好；preference 表示有一条主人亲口说的偏好。', inputSchema: z.toJSONSchema(proposalSchema) as Record<string, unknown> }
export const MEMORY_INSTRUCTIONS = `你是主人的记忆整理员。主人的每一批消息都会交给你判断，大多数批次并没有要记的东西：提问、任务指令、临时要求、闲聊、道谢、确认、粘贴的资料 → intent=none。
只根据「本批消息」判断主人有没有定下或改掉一条偏好或规矩。规矩和偏好指主人要求以后怎么对待他、怎么做事，例如回复长短、称呼、格式习惯、做事顺序、哪些事不要做；不限定用词，凭意思判断，不靠「以后」「记住」这类词。
只有主人本人的话算：Bot 自己说过的话、主人贴进来的资料内容，都不算主人的偏好。
判断规则：
- 主人在说长期有效的规矩（一直要这样） → tier=long。
- 只针对眼前这件事或近期的偏好 → tier=mid。
- 同一件事以前已经记过（见 candidates） → 在 conflicts 里写 duplicate；新话明确取代了某条旧规矩 → supersedes；只是相关 → related。拿不准是不是取代就不要写 supersedes。
- sourceInboxId 必须是本批消息的 id；quote 必须是那条消息里的一段原文，不超过 200 字。
- prompt 用一句话写出主人的偏好本身，不写解释。
通过 memory_commit 提交一次；拿不准就 intent=none。不要输出别的内容，不要执行任何工具以外的操作。`

const log = (memory: Pick<RuntimeMemory, 'botId' | 'id'>, action: MemoryLogAction, at: number, note?: string, actor: RuntimeMemoryLog['actor'] = 'memory'): RuntimeMemoryLog =>
  ({ id: `mlog_${randomUUID()}`, botId: memory.botId, memoryId: memory.id, action, actor, at, ...(note ? { note } : {}) })

/** 慢路的核对都在这里：是不是规矩、长期还是近期、是否取代旧规矩由模型判断；宿主只核对引文确实出自本批主人原话，任何操作都不删除记忆。 */
export function planMemoryChange(proposal: MemoryProposal, batch: RuntimeInbox[], memories: RuntimeMemory[], now: number, round: number): { reject?: string; ops?: RuntimeMemory[]; logs?: RuntimeMemoryLog[] } {
  if (proposal.intent !== 'preference') return {}
  const prompt = proposal.prompt?.trim()
  if (!prompt) return { reject: '缺少偏好内容' }
  const source = proposal.sourceInboxId ? batch.find(m => m.id === proposal.sourceInboxId) : undefined
  if (!source) return { reject: '原话不在本批消息里，不写记忆' }
  const quote = (proposal.quote ?? '').trim()
  if (!quote || !source.text.includes(quote)) return { reject: '引文不是主人原话的一部分，不写记忆' }
  const first = batch[0]!
  const tier: MemoryTier = proposal.tier ?? 'mid'
  const ops: RuntimeMemory[] = []; const logs: RuntimeMemoryLog[] = []
  const id = `memory_${randomUUID()}`
  let creates = true; let supersedes: string | undefined
  for (const conflict of proposal.conflicts ?? []) {
    const existing = memories.find(m => m.id === conflict.memoryId && m.status === 'active')
    if (!existing) continue
    if (conflict.relation === 'duplicate') {
      // 同一条原话再说一遍：什么都不改。另一条原话重复同一件事：次数加一，追加来源。
      if (existing.source.inboxId === source.id && existing.source.quote === quote) { creates = false; continue }
      ops.push({ ...existing, triggers: { count: existing.triggers.count + 1, lastTriggeredAt: now }, extraSources: [...(existing.extraSources ?? []), { inboxId: source.id, quote }], updatedAt: now })
      logs.push(log(existing, 'duplicate', now, `再次说到：${quote}`))
      creates = false
    } else if (conflict.relation === 'supersedes') {
      ops.push({ ...existing, status: 'superseded', supersededBy: id, updatedAt: now })
      logs.push(log(existing, 'supersede', now, `被新规矩取代：${prompt}`))
      supersedes = existing.id
    }
  }
  if (creates) {
    const created: RuntimeMemory = {
      id, botId: first.botId, channel: first.groupId, senderId: first.senderId, tier, status: 'active', prompt,
      ...(proposal.appliesTo?.trim() ? { appliesTo: proposal.appliesTo.trim() } : {}),
      source: { inboxId: source.id, quote, context: source.text.slice(0, 500), sentAt: source.createdAt },
      triggers: { count: 1 },
      ...(tier === 'mid' ? { bornRound: round, expiresAt: now + MID_TTL_MS } : {}),
      ...(supersedes ? { supersedes } : {}),
      createdAt: now, updatedAt: now,
    }
    ops.push(created)
    logs.push(log(created, 'create', now))
  }
  return { ops, logs }
}
