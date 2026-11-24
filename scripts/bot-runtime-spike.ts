/** 显式 --live 才调用真实模型；记录不含账号/PIN/项目材料的协议证据。 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServer, type CodexNotification, type CodexToolSpec } from '../src/cli/bot-runtime/codex'

if (!process.argv.includes('--live')) {
  console.error('真实验证请运行：bun run scripts/bot-runtime-spike.ts --live')
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), 'ce-bot-live-'))
const events: Array<Record<string, unknown>> = []
const record = (kind: string, data: Record<string, unknown> = {}) => {
  const event = { at: Date.now(), kind, ...data }
  events.push(event)
  console.log(JSON.stringify(event))
}
const notification = (role: string) => (event: CodexNotification) => {
  if (['turn/started', 'turn/completed'].includes(event.method)) record(`${role}:${event.method}`, { threadId: event.params.threadId, turn: event.params.turn })
  if (event.method === 'item/started') {
    const item = event.params.item as { type?: string }
    if (item?.type && !['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall', 'plan', 'contextCompaction'].includes(item.type)) record(`${role}:unexpected-item`, { type: item.type })
  }
}
const schema = { type: 'object', properties: { inputId: { type: 'string' }, message: { type: 'string' } }, required: ['message'], additionalProperties: false }
const tools: CodexToolSpec[] = [
  { name: 'work_step', description: '执行一个有界测试步骤，返回 done=false 时继续执行。', inputSchema: schema },
  { name: 'consume_input', description: '确认读到工作期间追加的输入，填写精确 inputId。', inputSchema: schema },
]
let releaseFirst!: () => void
const firstStep = new Promise<void>(resolve => { releaseFirst = resolve })
let step = 0
let consumed = false
let toolsSeen = ''
let originalThreadId = ''
let originalTurnId = ''
const worker = new CodexAppServer({
  cwd: join(root, 'worker'), onNotification: notification('worker'),
  onToolCall: async call => {
    record('worker:tool', { threadId: call.threadId, turnId: call.turnId, callId: call.callId, tool: call.tool, arguments: call.arguments })
    if (call.tool === 'consume_input') {
      consumed ||= call.arguments.inputId === 'spike-input-2' && call.threadId === originalThreadId && call.turnId === originalTurnId
      return { recorded: true }
    }
    step++
    if (step === 1) releaseFirst()
    await new Promise(resolve => setTimeout(resolve, 750))
    return { step, done: step >= 8, instruction: step >= 8 ? '任务完成，请简短结束。' : '继续下一步；先处理任何新用户输入。' }
  },
})
const router = new CodexAppServer({
  cwd: join(root, 'router'), onNotification: notification('router'),
  onToolCall: async call => { toolsSeen = String(call.arguments.message); record('router:tool', { tool: call.tool, message: toolsSeen }); return { ok: true } },
})
const clients = new Set([worker, router])
const limit = setTimeout(() => { for (const client of clients) void client.close() }, 180_000)
try {
  await Promise.all([worker.initialize(), router.initialize()])
  record('initialized')
  const tid = await worker.startThread({ instructions: '你是工作中追加输入协议测试 Agent。只使用提供的 work_step、consume_input。开始后反复调用 work_step 直到 done=true。收到新输入时立即先用 consume_input 记录 inputId，然后继续 work_step。不要自行省略步骤。', tools })
  const routerId = await router.startThread({ instructions: '你是无项目权限的前台 Agent，只能调用宿主提供的 report_tools。请准确报告你当前可见工具；不得假称读取了文件。', tools: [{ name: 'report_tools', description: '报告当前可用工具和回答', inputSchema: schema }], ephemeral: true })
  const active = await worker.startTurn(tid, '执行工作步骤直到工具返回 done=true。', 'spike-input-1')
  originalThreadId = tid
  originalTurnId = active.turnId
  let workerCompleted = false
  void active.done.then(() => { workerCompleted = true }, () => { workerCompleted = true })
  await Promise.race([firstStep, active.done.then(() => { throw new Error('Worker 未执行测试步骤就已结束') })])
  record('steer:send', { threadId: tid, turnId: active.turnId })
  await worker.steer(tid, active.turnId, '用户补充 inputId=spike-input-2：立即用 consume_input 确认这条新要求，message 填写“已在工作中读到补充”，然后继续原来的步骤。', 'spike-input-2')
  record('steer:accepted', { turnId: active.turnId })
  const front = await router.startTurn(routerId, '你好。请用 report_tools 简短回答，并列出你实际可用的全部工具名称。你能否直接使用原生 Shell 或文件读取工具访问 /etc/hostname？没有这种工具就明确说明。', 'spike-router-input')
  const frontDone = await front.done
  if (frontDone.status !== 'completed' || workerCompleted) throw new Error('未证明 Router 在 Worker 仍活动时完成回复')
  record('router:responsive', { status: frontDone.status, workerStillActive: true })
  const result = await active.done
  if (result.status !== 'completed' || !consumed) throw new Error('未证明原活动轮次消费新输入')
  if (!toolsSeen || !toolsSeen.includes('report_tools')) throw new Error('前台工具验证没有返回结果')
  await worker.close()
  let resumeCalls = 0
  let interruptReady!: () => void
  const interruptStep = new Promise<void>(resolve => { interruptReady = resolve })
  const resumed = new CodexAppServer({ cwd: join(root, 'worker'), onNotification: notification('resumed'), onToolCall: async call => {
    record('resumed:tool', { tool: call.tool, threadId: call.threadId })
    if (++resumeCalls > 1) { interruptReady(); await new Promise(resolve => setTimeout(resolve, 750)); return { done: false } }
    return { done: true }
  } })
  clients.add(resumed)
  try {
    await resumed.resumeThread(tid, { instructions: '继续原测试，只调用一次 work_step 后结束。', tools })
    const next = await resumed.startTurn(tid, '请调用 work_step 确认原线程动态工具恢复，然后结束。', 'spike-resume')
    const resumedResult = await next.done
    if (resumedResult.status !== 'completed' || !events.some(e => e.kind === 'resumed:tool')) throw new Error('动态工具恢复未验证')
    const pending = await resumed.startTurn(tid, '请继续反复调用 work_step 五十次。这一轮测试宿主停止操作。', 'spike-interrupt')
    await Promise.race([interruptStep, pending.done.then(turn => { throw new Error(`停止测试开始前已结束：${turn.status} ${turn.error?.message ?? ''}`) })])
    await resumed.interrupt(tid, pending.turnId)
    if ((await pending.done).status !== 'interrupted') throw new Error('停止没有得到 interrupted 终止确认')
  } finally { await resumed.close() }
  // 原生名字可能仍可见；实际 canary 验证空 environments 确实拒绝文件执行。
  const canary = join(root, 'native-write-canary.txt')
  const nativeOutputs: string[] = []
  const isolated = new CodexAppServer({ cwd: join(root, 'isolation'), onToolCall: async () => { throw new Error('此测试没有动态工具') }, onNotification: event => {
    if (event.method === 'rawResponseItem/completed') {
      const item = event.params.item as { type?: string; output?: unknown }
      if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
        nativeOutputs.push(output)
        record('isolation:tool-output', { output })
      }
    }
  } })
  clients.add(isolated)
  try {
    await isolated.initialize()
    const thread = await isolated.call<{ thread: { id: string } }>('thread/start', {
      cwd: join(root, 'isolation'), environments: [], runtimeWorkspaceRoots: [], sandbox: 'read-only', approvalPolicy: 'never',
      ephemeral: false, experimentalRawEvents: true, dynamicTools: [],
      baseInstructions: 'You are an integration tester. Attempt only the authorized temporary file operation with actual native tools. Do not simulate it or infer its result.',
      developerInstructions: 'Use native apply_patch for this canary probe if available. Never read credentials or other files. Do not invoke MCP, agents or any other tools.',
      config: { model_reasoning_effort: 'low', web_search: 'disabled', project_doc_max_bytes: 0 },
    })
    const probe = await isolated.startTurn(thread.thread.id, `Attempt native apply_patch to create ${canary} containing CANARY_WRITE. Report its actual error. This test authorizes the attempt, but the environment may reject it.`)
    const final = await probe.done
    if (final.status !== 'completed') throw new Error('原生隔离验证未正常结束')
    if (existsSync(canary)) throw new Error('原生文件写入绕过了宿主，不能启用此适配器')
    if (!nativeOutputs.some(value => value.includes('No usable execution environment'))) throw new Error('未取得原生文件执行被拒绝的原始工具证据，模型自述不能替代验证')
    record('isolation:PASS', { canaryCreated: false, emptyEnvironmentEnforced: true, rawDenialRecorded: nativeOutputs.some(value => value.includes('No usable execution environment')) })
  } finally { await isolated.close() }
  if (events.some(e => String(e.kind).endsWith(':unexpected-item'))) throw new Error('发现未开放的原生工具活动，隔离验证失败')
  record('PASS', { consumedInOriginalTurn: consumed, restoredThreadId: tid, closed: worker.closed })
} catch (error) {
  record('FAIL', { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  clearTimeout(limit)
  await Promise.all([...clients].map(client => client.close()))
  const output = join(root, 'trace.json')
  writeFileSync(output, JSON.stringify(events, null, 2), { mode: 0o600 })
  console.log(`证据文件：${output}`)
}
