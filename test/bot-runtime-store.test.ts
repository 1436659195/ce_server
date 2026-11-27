import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeInbox, RuntimeMandate } from '../src/cli/bot-runtime/types'

const roots: string[] = []
const stores: BotRuntimeStore[] = []
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ce-runtime-store-')); roots.push(root)
  const path = join(root, 'runtime.sqlite')
  const store = new BotRuntimeStore(path); stores.push(store)
  return { root, path, store }
}
function message(seq = 1): Omit<RuntimeInbox, 'id' | 'state'> {
  return { botId: 'bot-a', groupId: 'dm', seq, senderId: 'owner', memberId: 'member-owner', text: `原话 ${seq}`, createdAt: Date.now() }
}
const mandate: RuntimeMandate = { ownerPhoneId: 'owner', policyRevision: 1, directory: '/project', allowedOps: ['read', 'edit'], exclusions: ['发布'], mode: 'execute' }
function accepted(store: BotRuntimeStore) {
  const input = store.receive(message())
  const task = store.acceptWork({ inputId: input.id, newCase: { title: '论文 A', object: '论文 A', goal: '解读论文 A' }, goal: '写报告', acceptance: ['有方法分析'], mandate, replyText: '我先检查材料。' })
  return { input, task }
}

test('文件交付任务必须附真实成果；源附件消息不能跨 owner、Bot 或频道引用', () => {
  const { store } = fixture()
  const ref = { id: 'upload-one', kind: 'upload' as const, botId: 'bot-a', name: 'brief.txt', mime: 'text/plain', size: 1, hash: 'a'.repeat(64) }
  const source = store.receive({ ...message(), attachments: [ref] })
  const input = store.receive(message(10))
  const params = { inputId: input.id, newCase: { title: '报告', object: '材料', goal: '解读' }, goal: '写报告', acceptance: [], mandate, replyText: '我来整理报告。', delivery: 'files' as const }
  for (const patch of [{ senderId: 'other' }, { botId: 'other-bot' }, { groupId: 'other-dm' }]) {
    const foreign = store.receive({ ...message(3), ...patch, attachments: [ref] })
    expect(() => store.acceptWork({ ...params, sourceInputIds: [foreign.id] })).toThrow(/附件来源/)
  }
  const task = store.acceptWork({ ...params, sourceInputIds: [source.id] })
  expect(task.attachmentInputIds).toEqual([source.id])
  store.updateTask(task.id, { state: 'running' })
  expect(() => store.finishTask(task.id, 1, '报告写好了。', [])).toThrow(/附件/)
  expect(store.task(task.id)?.state).toBe('running')
  const additionMessage = store.receive(message(11))
  const addition = store.acceptInput({ inputId: additionMessage.id, taskId: task.id, expectedRevision: 1, kind: 'append', replyText: '可以。', sourceInputIds: [source.id] })
  expect(addition.attachments).toEqual([ref])
})

test('原消息去重且重开数据库保留原文与待路由状态', () => {
  const f = fixture()
  const first = f.store.receive(message())
  expect(f.store.receive({ ...message(), text: '重放不能改掉原文' }).id).toBe(first.id)
  f.store.close()
  const again = new BotRuntimeStore(f.path); stores.push(again)
  expect(again.inbox(first.id)).toMatchObject({ text: '原话 1', state: 'pending' })
  expect(again.pendingInbox('bot-a')).toHaveLength(1)
})

test('接单原子创建卷宗、工单、授权快照和前台 outbox；同一输入不重复派工', () => {
  const { store } = fixture(); const { input, task } = accepted(store)
  expect(store.tasks('bot-a')).toHaveLength(1)
  expect(store.cases('bot-a')).toHaveLength(1)
  expect(store.task(task.id)?.mandate).toEqual(mandate)
  expect(store.pendingReplies('bot-a')).toMatchObject([{ author: 'router', text: '我先检查材料。' }])
  expect(() => store.acceptWork({ inputId: input.id, newCase: { title: '重复', object: 'x', goal: 'x' }, goal: 'x', acceptance: [], mandate, replyText: '开始。' })).toThrow(/已处理/)
  expect(store.cases('bot-a')).toHaveLength(1)
})

test('已有任务补充保留原话、增加版本，过期完成不能丢弃补充', () => {
  const { store } = fixture(); const { task } = accepted(store)
  store.updateTask(task.id, { state: 'running' })
  const input = store.receive(message(2))
  const addition = store.acceptInput({ inputId: input.id, taskId: task.id, expectedRevision: 1, kind: 'append', replyText: '可以。' })
  expect(addition).toMatchObject({ text: '原话 2', revision: 2, delivery: 'pending' })
  expect(() => store.finishTask(task.id, 1, '已完成。', [])).toThrow(/版本/)
  expect(() => store.finishTask(task.id, 2, '已完成。', [])).toThrow(/输入/)
  store.consumeInput(addition.id, task.id)
  expect(() => store.finishTask(task.id, 2, '已完成。', [])).toThrow(/输入/)
  store.resolveInput(addition.id, task.id, '已在报告增加局限分析')
  store.finishTask(task.id, 2, '报告已完成。', [])
  expect(store.task(task.id)?.state).toBe('completed')
  expect(store.pendingReplies('bot-a')).toHaveLength(3)
})

