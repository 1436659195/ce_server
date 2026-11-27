import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'
import type { CodexTurn } from '../src/cli/bot-runtime/codex'
import { routerCall } from './helpers/router-decision'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const f of cleanup.splice(0)) await f() })
async function until(f: () => boolean) { for (let n = 0; n < 200 && !f(); n++) await Bun.sleep(5); expect(f()).toBe(true) }
function fixture(collectMetric?: (condition: any, signal?: AbortSignal) => Promise<{ value: number; at: number }>) {
  const root = mkdtempSync(join(tmpdir(), 'ce-automation-router-')); const store = new BotRuntimeStore(join(root, 'db'))
  const bot: RuntimeBot = { botId: 'b', groupId: 'dm', ownerPhoneId: 'o', name: '小林', platform: 'codex', directory: root, sourceCwd: root, policyRevision: 1, commandSandbox: false,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ ...store.settings('b'), mode: 'router-worker' })
  let now = Date.parse('2026-11-27T00:00:00Z'); let seq = 0; let offline = false; let workerStarts = 0
  const sent: RuntimeReply[] = []
  const turns: Array<{ context: any; call: (tool: string, args: Record<string, unknown>) => Promise<any>; decide: (args: Record<string, unknown>) => Promise<any>; finish: () => void }> = []
  const workerCalls: Array<(tool: string, args: Record<string, unknown>) => Promise<any>> = []
  const service = new BotRuntimeService({ store, rootDir: root, tickMs: 100_000, routerQuietMs: 0, bubbleGapMs: 0, automationNow: () => now, collectMetric, getBot: () => bot,
    sendReply: async r => { if (offline) throw new Error('offline'); sent.push(r) }, checkAccess: async () => ({ directory: root, permissions: bot.permissions, revision: 1 }), openTools: () => ({ call: async () => '', close: () => {} }),
    createClient: (role, options) => {
      let finish: ((r: CodexTurn) => void) | undefined
      return { initialize: async () => {}, startThread: async p => { if (role === 'router') expect(p.tools.some(t => t.name === 'automation')).toBe(true); return role }, resumeThread: async id => id,
        startTurn: async (threadId, text) => {
          const turnId = `${role}-${turns.length}-${workerStarts}`; const done = new Promise<CodexTurn>(r => { finish = r }); const resolve = finish!
          const call = (tool: string, args: Record<string, unknown>) => options.onToolCall({ threadId, turnId, callId: crypto.randomUUID(), tool, arguments: args })
          if (role === 'router') turns.push({ context: JSON.parse(text), call, decide: args => call('router_decide', routerCall({ action: 'reply', ...args })), finish: () => resolve({ id: turnId, status: 'completed' }) })
          else if (role === 'worker') { workerStarts++; workerCalls.push(call) }
          else resolve({ id: turnId, status: 'completed' })
          return { threadId, turnId, done }
        }, steer: async () => '', interrupt: async () => { finish?.({ id: 'i', status: 'interrupted' }) }, close: async () => { finish?.({ id: 'c', status: 'interrupted' }) } }
    } })
  cleanup.push(async () => { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  return { service, store, bot, turns, sent, workerCalls, workers: () => workerStarts, setOffline: (v: boolean) => { offline = v }, advance: (ms: number) => { now += ms }, now: () => now,
    send: (text: string) => service.receive('b', { groupId: 'dm', seq: ++seq, senderId: 'o', memberId: 'm', text, createdAt: now }) }
}
async function create(f: ReturnType<typeof fixture>, payload = '提醒开会') {
  f.send('一分钟后提醒我'); await until(() => f.turns.length === 1)
  const definition = { name: '开会', payload, schedule: { kind: 'at', at: new Date(f.now() + 60_000).toISOString() } }
  const receipt = await f.turns[0].call('automation', { action: 'create', slot: 1, definition })
  await f.turns[0].decide({ replies: ['已安排。'] }); f.turns[0].finish()
  await until(() => f.sent.length === 1)
  return { receipt, definition }
}

test('Router工具创建后保存回执，重复同槽不重复；普通上下文不注入全部待办', async () => {
  const f = fixture(); f.send('一分钟后提醒开会'); await until(() => f.turns.length === 1)
  const args = { action: 'create', slot: 1, definition: { name: '开会', payload: '提醒开会', schedule: { kind: 'at', at: new Date(f.now() + 60_000).toISOString() } } }
  const a = await f.turns[0].call('automation', args); const b = await f.turns[0].call('automation', args)
  expect(a).toMatchObject({ saved: true }); expect(b.job.id).toBe(a.job.id)
  expect(f.store.automations.list('b').jobs).toHaveLength(1)
  expect(f.turns[0].context.automationJobs).toBeUndefined()
  await expect(f.turns[0].call('automation', { ...args, ownerId: 'other' })).rejects.toThrow()
})

test('到期回到同一个Router，保持独立事件来源和100字纯文本规则', async () => {
  const f = fixture(); const { receipt } = await create(f)
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  const turn = f.turns[1]
  expect(turn.context.trigger).toBe('automation_event'); expect(turn.context.currentMessages).toEqual([])
  expect(turn.context.automationEvent.jobId).toBe(receipt.job.id)
  expect(f.store.messages('b')).toHaveLength(1)
  await expect(turn.decide({ replies: ['字'.repeat(101)] })).rejects.toThrow(/100/)
  await expect(turn.decide({ replies: ['**开会了**'] })).rejects.toThrow(/纯文本/)
  await turn.decide({ replies: ['到开会时间了。'] }); turn.finish()
  await until(() => f.sent.length === 2)
  await f.service.pollAutomations()
  expect(f.store.automations.get('b', receipt.job.id).status).toBe('completed')
  expect(f.sent[1].groupId).toBe('dm'); expect(f.sent[1].automationOccurrenceId).toBeDefined()
})

test('事件可发起Worker，结果仍走Router验收与500字规则', async () => {
  const f = fixture(); await create(f, '查询天气后报告')
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ action: 'start', replies: [], delivery: 'chat', goal: '查询天气', newCase: { title: '天气', object: '上海天气', goal: '每日预报' }, allowedOps: ['read'] }); f.turns[1].finish()
  await until(() => f.workers() === 1)
  const task = f.store.tasks('b')[0]; expect(task.automationOccurrenceId).toBeDefined()
  await f.workerCalls[0]('work_finish', { revision: 1, text: '天气晴朗。', artifactIds: [], checks: ['已核对'] })
  await until(() => f.turns.length === 3)
  await f.turns[2].decide({ replies: ['**天气预报**\n' + '晴'.repeat(150)] }); f.turns[2].finish()
  await until(() => f.sent.length === 2)
  await f.service.pollAutomations()
  expect(f.sent[1].format).toBe('markdown')
  expect(f.store.tasks('b')[0].review?.state).toBe('approved')
  expect(f.store.automations.occurrences('b')[0].state).toBe('completed')
})

