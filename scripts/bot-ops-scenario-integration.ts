/** 真实模型跑测试包里的运维剧本：临时账本与工作目录，回复只记录到本地，不向任何人发消息。
 *  用法：bun scripts/bot-ops-scenario-integration.ts --live [--platform=claude|codex] [--bundle=<测试包解压目录>] [--work=<工作目录>]
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotToolService } from '../src/cli/bot-tools'
import { CodexAppServer } from '../src/cli/bot-runtime/codex'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import type { RuntimeAttachment, RuntimeBot, RuntimeReply, RuntimeTask } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('真实模型验证需要 --live')
const arg = (key: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3)
const platform = arg('platform') === 'codex' ? 'codex' : 'claude'
const bundle = arg('bundle') ?? '/tmp/ce-bot-test-bundle'
const root = mkdtempSync(join(tmpdir(), 'ce-bot-ops-live-'))
const work = arg('work') ?? join(root, 'work'); mkdirSync(work, { recursive: true })
const trace: unknown[] = []
const record = (event: Record<string, unknown>) => { const item = { at: Date.now(), ...event }; trace.push(item); console.log(JSON.stringify(item)) }
const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); record({ kind: 'check', name, ok, detail }) }

/** 岗位与职责照测试包原文；agent_bot/workerN 是测试包约定的产物位置。 */
/** 岗位职责和主人的几轮原话照测试包原文。原文带客户环境信息，不进仓库：放在测试包目录的 script.json，
 *  字段 profile / turn1 / ack / turn3 / turn4 / logs / closing；数组按换行拼成一条。 */
interface Scenario { profile: string | string[]; turn1: string; ack: string; turn3: string | string[]; turn4: string; logs: string; closing: string }
const scenario = JSON.parse(readFileSync(join(bundle, 'script.json'), 'utf8')) as Scenario
const lines = (value: string | string[]) => Array.isArray(value) ? value.join('\n') : value
const profile = lines(scenario.profile); const turn3 = lines(scenario.turn3)

const store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
const bot: RuntimeBot = { botId: 'ops-scenario', name: '运维', groupId: 'local-dm', ownerPhoneId: 'owner', sourceCwd: work, directory: work, platform, policyRevision: 1, commandSandbox: false, workerAccessMode: 'full-access',
  permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'allow', execute: 'allow', commanders: 'owner', allowedPhoneIds: [] } }
