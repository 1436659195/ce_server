import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import * as router from '../src/cli/bot-runtime/router'
import type { RouterBindings } from '../src/cli/bot-runtime/router'
import type { RuntimeBot } from '../src/cli/bot-runtime/types'

const bot: RuntimeBot = { botId: 'b', name: '示例同事', groupId: 'dm', ownerPhoneId: 'owner', platform: 'claude', sourceCwd: '/example', directory: '/example', policyRevision: 3, commandSandbox: false,
  permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
const call = (decision: Record<string, unknown>) => ({ decision, feasibility: 'can', replies: ['我看一下。'] })
const schema = () => z.fromJSONSchema(router.ROUTER_TOOLS.find(t => t.name === 'router_decide')!.inputSchema)
const bindings = (): RouterBindings => ({ policyRevision: 3, tasks: new Map([['t1', { revision: 2, questionId: 'q1' }]]), currentInputIds: ['m1'], workerReplyId: undefined })
const bind = (value: Record<string, unknown>, snapshot = bindings(), liveBot = bot) => router.bindRouterDecision(value, liveBot, snapshot)

test('模型工具仅要求意图参数，不要求抄写权限版本和工单版本', () => {
  const valid = call({ action: 'ask_worker', taskId: 't1' })
  expect(schema().safeParse(valid).success).toBe(true)
  const sdkSchema = z.fromJSONSchema(router.ROUTER_TOOLS.find(t => t.name === 'router_decide')!.inputSchema) as z.ZodObject
  expect(z.object(sdkSchema.shape).safeParse(valid).success).toBe(true)
  expect(schema().safeParse({ ...valid, policyRevision: 3 }).success).toBe(false)
  expect(schema().safeParse(call({ action: 'ask_worker', taskId: 't1', expectedRevision: 2 })).success).toBe(false)
})

test('不同动作各有必填项，卷宗只能选新建或复用之一', () => {
  expect(schema().safeParse(call({ action: 'reply' })).success).toBe(true)
  expect(schema().safeParse(call({ action: 'ask_worker' })).success).toBe(false)
  const start = { action: 'start', goal: '解读材料', allowedOps: ['read'], delivery: 'chat', dossier: { kind: 'new', title: '示例材料', object: '材料A', goal: '理解材料A' } }
  expect(schema().safeParse(call(start)).success).toBe(true)
  expect(schema().safeParse(call({ ...start, dossier: undefined })).success).toBe(false)
  expect(schema().safeParse(call({ ...start, dossier: { kind: 'existing', caseId: 'case-a' } })).success).toBe(true)
  expect(schema().safeParse(call({ ...start, dossier: { ...start.dossier, caseId: 'case-a' } })).success).toBe(false)
})

test('工单与问题只绑定本轮已披露快照，不能凭空引用其他任务', () => {
  expect(bind(call({ action: 'ask_worker', taskId: 't1' }))).toMatchObject({ action: 'ask_worker', taskId: 't1', expectedRevision: 2, policyRevision: 3 })
  expect(bind(call({ action: 'answer', taskId: 't1' }))).toHaveProperty('questionId', 'q1')
  expect(() => bind(call({ action: 'ask_worker', taskId: 'unknown' }))).toThrow(/披露|读取|核对/)
  const snapshot = bindings(); snapshot.tasks.set('t1', { revision: 2, questionId: undefined })
  expect(() => bind(call({ action: 'answer', taskId: 't1' }), snapshot)).toThrow(/问题/)
})

test('聊天里说继续：resume 只需 taskId，工单版本由宿主绑定，不能凭空引用任务', () => {
  expect(bind(call({ action: 'resume', taskId: 't1' }))).toMatchObject({ action: 'resume', taskId: 't1', expectedRevision: 2, policyRevision: 3 })
  expect(schema().safeParse(call({ action: 'resume', taskId: 't1', expectedRevision: 2 })).success).toBe(false)
  expect(() => bind(call({ action: 'resume', taskId: 'unknown' }))).toThrow(/披露|读取|核对/)
})

test('权限变化不自动升级快照，Worker来源由宿主绑定且禁止模型伪造', () => {
  expect(() => bind(call({ action: 'reply' }), bindings(), { ...bot, policyRevision: 4 })).toThrow(/版本/)
  const snapshot = { ...bindings(), workerReplyId: 'source-1' }
  expect(bind(call({ action: 'reply' }), snapshot)).toHaveProperty('workerReplyId', 'source-1')
  expect(() => bind({ ...call({ action: 'reply' }), workerReplyId: 'forged' })).toThrow()
})

test('当前批次的附件自动关联，重复选择当前输入是无副作用的冗余；历史选择保留原ID供账本验权', () => {
  const request = call({ action: 'append', taskId: 't1', priorAttachmentMessageIds: ['m1', 'older-upload'] })
  expect(bind(request)).toMatchObject({ sourceInputIds: ['older-upload'], expectedRevision: 2 })
})

test('回答必要问题或专业追问也能明确选择历史附件并要求文件交付', () => {
  for (const action of ['answer', 'ask_worker']) {
    const request = call({ action, taskId: 't1', delivery: 'files', priorAttachmentMessageIds: ['older-upload'] })
    expect(schema().safeParse(request).success).toBe(true)
    expect(bind(request)).toMatchObject({ action, delivery: 'files', sourceInputIds: ['older-upload'], expectedRevision: 2 })
  }
})
