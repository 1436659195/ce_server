import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import * as router from '../src/cli/bot-runtime/router'
import type { RouterBindings } from '../src/cli/bot-runtime/router'
import type { RuntimeBot } from '../src/cli/bot-runtime/types'

const bot: RuntimeBot = { botId: 'b', name: '示例同事', groupId: 'dm', ownerPhoneId: 'owner', platform: 'claude', sourceCwd: '/example', directory: '/example', policyRevision: 3, commandSandbox: false,
  permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
const call = (decision: Record<string, unknown>) => ({ decision, feasibility: 'can', replies: ['我看一下。'] })
const schema = () => z.fromJSONSchema(router.ROUTER_TOOLS.find(t => t.name === 'router_decide')!.inputSchema)
const bindings = (): RouterBindings => ({ policyRevision: 3, tasks: new Map([['t1', { revision: 2, questionId: 'q1', caseId: 'case-a' }]]), cases: new Map([['case-a', { revision: 3 }]]), currentInputIds: ['m1'], workerReplyId: undefined })
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
  const start = { action: 'start', goal: '解读材料', allowedOps: ['read'], delivery: 'chat', dossier: { kind: 'new', title: '示例材料', object: '材料A', goal: '理解材料A', reason: '新的独立材料，与已有卷宗对象不同' } }
  expect(schema().safeParse(call(start)).success).toBe(true)
  expect(schema().safeParse(call({ ...start, dossier: undefined })).success).toBe(false)
  expect(schema().safeParse(call({ ...start, dossier: { kind: 'existing', caseId: 'case-a', relation: 'follow_up', reason: '追问原材料' } })).success).toBe(true)
  expect(schema().safeParse(call({ ...start, dossier: { ...start.dossier, caseId: 'case-a' } })).success).toBe(false)
})

test('新卷宗必须说明独立边界；已有卷宗必须披露，改名绑定宿主元数据版本', () => {
  const start = { action: 'start', goal: '修改设计并另存', delivery: 'files', allowedOps: ['read', 'create'] }
  expect(() => bind(call({ ...start, dossier: { kind: 'new', title: '修订', object: '原文档', goal: '修改' } }))).toThrow()
  expect(() => bind(call({ ...start, dossier: { kind: 'existing', caseId: 'unknown', relation: 'revision', reason: '修改旧成果' } }))).toThrow(/披露|核对/)
  expect(bind(call({ ...start, dossier: { kind: 'existing', caseId: 'case-a', relation: 'revision', reason: '根据差异修订原设计', update: { title: '项目文档梳理与设计修订', goal: '整理总结、核对差异并修订设计' } } }))).toMatchObject({
    caseId: 'case-a', caseUpdate: { expectedRevision: 3, title: '项目文档梳理与设计修订', goal: '整理总结、核对差异并修订设计' }, caseDecision: { kind: 'existing', relation: 'revision', reason: '根据差异修订原设计' },
  })
})

test('活动任务的补充可以更新卷宗范围，但不能指定别的卷宗或伪造版本', () => {
  expect(bind(call({ action: 'append', taskId: 't1', caseUpdate: { title: '项目文档梳理', goal: '核对项目及其设计文档' } }))).toMatchObject({ caseId: 'case-a', caseUpdate: { expectedRevision: 3, title: '项目文档梳理' } })
  expect(() => bind(call({ action: 'append', taskId: 't1', caseUpdate: { title: '改名', expectedRevision: 999 } }))).toThrow()
  expect(() => bind(call({ action: 'append', taskId: 't1', caseUpdate: { title: '改名', caseId: 'foreign' } }))).toThrow()
})

test('仅披露截断范围时不能覆盖累计范围，需要先完整查询卷宗', () => {
  const snapshot = bindings(); snapshot.cases.set('case-a', { revision: 3, scopeComplete: false })
  expect(() => bind(call({ action: 'append', taskId: 't1', caseUpdate: { goal: '新的范围' } }), snapshot)).toThrow(/完整|case_search/)
  snapshot.cases.set('case-a', { revision: 3, scopeComplete: true })
  expect(bind(call({ action: 'append', taskId: 't1', caseUpdate: { goal: '已有工作并包含新的要求' } }), snapshot).caseUpdate?.goal).toBe('已有工作并包含新的要求')
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


test('执行约束作为任务参数传递，返工意见与版本由宿主绑定', () => {
  const snapshot = {...bindings(), workerReplyId:'source', workerSource:{worker:true,files:false}}
  expect(bind(call({action:'revise',taskId:'t1',feedback:'原需求缺少局限分析',executionGuidance:'保留原始引用'}),snapshot)).toMatchObject({action:'revise',taskId:'t1',expectedRevision:2,workerReplyId:'source',executionGuidance:'保留原始引用',feedback:'原需求缺少局限分析'})
  for (const action of ['append','ask_worker','answer']) expect(bind(call({action,taskId:'t1',executionGuidance:'本次结论保留原始引用'})).executionGuidance).toBe('本次结论保留原始引用')
  expect(()=>bind(call({action:'append',taskId:'t1',executionGuidance:'字'.repeat(4001)}))).toThrow()
})

test('Router验收文字结果时能看到Worker实际检查记录', () => {
  const context=JSON.parse(router.routerContext({bot,profile:'',messages:[],cases:[],tasks:[],experienceSummaries:[],workerMessage:{id:'source',key:'result',botId:'b',groupId:'dm',author:'worker',purpose:'result',text:'完成',checks:['实际执行了单元测试'],policyRevision:3,state:'pending',createdAt:1}}))
  expect(context.workerMessage.checks).toEqual(['实际执行了单元测试'])
})