store.saveSettings({ ...store.settings(bot.botId), mode: 'router-worker', revision: 1, profile })
const tools = new BotToolService({ endpoint: () => '', authorize: async () => { throw new Error('使用工单授权') } })
const sent: RuntimeReply[] = []; const turns: Array<{ seq: number; trigger: string; toolsLocked: boolean; at: number }> = []
const turnTools = new Map<number, string[]>(); let turnSeq = 0; let running = 0
const runtime = new BotRuntimeService({ store, rootDir: root, getBot: () => bot,
  sendReply: async reply => { sent.push(reply); record({ kind: 'reply', text: reply.text.slice(0, 200), attachments: reply.artifactIds?.length ?? 0, purpose: reply.purpose }) },
  checkAccess: async () => ({ directory: work, permissions: bot.permissions, revision: 1 }),
  openTools: (_bot, memberId, authorize) => {
    const grant = tools.open({ name: bot.name, groupId: bot.groupId, memberId, requesterName: bot.name }, (_context, operation, summary) => authorize(operation, summary))
    return { close: () => grant.close(), call: (tool, args) => tools.call(grant.connection.token, tool, args) }
  },
  createClient: (role, options) => {
    let current = 0
    const traced = { ...options, onToolCall: async (call: Parameters<typeof options.onToolCall>[0]) => {
      turnTools.set(current, [...(turnTools.get(current) ?? []), call.tool])
      record({ kind: 'tool', role, tool: call.tool, ...(call.tool === 'router_decide' ? { decision: (call.arguments as { decision?: { action?: string } }).decision?.action, args: JSON.stringify(call.arguments).slice(0, 500) } : {}) })
      try { return await options.onToolCall(call) }
      catch (error) { record({ kind: 'tool_error', role, tool: call.tool, error: String(error) }); throw error }
    } }
    const client = platform === 'claude' ? new ClaudeRuntime(traced) : new CodexAppServer(traced)
    return { initialize: () => client.initialize(), startThread: p => client.startThread(p), resumeThread: (id, p) => client.resumeThread(id, p),
      startTurn: async (id, text, input) => {
        turnSeq++; current = turnSeq; running++
        // 前台没提交决策时宿主会在同一会话里提醒一次，那一轮的输入是纯文本，不是上下文 JSON。
        const context = text.startsWith('{') ? JSON.parse(text) : { trigger: 'nudge' }
        turns.push({ seq: turnSeq, trigger: context.trigger, toolsLocked: context.toolsLocked === true, at: Date.now() })
        record({ kind: 'turn', seq: turnSeq, trigger: context.trigger, toolsLocked: context.toolsLocked === true, messages: context.currentMessages?.map((m: { text: string }) => m.text.slice(0, 60)), workerPurpose: context.workerMessage?.purpose ?? null })
        const turn = await client.startTurn(id, text, input)
        return { ...turn, done: turn.done.finally(() => { running-- }) }
      }, steer: (id, turn, text, input) => client.steer(id, turn, text, input), interrupt: (id, turn) => client.interrupt(id, turn), close: () => client.close() }
  },
})
let seq = 0
function send(text: string, attachments: RuntimeAttachment[] = []) {
  const message = runtime.receive(bot.botId, { groupId: bot.groupId, seq: ++seq, senderId: bot.ownerPhoneId, memberId: 'owner-member', text, attachments, createdAt: Date.now() })
  record({ kind: 'received', id: message.id, text: text.slice(0, 60), attachments: attachments.length }); return message
}
function upload(path: string): RuntimeAttachment {
  const bytes = readFileSync(path); const name = path.split('/').pop()!
  const begun = runtime.upload(bot.botId, bot.ownerPhoneId, { action: 'begin', requestId: crypto.randomUUID(), name, mime: '', size: bytes.length }) as { id: string }
  for (let offset = 0; offset < bytes.length; offset += 262144) runtime.upload(bot.botId, bot.ownerPhoneId, { action: 'chunk', uploadId: begun.id, offset, data: bytes.subarray(offset, offset + 262144).toString('base64') })
  return runtime.upload(bot.botId, bot.ownerPhoneId, { action: 'finish', uploadId: begun.id, hash: createHash('sha256').update(bytes).digest('hex') }) as RuntimeAttachment
}
async function until(what: string, done: () => boolean, timeoutMs = 20 * 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    const failed = store.tasks(bot.botId).find(t => t.state === 'failed')
    const failedInput = store.failedInputs(bot.botId)[0]
    // 前台某一轮没提交有效决策只会在设置里留一条提示，宿主 5 秒后自动重试；任务或原话失败才算剧本失败。
    if (failed || failedInput) throw new Error(failed?.error ?? failedInput?.error)
    if (Date.now() > deadline) throw new Error(`等待超时：${what}${store.settings(bot.botId).error ? `（${store.settings(bot.botId).error}）` : ''}`)
    await Bun.sleep(500)
  }
}
const settled = () => running === 0 && !store.pendingInbox(bot.botId).length && !store.pendingReplies(bot.botId).length && !store.tasks(bot.botId).some(t => ['queued', 'running', 'stopping'].includes(t.state))
const cases = () => new Set(store.tasks(bot.botId).map(t => t.caseId))
const latest = () => store.tasks(bot.botId).at(-1) as RuntimeTask | undefined

