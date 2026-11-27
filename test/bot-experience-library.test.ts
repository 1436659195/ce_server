import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeExperience } from '../src/cli/bot-runtime/types'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-lessons-')); const path = join(dir, 'runtime.sqlite')
  const store = new BotRuntimeStore(path); cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  let seq = 0
  const input = (botId = 'b') => store.receive({ botId, groupId: `dm-${botId}`, seq: ++seq, text: '总结远程部署经验', senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const msg = input()
  const task = store.acceptWork({ inputId: msg.id, newCase: { title: 'CE 部署', object: 'ce-server', goal: '服务对齐' }, goal: 'CE 远程部署', acceptance: ['运行验证'], mandate: { ownerPhoneId: 'owner', policyRevision: 1, directory: dir, allowedOps: ['read'], exclusions: [], mode: 'execute' }, replies: [] })
  return { store, path, input, msg, task, lib: store.experienceLibrary }
}
const content = (title = 'CE 远程部署与重启', extra: Record<string, unknown> = {}) => ({ title, object: 'ce-server', goal: '服务对齐', applicability: '升级远程 CE 服务时', scope: { project: 'ce-server', service: 'ce' }, pitfalls: ['控制端口不是固定值'], steps: ['读取 daemon.json 获取端口', '重启后重建会话'], verification: ['核对进程和二进制哈希'], ...extra })
let requests = 0
const command = (body = content(), extra: Record<string, unknown> = {}) => ({ requestId: `req-${++requests}`, content: body, changeSummary: '记录已发现的做法', ...extra })
const save = (f: ReturnType<typeof fixture>, body = content()) => f.lib.save('b', command(body), { taskId: f.task.id })

test('structured lessons persist, explicit notes remain unverified, matching topic is not duplicated', () => {
  const f = fixture(); expect(f.lib).toBeDefined()
  const receipt = save(f)
  expect(receipt).toMatchObject({ version: 1, created: true })
  expect(f.lib.get('b', receipt.id)).toMatchObject({ format: 2, kind: 'lesson', title: 'CE 远程部署与重启', version: 1, verified: false, stats: { displays: 0, reads: 0, adopted: 0, succeeded: 0, legacyExposures: 0 } })
  expect(save(f)).toMatchObject({ id: receipt.id, version: 1, created: false, duplicate: true })
  expect(f.lib.search('b', {})).toMatchObject({ total: 1, mode: 'catalog' })
})

test('versioned updates preserve immutable snapshots and reject optimistic conflicts', () => {
  const f = fixture(); const first = save(f)
  const next = f.lib.save('b', command(content(undefined, { steps: ['动态读端口', '先等待启动，再重建会话'] }), { id: first.id, expectedVersion: 1 }), { taskId: f.task.id })
  expect(next).toMatchObject({ id: first.id, version: 2, created: false })
  expect(f.lib.get('b', first.id, 1)?.steps).toEqual(['读取 daemon.json 获取端口', '重启后重建会话'])
  expect(f.lib.get('b', first.id)?.steps).toEqual(['动态读端口', '先等待启动，再重建会话'])
  expect(() => f.lib.save('b', command(content(), { id: first.id, expectedVersion: 1 }), { taskId: f.task.id })).toThrow(/版本/)
  expect(f.lib.history('b', first.id).map(e => e.version)).toEqual([1, 2])
  expect(f.lib.history('other', first.id)).toEqual([])
})

test('request receipts survive retries but the same request cannot mean different content', () => {
  const f = fixture(); const cmd = command()
  const receipt = f.lib.save('b', cmd, { inboxId: f.msg.id })
  expect(f.lib.save('b', cmd, { inboxId: f.msg.id })).toEqual(receipt)
  expect(() => f.lib.save('b', { ...cmd, content: content('changed') }, { inboxId: f.msg.id })).toThrow(/请求|重复/)
})

test('sources and material IDs must belong to the current Bot and be genuine ledger records', () => {
  const f = fixture(); const foreign = f.input('other')
  expect(() => f.lib.save('b', command(), { inboxId: foreign.id })).toThrow(/归属|来源/)
  expect(() => f.lib.save('b', command(), { taskId: 'missing' })).toThrow(/来源|工单/)
  expect(() => f.lib.save('b', command(), {})).toThrow(/来源/)
  f.store.saveArtifact({ id: 'a-other', botId: 'other', taskId: 't-other', caseId: 'c-other', title: 'script.sh', mime: 'text/plain', path: '/not-a-grant', size: 3, hash: 'hash-other', revision: 1, createdAt: 1 })
  expect(() => save(f, content(undefined, { artifactIds: ['a-other'] }))).toThrow(/材料|成果|归属/)
  expect(() => save(f, content(undefined, { artifactIds: ['/etc/passwd'] }))).toThrow(/材料|成果/)
  f.store.saveArtifact({ id: 'script', botId: 'b', taskId: f.task.id, caseId: f.task.caseId, title: 'script.sh', mime: 'text/plain', path: '/private/snapshot', size: 3, hash: 'immutable-hash', revision: 2, createdAt: 1 })
  const ref = save(f, content(undefined, { artifactIds: ['script'] }))
  expect(f.lib.get('b', ref.id)?.materials).toEqual([{ artifactId: 'script', hash: 'immutable-hash', revision: 2, name: 'script.sh', mime: 'text/plain' }])
})

test('only an accepted Worker result with concrete checks can validate a lesson', () => {
  const f = fixture()
  const reply = f.store.reply({ botId: 'b', groupId: 'dm-b', author: 'worker', purpose: 'result', text: '已验证', key: 'result', taskId: f.task.id, taskRevision: 1, policyRevision: 1, checks: ['进程与构建哈希一致'] })
  expect(() => f.lib.save('b', command(), { taskId: f.task.id, replyId: reply.id })).toThrow(/验收|接受/)
  f.store.updateTask(f.task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } })
  f.store.presentWorkerReply('b', reply.id, ['已完成。'], '')
  const receipt = f.lib.save('b', command(), { taskId: f.task.id, replyId: reply.id })
  expect(f.lib.get('b', receipt.id)?.verified).toBe(true)
})

