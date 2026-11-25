import { routerCall } from './helpers/router-decision'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { silentMemoryClient } from './helpers/model-client'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true) }
function fixture(send?: (reply: RuntimeReply) => Promise<void>, inspectHistory?: (context: any, history: any) => void) {
  const root = mkdtempSync(join(tmpdir(), 'ce-unified-replies-'))
  const store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'bot', name: '助理', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: root, directory: root, platform: 'codex', commandSandbox: true, policyRevision: 1,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'ask', execute: 'ask', commanders: 'owner', allowedPhoneIds: [] } }
  const sent: RuntimeReply[] = []
  let modelCalls = 0
  const runtime = new BotRuntimeService({ routerQuietMs: 0, store, rootDir: root, getBot: () => bot,
    sendReply: async r => { await send?.(r); sent.push(r) },
    checkAccess: async () => { throw new Error('unexpected project access') }, openTools: () => { throw new Error('unexpected project access') },
    createClient: (role, options) => {
      if (role === 'memory') return silentMemoryClient()
      modelCalls++
      if (!inspectHistory) throw new Error('dispatch must not invoke a model')
      return { initialize: async () => {}, startThread: async () => 'router-thread', resumeThread: async id => id,
        startTurn: async (threadId, text) => ({ threadId, turnId: 'router-turn', done: Promise.resolve().then(async () => {
          const call = (tool: string, args: Record<string, unknown>) => options.onToolCall({ threadId, turnId: 'router-turn', callId: tool, tool, arguments: args })
          inspectHistory(JSON.parse(text), await call('chat_recent', { limit: 20 }))
          await call('router_decide', routerCall({ action: 'reply', replyText: '刚才的聊天我看到了。' }))
          return { id: 'router-turn', status: 'completed' }
        }) }), steer: async () => '', interrupt: async () => {}, close: async () => {},
      }
    },
  })
  store.saveSettings({ ...store.settings(bot.botId), mode: 'router-worker', revision: 1 })
  let seq = 0
  const receive = (text: string) => store.receive({ botId: bot.botId, groupId: bot.groupId, seq: ++seq, senderId: 'owner', memberId: 'owner-member', text, createdAt: Date.now() })
  function task() {
    const input = receive('写个报告')
    const t = store.acceptWork({ inputId: input.id, newCase: { title: '报告', object: `材料 ${seq}`, goal: '解读' }, goal: '写报告', acceptance: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: root, allowedOps: ['read'], exclusions: [], mode: 'execute' }, replyText: `受理 ${seq}` })
    store.updateTask(t.id, { state: 'running' })
    return { task: store.task(t.id)!, input }
  }
  // 本文件验证发送调度；Worker输入先模拟已通过Router整理。模型入口另有独立集成测试。
  const enqueue = (text: string, extra: Partial<RuntimeReply> = {}) => {
    const reply = store.reply({ botId: bot.botId, groupId: bot.groupId, author: 'router', purpose: 'chat', text, policyRevision: 1, key: text, ...extra, ...(extra.purpose === 'question' ? { questionId: extra.questionId ?? extra.key } : {}) })
    if (reply.author === 'router') return reply
    store.presentWorkerReply(bot.botId, reply.id, [text], '')
    return store.replies(bot.botId).find(r => r.sourceReplyId === reply.id)!
  }
  cleanups.push(async () => { await runtime.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  return { runtime, store, bot, root, sent, receive, task, enqueue, modelCalls: () => modelCalls }
}

test('Worker 已有最终结果时，取消同任务尚未发送的受理话并保留正文与附件关联', async () => {
  const f = fixture(); const { task, input } = f.task()
  const ack = f.store.pendingReplies('bot')[0]
  const result = f.enqueue('报告已经整理完成。', { author: 'worker', purpose: 'result', taskId: task.id, inputId: input.id, artifactIds: ['artifact-1'] })
  await f.runtime.flush('bot')
  expect(f.sent.map(r => r.id)).toEqual([result.id])
  expect(f.sent[0].artifactIds).toEqual(['artifact-1'])
  expect(f.store.replies('bot').find(r => r.id === ack.id)).toMatchObject({ state: 'cancelled', supersededBy: result.id })
  expect(f.modelCalls()).toBe(0)
})

test('新输入暂停前台整理的结果，处理新输入后续发且不复活旧受理话', async () => {
  const f = fixture(); const { task, input } = f.task()
  const ack = f.store.pendingReplies('bot')[0]
  const next = f.receive('哈哈')
  f.enqueue('报告已完成。', { author: 'worker', purpose: 'result', taskId: task.id, inputId: input.id, taskRevision: 1 })
  await f.runtime.flush('bot')
  expect(f.sent).toEqual([])
  f.store.markInput(next.id, 'routed', { action: 'reply', replies: [] })
  await f.runtime.flush('bot')
  expect(f.sent.map(r => r.text)).toEqual(['报告已完成。'])
  expect(f.store.replies('bot').find(r => r.id === ack.id)?.state).toBe('cancelled')
})

test('专业追问答案只替代同一输入的受理话，普通聊天与其他任务消息保留', async () => {
  const f = fixture(); const first = f.task(); const other = f.task()
  const inquiry = f.receive('现在做到哪了？')
  const addition = f.store.acceptInput({ inputId: inquiry.id, taskId: first.task.id, expectedRevision: 1, kind: 'ask_worker', replyText: '我看一下当前进展。' })
  const chat = f.enqueue('你好。')
  const answer = f.enqueue('已读完材料，正在整理大纲。', { author: 'worker', purpose: 'answer', taskId: first.task.id, inputId: inquiry.id })
  await f.runtime.flush('bot')
  expect(f.sent[0].id).toBe(answer.id)
  expect(f.sent.some(r => r.purpose === 'ack' && r.inputId === addition.inboxId)).toBe(false)
  expect(f.sent.some(r => r.taskId === other.task.id)).toBe(true)
  expect(f.sent.some(r => r.inputId === first.input.id && r.purpose === 'ack')).toBe(true)
  expect(f.sent.some(r => r.id === chat.id)).toBe(true)
})

test('必要问题优先发送，问题关联保留；旧问题在用户已回答后不再发送', async () => {
  const f = fixture(); const { task } = f.task()
  const chat = f.enqueue('下午好。')
  f.store.updateTask(task.id, { state: 'waiting_user', question: { id: 'q-now', text: '报告面向谁？', options: ['技术', '业务'], createdAt: Date.now() } })
  const obsolete = f.enqueue('过时的问题', { author: 'worker', purpose: 'question', key: 'q-old', taskId: task.id })
  const current = f.enqueue('报告面向谁？', { author: 'worker', purpose: 'question', key: 'q-now', taskId: task.id })
  await f.runtime.flush('bot')
  expect(f.sent.map(r => r.id)).toEqual([current.id, chat.id])
  expect(f.store.replies('bot').find(r => r.id === obsolete.id)?.state).toBe('cancelled')
  expect(f.store.task(task.id)?.question?.id).toBe('q-now')
})

test('发送期间追加的 Worker 答案随即接续，不必等轮询，不并发发两条', async () => {
  const firstSend = gate(); let sending = 0; let maxSending = 0
  const f = fixture(async () => { sending++; maxSending = Math.max(maxSending, sending); if (!f.sent.length) await firstSend.promise; sending-- })
  f.enqueue('前一句')
  const sendingFirst = f.runtime.flush('bot')
  try {
    await until(() => sending === 1)
    const { task, input } = f.task()
    const answer = f.enqueue('当前材料已核对。', { author: 'worker', purpose: 'answer', taskId: task.id, inputId: input.id })
    const sendingAgain = f.runtime.flush('bot')
    firstSend.release(); await Promise.all([sendingFirst, sendingAgain])
    expect(f.sent.map(r => r.text)).toEqual(['前一句', answer.text])
    expect(maxSending).toBe(1)
  } finally { firstSend.release() }
})

test('已开始发送的受理话保留实际发送事实，不被后来结果改成未发送', async () => {
  const delivering = gate(); let started = false
  const f = fixture(async r => { if (r.purpose === 'ack') { started = true; await delivering.promise } })
  const { task, input } = f.task(); const ack = f.store.pendingReplies('bot')[0]
  const pending = f.runtime.flush('bot')
  try {
    await until(() => started)
    const result = f.enqueue('已完成。', { author: 'worker', purpose: 'result', taskId: task.id, inputId: input.id })
    delivering.release(); await pending
    expect(f.sent.map(r => r.id)).toEqual([ack.id, result.id])
    expect(f.store.replies('bot').find(r => r.id === ack.id)).toMatchObject({ state: 'sent', attemptedAt: expect.any(Number), sentAt: expect.any(Number) })
  } finally { delivering.release() }
})

test('网络结果未知时保留同一回复 ID 重试，后来结果不能删除曾尝试发送的受理话', async () => {
  const attempts: string[] = []; let offline = true
  const f = fixture(async r => { attempts.push(r.id); if (offline) throw new Error('network result unknown') })
  const { task, input } = f.task(); const ack = f.store.pendingReplies('bot')[0]
  await f.runtime.flush('bot')
  const result = f.enqueue('结果已准备好。', { author: 'worker', purpose: 'result', taskId: task.id, inputId: input.id })
  offline = false; await f.runtime.flush('bot')
  expect(attempts).toEqual([ack.id, ack.id, result.id])
  expect(f.sent.map(r => r.id)).toEqual([ack.id, result.id])
  expect(f.modelCalls()).toBe(0)
})

test('旧权限消息失效时，不连带删除新权限下已生成的合法回复', async () => {
  const f = fixture(); const old = f.enqueue('旧权限回复')
  f.bot.policyRevision = 2
  const current = f.enqueue('新权限回复', { policyRevision: 2 })
  await f.runtime.flush('bot')
  expect(f.sent.map(r => r.id)).toEqual([current.id])
  expect(f.store.replies('bot').find(r => r.id === old.id)?.state).toBe('cancelled')
})

test('没有 Worker 结果时，前台受理话正常发送且不被固定模板替换', async () => {
  const f = fixture(); const { input } = f.task()
  const expected = f.store.pendingReplies('bot')[0]
  await f.runtime.flush('bot')
  expect(f.sent).toMatchObject([{ id: expected.id, text: expected.text, inputId: input.id }])
  expect(f.modelCalls()).toBe(0)
})

test('普通状态修改不刷新进展摘要的记录时间', async () => {
  const f = fixture(); const { task } = f.task()
  f.store.updateTask(task.id, { summary: '刚核对完第一份材料' })
  const reportAt = f.store.task(task.id)?.summaryUpdatedAt
  expect(reportAt).toBeNumber()
  await Bun.sleep(10)
  f.store.updateTask(task.id, { state: 'waiting_user' })
  expect(f.store.task(task.id)?.summaryUpdatedAt).toBe(reportAt)
  expect(f.store.task(task.id)!.updatedAt).toBeGreaterThan(reportAt!)
})

test('发送接口同步触发再次 flush 时，同一条消息仍然只发送一次', async () => {
  let again = true
  const f = fixture(async () => { if (again) { again = false; void f.runtime.flush('bot') } })
  const reply = f.enqueue('只发送一遍')
  await f.runtime.flush('bot')
  expect(f.sent.map(r => r.id)).toEqual([reply.id])
})

test('结果未知的发送尝试持久化，重开账本仍保留同一回复及尝试时间', async () => {
  const f = fixture(async () => { throw new Error('no receipt') })
  const reply = f.enqueue('等待重连')
  await f.runtime.flush('bot')
  const reopened = new BotRuntimeStore(f.store.path)
  try { expect(reopened.pendingReplies('bot')).toMatchObject([{ id: reply.id, attemptedAt: expect.any(Number), state: 'pending' }]) }
  finally { reopened.close() }
})

test('优先级改变发送顺序后，前台近期回复和聊天查询仍与用户实际看到的顺序一致', async () => {
  let context: any; let history: any
  const f = fixture(undefined, (c, h) => { context = c; history = h })
  const chats = Array.from({ length: 10 }, (_, i) => f.enqueue(`聊天 ${i}`))
  const { task, input } = f.task()
  const answer = f.enqueue('专业答案', { author: 'worker', purpose: 'answer', taskId: task.id, inputId: input.id })
  await f.runtime.flush('bot')
  expect(f.sent.map(r => r.text)).toEqual([answer.text, ...chats.map(r => r.text)])
  const query = f.runtime.receive('bot', { groupId: 'dm', seq: 100, senderId: 'owner', memberId: 'owner-member', text: '你最后说了什么？', createdAt: Date.now() })
  await until(() => f.store.inbox(query.id)?.state === 'routed')
  expect(context.previousReplies.map((r: any) => r.text)).toEqual(chats.slice(-8).map(r => r.text))
  expect(history.filter((r: any) => r.author !== 'owner').map((r: any) => r.text)).toEqual([answer.text, ...chats.map(r => r.text)])
})
