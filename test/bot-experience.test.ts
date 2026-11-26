import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXPERIENCE_ESTABLISHED_USES, experienceCandidate, experienceFingerprint, selectExperiences } from '../src/cli/bot-runtime/experience'
import { BotRuntimeService, FULL_ACCESS_WORKER_TOOLS, type RuntimeClientOptions } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot, RuntimeCase, RuntimeExperience, RuntimeTask } from '../src/cli/bot-runtime/types'
import type { CodexToolCall, CodexTurn } from '../src/cli/bot-runtime/codex'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const waitFor = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(10); expect(fn()).toBe(true) }
function experience(p: Partial<RuntimeExperience> & Pick<RuntimeExperience, 'id' | 'object' | 'goal'>): RuntimeExperience {
  return { botId: 'b', state: 'active', approach: `${p.object}的做法`, detail: '详细经过', checks: ['已核对'], verified: true, sourceTaskId: 'task-x', sourceCaseId: 'case-x', uses: 0, platform: 'codex', toolFingerprint: 'fp', createdAt: 1, updatedAt: 1, ...p }
}
const dossier = (object: string, goal: string): RuntimeCase => ({ id: 'case-1', botId: 'b', title: object, object, goal, summary: '', createdAt: 1, updatedAt: 1 })

test('任务完成自动生成一条经验候选，不调模型；来源是卷宗和交付说明', () => {
  const task = { id: 'task-1', botId: 'b', caseId: 'case-1', goal: '定位 报表 新旧环境评分差异' } as RuntimeTask
  const fingerprint = experienceFingerprint('codex', FULL_ACCESS_WORKER_TOOLS.map(t => t.name))
  const created = experienceCandidate(task, dossier('报表 评分差异', '定位差异'), '先比对 lua 脚本前后的意图。再看两份引擎日志的 score。', ['已比对两份日志'], 'codex', fingerprint)
  expect(created).toMatchObject({ botId: 'b', state: 'active', object: '报表 评分差异', goal: '定位 报表 新旧环境评分差异', approach: '先比对 lua 脚本前后的意图', verified: true, checks: ['已比对两份日志'], sourceTaskId: 'task-1', sourceCaseId: 'case-1', uses: 0, platform: 'codex', toolFingerprint: fingerprint })
  expect(experienceFingerprint('codex', ['b', 'a'])).toBe(experienceFingerprint('codex', ['a', 'b']))
  expect(experienceFingerprint('claude', ['a'])).not.toBe(experienceFingerprint('codex', ['a']))
})