test('scope matching excludes known incompatibility, preserves unknown conditions and filters before the catalog cap', () => {
  const f = fixture()
  save(f, content('Linux 重启', { scope: { os: 'linux' } }))
  save(f, content('Windows 重启', { scope: { os: 'windows' } }))
  save(f, content('通用重启', { scope: {} }))
  const found = f.lib.search('b', { query: '重启', scope: { os: 'linux' } })
  expect(found.items.map(e => e.title).sort()).toEqual(['Linux 重启', '通用重启'])
  const unknown = f.lib.search('b', { query: '重启' })
  expect(unknown.items).toHaveLength(3)
  expect(unknown.items.find(e => e.title === 'Linux 重启')?.warnings.join(' ')).toContain('os')
  expect(f.lib.search('other', { query: '重启' }).items).toEqual([])
})

test('small libraries expose all eligible candidates for semantic selection rather than reserving three popular slots', () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) save(f, content(`不相关旧主题${i}`))
  const lesson = save(f, content('会话失效后恢复连接'))
  const found = f.lib.search('b', { query: '重启后连不上' })
  expect(found.mode).toBe('catalog')
  expect(found.items).toHaveLength(5)
  expect(found.items.some(e => e.id === lesson.id)).toBe(true)
})

test('large libraries use Chinese/English full text search with bounded safe pagination', () => {
  const f = fixture()
  for (let i = 0; i < 22; i++) save(f, content(`库存报表${i}`, { object: 'inventory', applicability: '库存统计', pitfalls: [], steps: ['核对库存'] }))
  const target = save(f, content('CE restart 重建远程会话', { applicability: '远程重启后无法连接', steps: ['重建 remote session'] }))
  const found = f.lib.search('b', { query: '远程 restart 会话' })
  expect(found.mode).toBe('keyword')
  expect(found.items[0]?.id).toBe(target.id)
  expect(f.lib.search('b', { query: '" OR * : (', limit: 5 }).items).toEqual([])
  const first = f.lib.search('b', { query: '库存', limit: 5 })
  const second = f.lib.search('b', { query: '库存', limit: 5, offset: first.nextOffset })
  expect(first.items).toHaveLength(5); expect(second.items).toHaveLength(5)
  expect(first.items.some(e => second.items.some(x => x.id === e.id))).toBe(false)
  expect(() => f.lib.search('b', { limit: 21 })).toThrow(/范围|条数/)
  expect(() => f.lib.search('b', { offset: -1 })).toThrow(/范围|偏移/)
})

