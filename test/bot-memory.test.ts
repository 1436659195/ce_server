import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_LIMITS, parseMemoryProposal, planMemoryChange, relevance, selectMemories, tokenize } from '../src/cli/bot-runtime/memory'
import { BotRuntimeService, type RuntimeClient, type RuntimeClientOptions } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { CodexToolCall, CodexTurn } from '../src/cli/bot-runtime/codex'
import type { RuntimeBot, RuntimeInbox, RuntimeMemory, RuntimeReply } from '../src/cli/bot-runtime/types'

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
function fixture(options: { tickMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-memory-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'b', name: '小林', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: dir, directory: dir, platform: 'codex', policyRevision: 1, commandSandbox: false,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  const turns: Array<{ context: any; decide: (args: Record<string, unknown>) => Promise<any>; finish: () => void }> = []
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
        turns.push({ context: JSON.parse(text), decide: async (args: Record<string, unknown>) => options.onToolCall({ threadId, turnId, callId: turnId, tool: 'router_decide', arguments: { decision: { action: args.action ?? 'reply' }, feasibility: 'can', replies: args.replies ?? [], basis: args.basis } }), finish: () => complete({ id: turnId, status: 'completed' }) })
        return { threadId, turnId, done }
      }, steer: async () => '', interrupt: async () => {}, close: async () => { resolve?.({ id: 'closed', status: 'interrupted' }) } }
  }
  const serviceOptions = { store, rootDir: dir, routerQuietMs: 0, bubbleGapMs: 0, tickMs: options.tickMs ?? 3_600_000, getBot: () => bot, sendReply: async (reply: RuntimeReply) => { sent.push(reply) }, checkAccess: async () => { throw new Error('no worker') }, openTools: () => { throw new Error('no worker') }, createClient }
  let service = new BotRuntimeService(serviceOptions)
  store.saveSettings({ ...store.settings('b'), mode: 'router-worker', revision: 1 })
  let seq = 0
  const send = (text: string) => service.receive('b', { groupId: 'dm', seq: ++seq, text, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const restart = async () => { await service.close(); service = new BotRuntimeService(serviceOptions) }
  cleanups.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { get service() { return service }, store, bot, turns, sent, send, memoryPayloads, proposals, state, restart }
}

test('相关度：中文按字和二字组，英文数字按词', () => {
  expect([...tokenize('报告 Report2026 要简短')]).toEqual(expect.arrayContaining(['报告', '要简', '简短', 'report', '2026']))
  const base = memory({ id: 'm', prompt: '报告要简短' })
  expect(relevance(base, tokenize('报告写简短一点'))).toBeGreaterThan(relevance(base, tokenize('今天天气不错')))
  expect(relevance(base, tokenize('report'))).toBe(0)
})

test('长期记忆全部常驻，超过 30 条只计数；中期按相关程度取 10 条', () => {
  const now = Date.now()
  const long = Array.from({ length: 31 }, (_, i) => memory({ id: `l${i}`, prompt: `长期规矩${i}`, updatedAt: now + i }))
  const mid = Array.from({ length: 12 }, (_, i) => memory({ id: `m${i}`, prompt: i < 3 ? `报告要简短${i}` : `无关偏好${i}`, tier: 'mid', bornRound: 1, expiresAt: now + DAY }))
  const selection = selectMemories([...long, ...mid], '报告写简短一点', now, 3)
  expect(selection.long).toHaveLength(MEMORY_LIMITS.long)
  expect(selection.overflow).toBe(1)
  expect(selection.mid).toHaveLength(MEMORY_LIMITS.mid)
  expect(selection.mid.slice(0, 3).map(m => m.id)).toEqual(['m0', 'm1', 'm2'])
  expect(selection.triggered).toEqual(expect.arrayContaining(['m0', 'm1', 'm2']))
})

test('中期记忆 10 轮或 7 天先到为准，到期的不进上下文', () => {
  const now = Date.now()
  const byRound = memory({ id: 'r', prompt: '报告要简短', tier: 'mid', bornRound: 2, expiresAt: now + DAY })
  const byTime = memory({ id: 't', prompt: '报告要简短', tier: 'mid', bornRound: 90, expiresAt: now - 1 })
  const alive = memory({ id: 'a', prompt: '报告要简短', tier: 'mid', bornRound: 5, expiresAt: now + DAY })
  const selection = selectMemories([byRound, byTime, alive], '报告写简短一点', now, 12)
  expect(selection.mid.map(m => m.id)).toEqual(['a'])
  expect(selection.expired).toEqual(['r', 't'])
})

test('慢路核对：来源不在本批、引文不是原话都不写；长期还是近期、是否取代旧规矩由模型判断', () => {
  const now = Date.now()
  const batch = [{ id: 'in-1', botId: 'b', groupId: 'dm', text: '以后都简短点', senderId: 'owner', createdAt: 1 }, { id: 'in-2', botId: 'b', groupId: 'dm', text: '太长了', senderId: 'owner', createdAt: 2 }] as RuntimeInbox[]
  const parse = (args: Record<string, unknown>) => parseMemoryProposal(args)!
  expect(planMemoryChange(parse({ intent: 'none' }), batch, [], now, 3).ops).toBeUndefined()
  expect(planMemoryChange(parse({ intent: 'preference', tier: 'mid', prompt: 'x', sourceInboxId: 'in-other', quote: '太长了' }), batch, [], now, 3).reject).toContain('本批')
  expect(planMemoryChange(parse({ intent: 'preference', tier: 'mid', prompt: 'x', sourceInboxId: 'in-1', quote: '我没说过这句' }), batch, [], now, 3).reject).toContain('原话')
  // 不靠词表：没有「以后」这类词，模型判长期就是长期；没给档位按近期记并带到期。
  const plain = planMemoryChange(parse({ intent: 'preference', tier: 'long', prompt: '回复短一点', sourceInboxId: 'in-2', quote: '太长了' }), batch, [], now, 3)
  expect(plain.ops?.[0]).toMatchObject({ tier: 'long', status: 'active', channel: 'dm', senderId: 'owner', source: { inboxId: 'in-2', quote: '太长了' } })
  expect(plain.ops?.[0].expiresAt).toBeUndefined()
  const unset = planMemoryChange(parse({ intent: 'preference', prompt: '回复短一点', sourceInboxId: 'in-2', quote: '太长了' }), batch, [], now, 3)
  expect(unset.ops?.[0]).toMatchObject({ tier: 'mid', bornRound: 3 })
  expect(unset.ops?.[0].expiresAt).toBe(now + 7 * DAY)
  const old = memory({ id: 'old', prompt: '回复写详细一点' })
  const replaced = planMemoryChange(parse({ intent: 'preference', tier: 'mid', prompt: '短一点', sourceInboxId: 'in-2', quote: '太长了', conflicts: [{ memoryId: 'old', relation: 'supersedes' }] }), batch, [old], now, 3)
  expect(replaced.ops?.find(op => op.id === 'old')).toMatchObject({ status: 'superseded', supersededBy: expect.any(String) })
  expect(replaced.ops?.find(op => op.id !== 'old')).toMatchObject({ supersedes: 'old' })
  expect(replaced.logs?.map(l => l.action)).toContain('supersede')
  // 以下重复与计数的情形保持原样
})

test('同一条原话再说一遍不重复记；换一句原话重复同一件事只加次数', () => {
  const now = Date.now()
  const batch = [{ id: 'in-1', botId: 'b', groupId: 'dm', text: '以后都简短点', senderId: 'owner', createdAt: 1 }, { id: 'in-2', botId: 'b', groupId: 'dm', text: '太长了', senderId: 'owner', createdAt: 2 }] as RuntimeInbox[]
  const parse = (args: Record<string, unknown>) => parseMemoryProposal(args)!
  const sameSource = memory({ id: 'same', prompt: '回复保持简短', source: { inboxId: 'in-1', quote: '以后都简短点', context: '', sentAt: 1 } })
  const sameMessage = planMemoryChange(parse({ intent: 'preference', tier: 'long', prompt: '回复保持简短', sourceInboxId: 'in-1', quote: '以后都简短点', conflicts: [{ memoryId: 'same', relation: 'duplicate' }] }), batch, [sameSource], now, 3)
  expect(sameMessage.ops).toEqual([])
  expect(sameMessage.logs).toEqual([])
  const twin = memory({ id: 'twin', prompt: '回复保持简短', triggers: { count: 1 } })
  const bump = planMemoryChange(parse({ intent: 'preference', tier: 'long', prompt: '回复保持简短', sourceInboxId: 'in-2', quote: '太长了', conflicts: [{ memoryId: 'twin', relation: 'duplicate' }] }), batch, [twin], now, 3)
  expect(bump.ops?.[0]).toMatchObject({ id: 'twin', triggers: { count: 2 }, extraSources: [{ inboxId: 'in-2', quote: '太长了' }] })
  expect(bump.logs?.[0]).toMatchObject({ action: 'duplicate', memoryId: 'twin' })
})

test('每一轮主人话提交后都排一次记忆整理；模型判是长期规矩就落长期；同一批只整理一次，重启不重复', async () => {
  const f = fixture({ tickMs: 10 })
  f.proposals.push(payload => ({ intent: 'preference', tier: 'long', prompt: '回复保持简短', sourceInboxId: payload.batch[0].id, quote: '以后都简短点' }))
  const message = f.send('以后都简短点'); await until(() => f.turns.length === 1)
  expect(f.turns[0].context.memories).toEqual({ long: [], mid: [], overflow: 0 })
  expect(f.state.memoryCalls).toBe(0)
  await f.turns[0].decide({ replies: ['好，以后简短。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
  await until(() => f.store.memories('b').length === 1)
  expect(f.store.memories('b')[0]).toMatchObject({ tier: 'long', status: 'active', prompt: '回复保持简短', channel: 'dm', senderId: 'owner', source: { inboxId: message.id, quote: '以后都简短点' } })
  expect(f.store.inbox(message.id)?.memoryJob).toMatchObject({ state: 'done' })
  expect(f.memoryPayloads[0].batch.map((m: RuntimeInbox) => m.id)).toEqual([message.id])
  expect(f.memoryPayloads[0].recent.some((m: { text: string }) => m.text === '以后都简短点')).toBe(true)
  await f.restart(); await Bun.sleep(60)
  expect(f.state.memoryCalls).toBe(1)
  expect(f.store.memories('b')).toHaveLength(1)
  expect(f.store.memoryLog('b').map(l => l.action)).toEqual(['create'])
})

test('没有词表门槛：听不出规矩的话也交给模型判断，模型说没有就不写', async () => {
  const f = fixture({ tickMs: 10 })
  f.proposals.push(() => ({ intent: 'none' }))
  const message = f.send('以后再聊'); await until(() => f.turns.length === 1)
  await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
  await until(() => f.store.inbox(message.id)?.memoryJob?.state === 'done')
  expect(f.state.memoryCalls).toBe(1)
  expect(f.store.memories('b')).toEqual([])
})

test('前台只说了正文、由宿主代为提交的那一轮，同样会整理记忆', async () => {
  const f = fixture({ tickMs: 10 })
  f.proposals.push(payload => ({ intent: 'preference', tier: 'long', prompt: '回复保持简短', sourceInboxId: payload.batch[0].id, quote: '以后回复都简短点' }))
  const message = f.send('以后回复都简短点'); await until(() => f.turns.length === 1)
  f.turns[0].finish()
  await until(() => f.store.memories('b').length === 1)
  expect(f.store.inbox(message.id)?.state).toBe('routed')
  expect(f.store.memories('b')[0]).toMatchObject({ tier: 'long', prompt: '回复保持简短', source: { inboxId: message.id, quote: '以后回复都简短点' } })
})

test('记忆按渠道和对话角色分开取；长期常驻进上下文，命中相关度的记一次触发', async () => {
  const f = fixture()
  const mine = memory({ id: 'mine', prompt: '报告要简短', triggers: { count: 1 } })
  const otherRole = memory({ id: 'other-role', prompt: '别的角色', senderId: 'someone' })
  const otherChannel = memory({ id: 'other-channel', prompt: '别的渠道', channel: 'team' })
  const unrelated = memory({ id: 'unrelated', prompt: '早上问声好' })
  for (const m of [mine, otherRole, otherChannel, unrelated]) f.store.saveMemory(m)
  f.send('报告写简短一点'); await until(() => f.turns.length === 1)
  const shown = f.turns[0].context.memories
  expect(shown.long.map((m: { id: string }) => m.id).sort()).toEqual(['mine', 'unrelated'])
  expect(shown.overflow).toBe(0)
  await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
  expect(f.store.memory('mine')?.triggers).toMatchObject({ count: 2 })
  expect(f.store.memory('unrelated')?.triggers.count).toBe(0)
})

test('慢路出错不影响回复，失败在视图里可见；重启时进行中的任务标失败不重跑', async () => {
  const f = fixture({ tickMs: 10 })
  f.state.memoryFail = true
  const message = f.send('以后都简短点'); await until(() => f.turns.length === 1)
  await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
  await until(() => f.store.inbox(message.id)?.memoryJob?.state === 'failed')
  expect(f.store.inbox(message.id)?.state).toBe('routed')
  expect(f.service.view('b', 'owner').memory.failedJobs.map(j => j.id)).toEqual([message.id])
  const running = f.send('以后都别用表格'); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ replies: ['好。'] }); f.turns[1].finish()
  await until(() => f.store.inbox(running.id)?.memoryJob?.state === 'failed')
  f.store.setMemoryJob(running.id, { state: 'running', scheduledAt: Date.now() })
  await f.restart()
  expect(f.store.inbox(running.id)?.memoryJob).toMatchObject({ state: 'failed' })
  expect(f.store.inbox(running.id)?.memoryJob?.error).toContain('重启')
})

test('中期 7 天内触发满 3 次升长期；满 10 轮到期作废；长期 30 天没被触发进待看清单', async () => {
  const f = fixture({ tickMs: 10 })
  const now = Date.now()
  const hot = memory({ id: 'hot', prompt: '报告要简短', tier: 'mid', bornRound: 1, expiresAt: now + DAY, triggers: { count: 3, lastTriggeredAt: now } })
  const stale = memory({ id: 'stale', prompt: '早上问声好', tier: 'mid', bornRound: 0, expiresAt: now + DAY })
  const quiet = memory({ id: 'quiet', prompt: '遇到故障先看日志', triggers: { count: 2, lastTriggeredAt: now - 31 * DAY } })
  for (const m of [hot, stale, quiet]) f.store.saveMemory(m)
  f.store.saveSettings({ ...f.store.settings('b'), rounds: 10 })
  await until(() => f.store.memory('hot')?.tier === 'long')
  expect(f.store.memory('hot')).toMatchObject({ status: 'active', promotedAt: expect.any(Number) })
  expect(f.store.memory('hot')?.expiresAt).toBeUndefined()
  expect(f.store.memory('stale')?.status).toBe('expired')
  expect(f.store.memory('quiet')).toMatchObject({ status: 'active', needsReview: true })
  expect(f.service.view('b', 'owner').memory.review.map((m: RuntimeMemory) => m.id)).toEqual(['quiet'])
  expect(f.store.memoryLog('b').map(l => `${l.memoryId}:${l.action}`).sort()).toEqual(['hot:promote', 'quiet:review', 'stale:expire'])
})

test('原话被撤回：规矩作废、本地原文清空、流水留痕', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-memory-revoke-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const message = store.receive({ botId: 'b', groupId: 'dm', seq: 1, senderId: 'owner', memberId: 'om', text: '以后都简短点', attachments: [{ id: 'upload-x', kind: 'upload', botId: 'b', name: 'a.txt', mime: 'text/plain', size: 1, hash: 'h' }], createdAt: Date.now() })
  const rule = memory({ id: 'rule', prompt: '回复保持简短', source: { inboxId: message.id, quote: '以后都简短点', context: '以后都简短点', sentAt: message.createdAt } })
  const untouched = memory({ id: 'other', prompt: '早问好', source: { inboxId: 'msg-other', quote: '早问好', context: '', sentAt: message.createdAt } })
  store.saveMemory(rule); store.saveMemory(untouched)
  expect(store.inboxBySeq('b', 'dm', 1)?.id).toBe(message.id)
  store.applyMemoryOps([{ ...rule, status: 'revoked', revokedReason: '原话被撤回', updatedAt: 5 }], [{ id: 'log-1', botId: 'b', memoryId: 'rule', action: 'revoke', actor: 'host', at: 5, note: '原话被撤回' }])
  store.revokeInbox(message.id, 7)
  expect(store.inbox(message.id)).toMatchObject({ text: '', revokedAt: 7 })
  expect(store.inbox(message.id)?.attachments).toBeUndefined()
  expect(store.memoriesBySource('b', message.id).map(m => m.status)).toEqual(['revoked'])
  expect(store.memory('other')?.status).toBe('active')
})

test('变更流水只增不改；主人能压下和作废，别人不能', async () => {
  const f = fixture()
  const rule = memory({ id: 'rule', prompt: '回复保持简短' })
  f.store.saveMemory(rule)
  const log = { id: 'log-1', botId: 'b', memoryId: 'rule', action: 'review' as const, actor: 'owner' as const, at: 1 }
  f.store.appendMemoryLog(log)
  expect(() => f.store.appendMemoryLog(log)).toThrow()
  expect(() => f.store.appendMemoryLog({ ...log, action: 'revoke', at: 2 })).toThrow()
  await expect(f.service.memoryControl('b', 'other', { requestId: 'r1', action: 'suppress', id: 'rule' })).rejects.toThrow(/owner|创建者/)
  await f.service.memoryControl('b', 'owner', { requestId: 'r1', action: 'suppress', id: 'rule', note: '先不用这条' })
  expect(f.store.memory('rule')).toMatchObject({ status: 'suppressed', suppressedBy: 'owner' })
  f.send('报告写简短一点'); await until(() => f.turns.length === 1)
  expect(f.turns[0].context.memories.long).toEqual([])
  await f.turns[0].decide({ replies: ['好。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
  await f.service.memoryControl('b', 'owner', { requestId: 'r2', action: 'unsuppress', id: 'rule' })
  expect(f.store.memory('rule')?.status).toBe('active')
  await f.service.memoryControl('b', 'owner', { requestId: 'r3', action: 'revoke', id: 'rule', note: '这条不对' })
  expect(f.store.memory('rule')).toMatchObject({ status: 'revoked', revokedReason: '这条不对' })
  await f.service.memoryControl('b', 'owner', { requestId: 'r3', action: 'revoke', id: 'rule', note: '重复点击' })
  expect(f.store.memory('rule')?.revokedReason).toBe('这条不对')
  expect(f.service.view('b', 'owner').memory.log.map(l => l.action)).toEqual(['review', 'suppress', 'unsuppress', 'revoke'])
})
