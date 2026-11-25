import { routerCall } from './helpers/router-decision'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'
import type { CodexTurn } from '../src/cli/bot-runtime/codex'

/** 前台一轮正常结束却没有提交 router_decide：宿主代为提交、提醒一次，仍不提交才记失败。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function until(check: () => boolean) { for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true) }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-router-undecided-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'b', name: '小林', groupId: 'dm', ownerPhoneId: 'owner', platform: 'codex', sourceCwd: dir, directory: dir, policyRevision: 1, commandSandbox: false,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ ...store.settings('b'), mode: 'router-worker', revision: 1, profile: '负责运维，跟用户自然聊天。' })
  const sent: RuntimeReply[] = []
  // modelText 是模型这一轮最后说的话，空串表示它什么都没说就结束了；提醒那一轮的输入是纯文本，不是上下文 JSON。
  const turns: Array<{ context: any; decide: (args: Record<string, unknown>) => Promise<any>; finish: (modelText?: string) => void }> = []
  const service = new BotRuntimeService({ store, rootDir: dir, routerQuietMs: 0, bubbleGapMs: 0, getBot: () => bot,
    sendReply: async r => { sent.push(r) }, checkAccess: async () => { throw new Error('no work') }, openTools: () => { throw new Error('no work') },
    createClient: (role, options) => {
      expect(role).toBe('router'); let finish: ((v: CodexTurn) => void) | undefined
      return { initialize: async () => {}, startThread: async () => 'thread', resumeThread: async id => id,
        startTurn: async (threadId, text) => {
          const turnId = `turn-${turns.length}`; const done = new Promise<CodexTurn>(r => { finish = r }); const resolve = finish!
          turns.push({ context: text.startsWith('{') ? JSON.parse(text) : text, decide: args => options.onToolCall({ threadId, turnId, callId: turnId, tool: 'router_decide', arguments: routerCall({ action: 'reply', feasibility: 'can', ...args }) }),
            finish: (modelText = '') => resolve({ id: turnId, status: 'completed', ...(modelText ? { items: [{ type: 'agentMessage', text: modelText }] } : {}) }) })
          return { threadId, turnId, done }
        }, steer: async () => '', interrupt: async () => {}, close: async () => { finish?.({ id: 'closed', status: 'interrupted' }) } }
    } })
  let seq = 0
  const send = (text: string) => service.receive('b', { groupId: 'dm', seq: ++seq, text, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const origin = store.receive({ botId: 'b', groupId: 'dm', seq: ++seq, text: '示例引擎是什么', senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const task = store.acceptWork({ inputId: origin.id, newCase: { title: '产品关系', object: '示例引擎', goal: '理解产品' }, goal: origin.text, acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: dir, allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  store.updateTask(task.id, { state: 'running' })
  const output = (text = '示例引擎是语义引擎。', extra: Partial<RuntimeReply> = {}) => store.reply({ botId: 'b', groupId: 'dm', author: 'worker', purpose: 'answer', text, policyRevision: 1, inputId: origin.id, taskId: task.id, taskRevision: 1, key: crypto.randomUUID(), ...extra })
  cleanups.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, service, bot, task, sent, turns, send, output }
}

test('前台只说了正文、没提交决策：宿主代为提交，正文照发，不留未处理', async () => {
  const f = fixture(); const message = f.send('解决了，感谢感谢')
  await until(() => f.turns.length === 1)
  f.turns[0].finish('不客气，问题解决了就好。')
  await until(() => f.store.inbox(message.id)?.state === 'routed')
  expect(f.sent.map(r => [r.author, r.text])).toEqual([['router', '不客气，问题解决了就好。']])
  expect(f.turns).toHaveLength(1); expect(f.store.settings('b').error).toBeUndefined()
})

test('前台认为不必回话、什么都没说就结束：原话记为已处理，不发也不报错', async () => {
  const f = fixture(); const message = f.send('好的')
  await until(() => f.turns.length === 1)
  f.turns[0].finish()
  await until(() => f.store.inbox(message.id)?.state === 'routed')
  expect(f.sent).toHaveLength(0); expect(f.turns).toHaveLength(1); expect(f.store.settings('b').error).toBeUndefined()
})

test('正文超过气泡上限：同一会话提醒一次，正式提交后才发出', async () => {
  const f = fixture(); const message = f.send('总结一下'); await until(() => f.turns.length === 1)
  f.turns[0].finish('很长'.repeat(60)); await until(() => f.turns.length === 2)
  expect(f.turns[1].context).toContain('router_decide'); expect(f.sent).toHaveLength(0)
  await f.turns[1].decide({ replies: ['总结好了，见附件。'] }); f.turns[1].finish()
  await until(() => f.store.inbox(message.id)?.state === 'routed')
  expect(f.sent.map(r => r.text)).toEqual(['总结好了，见附件。'])
})

test('提醒后仍不提交：才记失败，原话保留重试入口', async () => {
  const f = fixture(); const message = f.send('总结一下'); await until(() => f.turns.length === 1)
  f.turns[0].finish('很长'.repeat(60)); await until(() => f.turns.length === 2)
  f.turns[1].finish('还是很长'.repeat(40))
  await until(() => f.store.inbox(message.id)?.state === 'failed')
  expect(f.store.settings('b').error).toMatch(/未提交有效决策/); expect(f.sent).toHaveLength(0); expect(f.turns).toHaveLength(2)
})

test('前台的提交被驳回后改说正文：不拿它代为提交，仍提醒一次按规则重写', async () => {
  const f = fixture(); const message = f.send('总结一下'); await until(() => f.turns.length === 1)
  await expect(f.turns[0].decide({ replies: ['很长'.repeat(60)] })).rejects.toThrow(/100/)
  f.turns[0].finish('提交失败。'); await until(() => f.turns.length === 2)
  expect(f.sent).toHaveLength(0)
  await f.turns[1].decide({ replies: ['总结好了。'] }); f.turns[1].finish()
  await until(() => f.store.inbox(message.id)?.state === 'routed')
  expect(f.sent.map(r => r.text)).toEqual(['总结好了。'])
})

test('前台没提交时又来了新消息：按最新整批重新开轮，不为旧批次提醒', async () => {
  const f = fixture(); const first = f.send('在吗'); await until(() => f.turns.length === 1)
  const second = f.send('帮我看下示例引擎'); f.turns[0].finish('在的。'); await until(() => f.turns.length === 2)
  expect(f.turns[1].context.currentMessages.map((m: { id: string }) => m.id)).toEqual([first.id, second.id])
  await f.turns[1].decide({ replies: ['好的，我去看。'] }); f.turns[1].finish()
  await until(() => f.store.inbox(second.id)?.state === 'routed')
  expect(f.sent.map(r => r.text)).toEqual(['好的，我去看。'])
})

test('Worker 结果轮没提交：提醒一次，提交后结果照常发出', async () => {
  const f = fixture(); const source = f.output(); await f.service.flush('b'); await until(() => f.turns.length === 1)
  f.turns[0].finish(); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ workerReplyId: source.id, replies: ['示例引擎是语义引擎。'] }); f.turns[1].finish()
  await until(() => f.sent.length === 1)
  expect(f.sent[0]).toMatchObject({ author: 'router', sourceReplyId: source.id, text: '示例引擎是语义引擎。' })
})

test('只带 Worker 结果、前台只说了正文：整句归这份结果，附件照常带上', async () => {
  const f = fixture(); f.store.saveArtifact({ id: 'artifact-a', botId: 'b', caseId: f.task.caseId, taskId: f.task.id, title: '报告', mime: 'text/plain', path: join(f.bot.directory, 'report.txt'), size: 20, hash: 'hash', revision: 1, createdAt: Date.now() })
  const source = f.output('报告已完成。', { purpose: 'result', artifactIds: ['artifact-a'] })
  await f.service.flush('b'); await until(() => f.turns.length === 1)
  f.turns[0].finish('报告好了。')
  await until(() => f.sent.length === 1)
  expect(f.sent[0]).toMatchObject({ author: 'router', sourceReplyId: source.id, taskId: f.task.id, text: '报告好了。', artifactIds: ['artifact-a'] })
  expect(f.store.replies('b').find(r => r.id === source.id)?.state).toBe('routed')
  expect(f.turns).toHaveLength(1)
})

test('主人话和 Worker 结果一起来的轮次不拿正文代为提交：提醒后仍不提交才记失败并延后结果', async () => {
  const f = fixture(); const source = f.output(); await f.service.flush('b'); await until(() => f.turns.length === 1)
  const message = f.send('辛苦了'); f.turns[0].finish(); await until(() => f.turns.length === 2)
  expect(f.turns[1].context.workerMessage.id).toBe(source.id)
  f.turns[1].finish('好的。'); await until(() => f.turns.length === 3)
  expect(f.sent).toHaveLength(0)
  f.turns[2].finish('好的。')
  await until(() => f.store.inbox(message.id)?.state === 'failed')
  expect(f.store.replies('b').find(r => r.id === source.id)).toMatchObject({ state: 'pending', routingAttempts: 1 })
  expect(f.sent).toHaveLength(0)
})