test('候选按相关度补位；用满 3 次才常驻；指纹不符的进待复核，不进摘要', () => {
  const list = [
    experience({ id: 'established', object: '报告', goal: '写报告', uses: 3, toolFingerprint: 'fp' }),
    experience({ id: 'candidate-hit', object: '报表 排查', goal: '定位差异', toolFingerprint: 'fp' }),
    experience({ id: 'candidate-miss', object: '财报分析', goal: '做表', toolFingerprint: 'fp' }),
    experience({ id: 'stale', object: '报告', goal: '写报告', uses: 5, toolFingerprint: 'old' }),
    experience({ id: 'retired', object: '报告', goal: '写报告', uses: 5, state: 'retired', toolFingerprint: 'fp' }),
  ]
  const selection = selectExperiences(list, '报表 新环境评分对不上，帮我定位', 'fp')
  expect(selection.selected.map(e => e.id)).toEqual(['established', 'candidate-hit'])
  expect(selection.stale).toEqual(['stale'])
  const quiet = selectExperiences(list, '今天天气不错', 'fp')
  expect(quiet.selected.map(e => e.id)).toEqual(['established'])
  expect(EXPERIENCE_ESTABLISHED_USES).toBe(3)
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-experience-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'b', name: '运维', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: dir, directory: dir, platform: 'codex', policyRevision: 1, commandSandbox: false, workerAccessMode: 'full-access',
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ botId: 'b', mode: 'router-worker', revision: 1, profile: '', model: '' })
  const decisions: Array<Record<string, unknown>> = []
  let workerOptions: RuntimeClientOptions | undefined; let workerDone: ((v: CodexTurn) => void) | undefined; let started = 0; let calls = 0
  const service = new BotRuntimeService({ routerQuietMs: 0, store, rootDir: dir, tickMs: 3_600_000, getBot: () => bot, sendReply: async () => {},
    checkAccess: async () => ({ directory: bot.directory, permissions: bot.permissions, revision: bot.policyRevision }),
    openTools: (_bot, _member, authorize) => ({ close() {}, call: async (_tool, args) => { await authorize('read', String(args.path)); return '文件内容' } }),
    createClient: (role, opts) => {
      if (role === 'worker') workerOptions = opts
      let clientDone: ((v: CodexTurn) => void) | undefined
      return { initialize: async () => {}, startThread: async () => `thread-${role}`, resumeThread: async (id: string) => id,
        startTurn: async (_threadId: string, text: string) => {
          if (role === 'router') {
            const context = JSON.parse(text); const decision = context.currentMessages.length ? decisions.shift() : { action: 'reply', replies: [context.workerMessage.text] }
            const call = (tool: string, args: Record<string, unknown> = {}) => opts.onToolCall({ threadId: 'thread-router', turnId: 'turn-router', callId: `router-${++calls}`, tool, arguments: args } satisfies CodexToolCall)
            const done = Promise.resolve().then(async () => { if (decision) await call('router_decide', { decision: { action: decision.action ?? 'reply', ...(decision.action === 'start' ? { dossier: { kind: 'new', ...(decision.newCase as object), reason: '新的独立事项，没有可承接的已有工作' }, goal: decision.goal, delivery: 'chat', allowedOps: ['read'] } : {}) }, feasibility: 'can', replies: decision.replies ?? [] }) ; return { id: 'turn-router', status: 'completed' } })
            return { threadId: 'thread-router', turnId: 'turn-router', done }
          }
          started++
          return { threadId: 'thread-worker', turnId: 'turn-worker', done: new Promise<CodexTurn>(r => { workerDone = clientDone = r }) }
        }, steer: async () => 'turn-worker', interrupt: async () => { clientDone?.({ id: 'turn-worker', status: 'interrupted' }) }, close: async () => { clientDone?.({ id: 'turn-worker', status: 'interrupted' }) } }
    } })
  cleanups.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const send = (seq: number, text: string) => service.receive('b', { groupId: 'dm', seq, text, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const workerCall = (tool: string, args: Record<string, unknown> = {}) => workerOptions!.onToolCall({ threadId: 'thread-worker', turnId: 'turn-worker', callId: `worker-${++calls}`, tool, arguments: args } satisfies CodexToolCall)
  return { store, service, bot, decisions, send, workerCall, started: () => started, complete: () => workerDone?.({ id: 'turn-worker', status: 'completed' }) }
}
const start = (object: string, goal: string) => ({ action: 'start', newCase: { title: object, object, goal }, goal, replyText: '我先看一下。' })

test('Worker 交付后自动落一条经验；进过摘要就算用过一次；主人说不对就作废', async () => {
  const f = fixture()
  f.decisions.push(start('报表 评分差异', '定位新旧环境评分差异'))
  f.send(1, '报表 新环境评分对不上，帮我定位'); await waitFor(() => f.started() === 1)
  await f.workerCall('work_finish', { revision: 1, text: '先比对 lua 脚本前后的意图。', artifactIds: [], checks: ['已比对两份日志'] })
  expect(f.store.experiences('b')).toHaveLength(1)
  expect(f.store.experiences('b')[0]).toMatchObject({ object: '报表 评分差异', goal: '定位新旧环境评分差异', approach: '先比对 lua 脚本前后的意图', verified: true, uses: 0, state: 'active' })
  f.complete()
  await waitFor(() => f.store.replies('b').some(r => r.author === 'router' && r.purpose === 'result' && r.state === 'sent'))
  f.decisions.push({ action: 'reply', replies: ['收到。'] })
  const second = f.send(2, '报表 评分又对不上了')
  await waitFor(() => f.store.inbox(second.id)?.state === 'routed')
  expect(f.store.experiences('b')[0].uses).toBe(1)
  await f.service.memoryControl('b', 'owner', { requestId: 'retire-1', target: 'experience', action: 'revoke', id: f.store.experiences('b')[0].id, note: '这条经验不对' })
  expect(f.store.experiences('b')[0]).toMatchObject({ state: 'retired' })
})

test('平台或工具集变了：经验进待复核，不进摘要；主人仍能在视图里看到', async () => {
  const f = fixture()
  f.store.saveExperience(experience({ id: 'exp-old', object: '报表 评分差异', goal: '定位差异', uses: 5, toolFingerprint: 'outdated' }))
  f.decisions.push({ action: 'reply', replies: ['好的。'] })
  f.send(1, '报表 评分差异怎么定位')
  await waitFor(() => f.store.experience('exp-old')?.state === 'needs_review')
  const view = f.service.view('b', 'owner')
  expect(view.experiences.map(e => [e.id, e.state])).toEqual([['exp-old', 'needs_review']])
})
