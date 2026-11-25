import { createHash, randomUUID } from 'node:crypto'
import { tokenize } from './memory'
import type { RuntimeCase, RuntimeExperience, RuntimeTask } from './types'

/** 被用满这么多次的经验才进常驻摘要；摘要最多带几条。 */
export const EXPERIENCE_ESTABLISHED_USES = 3
export const EXPERIENCE_SUMMARY_LIMIT = 3
/** 平台和工具集的指纹：变了就说明这份经验未必还适用。 */
export function experienceFingerprint(platform: string, toolNames: string[]): string {
  return createHash('sha256').update(JSON.stringify([platform, [...toolNames].sort()])).digest('hex').slice(0, 16)
}

/** 任务完成后自动生成的候选：不调模型，取自卷宗和 Worker 的交付说明。 */
export function experienceCandidate(task: RuntimeTask, dossier: RuntimeCase, text: string, checks: string[], platform: string, fingerprint: string): RuntimeExperience {
  const now = Date.now()
  const approach = text.trim().split(/[\n。！？]/)[0]?.trim().slice(0, 200) || dossier.title
  return {
    id: `exp_${randomUUID()}`, botId: task.botId, state: 'active',
    object: dossier.object.slice(0, 200), goal: task.goal.slice(0, 300), approach,
    detail: text.slice(0, 4000), checks: checks.map(c => String(c).slice(0, 200)).slice(0, 20),
    verified: checks.length > 0, sourceTaskId: task.id, sourceCaseId: task.caseId,
    uses: 0, platform, toolFingerprint: fingerprint, createdAt: now, updatedAt: now,
  }
}

export interface ExperienceSelection { selected: RuntimeExperience[]; stale: string[] }
/** 用满次数的常驻（最多 3 条，按相关度、被用次数排）；不满 3 条时用相关的候选补位。指纹不符的标待复核，不进摘要。 */
export function selectExperiences(list: RuntimeExperience[], batchText: string, fingerprint: string): ExperienceSelection {
  const tokens = tokenize(batchText)
  const score = (e: RuntimeExperience) => { let n = 0; for (const token of tokenize(`${e.object} ${e.goal} ${e.approach}`)) if (token.length >= 2 && tokens.has(token)) n += 2; return n }
  const byRank = (a: RuntimeExperience, b: RuntimeExperience) => score(b) - score(a) || b.uses - a.uses || (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt) || a.id.localeCompare(b.id)
  const stale = list.filter(e => e.state === 'active' && !e.migrated && e.toolFingerprint !== fingerprint).map(e => e.id)
  const usable = list.filter(e => e.state === 'active' && (e.migrated || e.toolFingerprint === fingerprint))
  const selected = usable.filter(e => e.uses >= EXPERIENCE_ESTABLISHED_USES).sort(byRank).slice(0, EXPERIENCE_SUMMARY_LIMIT)
  if (selected.length < EXPERIENCE_SUMMARY_LIMIT) selected.push(...usable.filter(e => e.uses < EXPERIENCE_ESTABLISHED_USES && score(e) > 0).sort(byRank).slice(0, EXPERIENCE_SUMMARY_LIMIT - selected.length))
  return { selected, stale }
}

export interface ExperienceSummary { id: string; object: string; goal: string; approach: string; uses: number }
export function experienceSummary(e: RuntimeExperience): ExperienceSummary {
  return { id: e.id, object: e.object, goal: e.goal, approach: e.approach, uses: e.uses }
}
