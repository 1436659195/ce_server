import type { RuntimeArtifact, RuntimeCase, RuntimeTask } from './types'

const activeStates = new Set(['queued', 'running', 'waiting_user', 'stopping', 'recovering'])
const words = new Intl.Segmenter('zh', { granularity: 'word' })
/** 仅用于召回候选；是否属于同一工作链由 Router 结合原话、任务和成果判断。 */
function relevance(query: string, text: string): number {
  const q = query.toLocaleLowerCase().trim(); const haystack = text.toLocaleLowerCase()
  if (!q) return 0
  const terms = [...new Set([...words.segment(q)].filter(s => s.isWordLike).map(s => s.segment))]
  return (haystack.includes(q) ? 4 : 0) + terms.reduce((score, term) => score + (haystack.includes(term) ? 1 / Math.max(1, terms.length) : 0), 0)
}

export function selectCases(cases: RuntimeCase[], tasks: RuntimeTask[], artifacts: RuntimeArtifact[], options: { query?: string; relatedTaskIds?: string[]; searchOnly?: boolean; limit?: number } = {}): RuntimeCase[] {
  const linked = new Set(options.relatedTaskIds ?? [])
  return cases.map(dossier => {
    const work = tasks.filter(t => t.caseId === dossier.id && t.botId === dossier.botId)
    const files = artifacts.filter(a => a.caseId === dossier.id && a.botId === dossier.botId)
    const score = relevance(options.query ?? '', [dossier.title, ...(dossier.aliases ?? []), dossier.object, dossier.goal, dossier.summary, ...work.map(t => `${t.goal} ${t.summary}`), ...files.map(a => `${a.title} ${a.name ?? ''}`)].join('\n'))
    return { dossier, score, linked: work.some(t => linked.has(t.id)), active: work.some(t => activeStates.has(t.state)), updated: Math.max(dossier.updatedAt, ...work.map(t => t.updatedAt)) }
  }).filter(c => !options.searchOnly || c.score > 0)
    .sort((a, b) => (options.searchOnly ? 0 : Number(b.linked) - Number(a.linked) || Number(b.active) - Number(a.active)) || b.score - a.score || b.updated - a.updated || b.dossier.createdAt - a.dossier.createdAt)
    .slice(0, options.limit ?? 5).map(c => c.dossier)
}

export function selectTasks(tasks: RuntimeTask[], relatedTaskIds: string[] = [], limit = 6): RuntimeTask[] {
  const linked = new Set(relatedTaskIds)
  return [...tasks].sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || Number(activeStates.has(b.state)) - Number(activeStates.has(a.state)) || b.updatedAt - a.updatedAt).slice(0, limit)
}

/** 对前台只披露归属和摘要，不包含附件本机路径或 Session 内部标识。 */
export function caseSummary(dossier: RuntimeCase, tasks: RuntimeTask[], artifacts: RuntimeArtifact[]) {
  return {
    id: dossier.id, title: dossier.title, aliases: (dossier.aliases ?? []).slice(-5), object: dossier.object.slice(0, 200), goal: dossier.goal, summary: dossier.summary.slice(0, 300), revision: dossier.revision ?? 1,
    tasks: selectTasks(tasks.filter(t => t.caseId === dossier.id && t.botId === dossier.botId), [], 2).map(t => ({ id: t.id, caseId: t.caseId, goal: t.goal.slice(0, 200), state: t.state })),
    artifacts: artifacts.filter(a => a.caseId === dossier.id && a.botId === dossier.botId).slice(-3).map(a => ({ id: a.id, caseId: a.caseId, taskId: a.taskId, title: a.title.slice(0, 120), name: a.name?.slice(0, 120) })),
  }
}
