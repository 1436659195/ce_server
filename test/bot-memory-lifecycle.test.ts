import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeInbox, RuntimeMemory } from '../src/cli/bot-runtime/types'

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })
const now = 1_800_000_000_000
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-v2-')); const store = new BotRuntimeStore(join(dir, 'state.sqlite'))
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const audience = { botId: 'b', channel: 'dm', senderId: 'owner', project: '/project' }
  const message = (text: string, seq: number) => store.receive({ botId: 'b', groupId: 'dm', senderId: 'owner', memberId: 'owner', text, seq, createdAt: now + seq })
  const commit = (msg: RuntimeInbox, changes: unknown[], requestId = msg.id) => store.memoryLibrary.write({ requestId, expectedRevision: store.memoryLibrary.revision(audience), changes }, { ...audience, batch: [msg], actor: 'router' }, now + 100)
  const save = (msg: RuntimeInbox, content: Record<string, unknown> = {}, requestId = msg.id) => commit(msg, [{ action: 'save', tier: 'long', kind: 'preference', topic: '回复长度', prompt: '默认简短回复', core: true, sourceInboxId: msg.id, quote: msg.text, ...content }], requestId)
  return { store, audience, message, save, commit }
}

test('one writer stores provenance, versions and real idempotent receipts for multiple topics', () => {
  const f = fixture(); const msg = f.message('以后简短回复，并且叫我老王', 1)
  const command = { requestId: 'batch', expectedRevision: f.store.memoryLibrary.revision(f.audience), changes: [
    { action: 'save', kind: 'preference', tier: 'long', topic: '回复长度', prompt: '默认简短回复', core: true, sourceInboxId: msg.id, quote: '以后简短回复' },
    { action: 'save', kind: 'preference', tier: 'long', topic: '称呼', prompt: '称呼用户老王', core: true, sourceInboxId: msg.id, quote: '叫我老王' },
  ] }
  const receipt = f.store.memoryLibrary.write(command, { ...f.audience, actor: 'memory', batch: [msg] }, now)
  expect(receipt.items).toHaveLength(2)
  expect(f.store.memories('b')[0]).toMatchObject({ version: 1, format: 2, topic: '回复长度', source: { inboxId: msg.id } })
  expect(f.store.memoryLibrary.write(command, { ...f.audience, actor: 'memory', batch: [msg] }, now)).toEqual(receipt)
  expect(f.store.memories('b')).toHaveLength(2)
})

test('all same-topic rules require conflict decisions; stale library changes roll back the whole batch', () => {
  const f = fixture(); const first = f.message('以后简短回复', 1); f.save(first)
  const old = f.store.memories('b')[0]; const changed = f.message('以后详细回复', 2)
  expect(() => f.save(changed, { prompt: '默认详细回复' })).toThrow(/冲突|检查/)
  const stale = f.store.memoryLibrary.revision(f.audience)
  const another = f.message('叫我老王', 3); f.save(another, { topic: '称呼', prompt: '称呼用户老王' })
  expect(() => f.store.memoryLibrary.write({ requestId: 'stale', expectedRevision: stale, changes: [{ action: 'revoke', id: old.id, expectedVersion: 1, sourceInboxId: changed.id, quote: changed.text }] }, { ...f.audience, actor: 'router', batch: [changed] }, now)).toThrow(/版本|重新/)
  expect(f.store.memory(old.id)?.status).toBe('active')
})

