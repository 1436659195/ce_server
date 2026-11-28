/** 独立 Router 对话回放；默认校验样本，--live 才调用模型。绝不连接真实用户。 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import { Database } from 'bun:sqlite'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import { CodexAppServer, type CodexToolCall } from '../src/cli/bot-runtime/codex'
import { memorySummary } from '../src/cli/bot-runtime/memory'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { bindRouterDecision, routerContext, ROUTER_INSTRUCTIONS, ROUTER_TOOLS, type RouterDecision } from '../src/cli/bot-runtime/router'
import type { RuntimeArtifact, RuntimeBot, RuntimeCase, RuntimeInbox, RuntimeMemory, RuntimeReply, RuntimeTask } from '../src/cli/bot-runtime/types'

const action = z.enum(['reply', 'start', 'append', 'ask_worker', 'answer', 'stop', 'resume', 'approve_directory', 'request_access', 'revise'])
const category = z.enum(['conversation', 'acknowledgement', 'continuity', 'result_focus', 'material_limits', 'preference'])
const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z-]+$/), category, split: z.enum(['tune', 'holdout']),
  current: z.array(z.string().min(1)),
  history: z.array(z.strictObject({ role: z.enum(['owner', 'router']), text: z.string().min(1) })),
  preferences: z.array(z.string().min(1)).optional(),
  task: z.strictObject({ state: z.enum(['running', 'completed', 'failed', 'waiting_user']), goal: z.string().min(1),
    delivery: z.enum(['chat', 'files']).optional(), acceptance: z.array(z.string()), question: z.string().optional() }).optional(),
  worker: z.strictObject({ purpose: z.enum(['result', 'answer', 'unable', 'question']), text: z.string().min(1), checks: z.array(z.string()),
    artifact: z.strictObject({ name: z.string().regex(/^[a-zA-Z0-9_.-]+$/), mime: z.string().min(1), text: z.string().min(1) }).optional() }).optional(),
  facts: z.array(z.string().min(1)).min(1), rubric: z.string().min(1),
  expected: z.strictObject({ actions: z.array(action).min(1), reply: z.enum(['required', 'optional', 'silent']),
    delivery: z.enum(['chat', 'files']).optional(), case: z.enum(['new', 'existing']).optional(),
    allowedOps: z.array(z.enum(['read', 'create', 'edit', 'delete', 'execute'])).optional(), guidanceContains: z.array(z.string()).optional() }),
})
export type ConversationScenario = z.infer<typeof scenarioSchema>
const anchor = Date.parse('2026-11-28T12:00:00+08:00')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export function validateCases(input: unknown): ConversationScenario[] {
  const cases = z.array(scenarioSchema).length(24).parse(input)
  if (new Set(cases.map(c => c.id)).size !== cases.length || cases.filter(c => c.split === 'holdout').length !== 8
    || category.options.some(name => cases.filter(c => c.category === name).length !== 4)
    || cases.some(c => c.worker && !c.task || !c.current.length && !c.worker)) throw new Error('样本必须有六类各4组、8组留出、唯一ID及完整的触发来源')
  return cases
}

export function buildFixture(s: ConversationScenario, platform: 'codex' | 'claude') {
  const bot: RuntimeBot = { botId: 'eval-bot', name: '小林', groupId: 'eval-dm', ownerPhoneId: 'eval-owner', platform,
    sourceCwd: '/example/router-eval', directory: '/example/router-eval', policyRevision: 1, commandSandbox: false,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  const history = [...(s.preferences ?? []).map(text => ({ role: 'owner' as const, text })), ...s.history]
  const inbox = (text: string, i: number, state: RuntimeInbox['state']): RuntimeInbox => ({
    id: `${s.id}-message-${i}`, botId: bot.botId, groupId: bot.groupId, seq: i + 1, text, senderId: bot.ownerPhoneId,
    memberId: 'eval-member', state, createdAt: anchor + i * 1000, receivedAt: anchor + i * 1000,
  })
  const messages = history.flatMap((m, i) => m.role === 'owner' ? [inbox(m.text, i, 'routed')] : [])
  const inputs = s.current.map((text, i) => inbox(text, history.length + i, 'pending'))
  const task: RuntimeTask | undefined = s.task ? {
    ...s.task, id: `${s.id}-task`, botId: bot.botId, caseId: `${s.id}-case`,
    originInputId: messages.at(-1)?.id ?? `${s.id}-source`, groupId: bot.groupId, requesterMemberId: 'eval-member',
    mandate: { ownerPhoneId: bot.ownerPhoneId, directory: bot.directory, policyRevision: 1, allowedOps: ['read', 'create', 'edit'], exclusions: [], mode: 'execute' },
    question: s.task.question ? { id: `${s.id}-question`, text: s.task.question, options: [], createdAt: anchor } : undefined,
    revision: 1, summary: '', createdAt: anchor, updatedAt: anchor,
    ...(s.worker?.purpose === 'result' ? { review: { state: 'pending' as const, rounds: 0 } } : {}),
  } : undefined
  const cases: RuntimeCase[] = task ? [{ id: task.caseId, botId: bot.botId, title: task.goal, object: task.goal, goal: task.goal,
    summary: '', revision: 1, createdAt: anchor, updatedAt: anchor }] : []
  const artifacts: RuntimeArtifact[] = s.worker?.artifact && task ? [{ id: `${s.id}-artifact`, botId: bot.botId, taskId: task.id, caseId: task.caseId,
    name: s.worker.artifact.name, title: s.worker.artifact.name, mime: s.worker.artifact.mime,
    path: join(bot.directory, s.worker.artifact.name), size: Buffer.byteLength(s.worker.artifact.text), hash: hash(s.worker.artifact.text), revision: 1, createdAt: anchor }] : []
  const memories: RuntimeMemory[] = (s.preferences ?? []).map((prompt, i) => ({
    id: `${s.id}-memory-${i}`, botId: bot.botId, channel: bot.groupId, senderId: bot.ownerPhoneId,
    tier: 'long', status: 'active', format: 2, version: 1, topic: '交流约定', kind: 'preference', prompt, scope: {}, core: true,
    source: { inboxId: messages[i].id, quote: prompt, context: prompt, sentAt: anchor + i * 1000 },
    triggers: { count: 1 }, createdAt: anchor, updatedAt: anchor,
  }))
  const workerMessage: RuntimeReply | undefined = s.worker && task ? {
    id: `${s.id}-worker`, key: `${s.id}-worker`, botId: bot.botId, groupId: bot.groupId, author: 'worker',
    purpose: s.worker.purpose, text: s.worker.text, checks: s.worker.checks, taskId: task.id, taskRevision: 1,
    inputId: task.originInputId, questionId: task.question?.id, policyRevision: 1, state: 'pending', createdAt: anchor + history.length * 1000,
    artifactIds: artifacts.map(a => a.id), artifactSummaries: artifacts.map(a => ({ artifactId: a.id, hash: a.hash, revision: a.revision, summary: s.worker!.text,
      requirements: task.acceptance, checks: s.worker!.checks, limitations: [] })),
  } : undefined
  const text = routerContext({ bot, profile: '负责示例工程维护，也和用户自然聊天。', inputs, input: inputs.at(-1), messages,
    previousReplies: history.flatMap((m, i) => m.role === 'router' ? [{ text: m.text, createdAt: anchor + i * 1000, taskId: task?.id, caseId: task?.caseId }] : []),
    cases, tasks: task ? [task] : [], relatedTaskIds: task ? [task.id] : [], artifacts,
    workerMessage, workerRequest: task?.goal, workerArtifacts: artifacts.map(a => ({ id: a.id, name: a.name!, mime: a.mime, size: a.size })),
    memories: { long: memories.map(memorySummary), mid: [], overflow: 0, revision: 'eval-v1', retrieval: { mode: 'keyword' } }, experienceSummaries: [],
  })
  const context = JSON.parse(text)
  context.observedAt = anchor + (history.length + inputs.length + 1) * 1000
  const bindings = { policyRevision: 1, currentInputIds: inputs.map(m => m.id), workerReplyId: workerMessage?.id,
    workerSource: { worker: !!workerMessage, files: !!artifacts.length },
    tasks: new Map(task ? [[task.id, { revision: 1, questionId: task.question?.id, caseId: task.caseId }]] : []),
    cases: new Map(cases.map(c => [c.id, { revision: 1, scopeComplete: true }])),
  }
  const historyReplies: RuntimeReply[] = history.flatMap((m, i) => m.role === 'router' ? [{
    id: `${s.id}-history-reply-${i}`, key: `${s.id}-history-reply-${i}`, botId: bot.botId, groupId: bot.groupId,
    author: 'router', purpose: 'chat', text: m.text, policyRevision: 1, state: 'sent',
    createdAt: anchor + i * 1000, sentAt: anchor + i * 1000, taskId: task?.id,
  }] : [])
  return { bot, task, cases, messages, inputs, memories, artifacts, workerMessage, historyReplies, bindings, context: JSON.stringify(context) }
}
type Fixture = ReturnType<typeof buildFixture>

/** 仅种入虚构记录；复用真实存储提交与历史查询，绝不启动 Worker/发送服务。 */
export function createReplay(f: Fixture, dir: string) {
  const path = join(dir, 'runtime.sqlite')
  const store = new BotRuntimeStore(path)
  const seed = new Database(path)
  try {
    for (const [table, rows] of [
      ['inbox', [...f.messages, ...f.inputs]], ['outbox', [...f.historyReplies, ...(f.workerMessage ? [f.workerMessage] : [])]],
      ['tasks', f.task ? [f.task] : []], ['cases', f.cases], ['artifacts', f.artifacts],
    ] as const) for (const row of rows) seed.query(`INSERT INTO ${table}(id,bot_id,body) VALUES(?,?,?)`).run(row.id, row.botId, JSON.stringify(row))
    for (const m of f.memories) store.saveMemory(m)
  } finally { seed.close() }
  const decide = (args: Record<string, unknown>): RouterDecision => {
    const d = bindRouterDecision(args, f.bot, f.bindings)
    if ((d.memoryIds ?? []).some(id => !f.memories.some(m => m.id === id))) throw new Error('采用了未披露的记忆')
    if (d.cancelReplyIds.length) throw new Error('本样本没有可以取消的前台气泡')
    if (d.experienceRefs?.length || d.acceptLesson) throw new Error('本样本没有可采用的经验或草稿')
    if (!f.inputs.length && !['reply', 'revise'].includes(d.action)) throw new Error('内部结果不能授权新工作')
    if (f.workerMessage && f.inputs.length && !d.workerReplyIndexes) throw new Error('混合输入需要workerReplyIndexes')
    const message = f.inputs.at(-1)
    const userReply = { botId: f.bot.botId, groupId: f.bot.groupId, inputId: message?.id, author: 'router' as const,
      purpose: 'chat' as const, key: `${message?.id ?? f.workerMessage?.id}:router`, policyRevision: 1 }
    store.transaction(() => {
      if (message) store.requireBatch(message.id, f.inputs.map(m => m.id))
      if (d.action === 'start') {
        store.acceptWork({ inputId: message!.id, inputIds: f.inputs.map(m => m.id), caseId: d.caseId, newCase: d.newCase,
          caseUpdate: d.caseUpdate, caseDecision: d.caseDecision, goal: d.goal!, acceptance: d.acceptance, delivery: d.delivery,
          executionGuidance: d.executionGuidance, replies: d.replies,
          mandate: { ownerPhoneId: f.bot.ownerPhoneId, directory: f.bot.directory, policyRevision: 1, allowedOps: d.allowedOps, exclusions: d.exclusions, mode: d.feasibility === 'assess' ? 'assess' : 'execute' } })
      } else if (['append', 'ask_worker', 'answer'].includes(d.action)) {
        store.acceptInput({ inputId: message!.id, inputIds: f.inputs.map(m => m.id), taskId: d.taskId!, expectedRevision: d.expectedRevision!,
          kind: d.action as 'append' | 'ask_worker' | 'answer', replies: d.replies, delivery: d.delivery, executionGuidance: d.executionGuidance })
      } else if (d.action === 'revise') {
        if (f.workerMessage?.purpose !== 'result' || d.taskId !== f.task?.id) throw new Error('返工来源不匹配')
        store.reviseWorkerResult(f.bot.botId, f.workerMessage.id, d.taskId!, d.expectedRevision!, d.feedback!, d.executionGuidance, d.delivery)
        store.routerBubbles(userReply, d.replies)
      } else if (d.action === 'reply' || d.action === 'request_access') {
        if (f.workerMessage) store.presentWorkerReply(f.bot.botId, f.workerMessage.id, d.replies, d.basis,
          message ? { indexes: d.workerReplyIndexes!, user: userReply } : undefined)
        else store.routerBubbles(userReply, d.replies)
      } else if (d.action === 'stop' && f.task?.state === 'running') {
        // 只模拟状态控制；没有真实执行进程，进程取消语义由 runtime 回归测试覆盖。
        store.updateTask(f.task.id, { state: 'stopped' }); store.routerBubbles(userReply, d.replies)
      } else throw new Error('本样本没有该控制动作所需的运行状态')
      for (const input of f.inputs) store.markInput(input.id, 'routed', d)
    })
    return d
  }
  return { store, decide }
}

