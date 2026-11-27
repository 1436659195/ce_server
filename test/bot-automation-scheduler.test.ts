import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { AutomationScheduler } from '../src/cli/bot-runtime/automation/scheduler'
import type { AutomationSource } from '../src/cli/bot-runtime/automation/types'

const clean: Array<() => void> = []
afterEach(() => clean.splice(0).forEach(f => f()))
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-automation-scheduler-')); const runtime = new BotRuntimeStore(join(dir, 'db'))
  clean.push(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }) })
  const source: AutomationSource = { botId: 'b', groupId: 'g', ownerId: 'o', memberId: 'm', inputIds: ['actual-input'], text: '提醒我', createdAt: 0, depth: 0, mandate: { ownerPhoneId: 'o', directory: dir, policyRevision: 1, allowedOps: ['read'], exclusions: [], mode: 'execute' } }
  let now = 0; let authorized = true; let wakes = 0; let samples = 0
  const scheduler = new AutomationScheduler({ store: runtime.automations, now: () => now, authorized: () => authorized, onWake: () => { wakes++ }, collect: async () => { samples++; return { value: 95, at: now } } })
  return { runtime, scheduler, source, setNow: (v: number) => { now = v }, revoke: () => { authorized = false }, wakes: () => wakes, samples: () => samples }
}
const every = { name: '提醒', payload: '报告情况', schedule: { kind: 'every', everyMs: 30_000, anchorMs: 30_000 } }

test('到期只写持久化触发，不需要智能体；重复tick不重复入队', async () => {
  const f = setup(); f.runtime.automations.create(f.source, every, '1', 0)
  await f.scheduler.tick(); expect(f.wakes()).toBe(0)
  f.setNow(30_000); await Promise.all([f.scheduler.tick(), f.scheduler.tick()])
  expect(f.runtime.automations.occurrences('b')).toHaveLength(1); expect(f.wakes()).toBe(1)
})

test('停机错过多次周期只补最近一次；过期一次性保留待处理原因', async () => {
  const f = setup(); f.runtime.automations.create(f.source, every, '1', 0)
  f.runtime.automations.create(f.source, { ...every, schedule: { kind: 'at', at: '1970-01-01T00:00:30Z' }, misfireMs: 1000 }, '2', 0)
  f.setNow(300_000); await f.scheduler.tick()
  const runs = f.runtime.automations.occurrences('b')
  expect(runs.filter(r => r.state === 'queued')).toHaveLength(1)
  expect(runs.find(r => r.state === 'queued')?.scheduledAt).toBe(300_000)
  expect(runs.find(r => r.state === 'needs_attention')?.error).toMatch(/过期/)
})

test('条件未满足不唤醒；持续达到阈值才触发，成功后提交去重状态', async () => {
  const f = setup(); const job = f.runtime.automations.create(f.source, { ...every, condition: { kind: 'metric', targetId: 'host', metric: 'cpu.utilization', above: 90, recoverBelow: 75, sustainMs: 60_000, cooldownMs: 300_000 } }, '1', 0)
  for (const t of [30_000, 60_000]) { f.setNow(t); await f.scheduler.tick() }
  expect(f.samples()).toBe(2); expect(f.wakes()).toBe(0)
  f.setNow(90_000); await f.scheduler.tick(); expect(f.wakes()).toBe(1)
  const r = f.scheduler.claim('b')!; expect(r.occurrence.pendingState?.latched).toBe(true)
  f.scheduler.complete(r.occurrence.id)
  expect(f.runtime.automations.get('b', job.id).state?.latched).toBe(true)
  f.setNow(120_000); await f.scheduler.tick(); expect(f.wakes()).toBe(1)
})

test('取消检查中的事件后迟到采样不能唤醒或覆盖编辑', async () => {
  const f = setup(); let finish!: (sample: { value: number; at: number }) => void
  const scheduler = new AutomationScheduler({ store: f.runtime.automations, now: () => 30_000, authorized: () => true, onWake: () => { throw new Error('must not wake') }, collect: () => new Promise(resolve => { finish = resolve }) })
  const job = f.runtime.automations.create(f.source, { ...every, condition: { kind: 'metric', targetId: 'host', metric: 'cpu.utilization', above: 90, recoverBelow: 75, sustainMs: 0, cooldownMs: 300_000 } }, '1', 0)
  const ticking = scheduler.tick(); await Promise.resolve(); await Promise.resolve()
  f.runtime.automations.setStatus('b', job.id, 1, 'paused', 30_001)
  finish({ value: 95, at: 30_000 }); await ticking
  expect(f.runtime.automations.occurrences('b')).toHaveLength(0)
  expect(f.runtime.automations.get('b', job.id).status).toBe('paused')
})