test('permanent replacement records lineage, temporary override restores the base after expiry', () => {
  const f = fixture(); const first = f.message('以后简短回复', 1); f.save(first)
  const base = f.store.memories('b')[0]; const temp = f.message('这周详细回复', 2)
  f.save(temp, { tier: 'mid', core: false, prompt: '本周详细回复', expiresAt: now + 1000, conflicts: [{ memoryId: base.id, version: 1, relation: 'overrides' }] })
  expect(f.store.memory(base.id)?.status).toBe('active')
  expect(f.store.memoryLibrary.effective(f.audience, now + 200).map((m: RuntimeMemory) => m.prompt)).toEqual(['本周详细回复'])
  expect(f.store.memoryLibrary.effective(f.audience, now + 1001).map((m: RuntimeMemory) => m.id)).toEqual([base.id])
  f.store.memoryLibrary.sweep('b', now + 1001)
  const next = f.message('以后详细回复', 3)
  f.save(next, { prompt: '默认详细回复', conflicts: [{ memoryId: base.id, version: 1, relation: 'supersedes' }] })
  expect(f.store.memory(base.id)).toMatchObject({ status: 'superseded', version: 2 })
  expect(f.store.memoryLibrary.history(f.audience, base.id)).toHaveLength(2)
})

test('a task-specific change cannot permanently replace a global preference', () => {
  const f = fixture(); f.save(f.message('以后简短回复', 1)); const base = f.store.memories('b')[0]
  const msg = f.message('这个项目详细讲', 2)
  expect(() => f.save(msg, { core: false, scope: { project: '/project' }, conflicts: [{ memoryId: base.id, version: 1, relation: 'supersedes' }] })).toThrow(/范围/)
  expect(f.store.memories('b')).toHaveLength(1)
})

test('mid memories expire by time, not rounds or retrieval count; default seven days', () => {
  const f = fixture(); f.save(f.message('这段时间简短回复', 1), { tier: 'mid', core: false })
  const mid = f.store.memories('b')[0]
  expect(mid.expiresAt).toBe(mid.source.sentAt + 7 * 86400000)
  for (let i = 0; i < 12; i++) f.store.memoryLibrary.record(f.audience, [mid.id], 'used', `turn-${i}`, now + 100 + i)
  f.store.memoryLibrary.sweep('b', now + 1000)
  expect(f.store.memory(mid.id)).toMatchObject({ tier: 'mid', status: 'active', uses: 12, recalls: 0 })
  expect(f.store.memoryLibrary.effective(f.audience, mid.expiresAt! + 1)).toEqual([])
})

test('revoked sources and foreign messages are rejected; failed writes leave no partial memory', () => {
  const f = fixture(); const msg = f.message('以后简短回复', 1)
  f.store.revokeInbox(msg.id, now)
  expect(() => f.save(msg)).toThrow(/撤回|来源/)
  const other = f.store.receive({ botId: 'other', groupId: 'dm', senderId: 'owner', memberId: 'owner', text: '以后详细回复', seq: 2, createdAt: now })
  expect(() => f.save(other)).toThrow(/来源|身份/)
  expect(f.store.memories('b')).toEqual([])
})

test('withdrawal removes one supporting source and only revokes unsupported rules', () => {
  const f = fixture(); const first = f.message('以后简短回复', 1); f.save(first); const base = f.store.memories('b')[0]
  const second = f.message('以后都简短点', 2)
  f.save(second, { conflicts: [{ memoryId: base.id, version: 1, relation: 'duplicate' }] })
  f.store.memoryLibrary.withdrawSource(f.audience, first.id, now + 200)
  expect(f.store.memory(base.id)).toMatchObject({ status: 'active', source: { inboxId: second.id } })
  f.store.memoryLibrary.withdrawSource(f.audience, second.id, now + 300)
  expect(f.store.memory(base.id)?.status).toBe('revoked')
})

test('purge removes text, versions and indexes; replay cannot resurrect it', () => {
  const f = fixture(); const msg = f.message('以后称呼我秘密名字', 1); const receipt = f.save(msg, { topic: '称呼', prompt: '称呼用户秘密名字' }); const base = f.store.memories('b')[0]
  const forget = f.message('彻底删除这个称呼记忆', 2)
  f.store.memoryLibrary.write({ requestId: 'forget', expectedRevision: f.store.memoryLibrary.revision(f.audience), changes: [{ action: 'purge', id: base.id, expectedVersion: 1, sourceInboxId: forget.id, quote: forget.text }] }, { ...f.audience, actor: 'router', batch: [forget] }, now + 200)
  expect(f.store.memory(base.id)?.prompt ?? '').not.toContain('秘密名字')
  expect(JSON.stringify(f.store.memoryLibrary.history(f.audience, base.id))).not.toContain('秘密名字')
  expect(JSON.stringify(f.store.memoryLog('b', 100))).not.toContain('秘密名字')
  expect(f.save(msg, { topic: '称呼', prompt: '称呼用户秘密名字' }).items).toEqual(receipt.items)
  expect(f.store.memory(base.id)?.status).toBe('revoked')
})

