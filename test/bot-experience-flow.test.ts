import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService, type RuntimeClientOptions } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot } from '../src/cli/bot-runtime/types'
import type { CodexTurn } from '../src/cli/bot-runtime/codex'
import { routerCall } from './helpers/router-decision'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function until(check: () => boolean) { for (let n = 0; n < 300 && !check(); n++) await Bun.sleep(5); expect(check()).toBe(true) }
const content = {
  title: 'CE 远程升级与重启', object: 'CE 服务', goal: '远程升级', applicability: 'CE 远程构建、替换与重启',
  pitfalls: ['控制端口每次启动都会变化'], steps: ['从 daemon.json 动态读取端口', '通道失效时重建会话'],
  verification: ['检查进程哈希和连接状态'], detail: '不要将历史观察到的端口写死到脚本里。', artifactIds: [],
}
const draft = () => ({ content: structuredClone(content), changeSummary: '保存部署复盘' })
interface Turn { context: any; call(tool: string, args: Record<string, unknown>): Promise<any>; finish(): void }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-experience-flow-')); const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'b', name: '维护', groupId: 'dm', ownerPhoneId: 'owner', platform: 'codex', sourceCwd: dir, directory: dir, policyRevision: 1, commandSandbox: false, workerAccessMode: 'full-access',
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ botId: 'b', mode: 'router-worker', revision: 1, profile: '', model: '' })
  const routers: Turn[] = []; const workers: Turn[] = []; let sequence = 0; let calls = 0
  const service = new BotRuntimeService({ store, rootDir: dir, routerQuietMs: 0, tickMs: 3_600_000, bubbleGapMs: 0, getBot: () => bot, sendReply: async () => {},
    checkAccess: async () => ({ directory: dir, permissions: bot.permissions, revision: 1 }), openTools: () => { throw new Error('unused') },
    createClient: (role, options: RuntimeClientOptions) => {
      let finish: (() => void) | undefined
      return { initialize: async () => {}, startThread: async () => `thread-${role}`, resumeThread: async id => id,
        startTurn: async (threadId, text) => {
          const turnId = `${role}-${++sequence}`
          if (role === 'memory') return { threadId, turnId, done: Promise.resolve({ id: turnId, status: 'completed' }) }
          const done = new Promise<CodexTurn>(resolve => { finish = () => resolve({ id: turnId, status: 'completed' }) })
          const resolve = finish!
          const turn = { context: JSON.parse(text), call: (tool: string, args: Record<string, unknown>) => options.onToolCall({ threadId, turnId, tool, arguments: args, callId: `call-${++calls}` }), finish: resolve }
          ;(role === 'router' ? routers : workers).push(turn)
          return { threadId, turnId, done }
        }, steer: async () => '', interrupt: async () => { finish?.() }, close: async () => { finish?.() } }
    } })
  let seq = 0
  const send = (text: string) => service.receive('b', { groupId: 'dm', seq: ++seq, text, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const source = () => store.receive({ botId: 'b', groupId: 'dm', seq: 1000 + ++seq, text: '请保存 CE 部署经验', senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const seed = () => { const s = source(); const receipt = store.experienceLibrary.save('b', { requestId: `seed-${s.id}`, ...draft() }, { inboxId: s.id }); store.markInput(s.id, 'routed', { action: 'reply' }); return receipt }
  cleanups.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, store, service, routers, workers, send, source, seed }
}
async function startTask(f: ReturnType<typeof fixture>, refs: Array<{ experienceId: string; version: number }> = []) {
  f.send('服务对齐'); await until(() => f.routers.length === 1)
  const args = routerCall({ action: 'start', newCase: { title: 'CE', object: 'CE 服务', goal: '维护 CE' }, goal: 'CE 远程升级与重启', delivery: 'chat', allowedOps: ['read'], replies: ['开始处理。'], executionGuidance: '动态读取端口，并验证连接状态。' })
  if (refs.length) Object.assign(args.decision as object, { experienceRefs: refs })
  await f.routers[0].call('router_decide', args); f.routers[0].finish(); await until(() => f.workers.length === 1)
  return f.workers[0]
}
async function finishTask(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  await f.workers[0].call('work_finish', { revision: 1, text: '任务已完成。', artifactIds: [], checks: ['连接状态已核实'], ...extra })
  await until(() => f.routers.length === 2)
}
async function acceptResult(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  const result = await f.routers[1].call('router_decide', { ...routerCall({ action: 'reply', replies: ['已完成。'] }), ...extra })
  f.routers[1].finish(); f.workers[0].finish(); return result
}

test('普通交付报告不再自动写成经验', async () => {
  const f = fixture(); await startTask(f); await finishTask(f); await acceptResult(f)
  expect(f.store.experiences('b')).toHaveLength(0)
})

test('Worker 的经验草稿经 Router 明确批准且交付验收后才保存并返回回执', async () => {
  const f = fixture(); await startTask(f); await finishTask(f, { lesson: draft() })
  expect(f.store.experiences('b')).toHaveLength(0)
  expect(f.routers[1].context.workerMessage.lesson.content.title).toBe(content.title)
  const receipt = await acceptResult(f, { acceptLesson: true })
  expect(receipt.experienceReceipt).toMatchObject({ version: 1, created: true })
  expect(f.store.experiences('b')).toHaveLength(1)
  expect(f.store.experiences('b')[0]).toMatchObject({ title: content.title, verified: true })
})

test('Router 可以按本轮用户原话直接保存，收到真实回执，聊天完成不算采用', async () => {
  const f = fixture(); f.send('把 CE 部署的坑记成经验'); await until(() => f.routers.length === 1)
  const receipt = await f.routers[0].call('experience_save', { requestId: 'manual', ...draft() })
  expect(receipt).toMatchObject({ version: 1, created: true })
  await f.routers[0].call('router_decide', routerCall({ action: 'reply', replies: ['已保存经验。'] })); f.routers[0].finish()
  expect(f.store.experiences('b')[0]).toMatchObject({ title: content.title, verified: false })
})

test('小经验库提供完整候选，主动搜索可用长期规矩展开查询，读取详情不会算采用', async () => {
  const f = fixture(); const receipt = f.seed()
  f.send('服务对齐'); await until(() => f.routers.length === 1)
  expect(f.routers[0].context.experienceSummaries.some((e: any) => e.id === receipt.id)).toBe(true)
  const found = await f.routers[0].call('experience_search', { query: 'CE 远程部署 构建 替换 重启' })
  expect(found.items.some((e: any) => e.id === receipt.id)).toBe(true)
  const read = await f.routers[0].call('experience_read', { experienceId: receipt.id, version: 1 })
  expect(read.steps).toContain('从 daemon.json 动态读取端口')
  await f.routers[0].call('router_decide', routerCall({ action: 'reply', replies: ['找到部署经验。'] })); f.routers[0].finish()
  expect(f.store.experienceLibrary.usage('b', receipt.id)).toHaveLength(0)
})

test('选中版本传入 Worker；看过不等于采用；实际采用和验收成功独立记账', async () => {
  const f = fixture(); const receipt = f.seed(); const refs = [{ experienceId: receipt.id, version: 1 }]
  const worker = await startTask(f, refs)
  expect(worker.context.task.experienceRefs).toEqual(refs)
  const read = await worker.call('work_read_experience', { experienceId: receipt.id, version: 1 })
  expect(read.steps).toContain('从 daemon.json 动态读取端口')
  expect(f.store.experienceLibrary.usage('b', receipt.id)).toHaveLength(0)
  await finishTask(f, { experienceUsage: [{ ...refs[0], status: 'applied', appliedSteps: ['从 daemon.json 动态读取端口'], result: '端口与进程对应，连接恢复' }] })
  const task = f.store.tasks('b')[0]
  expect(f.store.experienceLibrary.usage('b', receipt.id)).toHaveLength(1)
  await acceptResult(f)
  expect(f.store.experienceLibrary.usage('b', receipt.id)[0]).toMatchObject({ taskId: task.id, successful: true })
})

test('Worker 不能声称采用没有被派发的经验，校验失败不完成任务', async () => {
  const f = fixture(); const receipt = f.seed(); const worker = await startTask(f)
  await expect(worker.call('work_finish', { revision: 1, text: '完成', artifactIds: [], checks: ['已核实'], experienceUsage: [{ experienceId: receipt.id, version: 1, status: 'applied', appliedSteps: ['动态读取端口'], result: '完成' }] })).rejects.toThrow(/经验|选用|派发/)
  expect(f.store.tasks('b')[0].state).toBe('running')
})

for (const statuses of [['applied', 'failed'], ['failed', 'applied']]) test(`同次交付拒绝同一经验的重复反馈 ${statuses.join('/')}，修改后可正常交付`, async () => {
  const f = fixture(); const saved = f.seed(); const ref = { experienceId: saved.id, version: 1 }
  const worker = await startTask(f, [ref])
  const report = { ...ref, status: 'failed', appliedSteps: ['执行旧步骤'], result: '旧步骤失效' }
  await expect(worker.call('work_finish', { revision: 1, text: '完成', artifactIds: [], checks: ['检查完成'],
    experienceUsage: statuses.map(status => ({ ...report, status })) })).rejects.toThrow(/经验|重复/)
  expect(f.store.tasks('b')[0].state).toBe('running')
  expect(f.store.experienceLibrary.get('b', saved.id)).toMatchObject({ version: 1, state: 'active', stats: { adopted: 0, succeeded: 0 } })
  expect(f.store.experienceLibrary.usageHistory('b', f.store.tasks('b')[0].id)).toHaveLength(0)
  await finishTask(f, { experienceUsage: [report] }); await acceptResult(f)
  expect(f.store.experienceLibrary.usage('b', saved.id)[0]).toMatchObject({ status: 'failed', successful: false })
  expect(f.store.experienceLibrary.get('b', saved.id)?.stats).toMatchObject({ adopted: 1, succeeded: 0 })
})

test('更新经验后，已开始的 Worker 仍读取派发时的旧版本', async () => {
  const f = fixture(); const receipt = f.seed(); const worker = await startTask(f, [{ experienceId: receipt.id, version: 1 }])
  const s = f.source()
  f.store.experienceLibrary.save('b', { requestId: 'update', id: receipt.id, expectedVersion: 1, ...draft(), content: { ...content, steps: ['新版步骤'] }, changeSummary: '补充新做法' }, { inboxId: s.id })
  const old = await worker.call('work_read_experience', { experienceId: receipt.id, version: 1 })
  expect(old.version).toBe(1); expect(old.steps).toContain('从 daemon.json 动态读取端口')
  await expect(worker.call('work_read_experience', { experienceId: receipt.id, version: 2 })).rejects.toThrow(/经验|版本|派发/)
})

test('Router 不批准草稿时交付照常完成，经验不发布', async () => {
  const f = fixture(); await startTask(f); await finishTask(f, { lesson: draft() })
  await acceptResult(f, { acceptLesson: false })
  expect(f.store.experiences('b')).toHaveLength(0)
  expect(f.store.tasks('b')[0].review?.state).toBe('approved')
})

test('同次失败反馈和修复草稿不会自造版本冲突，验收后发布修正版并保留失败历史', async () => {
  const f = fixture(); const saved = f.seed(); const ref = { experienceId: saved.id, version: 1 }
  await startTask(f, [ref])
  await finishTask(f, { lesson: { ...draft(), id: saved.id, expectedVersion: 1, content: { ...content, steps: ['使用新版接口重建会话'] } },
    experienceUsage: [{ ...ref, status: 'failed', appliedSteps: ['尝试旧版会话接口'], result: '旧接口失效，已换新版接口并验证' }] })
  expect(f.store.experienceLibrary.get('b', saved.id)).toMatchObject({ state: 'needs_review', version: 2 })
  const reply = f.store.replies('b').find(r => r.author === 'worker' && r.purpose === 'result')!
  expect(() => f.store.experienceLibrary.acceptLesson('b', reply.id)).toThrow(/验收/)
  const receipt = await acceptResult(f, { acceptLesson: true })
  expect(receipt.experienceReceipt).toMatchObject({ id: saved.id, version: 3, created: false })
  expect(f.store.experienceLibrary.acceptLesson('b', reply.id)).toEqual(receipt.experienceReceipt)
  expect(f.store.tasks('b')[0].review?.state).toBe('approved')
  expect(f.store.experienceLibrary.get('b', saved.id)).toMatchObject({ state: 'active', verified: true, steps: ['使用新版接口重建会话'] })
  expect(f.store.experienceLibrary.history('b', saved.id).map(e => [e.version, e.state])).toEqual([[1, 'active'], [2, 'needs_review'], [3, 'active']])
  expect(f.store.experienceLibrary.usage('b', saved.id)[0]).toMatchObject({ version: 1, status: 'failed', successful: false })
})

test('失败反馈后的独立更新仍受版本保护，不能被旧修复草稿覆盖', async () => {
  const f = fixture(); const saved = f.seed(); const ref = { experienceId: saved.id, version: 1 }
  await startTask(f, [ref])
  await finishTask(f, { lesson: { ...draft(), id: saved.id, expectedVersion: 1 },
    experienceUsage: [{ ...ref, status: 'failed', appliedSteps: ['执行旧步骤'], result: '旧步骤已失效' }] })
  const source = f.source()
  f.store.experienceLibrary.save('b', { requestId: 'independent-fix', id: saved.id, expectedVersion: 2, ...draft(), content: { ...content, steps: ['独立修正的新步骤'] } }, { inboxId: source.id })
  await expect(acceptResult(f, { acceptLesson: true })).rejects.toThrow(/版本/)
  expect(f.store.experienceLibrary.get('b', saved.id)).toMatchObject({ version: 3, steps: ['独立修正的新步骤'] })
  await acceptResult(f, { acceptLesson: false })
})

test('人工状态更新不能被当成本工单的自动失败标记跳过', async () => {
  const f = fixture(); const saved = f.seed(); const ref = { experienceId: saved.id, version: 1 }
  await startTask(f, [ref]); const task = f.store.tasks('b')[0]
  f.store.experienceLibrary.changeState('b', { requestId: 'manual-review', id: saved.id, expectedVersion: 1, state: 'needs_review', reason: '需要额外人工核查' }, { taskId: task.id })
  await finishTask(f, { lesson: { ...draft(), id: saved.id, expectedVersion: 1 },
    experienceUsage: [{ ...ref, status: 'failed', appliedSteps: ['执行旧步骤'], result: '旧步骤失效' }] })
  await expect(acceptResult(f, { acceptLesson: true })).rejects.toThrow(/版本/)
  expect(f.store.experienceLibrary.get('b', saved.id)).toMatchObject({ version: 2, state: 'needs_review', changeSummary: '需要额外人工核查' })
  await acceptResult(f, { acceptLesson: false })
})

test('没有验证依据的修复草稿可保存但保持待复核', async () => {
  const f = fixture(); const saved = f.seed(); const ref = { experienceId: saved.id, version: 1 }
  await startTask(f, [ref])
  await finishTask(f, { checks: [], lesson: { ...draft(), id: saved.id, expectedVersion: 1 },
    experienceUsage: [{ ...ref, status: 'failed', appliedSteps: ['执行旧步骤'], result: '失效，提出待验证改法' }] })
  await acceptResult(f, { acceptLesson: true })
  expect(f.store.experienceLibrary.get('b', saved.id)).toMatchObject({ version: 3, state: 'needs_review', verified: false })
})

test('没有本轮用户委托时，不能用直接保存绕过 Worker 草稿验收', async () => {
  const f = fixture(); await startTask(f); await finishTask(f, { lesson: draft() })
  await expect(f.routers[1].call('experience_save', { requestId: 'bypass', ...draft() })).rejects.toThrow(/验收|用户|委托|草稿/)
  expect(f.store.experiences('b')).toHaveLength(0)
  await acceptResult(f, { acceptLesson: false })
})

test('经验编号不能跨 Bot 读取，Router 也不能靠猜编号获得材料', async () => {
  const f = fixture()
  const source = f.store.receive({ botId: 'other', groupId: 'other-dm', seq: 1, text: '保存其他 Bot 的经验', senderId: 'other-owner', memberId: 'other-member', createdAt: Date.now() })
  const receipt = f.store.experienceLibrary.save('other', { requestId: 'other', ...draft() }, { inboxId: source.id })
  f.send('找 CE 部署经验'); await until(() => f.routers.length === 1)
  await expect(f.routers[0].call('experience_read', { experienceId: receipt.id })).rejects.toThrow(/经验|归属|不存在/)
})


test('经验材料按派发版本授权，实际快照改变后拒绝读取', async () => {
  const f = fixture(); const script = '#!/bin/sh\necho deployment-check\n'; const path = join(f.dir, 'script.sh')
  writeFileSync(path, script)
  f.store.saveArtifact({ id: 'script', botId: 'b', taskId: 'old-task', caseId: 'old-case', title: 'deployment-check.sh', mime: 'text/plain', path, size: Buffer.byteLength(script), hash: createHash('sha256').update(script).digest('hex'), revision: 1, createdAt: Date.now() })
  const source = f.source()
  const saved = f.store.experienceLibrary.save('b', { requestId: 'script-lesson', ...draft(), content: { ...content, artifactIds: ['script'] } }, { inboxId: source.id })
  f.store.markInput(source.id, 'routed', { action: 'reply' })
  const worker = await startTask(f, [{ experienceId: saved.id, version: 1 }])
  const read = await worker.call('work_read_experience', { experienceId: saved.id, version: 1, artifactId: 'script' })
  expect(read.text).toContain('deployment-check')
  await expect(worker.call('work_read_experience', { experienceId: saved.id, version: 1, artifactId: 'unrelated' })).rejects.toThrow(/材料|经验|关联/)
  writeFileSync(path, 'changed')
  await expect(worker.call('work_read_experience', { experienceId: saved.id, version: 1, artifactId: 'script' })).rejects.toThrow(/快照|改变|校验/)
})


test('Worker 草稿和采用反馈总量超限时，不完成任务也不记采用', async () => {
  const f = fixture(); const saved = f.seed(); const ref = { experienceId: saved.id, version: 1 }; const worker = await startTask(f, [ref])
  const lesson = { ...draft(), content: { ...content, detail: '详'.repeat(12000), pitfalls: Array(10).fill('坑'.repeat(500)) } }
  await expect(worker.call('work_finish', { revision: 1, text: '完成', artifactIds: [], checks: ['已核实'], lesson, experienceUsage: [{ ...ref, status: 'applied', appliedSteps: ['读端口'], result: '恢复连接' }] })).rejects.toThrow(/过长|附件/)
  expect(f.store.tasks('b')[0].state).toBe('running')
  expect(f.store.experienceLibrary.usage('b', saved.id)).toHaveLength(0)
  expect(f.store.replies('b').filter(r => r.author === 'worker' && r.purpose === 'result')).toHaveLength(0)
})

test('经验草稿更新冲突可放弃草稿并重试验收，不丢交付结果', async () => {
  const f = fixture(); const saved = f.seed(); const ref = { experienceId: saved.id, version: 1 }
  await startTask(f, [ref]); await finishTask(f, { lesson: { ...draft(), id: saved.id, expectedVersion: 1 } })
  const source = f.source()
  f.store.experienceLibrary.save('b', { requestId: 'concurrent-update', ...draft(), id: saved.id, expectedVersion: 1, content: { ...content, steps: ['另一次修正'] } }, { inboxId: source.id })
  await expect(f.routers[1].call('router_decide', { ...routerCall({ action: 'reply', replies: ['已完成。'] }), acceptLesson: true })).rejects.toThrow(/版本/)
  expect(f.store.tasks('b')[0].review?.state).toBe('pending')
  expect(f.store.replies('b').find(r => r.author === 'worker' && r.purpose === 'result')?.state).toBe('pending')
  await acceptResult(f, { acceptLesson: false })
  expect(f.store.tasks('b')[0].review?.state).toBe('approved')
  expect(f.store.experienceLibrary.get('b', saved.id)?.steps).toEqual(['另一次修正'])
})

test('大经验库用本轮命中的长期约定展开检索，不混入无关规矩', async () => {
  const f = fixture(); const source = f.source()
  for (let i = 0; i < 22; i++) f.store.experienceLibrary.save('b', { requestId: `noise-${i}`, ...draft(), content: { ...content, title: `库存分析${i}`, object: 'inventory', goal: '库存核对', applicability: '库存统计', steps: ['核对库存'], pitfalls: [], verification: [] } }, { inboxId: source.id })
  const target = f.store.experienceLibrary.save('b', { requestId: 'target', ...draft(), content: { ...content, title: 'daemon replacement restart', object: 'daemon', goal: 'deployment', applicability: 'deployment', steps: ['restart daemon'], pitfalls: [], verification: [] } }, { inboxId: source.id })
  const unrelated = f.store.experienceLibrary.save('b', { requestId: 'unrelated', ...draft(), content: { ...content, title: '天气提醒', object: '天气', goal: '预报', applicability: '查询天气', steps: ['查询预报'], pitfalls: [], verification: [] } }, { inboxId: source.id })
  for (const [id, prompt, appliesTo] of [['rule', '服务对齐指 daemon replacement restart deployment', '服务对齐'], ['weather', '天气查询需要获取天气预报', '天气查询']]) f.store.saveMemory({ id, botId: 'b', channel: 'dm', senderId: 'owner', tier: 'long', status: 'active', prompt, appliesTo, source: { inboxId: source.id, quote: prompt, context: '', sentAt: 1 }, triggers: { count: 0 }, createdAt: 1, updatedAt: 1 })
  f.store.markInput(source.id, 'routed', { action: 'reply' })
  f.send('帮我服务对齐一下'); await until(() => f.routers.length === 1)
  expect(f.routers[0].context.experienceSummaries.some((e: any) => e.id === target.id)).toBe(true)
  expect(f.routers[0].context.experienceSummaries.some((e: any) => e.id === unrelated.id)).toBe(false)
})

test('返工不发布旧草稿，新增经验版本跟随同一任务的修正输入传给 Worker', async () => {
  const f = fixture(); const old = f.seed(); const source = f.source()
  const added = f.store.experienceLibrary.save('b', { requestId: 'new-reference', ...draft(), content: { ...content, title: '重启验收', steps: ['核对新进程与连接'] } }, { inboxId: source.id })
  f.store.markInput(source.id, 'routed', { action: 'reply' })
  await startTask(f, [{ experienceId: old.id, version: 1 }]); const taskId = f.store.tasks('b')[0].id
  await finishTask(f, { lesson: { ...draft(), content: { ...content, title: '未通过的旧草稿' } } })
  const refs = [{ experienceId: added.id, version: 1 }]
  await f.routers[1].call('router_decide', routerCall({ action: 'revise', taskId, feedback: '缺少连接状态核对', executionGuidance: '根据重启验收经验补充验证', experienceRefs: refs, replies: [], acceptLesson: false }))
  f.routers[1].finish(); f.workers[0].finish(); await until(() => f.workers.length === 2)
  expect(f.store.tasks('b')).toHaveLength(1)
  expect(f.store.experiences('b')).toHaveLength(2)
  expect(f.store.inputs(taskId).find(i => i.kind === 'correction')?.experienceRefs).toEqual(refs)
  expect(f.workers[1].context.task.experienceRefs).toContainEqual(refs[0])
  const before = f.store.replies('b').filter(r => r.purpose === 'result').length
  await expect(f.workers[1].call('work_finish', { revision: 1, text: '旧版完成', artifactIds: [], checks: ['已核对'], experienceUsage: [{ ...refs[0], status: 'applied', appliedSteps: ['核对新进程与连接'], result: '连接正常' }] })).rejects.toThrow(/版本|新输入/)
  expect(f.store.experienceLibrary.usage('b', added.id)).toHaveLength(0)
  expect(f.store.replies('b').filter(r => r.purpose === 'result')).toHaveLength(before)
})

test('Router 明确更新和停用经验都保留版本，未披露的新版本不能盲改', async () => {
  const f = fixture(); const saved = f.seed()
  f.send('补充部署经验并先停用'); await until(() => f.routers.length === 1)
  const turn = f.routers[0]
  await expect(turn.call('experience_state', { requestId: 'blind', id: saved.id, expectedVersion: 5, state: 'retired', reason: '停用' })).rejects.toThrow(/读取|版本/)
  const update = await turn.call('experience_save', { requestId: 'update', id: saved.id, expectedVersion: 1, ...draft(), content: { ...content, steps: ['更新后的步骤'] }, changeSummary: '补充新做法' })
  expect(update.version).toBe(2)
  const state = await turn.call('experience_state', { requestId: 'retire', id: saved.id, expectedVersion: 2, state: 'retired', reason: '先停用核对' })
  expect(state.version).toBe(3)
  const history = await turn.call('experience_read', { experienceId: saved.id, section: 'history' })
  expect(history.versions.map((v: any) => [v.version, v.state])).toEqual([[1, 'active'], [2, 'active'], [3, 'retired']])
  expect(f.store.experienceLibrary.get('b', saved.id, 1)?.steps).toEqual(content.steps)
  await turn.call('router_decide', routerCall({ action: 'reply', replies: ['已更新并停用。'] })); turn.finish()
})
