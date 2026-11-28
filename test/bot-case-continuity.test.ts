import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { routerContext } from '../src/cli/bot-runtime/router'
import type { RuntimeBot, RuntimeMandate } from '../src/cli/bot-runtime/types'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const mandate: RuntimeMandate = { ownerPhoneId: 'owner', directory: '/project', policyRevision: 1, allowedOps: ['read'], exclusions: [], mode: 'execute' }
const bot: RuntimeBot = { botId: 'b', name: '文档助理', groupId: 'dm', ownerPhoneId: 'owner', directory: '/project', sourceCwd: '/project', platform: 'codex', policyRevision: 1, commandSandbox: false,
  permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ce-case-continuity-'))
  const store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  let seq = 0
  const receive = (text: string) => store.receive({ botId: 'b', groupId: 'dm', senderId: 'owner', memberId: 'owner-member', seq: ++seq, text, createdAt: Date.now() })
  const start = (title = '项目文档总结') => store.acceptWork({ inputId: receive('根据项目写总结文档').id, newCase: { title, object: '示例项目的实现和设计文档', goal: '基于实现整理项目文档' }, goal: '编写总结', mandate, acceptance: [], replies: [] })
  return { store, receive, start }
}

test.each([undefined, 'files'] as const)('Router 披露任务交付方式 %s，保留具体格式且不猜测旧任务', delivery => {
  const { store, receive } = fixture()
  const task = store.acceptWork({ inputId: receive('整理为 TXT').id,
    newCase: { title: '排障指南', object: '示例服务', goal: '整理排障步骤' }, goal: '整理为 TXT',
    mandate, delivery, acceptance: ['交付 TXT 文件'], replies: [] })
  const context = JSON.parse(routerContext({
    bot, profile: '', messages: [], cases: store.cases('b'), tasks: store.tasks('b'),
    relatedTaskIds: [task.id], experienceSummaries: [],
  }))
  const disclosed = context.tasks.find((t: { id: string }) => t.id === task.id)
  expect(disclosed.delivery).toBe(delivery)
  expect(disclosed.acceptance).toEqual(['交付 TXT 文件'])
})

test('总结、对比、修改另存沿用卷宗，累计范围与旧名持久保存且不改变 Session', () => {
  const { store, receive, start } = fixture()
  const first = start()
  store.saveCase({ ...store.case(first.caseId)!, threadId: 'original-session', fingerprint: 'compatible' })
  store.updateTask(first.id, { state: 'completed' })
  const second = store.acceptWork({ inputId: receive('这个文档和设计文档哪里不一致').id, caseId: first.caseId, goal: '核对差异', mandate, acceptance: [], replies: [] })
  store.updateTask(second.id, { state: 'completed' })
  const third = store.acceptWork({ inputId: receive('不一致的地方修改下文档，另存最新设计文档').id, caseId: first.caseId,
    caseUpdate: { expectedRevision: 1, title: '项目文档梳理与设计修订', goal: '基于实现整理总结、核对设计差异，并修订设计文档' },
    goal: '修改并另存最新设计文档', mandate: { ...mandate, allowedOps: ['read', 'create', 'edit'] }, acceptance: ['保留原文档'], replies: [] })
  expect(store.cases('b')).toHaveLength(1)
  expect(third.caseId).toBe(first.caseId)
  expect(store.case(first.caseId)).toMatchObject({ title: '项目文档梳理与设计修订', goal: '基于实现整理总结、核对设计差异，并修订设计文档', aliases: ['项目文档总结'], revision: 2, threadId: 'original-session', fingerprint: 'compatible' })
  expect(store.task(first.id)!.mandate.allowedOps).toEqual(['read'])
  expect(third.mandate.allowedOps).toEqual(['read', 'create', 'edit'])
})

test('过期卷宗元数据更新整体拒绝，不新增工单或消耗用户消息', () => {
  const { store, receive, start } = fixture()
  const first = start(); const input = receive('修改文档')
  expect(() => store.acceptWork({ inputId: input.id, caseId: first.caseId, caseUpdate: { expectedRevision: 0, title: '过期名字' }, goal: '修改', mandate, acceptance: [], replies: [] })).toThrow(/卷宗.*版本/)
  expect(store.tasks('b')).toHaveLength(1)
  expect(store.inbox(input.id)?.state).toBe('pending')
})