test('displays and reads never become adoption and repeated event receipts do not inflate exposure', () => {
  const f = fixture(); const e = save(f); const refs = [{ experienceId: e.id, version: 1 }]
  f.lib.recordExposure('b', refs, 'display', 'router-turn-1')
  f.lib.recordExposure('b', refs, 'display', 'router-turn-1')
  f.lib.recordExposure('b', refs, 'read', 'read-call-1')
  expect(f.lib.get('b', e.id)?.stats).toMatchObject({ displays: 1, reads: 1, adopted: 0, succeeded: 0 })
  expect(f.lib.get('b', e.id)?.uses).toBe(0)
})

test('adoption is tied to selected versions, concrete execution and one task/lesson, success waits for accepted checks', () => {
  const f = fixture(); const e = save(f); const refs = [{ experienceId: e.id, version: 1 }]
  const report = { experienceId: e.id, version: 1, status: 'applied' as const, appliedSteps: ['读取动态端口'], result: '已读到本次启动端口' }
  expect(() => f.lib.recordUsage('b', f.task.id, [report], [])).toThrow(/选|关联/)
  expect(() => f.lib.recordUsage('b', f.task.id, [{ ...report, appliedSteps: [] }], refs)).toThrow(/步骤/)
  f.lib.recordUsage('b', f.task.id, [report], refs)
  f.lib.recordUsage('b', f.task.id, [report], refs)
  expect(f.lib.get('b', e.id)?.stats).toMatchObject({ adopted: 1, succeeded: 0 })
  const reply = f.store.reply({ botId: 'b', groupId: 'dm-b', author: 'worker', purpose: 'result', text: '完成', key: 'usage-result', taskId: f.task.id, taskRevision: 1, policyRevision: 1, checks: ['端口与 daemon.json 一致'], experienceUsage: [report] })
  expect(() => f.lib.acceptUsage('b', f.task.id, reply.id)).toThrow(/验收|接受/)
  f.store.updateTask(f.task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } })
  f.store.presentWorkerReply('b', reply.id, ['完成。'], '')
  f.lib.acceptUsage('b', f.task.id, reply.id); f.lib.acceptUsage('b', f.task.id, reply.id)
  expect(f.lib.get('b', e.id)?.stats).toMatchObject({ adopted: 1, succeeded: 1 })
})

test('retirement/review/restore are versioned and pinned old snapshots stay readable', () => {
  const f = fixture(); const e = save(f)
  const change = (state: 'active' | 'needs_review' | 'retired', expectedVersion: number) => f.lib.changeState('b', { requestId: `state-${state}-${expectedVersion}`, id: e.id, expectedVersion, state, reason: '主人要求调整' }, { inboxId: f.msg.id })
  change('retired', 1)
  expect(f.lib.search('b', {}).items).toHaveLength(0)
  expect(f.lib.get('b', e.id, 1)?.state).toBe('active')
  expect(f.lib.get('b', e.id)?.state).toBe('retired')
  change('active', 2)
  expect(f.lib.get('b', e.id)?.version).toBe(3)
  expect(f.lib.search('b', {}).items).toHaveLength(1)
})