/** 检查工具契约和动作；语义事实、自然度必须另行评阅，不能以此函数宣称通过。 */
export function assessDecision(s: ConversationScenario, d: RouterDecision, f: Fixture): string[] {
  const issues: string[] = []
  if (!s.expected.actions.includes(d.action)) issues.push(`action: ${d.action}; expected ${s.expected.actions.join('|')}`)
  if (s.expected.reply === 'required' && !d.replies.length || f.workerMessage?.purpose === 'unable' && !d.replies.length) issues.push('reply: required')
  if (s.expected.reply === 'silent' && d.replies.length) issues.push('reply: expected silence')
  if (d.action === 'reply' && f.artifacts.length && !d.replies.length) issues.push('attachment: cannot omit file delivery')
  if (d.taskId && d.taskId !== f.task?.id) issues.push('task: wrong target')
  if (s.expected.case === 'existing' && (d.action === 'start' ? d.caseId !== f.task?.caseId : d.taskId !== f.task?.id)) issues.push('case: expected existing')
  if (s.expected.case === 'new' && !d.newCase) issues.push('case: expected new')
  const delivery = d.delivery ?? (d.taskId ? f.task?.delivery : undefined)
  if (s.expected.delivery && delivery !== s.expected.delivery) issues.push(`delivery: expected ${s.expected.delivery}`)
  if (s.expected.allowedOps && d.allowedOps.some(op => !s.expected.allowedOps!.includes(op))) issues.push('permissions: exceeded requested operations')
  const guidance = [d.goal, ...d.acceptance, d.executionGuidance, d.feedback].join('\n').toLowerCase()
  for (const required of s.expected.guidanceContains ?? []) if (!guidance.includes(required.toLowerCase())) issues.push(`guidance: missing ${required}`)
  if (!f.inputs.length && !['reply', 'revise'].includes(d.action)) issues.push('source: worker result cannot authorize new work')
  if (d.action === 'revise' && (f.workerMessage?.purpose !== 'result' || d.taskId !== f.task?.id)) issues.push('review: wrong source')
  return issues
}

