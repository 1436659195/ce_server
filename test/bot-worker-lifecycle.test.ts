import { routerCall } from './helpers/router-decision'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotRuntimeService, WORKER_TOOLS, type RuntimeClientOptions } from '../src/cli/bot-runtime/service'
import { silentMemoryClient } from './helpers/model-client'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot, RuntimeTask } from '../src/cli/bot-runtime/types'
import type { BotOperation } from '../src/cli/bot-permissions'
import type { CodexToolCall, CodexTurn } from '../src/cli/bot-runtime/codex'
import * as workerPolicy from '../src/cli/bot-runtime/worker-policy'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const waitFor = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(10); expect(fn()).toBe(true) }
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
interface FixtureOptions {
  workerResultDecisions?: Array<Record<string, unknown>>
  finishBeforeTurnReturn?: boolean
  fullAccess?: boolean
  accessDelayMs?: number
  accessGate?: ReturnType<typeof gate>
  firstWorkerCloseGate?: ReturnType<typeof gate>
  seed?: (store: BotRuntimeStore, bot: RuntimeBot) => void
  runTool?: (tool: string, args: Record<string, unknown>, dir: string) => Promise<string>
  routerReads?: (call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>) => Promise<void>
  resumeIntentMs?: number
  tickMs?: number
  followupQuietMs?: number
  resumeFailure?: string
  directoryApproval?: boolean
}
function fixture(decisions: Array<Record<string, unknown>>, optionsOrDelay: FixtureOptions | number = {}) {
  const options = typeof optionsOrDelay === 'number' ? { accessDelayMs: optionsOrDelay } : optionsOrDelay
  const dir = mkdtempSync(join(tmpdir(), 'ce-worker-life-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'bot-a', name: '助理', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: dir, directory: dir, platform: 'codex', commandSandbox: true, policyRevision: 1, permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'ask', execute: 'ask', commanders: 'members', allowedPhoneIds: [] } }
  if (options.fullAccess) { bot.workerAccessMode = 'full-access'; bot.commandSandbox = false }
  store.saveSettings({ botId: bot.botId, mode: 'router-worker', revision: 1, profile: '', model: '' })
  options.seed?.(store, bot)
  const sent: string[] = []; const actions: string[] = []; const steers: string[] = []; const workerPayloads: string[] = []; const workerThreads: Array<{ method: string; instructions: string; tools?: Array<{ name: string }> }> = []
  let workerOptions: RuntimeClientOptions | undefined; let workerDone: ((v: CodexTurn) => void) | undefined; let started = 0; let calls = 0
  let workerClients = 0; let workerCloses = 0
  const service = new BotRuntimeService({ routerQuietMs: 0, store, rootDir: dir, getBot: () => bot, sendReply: async reply => { sent.push(reply.text) },
    ...(options.directoryApproval ? {
      resolveDirectory: (path: string) => { if (!path.startsWith(dir + '/')) throw new Error('目录超出设备范围'); return path },
      changeDirectory: (_id: string, actor: string, revision: number, path: string) => {
        if (actor !== bot.ownerPhoneId || revision !== bot.policyRevision) throw new Error('权限版本已改变')
        bot.directory = bot.sourceCwd = path; bot.policyRevision++
      },
    } : {}),
    ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}), ...(options.resumeIntentMs !== undefined ? { resumeIntentMs: options.resumeIntentMs } : {}),
    ...(options.followupQuietMs !== undefined ? { followupQuietMs: options.followupQuietMs } : {}),
    checkAccess: async () => {
      if (options.accessDelayMs) await Bun.sleep(options.accessDelayMs)
      if (options.accessGate) await options.accessGate.promise
      return { directory: bot.directory, permissions: bot.permissions, revision: bot.policyRevision }
    },
    openTools: (_bot, _member, authorize) => ({ close() {}, call: async (tool, args) => {
      const operations: Record<string, BotOperation> = { delete_file: 'delete', edit_file: 'edit', create_file: 'create', run_command: 'execute' }
      const operation = operations[tool] ?? 'read'
      await authorize(operation, String(args.path)); actions.push(tool)
      return options.runTool ? options.runTool(tool, args, dir) : '文件内容'
    } }),
    createClient: (role, opts) => {
      if (role === 'memory') return silentMemoryClient()
      if (role === 'worker') workerOptions = opts
      const workerNumber = role === 'worker' ? ++workerClients : 0
      let clientDone: ((v: CodexTurn) => void) | undefined
      const threadId = `thread-${role}`
      return {
        initialize: async () => {}, startThread: async options => { if (role === 'worker') workerThreads.push({ method: 'start', ...options }); return threadId }, resumeThread: async (_id, threadOptions) => { if (role === 'worker') { workerThreads.push({ method: 'resume', ...threadOptions }); if (options.resumeFailure) throw new Error(options.resumeFailure) } return threadId },
        startTurn: async (_threadId, text) => {
          if (role === 'router') {
            const context = JSON.parse(text)
            const decision = context.currentMessages.length ? decisions.shift() : options.workerResultDecisions?.shift() ?? { action: 'reply', replies: [context.workerMessage.text] }
            const call = (tool: string, args: Record<string, unknown> = {}) => opts.onToolCall({ threadId, turnId: 'turn-router', callId: `router-${++calls}`, tool, arguments: args })
            const done = Promise.resolve().then(async () => {
              if (context.currentMessages.length) await options.routerReads?.(call)
              if (decision) await call('router_decide', routerCall({ feasibility: 'can', ...decision, ...(context.workerMessage ? { workerReplyId: context.workerMessage.id, ...(context.currentMessages.length ? { workerReplyIndexes: decision.action === 'answer' ? [] : [0] } : {}) } : {}) }))
              return { id: 'turn-router', status: 'completed' }
            })
            return { threadId, turnId: 'turn-router', done }
          }
          started++
          workerPayloads.push(text)
          if (options.finishBeforeTurnReturn) {
            const task = JSON.parse(text).task
            await opts.onToolCall({ threadId, turnId: 'turn-worker', callId: 'early-finish', tool: 'work_finish', arguments: { revision: task.revision, text: '已完成', artifactIds: [], checks: ['核对'] } })
            return { threadId, turnId: 'turn-worker', done: Promise.resolve({ id: 'turn-worker', status: 'completed' }) }
          }
          return { threadId, turnId: 'turn-worker', done: new Promise<CodexTurn>(r => { workerDone = clientDone = r }) }
        },
        steer: async (_thread, _turn, text) => { steers.push(text); return 'turn-worker' },
        interrupt: async () => { clientDone?.({ id: 'turn-worker', status: 'interrupted' }) },
        close: async () => {
          if (role === 'worker') {
            workerCloses++; clientDone?.({ id: 'turn-worker', status: 'interrupted' })
            if (workerNumber === 1) await options.firstWorkerCloseGate?.promise
          }
        },
      }
    },
  })
  cleanups.push(async () => {
    options.firstWorkerCloseGate?.release(); options.accessGate?.release()
    await service.close()
    await Promise.resolve()
    store.close(); rmSync(dir, { recursive: true, force: true })
  })
  const send = (seq: number, text: string, senderId = 'owner') => service.receive(bot.botId, { groupId: 'dm', seq, text, senderId, memberId: 'member-owner', createdAt: Date.now() })
  const workerCall = (tool: string, args: Record<string, unknown> = {}) => workerOptions!.onToolCall({ threadId: 'thread-worker', turnId: 'turn-worker', callId: `worker-${++calls}`, tool, arguments: args } satisfies CodexToolCall)
  return { store, service, bot, dir, send, sent, steers, actions, workerPayloads, workerThreads, workerCall, get workerOptions() { return workerOptions }, started: () => started, workerCloses: () => workerCloses, complete: () => workerDone?.({ id: 'turn-worker', status: 'completed' }) }
}
const start = { action: 'start', delivery: 'chat', replyText: '我先看现有材料。', newCase: { title: '论文 A', object: '论文 A', goal: '解读' }, goal: '写报告', acceptance: ['交付报告'], allowedOps: ['read', 'create', 'edit', 'delete'], exclusions: [] }

test('CLI 升级后原 Session 恢复失败，保留卷宗且不自动新开重跑', async () => {
  const decisions:Array<Record<string,unknown>>=[start]
  const f=fixture(decisions,{resumeFailure:'Codex thread/resume 接口不兼容'})
  f.send(1,'整理材料');await waitFor(()=>f.started()===1)
  const first=f.store.tasks(f.bot.botId)[0]
  await f.workerCall('work_finish',{revision:first.revision,text:'材料已整理',artifactIds:[],checks:['核对']})
  f.complete();await waitFor(()=>f.workerCloses()===1)
  const originalThread=f.store.case(first.caseId)!.threadId
  decisions.push({...start,newCase:undefined,caseId:first.caseId,relation:'revision'})
  f.send(2,'继续修订');await waitFor(()=>f.store.tasks(f.bot.botId)[1]?.state==='failed')
  expect(f.workerThreads.map(t=>t.method)).toEqual(['start','resume'])
  expect(f.started()).toBe(1)
  expect(f.store.cases(f.bot.botId)).toHaveLength(1)
  expect(f.store.case(first.caseId)!.threadId).toBe(originalThread)
  expect(f.store.tasks(f.bot.botId)[1].sessionOrigin).toBeUndefined()
})