test('legacy exposure migration preserves reports and turns explicit retrospectives into searchable lessons once', () => {
  const f = fixture()
  const db = new Database(f.path)
  const legacy = (id: string, goal: string): RuntimeExperience => ({ id, botId: 'b', state: 'active', object: 'CE 服务', goal, approach: '文档已写好', detail: '控制端口随机变化；从 daemon.json 动态读取。', checks: ['已验证'], verified: true, sourceTaskId: f.task.id, sourceCaseId: f.task.caseId, uses: 11, platform: 'claude', toolFingerprint: 'old', createdAt: 1, updatedAt: 1 })
  for (const e of [legacy('report-old', '替换服务并重启'), legacy('lesson-old', '把部署踩坑整理成经验总结文档')]) db.query('INSERT INTO experiences(id,bot_id,body) VALUES(?,?,?)').run(e.id, e.botId, JSON.stringify(e))
  db.close(); f.store.close()
  const reopened = new BotRuntimeStore(f.path)
  expect(reopened.experience('report-old')).toMatchObject({ kind: 'report', uses: 0, stats: { legacyExposures: 11, adopted: 0 } })
  expect(reopened.experience('lesson-old')).toMatchObject({ kind: 'lesson', title: '把部署踩坑整理成经验总结文档', uses: 0, stats: { legacyExposures: 11 } })
  expect(reopened.experienceLibrary.search('b', {}).items.map(e => e.id)).toEqual(['lesson-old'])
  reopened.close()
  const again = new BotRuntimeStore(f.path)
  expect(again.experienceLibrary.history('b', 'lesson-old')).toHaveLength(1)
  expect(again.experience('lesson-old')?.stats?.legacyExposures).toBe(11)
  again.close()
})

test('failed adoption is auditable and marks review without changing the version already dispatched', () => {
  const f = fixture(); const e = save(f); const ref = { experienceId: e.id, version: 1 }
  f.lib.recordUsage('b', f.task.id, [{ ...ref, status: 'failed', appliedSteps: ['尝试重建会话'], result: '当前版本接口已经变化' }], [ref])
  expect(f.lib.get('b', e.id)).toMatchObject({ state: 'needs_review', version: 2, stats: { adopted: 1, succeeded: 0 } })
  expect(f.lib.get('b', e.id, 1)?.state).toBe('active')
  expect(f.lib.usage('b', e.id)[0]).toMatchObject({ taskId: f.task.id, version: 1, status: 'failed', successful: false })
  expect(f.lib.usageHistory('b', f.task.id)).toHaveLength(1)
  expect(f.lib.search('b', {}).items).toHaveLength(0)
})

test('accepted result without its own usage report cannot turn an earlier feedback into success', () => {
  const f = fixture(); const e = save(f); const ref = { experienceId: e.id, version: 1 }
  f.lib.recordUsage('b', f.task.id, [{ ...ref, status: 'applied', appliedSteps: ['旧轮次采用'], result: '旧结果待验收' }], [ref])
  const reply = f.store.reply({ botId: 'b', groupId: 'dm-b', author: 'worker', purpose: 'result', text: '新交付', key: 'new-no-usage', taskId: f.task.id, taskRevision: 1, policyRevision: 1, checks: ['新结果检查通过'] })
  f.store.updateTask(f.task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } }); f.store.presentWorkerReply('b', reply.id, ['完成。'], '')
  f.lib.acceptUsage('b', f.task.id, reply.id)
  expect(f.lib.get('b', e.id)?.stats).toMatchObject({ adopted: 1, succeeded: 0 })
})

test('duplicate usage IDs are rejected even across versions before any counters or history change', () => {
  const f = fixture(); const e = save(f)
  f.lib.save('b', command(content(), { id: e.id, expectedVersion: 1 }), { inboxId: f.msg.id })
  const refs = [1, 2].map(version => ({ experienceId: e.id, version }))
  const reports = refs.map(ref => ({ ...ref, status: 'applied' as const, appliedSteps: ['读取动态端口'], result: '端口已确认' }))
  expect(() => f.lib.recordUsage('b', f.task.id, reports, refs)).toThrow(/经验|重复/)
  expect(f.lib.get('b', e.id)?.stats).toMatchObject({ adopted: 0, succeeded: 0 })
  expect(f.lib.usageHistory('b', f.task.id)).toHaveLength(0)
})