test('explicit long-term intent can replace mid memory without count-based promotion', () => {
  const f = fixture(); f.save(f.message('这段时间简短点', 1), { tier: 'mid', core: false }); const old = f.store.memories('b')[0]
  f.save(f.message('以后都保持简短', 2), { tier: 'long', conflicts: [{ memoryId: old.id, version: 1, relation: 'supersedes' }] })
  expect(f.store.memory(old.id)?.status).toBe('superseded')
  expect(f.store.memories('b').find(m => m.id !== old.id)).toMatchObject({ tier: 'long', core: true })
})

test('phase-ending IDs are validated independently of the memory scope', () => {
  const f = fixture(); const msg = f.message('这个项目讨论期间简短回复', 1)
  expect(() => f.save(msg, { tier: 'mid', core: false, end: { kind: 'case', id: 'missing' } })).toThrow(/编号|阶段/)
})

test('task preferences survive interrupt and pending review, then expire on accepted completion', () => {
  const f = fixture(); const msg = f.message('排查这个项目', 1)
  const task = f.store.acceptWork({ inputId: msg.id, newCase: { title: '排查', object: '项目', goal: '排查' }, goal: '排查', acceptance: [], replies: [], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: '/project', allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  f.save(f.message('排查期间详细解释', 2), { tier: 'mid', core: false, scope: { taskId: task.id }, end: { kind: 'task', id: task.id } })
  const rule = f.store.memories('b')[0]
  for (const state of ['stopped','failed','completed'] as const) {
    f.store.updateTask(task.id, { state, review: { state: 'pending', rounds: 0 } }); f.store.memoryLibrary.sweep('b', now + 200)
    expect(f.store.memory(rule.id)?.status).toBe('active')
  }
  f.store.updateTask(task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } }); f.store.memoryLibrary.sweep('b', now + 300)
  expect(f.store.memory(rule.id)?.status).toBe('expired')
})

test('explicit discussion end expires case-bound memories through the shared writer', () => {
  const f = fixture(); f.store.saveCase({ id: 'discussion', botId: 'b', title: '方案', object: '项目', goal: '讨论方案', summary: '', createdAt: now, updatedAt: now })
  f.save(f.message('方案讨论期间先举例', 1), { tier: 'mid', core: false, scope: { caseId: 'discussion' }, end: { kind: 'case', id: 'discussion' } })
  const done = f.message('这个方案讨论结束', 2)
  f.store.memoryLibrary.write({ requestId: 'end', expectedRevision: f.store.memoryLibrary.revision(f.audience), changes: [{ action: 'end', kind: 'case', id: 'discussion', sourceInboxId: done.id, quote: done.text }] }, { ...f.audience, actor: 'router', batch: [done] }, now + 200)
  expect(f.store.memories('b')[0].status).toBe('expired')
})

test('invalid second topic rolls back an earlier valid write and its receipt', () => {
  const f = fixture(); const msg = f.message('以后简短，叫我老王', 1)
  const content = { action: 'save', tier: 'long', kind: 'preference', topic: '回复长度', prompt: '默认简短', core: true, sourceInboxId: msg.id, quote: '以后简短' }
  expect(() => f.store.memoryLibrary.write({ requestId: 'atomic', expectedRevision: f.store.memoryLibrary.revision(f.audience), changes: [content, { ...content, topic: '称呼', quote: '没有说过的内容' }] }, { ...f.audience, actor: 'router', batch: [msg] }, now)).toThrow(/原话/)
  expect(f.store.memories('b')).toEqual([]); expect(f.store.memoryLog('b')).toEqual([])
})