test('旧卷宗可开新工单，不能借同一卷宗继承上次授权', () => {
  const { store } = fixture(); const { task } = accepted(store)
  const input = store.receive(message(2))
  const next = store.acceptWork({ inputId: input.id, caseId: task.caseId, goal: '改 HTML', acceptance: ['HTML 可打开'], mandate: { ...mandate, allowedOps: ['read', 'create'] }, replyText: '我把报告改成 HTML。' })
  expect(next.id).not.toBe(task.id)
  expect(next.caseId).toBe(task.caseId)
  expect(store.task(task.id)?.mandate.allowedOps).toEqual(['read', 'edit'])
  expect(next.mandate.allowedOps).toEqual(['read', 'create'])
})

test('跨 Bot 关联、停止后追加和仍有工具运行时结案均拒绝', () => {
  const { store } = fixture(); const { task } = accepted(store)
  const foreign = store.receive({ ...message(2), botId: 'bot-b' })
  expect(() => store.acceptInput({ inputId: foreign.id, taskId: task.id, expectedRevision: 1, kind: 'append', replyText: '可以。' })).toThrow(/归属/)
  store.updateTask(task.id, { state: 'running' })
  store.saveOperation({ id: 'op-1', botId: 'bot-a', taskId: task.id, runId: 'run-1', callId: 'call-1', tool: 'run_command', arguments: { command: 'test' }, operation: 'execute', policyRevision: 1, state: 'running', createdAt: Date.now() })
  expect(() => store.finishTask(task.id, 1, '完成。', [])).toThrow(/工具/)
  store.updateTask(task.id, { state: 'stopped' })
  const input = store.receive(message(3))
  expect(() => store.acceptInput({ inputId: input.id, taskId: task.id, expectedRevision: 1, kind: 'append', replyText: '可以。' })).toThrow(/状态/)
})

test('回复按逻辑 ID 去重，网络确认不改变业务任务，长度按可见字符检查', () => {
  const { store } = fixture(); const { task, input } = accepted(store)
  expect(() => store.reply({ botId: 'bot-a', groupId: 'dm', inputId: input.id, author: 'router', purpose: 'answer', text: '👨‍👩‍👧‍👦'.repeat(101), key: 'too-long', policyRevision: 1 })).toThrow(/100/)
  const first = store.reply({ botId: 'bot-a', groupId: 'dm', inputId: input.id, taskId: task.id, author: 'router', purpose: 'answer', text: '回答。', key: 'answer-one', policyRevision: 1 })
  expect(store.reply({ ...first, key: 'answer-one' }).id).toBe(first.id)
  store.markReplySent(first.id)
  expect(store.task(task.id)?.state).toBe('queued')
  expect(store.pendingReplies('bot-a')).toHaveLength(1)
})


test('升级迁移只执行一次，重启不把新Worker内部消息变成旧传输',()=>{
  const {store,path}=fixture()
  const source=store.reply({botId:'bot-a',groupId:'dm',author:'worker',purpose:'answer',text:'内部结果',key:'new-result',policyRevision:1})
  store.markReplyAttempted(source.id);store.close()
  const reopened=new BotRuntimeStore(path);stores.push(reopened)
  expect(reopened.replies('bot-a')[0]).not.toHaveProperty('legacyDeliveryRecovery')
  const db=new Database(path);expect(db.query('PRAGMA user_version').get()).toEqual({user_version:5});db.close()
})

test('旧设置里的手写经验一次性迁进经验表：保留历史，展示不算采用',()=>{
  const {store,path}=fixture()
  store.saveSettings({ ...store.settings('bot-a'), experiences: [{ id: 'old-1', summary: '论文解读经验', detail: '先看方法部分', source: '手写', active: true }] } as any)
  const db=new Database(path);db.exec('PRAGMA user_version=2');db.close()
  store.close()
  const reopened=new BotRuntimeStore(path);stores.push(reopened)
  expect(reopened.experience('old-1')).toMatchObject({state:'active',goal:'论文解读经验',approach:'论文解读经验',detail:'先看方法部分',uses:0,kind:'lesson',stats:{legacyExposures:3,adopted:0},toolFingerprint:'legacy',migrated:true})
  expect(reopened.settings('bot-a')).not.toHaveProperty('experiences')
  expect(reopened.experiences('bot-a')).toHaveLength(1)
  reopened.close()
  const again=new BotRuntimeStore(path);stores.push(again)
  expect(again.experiences('bot-a')).toHaveLength(1)
  const check=new Database(path);expect(check.query('PRAGMA user_version').get()).toEqual({user_version:5});check.close()
})