test('accepted legacy duplicate reports cannot credit the stored failed adoption as success', () => {
  const f = fixture(); const e = save(f); const ref = { experienceId: e.id, version: 1 }
  const failed = { ...ref, status: 'failed' as const, appliedSteps: ['旧步骤'], result: '步骤已失效' }
  f.lib.recordUsage('b', f.task.id, [failed], [ref])
  const reply = f.store.reply({ botId: 'b', groupId: 'dm-b', author: 'worker', purpose: 'result', text: '完成', key: 'legacy-duplicates', taskId: f.task.id, taskRevision: 1, policyRevision: 1, checks: ['核实完成'], experienceUsage: [{ ...failed, status: 'applied' }, failed] })
  f.store.updateTask(f.task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } }); f.store.presentWorkerReply('b', reply.id, ['完成。'], '')
  expect(() => f.lib.acceptUsage('b', f.task.id, reply.id)).toThrow(/经验|重复/)
  expect(f.lib.usage('b', e.id)[0]).toMatchObject({ status: 'failed', successful: false })
  expect(f.lib.get('b', e.id)?.stats?.succeeded).toBe(0)
})

test('success requires the accepted report to match the recorded adoption, not only its ID and version', () => {
  const f = fixture(); const e = save(f); const ref = { experienceId: e.id, version: 1 }
  const applied = { ...ref, status: 'applied' as const, appliedSteps: ['读取动态端口'], result: '初次执行通过' }
  f.lib.recordUsage('b', f.task.id, [{ ...applied, status: 'failed', result: '后续核实失败' }], [ref])
  const reply = f.store.reply({ botId: 'b', groupId: 'dm-b', author: 'worker', purpose: 'result', text: '完成', key: 'mismatched-usage', taskId: f.task.id, taskRevision: 1, policyRevision: 1, checks: ['核实完成'], experienceUsage: [applied] })
  f.store.updateTask(f.task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } }); f.store.presentWorkerReply('b', reply.id, ['完成。'], '')
  f.lib.acceptUsage('b', f.task.id, reply.id)
  expect(f.lib.usage('b', e.id)[0]).toMatchObject({ status: 'failed', successful: false })
  expect(f.lib.get('b', e.id)?.stats?.succeeded).toBe(0)
})

test('matching normalized adapted feedback still counts success once after acceptance', () => {
  const f = fixture(); const e = save(f); const ref = { experienceId: e.id, version: 1 }
  const report = { ...ref, status: 'adapted' as const, appliedSteps: ['  按新接口读取动态端口  '], result: '  按目标版本调整后验证通过  ' }
  f.lib.recordUsage('b', f.task.id, [report], [ref])
  const reply = f.store.reply({ botId: 'b', groupId: 'dm-b', author: 'worker', purpose: 'result', text: '完成', key: 'adapted-usage', taskId: f.task.id, taskRevision: 1, policyRevision: 1, checks: ['新接口验证通过'], experienceUsage: [report] })
  f.store.updateTask(f.task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } }); f.store.presentWorkerReply('b', reply.id, ['完成。'], '')
  f.lib.acceptUsage('b', f.task.id, reply.id); f.lib.acceptUsage('b', f.task.id, reply.id)
  expect(f.lib.usage('b', e.id)[0]).toMatchObject({ status: 'adapted', successful: true })
  expect(f.lib.get('b', e.id)?.stats).toMatchObject({ adopted: 1, succeeded: 1 })
})

test('an accepted older applied report cannot validate a different applied result for the same version', () => {
  const f = fixture(); const e = save(f); const ref = { experienceId: e.id, version: 1 }
  const report = { ...ref, status: 'applied' as const, appliedSteps: ['读取动态端口'], result: '尚未检查的新结果' }
  f.lib.recordUsage('b', f.task.id, [report], [ref])
  const reply = f.store.reply({ botId: 'b', groupId: 'dm-b', author: 'worker', purpose: 'result', text: '完成', key: 'older-applied-usage', taskId: f.task.id, taskRevision: 1, policyRevision: 1, checks: ['旧结果验证通过'], experienceUsage: [{ ...report, result: '旧结果' }] })
  f.store.updateTask(f.task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } }); f.store.presentWorkerReply('b', reply.id, ['完成。'], '')
  f.lib.acceptUsage('b', f.task.id, reply.id)
  expect(f.lib.usage('b', e.id)[0]).toMatchObject({ status: 'applied', successful: false })
  expect(f.lib.get('b', e.id)?.stats?.succeeded).toBe(0)
})

