import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FULL_ACCESS_WORKER_TOOLS, REMOTE_WORKER_TOOLS } from '../src/cli/bot-runtime/service'
import { BotRuntimeService, type RuntimeClient } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RemoteChannel, RemoteRunResult, RemoteTicket } from '../src/cli/bot-runtime/remote-shell'
import type { CodexToolCall, CodexTurn } from '../src/cli/bot-runtime/codex'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'
import { routerCall } from './helpers/router-decision'
import { silentMemoryClient } from './helpers/model-client'

// 「其他电脑」:数字人挂了电脑才有远程工具;命令逐条审计;票据与密钥不进模型上下文。

const COMPUTER = { id: 'grant_abc123def456', label: '运维@机器B', directory: '/proj', directoryAbs: '/srv/b' }
const TICKET: RemoteTicket = { grantId: 'grant_abc123def456', key: 'secret-key', peerId: 'grant-abc123def456', relayUrl: 'ws://relay.test', sid: 's1', cliPub: 'pub', token: 'tok' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
async function until(check: () => boolean) { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true) }

function fixture(withComputer: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-bot-remote-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'b', name: '小林', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: dir, directory: dir, permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'allow', execute: 'allow', commanders: 'owner', allowedPhoneIds: [] }, policyRevision: 1, commandSandbox: false, workerAccessMode: 'full-access', platform: 'claude',
    ...(withComputer ? { computers: [COMPUTER] } : {}) }
  const sent: RuntimeReply[] = []
  const routerContexts: any[] = []
  const channelCalls: Array<Record<string, unknown>> = []
  const replies = new Map<string, string[]>()
  let workerTool: ((call: CodexToolCall) => Promise<unknown>) | undefined
  const service = new BotRuntimeService({
    store, rootDir: dir, routerQuietMs: 0, bubbleGapMs: 0, getBot: () => bot, sendReply: async r => { sent.push(r) },
    checkAccess: async () => { throw new Error('no local work') }, openTools: () => { throw new Error('no local work') },
    remoteTicket: (botId, computerId) => botId === 'b' && computerId === COMPUTER.id ? TICKET : undefined,
    createRemoteChannel: async () => {
      const channel: RemoteChannel & { emit: (t: string) => void } = {
        isOpen: true,
        onOutput: () => {},
        onControl: () => {}, onState: () => {},
        async rpc<T = unknown>(req: Record<string, unknown>): Promise<T> {
          channelCalls.push(req)
          if (req.op === 'listTerminals') return { ok: true, data: { terminals: [] } } as T
          if (req.op === 'createTerminal') return { ok: true, data: { name: '5', finger: 'f5' } } as T
          return { ok: true } as T
        },
        attach: () => {},
        stdin: (_name, text) => {
          const m = /^echo "__CE_RDY_(op\d+)__\$\?"\r$/.exec(text)
          if (m) queueMicrotask(() => channel.emit(`__CE_RDY_${m[1]}__0\r\n`))
          else if (text.includes('pwd')) queueMicrotask(() => { channel.emit(`${text}\r\n`); channel.emit('/srv/b\r\n') })
          else queueMicrotask(() => { channel.emit(`${text}\r\n`); for (const l of replies.get(text.slice(0, -1)) ?? []) channel.emit(`${l}\r\n`) })
        },
        close: () => { ;(channel as { isOpen: boolean }).isOpen = false },
        emit: (text: string) => channel.onOutput('5', text),
      } as RemoteChannel & { emit: (t: string) => void }
      return channel
    },
    createClient: (role, options) => {
      if (role === 'memory') return silentMemoryClient()
      if (role === 'worker') {
        workerTool = call => options.onToolCall(call)
        let workerDone!: (turn: CodexTurn) => void
        const done = new Promise<CodexTurn>(r => { workerDone = r })
        return { initialize: async () => {}, startThread: async () => 'worker-thread', resumeThread: async id => id,
          startTurn: async () => ({ threadId: 'worker-thread', turnId: 'wt', done }),
          steer: async () => 'wt', interrupt: async () => { workerDone({ id: 'wt', status: 'interrupted' }) }, close: async () => {} }
      }
      void routerContexts
      let routerDone!: (turn: CodexTurn) => void
      const done = new Promise<CodexTurn>(r => { routerDone = r })
      return { initialize: async () => {}, startThread: async () => 'thread', resumeThread: async id => id,
        startTurn: async (threadId, text) => {
          routerContexts.push(JSON.parse(text))
          queueMicrotask(async () => {
            await options.onToolCall({ threadId, turnId: 'rt', callId: 'rc', tool: 'router_decide', arguments: routerCall({ action: 'start', feasibility: 'can', newCase: { title: '远程', object: '机器B', goal: '看目录' }, goal: '在另一台电脑上看看目录', delivery: 'chat', allowedOps: ['read'] }) })
            routerDone({ id: 'rt', status: 'completed' })
          })
          return { threadId, turnId: 'rt', done }
        }, steer: async () => 'rt', interrupt: async () => {}, close: async () => {} } as RuntimeClient
    },
  })
  store.saveSettings({ ...store.settings('b'), mode: 'router-worker', revision: 1, profile: '负责运维。' })
  cleanups.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const send = (text: string) => service.receive('b', { groupId: 'dm', seq: Math.floor(Math.random() * 1e6), text, senderId: 'owner', memberId: 'om', createdAt: Date.now() })
  const call = async (tool: string, args: Record<string, unknown>) => {
    await until(() => workerTool !== undefined)
    return workerTool!({ tool, arguments: args, threadId: 'worker-thread', turnId: 'wt', callId: 'c1' } as CodexToolCall)
  }
  return { store, service, sent, routerContexts, channelCalls, replies, send, call }
}

