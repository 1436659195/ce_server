import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { AutomationSource } from '../src/cli/bot-runtime/automation/types'

const clean: Array<() => void> = []
afterEach(() => clean.splice(0).forEach(f => f()))
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-automation-store-'))
  const store = new BotRuntimeStore(join(dir, 'db'))
  clean.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const input = store.receive({ botId: 'b', groupId: 'g', memberId: 'm', senderId: 'o', seq: 1, text: '每天报天气', createdAt: 1 })
  const source: AutomationSource = { botId: 'b', groupId: 'g', ownerId: 'o', memberId: 'm', inputIds: [input.id], text: input.text, createdAt: 1, depth: 0, mandate: { ownerPhoneId: 'o', directory: dir, policyRevision: 1, allowedOps: ['read'], exclusions: [], mode: 'execute' } }
  return { store, source, dir, input }
}
const definition = { name: '天气', payload: '报告天气', schedule: { kind: 'every', everyMs: 60_000, anchorMs: 60_000 } }

test('创建同槽位重放返回同一已保存事件；参数变化不被误当新事件', () => {
  const { store, source } = setup()
  const a = store.automations.create(source, definition, 'turn:1', 0)
  expect(store.automations.create(source, definition, 'turn:1', 0).id).toBe(a.id)
  expect(() => store.automations.create(source, { ...definition, payload: '别的事情' }, 'turn:1', 0)).toThrow(/重复|槽位/)
  expect(store.automations.list('b').jobs).toHaveLength(1)
  expect(() => store.automations.get('other', a.id)).toThrow(/归属|不存在/)
})

test('列表按需分页；更新用版本号；暂停和删除留下取消版本', () => {
  const { store, source } = setup()
  const a = store.automations.create(source, definition, 'turn:1', 0)
  store.automations.create(source, definition, 'turn:2', 0)
  expect(store.automations.list('b', { limit: 1 }).nextOffset).toBe(1)
  const updated = store.automations.update('b', a.id, 1, { name: '每日天气' }, 1)
  expect(updated.revision).toBe(2)
  expect(() => store.automations.update('b', a.id, 1, { name: '旧修改' }, 2)).toThrow(/版本/)
  const paused = store.automations.setStatus('b', a.id, 2, 'paused', 2)
  const removed = store.automations.setStatus('b', a.id, paused.revision, 'removed', 3)
  expect(removed.status).toBe('removed')
  expect(() => store.automations.setStatus('b', a.id, removed.revision, 'enabled', 4)).toThrow(/删除/)
})

test('重复occurrence只入队一次，运行中只保留一个合并项', () => {
  const { store, source } = setup()
  const job = store.automations.create(source, definition, 'turn:1', 0)
  const first = store.automations.enqueue(job.id, 1, 'slot1', 60_000, '事实1', 60_000)!
  expect(store.automations.enqueue(job.id, 1, 'slot1', 60_000, '事实1', 60_000)?.id).toBe(first.id)
  store.automations.transition(first.id, 'routing', 60_000)
  store.automations.enqueue(job.id, 1, 'slot2', 120_000, '事实2', 120_000)
  store.automations.enqueue(job.id, 1, 'slot3', 180_000, '事实3', 180_000)
  expect(store.automations.occurrences('b', job.id).filter(r => r.state === 'queued')).toHaveLength(1)
})

test('暂停事务取消排队触发；旧版本不能再次入队', () => {
  const { store, source } = setup()
  const job = store.automations.create(source, definition, 'turn:1', 0)
  const occurrence = store.automations.enqueue(job.id, 1, 'slot1', 60_000, '事实', 60_000)!
  store.automations.setStatus('b', job.id, 1, 'paused', 60_001)
  expect(store.automations.occurrence(occurrence.id)?.state).toBe('cancelled')
  expect(store.automations.enqueue(job.id, 1, 'late', 60_000, '旧回调', 60_002)).toBeUndefined()
})

test('数据库重开保留事件、运行事实和原工单；不生成假聊天消息', () => {
  const { store, source, dir } = setup()
  const job = store.automations.create(source, definition, 'turn:1', 0)
  const occurrence = store.automations.enqueue(job.id, 1, 'slot1', 60_000, '事实', 60_000)!
  const reopened = new BotRuntimeStore(join(dir, 'db'))
  try {
    expect(reopened.automations.get('b', job.id).source.inputIds).toEqual(source.inputIds)
    expect(reopened.automations.occurrence(occurrence.id)?.message).toBe('事实')
    expect(reopened.messages('b')).toHaveLength(1)
  } finally { reopened.close() }
})

test('只有事件专用接单事务能建立任务，同时消费触发且不伪造inbox', () => {
  const { store, source } = setup()
  const job = store.automations.create(source, definition, 'turn:1', 0)
  const occurrence = store.automations.enqueue(job.id, 1, 'slot1', 60_000, '事实', 60_000)!
  store.automations.transition(occurrence.id, 'routing', 60_000)
  const task = store.acceptAutomationWork({ occurrenceId: occurrence.id, newCase: { title: '天气', object: '天气', goal: '天气预报' }, goal: job.payload, acceptance: [], mandate: source.mandate, replies: [], delivery: 'chat' })
  expect(task.automationOccurrenceId).toBe(occurrence.id)
  expect(store.automations.occurrence(occurrence.id)).toMatchObject({ state: 'working', taskId: task.id })
  expect(store.messages('b')).toHaveLength(1)
  expect(() => store.acceptAutomationWork({ occurrenceId: occurrence.id, newCase: { title: '天气', object: '天气', goal: '天气预报' }, goal: '重复任务', acceptance: [], mandate: source.mandate, replies: [] })).toThrow(/消费|状态/)
})