test('numeric version ranges and OS aliases are checked while unknown versions remain candidates', () => {
  const f = fixture(); save(f, content('支持版本一', { scope: { os: 'win32', versionRange: '>=1.2.0 <2.0.0' } }))
  expect(f.lib.search('b', { scope: { os: 'windows', version: '1.5.0' } }).items).toHaveLength(1)
  expect(f.lib.search('b', { scope: { os: 'windows', version: '2.0.0' } }).items).toHaveLength(0)
  expect(f.lib.search('b', { scope: { os: 'windows' } }).items[0]?.warnings).toContain('versionRange 未核实')
})

test('failure of a pinned old version does not mark an independently corrected latest version for review', () => {
  const f = fixture(); const e = save(f)
  f.lib.save('b', command(content(undefined, { steps: ['已修正的新步骤'] }), { id: e.id, expectedVersion: 1 }), { inboxId: f.msg.id })
  const ref = { experienceId: e.id, version: 1 }
  f.lib.recordUsage('b', f.task.id, [{ ...ref, status: 'failed', appliedSteps: ['执行旧步骤'], result: '旧步骤失效，新版尚未派发' }], [ref])
  expect(f.lib.get('b', e.id)).toMatchObject({ state: 'active', version: 2, steps: ['已修正的新步骤'] })
  expect(f.lib.usage('b', e.id)[0]).toMatchObject({ version: 1, status: 'failed', successful: false })
})

test('blank check strings do not validate a lesson or count successful adoption', () => {
  const f = fixture(); const e = save(f); const ref = { experienceId: e.id, version: 1 }
  const report = { ...ref, status: 'applied' as const, appliedSteps: ['动态读端口'], result: '执行过但尚未提供检查证据' }
  f.lib.recordUsage('b', f.task.id, [report], [ref])
  const reply = f.store.reply({ botId: 'b', groupId: 'dm-b', author: 'worker', purpose: 'result', text: '完成', key: 'blank-check', taskId: f.task.id, taskRevision: 1, policyRevision: 1, checks: ['  '], experienceUsage: [report] })
  f.store.updateTask(f.task.id, { state: 'completed', review: { state: 'approved', rounds: 0 } }); f.store.presentWorkerReply('b', reply.id, ['完成。'], '')
  const next = f.lib.save('b', command(content('未验证的另一个经验')), { taskId: f.task.id, replyId: reply.id })
  expect(f.lib.get('b', next.id)?.verified).toBe(false)
  f.lib.acceptUsage('b', f.task.id, reply.id)
  expect(f.lib.get('b', e.id)?.stats).toMatchObject({ adopted: 1, succeeded: 0 })
})

test('generic identical titles do not swallow lessons for different objects, goals or applicability', () => {
  const f = fixture()
  const ce = save(f, content('服务重启流程', { object: 'CE', scope: {} }))
  const pg = save(f, content('服务重启流程', { object: 'PostgreSQL', scope: {}, steps: ['使用 pg_ctl 重启'] }))
  const otherGoal = save(f, content('服务重启流程', { object: 'CE', scope: {}, goal: '数据库迁移前的停机准备' }))
  const otherCondition = save(f, content('服务重启流程', { object: 'CE', scope: {}, applicability: '离线恢复环境' }))
  expect(new Set([ce.id, pg.id, otherGoal.id, otherCondition.id]).size).toBe(4)
  expect(f.lib.get('b', pg.id)?.steps).toEqual(['使用 pg_ctl 重启'])
  expect(save(f, content('服务重启流程', { object: 'ce', scope: {} }))).toMatchObject({ id: ce.id, duplicate: true })
})

test('ambiguous abbreviated caret and tilde ranges warn instead of falsely excluding matching environments', () => {
  const f = fixture(); save(f, content('宽泛版本条件', { scope: { versionRange: '~1' } }))
  const found = f.lib.search('b', { scope: { version: '1.5.0' } })
  expect(found.items).toHaveLength(1)
  expect(found.items[0].warnings).toContain('versionRange 未核实')
})