test('授权撤销暂停事件，不能通过手动run绕过暂停', async () => {
  const f = setup(); const job = f.runtime.automations.create(f.source, every, '1', 0)
  f.revoke(); f.setNow(30_000); await f.scheduler.tick()
  expect(f.runtime.automations.get('b', job.id).status).toBe('paused')
  expect(() => f.scheduler.run('b', job.id, 'manual1')).toThrow(/暂停|启用|授权/)
  expect(f.wakes()).toBe(0)
})

test('重启恢复未提交Router轮次；已接单工单不重复派发', () => {
  const f = setup(); const job = f.runtime.automations.create(f.source, every, '1', 0)
  const r = f.runtime.automations.enqueue(job.id, 1, '1', 30_000, '事实', 30_000)!
  f.runtime.automations.transition(r.id, 'routing', 30_000)
  f.scheduler.recover()
  expect(f.runtime.automations.occurrence(r.id)?.state).toBe('queued')
  f.runtime.automations.transition(r.id, 'working', 30_001, { taskId: 'task-real' })
  f.scheduler.recover()
  expect(f.runtime.automations.occurrence(r.id)).toMatchObject({ state: 'working', taskId: 'task-real' })
})

test('外部任务完成事件以可信事件ID去重，不生成时间轮询模型', async () => {
  const f = setup(); f.runtime.automations.create(f.source, { ...every, schedule: { kind: 'event', topic: 'task.completed', taskId: 'task1' } }, '1', 0)
  await f.scheduler.tick(); expect(f.wakes()).toBe(0)
  f.scheduler.publishTaskCompleted('b', 'task1', 'task1:revision1', '任务已完成')
  f.scheduler.publishTaskCompleted('b', 'task1', 'task1:revision1', '任务已完成')
  expect(f.runtime.automations.occurrences('b')).toHaveLength(1); expect(f.wakes()).toBe(1)
})

test('执行失败与发送失败分离；已开始Worker不由调度器自动重跑', () => {
  const f = setup(); const job = f.runtime.automations.create(f.source, every, '1', 0)
  const r = f.runtime.automations.enqueue(job.id, 1, '1', 30_000, '事实', 30_000)!
  f.scheduler.claim('b'); f.runtime.automations.transition(r.id, 'working', 30_001, { taskId: 'real-task' })
  f.scheduler.fail(r.id, 'network timeout')
  expect(f.runtime.automations.occurrence(r.id)).toMatchObject({ state: 'needs_attention', taskId: 'real-task' })
  expect(f.scheduler.claim('b')).toBeUndefined()
})

test('条件检查超时记失败并退避，停止检查不会被误记为采样失败', async () => {
  const f = setup()
  const job = f.runtime.automations.create(f.source, { ...every, condition: { kind: 'metric', targetId: 'host', metric: 'gpu.utilization', above: 90, recoverBelow: 75, sustainMs: 0, cooldownMs: 30_000 } }, '1', 0)
  const scheduler = new AutomationScheduler({ store: f.runtime.automations, now: () => 30_000, checkTimeoutMs: 5, authorized: () => true, onWake: () => {}, collect: () => new Promise(() => {}) })
  await scheduler.tick()
  expect(f.runtime.automations.get('b', job.id)).toMatchObject({ failures: 1 })
  expect(f.runtime.automations.get('b', job.id).error).toMatch(/timeout/)
  expect(f.runtime.automations.get('b', job.id).checkToken).toBeUndefined()
})