test('ending a phase blocks delayed extraction from its old source but permits a new later instruction', () => {
  const f = fixture(); f.store.saveCase({ id: 'discussion', botId: 'b', title: '方案', object: '项目', goal: '讨论', summary: '', createdAt: now, updatedAt: now })
  const old = f.message('讨论期间先举例', 1), done = f.message('讨论结束', 2)
  f.store.memoryLibrary.write({ requestId: 'end-first', expectedRevision: f.store.memoryLibrary.revision(f.audience), changes: [{ action: 'end', kind: 'case', id: 'discussion', sourceInboxId: done.id, quote: done.text }] }, { ...f.audience, actor: 'router', batch: [done] }, now + 100)
  const content = { tier: 'mid', core: false, end: { kind: 'case', id: 'discussion' } }
  expect(() => f.save(old, content)).toThrow(/阶段|结束/)
  f.save(f.message('重新讨论，还是先举例', 3), content)
  expect(f.store.memories('b')[0].status).toBe('active')
})

test('a delayed old phase-end cannot expire newer instructions that reopened the discussion', () => {
  const f = fixture(); f.store.saveCase({ id: 'discussion', botId: 'b', title: '方案', object: '项目', goal: '讨论', summary: '', createdAt: now, updatedAt: now })
  const done = f.message('这个讨论结束', 1), reopened = f.message('重新讨论，先举例', 2)
  f.save(reopened, { tier: 'mid', core: false, end: { kind: 'case', id: 'discussion' } })
  f.store.memoryLibrary.write({ requestId: 'late-end', expectedRevision: f.store.memoryLibrary.revision(f.audience), changes: [{ action: 'end', kind: 'case', id: 'discussion', sourceInboxId: done.id, quote: done.text }] }, { ...f.audience, actor: 'memory', batch: [done] }, now + 200)
  expect(f.store.memories('b')[0].status).toBe('active')
})

test('delayed old instructions cannot replace or revoke a newer owner correction', () => {
  const f = fixture(); const older = f.message('以后简短回复，忘掉旧要求', 1), newer = f.message('以后详细回复', 2)
  f.save(newer, { prompt: '默认详细回复' }); const current = f.store.memories('b')[0]
  expect(() => f.save(older, { conflicts: [{ memoryId: current.id, version: 1, relation: 'supersedes' }] })).toThrow(/来源|较新|先后/)
  expect(() => f.store.memoryLibrary.write({ requestId: 'late-forget', expectedRevision: f.store.memoryLibrary.revision(f.audience), changes: [{ action: 'revoke', id: current.id, expectedVersion: 1, sourceInboxId: older.id, quote: '忘掉旧要求' }] }, { ...f.audience, actor: 'memory', batch: [older] }, now + 300)).toThrow(/来源|较新|先后/)
  expect(f.store.memory(current.id)?.status).toBe('active')
})

test('latest reaffirming source protects a rule from a delayed older mutation', () => {
  const f = fixture(); f.save(f.message('以后详细回复', 1)); const current = f.store.memories('b')[0]
  const delayed = f.message('以后简短回复', 2), reaffirm = f.message('还是详细回复', 3)
  f.save(reaffirm, { conflicts: [{ memoryId: current.id, version: 1, relation: 'duplicate' }] })
  expect(() => f.save(delayed, { conflicts: [{ memoryId: current.id, version: 2, relation: 'overrides' }] })).toThrow(/来源|较新|先后/)
})