test('挂了电脑的数字人才有远程工具;没挂的没有;和基础工具不重名', () => {
  const base = FULL_ACCESS_WORKER_TOOLS.map(t => t.name)
  expect(REMOTE_WORKER_TOOLS.map(t => t.name)).toEqual(['remote_run', 'remote_poll', 'remote_input', 'remote_close'])
  expect(base.some(n => n.startsWith('remote_'))).toBe(false)
})

test('远程执行:真实链路(会话开在授权目录、命令审计、结果带回退出码)', async () => {
  const f = fixture(true)
  const message = f.send('在另一台电脑上看看目录')
  await until(() => f.store.task(f.store.tasks('b')[0]?.id ?? '') !== undefined)
  const result = await f.call('remote_run', { computerId: COMPUTER.id, command: 'ls -1', waitMs: 100 }) as RemoteRunResult
  expect(result.state).toBe('done'); expect(result.exitCode).toBe(0)
  expect(f.channelCalls.some(c => c.op === 'createTerminal' && c.cwd === '/proj')).toBe(true)
  expect(f.store.inbox(message.id)?.state).toBe('routed')
  const ops = f.store.remoteOps('b')
  expect(ops).toHaveLength(1)
  expect(ops[0]).toMatchObject({ computerId: COMPUTER.id, command: 'ls -1', state: 'done', exitCode: 0, computerLabel: COMPUTER.label, directory: '/proj' })
  expect(JSON.stringify(ops)).not.toContain('secret-key')
  await f.call('remote_close', { computerId: COMPUTER.id })
  expect(f.channelCalls.filter(c => c.op === 'deleteTerminal')).toHaveLength(1) // close 时关掉对端上的终端(开会话时没有遗留)
})

test('上下文不带票据与密钥;未授权的 computerId 如实报错', async () => {
  const f = fixture(true)
  f.send('在另一台电脑上看看目录')
  await until(() => f.routerContexts.length > 0)
  const raw = JSON.stringify(f.routerContexts.at(-1))
  expect(raw).not.toContain('secret-key'); expect(raw).not.toContain('ws://relay.test')
  expect(f.service.view('b', 'owner').remoteOps).toEqual([])
  await expect(f.call('remote_run', { computerId: 'grant_other', command: 'x' })).rejects.toThrow(/未授权/)
})

test('没挂电脑的数字人拿不到远程工具;运行时拿不到票据也如实报错', async () => {
  const f = fixture(false)
  f.send('在另一台电脑上看看目录')
  await until(() => f.routerContexts.length > 0)
  const raw = JSON.stringify(f.routerContexts.at(-1))
  expect(raw).not.toContain('remote_run')
  await expect(f.call('remote_run', { computerId: COMPUTER.id, command: 'x' })).rejects.toThrow(/未授权|票据/)
})

test('移除电脑会关掉它的远程会话;进行中的命令在重启后标 unknown', async () => {
  const f = fixture(true)
  f.send('在另一台电脑上看看目录')
  await until(() => f.store.tasks('b').length > 0)
  await f.call('remote_run', { computerId: COMPUTER.id, command: 'echo started', waitMs: 100 })
  await f.service.dropComputer('b', COMPUTER.id)
  expect(f.channelCalls.filter(c => c.op === 'deleteTerminal').length).toBeGreaterThanOrEqual(1) // dropComputer 关掉了会话终端
  // 已完成的命令不受重启恢复影响;进行中的才标 unknown
  expect(f.store.remoteOps('b')[0]).toMatchObject({ state: 'done', command: 'echo started' })
  f.store.saveRemoteOp({ id: 'rop_running', botId: 'b', taskId: f.store.tasks('b')[0]!.id, runId: 'run_x', computerId: COMPUTER.id, computerLabel: COMPUTER.label, directory: COMPUTER.directory, command: 'sleep 99', state: 'running', outputHead: '', outputChars: 0, createdAt: Date.now() })
  f.store.markRemoteOpsUnknown('b', '宿主重启，远程命令结果未知')
  expect(f.store.remoteOps('b').find(o => o.id === 'rop_running')).toMatchObject({ state: 'unknown', error: '宿主重启，远程命令结果未知' })
})
