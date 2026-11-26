import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatHub } from '../src/cli/chat'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { silentMemoryClient } from './helpers/model-client'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { seal, open } from '../src/shared/crypto'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { GroupEnvelope } from '../src/shared/group'
import type { RuntimeMemory } from '../src/cli/bot-runtime/types'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const f of cleanups.splice(0)) await f() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-runtime-rpc-'))
  const key = new Uint8Array(32).fill(7); let legacyRuns = 0
  const posted: any[] = []
  let chat: ChatHub
  const members = [{ memberId: 'owner-member', phoneId: 'owner', name: 'Owner', human: true }, { memberId: 'other-member', phoneId: 'other', name: 'Other', human: true }]
  chat = new ChatHub({ cid: 'machine', privKey: new Uint8Array(32), pubKey: new Uint8Array(32), statePath: join(dir, 'chat.json'), rootDir: dir, procLister: () => [], botCliAvailable: async () => true, rosterSessions: async () => ({ terminals: [{ name: 'term-source', cwd: dir }], agentSessions: [] }), runBot: async () => { legacyRuns++; return { text: 'legacy' } }, commandSandbox: () => true,
    sendEnvelope: (env: GroupEnvelope) => queueMicrotask(() => {
      if (env.op === 'group-post') posted.push(JSON.parse(new TextDecoder().decode(open(key, Buffer.from((env.payload as any).ct, 'base64')))))
      const p = env.payload as Record<string, unknown>; const gid = String(env.groupId ?? p.inviteCode)
      chat.onEnvelope({ op: 'group-result', payload: { reqId: env.reqId, ok: true, data: env.op === 'group-join' ? { groupId: gid, snapshot: { seq: 0, meta: { name: '私聊·Test', createdBy: 'owner', createdAt: 0 }, members: [...members, { memberId: 'bot', ...(p.member as object) }] } } : { meta: { createdBy: 'owner', createdAt: 0 }, members, msgs: [], seq: 0 } } })
    }),
  })
  chat.setKey('dm', Buffer.from(key).toString('base64')); chat.setKey('team', Buffer.from(key).toString('base64'))
  await chat.addAgent({ code: 'dm', name: 'Test', groupId: 'dm', platform: 'codex', sourceSessionId: 'term-source', botProtocol: 1, botPolicyProtocol: 1, permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'allow', execute: 'allow', commanders: 'members', allowedPhoneIds: [] } }, 'owner')
  await chat.addAgent({ code: 'team', name: 'Test', groupId: 'team', platform: 'codex', sourceSessionId: 'term-source', botProtocol: 1 }, 'owner')
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const runtime = new BotRuntimeService({ routerQuietMs: 0, store, rootDir: dir, getBot: name => chat.runtimeBot(name), sendReply: reply => chat.sendRuntimeReply(reply), checkAccess: (bot, memberId, op) => chat.checkRuntimeAccess(bot.botId, memberId, op), openTools: () => { throw new Error('not used') }, createClient: role => role === 'memory' ? silentMemoryClient() : ({ initialize: async () => {}, startThread: async () => { throw new Error('model disabled in RPC test') }, resumeThread: async () => 'x', startTurn: async () => { throw new Error('not used') }, steer: async () => 'x', interrupt: async () => {}, close: async () => {} }) })
  chat.attachBotRuntime(runtime)
  cleanups.push(async () => { await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const message = (seq: number, groupId = 'dm', memberId = 'owner-member', body: object = { text: '你好' }) => chat.onEnvelope({ op: 'group-msg', groupId, payload: { seq, ts: Date.now(), from: { memberId, name: 'Owner', human: true }, ct: Buffer.from(seal(key, new TextEncoder().encode(JSON.stringify({ kind: 'text', ...body })))).toString('base64') } })
  return { chat, runtime, store, message, dir, posted, legacyRuns: () => legacyRuns }
}
test('runtime 管理只允许真实 owner，Bot ID 持久且切换后群入口不能走旧执行链', async () => {
  const f = await fixture()
  expect((await f.chat.botRuntime('Test', 'other')).ok).toBe(false)
  const before = await f.chat.botRuntime('Test', 'owner')
  expect(before).toMatchObject({ ok: true, data: { settings: { mode: 'legacy', revision: 0 } } })
  expect((await f.chat.botRuntimeUpdate('Test', 'owner', 0, { mode: 'router-worker' })).ok).toBe(true)
  const botId = f.chat.runtimeBot('Test').botId
  expect(f.chat.runtimeBot(botId).botId).toBe(botId)
  f.message(1, 'dm'); f.message(1, 'team'); f.message(2, 'dm', 'other-member')
  await Bun.sleep(50)
  expect(f.legacyRuns()).toBe(0)
  expect(f.store.messages(botId)).toHaveLength(1)
})

test('附件 RPC 校验连接 owner；无文字的附件消息也持久进入 Runtime', async () => {
  const f = await fixture()
  await f.chat.botRuntimeUpdate('Test', 'owner', 0, { mode: 'router-worker' })
  const begin = { action: 'begin' as const, requestId: 'file-1', name: 'input.txt', size: 5, mime: 'text/plain' }
  expect(f.chat.botUpload('Test', 'other', begin).ok).toBe(false)
  const upload = f.chat.botUpload('Test', 'owner', begin).data as { id: string }
  f.chat.botUpload('Test', 'owner', { action: 'chunk', uploadId: upload.id, offset: 0, data: Buffer.from('hello').toString('base64') })
  const attachment = f.chat.botUpload('Test', 'owner', { action: 'finish', uploadId: upload.id, hash: createHash('sha256').update('hello').digest('hex') }).data
  f.message(1, 'dm', 'owner-member', { text: '', attachments: [attachment] })
  await Bun.sleep(50)
  expect(f.store.messages(f.chat.runtimeBot('Test').botId)[0].attachments).toMatchObject([{ name: 'input.txt' }])
  expect(f.chat.botAttachment('Test', 'other', { id: upload.id, kind: 'upload' }, 0, 10).ok).toBe(false)
  expect(f.chat.botAttachment('Test', 'owner', { id: upload.id, kind: 'upload' }, 0, 10)).toMatchObject({ ok: true, data: { data: Buffer.from('hello').toString('base64') } })
})

test('Router 整理后的成果引用与正文一起加密发送，不把本地路径或文件字节放进群消息', async () => {
  const f = await fixture()
  await f.chat.botRuntimeUpdate('Test', 'owner', 0, { mode: 'router-worker' })
  const bot = f.chat.runtimeBot('Test')
  const input = f.store.receive({ botId: bot.botId, groupId: 'dm', seq: 100, senderId: 'owner', memberId: 'owner-member', text: '写报告', createdAt: Date.now() })
  const task = f.store.acceptWork({ inputId: input.id, newCase: { title: '报告', object: '报告', goal: '报告' }, goal: '写报告', acceptance: [], mandate: { ownerPhoneId: 'owner', policyRevision: bot.policyRevision, directory: bot.directory, allowedOps: ['read'], exclusions: [], mode: 'execute' }, replyText: '开始整理。' })
  f.store.cancelReplies(bot.botId)
  f.store.updateTask(task.id, { state: 'running' })
  const path = join(f.dir, 'report.html'); const content = '<h1>完整报告</h1>'; writeFileSync(path, content)
  f.store.saveArtifact({ id: 'artifact-report', botId: bot.botId, caseId: task.caseId, taskId: task.id, path, title: '报告', name: 'report.html', mime: 'text/html', size: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex'), revision: 1, createdAt: Date.now() })
  f.store.finishTask(task.id, 1, '报告在附件中。', ['artifact-report'])
  const source = f.store.pendingReplies(bot.botId)[0]
  await expect(f.chat.sendRuntimeReply(source)).rejects.toThrow()
  f.store.presentWorkerReply(bot.botId, source.id, ['报告在附件中。'], '')
  await f.chat.sendRuntimeReply(f.store.pendingReplies(bot.botId)[0])
  expect(f.posted[0]).toMatchObject({ text: '报告在附件中。', attachments: [{ id: 'artifact-report', kind: 'artifact', name: 'report.html' }] })
  expect(JSON.stringify(f.posted)).not.toContain(path)
  expect(JSON.stringify(f.posted)).not.toContain(content)
})

const memory = (p: { id: string; botId: string; prompt: string; source: { inboxId: string; quote: string } }): RuntimeMemory =>
  ({ channel: 'dm', senderId: 'owner', tier: 'long', status: 'active', triggers: { count: 1 }, createdAt: 1, updatedAt: 1, id: p.id, botId: p.botId, prompt: p.prompt, source: { ...p.source, context: '', sentAt: 1 } })

test('记忆管理只允许 owner；压下后不再进上下文，流水可见', async () => {
  const f = await fixture()
  await f.chat.botRuntimeUpdate('Test', 'owner', 0, { mode: 'router-worker' })
  const bot = f.chat.runtimeBot('Test')
  f.store.saveMemory(memory({ id: 'rule', botId: bot.botId, prompt: '回复保持简短', source: { inboxId: 'msg-rule', quote: '以后都简短点' } }))
  expect((await f.chat.botMemoryControl('Test', 'other', { requestId: 'r1', action: 'suppress', id: 'rule' })).ok).toBe(false)
  expect(f.store.memory('rule')?.status).toBe('active')
  expect((await f.chat.botMemoryControl('Test', 'owner', { requestId: 'r1', action: 'suppress', id: 'rule' })).data?.memory.log.map(l => l.action)).toEqual(['suppress'])
  expect(f.store.memory('rule')?.status).toBe('suppressed')
  expect((await f.chat.botRuntime('Test', 'owner')).data?.memory.active).toEqual([])
})

test('撤回消息重播到本机：以它为原话的规矩作废，本地原文清空', async () => {
  const f = await fixture()
  await f.chat.botRuntimeUpdate('Test', 'owner', 0, { mode: 'router-worker' })
  const bot = f.chat.runtimeBot('Test')
  f.message(1, 'dm', 'owner-member', { text: '以后都简短点' })
  await Bun.sleep(50)
  const stored = f.store.messages(bot.botId)[0]
  f.store.saveMemory(memory({ id: 'rule', botId: bot.botId, prompt: '回复保持简短', source: { inboxId: stored.id, quote: '以后都简短点' } }))
  f.chat.onEnvelope({ op: 'group-msg', groupId: 'dm', payload: { seq: 1, ts: Date.now(), revokedAt: Date.now(), from: { memberId: 'owner-member', name: 'Owner', human: true }, ct: '' } })
  expect(f.store.memory('rule')?.status).toBe('revoked')
  expect(f.store.inbox(stored.id)).toMatchObject({ text: '', revokedAt: expect.any(Number) })
  expect(f.store.inbox(stored.id)?.attachments).toBeUndefined()
})

test('chat.botComputers 三个接口:只有创建者能管理,票据严格校验,密钥不回显', async () => {
  const f = await fixture()
  const name = 'Test' // fixture 里 addAgent({name:'Test', botProtocol:1}, 'owner') 注册的数字员工
  const actor = 'owner'
  const good = { grantId: 'grant_abc123def456', peerId: 'grant-abc123def456', key: Buffer.alloc(32, 3).toString('base64'), label: '运维@机器B', directory: '/proj', directoryAbs: '/srv/b', relayUrl: 'ws://relay.test', sid: 's1', cliPub: 'pub', token: 'tok' }
  expect(f.chat.botComputerAdd(name!, 'stranger', good).error).toMatch(/创建者/)
  expect(f.chat.botComputerAdd(name!, actor, { ...good, key: 'short' }).error).toMatch(/密钥/)
  expect(f.chat.botComputerAdd(name!, actor, { ...good, grantId: 'nope' }).error).toMatch(/凭证编号/)
  expect(f.chat.botComputerAdd(name!, actor, good)).toMatchObject({ ok: true })
  const listed = f.chat.botComputers(name!, actor)
  expect(listed.ok).toBe(true)
  expect(listed.data).toHaveLength(1)
  expect(JSON.stringify(listed)).not.toContain('secret')
  expect(JSON.stringify(listed)).not.toContain(good.key.slice(0, 8))
  const ticket = f.chat.remoteTicket(name!, 'grant_abc123def456')
  expect(ticket?.key).toBe(good.key) // 密钥留在宿主,给运行时用
  expect(await f.chat.botComputerRemove(name!, actor, 'grant_abc123def456')).toMatchObject({ ok: true })
  expect(f.chat.botComputers(name!, actor).data).toHaveLength(0)
  expect((await f.chat.botComputerRemove(name!, actor, 'grant_abc123def456')).error).toMatch(/不在登记/)
})