test('投递失败只重试同一消息，不重跑Router或Worker', async () => {
  const f = fixture(); await create(f); f.setOffline(true)
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ replies: ['开会时间到了。'] }); f.turns[1].finish()
  await until(() => f.store.pendingReplies('b').some(r => r.attemptedAt !== undefined))
  const pending = f.store.pendingReplies('b').find(r => r.author === 'router')!
  f.advance(11 * 60_000); await f.service.pollAutomations()
  expect(f.store.automations.occurrences('b')[0].state).toBe('delivery_pending')
  f.setOffline(false); await f.service.flush('b'); await f.service.pollAutomations()
  expect(f.sent[1].id).toBe(pending.id); expect(f.turns).toHaveLength(2); expect(f.workers()).toBe(0)
})

test('权限变化和原话撤回阻止旧事件启动', async () => {
  const f = fixture(); const { receipt } = await create(f)
  f.bot.policyRevision++
  f.advance(60_000); await f.service.pollAutomations()
  expect(f.turns).toHaveLength(1); expect(f.store.automations.get('b', receipt.job.id).status).toBe('paused')
})

test('事件处理中暂停会拦住旧Router提交；暂停后的回调不能发消息', async () => {
  const f = fixture(); const { receipt } = await create(f)
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  const job = f.store.automations.get('b', receipt.job.id)
  f.store.automations.setStatus('b', job.id, job.revision, 'paused', f.now())
  expect(await f.turns[1].decide({ replies: ['旧提醒'] })).toMatchObject({ superseded: true })
  f.turns[1].finish(); await f.service.flush('b')
  expect(f.sent).toHaveLength(1)
})

