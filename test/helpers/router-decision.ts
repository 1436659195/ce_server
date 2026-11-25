/** 测试夹具的语义决策简写转换为模型当前真正使用的工具参数。 */
export function routerCall(p: Record<string, any>): Record<string, unknown> {
  const { action, feasibility = 'can', replies, replyText, basis, cancelReplyIds, workerReplyIndexes } = p
  const decision: Record<string, unknown> = { action }
  if (action === 'start') Object.assign(decision, {
    dossier: p.caseId ? { kind: 'existing', caseId: p.caseId } : { kind: 'new', ...p.newCase },
    goal: p.goal, delivery: p.delivery, allowedOps: p.allowedOps, acceptance: p.acceptance, exclusions: p.exclusions,
  })
  if (['append', 'ask_worker', 'answer', 'stop', 'resume'].includes(action)) decision.taskId = p.taskId
  if (['append', 'ask_worker', 'answer'].includes(action) && p.delivery) decision.delivery = p.delivery
  if (['start', 'append', 'ask_worker', 'answer'].includes(action) && p.sourceInputIds) decision.priorAttachmentMessageIds = p.sourceInputIds
  return { decision, feasibility, replies: replies ?? (replyText ? [replyText] : []), basis, cancelReplyIds, workerReplyIndexes }
}
