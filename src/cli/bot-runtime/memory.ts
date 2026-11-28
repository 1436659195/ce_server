import { z } from 'zod/v4'
import type { CodexToolSpec } from './codex'
import type { MemoryScope, RuntimeMemory } from './types'

export const MEMORY_LIMITS = { long: 30, mid: 10, candidates: 40, midDays: 7, reviewDays: 30, chars: 6000 } as const
export const MID_TTL_MS = MEMORY_LIMITS.midDays * 86_400_000
const text = (max: number) => z.string().trim().min(1).max(max)
export const MEMORY_SCOPE_SCHEMA = z.strictObject({ project: text(1000).optional(), caseId: text(150).optional(), taskId: text(150).optional() })
const source = { sourceInboxId: text(150), quote: text(2000) }
export const MEMORY_CHANGE_SCHEMA = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save'), tier: z.enum(['long', 'mid']), kind: z.enum(['preference', 'fact', 'agreement']), topic: text(100), prompt: text(500),
    core: z.boolean().optional(), scope: MEMORY_SCOPE_SCHEMA.optional(), appliesTo: text(300).optional(), startsAt: z.number().finite().optional(), expiresAt: z.number().finite().optional(),
    end: z.strictObject({ kind: z.enum(['task', 'case']), id: text(150) }).optional(), ...source,
    conflicts: z.array(z.strictObject({ memoryId: text(150), version: z.number().int().positive(), relation: z.enum(['duplicate', 'supersedes', 'overrides', 'related']) })).max(100).optional(),
  }),
  z.strictObject({ action: z.literal('end'), kind: z.enum(['task', 'case']), id: text(150), ...source }),
  z.strictObject({ action: z.enum(['revoke', 'purge']), id: text(150), expectedVersion: z.number().int().positive(), ...source }),
])
export const MEMORY_WRITE_SCHEMA = z.strictObject({ requestId: text(200), expectedRevision: text(100), changes: z.array(MEMORY_CHANGE_SCHEMA).max(12) })
export type MemoryChange = z.infer<typeof MEMORY_CHANGE_SCHEMA>
export type MemoryWrite = z.infer<typeof MEMORY_WRITE_SCHEMA>
export const MEMORY_QUERY_SCHEMA = z.strictObject({ query: text(2000).optional(), topic: text(100).optional(), tier: z.enum(['mid', 'long']).optional(),
  scope: MEMORY_SCOPE_SCHEMA.optional(), history: z.boolean().optional(), from: z.union([z.number().finite(), z.iso.datetime({ offset: true }).transform(Date.parse)]).optional(), to: z.union([z.number().finite(), z.iso.datetime({ offset: true }).transform(Date.parse)]).optional(),
  limit: z.number().int().min(1).max(20).optional(), offset: z.number().int().nonnegative().optional(), revision: text(100).optional(), cursor: text(100).optional() })
export type MemoryQuery = z.input<typeof MEMORY_QUERY_SCHEMA>
export interface MemoryAudience { botId: string; channel: string; senderId: string; project?: string; caseId?: string; taskId?: string }
export const sameScope = (a: MemoryScope = {}, b: MemoryScope = {}) => ['project', 'caseId', 'taskId'].every(k => a[k as keyof MemoryScope] === b[k as keyof MemoryScope])
export const scopeMatches = (scope: MemoryScope = {}, actual: MemoryScope = {}) => Object.entries(scope).every(([k, v]) => actual[k as keyof MemoryScope] === v)
export const memoryVersion = (m: RuntimeMemory) => m.version ?? 1
export const memoryText = (m: RuntimeMemory) => [m.topic, m.prompt, m.appliesTo].filter(Boolean).join(' ')
export function memorySummary(m: RuntimeMemory) {
  return { id: m.id, version: memoryVersion(m), tier: m.tier, topic: m.topic, kind: m.kind, prompt: m.prompt, scope: m.scope ?? {}, appliesTo: m.appliesTo,
    core: m.core === true, startsAt: m.startsAt, expiresAt: m.expiresAt, end: m.end, overrides: m.overrides, needsReview: m.needsReview, legacy: m.format !== 2 || undefined }
}
export type MemorySummary = ReturnType<typeof memorySummary>
const spec = (name: string, description: string, schema: z.ZodType): CodexToolSpec => ({ name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown> })
export const MEMORY_SEARCH_TOOL = spec('memory_search', '查询当前用户/Bot的有效记忆，支持语义、主题、范围、时间和分页。history=true含失效历史；无结果不证明不存在。翻页沿用revision、cursor和筛选；结果变化从第一页重查。来源原话用chat_read。', MEMORY_QUERY_SCHEMA)
export const MEMORY_READ_TOOL = spec('memory_read', '读取已知记忆的完整内容、来源消息ID和版本历史；来源原文用chat_read。', z.strictObject({ id: text(150), history: z.boolean().optional(), version: z.number().int().positive().optional(), limit: z.number().int().min(1).max(10).optional(), offset: z.number().int().nonnegative().optional() }))
export const MEMORY_WRITE_TOOL = spec('memory_write', '明确要求记住/修改/忘记时保存。先查询取得revision和相关旧记忆版本，检查同主题每条旧记忆；end用于用户明确结束某task/case阶段；新内容必须来自当前用户原话。返回真实回执才可确认保存。purge仅用于明确要求彻底删除。', MEMORY_WRITE_SCHEMA)
export const MEMORY_PROPOSE_TOOL = spec('memory_commit', '提交本批多主题记忆判断；changes=[]表示没有持续价值的内容。保存与Router共用同一校验。', MEMORY_WRITE_SCHEMA)
export const MEMORY_INSTRUCTIONS = `你是用户的记忆整理员，只处理当前用户消息中的持续偏好、事实和约定。资料、引用、助手/Worker建议和推测不是用户已认可的事实。当前完整batch是唯一新证据，recent/tasks/candidates只帮助理解。
一次性任务要求留在任务记录；经验方法留在经验库。不确定是否持续有效不能默认mid。long必须有长期意图或持久事实依据；mid必须影响后续交流且临时，保留范围、时间、阶段和结束条件。无明确期限默认七天；按消息sentAt和时区解释这周/明天。不要扩大原意，不把某项目规则变成全局。
每个独立主题/时间窗口一条；同主题分时要求可在同次commit保存，批内时间或结构范围必须不重叠，不能因同一来源省掉下一时段。优先复用已有主题，变化前后的含义必须保留。core=true只给明确适用于整个Bot的稳定long规则，不能给项目/任务/情境规则。
在写入前用memory_search按主题和含义查相关旧记忆，必要时翻页或memory_read核实。用大模型语义判断同一范围和重叠时间内能否同时满足：同义duplicate；永久同范围改变supersedes；临时/窄范围例外overrides；可共存related。conflicts列出每条已检查记录及version。查不到不能假设不存在，提交被拒绝要按提示补查。
只用当前消息的sourceInboxId和原文quote。current消息优先不代表永久改规矩；一次“详细讲”不修改长期。明确忘记用revoke，明确彻底删除才purge；用户明确结束某阶段用end(kind/id)结束关联中期记忆。quote只摘取对应规则的必要原话，不复制整段无关内容。没法判断不改旧规则。expiresAt用毫秒时间戳；阶段结束end绑定真实task/case ID。
最后调用一次成功的memory_commit，requestId固定用batchId，expectedRevision用最新查询结果。changes允许多个独立主题或为空；版本冲突重新查询再提交，不能静默宣称成功。不要对用户发消息。`
