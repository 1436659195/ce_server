/** 真实模型目录确认验收：仅临时文件、临时账本和本地回复，不发送社交消息。 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotToolService } from '../src/cli/bot-tools'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import { CodexAppServer } from '../src/cli/bot-runtime/codex'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('真实模型验收须显式传入 --live')
const platform = process.argv.includes('--codex') ? 'codex' : 'claude'
const manual = process.argv.includes('--manual')
const root = mkdtempSync(join(tmpdir(), `ce-directory-live-${platform}-`))
const project = join(root, 'project'); const frontend = join(project, 'frontend'); const backend = join(project, 'backend')
mkdirSync(frontend, { recursive: true }); mkdirSync(backend)
const target = join(backend, 'settings.json')
const original = JSON.stringify({ enabled: false, note: 'keep-this-value' }, null, 2) + '\n'
writeFileSync(target, original)
writeFileSync(join(frontend, 'README.md'), '这是临时验收项目；后端设置保存在相邻 backend/settings.json。\n')
const store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
const bot: RuntimeBot = {
  botId: 'directory-live', name: '目录验收助理', groupId: 'local-dm', ownerPhoneId: 'local-owner',
  sourceCwd: frontend, directory: frontend, platform, policyRevision: 1, commandSandbox: false, workerAccessMode: 'full-access',
  permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'allow', execute: 'allow', commanders: 'owner', allowedPhoneIds: [] },
}
store.saveSettings({ ...store.settings(bot.botId), mode: 'router-worker', revision: 1, profile: '负责当前临时项目的配置修改，保留不相关字段；依据实际文件核对结果。' })
const events: Array<Record<string, unknown>> = []
const replies: RuntimeReply[] = []
const threads: Array<{ method: string; id: string; cwd: string }> = []
const record = (event: Record<string, unknown>) => { events.push({ at: Date.now(), ...event }); console.log(JSON.stringify(event)) }
const resolveDirectory = (directory: string): string => {
  if (!isAbsolute(directory)) throw new Error('目标必须是绝对目录')
  const real = realpathSync(directory); const rel = relative(project, real)
  if (!statSync(real).isDirectory() || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('目录超出临时项目')
  return real
}
const tools = new BotToolService({ endpoint: () => '', authorize: async () => { throw new Error('使用工单授权') } })
const runtime = new BotRuntimeService({
  store, rootDir: root, getBot: () => structuredClone(bot), routerQuietMs: 50, bubbleGapMs: 0,
  resolveDirectory,
  changeDirectory: (botId, actor, revision, directory) => {
    if (botId !== bot.botId || actor !== bot.ownerPhoneId || revision !== bot.policyRevision) throw new Error('目录确认身份或版本不匹配')
    bot.directory = bot.sourceCwd = resolveDirectory(directory); bot.policyRevision++
    record({ kind: 'directory_changed', directory: bot.directory, policyRevision: bot.policyRevision })
  },
  sendReply: async reply => { replies.push(reply); record({ kind: 'reply', text: reply.text, purpose: reply.purpose }) },
  checkAccess: async () => ({ directory: bot.directory, permissions: bot.permissions, revision: bot.policyRevision }),
  openTools: (_bot, memberId, authorize) => {
    const grant = tools.open({ name: bot.name, groupId: bot.groupId, memberId, requesterName: bot.name }, (_context, operation, summary) => authorize(operation, summary))
    return { close: () => grant.close(), call: (tool, args) => tools.call(grant.connection.token, tool, args) }
  },
  createClient: (role, options) => {
    const clientOptions = { ...options, onToolCall: async (call: Parameters<typeof options.onToolCall>[0]) => {
      record({ kind: 'tool', role, tool: call.tool, ...(call.tool === 'router_decide' ? { decision: call.arguments.decision } : {}), ...(call.tool === 'work_ask_user' ? { directory: call.arguments.directory } : {}) })
      try { return await options.onToolCall(call) }
      catch (error) { record({ kind: 'tool_error', role, tool: call.tool, error: String(error) }); throw error }
    } }
    const client = platform === 'codex' ? new CodexAppServer(clientOptions) : new ClaudeRuntime(clientOptions)
    return {
      initialize: () => client.initialize(),
      startThread: async opts => { const id = await client.startThread(opts); if (role === 'worker') threads.push({ method: 'start', id, cwd: options.cwd }); return id },
      resumeThread: async (id, opts) => { const resumed = await client.resumeThread(id, opts); if (role === 'worker') threads.push({ method: 'resume', id: resumed, cwd: options.cwd }); return resumed },
      startTurn: (id, text, input) => client.startTurn(id, text, input),
      steer: (id, turn, text, input) => client.steer(id, turn, text, input),
      interrupt: (id, turn) => client.interrupt(id, turn), close: () => client.close(),
    }
  },
})
const send = (seq: number, text: string) => runtime.receive(bot.botId, { groupId: bot.groupId, seq, text, senderId: bot.ownerPhoneId, memberId: 'owner-member', createdAt: Date.now() })
async function until(check: () => boolean, phase: string): Promise<void> {
  const end = Date.now() + 180_000
  while (!check()) {
    const failed = store.failedInputs(bot.botId)[0]?.error ?? store.tasks(bot.botId).find(t => t.state === 'failed')?.error
    if (failed) throw new Error(`${phase}: ${failed}`)
    if (Date.now() > end) throw new Error(`${phase}: 超时，${store.settings(bot.botId).error ?? '未完成预期步骤'}`)
    await Bun.sleep(200)
  }
}
try {
  record({ kind: 'start', root, platform, scenario: manual ? 'manual-directory-resume' : 'chat-directory-approval' })
  send(1, `请把相邻后端 ${target} 的 enabled 从 false 改为 true，note 保持原值。当前工作目录是 frontend，不能先写目录外文件；如果需要修改工作目录，请明确申请改为共同父目录 ${project}，等我确认后再修改。只做这一处配置修改，读回校验后文字告诉我结果即可，不创建报告、不提交、不发布。`)
  await until(() => {
    const task = store.tasks(bot.botId)[0]
    return task?.state === 'waiting_user' && !!task.question?.directoryChange && store.runs(bot.botId).every(r => r.state === 'exited') && replies.some(r => r.purpose === 'question')
  }, '等待目录申请')
  const first = store.tasks(bot.botId)[0]
  if (first.question?.directoryChange?.toDirectory !== project) throw new Error('目录申请不是共同父目录')
  if (readFileSync(target, 'utf8') !== original || bot.policyRevision !== 1) throw new Error('owner 确认前发生目录或文件变更')
  record({ kind: 'proposal_pass', taskId: first.id, caseId: first.caseId, questionId: first.question.id })
  if (manual) {
    await runtime.control(bot.botId, bot.ownerPhoneId, { action: 'stop', taskId: first.id, expectedRevision: first.revision, requestId: 'manual-stop' })
    await until(() => { try { runtime.assertDirectoryChangeAllowed(bot.botId); return true } catch { return false } }, '等待目录设置入口空闲')
    bot.directory = bot.sourceCwd = resolveDirectory(project); bot.policyRevision++
    await runtime.policyChanged(bot.botId)
    if (threads.length !== 1 || readFileSync(target, 'utf8') !== original) throw new Error('仅修改目录就自动执行了旧任务')
    record({ kind: 'manual_directory_changed', directory: bot.directory, policyRevision: bot.policyRevision })
  }
  const constraint = manual ? undefined : send(2, '仍只修改 settings.json，禁止改其他文件')
  const confirmation = send(manual ? 2 : 3, manual ? '工作目录已经改了，继续吧' : '同意，继续')
  await until(() => store.task(first.id)?.state === 'completed' && store.runs(bot.botId).every(r => r.state === 'exited') && replies.some(r => r.taskId === first.id && r.purpose === 'result'), '等待确认后的原任务完成')
  const final = store.task(first.id)!
  const decision = store.inbox(confirmation.id)?.decision as { action?: string } | undefined
  const expectedAction = manual ? 'resume' : 'approve_directory'
  if (decision?.action !== expectedAction) throw new Error(`Router 未选择 ${expectedAction}：${decision?.action}`)
  if (store.tasks(bot.botId).length !== 1 || store.cases(bot.botId).length !== 1 || final.caseId !== first.caseId) throw new Error('目录确认拆了工单或卷宗')
  if (threads.length !== 2 || threads.some(t => t.method !== 'start') || threads[0].id === threads[1].id || threads[0].cwd !== frontend || threads[1].cwd !== project) throw new Error('目录确认后未在新目录新建 Worker Session')
  if (bot.directory !== project || final.mandate.directory !== project || final.mandate.policyRevision !== 2 || final.sessionOrigin !== 'new') throw new Error('新目录授权或 Session 来源未保存')
  if (constraint) {
    const input = store.inputs(final.id).find(i => i.inboxIds?.includes(constraint.id) && i.inboxIds.includes(confirmation.id))
    if (!input?.consumedAt || !input.resolution || !input.text.includes(constraint.text) || !input.text.includes(confirmation.text)) throw new Error('确认批次的限制没有完整送达、读取并处理')
  }
  const actual = JSON.parse(readFileSync(target, 'utf8'))
  if (actual.enabled !== true || actual.note !== 'keep-this-value' || Object.keys(actual).length !== 2) throw new Error('临时后端配置未正确修改')
  if (readdirSync(project).sort().join(',') !== 'backend,frontend' || readdirSync(frontend).join(',') !== 'README.md' || readdirSync(backend).join(',') !== 'settings.json' || readFileSync(join(frontend, 'README.md'), 'utf8') !== '这是临时验收项目；后端设置保存在相邻 backend/settings.json。\n') throw new Error('修改了目标配置以外的项目文件')
  record({ kind: 'pass', platform, scenario: manual ? 'manual-directory-resume' : 'chat-directory-approval', taskId: final.id, caseId: final.caseId, threads, file: target })
} catch (error) {
  process.exitCode = 1; record({ kind: 'failure', error: String(error) })
} finally {
  await runtime.close()
  writeFileSync(join(root, 'verification.json'), JSON.stringify({ events, threads, bot, cases: store.cases(bot.botId), tasks: store.tasks(bot.botId), replies: store.replies(bot.botId), inputs: store.messages(bot.botId) }, null, 2), { mode: 0o600 })
  store.close(); console.log(`Verification: ${join(root, 'verification.json')}`)
}
