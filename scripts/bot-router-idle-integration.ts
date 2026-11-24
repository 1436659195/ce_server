/** Real Codex + CC keepalive verification, using isolated local chats and no social sends. */
import { mkdtempSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService, ROUTER_IDLE_MS, type RuntimeClient } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { CodexAppServer } from '../src/cli/bot-runtime/codex'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import type { RuntimeBot } from '../src/cli/bot-runtime/types'

if (!process.argv.includes('--live')) throw new Error('使用真实模型，请显式传入 --live')
const root = mkdtempSync(join(tmpdir(), 'ce-router-idle-live-'))
const trace: unknown[] = []
function record(value: Record<string, unknown>) { const entry = { at: Date.now(), ...value }; trace.push(entry); console.log(JSON.stringify(entry)) }
function pids(cwd: string) {
  return readdirSync('/proc').filter(p => /^\d+$/.test(p)).filter(p => {
    try { return readlinkSync(`/proc/${p}/cwd`) === cwd } catch { return false }
  }).map(Number).sort((a, b) => a - b)
}
async function verify(platform: 'codex' | 'claude') {
  const dir = join(root, platform)
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: platform, name: '保活验收', groupId: 'local-dm', ownerPhoneId: 'local-owner', platform, sourceCwd: dir, directory: dir, policyRevision: 1, commandSandbox: true,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'ask', execute: 'ask', commanders: 'owner', allowedPhoneIds: [] } }
  store.saveSettings({ ...store.settings(platform), mode: 'router-worker', revision: 1, profile: '自然简短聊天。' })
  const leases: Array<{ closed: boolean; finished: number; cwd: string; thread?: string; doneAt?: number }> = []
  const service = new BotRuntimeService({ store, rootDir: dir, getBot: () => bot,
    sendReply: async r => { record({ platform, kind: 'reply', text: r.text }) },
    checkAccess: async () => { throw new Error('本验收不使用项目工具') }, openTools: () => { throw new Error('本验收不派 Worker') },
    createClient: (role, options) => {
      if (role !== 'router') throw new Error('闲聊不应派 Worker')
      const lease = { closed: false, finished: 0, cwd: options.cwd, thread: undefined as string | undefined, doneAt: undefined as number | undefined }
      leases.push(lease)
      const c: RuntimeClient = platform === 'codex' ? new CodexAppServer(options) : new ClaudeRuntime(options)
      return {
        initialize: () => c.initialize(), resumeThread: (...args) => c.resumeThread(...args), steer: (...args) => c.steer(...args), interrupt: (...args) => c.interrupt(...args),
        startThread: async args => { lease.thread = await c.startThread(args); return lease.thread },
        startTurn: async (...args) => {
          const turn = await c.startTurn(...args)
          return { ...turn, done: turn.done.then(result => { lease.finished++; lease.doneAt = Date.now(); record({ platform, kind: 'turn_done', client: leases.indexOf(lease), thread: lease.thread, pids: pids(lease.cwd), status: result.status }); return result }) }
        },
        close: async () => { await c.close(); lease.closed = true; record({ platform, kind: 'closed', client: leases.indexOf(lease), idleMs: lease.doneAt ? Date.now() - lease.doneAt : undefined, pids: pids(lease.cwd) }) },
      }
    },
  })
  async function until(check: () => boolean, maxMs = 45_000) {
    const end = Date.now() + maxMs
    while (!check()) {
      if (store.settings(platform).error) throw new Error(`${platform}: ${store.settings(platform).error}`)
      if (Date.now() > end) throw new Error(`${platform}: 等待超时`)
      await Bun.sleep(200)
    }
  }
  const send = (seq: number, text: string) => service.receive(platform, { groupId: bot.groupId, seq, senderId: bot.ownerPhoneId, memberId: 'local-owner-member', text, createdAt: Date.now() })
  try {
    send(1, '嗨，我叫小舟，今天来跟你打个招呼。')
    await until(() => leases[0]?.finished === 1)
    const firstPids = pids(leases[0].cwd)
    if (!firstPids.length) throw new Error(`${platform}: 第一轮结束进程已消失`)
    await Bun.sleep(2000)
    send(2, '还记得我刚才说我叫什么吗？')
    await until(() => leases[0]?.finished === 2)
    if (leases.length !== 1 || JSON.stringify(pids(leases[0].cwd)) !== JSON.stringify(firstPids)) throw new Error(`${platform}: 未复用同一进程`)
    record({ platform, kind: 'reuse_verified', pids: firstPids })
    await until(() => leases[0].closed, ROUTER_IDLE_MS + 5000)
    if (leases[0].doneAt && Date.now() - leases[0].doneAt! < ROUTER_IDLE_MS) throw new Error(`${platform}: 过早释放`)
    send(3, '过会儿又来找你聊两句，你好呀。')
    await until(() => leases[1]?.finished === 1)
    if (leases.length !== 2) throw new Error(`${platform}: 释放后没有重新建立连接`)
    record({ platform, kind: 'pass', newPids: pids(leases[1].cwd) })
  } finally { await service.close(); store.close() }
}
const results = await Promise.allSettled([verify('codex'), verify('claude')])
for (const r of results) if (r.status === 'rejected') { record({ kind: 'failure', error: String(r.reason) }); process.exitCode = 1 }
writeFileSync(join(root, 'trace.json'), JSON.stringify(trace, null, 2), { mode: 0o600 })
console.log(`Trace: ${join(root, 'trace.json')}`)