for (const fullAccess of [false, true]) test(`工具参数升级后在原卷宗新开会话并完成文件交付，契约未变时继续复用（${fullAccess ? '全权限' : '受控'}）`, async () => {
  const finish = WORKER_TOOLS.find(t => t.name === 'work_finish')!
  const currentSchema = finish.inputSchema
  const oldSchema = structuredClone(currentSchema)
  delete (oldSchema.properties as Record<string, unknown>).artifactSummaries
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { fullAccess, runTool: async (_tool, args, dir) => JSON.stringify({ name: 'report.txt', data: readFileSync(join(dir, String(args.path))).toString('base64') }) })
  try {
    finish.inputSchema = oldSchema
    f.send(1, '整理材料'); await waitFor(() => f.started() === 1)
    const first = f.store.tasks()[0]
    await f.workerCall('work_finish', { revision: 1, text: '材料整理完成', artifactIds: [], checks: ['核对材料'] })
    f.complete(); await waitFor(() => f.workerCloses() === 1)

    finish.inputSchema = currentSchema
    decisions.push({ ...start, newCase: undefined, caseId: first.caseId, relation: 'revision', delivery: 'files' })
    f.send(2, '将已有结论保存为TXT附件'); await waitFor(() => f.started() === 2)
    const second = f.store.tasks()[1]
    expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
    expect(second).toMatchObject({ caseId: first.caseId, sessionOrigin: 'new' })
    expect(f.store.cases(f.bot.botId)).toHaveLength(1)
    expect(JSON.parse(f.workerPayloads[1]).caseContext.previousTasks).toMatchObject([{ id: first.id, summary: '材料整理完成' }])

    writeFileSync(join(f.dir, 'report.txt'), '已核实的材料结论')
    const op = await f.workerCall('project_export_file', { path: 'report.txt' }) as { operationId: string }
    await waitFor(() => f.store.operation(op.operationId)?.state === 'completed')
    const poll = await f.workerCall('project_poll', { operationId: op.operationId }) as { result: string }
    const { artifactId } = JSON.parse(poll.result)
    await f.workerCall('work_finish', { revision: 1, text: '请看附件。', artifactIds: [artifactId], checks: ['读取核对'], artifactSummaries: [{ artifactId, summary: '材料结论TXT', requirements: ['交付报告'], checks: ['读取核对'], limitations: [] }] })
    f.complete(); await waitFor(() => f.workerCloses() === 2 && f.sent.includes('请看附件。'))
    const reply = f.store.replies(f.bot.botId).find(r => r.author === 'router' && r.artifactIds?.includes(artifactId))!
    expect(reply.state).toBe('sent')
    expect(f.service.replyAttachments(reply)).toMatchObject([{ kind: 'artifact', name: 'report.txt' }])
    expect(readFileSync(f.store.artifact(artifactId)!.path, 'utf8')).toBe('已核实的材料结论')

    decisions.push({ ...start, newCase: undefined, caseId: first.caseId, relation: 'revision' })
    f.send(3, '继续核对结论'); await waitFor(() => f.started() === 3)
    expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start', 'resume'])
  } finally { finish.inputSchema = currentSchema }
})

test('没有工具契约指纹的旧版持久会话保留卷宗并新开Session', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions)
  f.send(1, '整理材料'); await waitFor(() => f.started() === 1)
  const first = f.store.tasks()[0]
  await f.workerCall('work_finish', { revision: 1, text: '材料整理完成', artifactIds: [], checks: ['核对'] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  const legacy = createHash('sha256').update(JSON.stringify({ owner: f.bot.ownerPhoneId, directory: f.bot.directory, policy: f.bot.policyRevision, model: '', schema: 2 })).digest('hex')
  f.store.saveCase({ ...f.store.case(first.caseId)!, fingerprint: legacy })
  decisions.push({ ...start, newCase: undefined, caseId: first.caseId, relation: 'revision' })
  f.send(2, '继续核对'); await waitFor(() => f.started() === 2)
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
  expect(f.store.cases(f.bot.botId)).toHaveLength(1)
  expect(JSON.parse(f.workerPayloads[1]).caseContext.previousTasks[0].id).toBe(first.id)
})

test('工具描述变化也使旧会话失效，不仅比较工具名称', async () => {
  const report = WORKER_TOOLS.find(t => t.name === 'work_report')!
  const description = report.description
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions)
  f.send(1, '整理材料'); await waitFor(() => f.started() === 1)
  const first = f.store.tasks()[0]
  await f.workerCall('work_finish', { revision: 1, text: '材料整理完成', artifactIds: [], checks: ['核对'] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  try {
    report.description += ' 新规则：报告须标出尚未验证的事实。'
    decisions.push({ ...start, newCase: undefined, caseId: first.caseId, relation: 'revision' })
    f.send(2, '继续核对'); await waitFor(() => f.started() === 2)
    expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
  } finally { report.description = description }
})

test('只有固定执行规则变化时也不续接旧会话', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { fullAccess: true })
  f.send(1, '整理材料'); await waitFor(() => f.started() === 1)
  const first = f.store.tasks()[0]
  await f.workerCall('work_finish', { revision: 1, text: '材料整理完成', artifactIds: [], checks: ['核对'] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  const policy = workerPolicy.workerExecutionPolicy(f.bot.directory)
  const changed = spyOn(workerPolicy, 'workerExecutionPolicy').mockReturnValue({ ...policy, instructions: policy.instructions + '\n新增宿主固定执行规则。' })
  try {
    decisions.push({ ...start, newCase: undefined, caseId: first.caseId, relation: 'revision' })
    f.send(2, '继续核对'); await waitFor(() => f.started() === 2)
    expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
    expect(f.workerThreads[1].instructions).toContain('新增宿主固定执行规则。')
  } finally { changed.mockRestore() }
})

test('挂载其他电脑改变工具和执行规则时在原卷宗新开会话', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { fullAccess: true })
  f.send(1, '整理材料'); await waitFor(() => f.started() === 1)
  const first = f.store.tasks()[0]
  await f.workerCall('work_finish', { revision: 1, text: '材料整理完成', artifactIds: [], checks: ['核对'] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  f.bot.computers = [{ id: 'remote', label: '其他电脑', directory: '/project', directoryAbs: '/project' }]
  decisions.push({ ...start, newCase: undefined, caseId: first.caseId, relation: 'revision' })
  f.send(2, '继续核对'); await waitFor(() => f.started() === 2)
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
  expect(f.workerThreads[1].tools?.some(t => t.name === 'remote_run')).toBe(true)
  expect(f.workerThreads[1].instructions).not.toBe(f.workerThreads[0].instructions)
})

test('执行平台切换时不把旧平台线程交给新平台恢复', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions)
  f.send(1, '整理材料'); await waitFor(() => f.started() === 1)
  const first = f.store.tasks()[0]
  await f.workerCall('work_finish', { revision: 1, text: '材料整理完成', artifactIds: [], checks: ['核对'] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  f.bot.platform = 'claude'
  decisions.push({ ...start, newCase: undefined, caseId: first.caseId, relation: 'revision' })
  f.send(2, '继续核对'); await waitFor(() => f.started() === 2)
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
})

test('换目录保护待派工与执行中任务，完成后同卷宗在新目录新开Session', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { fullAccess: true })
  expect(() => f.service.assertDirectoryChangeAllowed(f.bot.botId)).not.toThrow()
  f.send(1, '写报告')
  expect(() => f.service.assertDirectoryChangeAllowed(f.bot.botId)).toThrow(/任务|处理/)
  await waitFor(() => f.started() === 1)
  expect(() => f.service.assertDirectoryChangeAllowed(f.bot.botId)).toThrow(/任务|处理/)
  const first = f.store.tasks(f.bot.botId)[0]
  await f.workerCall('work_finish', { revision: first.revision, text: '报告完成', artifactIds: [], checks: ['核对'] }); f.complete()
  await waitFor(() => { try { f.service.assertDirectoryChangeAllowed(f.bot.botId); return true } catch { return false } })
  const next = join(f.dir, 'next'); mkdirSync(next); f.bot.directory = f.bot.sourceCwd = next; f.bot.policyRevision++
  await f.service.policyChanged(f.bot.botId)
  decisions.push({ ...start, newCase: undefined, caseId: first.caseId, relation: 'revision', goal: '在新目录修订报告' })
  f.send(2, '继续修订报告'); await waitFor(() => f.started() === 2)
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
  expect(f.workerOptions?.cwd).toBe(next)
  expect(f.store.tasks(f.bot.botId)[1]).toMatchObject({ caseId: first.caseId, sessionOrigin: 'new', mandate: { directory: next, policyRevision: 2 } })
  expect(JSON.parse(f.workerPayloads[1]).caseContext.previousTasks[0].id).toBe(first.id)
})

test('未知的旧执行必须核对后才能换目录', () => {
  const f = fixture([], { seed: (store, bot) => {
    const task = seedTask(store, bot)
    store.updateTask(task.id, { state: 'failed' })
    store.saveRun({ id: 'old-run', botId: bot.botId, taskId: task.id, state: 'unknown', createdAt: 1, updatedAt: 1 })
  } })
  expect(() => f.service.assertDirectoryChangeAllowed(f.bot.botId)).toThrow(/核对/)
})