async function runScenario(s: ConversationScenario, run: number, options: { platform: 'codex' | 'claude'; model?: string; instructions: string; root: string }) {
  const f = buildFixture(s, options.platform)
  const dir = join(options.root, `${s.id}-${run}`)
  mkdirSync(dir, { recursive: true })
  if (s.worker?.artifact) writeFileSync(join(dir, s.worker.artifact.name), s.worker.artifact.text, { mode: 0o600 })
  const calls: Array<{ tool: string; arguments: Record<string, unknown>; error?: string }> = []
  const replay = createReplay(f, dir)
  let accepted: RouterDecision | undefined
  let reads = 0
  const onToolCall = async (call: CodexToolCall): Promise<unknown> => {
    const entry: typeof calls[number] = { tool: call.tool, arguments: call.arguments }; calls.push(entry)
    try {
      if (accepted) throw new Error('本轮已经提交，请结束')
      if (call.tool === 'router_decide') {
        accepted = replay.decide(call.arguments)
        return { accepted: true, simulation: true }
      }
      if (++reads > 4) throw new Error('本轮查询预算已用尽')
      if (call.tool === 'task_inspect') {
        if (call.arguments.taskId !== f.task?.id) throw new Error('任务不存在')
        return JSON.parse(f.context).tasks[0]
      }
      if (call.tool === 'case_search') return JSON.parse(f.context).cases
      if (call.tool === 'chat_recent' || call.tool === 'chat_search') {
        return replay.store.chatHistory(f.bot.botId, { ...call.arguments, groupId: f.bot.groupId })
      }
      if (call.tool === 'chat_read') {
        return replay.store.chatMessage(f.bot.botId, { groupId: f.bot.groupId, messageId: String(call.arguments.messageId),
          offset: Number(call.arguments.offset ?? 0), length: Number(call.arguments.length ?? 1600) })
      }
      if (call.tool === 'memory_search') return { items: f.memories.map(memorySummary), revision: 'eval-v1' }
      if (call.tool === 'memory_read') {
        const m = f.memories.find(m => m.id === call.arguments.id)
        if (!m) throw new Error('记忆不存在')
        return { memory: m, revision: 'eval-v1' }
      }
      if (call.tool === 'artifact_read' && call.arguments.artifactId === f.artifacts[0]?.id && s.worker?.artifact) return { text: s.worker.artifact.text, eof: true }
      if (call.tool === 'experience_search') return { items: [] }
      throw new Error('此回放不提供写工具或未声明的外部信息，请根据当前样本决策')
    } catch (error) { entry.error = String(error); throw error }
  }
  const clientOptions = { cwd: dir, model: options.model, effort: 'low' as const, onToolCall }
  const client = options.platform === 'codex' ? new CodexAppServer(clientOptions) : new ClaudeRuntime(clientOptions)
  const started = Date.now()
  let failure: string | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        const threadId = await client.startThread({ instructions: options.instructions, tools: ROUTER_TOOLS, ephemeral: true })
        const turn = await client.startTurn(threadId, f.context)
        const result = await turn.done
        if (result.status !== 'completed') throw new Error(`turn: ${result.status}; ${result.error?.message ?? ''}`)
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('模型回放超过90秒')), 90_000) }),
    ])
  } catch (error) { failure = String(error) }
  finally { clearTimeout(timeout); await client.close(); replay.store.close() }
  const issues = accepted ? assessDecision(s, accepted, f) : ['decision: not submitted']
  if (failure) issues.push(failure)
  return { id: s.id, category: s.category, split: s.split, run, contextHash: hash(f.context), context: JSON.parse(f.context),
    elapsedMs: Date.now() - started, calls, decision: accepted, issues, facts: s.facts, rubric: s.rubric,
    review: { factsCorrect: null, naturalness: null, relevance: null, continuity: null, concision: null, notes: '' } }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (args.some(a => !/^--(?:live$|(?:platform|runs|concurrency|model|instructions-file|output|split)=.+$)/.test(a))) throw new Error('未知或空参数')
  const platform = z.enum(['codex', 'claude']).parse(option('platform') ?? 'codex')
  const runs = z.coerce.number().int().min(1).max(10).parse(option('runs') ?? 3)
  const concurrency = z.coerce.number().int().min(1).max(8).parse(option('concurrency') ?? 4)
  const split = z.enum(['all', 'tune', 'holdout']).parse(option('split') ?? 'all')
  const all = validateCases(JSON.parse(readFileSync(new URL('../test/fixtures/router-conversation-cases.json', import.meta.url), 'utf8')))
  const scenarios = all.filter(s => split === 'all' || s.split === split)
  if (!args.includes('--live')) {
    for (const s of scenarios) buildFixture(s, platform)
    console.log(JSON.stringify({ status: 'validated', cases: scenarios.length, holdouts: scenarios.filter(s => s.split === 'holdout').length, live: false }))
    return
  }
  const instructions = option('instructions-file') ? readFileSync(option('instructions-file')!, 'utf8') : ROUTER_INSTRUCTIONS
  const model = option('model')
  const root = mkdtempSync(join(tmpdir(), 'ce-router-conversation-'))
  const output = option('output') ?? join(root, 'evaluation.json')
  const jobs = scenarios.flatMap(s => Array.from({ length: runs }, (_, i) => ({ s, run: i + 1 })))
  const results: Awaited<ReturnType<typeof runScenario>>[] = []
  const version = execFileSync(platform, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
  const report = { version: 1, platform, cliVersion: version, model: model ?? 'CLI configured default', effort: 'low',
    instructionsHash: hash(instructions), instructions, datasetHash: hash(JSON.stringify(all)), runs, split, root, results }
  const save = () => {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  }
  save()
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      const result = await runScenario(job.s, job.run, { platform, model, instructions, root })
      results.push(result); save()
      console.log(JSON.stringify({ completed: results.length, total: jobs.length, id: result.id, run: result.run, issues: result.issues }))
    }
  }))
  console.log(JSON.stringify({ output, runs: results.length, contractFailures: results.filter(r => r.issues.length).length, semanticReview: 'pending' }))
  if (results.some(r => r.issues.length)) process.exitCode = 1
}

if (import.meta.main) await main()
