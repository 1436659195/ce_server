/** Real local conversations only. A delivery gate reproduces slow inference at the user's measured gaps. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService, type RuntimeClient } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { CodexAppServer } from '../src/cli/bot-runtime/codex'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('需要 --live')
const root = mkdtempSync(join(tmpdir(), 'ce-chat-rhythm-live-'))
const trace: unknown[] = []
function record(value: Record<string, unknown>) { const item = { at: Date.now(), ...value }; trace.push(item); console.log(JSON.stringify(item)) }
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
async function verify(platform: 'codex' | 'claude') {
  const dir = join(root, platform); mkdirSync(dir)
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: platform, name: '小林', groupId: 'local-dm', ownerPhoneId: 'local-owner', platform, sourceCwd: dir, directory: dir, policyRevision: 1, commandSandbox: false,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'deny', execute: 'deny', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ ...store.settings(platform), mode: 'router-worker', revision: 1, profile: '你负责现场部署排障和文档整理。日常聊天自然简短，避免重复确认。' })
  const sent: RuntimeReply[] = []; let seq = 0; let clients = 0; let running = 0; let hold: ReturnType<typeof gate> | undefined
  let interject = false
  const service = new BotRuntimeService({ store, rootDir: dir, getBot: () => bot,
    checkAccess: async () => { throw new Error('no work in this test') }, openTools: () => { throw new Error('no work in this test') },
    sendReply: async r => {
      sent.push(r); record({ platform, kind: 'sent', text: r.text, inputId: r.inputId, group: r.replyGroupId })
      if (interject) { interject = false; send('第二点不用说了，这里结束，不用再回复。') }
    },
    createClient: (role, options) => {
      if (role !== 'router') throw new Error('聊天不应派工')
      clients++
      const observed = { ...options, onToolCall: async (call: Parameters<typeof options.onToolCall>[0]) => {
        if (call.tool === 'router_decide') await hold?.promise
        try { const result = await options.onToolCall(call); record({ platform, kind: 'tool', tool: call.tool, args: call.arguments, result }); return result }
        catch (e) { record({ platform, kind: 'tool_error', error: String(e) }); throw e }
      } }
      const client: RuntimeClient = platform === 'codex' ? new CodexAppServer(observed) : new ClaudeRuntime(observed)
      return { initialize: () => client.initialize(), startThread: p => client.startThread(p), resumeThread: (...a) => client.resumeThread(...a), steer: (...a) => client.steer(...a), interrupt: (...a) => client.interrupt(...a), close: () => client.close(),
        startTurn: async (...args) => {
          running++; record({ platform, kind: 'turn', ids: JSON.parse(args[1]).currentMessages.map((m: any) => m.id) })
          const turn = await client.startTurn(...args)
          return { ...turn, done: turn.done.finally(() => { running-- }) }
        } }
    } })
  function send(text: string) {
    const message = service.receive(platform, { groupId: bot.groupId, seq: ++seq, senderId: bot.ownerPhoneId, memberId: 'local-member', text, createdAt: Date.now() })
    record({ platform, kind: 'received', id: message.id, text }); return message
  }
  async function until(check: () => boolean) {
    const end = Date.now() + 90_000
    while (!check()) {
      if (store.settings(platform).error) throw new Error(`${platform}: ${store.settings(platform).error}`)
      if (Date.now() > end) throw new Error(`${platform}: timed out`)
      await Bun.sleep(100)
    }
  }
  try {
    hold = gate(); const quietFrom = Date.now(); const a = send('在吗'); await Bun.sleep(4476); const b = send('你当前工作是什么'); hold.release(); hold = undefined
    await until(() => store.inbox(a.id)?.state === 'routed' && store.inbox(b.id)?.state === 'routed' && running === 0)
    await until(() => store.pendingReplies(platform).length === 0)
    if (!sent.length || sent.some(r => r.inputId === a.id) || new Set(sent.map(r => r.replyGroupId)).size !== 1) throw new Error('未合并首组对话')
    // 默认安静期 3 秒：第一轮不能在 2.8 秒内开（线程启动耗时只会更晚）。
    const firstTurn = (trace as Array<{ kind: string; at: number }>).find(i => i.kind === 'turn' && i.at >= quietFrom)
    if (!firstTurn || firstTurn.at - quietFrom < 2800) throw new Error(`安静期不足 3 秒：${firstTurn ? firstTurn.at - quietFrom : 'no turn'}`)
    const before = sent.length
    hold = gate(); const c = send('好'); await Bun.sleep(2773); const d = send('不用确认了'); hold.release(); hold = undefined
    await until(() => store.inbox(c.id)?.state === 'routed' && store.inbox(d.id)?.state === 'routed' && running === 0)
    if (sent.length !== before || store.pendingReplies(platform).length) throw new Error('收尾仍追加确认')
    interject = true
    send('用两条短消息分别介绍：第一条你的工作范围，第二条你能帮我整理什么文档。')
    await until(() => !interject && !store.pendingInbox(platform).length && running === 0)
    await Bun.sleep(1000)
    if (sent.length !== before + 1 || store.pendingReplies(platform).length) throw new Error('插话后仍发送过时气泡')
    if (!store.replies(platform).some(r => r.state === 'cancelled')) throw new Error('没有验证到取消后续气泡')
    // 停止类整句不等安静期：会话已存在，应在 2 秒内开轮（正常要等 3 秒）。
    await until(() => store.pendingReplies(platform).length === 0)
    send('我想问问'); await Bun.sleep(400); const stopFrom = Date.now(); const stop = send('算了')
    await until(() => store.inbox(stop.id)?.state === 'routed' && running === 0)
    await until(() => store.pendingReplies(platform).length === 0)
    const stopTurn = (trace as Array<{ kind: string; at: number }>).find(i => i.kind === 'turn' && i.at >= stopFrom)
    if (!stopTurn || stopTurn.at - stopFrom > 2000) throw new Error(`停止语没有立即开轮：${stopTurn ? stopTurn.at - stopFrom : 'no turn'}`)
    // 连着发个不停：安静期永远到不了，12 秒封顶必须开轮。
    const capFrom = Date.now()
    for (let i = 0; i < 6; i++) { send(`闲聊一句 ${i}`); await Bun.sleep(2500) }
    await until(() => !store.pendingInbox(platform).length && running === 0)
    await until(() => store.pendingReplies(platform).length === 0)
    const capTurn = (trace as Array<{ kind: string; at: number }>).find(i => i.kind === 'turn' && i.at >= capFrom)
    const capWait = capTurn ? capTurn.at - capFrom : -1
    if (capWait < 11000 || capWait > 16000) throw new Error(`封顶等待不符：${capWait}`)
    record({ platform, kind: 'pass', clients, messages: store.messages(platform).length, replies: sent.length, tasks: store.tasks(platform).length, quietWaitMs: firstTurn.at - quietFrom, stopWaitMs: stopTurn.at - stopFrom, capWaitMs: capWait })
  } finally { hold?.release(); await service.close(); store.close() }
}
const chosen = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1]
const platforms: Array<'codex' | 'claude'> = chosen === 'codex' || chosen === 'claude' ? [chosen] : ['codex', 'claude']
const results = await Promise.allSettled(platforms.map(verify))
for (const r of results) if (r.status === 'rejected') { record({ kind: 'failure', error: String(r.reason) }); process.exitCode = 1 }
writeFileSync(join(root, 'trace.json'), JSON.stringify(trace, null, 2), { mode: 0o600 })
console.log(`Trace: ${join(root, 'trace.json')}`)
