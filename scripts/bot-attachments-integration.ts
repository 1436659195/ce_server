/** 真实模型附件验证：只用独立临时账本，不向他人发送消息。 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotToolService } from '../src/cli/bot-tools'
import type { RuntimeAttachment, RuntimeBot } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('请显式传入 --live 使用真实本机模型')
const root = mkdtempSync(join(tmpdir(), 'ce-attachment-live-'))
const store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
const bot: RuntimeBot = { botId: 'attachment-live-bot', name: '附件验证助理', groupId: 'local-dm', ownerPhoneId: 'test-owner', sourceCwd: root, directory: root, policyRevision: 1, platform: 'codex', commandSandbox: true, permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
store.saveSettings({ botId: bot.botId, mode: 'router-worker', revision: 1, profile: '根据用户提供的真实附件完成工作，文件通过聊天交付。', model: '', experiences: [] })
const toolService = new BotToolService({ endpoint: () => '', authorize: async () => { throw new Error('需要运行时授权') } })
const deliveries: RuntimeAttachment[] = []
const runtime = new BotRuntimeService({ store, rootDir: root, getBot: () => bot,
  sendReply: async reply => { const attachments = runtime.replyAttachments(reply); deliveries.push(...attachments); console.log(JSON.stringify({ author: reply.author, text: reply.text, attachments: attachments.map(a => ({ name: a.name, mime: a.mime })) })) },
  checkAccess: async () => ({ directory: root, permissions: bot.permissions, revision: 1 }),
  openTools: (_bot, memberId, authorize) => {
    const grant = toolService.open({ name: bot.name, groupId: bot.groupId, memberId, requesterName: bot.name }, (_context, operation, summary) => authorize(operation, summary))
    return { call: (tool, args) => toolService.call(grant.connection.token, tool, args), close: () => grant.close() }
  },
})
function upload(name: string, bytes: Buffer): RuntimeAttachment {
  const first = runtime.upload(bot.botId, bot.ownerPhoneId, { action: 'begin', requestId: crypto.randomUUID(), name, mime: '', size: bytes.length }) as { id: string }
  for (let offset = 0; offset < bytes.length; offset += 262144) runtime.upload(bot.botId, bot.ownerPhoneId, { action: 'chunk', uploadId: first.id, offset, data: bytes.subarray(offset, offset + 262144).toString('base64') })
  return runtime.upload(bot.botId, bot.ownerPhoneId, { action: 'finish', uploadId: first.id, hash: createHash('sha256').update(bytes).digest('hex') }) as RuntimeAttachment
}
try {
  const image = upload('figure.png', readFileSync(join(import.meta.dir, '../../ce-platform-social/docs/plans/assets/android-runtime-fixture/figure.png')))
  const brief = upload('brief.txt', Buffer.from('这是一张软件验收用的示意图，不是论文数据。报告需要准确说明图上的四位数字、左右图形的颜色和形状，并说明图片用途。'))
  console.log(JSON.stringify({ root, stage: 'uploaded', files: [image.name, brief.name] }))
  runtime.receive(bot.botId, { groupId: bot.groupId, seq: 1, senderId: bot.ownerPhoneId, memberId: 'test-owner-member', text: '请读取我上传的说明和图片，根据实际看到的图写中文 report.html，并通过聊天把报告文件和原图一起发给我。只需使用附件和本地文件工具。', attachments: [brief, image], createdAt: Date.now() })
  const deadline = Date.now() + 240000
  while (!store.tasks(bot.botId).some(t => t.state === 'completed') || deliveries.length < 2) {
    const task = store.tasks(bot.botId).at(-1)
    if (task?.state === 'failed' || store.settings(bot.botId).error) throw new Error(task?.error ?? store.settings(bot.botId).error)
    if (Date.now() > deadline) throw new Error('真实附件验证超时')
    await Bun.sleep(500)
  }
  const report = deliveries.find(a => a.mime === 'text/html')
  const returnedImage = deliveries.find(a => a.mime === 'image/png')
  if (!report || !returnedImage) throw new Error('没有收到报告与图片附件')
  const html = runtime.files.bytes(bot, bot.ownerPhoneId, report).bytes.toString('utf8')
  if (!html.includes('4816') || !html.includes('红') || !html.includes('蓝')) throw new Error('报告未正确识别图片内容')
  if (returnedImage.hash !== image.hash) throw new Error('返回的图片与用户原图不同')
  console.log('PASS：上传文本与图片 → Worker 真实识图 → HTML 与原图作为附件交付；字节校验通过。')
} catch (error) { console.error((error as Error).message); process.exitCode = 1 }
finally {
  writeFileSync(join(root, 'verification.json'), JSON.stringify({ tasks: store.tasks(), operations: store.operations(), replies: store.replies(bot.botId), inbox: store.messages(bot.botId) }, null, 2), { mode: 0o600 })
  await runtime.close(); store.close(); console.log(`Verification: ${root}`)
}