test('目录阻塞后停止、换目录、聊天继续：原工单按新目录授权并新开 Session', async () => {
  const decisions: Array<Record<string, unknown>> = [{ ...start, goal: '优化后端；当前只能在旧目录写入', exclusions: ['不发布'] }]
  const f = fixture(decisions, { fullAccess: true })
  f.send(1, '按方案实施'); await waitFor(() => f.started() === 1)
  const original = f.store.tasks(f.bot.botId)[0]
  await f.workerCall('work_report', { summary: '已定位后端五项改造位置，尚未改代码' })
  await f.workerCall('work_ask_user', { text: '需要修改相邻后端，请调整工作目录后继续', options: [] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  await f.service.control(f.bot.botId, 'owner', { action: 'stop', taskId: original.id, expectedRevision: 1, requestId: 'stop-before-directory' })
  f.service.assertDirectoryChangeAllowed(f.bot.botId)
  const next = join(f.dir, 'next'); mkdirSync(next)
  f.bot.directory = f.bot.sourceCwd = next; f.bot.policyRevision++
  await f.service.policyChanged(f.bot.botId)
  expect(f.started()).toBe(1) // 改设置本身不派工。
  decisions.push({ action: 'resume', taskId: original.id, replyText: '按新目录继续原任务。' })
  const confirmation = f.send(2, '工作目录已经改了，继续吧')
  await waitFor(() => f.started() === 2)
  const current = f.store.task(original.id)!
  expect(f.store.tasks(f.bot.botId)).toHaveLength(1)
  expect(f.store.cases(f.bot.botId)).toHaveLength(1)
  expect(current).toMatchObject({ caseId: original.caseId, goal: original.goal, acceptance: original.acceptance, revision: 2,
    mandate: { directory: next, policyRevision: 2, exclusions: ['不发布'] }, sessionOrigin: 'new' })
  expect(current.question).toBeUndefined()
  expect(f.workerOptions?.cwd).toBe(next)
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
  const payload = JSON.parse(f.workerPayloads[1])
  expect(payload.directoryContinuation).toMatchObject({ fromDirectory: f.dir, toDirectory: next, requestId: confirmation.id, confirmationText: '工作目录已经改了，继续吧' })
  expect(payload.task.summary).toBe('已定位后端五项改造位置，尚未改代码')
  expect(payload.executionPolicy.directory).toBe(next)
  await f.service.control(f.bot.botId, 'owner', { action: 'resume', taskId: original.id, expectedRevision: 1, requestId: confirmation.id })
  expect(f.started()).toBe(2) // 同一确认重传不重复执行。
  await f.service.control(f.bot.botId, 'owner', { action: 'stop', taskId: original.id, expectedRevision: 2, requestId: 'stop-again' })
  await f.service.control(f.bot.botId, 'owner', { action: 'resume', taskId: original.id, expectedRevision: 2, requestId: 'resume-again' })
  await waitFor(() => f.started() === 3)
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start', 'resume'])
})

test('换目录继续仍拒绝未知执行、未结束操作、不同 owner 及执行模式降级', async () => {
  const f = fixture([start], { fullAccess: true })
  f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  await f.service.control(f.bot.botId, 'owner', { action: 'stop', taskId: task.id, expectedRevision: 1, requestId: 'stop' })
  f.bot.directory = join(f.dir, 'new'); mkdirSync(f.bot.directory); f.bot.policyRevision++
  const request = { action: 'resume' as const, taskId: task.id, expectedRevision: 1, requestId: 'resume-new' }
  await expect(f.service.control(f.bot.botId, 'stranger', request)).rejects.toThrow(/owner/)
  f.bot.ownerPhoneId = 'new-owner'
  await expect(f.service.control(f.bot.botId, 'new-owner', request)).rejects.toThrow(/授权|owner/)
  f.bot.ownerPhoneId = 'owner'; f.bot.workerAccessMode = undefined
  await expect(f.service.control(f.bot.botId, 'owner', request)).rejects.toThrow(/授权/)
  f.bot.workerAccessMode = 'full-access'
  const run = f.store.runs()[0]; f.store.saveRun({ ...run, state: 'unknown' })
  await expect(f.service.control(f.bot.botId, 'owner', request)).rejects.toThrow(/核对/)
  f.store.saveRun({ ...run, state: 'exited' })
  f.store.saveOperation({ id: 'pending-old', botId: f.bot.botId, taskId: task.id, runId: run.id, callId: 'old-op', tool: 'edit_file', arguments: {}, operation: 'edit', policyRevision: 1, state: 'approved', createdAt: Date.now() })
  await expect(f.service.control(f.bot.botId, 'owner', request)).rejects.toThrow(/核对|结束/)
  expect(f.store.task(task.id)?.mandate.policyRevision).toBe(1)
  expect(f.started()).toBe(1)
})

test('只改权限版本但目录未变，继续不能自动更新旧授权', async () => {
  const f = fixture([start], { fullAccess: true })
  f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  await f.service.control(f.bot.botId, 'owner', { action: 'stop', taskId: task.id, expectedRevision: 1, requestId: 'stop' })
  f.bot.policyRevision++
  await expect(f.service.control(f.bot.botId, 'owner', { action: 'resume', taskId: task.id, expectedRevision: 1, requestId: 'resume' })).rejects.toThrow(/授权/)
  expect(f.started()).toBe(1)
})

for (const viaChat of [false, true]) test(`具体目录申请${viaChat ? '口头同意' : '卡片确认'}后自动换目录并继续，重复确认不重复派工`, async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { fullAccess: true, directoryApproval: true })
  const next = join(f.dir, 'expanded'); mkdirSync(next)
  f.send(1, '修改后端'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  await f.workerCall('work_ask_user', { text: '需要在后端修改文件，请确认新目录', directory: next })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  const question = f.store.task(task.id)!.question!
  expect(question.directoryChange).toEqual({ fromDirectory: f.dir, toDirectory: next, policyRevision: 1 })
  expect(f.bot.directory).toBe(f.dir)
  expect(f.service.view(f.bot.botId, 'owner').capabilities.directoryApproval).toBe(true)
  const request = { action: 'approve_directory' as const, taskId: task.id, expectedRevision: 1, questionId: question.id, requestId: 'approve-card' }
  await expect(f.service.control(f.bot.botId, 'stranger', request)).rejects.toThrow(/owner/)
  await expect(f.service.control(f.bot.botId, 'owner', { ...request, questionId: 'stale-question' })).rejects.toThrow(/问题/)
  if (viaChat) {
    decisions.push({ action: 'approve_directory', taskId: task.id, replyText: '已确认目录，继续。' })
    const input = f.send(2, '同意，继续'); request.requestId = input.id
  } else await f.service.control(f.bot.botId, 'owner', request)
  await waitFor(() => f.started() === 2)
  expect(f.bot.directory).toBe(next)
  expect(f.store.task(task.id)).toMatchObject({ revision: 2, state: 'running', mandate: { directory: next, policyRevision: 2 } })
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
  expect(f.store.tasks()).toHaveLength(1)
  await f.service.control(f.bot.botId, 'owner', request)
  expect(f.started()).toBe(2)
})

test('目录申请只允许阻塞问题；撤回与过期确认都不能修改目录', async () => {
  const f = fixture([start], { fullAccess: true, directoryApproval: true })
  f.send(1, '修改后端'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]; const next = join(f.dir, 'new'); mkdirSync(next)
  await expect(f.workerCall('work_ask_user', { text: '换目录', directory: next, blocks: false })).rejects.toThrow(/阻塞/)
  await expect(f.workerCall('work_ask_user', { text: '换目录', directory: '/elsewhere' })).rejects.toThrow(/范围/)
  await f.workerCall('work_ask_user', { text: '换目录', directory: next })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  const question = f.store.task(task.id)!.question!
  f.bot.policyRevision++
  await expect(f.service.control(f.bot.botId, 'owner', { action: 'approve_directory', taskId: task.id, expectedRevision: 1, questionId: question.id, requestId: 'old-approval' })).rejects.toThrow(/版本|失效/)
  expect(f.bot.directory).toBe(f.dir)
  expect(f.started()).toBe(1)
})

test('目录确认等待旧 Worker 退出时，主人停止会取消在途确认', async () => {
  const closing = gate()
  const f = fixture([start], { fullAccess: true, directoryApproval: true, firstWorkerCloseGate: closing })
  f.send(1, '修改后端'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]; const next = join(f.dir, 'new'); mkdirSync(next)
  await f.workerCall('work_ask_user', { text: '换目录', directory: next }); f.complete()
  await waitFor(() => f.workerCloses() === 1)
  const question = f.store.task(task.id)!.question!
  const approving = f.service.control(f.bot.botId, 'owner', { action: 'approve_directory', taskId: task.id, expectedRevision: 1, questionId: question.id, requestId: 'approve' })
  const outcome = approving.then(() => undefined, error => error as Error)
  await waitFor(() => f.store.task(task.id)?.state === 'stopping')
  const stopping = f.service.control(f.bot.botId, 'owner', { action: 'stop', taskId: task.id, expectedRevision: 1, requestId: 'cancel-approval' })
  closing.release(); await stopping
  expect((await outcome)?.message).toMatch(/取消|停止/)
  expect(f.bot.directory).toBe(f.dir)
  expect(f.store.task(task.id)?.state).toBe('stopped')
  expect(f.started()).toBe(1)
})

test('其他工单的未知操作未核对时，不可通过目录确认绕过', async () => {
  const f = fixture([start], { fullAccess: true, directoryApproval: true })
  f.send(1, '修改后端'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]; const next = join(f.dir, 'new'); mkdirSync(next)
  await f.workerCall('work_ask_user', { text: '换目录', directory: next }); f.complete()
  await waitFor(() => f.workerCloses() === 1)
  f.store.saveOperation({ id: 'other-unknown', botId: f.bot.botId, taskId: 'older-task', runId: 'older-run', callId: 'old-call', tool: 'edit_file', arguments: {}, operation: 'edit', policyRevision: 1, state: 'unknown', createdAt: 1 })
  await expect(f.service.control(f.bot.botId, 'owner', { action: 'approve_directory', taskId: task.id, expectedRevision: 1, questionId: f.store.task(task.id)!.question!.id, requestId: 'approve' })).rejects.toThrow(/核对/)
  expect(f.bot.directory).toBe(f.dir)
})

test('换目录的新 Session 保留已处理补充和整批确认中的新限制', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { fullAccess: true, directoryApproval: true })
  f.send(1, '修改后端'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  decisions.push({ action: 'append', taskId: task.id, replyText: '记下了。' })
  f.send(2, '不得删除任何现有文件')
  await waitFor(() => f.store.inputs(task.id).length === 1)
  const prior = f.store.inputs(task.id)[0]
  await f.workerCall('work_consume_input', { inputId: prior.id })
  await f.workerCall('work_report', { summary: '已定位修改位置', resolutions: [{ inputId: prior.id, resolution: '已核对要求' }] })
  const next = join(f.dir, 'new'); mkdirSync(next)
  await f.workerCall('work_ask_user', { text: '需要换目录', directory: next }); f.complete()
  await waitFor(() => f.workerCloses() === 1)
  decisions.push({ action: 'approve_directory', taskId: task.id, replyText: '按你确认的范围继续。' })
  f.send(3, '只修改 service.ts，不许改 store.ts')
  f.send(4, '同意目录，继续吧')
  await waitFor(() => f.started() === 2)
  const payload = JSON.parse(f.workerPayloads[1])
  expect(payload.directoryContinuation.confirmationText).toContain('不许改 store.ts')
  expect(payload.directoryContinuation.previousInputs).toContainEqual(expect.objectContaining({ text: '不得删除任何现有文件' }))
  expect(payload.pendingInputs).toContainEqual(expect.objectContaining({ text: '只修改 service.ts，不许改 store.ts\n同意目录，继续吧' }))
  expect(f.store.inputs(task.id)).toHaveLength(2)
})

test('撤回等待中的口头确认，不能先改目录再发现原话失效', async () => {
  const closing = gate()
  const f = fixture([start], { fullAccess: true, directoryApproval: true, firstWorkerCloseGate: closing })
  f.send(1, '修改后端'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]; const next = join(f.dir, 'new'); mkdirSync(next)
  await f.workerCall('work_ask_user', { text: '换目录', directory: next }); f.complete()
  await waitFor(() => f.workerCloses() === 1)
  const input = f.store.receive({ botId: f.bot.botId, groupId: 'dm', senderId: 'owner', memberId: 'member-owner', seq: 2, text: '同意，继续', createdAt: Date.now() })
  const outcome = f.service.control(f.bot.botId, 'owner', { action: 'approve_directory', taskId: task.id, expectedRevision: 1, questionId: f.store.task(task.id)!.question!.id, requestId: input.id }, [input.id]).then(() => undefined, error => error as Error)
  await waitFor(() => f.store.task(task.id)?.state === 'stopping')
  f.store.revokeInbox(input.id, Date.now()); closing.release()
  expect((await outcome)?.message).toMatch(/失效/)
  expect(f.bot.directory).toBe(f.dir)
  expect(f.started()).toBe(1)
})