test('Router轮换会话后释放原触发，再开轮也只处理一次', async () => {
  const f = fixture(); await create(f)
  const session = (f.service as any).routerClients.get('b'); session.turns = 8
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ replies: ['开会时间到了。'] }); f.turns[1].finish()
  await until(() => f.sent.length === 2)
  expect(f.store.automations.occurrences('b')).toHaveLength(1)
})

test('自动触发不能把自身改成无限周期；只能建立有限的一次性后续', async () => {
  const f = fixture(); const { receipt } = await create(f)
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  await expect(f.turns[1].call('automation', { action: 'update', jobId: receipt.job.id, revision: 1, definition: { schedule: { kind: 'every', everyMs: 30_000, anchorMs: f.now() } } })).rejects.toThrow(/自动执行|一次性/)
  await expect(f.turns[1].call('automation', { action: 'create', slot: 1, definition: { name: '循环', payload: '继续检查', schedule: { kind: 'every', everyMs: 30_000, anchorMs: f.now() } } })).rejects.toThrow(/一次性/)
  const child = await f.turns[1].call('automation', { action: 'create', slot: 2, definition: { name: '后续', payload: '再检查一次', schedule: { kind: 'at', at: new Date(f.now() + 30_000).toISOString() } } })
  expect(child.saved).toBe(true)
})

test('超过有效期后即使还没下一次tick，旧模型提交和发送也失效', async () => {
  const f = fixture(); await create(f)
  const job = f.store.automations.list('b').jobs[0]
  f.store.automations.saveJob({ ...job, expiresAt: f.now() + 60_001 })
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  f.advance(2)
  expect(await f.turns[1].decide({ replies: ['迟到的消息'] })).toMatchObject({ superseded: true })
  f.turns[1].finish(); expect(f.sent).toHaveLength(1)
})

test('用户原话撤回后禁止派工和发送', async () => {
  const f = fixture(); const { receipt } = await create(f)
  f.service.revokeMessage('b', 'dm', 1, f.now() + 1)
  f.advance(60_000); await f.service.pollAutomations()
  expect(f.turns).toHaveLength(1); expect(f.store.automations.get('b', receipt.job.id).status).toBe('paused')
})

test('手动停止事件派工只取消本次，周期定义保留', async () => {
  const f = fixture(); f.send('每分钟检查天气'); await until(() => f.turns.length === 1)
  const receipt = await f.turns[0].call('automation', { action: 'create', slot: 1, definition: { name: '天气', payload: '查天气', schedule: { kind: 'every', everyMs: 60_000, anchorMs: f.now() + 60_000 } } })
  await f.turns[0].decide({ replies: ['已安排。'] }); f.turns[0].finish(); await until(() => f.sent.length === 1)
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ action: 'start', replies: [], delivery: 'chat', goal: '查天气', newCase: { title: '天气', object: '上海天气', goal: '预报' }, allowedOps: ['read'] }); f.turns[1].finish(); await until(() => f.workers() === 1)
  const task = f.store.tasks('b')[0]
  await f.service.control('b', 'o', { action: 'stop', taskId: task.id, expectedRevision: task.revision, requestId: 'stop-event-run' })
  expect(f.store.automations.occurrences('b')[0].state).toBe('cancelled')
  expect(f.store.automations.get('b', receipt.job.id).status).toBe('enabled')
  await until(() => f.store.runs('b').every(r => r.state === 'exited'))
  await f.service.control('b', 'o', { action: 'resume', taskId: task.id, expectedRevision: task.revision, requestId: 'resume-event-run' })
  await until(() => f.workers() === 2)
  expect(f.store.task(task.id)?.automationOccurrenceId).toBeUndefined()
  expect(f.store.automations.occurrences('b')[0].state).toBe('cancelled')
})

