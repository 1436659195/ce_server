/** 真实模型三轮验收；仅临时项目、临时账本、本地回复，不发送社交消息。 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotToolService } from '../src/cli/bot-tools'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import { CodexAppServer } from '../src/cli/bot-runtime/codex'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('使用真实模型须传 --live')
const platform = process.argv.includes('--codex') ? 'codex' : 'claude'
const root = mkdtempSync(join(tmpdir(), `ce-case-live-${platform}-`))
const project = join(root, 'project'); mkdirSync(project)
const original = '# 原设计\n\n系统仅支持密码登录，登录态保留 24 小时。导出只支持 CSV。\n'
writeFileSync(join(project, 'design.md'), original)
writeFileSync(join(project, 'implementation.ts'), "export const loginMethods = ['password', 'passkey'];\nexport const sessionHours = 12;\nexport const exportFormats = ['csv', 'json'];\n")
const store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
const bot: RuntimeBot = { botId: 'case-live', name: '文档助理', groupId: 'local-dm', ownerPhoneId: 'local-owner', sourceCwd: project, directory: project, platform, policyRevision: 1, commandSandbox: false, workerAccessMode: 'full-access',
  permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'allow', execute: 'allow', commanders: 'owner', allowedPhoneIds: [] } }
store.saveSettings({ ...store.settings(bot.botId), mode: 'router-worker', revision: 1, profile: '负责这个示例项目的文档工作。简明回答，依据文件实际内容。' })
const replies: RuntimeReply[] = []; const threads: Array<{ method: string; id: string }> = []; const events: unknown[] = []
const record = (event: Record<string, unknown>) => { events.push(event); console.log(JSON.stringify(event)) }
const tools = new BotToolService({ endpoint: () => '', authorize: async () => { throw new Error('使用工单授权') } })
const runtime = new BotRuntimeService({ store, rootDir: root, getBot: () => bot, routerQuietMs: 0,
  sendReply: async reply => { replies.push(reply); record({ kind: 'reply', text: reply.text, artifacts: reply.artifactIds }) },
  checkAccess: async () => ({ directory: project, permissions: bot.permissions, revision: bot.policyRevision }),
  openTools: (_bot, memberId, authorize) => {
    const grant = tools.open({ name: bot.name, groupId: bot.groupId, memberId, requesterName: bot.name }, (_context, operation, summary) => authorize(operation, summary))
    return { close: () => grant.close(), call: (tool, args) => tools.call(grant.connection.token, tool, args) }
  },
  createClient: (role, options) => {
    const traced = { ...options, onToolCall: async (call: Parameters<typeof options.onToolCall>[0]) => {
      record({ kind: 'tool', role, tool: call.tool, ...(call.tool === 'router_decide' ? { decision: call.arguments.decision } : {}) })
      try { return await options.onToolCall(call) } catch (error) { record({ kind: 'tool_error', tool: call.tool, error: String(error) }); throw error }
    } }
    const client = platform === 'claude' ? new ClaudeRuntime(traced) : new CodexAppServer(traced)
    return { initialize: () => client.initialize(),
      startThread: async options => { const id = await client.startThread(options); if (role === 'worker') threads.push({ method: 'start', id }); return id },
      resumeThread: async (id, options) => { const resumed = await client.resumeThread(id, options); if (role === 'worker') threads.push({ method: 'resume', id: resumed }); return resumed },
      startTurn: (id, text, input) => client.startTurn(id, text, input), steer: (id, turn, text, input) => client.steer(id, turn, text, input), interrupt: (id, turn) => client.interrupt(id, turn), close: () => client.close() }
  },
})
async function round(seq: number, text: string, files: boolean) {
  const input = runtime.receive(bot.botId, { groupId: bot.groupId, senderId: bot.ownerPhoneId, memberId: 'owner-member', seq, text, createdAt: Date.now() })
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    const task = store.tasks(bot.botId).find(t => t.originInputId === input.id)
    const failure = store.failedInputs(bot.botId)[0]?.error ?? (task?.state === 'failed' ? task.error : undefined)
    if (failure) throw new Error(failure)
    if (!files && !task && store.inbox(input.id)?.state === 'routed' && replies.some(r => r.inputId === input.id && r.purpose === 'chat')) {
      record({ kind: 'round_answered_from_context', seq }); return store.tasks(bot.botId).at(-1)!
    }
    if (task?.state === 'completed' && store.runs(bot.botId).filter(r => r.taskId === task.id).every(r => r.state === 'exited') && replies.some(r => r.taskId === task.id && r.purpose === 'result' && (!files || r.artifactIds?.length))) {
      record({ kind: 'round_complete', seq, taskId: task.id, caseId: task.caseId, sessionOrigin: task.sessionOrigin }); return task
    }
    await Bun.sleep(250)
  }
  throw new Error(`第 ${seq} 轮未完成：${store.settings(bot.botId).error ?? '超时或未派工'}`)
}
try {
  const first = await round(1, '根据这个项目的 implementation.ts，写个总结文档 summary.md 并发给我。', true)
  const second = await round(2, '这个文档和 design.md 设计文档哪里不一致？直接告诉我差异。', false)
  const third = await round(3, '不一致的地方你修改下设计文档，另存最新设计文档 design-latest.md，保留原文件，并把新文档发给我。', true)
  if (new Set([first.caseId, second.caseId, third.caseId]).size !== 1 || store.cases(bot.botId).length !== 1) throw new Error('三轮被拆为多个卷宗')
  if (threads[0]?.method !== 'start' || threads.slice(1).some(t => t.method !== 'resume') || threads.length < 2 || new Set(threads.map(t => t.id)).size !== 1) throw new Error('没有恢复同一 Session')
  if ((second.id !== first.id && second.sessionOrigin !== 'inherited') || third.sessionOrigin !== 'inherited') throw new Error('未记录实际续接状态')
  if (readFileSync(join(project, 'design.md'), 'utf8') !== original) throw new Error('原设计被覆盖')
  const final = readFileSync(join(project, 'design-latest.md'), 'utf8')
  if (!/passkey|通行密钥/i.test(final) || !final.includes('12') || !/json/i.test(final)) throw new Error('修订遗漏真实差异')
  const dossier = store.case(first.caseId)!
  if (dossier.aliases?.length && !store.findCases(bot.botId, dossier.aliases[0]).some(c => c.id === dossier.id)) throw new Error('旧名称不可检索')
  record({ kind: 'pass', platform, caseTitle: dossier.title, aliases: dossier.aliases, caseGoal: dossier.goal, threads })
} catch (error) { process.exitCode = 1; record({ kind: 'failure', error: String(error) }) }
finally {
  await runtime.close()
  writeFileSync(join(root, 'verification.json'), JSON.stringify({ events, threads, cases: store.cases(bot.botId), tasks: store.tasks(bot.botId), replies: store.replies(bot.botId), inputs: store.messages(bot.botId) }, null, 2), { mode: 0o600 })
  store.close(); console.log(`Verification: ${join(root, 'verification.json')}`)
}
