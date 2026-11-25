/** 本机真实 CC/Codex 验证；临时工作目录，回复仅记录到本地，不发送社交消息。 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotToolService } from '../src/cli/bot-tools'
import { CodexAppServer } from '../src/cli/bot-runtime/codex'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('真实模型验证需要 --live')
const root = mkdtempSync(join(tmpdir(), 'ce-full-access-live-'))
const trace: unknown[] = []
const record = (event: Record<string, unknown>) => { trace.push(event); console.log(JSON.stringify(event)) }
async function verify(platform: 'codex' | 'claude') {
  const dir = join(root, platform); const project = join(dir, 'project'); mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'input.txt'), '这是一个独立验收项目。报告需要包含“原生工具验证”。\n' + 'sample '.repeat(35000))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: platform, name: '验证助理', groupId: 'local', ownerPhoneId: 'owner', sourceCwd: project, directory: project,
    platform, policyRevision: 1, commandSandbox: false, workerAccessMode: 'full-access',
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'allow', execute: 'allow', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ ...store.settings(platform), mode: 'router-worker', revision: 1 })
  const tools = new BotToolService({ endpoint: () => '', authorize: async () => { throw new Error('使用工单授权') } })
  const replies: RuntimeReply[] = []; const threads: string[] = []; const starts: string[] = []
  let shells = 0
  const runtime = new BotRuntimeService({ store, rootDir: dir, getBot: () => bot, routerQuietMs: 0,
    sendReply: async reply => { replies.push(reply); record({ platform, kind: 'reply', author: reply.author, attachments: reply.artifactIds?.length ?? 0 }) },
    checkAccess: async () => ({ directory: project, permissions: bot.permissions, revision: 1 }),
    openTools: (_bot, memberId, authorize) => {
      const grant = tools.open({ name: bot.name, groupId: bot.groupId, memberId, requesterName: bot.name }, (_context, operation, summary) => authorize(operation, summary))
      return { close: () => grant.close(), call: (tool, args) => tools.call(grant.connection.token, tool, args) }
    },
    createClient: (role, options) => {
      const traced = { ...options, onToolCall: async (call: Parameters<typeof options.onToolCall>[0]) => {
        record({ platform, kind: 'tool', role, tool: call.tool })
        return options.onToolCall(call)
      } }
      const client = platform === 'claude' ? new ClaudeRuntime(traced) : new CodexAppServer({ ...traced, onNotification: event => {
        if (role === 'worker' && event.method === 'item/started' && (event.params.item as { type?: string })?.type === 'commandExecution') { shells++; record({ platform, kind: 'native_shell' }) }
      } })
      return {
        initialize: () => client.initialize(),
        startThread: async p => { const id = await client.startThread(p); if (role === 'worker') { threads.push(id); starts.push('start') } return id },
        resumeThread: async (id, p) => { const resumed = await client.resumeThread(id, p); if (role === 'worker') { threads.push(resumed); starts.push('resume') } return resumed },
        startTurn: (id, text, input) => client.startTurn(id, text, input), steer: (id, turn, text, input) => client.steer(id, turn, text, input),
        interrupt: (id, turn) => client.interrupt(id, turn), close: () => client.close(),
      }
    },
  })
  const send = (seq: number, text: string) => runtime.receive(platform, { groupId: bot.groupId, seq, senderId: bot.ownerPhoneId, memberId: 'owner-member', text, createdAt: Date.now() })
  async function until(check: () => boolean) {
    const deadline = Date.now() + 180000
    while (!check()) {
      const failed = store.tasks(platform).find(t => t.state === 'failed')
      if (failed || store.settings(platform).error) throw new Error(failed?.error ?? store.settings(platform).error)
      if (Date.now() > deadline) throw new Error('验证超时')
      await Bun.sleep(300)
    }
  }
  try {
    send(1, '请用原生 Shell 执行 Python，读取 input.txt（超过200000字节），把实际 cwd 和文件字节数写入 probe.json，再生成简短 report.html，包含材料第一句话和“原生工具验证”，并把 HTML 文件发给我。所有输出都留在工作目录。')
    await until(() => store.tasks(platform).some(t => t.state === 'completed') && replies.some(r => r.artifactIds?.length))
    const task = store.tasks(platform)[0]
    const probe = JSON.parse(readFileSync(join(project, 'probe.json'), 'utf8'))
    if (!JSON.stringify(probe).includes(project) || !JSON.stringify(probe).includes(String(readFileSync(join(project, 'input.txt')).length))) throw new Error('原生 Shell 读取或工作目录不符')
    if (task.mandate.executionMode !== 'full-access' || !task.mandate.safetyInstructions?.includes('不要更改工作目录之外的任何文件')) throw new Error('工单缺少软隔离')
    const first = store.artifacts(platform).find(a => a.name === 'report.html')
    if (!first || !readFileSync(first.path, 'utf8').includes('原生工具验证')) throw new Error('报告内容不符')
    send(2, '把刚才的 report.html 增加一句“继续同一卷宗验证”，再把修改后的文件发给我。')
    await until(() => store.tasks(platform).filter(t => t.state === 'completed').length === 2 && replies.filter(r => r.artifactIds?.length).length === 2)
    if (starts.join(',') !== 'start,resume' || threads[0] !== threads[1]) throw new Error('没有恢复同一卷宗会话')
    if (platform === 'codex' && shells === 0) throw new Error('没有观察到原生 Shell')
    if (replies.some(r => r.author !== 'router')) throw new Error('结果绕过了 Router')
    record({ platform, kind: 'pass', nativeShellsObserved: shells, starts, inputBytes: readFileSync(join(project, 'input.txt')).length })
  } finally { await runtime.close(); store.close() }
}
const results = await Promise.allSettled((['codex', 'claude'] as const).map(verify))
for (let i = 0; i < results.length; i++) if (results[i].status === 'rejected') { process.exitCode = 1; record({ platform: ['codex', 'claude'][i], kind: 'failure', error: String((results[i] as PromiseRejectedResult).reason) }) }
writeFileSync(join(root, 'trace.json'), JSON.stringify(trace, null, 2), { mode: 0o600 })
console.log(`Trace: ${join(root, 'trace.json')}`)