test('工具支持分页、详情、修改、暂停、恢复、手动执行和删除；未知ID不能管理', async () => {
  const f = fixture(); const { receipt } = await create(f)
  f.send('管理刚才的提醒'); await until(() => f.turns.length === 2)
  const call = f.turns[1].call
  expect((await call('automation', { action: 'list', limit: 1 })).jobs[0].id).toBe(receipt.job.id)
  expect((await call('automation', { action: 'inspect', jobId: receipt.job.id })).job.payload).toBe('提醒开会')
  let r = await call('automation', { action: 'update', jobId: receipt.job.id, revision: 1, definition: { name: '会议提醒' } })
  r = await call('automation', { action: 'pause', jobId: receipt.job.id, revision: r.job.revision }); expect(r.job.status).toBe('paused')
  await expect(call('automation', { action: 'run', jobId: receipt.job.id })).rejects.toThrow(/暂停/)
  r = await call('automation', { action: 'resume', jobId: receipt.job.id, revision: r.job.revision }); expect(r.job.status).toBe('enabled')
  expect((await call('automation', { action: 'run', jobId: receipt.job.id })).enqueued).toBe(true)
  r = await call('automation', { action: 'remove', jobId: receipt.job.id, revision: r.job.revision }); expect(r.job.status).toBe('removed')
  await expect(call('automation', { action: 'inspect', jobId: 'other-id' })).rejects.toThrow(/归属|不存在/)
})

test.each(['pause', 'revoke'])('暂停或撤回立刻停止关联Worker，不等待无关慢采样：%s', async mode => {
  let finish!: (sample: { value: number; at: number }) => void
  const f = fixture(() => new Promise(resolve => { finish = resolve }))
  const { receipt } = await create(f, '检查天气')
  const original = f.store.automations.get('b', receipt.job.id)
  f.store.automations.create(original.source, { name: 'GPU', payload: '告警', schedule: { kind: 'every', everyMs: 90_000, anchorMs: f.now() + 90_000 }, condition: { kind: 'metric', targetId: 'host', metric: 'gpu.utilization', above: 90, recoverBelow: 75, sustainMs: 0, cooldownMs: 0 } }, 'second', f.now())
  f.advance(60_000); await f.service.pollAutomations(); await until(() => f.turns.length === 2)
  await f.turns[1].decide({ action: 'start', replies: [], delivery: 'chat', goal: '检查天气', newCase: { title: '天气', object: '天气', goal: '检查' }, allowedOps: ['read'] }); f.turns[1].finish(); await until(() => f.workers() === 1)
  f.advance(30_000); const polling = f.service.pollAutomations(); await until(() => !!finish)
  if (mode === 'pause') {
    f.send('暂停提醒'); await until(() => f.turns.length === 3)
    const paused = await Promise.race([f.turns[2].call('automation', { action: 'pause', jobId: receipt.job.id, revision: original.revision }), Bun.sleep(100).then(() => { throw new Error('暂停被无关采样阻塞') })])
    expect(paused.job.status).toBe('paused')
  } else {
    f.service.revokeMessage('b', 'dm', 1, f.now())
    await until(() => f.store.tasks('b')[0].state === 'stopped')
    expect(f.store.automations.get('b', receipt.job.id).status).toBe('paused')
  }
  expect(f.store.tasks('b')[0].state).toBe('stopped')
  finish({ value: 50, at: f.now() }); await polling
})