test('等待目录确认时新聊天指令保留并使在途确认失效', async () => {
  const closing = gate()
  const f = fixture([start], { fullAccess: true, directoryApproval: true, firstWorkerCloseGate: closing })
  f.send(1, '修改后端'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]; const next = join(f.dir, 'new'); mkdirSync(next)
  await f.workerCall('work_ask_user', { text: '换目录', directory: next }); f.complete()
  await waitFor(() => f.workerCloses() === 1)
  const outcome = f.service.control(f.bot.botId, 'owner', { action: 'approve_directory', taskId: task.id, expectedRevision: 1, questionId: f.store.task(task.id)!.question!.id, requestId: 'approve' }).then(() => undefined, error => error as Error)
  await waitFor(() => f.store.task(task.id)?.state === 'stopping')
  const changedMind = f.send(2, '先别改目录，停下来')
  expect(f.store.inbox(changedMind.id)?.state).toBe('pending')
  closing.release()
  expect((await outcome)?.message).toMatch(/取消/)
  expect(f.bot.directory).toBe(f.dir)
})

test('Worker 在 startTurn 返回前完成，仍保存真实 Session 来源和 turnId', async () => {
  const f = fixture([start], { finishBeforeTurnReturn: true })
  f.send(1, '检查材料')
  await waitFor(() => f.store.tasks(f.bot.botId)[0]?.state === 'completed' && f.workerCloses() === 1)
  expect(f.store.tasks(f.bot.botId)[0].sessionOrigin).toBe('new')
  expect(f.store.runs(f.bot.botId)[0].turnId).toBe('turn-worker')
})

test('项目总结→设计对比→修改另存：一个卷宗，读写工单独立授权并续接同一 Session', async () => {
  const decisions: Array<Record<string, unknown>> = [{ ...start, newCase: { title: '项目文档总结', object: '示例项目及文档', goal: '梳理项目实现' }, goal: '总结项目', allowedOps: ['read'] }]
  const f = fixture(decisions, { runTool: async (tool, args, dir) => {
    if (tool === 'create_file') writeFileSync(join(dir, String(args.path)), String(args.content))
    return '操作完成'
  } })
  writeFileSync(join(f.dir, 'design.md'), '原始设计')
  f.send(1, '根据项目写总结文档'); await waitFor(() => f.started() === 1)
  const first = f.store.tasks(f.bot.botId)[0]
  await expect(f.workerCall('project_create_file', { path: 'forbidden.md', content: 'x' })).rejects.toThrow(/授权/)
  await f.workerCall('work_finish', { revision: first.revision, text: '总结已完成', artifactIds: [], checks: ['检查实现'] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  decisions.push({ ...start, newCase: undefined, caseId: first.caseId, goal: '核对设计差异', allowedOps: ['read'], relation: 'follow_up' })
  f.send(2, '这个文档和设计文档哪里不一致'); await waitFor(() => f.started() === 2)
  const second = f.store.tasks(f.bot.botId)[1]
  await f.workerCall('work_finish', { revision: second.revision, text: '差异已核对', artifactIds: [], checks: ['比较设计'] })
  f.complete(); await waitFor(() => f.workerCloses() === 2)
  decisions.push({ ...start, newCase: undefined, caseId: first.caseId, goal: '修改并另存最新设计', allowedOps: ['read', 'create'], relation: 'revision', caseUpdate: { title: '项目文档梳理与设计修订', goal: '整理项目总结、核对设计差异，并修订设计文档' } })
  f.send(3, '不一致的地方修改下文档，另存最新设计文档'); await waitFor(() => f.started() === 3)
  const third = f.store.tasks(f.bot.botId)[2]
  const operation = await f.workerCall('project_create_file', { path: 'design-latest.md', content: '已修订的新设计' }) as { operationId: string }
  await waitFor(() => f.store.operation(operation.operationId)?.state === 'completed')
  expect(readFileSync(join(f.dir, 'design.md'), 'utf8')).toBe('原始设计')
  expect(readFileSync(join(f.dir, 'design-latest.md'), 'utf8')).toBe('已修订的新设计')
  expect(f.store.cases(f.bot.botId)).toHaveLength(1)
  expect(f.store.tasks(f.bot.botId).map(t => t.caseId)).toEqual([first.caseId, first.caseId, first.caseId])
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'resume', 'resume'])
  expect(third.sessionOrigin).toBe('inherited')
  expect(third.sessionReason).toContain('续接')
  expect(f.store.case(first.caseId)).toMatchObject({ title: '项目文档梳理与设计修订', aliases: ['项目文档总结'] })
  const payload = JSON.parse(f.workerPayloads[2])
  expect(payload.caseContext.goal).toContain('核对设计差异')
  expect(payload.caseContext.previousTasks.map((t: { id: string }) => t.id)).toEqual([first.id, second.id])
  expect(payload.instruction).toContain('当前工单')
})

test('配置变化只换 Session，同卷宗旧成果仍可读取且不能读取其他卷宗成果', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions)
  f.send(1, '整理材料'); await waitFor(() => f.started() === 1)
  const first = f.store.tasks(f.bot.botId)[0]
  const bytes = Buffer.from('前序交付的重要事实')
  const file = join(f.dir, 'snapshot.txt'); writeFileSync(file, bytes)
  const artifact = { id: 'prior-result', botId: f.bot.botId, caseId: first.caseId, taskId: first.id, title: '旧成果', name: 'report.txt', mime: 'text/plain', path: file, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), revision: 1, createdAt: Date.now() }
  f.store.saveArtifact(artifact)
  await f.workerCall('work_finish', { revision: first.revision, text: '材料已整理', artifactIds: [artifact.id], artifactSummaries: [{ artifactId: artifact.id, summary: '材料原文', requirements: ['保留材料'], checks: ['核对'], limitations: [] }], checks: ['核对'] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  f.store.saveSettings({ ...f.store.settings(f.bot.botId), model: 'changed-model' })
  f.store.saveArtifact({ ...artifact, id: 'foreign-result', caseId: 'other-case' })
  decisions.push({ ...start, newCase: undefined, caseId: first.caseId })
  f.send(2, '继续修订'); await waitFor(() => f.started() === 2)
  const next = f.store.tasks(f.bot.botId)[1]
  expect(next.caseId).toBe(first.caseId)
  expect(f.workerThreads.map(t => t.method)).toEqual(['start', 'start'])
  expect(next.sessionReason).toContain('配置已变化')
  expect(JSON.parse(f.workerPayloads[1]).availableAttachments).toContainEqual(expect.objectContaining({ id: artifact.id, kind: 'artifact' }))
  expect(await f.workerCall('work_read_attachment', { attachmentId: artifact.id })).toMatchObject({ text: '前序交付的重要事实' })
  await expect(f.workerCall('work_read_attachment', { attachmentId: 'foreign-result' })).rejects.toThrow(/卷宗/)
})

test('全权限工单持久化软隔离约束，在原目录启动，追加和续接均重申约束', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { fullAccess: true })
  f.send(1, '检查项目'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks(f.bot.botId)[0]
  expect(f.workerOptions).toMatchObject({ cwd: f.dir, accessMode: 'full-access' })
  expect(task.mandate).toMatchObject({ executionMode: 'full-access', directoryIsolation: 'soft', directory: f.dir })
  expect(task.mandate.safetyInstructions).toContain('不要更改工作目录之外的任何文件')
  expect(task.mandate.safetyInstructions).toContain('不得破坏系统')
  expect(task.mandate.allowedOps).toContain('execute')
  expect(f.workerThreads[0].instructions).toContain(f.dir)
  expect(f.workerThreads[0].tools?.map(t => t.name)).not.toContain('project_read_file')
  decisions.push({ action: 'append', taskId: task.id, replyText: '可以一起处理。' })
  f.send(2, '补充一份说明'); await waitFor(() => f.steers.length === 1)
  expect(JSON.parse(f.steers[0]).executionPolicy.instructions).toContain('不要更改工作目录之外的任何文件')
  const input = f.store.inputs(task.id)[0]
  await f.workerCall('work_consume_input', { inputId: input.id })
  await f.workerCall('work_report', { summary: '已检查', resolutions: [{ inputId: input.id, resolution: '已补充' }] })
  await f.workerCall('work_finish', { revision: f.store.task(task.id)!.revision, text: '检查完成', artifactIds: [], checks: ['本地核对'] })
  f.complete(); await waitFor(() => f.workerCloses() === 1)
  decisions.push({ ...start, newCase: undefined, caseId: task.caseId })
  f.send(3, '继续补充说明'); await waitFor(() => f.started() === 2)
  expect(f.workerThreads[1].method).toBe('resume')
  expect(f.workerThreads[1].instructions).toContain('不要更改工作目录之外的任何文件')
})

test('全权限 Worker 获得已接收二进制附件的只读本地路径，可交给原生解析工具', async () => {
  const f = fixture([start], { fullAccess: true })
  const bytes = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(240000)])
  const begun = f.service.upload(f.bot.botId, 'owner', { action: 'begin', requestId: 'binary-input', name: 'sample.docx', size: bytes.length, mime: '' }) as { id: string }
  f.service.upload(f.bot.botId, 'owner', { action: 'chunk', uploadId: begun.id, offset: 0, data: bytes.toString('base64') })
  const attachment = f.service.upload(f.bot.botId, 'owner', { action: 'finish', uploadId: begun.id, hash: createHash('sha256').update(bytes).digest('hex') }) as any
  f.service.receive(f.bot.botId, { groupId: 'dm', seq: 1, senderId: 'owner', memberId: 'member-owner', text: '读取文档', attachments: [attachment], createdAt: Date.now() })
  await waitFor(() => f.started() === 1)
  const result = await f.workerCall('work_read_attachment', { attachmentId: attachment.id }) as { localPath: string; instruction: string }
  expect(readFileSync(result.localPath)).toEqual(bytes)
  expect(result.instruction).toContain('只读')
})

