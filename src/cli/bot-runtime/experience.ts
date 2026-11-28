import { createHash, randomUUID } from 'node:crypto'
const CJK = /[㐀-鿿぀-ヿ]/u
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>(text.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? [])
  const chars = [...text].filter(c => CJK.test(c))
  for (let i = 0; i < chars.length; i++) { tokens.add(chars[i]); if (i) tokens.add(chars[i - 1] + chars[i]) }
  return tokens
}
import type { RuntimeCase, RuntimeExperience, RuntimeTask } from './types'

/** Legacy migration constant only; popularity no longer reserves slots. */
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
/** Compatibility selector for callers not yet using the library catalog. Impressions never rank lessons. */
export function selectExperiences(list: RuntimeExperience[], batchText: string, _fingerprint: string): ExperienceSelection {
  const tokens = tokenize(batchText)
  const score = (e: RuntimeExperience) => { let n = 0; for (const token of tokenize(`${e.title ?? ''} ${e.object} ${e.goal} ${e.approach} ${(e.pitfalls ?? []).join(' ')} ${(e.steps ?? []).join(' ')}`)) if (token.length >= 2 && tokens.has(token)) n += 2; return n }
  const usable = list.filter(e => e.state === 'active' && (e.kind === 'lesson' || (!e.kind && (e.migrated || /经验.*(?:总结|复盘)|(?:总结|复盘).*(?:经验|踩坑)|踩坑.*(?:总结|复盘)/.test(e.goal)))))
  return { selected: usable.filter(e => score(e) > 0).sort((a, b) => score(b) - score(a) || Number(b.verified) - Number(a.verified) || a.id.localeCompare(b.id)).slice(0, EXPERIENCE_SUMMARY_LIMIT), stale: [] }
}

export interface ExperienceSummary { id: string; object: string; goal: string; approach: string; uses: number }
export function experienceSummary(e: RuntimeExperience): ExperienceSummary {
  return { id: e.id, object: e.object, goal: e.goal, approach: e.approach, uses: e.uses }
}
