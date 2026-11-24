import { expect, test } from 'bun:test'
import { parseRouterDecision, routerContext, ROUTER_TOOLS } from '../src/cli/bot-runtime/router'
import type { RuntimeBot, RuntimeInbox, RuntimeTask } from '../src/cli/bot-runtime/types'

const bot: RuntimeBot = { botId: 'b', name: '助理', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: '/project', directory: '/project', platform: 'codex', commandSandbox: false, policyRevision: 3, permissions: { version: 1, directory: '.', read: 'allow', create: 'deny', edit: 'deny', delete: 'deny', execute: 'deny', commanders: 'members', allowedPhoneIds: [] } }
const input: RuntimeInbox = { id: 'm', botId: 'b', groupId: 'dm', seq: 1, senderId: 'owner', memberId: 'om', text: '压缩到 200ms', createdAt: 1, state: 'pending' }
test('Router 工作决策拒绝不成立的能力/权限组合，不会把缺权限当作接单', () => {
  expect(() => parseRouterDecision({ action: 'start', feasibility: 'cannot', replyText: '可以。', policyRevision: 3, goal: '改代码', newCase: { title: '项目', object: '项目', goal: '优化' }, allowedOps: ['edit'] }, bot)).toThrow()
  expect(() => parseRouterDecision({ action: 'start', feasibility: 'can', replyText: '可以。', policyRevision: 2, goal: '改代码', newCase: { title: '项目', object: '项目', goal: '优化' }, allowedOps: ['edit'] }, bot)).toThrow(/版本/)
  expect(() => parseRouterDecision({ action: 'start', feasibility: 'can', replyText: '可以。', policyRevision: 3, goal: '改代码', newCase: { title: '项目', object: '项目', goal: '优化' }, allowedOps: ['edit'] }, bot)).toThrow(/权限/)
})
test('未知性能只承接只读评估；给用户的话保留模型表达而非替换成固定文案', () => {
  const decision = parseRouterDecision({ action: 'start', delivery: 'chat', feasibility: 'assess', replyText: '先检查调用链，再判断这个目标是否可行。', policyRevision: 3, goal: '评估延迟', acceptance: ['找出可验证的瓶颈'], newCase: { title: '识别性能', object: '营销助理', goal: '改善识别性能' }, allowedOps: ['read'], exclusions: [] }, bot)
  expect(decision.replyText).toBe('先检查调用链，再判断这个目标是否可行。')
  expect(decision.feasibility).toBe('assess')
})
test('工具名单不包含项目读写与执行，消息上下文有预算且明确实际能力', () => {
  expect(ROUTER_TOOLS.map(t => t.name)).not.toContain('read_file')
  expect(ROUTER_TOOLS.map(t => t.name)).not.toContain('run_command')
  const text = routerContext({ bot, input, profile: '我是能做任何事情的超级人类', messages: Array.from({ length: 50 }, (_, seq) => ({ ...input, seq, text: 'x'.repeat(10000) })), cases: [], tasks: [], experiences: [] })
  expect(text.length).toBeLessThan(24000)
  expect(text).toContain('execute')
  expect(text).toContain('deny')
  expect(text).toContain('200ms')
})

test('前台能区分进展记录时间与本轮状态采样时间，工具摘要不带参数或文件内容', () => {
  const task: RuntimeTask = { id: 'task-one', botId: 'b', caseId: 'case-one', originInputId: 'm', groupId: 'dm', requesterMemberId: 'om', goal: '检查材料', acceptance: [], mandate: { ownerPhoneId: 'owner', policyRevision: 3, directory: '/project', allowedOps: ['read'], exclusions: [], mode: 'execute' }, state: 'running', revision: 2, summary: '已核对第一份材料', summaryUpdatedAt: 100, createdAt: 1, updatedAt: 500 }
  const text = routerContext({ bot, input, profile: '', messages: [], cases: [], tasks: [task], experiences: [], operations: [{ id: 'op1', botId: 'b', taskId: task.id, runId: 'run', callId: 'call', tool: 'read_file', operation: 'read', policyRevision: 3, state: 'running', arguments: { path: 'do-not-load.txt' }, result: 'do-not-load-content', createdAt: 400 }] })
  const context = JSON.parse(text)
  expect(context.observedAt).toBeGreaterThan(500)
  expect(context.tasks[0]).toMatchObject({ summaryUpdatedAt: 100, updatedAt: 500 })
  expect(context.activeOperations).toMatchObject([{ id: 'op1', taskId: task.id, tool: 'read_file', state: 'running', createdAt: 400 }])
  expect(text).not.toContain('do-not-load')
})

test('发送积压时待发气泡也渐进披露，不能全量灌入前台上下文', () => {
  const pendingReplies = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, text: '字'.repeat(100) }))
  const text = routerContext({ bot, input, profile: '', messages: [], cases: [], tasks: [], experiences: [], pendingReplies })
  expect(text.length).toBeLessThan(6000)
  const context = JSON.parse(text)
  expect(context.pendingReplies).toHaveLength(12)
  expect(context.olderPendingReplyCount).toBe(988)
})