test('same message can preserve different rules for separate time windows', () => {
  const f = fixture(); const msg = f.message('这周简短回复，下周详细回复', 1)
  const first = { tier: 'mid', core: false, prompt: '简短回复', startsAt: now, expiresAt: now + 1000 }
  const a = f.save(msg, first, 'week-1').items[0]
  const second = { tier: 'mid', core: false, prompt: '详细回复', startsAt: now + 1000, expiresAt: now + 2000, conflicts: [{ memoryId: a.id, version: 1, relation: 'related' }] }
  const b = f.save(msg, second, 'week-2').items[0]
  expect(b.action).toBe('save'); expect(b.id).not.toBe(a.id)
  expect(f.store.memoryLibrary.effective(f.audience, now + 500).map(m => m.prompt)).toEqual(['简短回复'])
  expect(f.store.memoryLibrary.effective(f.audience, now + 1500).map(m => m.prompt)).toEqual(['详细回复'])
  expect(f.save(msg, first, 'replay-1').items[0]).toMatchObject({ id: a.id, action: 'duplicate' })
  expect(f.save(msg, second, 'replay-2').items[0]).toMatchObject({ id: b.id, action: 'duplicate' })
})

test('same-source changes in content, activation or end condition are not automatic replays', () => {
  for (const changed of [{ prompt: '详细回复' }, { startsAt: now + 1 }, { expiresAt: now + 2000 }, { end: { kind: 'case', id: 'discussion' } }]) {
    const f = fixture(); f.store.saveCase({ id: 'discussion', botId: 'b', title: '讨论', object: '规则', goal: '讨论', summary: '', createdAt: now, updatedAt: now })
    const msg = f.message('本阶段按约定回复', 1)
    const original = { tier: 'mid', core: false, startsAt: now, expiresAt: now + 1000 }
    f.save(msg, original, 'first')
    expect(() => f.save(msg, { ...original, ...changed }, 'different')).toThrow(/冲突|检查/)
  }
})

test('bounded long rules must override rather than permanently supersede defaults', () => {
  for (const bound of [{ expiresAt: now + 1000 }, { end: { kind: 'case', id: 'discussion' } }]) {
    const f = fixture(); f.store.saveCase({ id: 'discussion', botId: 'b', title: '讨论', object: '规则', goal: '讨论', summary: '', createdAt: now, updatedAt: now })
    f.save(f.message('默认简短回复', 1)); const base = f.store.memories('b')[0]
    const msg = f.message('暂时详细回复', 2)
    expect(() => f.save(msg, { ...bound, prompt: '详细回复', conflicts: [{ memoryId: base.id, version: 1, relation: 'supersedes' }] }, 'bounded')).toThrow(/临时|overrides|永久/)
    expect(f.store.memory(base.id)?.status).toBe('active'); expect(f.store.memories('b')).toHaveLength(1)
    f.save(msg, { ...bound, prompt: '详细回复', conflicts: [{ memoryId: base.id, version: 1, relation: 'overrides' }] }, 'override')
    if ('expiresAt' in bound) expect(f.store.memoryLibrary.effective(f.audience, now + 1001).map(m => m.id)).toEqual([base.id])
  }
})

const scheduled = (msg: RuntimeInbox, prompt: string, startsAt: number, expiresAt: number) => ({ action: 'save', tier: 'mid', kind: 'preference', topic: '回复长度', prompt, startsAt, expiresAt, sourceInboxId: msg.id, quote: prompt })

test('one atomic submission saves adjacent same-topic windows in either order and replays its receipt', () => {
  for (const reverse of [false, true]) {
    const f = fixture(); const msg = f.message('这周简短回复，下周详细回复', 1)
    const changes = [scheduled(msg, '简短回复', now, now + 1000), scheduled(msg, '详细回复', now + 1000, now + 2000)]
    if (reverse) changes.reverse()
    const receipt = f.commit(msg, changes)
    expect(receipt.items.map(item => item.action)).toEqual(['save', 'save'])
    expect(new Set(receipt.items.map(item => item.id)).size).toBe(2)
    expect(f.store.memoryLibrary.effective(f.audience, now + 999).map(m => m.prompt)).toEqual(['简短回复'])
    expect(f.store.memoryLibrary.effective(f.audience, now + 1000).map(m => m.prompt)).toEqual(['详细回复'])
    expect(f.store.memoryLibrary.effective(f.audience, now + 2000)).toEqual([])
    expect(f.commit(msg, changes)).toEqual(receipt)
    expect(f.store.memories('b')).toHaveLength(2)
  }
})

