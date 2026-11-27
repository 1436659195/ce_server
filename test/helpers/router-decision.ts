/** 测试夹具的语义决策简写转换为模型当前真正使用的工具参数。 */
export function routerCall(p: Record<string, any>): Record<string, unknown> {
  const { action, feasibility = 'can', replies, replyText, basis, cancelReplyIds, workerReplyIndexes } = p
  const decision: Record<string, unknown> = { action }
  if (action === 'start') Object.assign(decision, {
    dossier: p.caseId ? { kind: 'existing', caseId: p.caseId, relation: p.relation ?? 'next_step', reason: p.caseReason ?? '延续原工作及成果', update: p.caseUpdate } : { kind: 'new', ...p.newCase, reason: p.caseReason ?? '独立工作对象，没有可承接的已有卷宗' },
    goal: p.goal, delivery: p.delivery, allowedOps: p.allowedOps, acceptance: p.acceptance, exclusions: p.exclusions,
  })
  if (['append', 'ask_worker', 'answer', 'stop', 'resume', 'approve_directory', 'revise'].includes(action)) decision.taskId = p.taskId
  if (['append', 'ask_worker', 'answer', 'revise'].includes(action) && p.delivery) decision.delivery = p.delivery
  if (['append', 'ask_worker', 'answer'].includes(action) && p.caseUpdate) decision.caseUpdate = p.caseUpdate
  if (['start', 'append', 'ask_worker', 'answer'].includes(action) && p.sourceInputIds) decision.priorAttachmentMessageIds = p.sourceInputIds
  if (['start', 'append', 'ask_worker', 'answer', 'revise'].includes(action) && p.executionGuidance !== undefined) decision.executionGuidance = p.executionGuidance
  if (['start', 'append', 'ask_worker', 'answer', 'revise'].includes(action) && p.experienceRefs !== undefined) decision.experienceRefs = p.experienceRefs
  if (action === 'revise') decision.feedback = p.feedback
  return { decision, feasibility, replies: replies ?? (replyText ? [replyText] : []), basis, cancelReplyIds, workerReplyIndexes, ...(p.acceptLesson !== undefined ? { acceptLesson: p.acceptLesson } : {}) }
}