test('上传材料进入 Worker 原消息与活动补充，读取图片返回多模态内容而非 base64 文本', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions)
  const upload = (name: string, bytes: Buffer) => {
    const begun = f.service.upload(f.bot.botId, 'owner', { action: 'begin', requestId: crypto.randomUUID(), name, size: bytes.length, mime: '' }) as { id: string }
    f.service.upload(f.bot.botId, 'owner', { action: 'chunk', uploadId: begun.id, offset: 0, data: bytes.toString('base64') })
    return f.service.upload(f.bot.botId, 'owner', { action: 'finish', uploadId: begun.id, hash: createHash('sha256').update(bytes).digest('hex') }) as any
  }
  const text = upload('brief.txt', Buffer.from('重点分析成本'))
  f.service.receive(f.bot.botId, { groupId: 'dm', seq: 1, senderId: 'owner', memberId: 'member-owner', text: '根据附件写报告', attachments: [text], createdAt: Date.now() })
  await waitFor(() => f.started() === 1)
  expect(JSON.parse(f.workerPayloads[0]).originalMessage.attachments[0].id).toBe(text.id)
  expect(await f.workerCall('work_read_attachment', { attachmentId: text.id })).toMatchObject({ text: '重点分析成本', eof: true })
  const unrelated = upload('other.txt', Buffer.from('未发送的文件'))
  await expect(f.workerCall('work_read_attachment', { attachmentId: unrelated.id })).rejects.toThrow('卷宗')
  const png = upload('图.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64'))
  const task = f.store.tasks()[0]
  decisions.push({ action: 'append', taskId: task.id, expectedRevision: 1, replyText: '我会结合这张图。' })
  f.service.receive(f.bot.botId, { groupId: 'dm', seq: 2, senderId: 'owner', memberId: 'member-owner', text: '再参考图片', attachments: [png], createdAt: Date.now() })
  await waitFor(() => f.steers.length === 1)
  expect(JSON.parse(f.steers[0]).input.attachments[0].id).toBe(png.id)
  const image = await f.workerCall('work_read_attachment', { attachmentId: png.id }) as any
  expect(image.contentItems[1]).toMatchObject({ type: 'inputImage', imageUrl: expect.stringContaining('data:image/png;base64,') })
  const forwarded = await f.workerCall('work_publish_attachment', { attachmentId: png.id }) as { artifactId: string }
  expect(f.store.artifact(forwarded.artifactId)).toMatchObject({ name: '图.png', mime: 'image/png', hash: png.hash })
})

test('项目导出生成真实成果快照，finish 不得省略已经准备好的附件', async () => {
  const f = fixture([start], { runTool: async () => JSON.stringify({ name: 'report.html', data: Buffer.from('<h1>实际报告</h1>').toString('base64') }) })
  f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const op = await f.workerCall('project_export_file', { path: 'report.html' }) as { operationId: string }
  await waitFor(() => f.store.operation(op.operationId)?.state === 'completed')
  const poll = await f.workerCall('project_poll', { operationId: op.operationId }) as { result: string }
  const artifact = JSON.parse(poll.result)
  expect(artifact.name).toBe('report.html')
  expect(poll.result).not.toContain(Buffer.from('<h1>实际报告</h1>').toString('base64'))
  const task = f.store.tasks()[0]
  await expect(f.workerCall('work_finish', { revision: task.revision, text: '报告写好了。', artifactIds: [], checks: ['读取核对'] })).rejects.toThrow('附件')
  await f.workerCall('work_finish', { revision: task.revision, text: '报告在附件里。', artifactIds: [artifact.artifactId], artifactSummaries: [{ artifactId: artifact.artifactId, summary: '报告文件', requirements: ['分析材料'], checks: ['读取核对'], limitations: [] }], checks: ['读取核对'] })
  expect(f.service.replyAttachments(f.store.replies(f.bot.botId).find(r => r.purpose === 'result')!)).toMatchObject([{ kind: 'artifact', name: 'report.html' }])
})

test('先只发附件再说用途时，前台可把前序用户材料关联到新卷宗', async () => {
  const decisions: Array<Record<string, unknown>> = [{ action: 'reply', replyText: '希望我怎样处理这份材料？' }]
  const f = fixture(decisions)
  const bytes = Buffer.from('材料要求：报告必须讨论缓存污染。')
  const upload = f.service.upload(f.bot.botId, 'owner', { action: 'begin', requestId: 'prior-file', name: 'prior.txt', mime: '', size: bytes.length }) as { id: string }
  f.service.upload(f.bot.botId, 'owner', { action: 'chunk', uploadId: upload.id, offset: 0, data: bytes.toString('base64') })
  const ref = f.service.upload(f.bot.botId, 'owner', { action: 'finish', uploadId: upload.id, hash: createHash('sha256').update(bytes).digest('hex') }) as any
  const source = f.service.receive(f.bot.botId, { groupId: 'dm', seq: 1, senderId: 'owner', memberId: 'member-owner', text: '', attachments: [ref], createdAt: Date.now() })
  await waitFor(() => f.store.inbox(source.id)?.state === 'routed')
  expect(f.store.tasks()).toHaveLength(0)
  decisions.push({ ...start, sourceInputIds: [source.id] })
  f.send(2, '用刚才上传的材料写报告')
  await waitFor(() => f.started() === 1)
  expect(JSON.parse(f.workerPayloads[0]).availableAttachments).toMatchObject([{ id: ref.id }])
  expect(await f.workerCall('work_read_attachment', { attachmentId: ref.id })).toMatchObject({ text: bytes.toString('utf8') })
})

function seedTask(store: BotRuntimeStore, bot: RuntimeBot): RuntimeTask {
  const message = store.receive({ botId: bot.botId, groupId: bot.groupId, seq: 1, text: '写论文报告', senderId: bot.ownerPhoneId, memberId: 'member-owner', createdAt: Date.now() })
  return store.acceptWork({ inputId: message.id, newCase: start.newCase, goal: start.goal, acceptance: start.acceptance, replyText: start.replyText,
    mandate: { ownerPhoneId: bot.ownerPhoneId, policyRevision: bot.policyRevision, directory: bot.directory, allowedOps: ['read', 'create', 'edit', 'delete'], exclusions: [], mode: 'execute' } })
}

test('前台能按文件名找回超出最近窗口的纯附件消息', async () => {
  let found: unknown
  const f = fixture([{ action: 'reply', replyText: '这份材料希望重点分析什么？' }], {
    seed: (store, bot) => {
      for (let seq = 1; seq <= 24; seq++) {
        const message = store.receive({ botId: bot.botId, groupId: bot.groupId, seq, senderId: bot.ownerPhoneId, memberId: 'owner', text: seq === 1 ? '' : '闲聊', createdAt: seq,
          ...(seq === 1 ? { attachments: [{ id: 'upload-prior', kind: 'upload' as const, botId: bot.botId, name: 'brief.txt', mime: 'text/plain', size: 1, hash: 'a'.repeat(64) }] } : {}) })
        store.markInput(message.id, 'routed')
      }
    },
    routerReads: async call => { found = await call('chat_search', { query: 'brief.txt' }) },
  })
  f.send(25, '请再找找我以前发的材料')
  await waitFor(() => found !== undefined)
  expect(found).toMatchObject({ messages: [{ text: '', attachments: [{ name: 'brief.txt' }] }] })
})

test('闲聊无工单；原消息重放不再次运行 Router 或发回复', async () => {
  const f = fixture([{ action: 'reply', replyText: '今天想聊什么？' }])
  f.send(1, '你好'); f.send(1, '你好')
  await waitFor(() => f.sent.length === 1)
  expect(f.store.tasks()).toHaveLength(0)
  expect(f.started()).toBe(0)
})
test('活动 Worker 中追加原话立即 steer；前台不等待完成，专业回答经前台发出', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions)
  f.send(1, '写论文 A 报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  decisions.push({ action: 'append', taskId: task.id, expectedRevision: 1, replyText: '可以，加上局限分析。' })
  f.send(2, '加一节局限分析')
  await waitFor(() => f.steers.length === 1)
  expect(f.steers[0]).toContain('加一节局限分析')
  expect(f.store.task(task.id)?.state).toBe('running')
  const addition = f.store.inputs(task.id)[0]
  await f.workerCall('work_consume_input', { inputId: addition.id })
  await f.workerCall('work_report', { summary: '正在补充局限分析', resolutions: [{ inputId: addition.id, resolution: '已纳入报告大纲' }] })
  await f.workerCall('work_reply', { replyToInputId: addition.inboxId, text: '局限分析会覆盖样本偏差和泛化范围。' })
  await waitFor(() => f.sent.includes('局限分析会覆盖样本偏差和泛化范围。'))
  expect(f.started()).toBe(1)
})

test('长工具执行中追问进度进入原 Worker，答案从统一出口发出后原任务继续交付', async () => {
  const toolGate = gate()
  const decisions: Array<Record<string, unknown>> = [start]
  const inspections: any[] = []
  const f = fixture(decisions, {
    runTool: async () => { await toolGate.promise; return '已读完材料' },
    routerReads: async call => { const task = f.store.tasks()[0]; if (task) inspections.push(await call('task_inspect', { taskId: task.id })) },
  })
  try {
    f.send(1, '核对材料并写报告'); await waitFor(() => f.started() === 1)
    const task = f.store.tasks()[0]; const runId = f.store.runs()[0].id
    await f.service.flush('bot-a')
    const sentBeforeReport = f.sent.length
    await f.workerCall('work_report', { summary: '已列出材料清单，正在读取正文' })
    expect(f.sent.length).toBe(sentBeforeReport)
    const operation = await f.workerCall('project_read_file', { path: 'paper.txt' }) as { operationId: string }
    await waitFor(() => f.store.operation(operation.operationId)?.state === 'running')
    decisions.push({ action: 'ask_worker', taskId: task.id, expectedRevision: 1, replyText: '我确认一下现在的进展。' })
    f.send(2, '现在做到哪了？')
    await waitFor(() => f.steers.length === 1)
    expect(inspections[0]).toMatchObject({ summaryUpdatedAt: expect.any(Number), observedAt: expect.any(Number), activeOperations: [{ id: operation.operationId, state: 'running' }] })
    const input = f.store.inputs(task.id)[0]
    expect(input.kind).toBe('ask_worker')
    await f.workerCall('work_consume_input', { inputId: input.id })
    await f.workerCall('work_reply', { replyToInputId: input.id, text: '材料清单已核对，正文读取仍在执行，尚未开始写报告。' })
    await waitFor(() => f.sent.includes('材料清单已核对，正文读取仍在执行，尚未开始写报告。'))
    expect(f.store.operation(operation.operationId)?.state).toBe('running')
    expect(f.store.task(task.id)?.state).toBe('running')
    expect(f.started()).toBe(1); expect(f.store.runs()[0].id).toBe(runId)
    await f.workerCall('work_report', { summary: '已回答进度，继续等待材料读取', resolutions: [{ inputId: input.id, resolution: '已直接回答当前状态，继续原任务' }] })
    toolGate.release(); await waitFor(() => f.store.operation(operation.operationId)?.state === 'completed')
    await f.workerCall('work_finish', { revision: 2, text: '材料已核对完成。', artifactIds: [], checks: ['已确认读取结果'] })
    f.complete(); await waitFor(() => f.sent.includes('材料已核对完成。'))
    expect(f.store.task(task.id)?.state).toBe('completed')
    expect(f.store.replies('bot-a').filter(r => r.author === 'router' && r.purpose === 'answer')).toHaveLength(1)
    expect(f.started()).toBe(1)
  } finally { toolGate.release() }
})
test('非 owner 不能指挥；审批归 owner，批准只执行一次', async () => {
  const f = fixture([start])
  expect(() => f.send(1, '删文件', 'other')).toThrow(/owner|创建者/)
  f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const op = await f.workerCall('project_delete_file', { path: 'old.txt' }) as { operationId: string }
  expect(f.actions).toHaveLength(0)
  expect(f.service.approvals('bot-a')).toHaveLength(1)
  await expect(f.service.approve('bot-a', 'other', op.operationId, true)).rejects.toThrow(/owner|创建者/)
  await f.service.approve('bot-a', 'owner', op.operationId, true)
  await waitFor(() => f.actions.length === 1)
  await expect(f.service.approve('bot-a', 'owner', op.operationId, true)).rejects.toThrow(/结束|不存在/)
  expect(f.actions).toEqual(['delete_file'])
})
test('停止后拒绝旧 Worker 交付；未知执行记录重启时不自动重复操作', async () => {
  const f = fixture([start]); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  await f.service.control('bot-a', 'owner', { action: 'stop', taskId: task.id, expectedRevision: 1, requestId: 'stop-1' })
  expect(f.store.task(task.id)?.state).toBe('stopped')
  await expect(f.workerCall('work_finish', { revision: 1, text: '完成。', artifactIds: [], checks: ['检查通过'] })).rejects.toThrow()
  expect(f.sent).not.toContain('完成。')
})

