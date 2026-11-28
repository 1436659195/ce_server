import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryEmbedding } from '../src/cli/bot-runtime/memory-retrieval'
import { BotRuntimeService, type RuntimeClient, type RuntimeClientOptions } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { CodexToolCall, CodexTurn } from '../src/cli/bot-runtime/codex'
import type { RuntimeBot, RuntimeMemory, RuntimeReply } from '../src/cli/bot-runtime/types'

const DAY = 86_400_000
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function until(check: () => boolean, max = 400) {
  for (let i = 0; i < max && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}
function memory(p: Partial<RuntimeMemory> & Pick<RuntimeMemory, 'id' | 'prompt'>): RuntimeMemory {
  const now = Date.now()
  return { botId: 'b', channel: 'dm', senderId: 'owner', tier: 'long', status: 'active', source: { inboxId: `msg-${p.id}`, quote: p.prompt, context: '', sentAt: now }, triggers: { count: 0 }, createdAt: now, updatedAt: now, ...p }
}
function fixture(options: { tickMs?: number; memoryEmbedding?: MemoryEmbedding; getBot?: (botId: string) => RuntimeBot } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-memory-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'b', name: '小林', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: dir, directory: dir, platform: 'codex', policyRevision: 1, commandSandbox: false,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  const turns: Array<{ context: any; decide: (args: Record<string, unknown>) => Promise<any>; call: (tool: string, args: Record<string, unknown>) => Promise<any>; finish: () => void }> = []
  const sent: RuntimeReply[] = []
  const memoryPayloads: any[] = []
  const proposals: Array<(payload: any) => Record<string, unknown> | undefined> = []
  const state = { memoryCalls: 0, memoryFail: false }
  const createClient = (role: 'router' | 'worker' | 'memory', options: RuntimeClientOptions): RuntimeClient => {
    if (role === 'worker') throw new Error('test leaves tasks queued')
    if (role === 'memory') {
      state.memoryCalls++
      return { initialize: async () => {}, startThread: async () => 'memory-thread', resumeThread: async (id: string) => id,
        startTurn: async (threadId: string, text: string) => {
          if (state.memoryFail) throw new Error('memory model down')
          const payload = JSON.parse(text); memoryPayloads.push(payload)
          const proposal = proposals.shift()
          const done = (async () => {
            if (proposal) await options.onToolCall({ threadId, turnId: 'memory-turn', callId: 'memory-turn', tool: 'memory_commit', arguments: proposal(payload) ?? {} } satisfies CodexToolCall)
            return { id: 'memory-turn', status: 'completed' } satisfies CodexTurn
          })()
          return { threadId, turnId: 'memory-turn', done }
        }, steer: async () => '', interrupt: async () => {}, close: async () => {} }
    }
    let resolve: ((turn: CodexTurn) => void) | undefined
    return { initialize: async () => {}, startThread: async () => 'thread', resumeThread: async (id: string) => id,
      startTurn: async (threadId: string, text: string) => {
        const turnId = `turn-${turns.length}`
        const done = new Promise<CodexTurn>(r => { resolve = r })
        const complete = resolve!
        turns.push({ context: JSON.parse(text), call: (tool, args) => options.onToolCall({ threadId, turnId, callId: `${turnId}:${tool}`, tool, arguments: args }), decide: async (args: Record<string, unknown>) => options.onToolCall({ threadId, turnId, callId: turnId, tool: 'router_decide', arguments: { decision: args.decision ?? { action: args.action ?? 'reply' }, feasibility: 'can', replies: args.replies ?? [], basis: args.basis, memoryIds: args.memoryIds } }), finish: () => complete({ id: turnId, status: 'completed' }) })
        return { threadId, turnId, done }
      }, steer: async () => '', interrupt: async () => {}, close: async () => { resolve?.({ id: 'closed', status: 'interrupted' }) } }
  }
  const serviceOptions = { memoryEmbedding: options.memoryEmbedding, store, rootDir: dir, routerQuietMs: 0, bubbleGapMs: 0, tickMs: options.tickMs ?? 3_600_000, getBot: options.getBot ?? (() => bot), sendReply: async (reply: RuntimeReply) => { sent.push(reply) }, checkAccess: async () => { throw new Error('no worker') }, openTools: () => { throw new Error('no worker') }, createClient }
  let service = new BotRuntimeService(serviceOptions)
  store.saveSettings({ ...store.settings('b'), mode: 'router-worker', revision: 1 })
  let seq = 0
  const send = (text: string, targetTaskId?: string) => service.receive('b', { groupId: 'dm', seq: ++seq, text, targetTaskId, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const restart = async () => { await service.close(); service = new BotRuntimeService(serviceOptions) }
  cleanups.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { get service() { return service }, store, bot, turns, sent, send, memoryPayloads, proposals, state, restart }
}


const change = (payload: any, extra: Record<string, unknown> = {}) => ({ action: 'save', tier: 'long', kind: 'preference', topic: '回复长度', prompt: '回复保持简短', core: true, sourceInboxId: payload.batch[0].id, quote: payload.batch[0].text.slice(0, 100), ...extra })
const command = (payload: any, changes: unknown[]) => ({ requestId: payload.batchId, expectedRevision: payload.revision, changes })

test('background sees full messages, commits multiple topics through the shared writer and records real success', async () => {
  const f = fixture({ tickMs: 10 })
  f.proposals.push(p => command(p, [change(p), change(p, { topic: '称呼', prompt: '称呼用户老王', quote: '以后叫我老王' })]))
  const text = '以后回复简短。' + '背景信息'.repeat(600) + '以后叫我老王'
  const message = f.send(text); await until(() => f.turns.length === 1)
  expect(f.state.memoryCalls).toBe(0)
  await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
  await until(() => f.store.inbox(message.id)?.memoryJob?.state === 'done')
  expect(f.memoryPayloads[0].batch[0].text).toBe(text)
  expect(f.store.memories('b')).toHaveLength(2)
  expect(f.store.memoryLog('b').map(l => l.actor)).toEqual(['memory', 'memory'])
  await f.restart(); await Bun.sleep(30); expect(f.state.memoryCalls).toBe(1)
})

test('a retired bot left enabled in the store must not break the background tick for the others', async () => {
  // 2026-11-28 线上:已注销 Bot 仍在 enabledBots,sweepMemories → getBot 抛错逃出 setInterval 回调 → daemon 退出 → 手机掉线。
  const f = fixture({ tickMs: 10, getBot: id => { if (id === 'gone') throw new Error('Bot 未配置 owner 权限或已注销'); return f.bot } })
  f.store.saveSettings({ ...f.store.settings('gone'), mode: 'router-worker', revision: 1 })
  expect(() => (f.service as any).sweepMemories('gone')).not.toThrow()
  f.proposals.push(p => command(p, [change(p)]))
  const msg = f.send('以后回复简短。')
  await until(() => f.turns.length === 1); await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
  await until(() => f.store.inbox(msg.id)?.memoryJob?.state === 'done')
})

test('a synchronous tick step failure is logged once and later background work still completes', async () => {
  const f = fixture({ tickMs: 10 })
  const runtime = f.service as any
  runtime.sweepMemories = () => { throw new Error('injected sweep failure') }
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    f.proposals.push(p => command(p, [change(p)]))
    const msg = f.send('以后回复简短。')
    await until(() => f.turns.length === 1)
    await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
    await until(() => f.store.inbox(msg.id)?.memoryJob?.state === 'done')
    expect(f.store.memories('b')).toHaveLength(1)
    runtime.tick(); runtime.tick()
    expect(log.mock.calls.filter(([message]) => String(message).includes('injected sweep failure'))).toHaveLength(1)
  } finally { log.mockRestore() }
})

test('a missing or rejected memory commit is failure, not a successful empty extraction', async () => {
  const f = fixture({ tickMs: 10 }); const msg = f.send('以后都简短点')
  await until(() => f.turns.length === 1); await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
  await until(() => f.store.inbox(msg.id)?.memoryJob?.state === 'failed')
  expect(f.service.view('b', 'owner').memory.failedJobs.map(j => j.id)).toContain(msg.id)
  expect(f.sent).toHaveLength(1)
})

test('explicit Router write returns receipt, updates next disclosure, and background deduplicates explicit saves', async () => {
  const f = fixture({ tickMs: 10 }); f.proposals.push(p => command(p, [change(p)])); const msg = f.send('记住以后回复简短')
  await until(() => f.turns.length === 1)
  const turn = f.turns[0]
  const receipt = await turn.call('memory_write', { requestId: 'remember', expectedRevision: turn.context.memories.revision, changes: [{ action: 'save', tier: 'long', kind: 'preference', topic: '回复长度', prompt: '回复保持简短', core: true, sourceInboxId: msg.id, quote: msg.text }] })
  expect(receipt.items[0]).toMatchObject({ version: 1, action: 'save' })
  await turn.decide({ replies: ['已记住。'], memoryIds: [receipt.items[0].id] }); turn.finish()
  await until(() => f.store.inbox(msg.id)?.memoryJob?.state === 'done'); expect(f.state.memoryCalls).toBe(1); expect(f.store.memories('b')).toHaveLength(1)
  f.send('你好'); await until(() => f.turns.length === 2)
  expect(f.turns[1].context.memories.long.map((m: any) => m.id)).toEqual([receipt.items[0].id])
})

test('disclosure and actual adoption are counted separately and unknown memory IDs are rejected', async () => {
  const f = fixture(); f.store.saveMemory(memory({ id: 'mine', prompt: '报告要简短', format: 2, version: 1, core: true }))
  f.send('报告写简短一点'); await until(() => f.turns.length === 1)
  await expect(f.turns[0].decide({ memoryIds: ['unknown'] })).rejects.toThrow(/记忆/)
  await f.turns[0].decide({ replies: ['好。'], memoryIds: [] }); f.turns[0].finish(); await until(() => f.sent.length === 1)
  expect(f.store.memory('mine')).toMatchObject({ recalls: 1 })
  expect(f.store.memory('mine')?.uses ?? 0).toBe(0)
})

test('memory query is scoped, source IDs use existing chat_read, owner controls invalidate context', async () => {
  const f = fixture(); const msg = f.send('以后简短回复'); await until(() => f.turns.length === 1)
  const turn = f.turns[0]
  const receipt = await turn.call('memory_write', { requestId: 'remember', expectedRevision: turn.context.memories.revision, changes: [{ action: 'save', tier: 'long', kind: 'preference', topic: '回复长度', prompt: '回复保持简短', core: true, sourceInboxId: msg.id, quote: msg.text }] })
  const found = await turn.call('memory_search', { topic: '回复长度' }); expect(found.items[0].id).toBe(receipt.items[0].id)
  const full = await turn.call('memory_read', { id: receipt.items[0].id }); expect(full.memory.source.inboxId).toBe(msg.id)
  await f.service.memoryControl('b', 'owner', { requestId: 'forget', action: 'revoke', id: receipt.items[0].id })
  await expect(turn.decide({ memoryIds: [receipt.items[0].id] })).rejects.toThrow(/记忆|失效|变化/)
})

test('time expiry never promotes hot memories or expires them after ten rounds', async () => {
  const f = fixture({ tickMs: 10 }); const now = Date.now()
  f.store.saveMemory(memory({ id: 'hot', prompt: '报告要简短', tier: 'mid', bornRound: 0, expiresAt: now + DAY, triggers: { count: 99 } }))
  f.store.saveMemory(memory({ id: 'expired', prompt: '旧规则', tier: 'mid', expiresAt: now - 1 }))
  f.store.saveSettings({ ...f.store.settings('b'), rounds: 100 })
  await until(() => f.store.memory('expired')?.status === 'expired')
  expect(f.store.memory('hot')).toMatchObject({ tier: 'mid', status: 'active' })
})

test('owner revocation of source clears local original and invalidates only affected rules', async () => {
  const f = fixture(); const msg = f.send('以后简短回复'); await until(() => f.turns.length === 1)
  const rule = memory({ id: 'rule', prompt: '回复保持简短', source: { inboxId: msg.id, quote: msg.text, context: msg.text, sentAt: msg.createdAt } }); f.store.saveMemory(rule)
  f.service.revokeMessage('b', 'dm', msg.seq, Date.now())
  expect(f.store.inbox(msg.id)?.text).toBe(''); expect(f.store.memory('rule')?.status).toBe('revoked')
  await expect(f.service.memoryControl('b', 'other', { requestId: 'foreign', id: 'rule', action: 'unsuppress' })).rejects.toThrow(/owner|创建者/)
})

test('background still extracts an independent preference after an explicit Router save', async () => {
  const f = fixture({ tickMs: 10 })
  f.proposals.push(p => command(p, [change(p), change(p, { topic: '称呼', prompt: '称呼用户老王', quote: '以后叫我老王' })]))
  const msg = f.send('记住以后简短回复。以后叫我老王'); await until(() => f.turns.length === 1)
  const turn = f.turns[0]
  await turn.call('memory_write', { requestId: 'remember', expectedRevision: turn.context.memories.revision, changes: [{ action: 'save', tier: 'long', kind: 'preference', topic: '回复长度', prompt: '回复保持简短', core: true, sourceInboxId: msg.id, quote: '记住以后简短回复' }] })
  await turn.decide({ replies: ['已记住。'] }); turn.finish()
  await until(() => f.store.inbox(msg.id)?.memoryJob?.state === 'done')
  expect(f.store.memories('b').map(m => m.topic).sort()).toEqual(['回复长度','称呼'])
})

test('new tasks cannot adopt the prior task or case memory even when disclosed or read', async () => {
  const f = fixture()
  const input = f.store.receive({ botId: 'b', groupId: 'dm', senderId: 'owner', memberId: 'om', text: '整理财务报告', seq: 0, createdAt: Date.now() })
  const old = f.store.acceptWork({ inputId: input.id, newCase: { title: '财务', object: '财务', goal: '报告' }, goal: '整理财务报告', acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: f.bot.directory, allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  f.store.saveMemory(memory({ id: 'task-rule', prompt: '报告必须十页', scope: { taskId: old.id }, format: 2, version: 1 }))
  f.store.saveMemory(memory({ id: 'case-rule', prompt: '报告必须十页', scope: { caseId: old.caseId }, format: 2, version: 1 }))
  f.send('新建网站'); await until(() => f.turns.length === 1)
  const turn = f.turns[0]
  for (const id of ['task-rule', 'case-rule']) await turn.call('memory_read', { id })
  const base = { action: 'start', goal: '新建网站', delivery: 'chat', allowedOps: ['read'] }
  const dossier = { kind: 'new', title: '网站', object: '网站', goal: '新建网站', reason: '与财务无关的独立事项' }
  for (const id of ['task-rule', 'case-rule']) await expect(turn.decide({ decision: { ...base, dossier }, memoryIds: [id] })).rejects.toThrow(/记忆|范围/)
  // Reusing a case does not grant the new task access to another task's rule.
  const existing = { kind: 'existing', caseId: old.caseId, relation: 'next_step', reason: '后续任务' }
  await expect(turn.decide({ decision: { ...base, dossier: existing }, memoryIds: ['task-rule'] })).rejects.toThrow(/记忆|范围/)
  expect(f.store.tasks('b')).toHaveLength(1)
  await turn.decide({ decision: { ...base, dossier: existing }, memoryIds: ['case-rule'] }); turn.finish()
  expect(f.store.tasks('b')).toHaveLength(2)
  expect(f.store.memory('case-rule')?.uses).toBe(1)
})


test('direct replies can adopt memory belonging to the explicitly addressed task', async () => {
  const f = fixture()
  const input = f.store.receive({ botId: 'b', groupId: 'dm', senderId: 'owner', memberId: 'om', text: '整理财务报告', seq: 0, createdAt: Date.now() })
  const task = f.store.acceptWork({ inputId: input.id, newCase: { title: '财务', object: '财务', goal: '报告' }, goal: '整理财务报告', acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: f.bot.directory, allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  f.store.saveMemory(memory({ id: 'rule', prompt: '报告必须十页', scope: { taskId: task.id }, format: 2, version: 1 }))
  f.send('报告格式是什么？', task.id); await until(() => f.turns.length === 1)
  const turn = f.turns[0]
  expect(turn.context.memories.long.map((m: any) => m.id)).toEqual(['rule'])
  await turn.decide({ replies: ['报告要求十页。'], memoryIds: ['rule'] }); turn.finish()
  expect(f.store.memory('rule')?.uses).toBe(1)
})

test('a memory tool result cannot silently adopt a newer revision than the returned snapshot', async () => {
  const f = fixture(); f.store.saveMemory(memory({ id: 'rule', prompt: '报告要简短', core: true, format: 2, version: 1 }))
  f.send('报告格式是什么？'); await until(() => f.turns.length === 1)
  const turn = f.turns[0]
  const search = f.service.memoryRetrieval.search.bind(f.service.memoryRetrieval)
  let changed = false
  f.service.memoryRetrieval.search = async (...args) => {
    const result = await search(...args)
    if (!changed) { changed = true; f.store.memoryLibrary.control({ botId: 'b', channel: 'dm', senderId: 'owner' }, 'rule', 'purge') }
    return result
  }
  const result = await turn.call('memory_search', { topic: 'rule' })
  expect(result.revision).not.toBe(f.store.memoryLibrary.revision({ botId: 'b', channel: 'dm', senderId: 'owner' }))
  await expect(turn.decide({ replies: ['收到。'] })).rejects.toThrow(/记忆已变化/)
  await turn.call('memory_search', { topic: 'rule' })
  await turn.decide({ replies: ['收到。'] }); turn.finish()
})

test('background commits both time windows from a single message in one atomic memory_commit', async () => {
  const f = fixture({ tickMs: 10 })
  f.proposals.push(p => {
    const start = p.batch[0].sentAt
    return command(p, [
      change(p, { tier: 'mid', core: false, prompt: '简短回复', quote: '简短回复', startsAt: start, expiresAt: start + DAY }),
      change(p, { tier: 'mid', core: false, prompt: '详细回复', quote: '详细回复', startsAt: start + DAY, expiresAt: start + 2 * DAY }),
    ])
  })
  const msg = f.send('今天简短回复，明天详细回复'); await until(() => f.turns.length === 1)
  await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
  await until(() => ['done', 'failed'].includes(f.store.inbox(msg.id)?.memoryJob?.state ?? ''))
  expect(f.store.inbox(msg.id)?.memoryJob?.state).toBe('done')
  expect(f.state.memoryCalls).toBe(1)
  expect(f.store.memories('b').map(m => m.prompt)).toEqual(['简短回复', '详细回复'])
})