try {
  record({ kind: 'start', platform, bundle, work, profile })
  // ① 问题描述 + 两张截图
  const images = [upload(join(bundle, '图片1.jpg')), upload(join(bundle, '图片2.jpg'))]
  const first = send(scenario.turn1, images)
  await until('首轮派工并开始排查', () => store.tasks(bot.botId).length > 0 && sent.length > 0 && running === 0 && !store.pendingReplies(bot.botId).length)
  await until('首轮 Worker 交付', () => settled() && store.artifacts(bot.botId).length > 0 && store.tasks(bot.botId).some(t => t.review?.state === 'approved'), 25 * 60_000)
  const task1 = store.tasks(bot.botId)[0]
  // attachmentInputIds 记的是带附件的消息，不是附件个数。
  check('首轮开在卷宗并带上两张截图', task1.attachmentInputIds?.includes(first.id) === true && (store.inbox(first.id)?.attachments?.length ?? 0) === 2 && cases().size === 1)
  check('首轮产出排查文件并交付', store.artifacts(bot.botId).some(a => a.taskId === task1.id) && sent.some(r => r.artifactIds?.length))
  // ② 「好的」：不派工
  const before2 = store.tasks(bot.botId).length
  const second = send(scenario.ack)
  await until('「好的」处理完', () => store.inbox(second.id)?.state === 'routed' && settled())
  check('「好的」不另派工', store.tasks(bot.botId).length === before2)
  // ③ 粘贴终端输出
  const t3 = Date.now(); const third = send(turn3)
  await until('结合终端输出继续排查并交付', () => store.inbox(third.id)?.state === 'routed' && settled() && store.artifacts(bot.botId).some(a => a.createdAt >= t3), 25 * 60_000)
  const caseIds3 = cases()
  // 卷宗怎么归是前台按「对象和目标」判断的：路径前缀问题被当成另一个对象也说得通，只记录不判失败。
  record({ kind: 'observe', name: '粘贴终端后卷宗怎么归', detail: `任务数 ${store.tasks(bot.botId).length}，卷宗数 ${caseIds3.size}，原任务补充 ${store.inputs(task1.id).length} 条` })
  // ④ 追问：补进当前工作，不另起炉灶
  const before4 = store.tasks(bot.botId).length
  const fourth = send(turn4)
  await until('追问进入当前工作', () => store.inbox(fourth.id)?.state === 'routed' && settled(), 25 * 60_000)
  const appended = store.tasks(bot.botId).some(t => store.inputs(t.id).some(i => i.inboxIds?.includes(fourth.id)))
  const sameCaseNew = store.tasks(bot.botId).length > before4 && cases().size === caseIds3.size
  record({ kind: 'observe', name: '追问怎么进工作', detail: appended ? '作为补充进入原任务' : sameCaseNew ? '在已有卷宗里开了后续工单' : '另起了卷宗' })
  // ⑤ 两份引擎日志
  const t5 = Date.now(); const logs = [upload(join(bundle, '新环境.txt')), upload(join(bundle, '旧环境.txt'))]
  const fifth = send(scenario.logs, logs)
  await until('结合日志给出结论', () => store.inbox(fifth.id)?.state === 'routed' && settled(), 25 * 60_000)
  const asked = store.replies(bot.botId).some(r => r.purpose === 'question' && r.state === 'sent') || store.tasks(bot.botId).some(t => t.question || t.followup)
  check('收到日志后任务收口', !store.tasks(bot.botId).some(t => ['queued', 'running', 'stopping', 'failed'].includes(t.state)))
  record({ kind: 'observe', name: 'Worker 是否主动要日志', asked })
  // ⑥ 解决了：不派工
  const before6 = store.tasks(bot.botId).length
  const sixth = send(scenario.closing)
  await until('收尾', () => store.inbox(sixth.id)?.state === 'routed' && settled())
  check('收尾不另派工', store.tasks(bot.botId).length === before6)
  // 三道关：Worker 结果单独到来那一轮只压短，没有查询
  const locked = turns.filter(t => t.trigger === 'worker_message')
  check('Worker 结果那一轮只压短不查询', locked.length > 0 && locked.every(t => t.toolsLocked) && locked.every(t => (turnTools.get(t.seq) ?? []).every(tool => tool === 'router_decide')), `共 ${locked.length} 轮`)
  // 经验是可选的复用知识，不再要求每份完成报告都生成一条。
  const completed = store.tasks(bot.botId).filter(t => t.state === 'completed' && t.review?.state === 'approved')
  const lessons = store.experiences(bot.botId)
  check('自动经验仅来自经前台验收的任务', completed.length > 0 && lessons.every(e => e.kind === 'lesson' && completed.some(t => t.id === e.sourceTaskId)))
  record({ kind: 'observe', name: 'Worker 主动总结并获批的经验数', count: lessons.length })
  // 记忆：剧本里没有定规矩的话
  check('剧本里没有偏好话，记忆库保持为空', store.memories(bot.botId).length === 0)
  check('对外的话全部经前台整理', sent.every(r => r.author === 'router'))
  const quiet = store.messages(bot.botId).map(m => { const turn = turns.find(t => t.at >= (m.receivedAt ?? 0)); return turn ? turn.at - (m.receivedAt ?? 0) : null })
  record({ kind: 'observe', name: '每轮从收到到开轮的毫秒数', quiet })
} catch (error) {
  check('剧本跑完', false, String(error))
} finally {
  const summary = { kind: 'summary', passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).map(c => c.name), tasks: store.tasks(bot.botId).map(t => ({ state: t.state, goal: t.goal.slice(0, 80), caseId: t.caseId })), replies: sent.map(r => r.text.slice(0, 80)), artifacts: store.artifacts(bot.botId).map(a => a.name), work }
  await runtime.close(); store.close()
  record(summary)
  writeFileSync(join(root, 'trace.json'), JSON.stringify(trace, null, 2), { mode: 0o600 })
  console.log(`Trace: ${join(root, 'trace.json')}`)
  if (checks.some(c => !c.ok)) process.exitCode = 1
}