test('事件派工不能扩大源委托操作权限', () => {
  const { store, source } = setup()
  const job = store.automations.create(source, definition, 'turn:1', 0)
  const occurrence = store.automations.enqueue(job.id, 1, 'slot1', 60_000, '事实', 60_000)!
  store.automations.transition(occurrence.id, 'routing', 60_000)
  expect(() => store.acceptAutomationWork({ occurrenceId: occurrence.id, newCase: { title: '天气', object: '天气', goal: '天气' }, goal: '天气', acceptance: [], mandate: { ...source.mandate, allowedOps: ['read', 'delete'] }, replies: [] })).toThrow(/权限|授权/)
  expect(store.tasks('b')).toHaveLength(0)
})

test('一次性已过期后重放原创建回执仍然幂等，不重新验证成新任务', () => {
  const { store, source } = setup()
  const definition = { name: '提醒', payload: '提醒开会', schedule: { kind: 'at', at: '1970-01-01T00:00:30Z' } }
  const first = store.automations.create(source, definition, '1', 0)
  expect(store.automations.create(source, definition, '1', 300_000).id).toBe(first.id)
})

test('首次事件派工保存原卷宗关联，后续周期不会丢失工作对象', () => {
  const { store, source } = setup(); const job = store.automations.create(source, definition, '1', 0)
  const r = store.automations.enqueue(job.id, 1, '1', 30_000, '事实', 30_000)!
  store.automations.transition(r.id, 'routing', 30_000)
  const task = store.acceptAutomationWork({ occurrenceId: r.id, newCase: { title: '天气', object: '上海天气', goal: '预报' }, goal: '预报', acceptance: [], mandate: source.mandate, replies: [] })
  expect(store.automations.get('b', job.id).source.caseId).toBe(task.caseId)
})

test('排队合并的每个触发键都保留回执，执行后重放不能产生第二次任务', () => {
  const { store, source } = setup(); const job = store.automations.create(source, definition, '1', 0)
  const original = store.automations.enqueue(job.id, 1, 'timer:1', 30_000, '定时触发', 30_000)!
  const merged = store.automations.enqueue(job.id, 1, 'manual:request1', 30_001, '手动触发', 30_001)!
  expect(merged.id).toBe(original.id)
  store.automations.transition(original.id, 'completed', 30_002)
  expect(store.automations.enqueue(job.id, 1, 'manual:request1', 30_001, '手动重放', 30_003)?.id).toBe(original.id)
  expect(store.automations.occurrences('b')).toHaveLength(1)
})

test('事件接单保留整批源消息的附件授权，附件不只取末条气泡', () => {
  const { store, source } = setup()
  const file = store.receive({ botId: 'b', groupId: 'g', memberId: 'm', senderId: 'o', seq: 2, text: '', createdAt: 2, attachments: [{ id: 'upload1', kind: 'upload', name: '材料.txt', mime: 'text/plain', size: 3 } as any] })
  const last = store.receive({ botId: 'b', groupId: 'g', memberId: 'm', senderId: 'o', seq: 3, text: '明天分析它', createdAt: 3 })
  source.inputIds = [file.id, last.id]
  const job = store.automations.create(source, definition, '1', 0); const r = store.automations.enqueue(job.id, 1, '1', 30_000, '分析材料', 30_000)!
  store.automations.transition(r.id, 'routing', 30_000)
  const task = store.acceptAutomationWork({ occurrenceId: r.id, newCase: { title: '材料', object: '材料.txt', goal: '分析' }, goal: '分析', acceptance: [], mandate: source.mandate, replies: [] })
  expect(task.attachmentInputIds).toEqual([file.id])
})

test('修改时可显式清除条件、次数和有效期，不能被旧对象字段覆盖回来', () => {
  const { store, source } = setup()
  const job = store.automations.create(source, { ...definition, expiresAt: 300_000, maxRuns: 2, condition: { kind: 'metric', targetId: 'host', metric: 'cpu.utilization', above: 90, recoverBelow: 75, sustainMs: 0, cooldownMs: 0 } }, '1', 0)
  const updated = store.automations.update('b', job.id, 1, { condition: null, expiresAt: null, maxRuns: null }, 1)
  expect(updated.condition).toBeUndefined(); expect(updated.expiresAt).toBeUndefined(); expect(updated.maxRuns).toBeUndefined()
})

test('活动查询不返回历史终态，历史分页只返回指定条数并保持来源隔离', () => {
  const { store, source } = setup(); const job = store.automations.create(source, definition, '1', 0)
  for (let n = 0; n < 30; n++) {
    const r = store.automations.enqueue(job.id, 1, String(n), n, '记录', n)!
    store.automations.transition(r.id, 'completed', n)
  }
  const latest = store.automations.enqueue(job.id, 1, 'active', 31, '待办', 31)!
  expect(store.automations.active('b', job.id).map(r => r.id)).toEqual([latest.id])
  const page = store.automations.history('b', job.id, { limit: 5 })
  expect(page.runs).toHaveLength(5); expect(page.nextOffset).toBe(5)
  expect(page.runs[0].id).toBe(latest.id)
  expect(() => store.automations.history('other', job.id)).toThrow()
})