test('abbreviated version ranges are unknown rather than padded into exact numeric versions', () => {
  const f = fixture()
  for (const [range, version] of [['1', '1.5.0'], ['1.2', '1.2.9'], ['=1.2', '1.2.9'], ['>=1.2', '1.2.9'], ['^0', '0.5.0']]) {
    const saved = save(f, content(`简写范围 ${range}`, { scope: { versionRange: range } }))
    const found = f.lib.search('b', { scope: { version } }).items.find(e => e.id === saved.id)
    expect(found).toBeDefined()
    expect(found?.warnings).toContain('versionRange 未核实')
  }
  const exact = save(f, content('完整精确版本', { scope: { versionRange: '=1.2.0' } }))
  expect(f.lib.search('b', { scope: { version: '1.2.9' } }).items.some(e => e.id === exact.id)).toBe(false)
})

test('incomplete current versions stay unknown for both ranges and exact numeric scopes', () => {
  const f = fixture()
  const ranged = save(f, content('完整范围', { scope: { versionRange: '>=1.2.1 <2.0.0' } }))
  const exact = save(f, content('精确补丁版本', { scope: { version: '1.2.9' } }))
  for (const version of ['1', '1.2', 'v1.2']) {
    const found = f.lib.search('b', { scope: { version } }).items
    expect(found.find(e => e.id === ranged.id)?.warnings).toContain('versionRange 未核实')
    expect(found.find(e => e.id === exact.id)?.warnings).toContain('version 未核实')
  }
  expect(f.lib.search('b', { scope: { version: '1.2.0' } }).items).toHaveLength(0)
  expect(f.lib.search('b', { scope: { version: '1.2.9' } }).items.map(e => e.id)).toEqual(expect.arrayContaining([ranged.id, exact.id]))
  const partial = save(f, content('待核实的精确版本', { scope: { version: '1.2' } }))
  expect(f.lib.search('b', { scope: { version: '1.2.9' } }).items.find(e => e.id === partial.id)?.warnings).toContain('version 未核实')
})

test('exact version scopes exclude known mismatches and retain unknown versions with explicit warnings', () => {
  const f = fixture(); const exact = save(f, content('仅适用一个版本', { scope: { version: 'v1.0.0' } }))
  expect(f.lib.search('b', { scope: { version: '2.0.0' } }).items).toHaveLength(0)
  const match = f.lib.search('b', { scope: { version: '1.0.0' } }).items
  expect(match.map(e => e.id)).toEqual([exact.id]); expect(match[0]?.warnings).toEqual([])
  const unknown = f.lib.search('b', {}).items
  expect(unknown.map(e => e.id)).toEqual([exact.id]); expect(unknown[0]?.warnings).toContain('version 未核实')
})

test('exact opaque versions use normalized equality and both exact version and range remain required', () => {
  const f = fixture(); const opaque = save(f, content('固定提交版本', { scope: { version: 'Build-ABC123' } }))
  expect(f.lib.search('b', { scope: { version: ' build-abc123 ' } }).items.map(e => e.id)).toEqual([opaque.id])
  expect(f.lib.search('b', { scope: { version: 'build-def456' } }).items).toHaveLength(0)
  const both = save(f, content('精确版本加兼容范围', { scope: { version: '1.2.3', versionRange: '>=1.0.0 <2.0.0' } }))
  expect(f.lib.search('b', { scope: { version: '1.5.0' } }).items).toHaveLength(0)
  expect(f.lib.search('b', { scope: { version: 'v1.2.3' } }).items.map(e => e.id)).toEqual([both.id])
  const unknown = f.lib.search('b', {}).items.find(e => e.id === both.id)
  expect(unknown?.warnings).toEqual(expect.arrayContaining(['version 未核实', 'versionRange 未核实']))
  save(f, content('相互矛盾的版本要求', { scope: { version: '1.2.3', versionRange: '>=2.0.0' } }))
  expect(f.lib.search('b', { scope: { version: '1.2.3' } }).items.map(e => e.id)).toEqual([both.id])
})