test('没有实际改名不增加历史；恢复旧名仍保留两次名称可查', () => {
  const { store, receive, start } = fixture(); const first = start()
  const update = (title: string, expectedRevision: number) => store.acceptWork({ inputId: receive('继续').id, caseId: first.caseId, caseUpdate: { title, expectedRevision }, goal: '继续', mandate, acceptance: [], replies: [] })
  update('项目文档总结', 1)
  expect(store.case(first.caseId)?.revision).toBe(1)
  update('项目设计修订', 1)
  update('项目文档总结', 2)
  expect(store.case(first.caseId)?.aliases).toEqual(['项目设计修订'])
  expect(store.findCases('b', '项目设计修订').map(c => c.id)).toContain(first.caseId)
})

test('按旧名、任务、成果和多词查询卷宗，不跨 Bot 泄露候选', () => {
  const { store, receive, start } = fixture(); const first = start()
  store.acceptWork({ inputId: receive('修改').id, caseId: first.caseId, caseUpdate: { expectedRevision: 1, title: '设计修订' }, goal: '检查 websocket 重连逻辑', mandate, acceptance: [], replies: [] })
  store.saveArtifact({ id: 'a', botId: 'b', caseId: first.caseId, taskId: first.id, title: '架构核对报告', name: 'architecture-review.md', mime: 'text/markdown', path: '/unused', size: 1, hash: 'hash', revision: 1, createdAt: 1 })
  store.saveCase({ id: 'foreign', botId: 'other', title: '项目文档总结', object: '', goal: '', summary: '', createdAt: 1, updatedAt: 1 })
  for (const query of ['项目文档总结', 'websocket 重连', 'architecture review', '架构核对报告']) {
    expect(store.findCases('b', query).map(c => c.id)).toEqual([first.caseId])
  }
})

test('旧卷宗的活动任务和刚使用的卷宗优先披露，成果保留真实 caseId/taskId', () => {
  const { store, receive, start } = fixture(); const first = start('旧文档工作')
  store.updateTask(first.id, { state: 'running' })
  for (let i = 0; i < 7; i++) { const task = start(`其他工作${i}`); store.updateTask(task.id, { state: 'completed' }) }
  const artifact = { id: 'a', botId: 'b', caseId: first.caseId, taskId: first.id, title: '项目总结', mime: 'text/plain', path: '/private/never-expose', size: 1, hash: 'hash', revision: 1, createdAt: 1 }
  const input = receive('这个文档与设计哪里不一致')
  const text = routerContext({ bot, input, profile: '', messages: [store.inbox(first.originInputId)!], cases: store.cases('b'), tasks: store.tasks('b'), artifacts: [artifact], experienceSummaries: [] })
  const context = JSON.parse(text)
  expect(context.cases[0].id).toBe(first.caseId)
  expect(context.tasks.some((t: { id: string }) => t.id === first.id)).toBe(true)
  expect(context.recentMessages[0]).toMatchObject({ taskId: first.id, caseId: first.caseId })
  expect(context.cases[0].artifacts).toMatchObject([{ id: 'a', caseId: first.caseId, taskId: first.id, title: '项目总结' }])
  expect(text).not.toContain('/private/never-expose')
  store.updateTask(first.id, { state: 'completed' })
  store.saveCase({ ...store.case(first.caseId)!, updatedAt: Date.now() + 100 })
  const next = JSON.parse(routerContext({ bot, input, profile: '', messages: [], cases: store.cases('b'), tasks: [], experienceSummaries: [] }))
  expect(next.cases[0].id).toBe(first.caseId)
})

test('显式讨论中的旧成果优先于新建但无关的卷宗，任务和卷宗同时披露', () => {
  const { store, receive, start } = fixture(); const first = start('旧报告')
  store.updateTask(first.id, { state: 'completed' })
  for (let i = 0; i < 8; i++) { const task = start(`另一个项目${i}`); store.updateTask(task.id, { state: 'completed' }) }
  const context = JSON.parse(routerContext({ bot, input: receive('这个报告再补一节'), relatedTaskIds: [first.id], profile: '', messages: [], cases: store.cases('b'), tasks: store.tasks('b'), experienceSummaries: [] }))
  expect(context.cases[0].id).toBe(first.caseId)
  expect(context.tasks[0].id).toBe(first.id)
})

test('累计范围超过摘要长度仍完整披露，后续更新不会丢掉尾部的旧工作关系', () => {
  const { store, receive, start } = fixture(); const task = start()
  const goal = '既有工作。'.repeat(110) + '还包括原设计的兼容性说明'
  store.saveCase({ ...store.case(task.caseId)!, goal })
  const context = JSON.parse(routerContext({ bot, input: receive('继续修订'), profile: '', messages: [], cases: store.cases('b'), tasks: store.tasks('b'), experienceSummaries: [] }))
  expect(context.cases[0].goal).toBe(goal)
})