test('one batch may schedule disjoint overrides of the same existing default without mutating it', () => {
  const f = fixture(); f.save(f.message('默认简短回复', 1)); const base = f.store.memories('b')[0]
  const msg = f.message('这周详细回复，下周充分解释', 2)
  const conflicts = [{ memoryId: base.id, version: 1, relation: 'overrides' }]
  const receipt = f.commit(msg, [
    { ...scheduled(msg, '详细回复', now, now + 1000), conflicts },
    { ...scheduled(msg, '充分解释', now + 1000, now + 2000), conflicts },
  ])
  expect(receipt.items).toHaveLength(2)
  expect(f.store.memory(base.id)).toMatchObject({ status: 'active', version: 1 })
  for (const item of receipt.items) expect(f.store.memory(item.id)?.overrides).toEqual([base.id])
  expect(f.store.memoryLibrary.effective(f.audience, now + 500).map(m => m.prompt)).toEqual(['详细回复'])
  expect(f.store.memoryLibrary.effective(f.audience, now + 1500).map(m => m.prompt)).toEqual(['充分解释'])
  expect(f.store.memoryLibrary.effective(f.audience, now + 2000).map(m => m.id)).toEqual([base.id])
})

test('overlapping batch rules roll back completely and do not consume the request ID', () => {
  for (const secondStart of [now, now + 500]) {
    const f = fixture(); const msg = f.message('这周简短回复，下周详细回复', 1)
    const first = scheduled(msg, '简短回复', now, now + 1000)
    const revision = f.store.memoryLibrary.revision(f.audience)
    expect(() => f.commit(msg, [first, scheduled(msg, '详细回复', secondStart, now + 2000)])).toThrow(/同批.*重叠/)
    expect(f.store.memories('b')).toEqual([])
    expect(f.store.memoryLog('b')).toEqual([])
    expect(f.store.memoryLibrary.revision(f.audience)).toBe(revision)
    expect(f.commit(msg, [first, scheduled(msg, '详细回复', now + 1000, now + 2000)]).items).toHaveLength(2)
  }
})

test('each batch rule must still account for preexisting memories', () => {
  const f = fixture(); f.save(f.message('默认简短回复', 1)); const base = f.store.memories('b')[0]
  const msg = f.message('这周详细回复，下周充分解释', 2)
  expect(() => f.commit(msg, [
    { ...scheduled(msg, '详细回复', now, now + 1000), conflicts: [{ memoryId: base.id, version: 1, relation: 'overrides' }] },
    scheduled(msg, '充分解释', now + 1000, now + 2000),
  ])).toThrow(/同主题.*检查冲突/)
  expect(f.store.memories('b').map(m => m.id)).toEqual([base.id])
  expect(f.store.memory(base.id)).toMatchObject({ status: 'active', version: 1 })
})

test('batch scopes may be structurally disjoint but narrower scopes still overlap global rules', () => {
  const f = fixture(); const msg = f.message('方案一简短回复，方案二详细回复', 1)
  for (const id of ['one', 'two']) f.store.saveCase({ id, botId: 'b', title: id, object: id, goal: id, summary: '', createdAt: now, updatedAt: now })
  const a = scheduled(msg, '简短回复', now, now + 1000), b = scheduled(msg, '详细回复', now, now + 1000)
  expect(f.commit(msg, [{ ...a, scope: { caseId: 'one' } }, { ...b, scope: { caseId: 'two' } }]).items).toHaveLength(2)
  const g = fixture(); const other = g.message(msg.text, 1)
  expect(() => g.commit(other, [scheduled(other, '简短回复', now, now + 1000), { ...scheduled(other, '详细回复', now, now + 1000), scope: { project: '/project' } }])).toThrow(/同批.*重叠/)
  expect(g.store.memories('b')).toEqual([])
})
