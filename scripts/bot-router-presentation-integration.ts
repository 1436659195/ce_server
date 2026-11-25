/** 真实前台模型表达验收：只使用虚构资料与独立账本，不连接社交用户。 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('使用真实模型，请传 --live')
const root = mkdtempSync(join(tmpdir(), 'ce-router-presentation-'))
const requested = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1]
const platforms: Array<'codex' | 'claude'> = requested === 'claude' ? ['claude'] : requested === 'codex' ? ['codex'] : ['codex', 'claude']
for (const platform of platforms) {
  const dir = join(root, platform)
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: platform, name: '示例同事', groupId: 'local-dm', ownerPhoneId: 'local-owner', sourceCwd: dir, directory: dir, platform, policyRevision: 1, commandSandbox: false,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ ...store.settings(platform), mode: 'router-worker', revision: 1, profile: '像同事一样自然聊天，直接回答用户想知道的事情。' })
  const first = store.receive({ botId: platform, groupId: bot.groupId, seq: 1, senderId: bot.ownerPhoneId, memberId: 'local-member', text: '示例引擎是什么？', createdAt: Date.now() })
  const second = store.receive({ ...first, seq: 2, text: '和示例控制台有啥关系？' })
  const task = store.acceptWork({ inputId: second.id, inputIds: [first.id, second.id], newCase: { title: '示例产品', object: '示例产品', goal: '理解产品关系' }, goal: '解释示例引擎的功能及与示例控制台的关系', acceptance: [], replies: [], delivery: 'chat',
    mandate: { ownerPhoneId: bot.ownerPhoneId, directory: dir, policyRevision: 1, allowedOps: ['read'], exclusions: [], mode: 'execute' } })
  store.updateTask(task.id, { state: 'running' })
  store.finishTask(task.id, 1, '示例引擎负责理解问题、识别意图和检索知识；示例控制台是使用它的管理界面。别名及版本沿革未确认。来源：虚构产品手册§3.4。', [])
  const source = store.pendingReplies(platform)[0]
  const sent: RuntimeReply[] = []
  const runtime = new BotRuntimeService({ store, rootDir: dir, getBot: () => bot,
    sendReply: async reply => { sent.push(reply) },
    checkAccess: async () => { throw new Error('此验收不执行项目操作') }, openTools: () => { throw new Error('此验收不创建Worker') },
  })
  try {
    await runtime.flush(platform)
    const deadline = Date.now() + 90_000
    while (!sent.length) {
      if (Date.now() > deadline) throw new Error(`${platform}: 表达验收超时：${store.settings(platform).error ?? ''}`)
      await Bun.sleep(100)
    }
    const text = sent.map(r => r.text).join('')
    if (sent.some(r => r.author !== 'router' || r.sourceReplyId !== source.id)) throw new Error('结果没有经过Router')
    if (/来源|§|版本沿革|未确认|Router|Worker/.test(text)) throw new Error(`仍夹带无关报告话术：${text}`)
    if (!text.includes('引擎') || !text.includes('控制台')) throw new Error(`遗漏了实际问题：${text}`)
    console.log(JSON.stringify({ platform, status: 'pass', text }))
  } catch (error) { console.error(String(error)); process.exitCode = 1 }
  finally {
    writeFileSync(join(dir, 'verification.json'), JSON.stringify({ replies: store.replies(platform), error: store.settings(platform).error }, null, 2), { mode: 0o600 })
    await runtime.close(); store.close()
  }
}
console.log(`Verification: ${root}`)