test('两个并行项目调用跨过异步验权时，也只能有一个操作被接受', async () => {
  const f = fixture([start], 20); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const results = await Promise.allSettled([f.workerCall('project_read_file', { path: 'a' }), f.workerCall('project_read_file', { path: 'b' })])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
})

test('必要问题的答案在旧轮次结束前到达，可立即恢复同一 Worker 的操作权', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  const question = await f.workerCall('work_ask_user', { text: '报告要侧重方法还是局限？', options: ['方法', '局限'] }) as { questionId: string }
  decisions.push({ action: 'answer', taskId: task.id, expectedRevision: 1, questionId: question.questionId, replyText: '我会侧重局限。' })
  f.send(2, '侧重局限'); await waitFor(() => f.steers.length === 1)
  expect(f.store.task(task.id)?.state).toBe('running')
  await expect(f.workerCall('project_read_file', { path: 'paper.txt' })).resolves.toHaveProperty('operationId')
})

test('成功交付后的旧 Worker 不能再提问或重新打开已完成工单', async () => {
  const f = fixture([start]); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  await f.workerCall('work_finish', { revision: 1, text: '报告完成。', artifactIds: [], checks: ['检查通过'] })
  await expect(f.workerCall('work_ask_user', { text: '还需要确认吗？' })).rejects.toThrow()
  expect(f.store.task(task.id)?.state).toBe('completed')
})

test('同一追问的输入 ID 和原消息 ID 共用一条回复，不能分条规避正文上限', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  decisions.push({ action: 'ask_worker', taskId: task.id, expectedRevision: 1, replyText: '我把当前大纲给你。' })
  f.send(2, '报告覆盖什么？'); await waitFor(() => f.steers.length === 1)
  const input = f.store.inputs(task.id)[0]
  await f.workerCall('work_reply', { replyToInputId: input.id, text: '第一部分：方法。' })
  await f.workerCall('work_reply', { replyToInputId: input.inboxId, text: '第二部分：局限。' })
  await waitFor(() => f.sent.includes('第一部分：方法。'))
  const replies = f.store.replies('bot-a').filter(r => r.author === 'router' && r.purpose === 'answer')
  expect(replies).toHaveLength(1)
  expect(replies[0].inputId).toBe(input.inboxId)
  expect(f.sent).not.toContain('第二部分：局限。')
})

test('审批在 Worker 关闭期间到达，等旧进程退出后由后继 Worker 执行一次', async () => {
  const closing = gate()
  const f = fixture([start], { firstWorkerCloseGate: closing }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]; const oldRun = f.store.runs()[0]
  const op = await f.workerCall('project_delete_file', { path: 'old.txt' }) as { operationId: string }
  f.complete(); await waitFor(() => f.workerCloses() > 0)
  await f.service.approve('bot-a', 'owner', op.operationId, true)
  expect(f.store.task(task.id)?.state).toBe('queued')
  expect(f.actions).toEqual([])
  expect(f.started()).toBe(1)
  expect(f.steers).toEqual([])
  closing.release()
  await waitFor(() => f.started() === 2 && f.actions.length === 1)
  expect(f.store.runs().find(r => r.id === oldRun.id)?.state).toBe('exited')
  expect(f.store.task(task.id)?.state).toBe('running')
  expect(f.store.operation(op.operationId)?.runId).toBe(f.store.task(task.id)?.latestRunId)
  expect(f.actions).toEqual(['delete_file'])
})

test('必要答案在 Worker 关闭期间到达，原话留给后继轮次且不向旧轮次 steer', async () => {
  const closing = gate(); const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { firstWorkerCloseGate: closing }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  const question = await f.workerCall('work_ask_user', { text: '报告面向谁？' }) as { questionId: string }
  f.complete(); await waitFor(() => f.workerCloses() > 0)
  decisions.push({ action: 'answer', taskId: task.id, questionId: question.questionId, expectedRevision: 1, replyText: '我会按研究人员的背景来写。' })
  f.send(2, '面向研究人员，务必保留局限分析')
  await waitFor(() => f.store.inputs(task.id).length === 1)
  expect(f.steers).toEqual([])
  expect(f.store.inputs(task.id)[0].delivery).toBe('pending')
  expect(f.store.task(task.id)?.state).toBe('queued')
  closing.release(); await waitFor(() => f.started() === 2)
  const payload = JSON.parse(f.workerPayloads[1])
  expect(payload.pendingInputs).toHaveLength(1)
  expect(payload.pendingInputs[0].text).toBe('面向研究人员，务必保留局限分析')
  expect(payload.task.revision).toBe(2)
  expect(f.store.task(task.id)?.state).toBe('running')
})

test('写入后异常保留真实副作用，未知结果只允许读取，owner 核对后不自动重播', async () => {
  const f = fixture([start], { runTool: async (tool, _args, dir) => {
    const path = join(dir, 'report.txt')
    if (tool === 'edit_file') { writeFileSync(path, '已经写入一次'); throw new Error('写入后执行中断，结果未知') }
    return readFileSync(path, 'utf8')
  } })
  f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  const op = await f.workerCall('project_edit_file', { path: 'report.txt', content: '已经写入一次' }) as { operationId: string }
  await waitFor(() => f.store.operation(op.operationId)?.state === 'unknown')
  expect(readFileSync(join(f.dir, 'report.txt'), 'utf8')).toBe('已经写入一次')
  await expect(f.workerCall('project_edit_file', { path: 'report.txt', content: '重复写入' })).rejects.toThrow(/未知|核对/)
  const read = await f.workerCall('project_read_file', { path: 'report.txt' }) as { operationId: string }
  await waitFor(() => f.store.operation(read.operationId)?.state === 'completed')
  expect(f.store.operation(read.operationId)?.result).toBe('已经写入一次')
  const request = { action: 'reconcile' as const, taskId: task.id, expectedRevision: 1, requestId: 'resolve-write', operationId: op.operationId, text: '已核对报告文件，当前内容只写入了一次', confirmedStopped: true }
  await expect(f.service.control('bot-a', 'owner', request)).rejects.toThrow(/停止/)
  await f.service.control('bot-a', 'owner', { action: 'stop', taskId: task.id, expectedRevision: 1, requestId: 'stop-for-check' })
  await expect(f.service.control('bot-a', 'other', request)).rejects.toThrow(/owner|创建者/)
  await expect(f.service.control('bot-a', 'owner', { ...request, confirmedStopped: false })).rejects.toThrow(/停止/)
  await expect(f.service.control('bot-a', 'owner', { ...request, text: '' })).rejects.toThrow(/核对说明/)
  await f.service.control('bot-a', 'owner', request)
  await waitFor(() => f.started() === 2)
  expect(f.store.operation(op.operationId)?.state).toBe('reconciled')
  expect(f.store.operation(op.operationId)?.reconciliation?.actor).toBe('owner')
  expect(f.workerPayloads[1]).toContain(request.text)
  await expect(f.service.control('bot-a', 'owner', request)).resolves.toHaveProperty('protocol', 1)
  expect(f.started()).toBe(2)
  expect(f.actions.filter(a => a === 'edit_file')).toHaveLength(1)
  expect(readFileSync(join(f.dir, 'report.txt'), 'utf8')).toBe('已经写入一次')
})

test('重启遗留 Worker 即使没有工具操作，也须 owner 确认旧执行后才能恢复', async () => {
  let task!: RuntimeTask
  const f = fixture([], { seed: (store, bot) => {
    task = seedTask(store, bot)
    store.saveRun({ id: 'orphan-run', botId: bot.botId, taskId: task.id, state: 'running', threadId: 'orphan-thread', createdAt: Date.now(), updatedAt: Date.now() })
    store.updateTask(task.id, { state: 'running', latestRunId: 'orphan-run' })
  } })
  expect(f.store.task(task.id)?.state).toBe('recovering')
  expect(f.store.operations()).toEqual([])
  expect(f.service.view('bot-a', 'owner').recoveries).toEqual([{ taskId: task.id, runIds: ['orphan-run'], canReconcile: true }])
  const resume = { action: 'resume' as const, taskId: task.id, expectedRevision: 1, requestId: 'resume-orphan' }
  await expect(f.service.control('bot-a', 'owner', resume)).rejects.toThrow(/旧执行|未知|核对/)
  // “停止”只能停止本进程实际持有的执行，不能为上次遗留进程作退出证明。
  await f.service.control('bot-a', 'owner', { ...resume, action: 'stop', requestId: 'stop-orphan' })
  await expect(f.service.control('bot-a', 'owner', { ...resume, requestId: 'resume-after-stop' })).rejects.toThrow(/旧执行|未知|核对/)
  expect(f.started()).toBe(0)
  const reconcile = { ...resume, action: 'reconcile' as const, requestId: 'resolve-orphan', text: '已在本机确认上次 Worker 及其项目命令全部退出', confirmedStopped: true }
  await expect(f.service.control('bot-a', 'owner', { ...reconcile, confirmedStopped: false })).rejects.toThrow(/停止/)
  await f.service.control('bot-a', 'owner', reconcile)
  await waitFor(() => f.started() === 1)
  expect(f.store.runs().find(r => r.id === 'orphan-run')?.state).toBe('exited')
  expect(f.store.runs().find(r => r.id === 'orphan-run')?.reconciliation?.note).toBe(reconcile.text)
  expect(f.service.view('bot-a', 'owner').recoveries).toEqual([])
  await expect(f.service.control('bot-a', 'owner', reconcile)).resolves.toHaveProperty('protocol', 1)
  expect(f.started()).toBe(1)
  expect(f.store.task(task.id)?.latestRunId).not.toBe('orphan-run')
  expect(f.actions).toEqual([])
})

