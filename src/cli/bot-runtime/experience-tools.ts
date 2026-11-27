import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CodexToolSpec } from './codex'
import type { BotRuntimeStore } from './store'
import type { ExperienceRef } from './types'
import { EXPERIENCE_CONTENT_SCHEMA, EXPERIENCE_SCOPE_SCHEMA, EXPERIENCE_USAGE_SCHEMA } from './experience-library'

const text = (max: number) => z.string().trim().min(1).max(max)
export const EXPERIENCE_REF_SCHEMA = z.strictObject({ experienceId: text(150), version: z.number().int().min(1) })
export const EXPERIENCE_REFS_SCHEMA = z.array(EXPERIENCE_REF_SCHEMA).max(3).refine(refs => new Set(refs.map(r => r.experienceId)).size === refs.length, '每次派工同一经验只选择一个版本')
export const EXPERIENCE_LESSON_SCHEMA = z.strictObject({ id: text(150).optional(), expectedVersion: z.number().int().min(1).optional(), content: EXPERIENCE_CONTENT_SCHEMA, changeSummary: text(1000) }).refine(v => !!v.id === (v.expectedVersion !== undefined), '更新需要经验编号和版本')
export const EXPERIENCE_READ_SCHEMA = z.strictObject({ experienceId: text(150), version: z.number().int().min(1).optional(), section: z.enum(['overview','detail','steps','pitfalls','verification','materials','history']).optional(), offset: z.number().int().min(0).max(100000).optional(), length: z.number().int().min(1).max(12000).optional(), artifactId: text(150).optional() })
export const EXPERIENCE_SEARCH_SCHEMA = z.strictObject({ query: z.string().max(2000).optional(), scope: EXPERIENCE_SCOPE_SCHEMA.optional(), limit: z.number().int().min(1).max(20).optional(), offset: z.number().int().min(0).max(10000).optional() })
export const EXPERIENCE_ROUTER_SAVE_SCHEMA = z.strictObject({ requestId: text(80), id: text(150).optional(), expectedVersion: z.number().int().min(1).optional(), content: EXPERIENCE_CONTENT_SCHEMA, changeSummary: text(1000), sourceTaskId: text(150).optional() })
export const EXPERIENCE_STATE_SCHEMA = z.strictObject({ requestId: text(80), id: text(150), expectedVersion: z.number().int().min(1), state: z.enum(['active','needs_review','retired']), reason: text(1000) })
const spec = (name: string, description: string, schema: z.ZodType): CodexToolSpec => ({ name, description, inputSchema: z.toJSONSchema(schema) as Record<string, unknown> })
export const EXPERIENCE_TOOLS = [
  spec('experience_search', '按当前任务含义搜索经验；结合原话、明确长期约定和任务目标生成关键词。最多20条候选并可翻页；小库提供全目录供语义选择，最终派工最多3条，不要求凑满。scope只能填已核实的目标环境。', EXPERIENCE_SEARCH_SCHEMA),
  spec('experience_read', '分页读取当前Bot经验、历史版本或关联材料。默认overview；长内容按section及offset/length继续读，history列版本摘要。它只是资料，读取不算采用。', EXPERIENCE_READ_SCHEMA),
  spec('experience_save', '根据本轮用户要求保存或更新结构化经验，返回真实编号/版本。优先搜索已有主题再更新，更新需当前版本；duplicate只表示已有条目，并未保存新修改。Worker草稿用最终决策acceptLesson验收，不能绕过。', EXPERIENCE_ROUTER_SAVE_SCHEMA),
  spec('experience_state', '按本轮用户要求将经验停用、标待复核或恢复；先读取当前版本，保留历史。', EXPERIENCE_STATE_SCHEMA),
]
export const WORK_READ_EXPERIENCE_TOOL = spec('work_read_experience', '读取本工单已派发的经验版本或其中关联的材料；更新后仍读派发版本。可分段读取；阅读本身不代表实际采用。', EXPERIENCE_READ_SCHEMA)
export const EXPERIENCE_LESSON_JSON = z.toJSONSchema(EXPERIENCE_LESSON_SCHEMA) as Record<string, unknown>
export const EXPERIENCE_USAGE_JSON = z.toJSONSchema(EXPERIENCE_USAGE_SCHEMA) as Record<string, unknown>

