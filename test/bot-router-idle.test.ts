import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService, type RuntimeClientOptions } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { CodexToolCall, CodexTurn } from '../src/cli/bot-runtime/codex'
import type { RuntimeBot } from '../src/cli/bot-runtime/types'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}
function fixture(idleMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-router-idle-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const bot: RuntimeBot = { botId: 'a', name: '小林', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: dir, directory: dir, platform: 'codex', policyRevision: 1, commandSandbox: true,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'ask', execute: 'ask', commanders: 'owner', allowedPhoneIds: [] } }
  const clients: Array<{ options: RuntimeClientOptions; closed: number; threads: number; inputs: any[]; calls: CodexToolCall[]; finish: (status?: string) => Promise<void> }> = []
  let auto = true
  let closeGate: Promise<void> | undefined
  const service = new BotRuntimeService({ routerQuietMs: 0, store, rootDir: dir, routerIdleMs: idleMs, getBot: id => ({ ...bot, botId: id }), sendReply: async () => {},
    checkAccess: async () => { throw new Error('no worker') }, openTools: () => { throw new Error('no worker') },
    createClient: (role, options) => {
      expect(role).toBe('router')
      let resolve: ((turn: CodexTurn) => void) | undefined
      const c = { options, closed: 0, threads: 0, inputs: [] as any[], calls: [] as CodexToolCall[], finish: async (_status = 'completed') => {} }
      clients.push(c)
      return {
        initialize: async () => {}, startThread: async () => { c.threads++; if (c.threads > 1) throw new Error('one thread per CC client'); return `thread-${clients.indexOf(c)}` }, resumeThread: async id => id,
        startTurn: async (threadId, text) => {
          const context = JSON.parse(text); c.inputs.push(context)
          const turnId = `turn-${c.inputs.length}`
          const call: CodexToolCall = { threadId, turnId, callId: turnId, tool: 'router_decide', arguments: { action: 'reply', feasibility: 'can', policyRevision: 1, replyText: `回复：${context.currentMessage.seq}` } }
          c.calls.push(call)
          const done = new Promise<CodexTurn>(r => { resolve = r })
          c.finish = async (status = 'completed') => {
            if (status === 'completed') await options.onToolCall(call)
            resolve?.({ id: turnId, status })
          }
          // A real adapter can deliver its first call before startTurn's promise settles.
          if (auto) void Promise.resolve().then(() => c.finish()).catch(() => resolve?.({ id: turnId, status: 'failed' }))
          return { threadId, turnId, done }
        },
        steer: async () => '', interrupt: async () => {}, close: async () => { c.closed++; resolve?.({ id: 'closed', status: 'interrupted' }); await closeGate },
      }
    },
  })
  for (const id of ['a', 'b']) store.saveSettings({ ...store.settings(id), mode: 'router-worker', revision: 1 })
  let seq = 0
  const send = (id = 'a', text = '聊两句') => service.receive(id, { groupId: 'dm', seq: ++seq, text, senderId: 'owner', memberId: 'owner-member', createdAt: Date.now() })
  cleanups.push(async () => { await service.close(); await Bun.sleep(5); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { service, store, bot, clients, send, manual: () => { auto = false }, delayClose: (promise: Promise<void>) => { closeGate = promise } }
}

test('默认一分钟保活，同 Bot 连续消息复用进程和会话，决策绑定当前输入', async () => {
  const f = fixture()
  const first = f.send(); await until(() => f.store.inbox(first.id)?.state === 'routed')
  await Bun.sleep(20)
  expect(f.clients[0].closed).toBe(0)
  const next = f.send(); await until(() => f.store.inbox(next.id)?.state === 'routed')
  expect(f.clients).toHaveLength(1)
  expect(f.clients[0].threads).toBe(1)
  expect(f.store.replies('a').map(r => [r.inputId, r.text])).toEqual([[first.id, '回复：1'], [next.id, '回复：2']])
})

test('新消息重置空闲计时，过期后下条消息才重新启动', async () => {
  const f = fixture(180)
  const first = f.send(); await until(() => f.store.inbox(first.id)?.state === 'routed')
  await Bun.sleep(100)
  const next = f.send(); await until(() => f.store.inbox(next.id)?.state === 'routed')
  await Bun.sleep(110)
  expect(f.clients).toHaveLength(1); expect(f.clients[0].closed).toBe(0)
  await until(() => f.clients[0].closed === 1)
  const last = f.send(); await until(() => f.store.inbox(last.id)?.state === 'routed')
  expect(f.clients).toHaveLength(2)
})

test('空闲计时不杀正在处理的轮次，处理途中到达的消息随即接续', async () => {
  const f = fixture(60)
  const first = f.send(); await until(() => f.store.inbox(first.id)?.state === 'routed')
  f.manual()
  const second = f.send(); await until(() => f.clients[0].inputs.length === 2)
  await Bun.sleep(100)
  expect(f.clients[0].closed).toBe(0)
  const third = f.send()
  await f.clients[0].finish()
  await until(() => f.clients[0].inputs.length === 3)
  await f.clients[0].finish()
  await until(() => f.store.inbox(third.id)?.state === 'routed')
  expect(f.store.inbox(second.id)?.state).toBe('routed'); expect(f.clients).toHaveLength(1)
})

test('拒绝上一轮迟到的工具调用，且不同 Bot 不共享进程', async () => {
  const f = fixture()
  const first = f.send(); await until(() => f.store.inbox(first.id)?.state === 'routed')
  f.manual()
  const next = f.send(); await until(() => f.clients[0].inputs.length === 2)
  await expect(f.clients[0].options.onToolCall({ ...f.clients[0].calls[0], arguments: { ...f.clients[0].calls[0].arguments, replyText: '迟到回复' } })).rejects.toThrow(/失效|轮次/)
  expect(f.store.inbox(next.id)?.state).toBe('pending')
  await f.clients[0].finish(); await until(() => f.store.inbox(next.id)?.state === 'routed')
  f.send('b'); await until(() => f.clients.length === 2)
})

test('配置更新释放旧 Router，下次读取新的模型与自我认知', async () => {
  const f = fixture()
  const first = f.send(); await until(() => f.store.inbox(first.id)?.state === 'routed')
  await f.service.configure('a', 'owner', 1, { model: 'new-model', profile: '简短自然' })
  expect(f.clients[0].closed).toBe(1)
  const next = f.send(); await until(() => f.store.inbox(next.id)?.state === 'routed')
  expect(f.clients).toHaveLength(2)
  expect(f.clients[1].options.model).toBe('new-model')
  expect(f.clients[1].inputs[0].profile).toBe('简短自然')
})

test('停止与服务退出立即释放，旧计时器不会再次关闭新进程', async () => {
  const f = fixture(100)
  const first = f.send(); await until(() => f.store.inbox(first.id)?.state === 'routed')
  await f.service.stopBot('a'); expect(f.clients[0].closed).toBe(1)
  const next = f.send(); await until(() => f.store.inbox(next.id)?.state === 'routed')
  await f.service.close(); await Bun.sleep(130)
  expect(f.clients.map(c => c.closed)).toEqual([1, 1])
})

test('失败轮次不留在池中，下次能重新连接', async () => {
  const f = fixture(); f.manual()
  const first = f.send(); await until(() => f.clients[0]?.inputs.length === 1)
  await f.clients[0].finish('failed'); await until(() => f.store.inbox(first.id)?.state === 'failed')
  expect(f.clients[0].closed).toBe(1)
  const next = f.send(); await until(() => f.clients.length === 2)
  await until(() => f.clients[1].inputs.length === 1); await f.clients[1].finish()
  await until(() => f.store.inbox(next.id)?.state === 'routed')
})

test('持续聊天达到短会话上限后换新上下文，保留本地聊天摘要', async () => {
  const f = fixture()
  for (let i = 0; i < 9; i++) { const m = f.send(); await until(() => f.store.inbox(m.id)?.state === 'routed') }
  expect(f.clients).toHaveLength(2)
  expect(f.clients[0].inputs).toHaveLength(8)
  expect(f.clients[1].inputs[0].recentMessages.length).toBeGreaterThan(1)
})

test('空闲关闭仍在退出时，新消息等待旧进程回收，服务关闭也等待它', async () => {
  const f = fixture(40)
  let release!: () => void
  const closing = new Promise<void>(r => { release = r })
  f.delayClose(closing)
  try {
    const first = f.send(); await until(() => f.store.inbox(first.id)?.state === 'routed')
    await until(() => f.clients[0].closed === 1)
    f.send()
    await Bun.sleep(20)
    expect(f.clients).toHaveLength(1)
    let stopped = false
    const stopping = f.service.close().then(() => { stopped = true })
    await Bun.sleep(20)
    expect(stopped).toBe(false)
    release(); await stopping
    expect(f.clients).toHaveLength(1)
  } finally { release() }
})

test('换短会话等待退出期间修改配置，原消息使用新快照继续而不是失败', async () => {
  const f = fixture()
  let release!: () => void
  const closing = new Promise<void>(r => { release = r })
  try {
    for (let i = 0; i < 8; i++) { const m = f.send(); await until(() => f.store.inbox(m.id)?.state === 'routed') }
    f.delayClose(closing)
    const next = f.send(); await until(() => f.clients[0].closed === 1)
    const changing = f.service.configure('a', 'owner', 1, { model: 'new-model', profile: '最新设定' })
    await Bun.sleep(10); release(); await changing
    await until(() => f.store.inbox(next.id)?.state !== 'pending')
    expect(f.store.inbox(next.id)?.state).toBe('routed')
    expect(f.clients[1].inputs[0].profile).toBe('最新设定')
    expect(f.clients[1].options.model).toBe('new-model')
  } finally { release() }
})