test('连续采集失败第三次才唤醒Router告知异常，不伪报正常', async () => {
  const f = setup(); let now = 30_000; let wakes = 0
  const job = f.runtime.automations.create(f.source, { ...every, condition: { kind: 'metric', targetId: 'host', metric: 'gpu.utilization', above: 90, recoverBelow: 75, sustainMs: 0, cooldownMs: 30_000 } }, '1', 0)
  const scheduler = new AutomationScheduler({ store: f.runtime.automations, now: () => now, authorized: () => true, onWake: () => { wakes++ }, collect: async () => { throw new Error('GPU采集不可用') } })
  for (let n = 0; n < 3; n++) { await scheduler.tick(); now = f.runtime.automations.get('b', job.id).nextCheckAt! }
  expect(wakes).toBe(1)
  expect(f.runtime.automations.occurrences('b')[0]).toMatchObject({ diagnostic: true })
  expect(f.runtime.automations.occurrences('b')[0].message).toContain('监测异常')
})

test('未启动执行的瞬时失败有限重试，完成的一次性事件不能重放', async () => {
  const f = setup(); const job = f.runtime.automations.create(f.source, { ...every, schedule: { kind: 'at', at: '1970-01-01T00:00:30Z' } }, '1', 0)
  f.setNow(30_000); await f.scheduler.tick()
  const r = f.scheduler.claim('b')!
  f.scheduler.fail(r.occurrence.id, 'HTTP 503 Service Unavailable')
  expect(f.scheduler.claim('b')).toBeUndefined()
  f.setNow(35_000); expect(f.scheduler.claim('b')?.occurrence.id).toBe(r.occurrence.id)
  f.scheduler.complete(r.occurrence.id)
  expect(f.runtime.automations.get('b', job.id).status).toBe('completed')
  await f.scheduler.tick(); expect(f.scheduler.claim('b')).toBeUndefined()
})

test('旧触发完成不能覆盖更晚的恢复样本；新异常仍可再次提醒', async () => {
  const f = setup(); let now = 30_000; let value = 95
  const job = f.runtime.automations.create(f.source, { ...every, condition: { kind: 'metric', targetId: 'host', metric: 'cpu.utilization', above: 90, recoverBelow: 75, sustainMs: 0, cooldownMs: 0 } }, '1', 0)
  const scheduler = new AutomationScheduler({ store: f.runtime.automations, now: () => now, authorized: () => true, onWake: () => {}, collect: async () => ({ value, at: now }) })
  await scheduler.tick(); const first = scheduler.claim('b')!
  now = 60_000; value = 50; await scheduler.tick(); scheduler.complete(first.occurrence.id)
  expect(f.runtime.automations.get('b', job.id).state?.latched).toBe(false)
  now = 90_000; value = 95; await scheduler.tick()
  expect(scheduler.claim('b')?.occurrence.id).not.toBe(first.occurrence.id)
  expect(f.runtime.automations.occurrences('b')).toHaveLength(2)
})

test('合并诊断触发时同时替换诊断标记，不能把监测失败当新工作', () => {
  const f = setup(); const job = f.runtime.automations.create(f.source, every, '1', 0)
  const original = f.runtime.automations.enqueue(job.id, 1, '1', 30_000, '普通提醒', 30_000)!
  const diagnostic = f.runtime.automations.enqueue(job.id, 1, '2', 30_001, '监测异常', 30_001, { diagnostic: true })!
  expect(diagnostic.id).toBe(original.id); expect(diagnostic.diagnostic).toBe(true)
})

test('告警完成与采样并发时，采样必须使用最新已提交状态避免重复告警', async () => {
  const f = setup(); let now = 30_000; let finish: ((sample: { value: number; at: number }) => void) | undefined
  const job = f.runtime.automations.create(f.source, { ...every, condition: { kind: 'metric', targetId: 'host', metric: 'cpu.utilization', above: 90, recoverBelow: 75, sustainMs: 0, cooldownMs: 0 } }, '1', 0)
  const scheduler = new AutomationScheduler({ store: f.runtime.automations, now: () => now, authorized: () => true, onWake: () => {}, collect: () => now === 30_000 ? Promise.resolve({ value: 95, at: now }) : new Promise(resolve => { finish = resolve }) })
  await scheduler.tick(); const r = scheduler.claim('b')!
  now = 60_000; const ticking = scheduler.tick(); await Promise.resolve(); await Promise.resolve()
  scheduler.complete(r.occurrence.id)
  finish!({ value: 95, at: now }); await ticking
  expect(f.runtime.automations.occurrences('b', job.id)).toHaveLength(1)
})
