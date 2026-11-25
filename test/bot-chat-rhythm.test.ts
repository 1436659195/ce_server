import { routerCall } from './helpers/router-decision'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isControlUtterance, parseRouterDecision } from '../src/cli/bot-runtime/router'
import { BotRuntimeService, ROUTER_MAX_WAIT_MS, ROUTER_QUIET_MS, type RuntimeClientOptions } from '../src/cli/bot-runtime/service'
import { silentMemoryClient } from './helpers/model-client'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { CodexTurn } from '../src/cli/bot-runtime/codex'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}
/** 不传参数用测试节奏；传 'defaults' 则不覆盖，走生产默认的安静期与封顶。 */
function fixture(timing: { routerQuietMs?: number; routerMaxWaitMs?: number } | 'defaults' = { routerQuietMs: 40, routerMaxWaitMs: 100 }) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-chat-rhythm-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'b', name: '小林', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: dir, directory: dir, platform: 'codex', policyRevision: 1, commandSandbox: false,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  const turns: Array<{ context: any; decide: (args: Record<string, unknown>) => Promise<any>; finish: () => void }> = []
  const sent: RuntimeReply[] = []
  const service = new BotRuntimeService({ store, rootDir: dir, ...(timing === 'defaults' ? {} : timing), bubbleGapMs: 100,
    getBot: () => bot, sendReply: async reply => { sent.push(reply) }, checkAccess: async () => { throw new Error('no worker') }, openTools: () => { throw new Error('no worker') },
    createClient: (role, options: RuntimeClientOptions) => {
      if (role === 'worker') throw new Error('test leaves tasks queued')
      if (role === 'memory') return silentMemoryClient()
      let resolve: ((turn: CodexTurn) => void) | undefined
      return { initialize: async () => {}, startThread: async () => 'thread', resumeThread: async id => id,
        startTurn: async (threadId, text) => {
          const turnId = `turn-${turns.length}`
          const done = new Promise<CodexTurn>(r => { resolve = r })
          const complete = resolve!
          turns.push({ context: JSON.parse(text), decide: args => options.onToolCall({ threadId, turnId, callId: turnId, tool: 'router_decide', arguments: routerCall({ feasibility: 'can', ...args }) }), finish: () => complete({ id: turnId, status: 'completed' }) })
          return { threadId, turnId, done }
        }, steer: async () => '', interrupt: async () => {}, close: async () => { resolve?.({ id: 'closed', status: 'interrupted' }) } }
    } })
  store.saveSettings({ ...store.settings('b'), mode: 'router-worker', revision: 1 })
  let seq = 0
  const send = (text: string) => service.receive('b', { groupId: 'dm', seq: ++seq, text, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  cleanups.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { service, store, bot, turns, sent, send }
}

test('短间隔两条原文同批判断，只发一次完整回答', async () => {
  const f = fixture(); const a = f.send('在吗'); await Bun.sleep(10); const b = f.send('你当前工作是什么')
  await until(() => f.turns.length === 1)
  expect(f.turns[0].context.currentMessages.map((m: any) => m.id)).toEqual([a.id, b.id])
  await f.turns[0].decide({ action: 'reply', replies: ['在，我负责现场排障。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
  expect(f.store.inbox(a.id)?.state).toBe('routed'); expect(f.store.inbox(b.id)?.state).toBe('routed')
  expect(f.turns).toHaveLength(1)
})

test('超过收集窗口但仍在生成时的新话使旧派工失效，再整体判断', async () => {
  const f = fixture(); const a = f.send('写一个报告'); await until(() => f.turns.length === 1)
  await Bun.sleep(120); const b = f.send('先别写了，我只是想问问')
  const result = await f.turns[0].decide({ action: 'start', replyText: '我来写。', goal: '写报告', delivery: 'files', newCase: { title: '报告', object: '报告', goal: '写报告' }, allowedOps: ['read', 'create'] })
  expect(result.superseded).toBe(true); f.turns[0].finish()
  expect(f.store.tasks('b')).toHaveLength(0); expect(f.sent).toHaveLength(0)
  await until(() => f.turns.length === 2)
  expect(f.turns[1].context.currentMessages.map((m: any) => m.id)).toEqual([a.id, b.id])
  await f.turns[1].decide({ action: 'reply', replies: ['你想问哪方面？'] }); f.turns[1].finish()
  await until(() => f.sent.length === 1)
  expect(f.store.failedInputs('b')).toHaveLength(0)
})

test('好、不用确认了允许沉默，原始消息都有处理记录', async () => {
  const f = fixture(); const a = f.send('好'); const b = f.send('不用确认了')
  await until(() => f.turns.length === 1)
  await f.turns[0].decide({ action: 'reply', replies: [], basis: '用户结束话题，无需再次确认' }); f.turns[0].finish()
  await until(() => f.store.inbox(b.id)?.state === 'routed')
  expect(f.store.inbox(a.id)?.state).toBe('routed'); expect(f.store.replies('b')).toHaveLength(0)
})

test('连续来话最多等待一个收集上限，不无限延长', async () => {
  const f = fixture(); f.send('第一句')
  for (let i = 0; i < 5; i++) { await Bun.sleep(25); f.send(`补充${i}`) }
  expect(f.turns.length).toBeGreaterThan(0)
})

test('分泡发送期间新话暂停未发部分，模型可以取消；已发历史保留', async () => {
  const f = fixture(); f.send('你能做什么'); await until(() => f.turns.length === 1)
  await f.turns[0].decide({ action: 'reply', replies: ['我能排查部署问题。', '也能整理操作文档。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1); f.send('第二点不用说了')
  await until(() => f.turns.length === 2); await Bun.sleep(120)
  expect(f.sent).toHaveLength(1)
  const waiting = f.turns[1].context.pendingReplies
  expect(waiting.map((r: any) => r.text)).toEqual(['也能整理操作文档。'])
  await f.turns[1].decide({ action: 'reply', replies: [], cancelReplyIds: waiting.map((r: any) => r.id) }); f.turns[1].finish()
  await Bun.sleep(120); expect(f.sent).toHaveLength(1)
  expect(f.store.replies('b').map(r => r.state)).toEqual(['sent', 'cancelled'])
})

test('插入哈哈不机械清空待发内容，模型可保留后续气泡', async () => {
  const f = fixture(); f.send('介绍一下'); await until(() => f.turns.length === 1)
  await f.turns[0].decide({ action: 'reply', replies: ['我负责部署。', '遇到故障可以找我。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1); f.send('哈哈'); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ action: 'reply', replies: [], cancelReplyIds: [] }); f.turns[1].finish()
  await until(() => f.sent.length === 2); expect(f.sent[1].text).toBe('遇到故障可以找我。')
})

test('多泡总长度仍限制100字，不能分泡绕过；权限拒绝必须交代', () => {
  const f = fixture()
  expect(() => parseRouterDecision({ action: 'reply', feasibility: 'can', policyRevision: 1, replies: ['甲'.repeat(60), '乙'.repeat(60)] }, f.bot)).toThrow(/100/)
  expect(() => parseRouterDecision({ action: 'request_access', feasibility: 'needs_access', policyRevision: 1, replies: [] }, f.bot)).toThrow(/回复|说明/)
})

test('任务批次保留每条原文和附件，补充一次入账且重复消息不会重新派工', () => {
  const f = fixture()
  const attachment = { id: 'upload-x', kind: 'upload' as const, botId: 'b', name: '资料.txt', mime: 'text/plain', size: 3, hash: 'hash' }
  const receive = (seq: number, text: string, attachments = [] as typeof attachment[]) => f.store.receive({ botId: 'b', groupId: 'dm', seq, text, attachments, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const a = receive(1, '看这份资料', [attachment]); const b = receive(2, '写一个报告')
  const task = f.store.acceptWork({ inputId: b.id, inputIds: [a.id, b.id], newCase: { title: '报告', object: '资料', goal: '解读' }, goal: '写报告', acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: f.bot.directory, allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  expect(task.originInputIds).toEqual([a.id, b.id]); expect(task.attachmentInputIds).toContain(a.id)
  const c = receive(3, '改成HTML'); const d = receive(4, '用深色背景')
  const addition = f.store.acceptInput({ inputId: d.id, inputIds: [c.id, d.id], taskId: task.id, expectedRevision: 1, kind: 'append', replies: [] })
  expect(addition.inboxIds).toEqual([c.id, d.id]); expect(addition.text).toContain(c.text); expect(addition.text).toContain(d.text)
  expect(f.store.task(task.id)?.revision).toBe(2)
  expect([a,b,c,d].map(m => f.store.inbox(m.id)?.state)).toEqual(['routed','routed','routed','routed'])
  expect(() => f.store.acceptInput({ inputId: d.id, inputIds: [c.id, d.id], taskId: task.id, expectedRevision: 2, kind: 'append', replies: [] })).toThrow(/已处理/)
  expect(f.store.inputs(task.id)).toHaveLength(1)
})

test('批次混入别人的消息必须整批回滚', () => {
  const f = fixture(); const a = f.send('第一条')
  const b = f.store.receive({ botId: 'b', groupId: 'dm', seq: 2, text: '越权', senderId: 'other', memberId: 'other', createdAt: Date.now() })
  expect(() => f.store.acceptWork({ inputId: a.id, inputIds: [a.id, b.id], newCase: { title: '任务', object: '资料', goal: '解读' }, goal: '读取', acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: f.bot.directory, allowedOps: ['read'], exclusions: [], mode: 'execute' } })).toThrow(/批次|归属/)
  expect(f.store.tasks('b')).toHaveLength(0); expect(f.store.inbox(a.id)?.state).toBe('pending')
})

test('聊天与按钮补充按本机接收顺序合批，不以随机负seq当成时间顺序', async () => {
  const f = fixture()
  const origin = f.store.receive({ botId: 'b', groupId: 'dm', seq: 1, senderId: 'owner', memberId: 'om', text: '排查', createdAt: Date.now() })
  const task = f.store.acceptWork({ inputId: origin.id, newCase: { title: '排查', object: '系统', goal: '定位' }, goal: '定位', acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: f.bot.directory, allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  // 避免此测试启动 Worker，专门检查控制输入进入 Router 的合并与失效机制。
  f.store.updateTask(task.id, { state: 'running' })
  f.send('排查'); const chat = f.send('补充一下')
  await until(() => f.turns.length === 1)
  await f.service.control('b', 'owner', { action: 'correct', taskId: task.id, expectedRevision: 1, requestId: 'button-correction', text: '只读检查，不要改文件' })
  const old = await f.turns[0].decide({ action: 'reply', replies: ['旧回复'] }); f.turns[0].finish()
  expect(old.superseded).toBe(true)
  await until(() => f.turns.length === 2)
  const batch = f.turns[1].context.currentMessages
  expect(batch.map((m: any) => m.text)).toEqual(['补充一下', '只读检查，不要改文件'])
  const addition = f.store.acceptInput({ inputId: batch[1].id, inputIds: batch.map((m: any) => m.id), taskId: task.id, expectedRevision: 1, kind: 'append', replies: [] })
  expect(addition.text).toContain(chat.text)
  expect(f.store.failedInputs('b')).toHaveLength(0)
})

test('模型判断期间旧气泡已被Worker淘汰，重复取消仍可提交有效的新回答', async () => {
  const f = fixture()
  const old = f.store.reply({ botId: 'b', groupId: 'dm', author: 'router', purpose: 'chat', text: '原来的内容', policyRevision: 1, key: 'old' })
  const next = f.send('换个问题'); await until(() => f.turns.length === 1)
  f.store.cancelReply(old.id, 'Worker 已给出结果')
  await f.turns[0].decide({ action: 'reply', replies: ['你说。'], cancelReplyIds: [old.id] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
  expect(f.store.inbox(next.id)?.state).toBe('routed'); expect(f.sent[0].text).toBe('你说。')
})

test('默认安静期是 3 秒，最长等 12 秒', async () => {
  expect(ROUTER_QUIET_MS).toBe(3_000); expect(ROUTER_MAX_WAIT_MS).toBe(12_000)
  const f = fixture('defaults'); f.send('在吗')
  await Bun.sleep(2_300); expect(f.turns).toHaveLength(0)
  await until(() => f.turns.length === 1)
  await f.turns[0].decide({ action: 'reply', replies: ['在。'] }); f.turns[0].finish()
})

test('停止类整句不等安静期，立即开轮', async () => {
  const f = fixture({ routerQuietMs: 900, routerMaxWaitMs: 3_000 })
  const a = f.send('开始写报告'); await Bun.sleep(20)
  const started = Date.now(); const b = f.send('停止')
  await until(() => f.turns.length === 1)
  expect(Date.now() - started).toBeLessThan(600)
  expect(f.turns[0].context.currentMessages.map((m: any) => m.id)).toEqual([a.id, b.id])
  await f.turns[0].decide({ action: 'reply', replies: ['好的，先不做。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
})

test('控制语只认整句：句末标点可省，夹在长句里的不算', () => {
  for (const text of ['停', '停。', '别搞了！', '继续', '算了～', '不用了?']) expect(isControlUtterance(text)).toBe(true)
  for (const text of ['停止一下', '继续补充说明', '你别搞了呀', '不停的报错', '算了一下', '在吗', '']) expect(isControlUtterance(text)).toBe(false)
})

test('确认卡里打字的回答和控制纠正不等安静期', async () => {
  const f = fixture({ routerQuietMs: 900, routerMaxWaitMs: 3_000 })
  const origin = f.store.receive({ botId: 'b', groupId: 'dm', seq: 1, senderId: 'owner', memberId: 'om', text: '排查', createdAt: Date.now() })
  const task = f.store.acceptWork({ inputId: origin.id, newCase: { title: '排查', object: '系统', goal: '定位' }, goal: '定位', acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: f.bot.directory, allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  // 不启动 Worker，只检查控制面文字进入前台的时机。
  f.store.updateTask(task.id, { state: 'running' })
  const started = Date.now()
  await f.service.control('b', 'owner', { action: 'correct', taskId: task.id, expectedRevision: 1, requestId: 'button-correction-timing', text: '只读检查，不要改文件' })
  await until(() => f.turns.length === 1)
  expect(Date.now() - started).toBeLessThan(600)
  expect(f.turns[0].context.currentMessages.map((m: any) => m.text)).toEqual(['只读检查，不要改文件'])
  await f.turns[0].decide({ action: 'reply', replies: ['收到，只读检查。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
})
