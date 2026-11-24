/** Real Router + Worker: ask for progress during a blocked read, then deliver a file.
 * Uses isolated local conversations; never sends messages to a social user.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotToolService } from '../src/cli/bot-tools'
import { CodexAppServer } from '../src/cli/bot-runtime/codex'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('使用真实模型，请显式传入 --live')
const root = mkdtempSync(join(tmpdir(), 'ce-unified-outbox-live-'))
const trace: unknown[] = []
function record(event: Record<string, unknown>) { const entry = { at: Date.now(), ...event }; trace.push(entry); console.log(JSON.stringify(entry)) }
async function verify(platform: 'codex' | 'claude') {
  const dir = join(root, platform); mkdirSync(dir)
  writeFileSync(join(dir, 'paper.txt'), '论文 A 提出通过语义缓存减少重复的意图识别调用。缓存命中可以省去一次推理。局限：尚未验证长期语义漂移，也没有提供生产环境性能数据。')
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: platform, name: '验收助理', groupId: 'local-dm', ownerPhoneId: 'local-owner', sourceCwd: dir, directory: dir, platform, policyRevision: 1, commandSandbox: true,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'allow', execute: 'allow', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ ...store.settings(platform), mode: 'router-worker', revision: 1, profile: '简短自然，不重复说受理话。用户问进度就请原 Worker 依据已知事实优先回答，并继续原任务。' })
  const toolService = new BotToolService({ endpoint: () => '', authorize: async () => { throw new Error('必须经运行时授权') } })
  const replies: RuntimeReply[] = []
  let unblock!: () => void
  const readGate = new Promise<void>(r => { unblock = r })
  let blocked = false; let workerClients = 0
  const runtime = new BotRuntimeService({ store, rootDir: dir, getBot: () => bot,
    sendReply: async reply => { replies.push(reply); record({ platform, kind: 'reply', author: reply.author, purpose: reply.purpose, text: reply.text, attachmentCount: reply.artifactIds?.length ?? 0 }) },
    checkAccess: async () => ({ directory: dir, permissions: bot.permissions, revision: 1 }),
    createClient: (role, options) => {
      if (role === 'worker') workerClients++
      record({ platform, kind: 'client_created', role })
      const traced = { ...options, onToolCall: async (call: Parameters<typeof options.onToolCall>[0]) => {
        record({ platform, kind: 'tool_call', role, tool: call.tool, ...(call.tool === 'router_decide' ? { action: call.arguments.action, allowedOps: call.arguments.allowedOps, sourceInputIds: call.arguments.sourceInputIds } : {}) })
        try { return await options.onToolCall(call) }
        catch (error) { record({ platform, kind: 'tool_rejected', role, tool: call.tool, error: error instanceof Error ? error.message : 'tool failed' }); throw error }
      } }
      return platform === 'claude' ? new ClaudeRuntime(traced) : new CodexAppServer({ ...traced, onNotification: event => {
        if (event.method === 'turn/started' || event.method === 'turn/completed') record({ platform, kind: 'model_event', role, method: event.method })
      } })
    },
    openTools: (_bot, memberId, authorize) => {
      const grant = toolService.open({ name: bot.name, groupId: bot.groupId, memberId, requesterName: bot.name }, (_context, operation, summary) => authorize(operation, summary))
      return { close: () => grant.close(), call: async (tool, args) => {
        if (tool === 'read_file' && String(args.path).endsWith('paper.txt') && !blocked) {
          blocked = true; record({ platform, kind: 'read_waiting' }); await readGate
        }
        return toolService.call(grant.connection.token, tool, args)
      } }
    },
  })
  const send = (seq: number, text: string) => runtime.receive(platform, { groupId: bot.groupId, seq, senderId: bot.ownerPhoneId, memberId: 'local-owner-member', text, createdAt: Date.now() })
  async function until(check: () => boolean, limitMs = 150_000) {
    const end = Date.now() + limitMs
    while (!check()) {
      const task = store.tasks(platform)[0]
      if (store.settings(platform).error || task?.state === 'failed') throw new Error(`${platform}: ${store.settings(platform).error ?? task?.error}`)
      if (Date.now() > end) throw new Error(`${platform}: 等待超时，任务状态 ${task?.state}`)
      await Bun.sleep(200)
    }
  }
  try {
    send(1, '请用文件读取工具打开 paper.txt，写一份简短 HTML 论文解读报告，保存为 report.html，并把实际文件发给我。若读取还在后台执行，等返回后再写，不要重复发起读取。')
    await until(() => blocked)
    const task = store.tasks(platform)[0]; const run = store.runs(platform)[0]
    const progress = send(2, '现在做到哪了？请先告诉我已经完成了什么、正在等什么，再继续原来的报告。')
    await until(() => replies.some(r => r.author === 'worker' && r.purpose === 'answer' && r.inputId === progress.id), 90_000)
    const addition = store.inputs(task.id).find(i => i.inboxId === progress.id)
    if (addition?.kind !== 'ask_worker' || workerClients !== 1 || store.tasks(platform).length !== 1) throw new Error(`${platform}: 追问没有进入原 Worker`)
    if (!store.operations(task.id).some(o => o.tool === 'read_file' && o.state === 'running')) throw new Error(`${platform}: 没有在工具运行时回答`)
    if (store.task(task.id)?.state !== 'running' || store.runs(platform)[0].id !== run.id) throw new Error(`${platform}: 追问中断了原任务`)
    record({ platform, kind: 'progress_while_working_verified', taskId: task.id, workerClients })
    unblock()
    await until(() => store.task(task.id)?.state === 'completed')
    await runtime.flush(platform)
    const result = replies.find(r => r.purpose === 'result')
    if (!result?.artifactIds?.length) throw new Error(`${platform}: 没有交付附件`)
    const artifact = store.artifact(result.artifactIds[0])!
    const body = readFileSync(artifact.path, 'utf8')
    if (!/语义|缓存/.test(body) || !/<(?:html|!doctype)/i.test(body)) throw new Error(`${platform}: 交付文件内容不符合要求`)
    const count = replies.length
    await runtime.flush(platform)
    if (replies.length !== count || new Set(replies.map(r => r.id)).size !== count) throw new Error(`${platform}: 回复重复发送`)
    if (workerClients !== 1 || !store.inputs(task.id).every(i => i.consumedAt && i.resolution)) throw new Error(`${platform}: 没有在原 Worker 中处理完追问`)
    record({ platform, kind: 'pass', replyCount: replies.length, workerClients, artifact: artifact.name, bytes: artifact.size })
  } catch (error) {
    record({ platform, kind: 'failure', error: String(error), tasks: store.tasks(platform).map(t => ({ id: t.id, state: t.state, error: t.error })), failedInputs: store.failedInputs(platform).map(i => ({ id: i.id, error: i.error })) })
    throw error
  } finally { unblock(); await runtime.close(); store.close() }
}
const requested = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1]
const platforms: Array<'codex' | 'claude'> = requested === 'codex' || requested === 'claude' ? [requested] : ['codex', 'claude']
const results = await Promise.allSettled(platforms.map(verify))
if (results.some(r => r.status === 'rejected')) process.exitCode = 1
writeFileSync(join(root, 'trace.json'), JSON.stringify(trace, null, 2), { mode: 0o600 })
console.log(`Trace: ${join(root, 'trace.json')}`)