test('停止期间到达的审批被拒绝，进程实际关闭前不完成停止且不执行操作', async () => {
  const closing = gate()
  const f = fixture([start], { firstWorkerCloseGate: closing }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  const op = await f.workerCall('project_delete_file', { path: 'old.txt' }) as { operationId: string }
  let stopped = false
  const stopping = f.service.control('bot-a', 'owner', { action: 'stop', taskId: task.id, expectedRevision: 1, requestId: 'stop-before-approval' }).then(() => { stopped = true })
  await waitFor(() => f.workerCloses() > 0)
  expect(stopped).toBe(false)
  await expect(f.service.approve('bot-a', 'owner', op.operationId, true)).rejects.toThrow()
  expect(f.store.operation(op.operationId)?.state).toBe('failed')
  expect(f.actions).toEqual([])
  closing.release(); await stopping
  expect(f.store.task(task.id)?.state).toBe('stopped')
  expect(f.store.runs().every(r => r.state === 'exited')).toBe(true)
  expect(f.started()).toBe(1)
})

test('宿主停机时仍在验权的项目调用不得在晚到的验权结果后执行', async () => {
  const access = gate()
  const f = fixture([start], { accessGate: access }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const pending = f.workerCall('project_edit_file', { path: 'report.txt', content: '不能落盘' }).then(
    () => ({ error: undefined }), error => ({ error: error as Error }),
  )
  await f.service.close()
  access.release()
  const result = await pending
  expect(result.error?.message).toMatch(/停止|失效/)
  expect(f.actions).toEqual([])
  expect(f.store.operations()).toEqual([])
  expect(f.store.tasks()[0].state).toBe('stopped')
})

test('必要问题回答成功后重试同一个控制请求，不受旧版本或已清除 question 阻挡', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  const question = await f.workerCall('work_ask_user', { text: '报告面向谁？' }) as { questionId: string }
  decisions.push({ action: 'answer', taskId: task.id, expectedRevision: 1, questionId: question.questionId, replyText: '我会面向研究人员继续。' })
  const request = { action: 'answer' as const, taskId: task.id, expectedRevision: 1, questionId: question.questionId, requestId: 'answer-reconnect', text: '研究人员' }
  await f.service.control('bot-a', 'owner', request)
  await waitFor(() => f.steers.length === 1)
  expect(f.store.task(task.id)?.revision).toBe(2)
  expect(f.store.task(task.id)?.question).toBeUndefined()
  await expect(f.service.control('bot-a', 'owner', request)).resolves.toHaveProperty('protocol', 1)
  await expect(f.service.control('bot-a', 'other', request)).rejects.toThrow(/owner|创建者/)
  expect(f.store.inputs(task.id)).toHaveLength(1)
  expect(f.steers).toHaveLength(1)
  expect(f.store.task(task.id)?.revision).toBe(2)
})

test('Router 查工单只披露有限未处理输入，不把已处理长历史灌入上下文', async () => {
  let task!: RuntimeTask; let inspected: any
  const f = fixture([{ action: 'reply', replyText: '我看到了当前处理范围。' }], {
    seed: (store, bot) => {
      task = seedTask(store, bot)
      for (let i = 0; i < 20; i++) {
        const message = store.receive({ botId: bot.botId, groupId: bot.groupId, seq: i + 2, text: `补充 ${i}：${'材料'.repeat(1000)}`, senderId: bot.ownerPhoneId, memberId: 'member-owner', createdAt: Date.now() })
        const input = store.acceptInput({ inputId: message.id, taskId: task.id, expectedRevision: i + 1, kind: 'append', replyText: '范围明确。' })
        if (i < 15) { store.consumeInput(input.id, task.id); store.resolveInput(input.id, task.id, '历史详细结论'.repeat(1000)) }
      }
    },
    routerReads: async call => { inspected = await call('task_inspect', { taskId: task.id }) },
  })
  f.send(30, '当前任务是什么？'); await waitFor(() => inspected !== undefined)
  expect(JSON.stringify(inspected).length).toBeLessThanOrEqual(4000)
  expect(inspected.inputs).toHaveLength(3)
  expect(inspected.inputs.map((i: { text: string }) => i.text)).toEqual(expect.arrayContaining([expect.stringContaining('补充 17'), expect.stringContaining('补充 18'), expect.stringContaining('补充 19')]))
  expect(JSON.stringify(inspected)).not.toContain('历史详细结论')
})

test('Router 经验读取分页、累计预算和调用次数独立于普通查询预算', async () => {
  const results: unknown[] = []; const errors: string[] = []; let experienceId = ''
  const f = fixture([{ action: 'reply', replyText: '我会根据已读取的经验判断。' }], {
    seed: (store, bot) => {
      const source = store.receive({ botId: bot.botId, groupId: bot.groupId, seq: 100, text: '保存经验', senderId: bot.ownerPhoneId, memberId: 'member-owner', createdAt: Date.now() })
      const saved = store.experienceLibrary.save(bot.botId, { requestId: 'budget-seed', content: { title: '经验预算', object: '维护', goal: '查询', applicability: '需要查询时', pitfalls: Array(20).fill('坑'.repeat(500)), steps: Array(20).fill('步'.repeat(500)), verification: Array(20).fill('验'.repeat(500)), detail: '详'.repeat(12000) }, changeSummary: '预算边界' }, { inboxId: source.id })
      experienceId = saved.id; store.markInput(source.id, 'routed', { action: 'reply' })
    },
    routerReads: async call => {
      for (let i = 0; i < 4; i++) await call('chat_recent', { limit: 1 })
      results.push(await call('experience_read', { experienceId, section: 'detail', length: 12000 }))
      for (let i = 0; i < 8; i++) {
        try { results.push(await call('experience_read', { experienceId })) }
        catch (error) { errors.push((error as Error).message) }
      }
    },
  })
  f.send(1, '以前有类似经验吗？'); await waitFor(() => f.sent.length === 1)
  expect((results[0] as { text: string }).text).toHaveLength(2400)
  expect(results.length).toBeGreaterThan(2); expect(results.length).toBeLessThan(8)
  expect(errors.some(error => error.includes('内容预算'))).toBe(true)
  expect(errors.some(error => error.includes('读取预算'))).toBe(true)
  expect(results.reduce<number>((sum, value) => sum + JSON.stringify(value).length, 0)).toBeLessThanOrEqual(32000)
})

test('聊天里说继续：恢复最近停下的任务并重开 Worker，原话有处理记录', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  decisions.push({ action: 'stop', taskId: task.id, replyText: '好的，先停下。' })
  f.send(2, '别搞了'); await waitFor(() => f.store.task(task.id)?.state === 'stopped')
  expect(f.sent).toContain('好的，先停下。')
  decisions.push({ action: 'resume', taskId: task.id, replyText: '好，接着做。' })
  f.send(3, '继续'); await waitFor(() => f.started() === 2)
  expect(f.store.task(task.id)?.state).toBe('running')
  expect(f.store.task(task.id)?.error).toBeUndefined()
  expect(f.store.runs().filter(r => r.taskId === task.id)).toHaveLength(2)
  expect(f.sent).toContain('好，接着做。')
  expect(f.store.failedInputs(f.bot.botId)).toHaveLength(0)
})

test('停止尚未完成时说继续：不报错，登记意图，真正停下后自动恢复', async () => {
  const closing = gate(); const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { firstWorkerCloseGate: closing }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  let stopped = false
  const stopping = f.service.control('bot-a', 'owner', { action: 'stop', taskId: task.id, expectedRevision: 1, requestId: 'stop-in-progress' }).then(() => { stopped = true })
  await waitFor(() => f.store.task(task.id)?.state === 'stopping' && f.workerCloses() > 0)
  expect(stopped).toBe(false)
  decisions.push({ action: 'resume', taskId: task.id, replyText: '好，停下后我接着做。' })
  const resumed = f.send(2, '继续')
  await waitFor(() => f.store.task(task.id)?.resumeIntent !== undefined && f.store.inbox(resumed.id)?.state === 'routed')
  expect(f.store.task(task.id)?.state).toBe('stopping')
  expect(f.store.failedInputs(f.bot.botId)).toHaveLength(0)
  expect(f.sent).toContain('好，停下后我接着做。')
  closing.release(); await stopping
  await waitFor(() => f.started() === 2)
  expect(f.store.task(task.id)?.state).toBe('running')
  expect(f.store.task(task.id)?.resumeIntent).toBeUndefined()
  expect(f.store.task(task.id)?.error).toBeUndefined()
})

test('等待停止超时：恢复意图作废并留下说明，停下后不自动恢复', async () => {
  const closing = gate(); const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { firstWorkerCloseGate: closing, resumeIntentMs: 50, tickMs: 20 }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  let stopped = false
  const stopping = f.service.control('bot-a', 'owner', { action: 'stop', taskId: task.id, expectedRevision: 1, requestId: 'stop-slow' }).then(() => { stopped = true })
  await waitFor(() => f.store.task(task.id)?.state === 'stopping' && f.workerCloses() > 0)
  decisions.push({ action: 'resume', taskId: task.id })
  f.send(2, '继续')
  await waitFor(() => f.store.task(task.id)?.error?.includes('超时') === true)
  expect(stopped).toBe(false)
  closing.release(); await stopping
  await waitFor(() => f.store.task(task.id)?.state === 'stopped')
  expect(f.store.task(task.id)?.resumeIntent).toBeUndefined()
  expect(f.store.task(task.id)?.error).toContain('超时')
  await Bun.sleep(80)
  expect(f.started()).toBe(1)
})

test('有未知执行时说继续被拒：任务不动，原话留下可重试的失败记录', async () => {
  let task!: RuntimeTask
  const decisions: Array<Record<string, unknown>> = [{ action: 'resume' }]
  const f = fixture(decisions, { seed: (store, bot) => {
    task = seedTask(store, bot)
    store.saveRun({ id: 'orphan-run', botId: bot.botId, taskId: task.id, state: 'unknown', createdAt: Date.now(), updatedAt: Date.now() })
    store.updateTask(task.id, { state: 'recovering', latestRunId: 'orphan-run' })
  } })
  decisions[0].taskId = task.id
  f.send(2, '继续')
  await waitFor(() => f.store.failedInputs(f.bot.botId).length === 1)
  expect(f.store.failedInputs(f.bot.botId)[0].error).toContain('核对')
  expect(f.store.task(task.id)?.state).toBe('recovering')
  expect(f.store.task(task.id)?.resumeIntent).toBeUndefined()
  expect(f.started()).toBe(0)
})

