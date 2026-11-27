import { routerCall } from './helpers/router-decision'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  const turns: Array<{ context: any; decide: (args: Record<string, unknown>) => Promise<any>; call: (tool: string, args: Record<string, unknown>) => Promise<unknown>; finish: (modelText?: string, status?: string, error?: string) => void }> = []
  const service = new BotRuntimeService({ store, rootDir: dir, routerQuietMs: 0, bubbleGapMs: 0, getBot: () => bot,
    sendReply: async r => { sent.push(r) }, checkAccess: async () => { throw new Error('no work') }, openTools: () => { throw new Error('no work') },
    createClient: (role, options) => {
      expect(role).toBe('router'); let finish: ((v: CodexTurn) => void) | undefined
      return { initialize: async () => {}, startThread: async () => 'thread', resumeThread: async id => id,
        startTurn: async (threadId, text) => {
          const turnId = `turn-${turns.length}`; const done = new Promise<CodexTurn>(r => { finish = r }); const resolve = finish!
          const call = (tool: string, args: Record<string, unknown>) => options.onToolCall({ threadId, turnId, callId: turnId, tool, arguments: args })
          turns.push({ context: text.startsWith('{') ? JSON.parse(text) : text, call, decide: args => call('router_decide', routerCall({ action: 'reply', feasibility: 'can', ...args })),
            finish: (modelText = '', status = 'completed', error) => resolve({ id: turnId, status, ...(error ? { error: { message: error } } : {}), ...(modelText ? { items: [{ type: 'agentMessage', text: modelText }] } : {}) }) })
          return { threadId, turnId, done }
        }, steer: async () => '', interrupt: async () => {}, close: async () => { finish?.({ id: 'closed', status: 'interrupted' }) } }
    } })
  let seq = 0
  const send = (text: string) => service.receive('b', { groupId: 'dm', seq: ++seq, text, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const origin = store.receive({ botId: 'b', groupId: 'dm', seq: ++seq, text: '示例引擎是什么', senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const task = store.acceptWork({ inputId: origin.id, newCase: { title: '产品关系', object: '示例引擎', goal: '理解产品' }, goal: origin.text, acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: dir, allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  store.updateTask(task.id, { state: 'running' })
  const output = (text = '示例引擎是语义引擎。', extra: Partial<RuntimeReply> = {}) => {
    if(extra.purpose==='result') store.updateTask(task.id,{state:'completed',review:{state:'pending',rounds:store.task(task.id)?.review?.rounds??0}})
    return store.reply({ botId: 'b', groupId: 'dm', author: 'worker', purpose: 'answer', text, policyRevision: 1, inputId: origin.id, taskId: task.id, taskRevision: store.task(task.id)!.revision, key: crypto.randomUUID(), ...extra })
  }
  cleanups.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, store, service, bot, task, sent, turns, send, output }
}

const diagnosticPath = (dir: string) => join(dir, 'bot-runtime', 'router-diagnostics.jsonl')
const diagnostics = (dir: string) => readFileSync(diagnosticPath(dir), 'utf8').trim().split('\n').map(line => JSON.parse(line))

test('决策被拒绝后保存具体原因、关联消息与轮次，补交提醒携带校验原因', async () => {
  const f = fixture(); const message = f.send('啥意思？'); await until(() => f.turns.length === 1)
  const privateReply = '保密回答不要落日志'.repeat(20)
  await expect(f.turns[0].decide({ replies: [privateReply] })).rejects.toThrow(/100/)
  f.turns[0].finish('内部正文不应落日志'); await until(() => f.turns.length === 2)
  expect(f.turns[1].context).toContain('100')
  f.turns[1].finish()
  await until(() => f.store.inbox(message.id)?.state === 'failed')
  const [trace] = diagnostics(f.dir)
  expect(trace).toMatchObject({ botId: 'b', inputIds: [message.id], outcome: 'failed', nudged: true })
  expect(trace.decisions).toMatchObject([{ phase: 'initial', origin: 'model', stage: 'validation', accepted: false, action: 'reply', replyCount: 1, replyChars: [privateReply.length], reason: expect.stringContaining('100') }])
  expect(trace.turns).toMatchObject([{ phase: 'initial', status: 'completed', textChars: '内部正文不应落日志'.length }, { phase: 'nudge', status: 'completed', textChars: 0 }])
  expect(JSON.stringify(trace)).not.toContain('保密回答')
  expect(JSON.stringify(trace)).not.toContain('内部正文')
  expect(JSON.stringify(trace)).not.toContain('啥意思')
  expect(statSync(diagnosticPath(f.dir)).mode & 0o777).toBe(0o600)
})

test('宿主代交失败后模型修正成功仍保留恢复诊断，不改变原消息处理结果', async () => {
  const f = fixture(); const message = f.send('解释一下'); await until(() => f.turns.length === 1)
  f.turns[0].finish('长'.repeat(120)); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ replies: ['已经解释清楚。'] }); f.turns[1].finish()
  await until(() => f.store.inbox(message.id)?.state === 'routed')
  await until(() => existsSync(diagnosticPath(f.dir)))
  const [trace] = diagnostics(f.dir)
  expect(trace.outcome).toBe('recovered')
  expect(trace.decisions).toMatchObject([{ origin: 'host', accepted: false, reason: expect.stringContaining('100') }, { phase: 'nudge', origin: 'model', accepted: true }])
  expect(f.sent.map(r => r.text)).toEqual(['已经解释清楚。'])
  expect(f.store.settings('b').error).toBeUndefined()
})

test('结构错误保留字段路径，不记录未知字段内的敏感值', async () => {
  const f = fixture(); const message = f.send('解释一下'); await until(() => f.turns.length === 1)
  await expect(f.turns[0].call('router_decide', { decision: { action: 'reply' }, feasibility: 'can', replies: '不能记录的原始回答', 'private-token-should-not-log': 'secret-value-should-not-log' })).rejects.toThrow(/决策参数格式错误/)
  f.turns[0].finish(); await until(() => f.turns.length === 2); f.turns[1].finish()
  await until(() => f.store.inbox(message.id)?.state === 'failed')
  const [trace] = diagnostics(f.dir)
  expect(trace.decisions[0].reason).toContain('replies')
  expect(trace.decisions[0].reason).toContain('决策参数格式错误')
  expect(JSON.stringify(trace)).not.toContain('private-token-should-not-log')
  expect(JSON.stringify(trace)).not.toContain('secret-value-should-not-log')
  expect(JSON.stringify(trace)).not.toContain('不能记录的原始回答')
})

test('模型运行失败记录分类，不复制原始账号诊断或完整输出', async () => {
  const f = fixture(); const message = f.send('在吗'); await until(() => f.turns.length === 1)
  f.turns[0].finish('不得记录的模型输出', 'failed', '401 unauthorized bearer super-secret-test-token')
  await until(() => f.store.inbox(message.id)?.state === 'failed')
  const [trace] = diagnostics(f.dir)
  expect(trace.outcome).toBe('failed')
  expect(trace.reason).toContain('认证')
  expect(trace.turns).toMatchObject([{ phase: 'initial', status: 'failed' }])
  expect(JSON.stringify(trace)).not.toContain('super-secret-test-token')
  expect(JSON.stringify(trace)).not.toContain('不得记录的模型输出')
})

test('未知字段名包含引号和分隔符时，日志和补交提醒都不保留字段名内容', async () => {
  const f = fixture(); const message = f.send('解释一下'); await until(() => f.turns.length === 1)
  const unknown = 'prefix"PRIVATE_KEY_CONTENT"suffix；ANOTHER_PRIVATE_KEY'
  await expect(f.turns[0].call('router_decide', { decision: { action: 'reply' }, feasibility: 'can', replies: ['说明。'], [unknown]: 'value' })).rejects.toThrow(/决策参数格式错误/)
  f.turns[0].finish(); await until(() => f.turns.length === 2)
  expect(f.turns[1].context).not.toContain('PRIVATE_KEY_CONTENT')
  expect(f.turns[1].context).not.toContain('ANOTHER_PRIVATE_KEY')
  f.turns[1].finish(); await until(() => f.store.inbox(message.id)?.state === 'failed')
  const [trace] = diagnostics(f.dir)
  expect(trace.decisions[0].reason).toContain('决策参数格式错误')
  expect(JSON.stringify(trace)).not.toContain('PRIVATE_KEY_CONTENT')
  expect(JSON.stringify(trace)).not.toContain('ANOTHER_PRIVATE_KEY')
})

test('通过参数校验但被派工与来源校验拒绝时，记录提交阶段的具体原因', async () => {
  const f = fixture(); const message = f.send('解释一下'); await until(() => f.turns.length === 1)
  await expect(f.turns[0].decide({ replies: ['说明。'], workerReplyIndexes: [0] })).rejects.toThrow(/Worker/)
  f.turns[0].finish(); await until(() => f.turns.length === 2); f.turns[1].finish()
  await until(() => f.store.inbox(message.id)?.state === 'failed')
  const [trace] = diagnostics(f.dir)
  expect(trace.decisions[0]).toMatchObject({ stage: 'commit', accepted: false, reason: expect.stringContaining('Worker') })
  expect(f.sent).toHaveLength(0)
})

test('一轮反复提交只保留最近八次诊断及丢弃计数，正常回复不产生诊断日志', async () => {
  const f = fixture(); const message = f.send('解释一下'); await until(() => f.turns.length === 1)
  for (let i = 0; i < 12; i++) await expect(f.turns[0].decide({ replies: ['长'.repeat(120)] })).rejects.toThrow(/100/)
  await f.turns[0].decide({ replies: ['已说明。'] }); f.turns[0].finish()
  await until(() => existsSync(diagnosticPath(f.dir)))
  const [trace] = diagnostics(f.dir)
  expect(trace).toMatchObject({ outcome: 'recovered', droppedDecisions: 5, nudged: false })
  expect(trace.decisions).toHaveLength(8)
  expect(f.store.inbox(message.id)?.state).toBe('routed')

  const ordinary = fixture(); ordinary.send('在吗'); await until(() => ordinary.turns.length === 1)
  await ordinary.turns[0].decide({ replies: ['在。'] }); ordinary.turns[0].finish()
  await until(() => ordinary.sent.length === 1)
  expect(existsSync(diagnosticPath(ordinary.dir))).toBe(false)
})

test('诊断日志轮转保留完整JSON行，日志不可写不影响正常处理', async () => {
  const f = fixture(); mkdirSync(join(f.dir, 'bot-runtime'), { recursive: true })
  writeFileSync(diagnosticPath(f.dir), 'x'.repeat(1_100_000))
  const message = f.send('解释一下'); await until(() => f.turns.length === 1)
  f.turns[0].finish('长'.repeat(120)); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ replies: ['已说明。'] }); f.turns[1].finish()
  await until(() => f.store.inbox(message.id)?.state === 'routed')
  await until(() => existsSync(diagnosticPath(f.dir) + '.1'))
  expect(diagnostics(f.dir)).toHaveLength(1)

  const blocked = fixture(); writeFileSync(join(blocked.dir, 'bot-runtime'), 'blocked')
  const next = blocked.send('解释一下'); await until(() => blocked.turns.length === 1)
  blocked.turns[0].finish('长'.repeat(120)); await until(() => blocked.turns.length === 2)
  await blocked.turns[1].decide({ replies: ['仍能正常说明。'] }); blocked.turns[1].finish()
  await until(() => blocked.store.inbox(next.id)?.state === 'routed')
  expect(blocked.sent.map(r => r.text)).toEqual(['仍能正常说明。'])
  expect(blocked.store.settings('b').error).toBeUndefined()
})

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
