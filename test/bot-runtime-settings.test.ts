import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService, type RuntimeClient, type RuntimeClientOptions } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot, RuntimeInbox } from '../src/cli/bot-runtime/types'
import type { CodexTurn } from '../src/cli/bot-runtime/codex'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}
function fixture(createClient?: (role: 'router' | 'worker', options: RuntimeClientOptions) => RuntimeClient) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-runtime-settings-'))
  const store = new BotRuntimeStore(join(dir, 'runtime.sqlite'))
  const probe = gate()
  const bot: RuntimeBot = {
    botId: 'bot', name: '助理', groupId: 'dm', ownerPhoneId: 'owner', sourceCwd: dir, directory: dir,
    platform: 'codex', commandSandbox: true, policyRevision: 1,
    permissions: { version: 1, directory: '.', read: 'allow', create: 'allow', edit: 'allow', delete: 'ask', execute: 'ask', commanders: 'owner', allowedPhoneIds: [] },
  }
  let probeError: Error | undefined
  const service = new BotRuntimeService({ routerQuietMs: 0,
    store, rootDir: dir, getBot: () => ({ ...bot }), sendReply: async () => {},
    checkAccess: async () => ({ directory: dir, permissions: bot.permissions, revision: bot.policyRevision }),
    openTools: () => { throw new Error('settings test does not execute project tools') },
    createClient: createClient ?? (() => ({
      initialize: async () => { await probe.promise; if (probeError) throw probeError },
      startThread: async () => { throw new Error('unexpected thread') }, resumeThread: async id => id,
      startTurn: async () => { throw new Error('unexpected turn') },
      steer: async () => '', interrupt: async () => {}, close: async () => {},
    })),
  })
  cleanups.push(async () => { probe.release(); await service.close(); await Promise.resolve(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { service, store, bot, probe, failProbe: () => { probeError = new Error('probe unavailable') } }
}

test('同一 Bot 的探测在途时拒绝并发配置，后续重试使用新版本', async () => {
  const f = fixture()
  const enabling = f.service.configure('bot', 'owner', 0, { mode: 'router-worker' })
  await expect(f.service.configure('bot', 'owner', 0, { mode: 'legacy', profile: '新偏好' })).rejects.toThrow(/正在更新/)
  expect(f.store.settings('bot').revision).toBe(0)
  f.probe.release()
  expect((await enabling).settings).toMatchObject({ mode: 'router-worker', revision: 1 })
  const latest = await f.service.configure('bot', 'owner', 1, { mode: 'legacy', profile: '新偏好' })
  expect(latest.settings).toMatchObject({ mode: 'legacy', profile: '新偏好', revision: 2 })
})

test('异步探测后的提交不能覆盖已更新的持久配置', async () => {
  const f = fixture()
  const enabling = f.service.configure('bot', 'owner', 0, { mode: 'router-worker' })
  f.store.saveSettings({ ...f.store.settings('bot'), revision: 1, profile: '较新的持久配置' })
  f.probe.release()
  await expect(enabling).rejects.toThrow(/配置或权限已变化/)
  expect(f.store.settings('bot')).toMatchObject({ mode: 'legacy', revision: 1, profile: '较新的持久配置' })
})

test('探测期间权限变化时不启用旧配置，失败后释放配置锁', async () => {
  const f = fixture()
  const enabling = f.service.configure('bot', 'owner', 0, { mode: 'router-worker' })
  f.bot.policyRevision++
  f.probe.release()
  await expect(enabling).rejects.toThrow(/配置或权限已变化/)
  expect(f.store.settings('bot').mode).toBe('legacy')
  expect((await f.service.configure('bot', 'owner', 0, { profile: '重新核对后的偏好' })).settings.revision).toBe(1)
})

test('探测失败不遗留配置锁，owner 可以继续编辑配置', async () => {
  const f = fixture()
  f.failProbe()
  const enabling = f.service.configure('bot', 'owner', 0, { mode: 'router-worker' })
  f.probe.release()
  await expect(enabling).rejects.toThrow('probe unavailable')
  expect((await f.service.configure('bot', 'owner', 0, { profile: '继续使用旧模式' })).settings).toMatchObject({ mode: 'legacy', revision: 1 })
})

test('切换期新消息显式失败，启用后只能由 owner 按原消息重试一次', async () => {
  const closing = gate()
  let workers = 0; let closeStarted = false
  const routedInputs: string[] = []
  const f = fixture((role, options) => {
    const workerNumber = role === 'worker' ? ++workers : 0
    let resolveTurn: ((turn: CodexTurn) => void) | undefined
    return {
      initialize: async () => {}, startThread: async () => `${role}-${workerNumber}`, resumeThread: async id => id,
      startTurn: async (threadId, text) => {
        if (role === 'router') {
          const context = JSON.parse(text)
          routedInputs.push(context.currentMessage.id)
          return { threadId, turnId: 'router-turn', done: Promise.resolve().then(async () => {
            await options.onToolCall({ threadId, turnId: 'router-turn', callId: 'decision', tool: 'router_decide', arguments: {
              action: 'start', delivery: 'chat', feasibility: 'can', policyRevision: 1, replyText: '可以，我先看看。',
              newCase: { title: context.currentMessage.text, object: '当前项目', goal: '调查功能' }, goal: '调查功能', allowedOps: ['read'],
            } })
            return { id: 'router-turn', status: 'completed' }
          }) }
        }
        return { threadId, turnId: 'worker-turn', done: new Promise<CodexTurn>(resolve => { resolveTurn = resolve }) }
      },
      steer: async () => 'worker-turn', interrupt: async () => { resolveTurn?.({ id: 'worker-turn', status: 'interrupted' }) },
      close: async () => {
        resolveTurn?.({ id: 'worker-turn', status: 'interrupted' })
        if (workerNumber === 1) { closeStarted = true; await closing.promise }
      },
    }
  })
  f.store.saveSettings({ ...f.store.settings('bot'), mode: 'router-worker', revision: 1 })
  const send = (seq: number) => f.service.receive('bot', { groupId: 'dm', seq, senderId: 'owner', memberId: 'owner-member', text: `调查功能 ${seq}`, createdAt: Date.now() })
  send(1)
  await waitFor(() => f.store.runs().some(run => run.state === 'running'))
  const disabling = f.service.configure('bot', 'owner', 1, { mode: 'legacy' })
  let failed!: RuntimeInbox
  try {
    await waitFor(() => closeStarted)
    failed = send(2)
    expect(failed.state).toBe('failed')
    expect(f.service.view('bot', 'owner').failedInputs).toContainEqual({
      id: failed.id, text: '调查功能 2', error: failed.error, createdAt: failed.createdAt,
    })
    expect(failed.error).toMatch(/停止|切换/)
    await expect(f.service.control('bot', 'owner', { action: 'retry_input', inputId: failed.id, requestId: 'during-switch' })).rejects.toThrow(/等待切换/)
    await Bun.sleep(30)
  } finally { closing.release() }
  expect((await disabling).settings.mode).toBe('legacy')
  expect(workers).toBe(1)
  expect(f.store.runs().every(run => run.state === 'exited')).toBe(true)
  expect(f.store.tasks().some(task => task.state === 'running')).toBe(false)
  const retry = { action: 'retry_input' as const, inputId: failed.id, requestId: 'retry-original-input' }
  await expect(f.service.control('bot', 'owner', retry)).rejects.toThrow(/先启用/)
  await expect(f.service.control('bot', 'other', retry)).rejects.toThrow(/owner|创建者/)
  expect(f.store.inbox(failed.id)?.state).toBe('failed')

  await f.service.configure('bot', 'owner', 2, { mode: 'router-worker' })
  expect(workers).toBe(1)
  expect(f.service.view('bot', 'owner').failedInputs.map(input => input.id)).toContain(failed.id)
  await f.service.control('bot', 'owner', retry)
  await waitFor(() => workers === 2 && f.store.inbox(failed.id)?.state === 'routed')
  await f.service.control('bot', 'owner', retry)
  await expect(f.service.control('bot', 'owner', { ...retry, requestId: 'cannot-retry-routed' })).rejects.toThrow(/不重复派工/)
  expect(f.store.messages('bot')).toHaveLength(2)
  expect(f.store.tasks().filter(task => task.originInputId === failed.id)).toHaveLength(1)
  expect(routedInputs.filter(id => id === failed.id)).toHaveLength(1)
  expect(f.service.view('bot', 'owner').failedInputs).toEqual([])
  expect(workers).toBe(2)
})

test('失败消息视图限制条数和正文，但保留完整原文且不能跨 Bot 重试', async () => {
  const f = fixture()
  const ids: string[] = []
  for (let seq = 1; seq <= 12; seq++) {
    const input = f.store.receive({ botId: 'bot', groupId: 'dm', seq, senderId: 'owner', memberId: 'owner-member', text: `${seq}:${'原文'.repeat(800)}`, createdAt: seq })
    f.store.markInput(input.id, 'failed', undefined, '切换期间未派工')
    ids.push(input.id)
  }
  const foreign = f.store.receive({ botId: 'other-bot', groupId: 'other-dm', seq: 1, senderId: 'owner', memberId: 'owner-member', text: '另一个 Bot 的消息', createdAt: 20 })
  f.store.markInput(foreign.id, 'failed', undefined, '未派工')
  const visible = f.service.view('bot', 'owner').failedInputs
  expect(visible.map(input => input.id)).toEqual(ids.slice(-10))
  expect(visible.every(input => input.text.length <= 1000)).toBe(true)
  expect(f.store.inbox(ids[11])?.text).toBe(`12:${'原文'.repeat(800)}`)
  await expect(f.service.control('bot', 'owner', { action: 'retry_input', inputId: foreign.id, requestId: 'foreign-input' })).rejects.toThrow(/无权重试/)
  expect(f.store.inbox(foreign.id)?.state).toBe('failed')
})