test('非阻塞提问经前台发出，任务不停下，Worker 继续干活', async () => {
  const f = fixture([start], { tickMs: 3_600_000 }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  const asked = await f.workerCall('work_ask_user', { text: '报告面向谁？', blocks: false }) as { questionId: string }
  expect(f.store.task(task.id)?.state).toBe('running')
  expect(f.store.task(task.id)?.question).toBeUndefined()
  expect(f.store.task(task.id)?.followup).toMatchObject({ questionId: asked.questionId, askCount: 1 })
  await waitFor(() => f.sent.includes('报告面向谁？'))
  await expect(f.workerCall('project_read_file', { path: 'paper.txt' })).resolves.toHaveProperty('operationId')
  expect(f.store.task(task.id)?.state).toBe('running')
})

test('主人任何回复到达即清零跟进；再提醒允许前台0泡，普通必要问题仍不能丢', async () => {
  const decisions: Array<Record<string, unknown>> = [start]
  const f = fixture(decisions, { tickMs: 3_600_000 }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  await f.workerCall('work_ask_user', { text: '报告面向谁？', blocks: false })
  await waitFor(() => f.sent.includes('报告面向谁？'))
  decisions.push({ action: 'reply', replyText: '好的，不用回答也行。' })
  f.send(2, '不用了')
  await waitFor(() => f.store.task(task.id)?.followup === undefined)
  expect(f.store.task(task.id)?.state).toBe('running')
  const reminder = f.store.reply({ botId: 'bot-a', groupId: 'dm', author: 'worker', purpose: 'question', text: '再问一次？', policyRevision: 1, key: 'nudge-x', followupReminder: true })
  f.store.presentWorkerReply('bot-a', reminder.id, [], '主人未答，且不必再提')
  expect(f.store.replies('bot-a').find(r => r.id === reminder.id)?.state).toBe('routed')
  const plain = f.store.reply({ botId: 'bot-a', groupId: 'dm', author: 'worker', purpose: 'question', text: '给谁看？', policyRevision: 1, key: 'q-plain' })
  expect(() => f.store.presentWorkerReply('bot-a', plain.id, [], 'x')).toThrow(/必要问题/)
})

test('主人安静超过阈值只再提一次，之后不再提', async () => {
  const f = fixture([start], { tickMs: 20, followupQuietMs: 30 }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  await f.workerCall('work_ask_user', { text: '报告面向谁？', blocks: false })
  await waitFor(() => f.sent.filter(t => t === '报告面向谁？').length === 2)
  expect(f.store.task(task.id)?.followup?.askCount).toBe(2)
  await Bun.sleep(200)
  expect(f.sent.filter(t => t === '报告面向谁？')).toHaveLength(2)
  expect(f.store.task(task.id)?.state).toBe('running')
})

test('任务完成后不再提醒', async () => {
  const f = fixture([start], { tickMs: 20, followupQuietMs: 30 }); f.send(1, '写报告'); await waitFor(() => f.started() === 1)
  const task = f.store.tasks()[0]
  await f.workerCall('work_ask_user', { text: '报告面向谁？', blocks: false })
  await waitFor(() => f.sent.includes('报告面向谁？'))
  await f.workerCall('work_finish', { revision: 1, text: '报告完成。', artifactIds: [], checks: ['检查通过'] })
  expect(f.store.task(task.id)?.state).toBe('completed')
  expect(f.store.task(task.id)?.followup).toBeUndefined()
  f.complete()
  await Bun.sleep(200)
  expect(f.sent.filter(t => t === '报告面向谁？')).toHaveLength(1)
})

test('case_search可按成果ID找旧卷宗并翻页，仍受整轮4次读取预算约束', async () => {
  const results: any[] = []; const errors: string[] = []
  let oldId = ''
  const f = fixture([{ action: 'reply', replyText: '已找到旧报告。' }], {
    seed: (store, bot) => {
      const task = seedTask(store, bot)
      oldId = task.caseId
      for (const reply of store.pendingReplies(bot.botId)) store.markReplySent(reply.id)
      store.updateTask(task.id, { state: 'completed' })
      store.saveArtifact({ id: 'retrieval-report', botId: bot.botId, caseId: task.caseId, taskId: task.id, title: '旧报告', name: 'report.md', path: '/unused', mime: 'text/plain', size: 1, hash: '', revision: 1, createdAt: 1 })
      store.saveCase({ ...store.case(task.caseId)!, title: '同名事项', goal: '', object: '', summary: '', createdAt: 0, updatedAt: 0 })
      for (let i = 0; i < 6; i++) store.saveCase({ id: `new-retrieval-${i}`, botId: bot.botId, title: '同名事项', object: '', goal: '', summary: '', createdAt: Date.now() + i + 1, updatedAt: Date.now() + i + 1 })
    },
    routerReads: async call => {
      for (const args of [{ artifactId: 'retrieval-report' }, { query: '同名事项' }, { query: '同名事项', offset: 5 }, { query: '同名事项' }, { query: '同名事项' }]) {
        try { results.push(await call('case_search', args)) } catch (error) { errors.push((error as Error).message) }
      }
    },
  })
  f.send(10, '找一下旧报告'); await waitFor(() => f.sent.length === 1)
  expect(results).toHaveLength(4)
  expect(results[0]).toMatchObject([{ id: oldId }])
  expect(results[1].some((c: any) => c.id === oldId)).toBe(false)
  expect(results[2].some((c: any) => c.id === oldId)).toBe(true)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain('读取预算')
})


test('case_search长摘要裁页后按实际返回条数继续，不跳过候选', async () => {
  const ids: string[] = []
  const f = fixture([{ action: 'reply', replyText: '已核对候选。' }], {
    seed: (store, bot) => {
      for (let i = 0; i < 7; i++) store.saveCase({ id: `long-case-${i}`, botId: bot.botId, title: '同名长卷宗', object: '', goal: '长'.repeat(700), summary: '', createdAt: i, updatedAt: i })
    },
    routerReads: async call => {
      for (let page = 0; page < 4 && ids.length < 7; page++) {
        const found = await call('case_search', { query: '同名长卷宗', offset: ids.length }) as Array<{ id: string }>
        ids.push(...found.map(c => c.id))
      }
    },
  })
  f.send(1, '找旧卷宗'); await waitFor(() => f.sent.length === 1)
  expect(ids).toHaveLength(7)
  expect(new Set(ids).size).toBe(7)
})


test('Router验收返工复用原卷宗会话，旧Worker退出后才启动修正且执行指导完整', async () => {
  const resultDecisions: Array<Record<string, unknown>> = []
  const f = fixture([{...start, executionGuidance:'报告保留原文引用，不省略必要条件'}], {workerResultDecisions:resultDecisions})
  f.send(1,'写报告，保留原文引用'); await waitFor(()=>f.started()===1)
  const task=f.store.tasks()[0]
  expect(JSON.parse(f.workerPayloads[0]).task.executionGuidance).toBe('报告保留原文引用，不省略必要条件')
  resultDecisions.push({action:'revise',taskId:task.id,feedback:'缺少局限分析，按原目标补全',executionGuidance:'保留原文引用，说明未核实部分',replies:[]})
  await f.workerCall('work_finish',{revision:1,text:'初稿完成',artifactIds:[],checks:['核对结构']})
  await waitFor(()=>f.store.task(task.id)?.state==='queued')
  expect(f.started()).toBe(1)
  expect(f.store.experiences(f.bot.botId)).toHaveLength(0)
  expect(f.sent).not.toContain('初稿完成')
  f.complete(); await waitFor(()=>f.started()===2)
  expect(f.workerThreads.map(t=>t.method)).toEqual(['start','resume'])
  expect(f.store.tasks()).toHaveLength(1)
  const payload=JSON.parse(f.workerPayloads[1])
  expect(payload.task).toMatchObject({id:task.id,caseId:task.caseId,revision:2,executionGuidance:'报告保留原文引用，不省略必要条件',mandate:task.mandate})
  expect(payload.pendingInputs[0]).toMatchObject({kind:'correction',executionGuidance:'保留原文引用，说明未核实部分'})
  const input=payload.pendingInputs[0]
  await f.workerCall('work_consume_input',{inputId:input.id})
  await f.workerCall('work_report',{summary:'已补全局限',resolutions:[{inputId:input.id,resolution:'已补全局限并保留引用'}]})
  await f.workerCall('work_finish',{revision:2,text:'修正报告完成',artifactIds:[],checks:['核对引用及局限']})
  f.complete(); await waitFor(()=>f.store.task(task.id)?.review?.state==='approved')
  expect(f.store.task(task.id)?.review).toEqual({state:'approved',rounds:1})
  await waitFor(()=>f.sent.includes('修正报告完成'))
  expect(f.sent).not.toContain('初稿完成')
  expect(f.store.experiences(f.bot.botId)).toEqual([])
})

test('切换模式或权限时停止待验收任务，避免永久核对中', async () => {
  let taskId=''
  const f=fixture([], {seed:(store,bot)=>{
    const task=seedTask(store,bot); taskId=task.id
    store.updateTask(task.id,{state:'running'})
    store.finishTask(task.id,1,'待验收',[])
  }})
  await f.service.policyChanged(f.bot.botId)
  expect(f.store.task(taskId)).toMatchObject({state:'stopped'})
  expect(f.store.pendingReplies(f.bot.botId)).toHaveLength(0)
  expect(f.started()).toBe(0)
})

test('已消费补充的执行约束在停止后恢复仍交给Worker，不依赖旧会话记忆', async () => {
  const decisions:Array<Record<string,unknown>>=[start]
  const f=fixture(decisions); f.send(1,'写报告'); await waitFor(()=>f.started()===1)
  const task=f.store.tasks()[0]
  decisions.push({action:'append',taskId:task.id,replies:[],executionGuidance:'报告必须保留原文引用'})
  f.send(2,'保留原文引用'); await waitFor(()=>f.store.inputs(task.id).length===1)
  const input=f.store.inputs(task.id)[0]
  await f.workerCall('work_consume_input',{inputId:input.id})
  await f.workerCall('work_report',{summary:'已补引用',resolutions:[{inputId:input.id,resolution:'引用已保留'}]})
  await f.service.control(f.bot.botId,'owner',{action:'stop',taskId:task.id,expectedRevision:2,requestId:'stop-guidance'})
  await f.service.control(f.bot.botId,'owner',{action:'resume',taskId:task.id,expectedRevision:2,requestId:'resume-guidance'})
  await waitFor(()=>f.started()===2)
  expect(JSON.parse(f.workerPayloads[1]).executionGuidanceHistory).toEqual([{inputId:input.id,revision:2,kind:'append',executionGuidance:'报告必须保留原文引用'}])
})