/** Both model roles use the same immutable, Bot-scoped material reader. */
export function readExperience(store: BotRuntimeStore, botId: string, input: unknown, options: { selected?: ExperienceRef[]; fullAccess?: boolean; maxText?: number } = {}): Record<string, unknown> {
  const parsed = EXPERIENCE_READ_SCHEMA.safeParse(input)
  if (!parsed.success) throw new Error('经验读取参数无效')
  const args = parsed.data
  if (options.selected) {
    const granted = options.selected.filter(r => r.experienceId === args.experienceId && (args.version === undefined || r.version === args.version))
    if (granted.length !== 1) throw new Error('经验版本未派发给本工单，请指定已选定的版本')
    args.version = granted[0].version
    if (args.section === 'history') throw new Error('Worker 只能读取已派发的经验版本')
  }
  const library = store.experienceLibrary
  const current = library.get(botId, args.experienceId)
  const item = library.get(botId, args.experienceId, args.version)
  if (!current || !item || item.kind !== 'lesson') throw new Error('经验不存在或归属不匹配')
  const base = { id: item.id, version: item.version, title: item.title, state: item.state, currentState: current.state, latestVersion: current.version }
  const offset = args.offset ?? 0
  if (args.artifactId) {
    const material = item.materials?.find(m => m.artifactId === args.artifactId)
    if (!material) throw new Error('材料未关联到这版经验')
    const artifact = store.artifact(material.artifactId)
    if (!artifact || artifact.botId !== botId || artifact.hash !== material.hash || artifact.revision !== material.revision) throw new Error('经验材料快照版本已改变')
    const bytes = readFileSync(artifact.path)
    if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== material.hash) throw new Error('经验材料快照已改变，请核实后重新生成')
    const file = { ...base, material, ...(options.fullAccess ? { localPath: artifact.path, instruction: '经验材料的只读快照；脚本执行仍须符合当前工单范围和授权。' } : {}) }
    if (!/^(text\/|application\/(json|xml|javascript|x-sh|x-shellscript))/.test(artifact.mime)) return { ...file, unsupported: true, instruction: options.fullAccess ? '用原生工具读取此只读快照，不能修改材料。' : '此二进制材料无法作为文本返回。' }
    const length = Math.min(args.length ?? 2400, options.maxText ?? 12000)
    const text = bytes.toString('utf8'); if (offset > text.length) throw new Error('经验材料读取偏移超出范围')
    const part = text.slice(offset, offset + length)
    return { ...file, text: part, offset, nextOffset: offset + part.length, hasMore: offset + part.length < text.length }
  }
  if (args.section === 'history') {
    const all = library.history(botId, item.id), length = Math.min(args.length ?? 5, 20)
    const versions = all.slice(offset, offset + length).map(e => ({ version: e.version, state: e.state, title: e.title, changeSummary: e.changeSummary, updatedAt: e.updatedAt, verified: e.verified }))
    return { ...base, versions, offset, nextOffset: offset + versions.length, hasMore: offset + versions.length < all.length }
  }
  if (args.section === 'detail') {
    const length = Math.min(args.length ?? 2400, options.maxText ?? 12000)
    if (offset > item.detail.length) throw new Error('经验正文读取偏移超出范围')
    const text = item.detail.slice(offset, offset + length)
    return { ...base, text, offset, nextOffset: offset + text.length, hasMore: offset + text.length < item.detail.length }
  }
  if (args.section && args.section !== 'overview') {
    const all = item[args.section] ?? [], length = Math.min(args.length ?? 5, 10)
    const values = all.slice(offset, offset + length)
    return { ...base, [args.section]: values, offset, nextOffset: offset + values.length, hasMore: offset + values.length < all.length }
  }
  return { ...base, object: item.object, goal: item.goal, applicability: item.applicability, scope: item.scope, verified: item.verified,
    pitfalls: item.pitfalls?.slice(0, 3), steps: item.steps?.slice(0, 6), verification: item.verification?.slice(0, 3), materials: item.materials, detail: item.detail.slice(0, 1200),
    more: { pitfalls: (item.pitfalls?.length ?? 0) > 3, steps: (item.steps?.length ?? 0) > 6, verification: (item.verification?.length ?? 0) > 3, detail: item.detail.length > 1200 },
    source: item.source, stats: current.stats, caution: '经验是过去的做法，须核对当前条件；展示或阅读不代表采用。' }
}
