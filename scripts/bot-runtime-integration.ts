/** 显式 --live 的本机集成验证；只操作新建的临时项目，不发送真实社交消息。 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotToolService } from '../src/cli/bot-tools'
import type { RuntimeBot } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('此脚本使用真实模型，请显式传入 --live')
const root = mkdtempSync(join(tmpdir(), 'ce-bot-integration-'))
const store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
writeFileSync(join(root, 'paper.txt'), '论文 A：通过复用语义缓存降低重复意图识别延迟。样本为三千条营销对话，缓存命中时减少一次模型调用。尚未评估长期语义漂移，错误缓存可能误判意图。实测延迟为示例数据，不能推断实际生产性能。')
const bot: RuntimeBot = { botId: 'integration-bot', name: '验证助理', groupId: 'local-dm', ownerPhoneId: 'test-owner', sourceCwd: root, directory: root, policyRevision: 1, platform: 'codex', commandSandbox: true, permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'allow', execute: 'allow', commanders: 'owner', allowedPhoneIds: [] } }
store.saveSettings({ botId: bot.botId, mode: 'router-worker', revision: 1, profile: '认真核对材料和真实能力，未知事实不作保证。对合理补充及时处理。', model: '' })
const tools = new BotToolService({ endpoint: () => '', authorize: async () => { throw new Error('必须通过运行时操作授权') } })
const events: Array<Record<string, unknown>> = []
const runtime = new BotRuntimeService({ store, rootDir: root, getBot: () => bot,
  sendReply: async reply => { events.push({ kind: 'reply', at: Date.now(), author: reply.author, text: reply.text }); console.log(JSON.stringify(events.at(-1))) },
  checkAccess: async () => ({ directory: root, permissions: bot.permissions, revision: 1 }),
  openTools: (_bot, memberId, authorize) => {
    const grant = tools.open({ name: bot.name, groupId: bot.groupId, memberId, requesterName: bot.name }, (_context, op, summary) => authorize(op, summary))
    return { call: (tool, args) => tools.call(grant.connection.token, tool, args), close: () => grant.close() }
  },
})
const send = (seq: number, text: string) => runtime.receive(bot.botId, { groupId: bot.groupId, seq, text, senderId: bot.ownerPhoneId, memberId: 'test-member', createdAt: Date.now() })
async function until(check: () => boolean, limitMs = 180_000) {
  const end = Date.now() + limitMs
  while (!check()) {
    const task = store.tasks(bot.botId).at(-1)
    if (task?.state === 'failed' || store.settings(bot.botId).error) throw new Error(task?.error ?? store.settings(bot.botId).error)
    if (Date.now() > end) throw new Error('集成验证超时')
    await Bun.sleep(300)
  }
}
try {
  console.log(JSON.stringify({ root, kind: 'start' }))
  send(1, '请读取 paper.txt，先执行一条耗时约八秒的本地校验命令（sleep 8 即可），再写 paper-report.html 解读报告并交付文件。此任务允许读取、创建、修改、删除与执行本地命令。')
  await until(() => store.tasks(bot.botId).some(t => t.state === 'running'))
  const originalTask = store.tasks(bot.botId)[0]
  send(2, '给刚才的论文报告加一节“局限性”，明确指出长期语义漂移未验证。')
  await until(() => store.inputs(originalTask.id).some(i => !!i.consumedAt))
  events.push({ kind: 'consumed', at: Date.now(), inputs: store.inputs(originalTask.id), runs: store.runs(bot.botId) })
  send(3, '顺便问候一下，今天怎么样？')
  await until(() => store.inbox(store.messages(bot.botId).find(i => i.seq === 3)!.id)?.state === 'routed')
  await until(() => store.task(originalTask.id)?.state === 'completed')
  const artifacts = store.artifacts(bot.botId)
  if (!artifacts.length) throw new Error('没有交付文件')
  if (!readFileSync(artifacts[0].path, 'utf8').includes('语义漂移')) throw new Error('交付遗漏用户补充')
  events.push({ kind: 'complete', at: Date.now(), task: store.task(originalTask.id), artifacts: artifacts.map(({ path: _path, ...a }) => a) })
  console.log('PASS：同任务补充被读取、前台可闲聊、Worker 直接交付含补充的 HTML 文件')
} catch (error) {
  events.push({ kind: 'failure', error: (error as Error).message, tasks: store.tasks(), operations: store.operations(), inbox: store.messages(bot.botId), settings: store.settings(bot.botId) })
  console.error((error as Error).message); process.exitCode = 1
} finally {
  writeFileSync(join(root, 'trace.json'), JSON.stringify(events, null, 2), { mode: 0o600 })
  await runtime.close(); store.close()
  console.log(`Trace: ${join(root, 'trace.json')}`)
}
