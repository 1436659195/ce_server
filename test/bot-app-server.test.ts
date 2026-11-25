import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServer, CodexToolOutput, type CodexToolCall, type CodexNotification } from '../src/cli/bot-runtime/codex'

const clients: CodexAppServer[] = []
const dirs: string[] = []
function client(onToolCall = async (_call: CodexToolCall): Promise<unknown> => ({}), onNotification?: (event: CodexNotification) => void, accessMode?: 'full-access') {
  const cwd = mkdtempSync(join(tmpdir(), 'ce-app-server-test-'))
  dirs.push(cwd)
  const instance = new CodexAppServer({ cwd, accessMode, command: [process.execPath, join(import.meta.dir, 'fixtures/bot-app-server.ts')], onToolCall, onNotification, requestTimeoutMs: 200 })
  clients.push(instance)
  return instance
}
function probingClient() {
  const cwd = mkdtempSync(join(tmpdir(), 'ce-app-server-probe-test-'))
  dirs.push(cwd)
  const executable = join(cwd, 'codex')
  const log = join(cwd, 'probes.jsonl')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, 'fixtures/bot-app-server.ts'))} ${quote('--fixture-probe-log=' + log)} "$@"\n`)
  chmodSync(executable, 0o700)
  const instance = new CodexAppServer({ cwd, executable, onToolCall: async () => ({}), requestTimeoutMs: 200 })
  clients.push(instance)
  return { instance, log }
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Codex app-server transport', () => {
  test('全权限 Worker 启动和恢复保留工作环境，原生 Shell 不会触发 Router 工具拦截', async () => {
    const c = client(undefined, undefined, 'full-access')
    const thread = await c.startThread({ instructions: '不要更改工作目录之外的文件', tools: [] })
    let config = await c.call<any>('test/config', {})
    expect(config.thread.sandbox).toBe('danger-full-access')
    expect(config.thread.environments).toBeUndefined()
    expect(config.thread.runtimeWorkspaceRoots).toBeUndefined()
    expect(config.thread.baseInstructions).toBeUndefined()
    expect(config.thread.developerInstructions).toContain('不要更改工作目录之外的文件')
    const turn = await c.startTurn(thread, 'native-shell')
    expect((await turn.done).status).toBe('completed')
    await c.resumeThread(thread, { instructions: '继续遵守工作目录约束' })
    config = await c.call<any>('test/config', {})
    expect(config.thread.sandbox).toBe('danger-full-access')
    expect(config.turn.environments).toBeUndefined()
    expect(c.closed).toBe(false)
  })
  test('图片工具结果走结构化 inputImage，保持当前轮次和授权工具校验', async () => {
    let resolve!: (value: unknown) => void
    const returned = new Promise(r => { resolve = r })
    const items = [{ type: 'inputText' as const, text: '用户图片' }, { type: 'inputImage' as const, imageUrl: 'data:image/png;base64,aGVsbG8=' }]
    const c = client(async () => new CodexToolOutput(items), event => { if (event.method === 'test/tool-result') resolve(event.params) })
    const tid = await c.startThread({ instructions: 'test', tools: [{ name: 'report', description: 'report', inputSchema: { type: 'object' } }] })
    const active = await c.startTurn(tid, 'tool')
    expect(await returned).toEqual({ contentItems: items, success: true })
    await c.interrupt(tid, active.turnId)
  })
  test('版本与 MCP 安全检查都不阻塞 CE 事件循环，并且每个新进程都重新检查', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { instance, log } = probingClient()
      const ticks: number[] = []
      const timer = setInterval(() => ticks.push(Date.now()), 20)
      try { await instance.initialize() } finally { clearInterval(timer) }
      const records = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; at: number })
      for (const probe of ['version', 'mcp']) {
        const start = records.find(record => record.event === probe + ':start')!
        const end = records.find(record => record.event === probe + ':end')!
        expect(end.at - start.at).toBeGreaterThanOrEqual(350)
        expect(ticks.filter(at => at >= start.at && at <= end.at).length).toBeGreaterThanOrEqual(10)
      }
      expect(records.some(record => record.event === 'app-server:start')).toBe(true)
      await instance.close()
    }
  })
  test('关闭正在安全检查的客户端会取消启动，不会在稍后偷偷启动 app-server', async () => {
    const { instance, log } = probingClient()
    const initialized = instance.initialize().then(() => 'initialized', () => 'cancelled')
    for (let attempt = 0; attempt < 50 && !existsSync(log); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(existsSync(log)).toBe(true)
    await instance.close()
    expect(await initialized).toBe('cancelled')
    expect(readFileSync(log, 'utf8')).not.toContain('app-server:start')
    expect(instance.closed).toBe(true)
    await expect(instance.initialize()).rejects.toThrow()
  })
  test('向原活动轮次发送补充，不等待该轮结束', async () => {
    const c = client()
    await c.initialize()
    const tid = await c.startThread({ instructions: 'test', tools: [], ephemeral: true })
    const active = await c.startTurn(tid, 'working', 'input-1')
    expect(await c.steer(tid, active.turnId, 'new request', 'input-2')).toBe(active.turnId)
    expect((await active.done).status).toBe('completed')
  })
  test('start 返回前已经完成也能得到最终状态', async () => {
    const c = client()
    await c.initialize()
    const tid = await c.startThread({ instructions: 'test', tools: [] })
    const active = await c.startTurn(tid, 'fast')
    expect((await active.done).status).toBe('completed')
  })
  test('过期 turn ID 拒绝，不把补充交给别的轮次', async () => {
    const c = client()
    await c.initialize()
    const active = await c.startTurn('thread-test', 'working')
    await expect(c.steer('thread-test', 'old-turn', 'update')).rejects.toThrow('active turn mismatch')
    await c.interrupt('thread-test', active.turnId)
    expect((await active.done).status).toBe('interrupted')
  })
  test('动态工具绑定真实线程、轮次与调用 ID', async () => {
    let resolveCall!: (value: CodexToolCall) => void
    const called = new Promise<CodexToolCall>(resolve => { resolveCall = resolve })
    const c = client(async call => { resolveCall(call); return { ok: true } })
    await c.initialize()
    const tid = await c.startThread({ instructions: 'test', tools: [{ name: 'report', description: 'report', inputSchema: { type: 'object' } }] })
    const active = await c.startTurn(tid, 'tool')
    expect(await called).toMatchObject({ threadId: tid, turnId: active.turnId, callId: 'call-test', tool: 'report', arguments: { message: 'hello' } })
    await c.interrupt(tid, active.turnId)
  })
  test('分块 UTF-8 与响应 ID 配对正确，未响应请求有界超时', async () => {
    const c = client()
    await c.initialize()
    expect(await c.call<{ text: string }>('test/split', {})).toEqual({ text: '中文😀' })
    await expect(c.call('test/never', {})).rejects.toThrow('超时')
  })
  test('子进程退出时拒绝活动等待；close 确认进程退出', async () => {
    const c = client()
    await c.initialize()
    const active = await c.startTurn('thread-test', 'exit')
    await expect(active.done).rejects.toThrow('退出')
    await c.close()
    expect(c.closed).toBe(true)
  })
  test('恢复线程仍指定无环境与只读策略', async () => {
    const c = client()
    await c.initialize()
    expect(await c.resumeThread('thread-test', { instructions: 'new policy' })).toBe('thread-test')
  })
  test('发现原生协作工具运行时立即关闭，不让它继续生成子工作者', async () => {
    const c = client()
    await c.initialize()
    const active = await c.startTurn('thread-test', 'native')
    await expect(active.done).rejects.toThrow('未开放的原生工具')
    await c.close()
    expect(c.closed).toBe(true)
  })
  test('同线程活动轮次不能被再次 start 隐式转成 steer', async () => {
    const c = client()
    await c.initialize()
    const active = await c.startTurn('thread-test', 'working')
    await expect(c.startTurn('thread-test', 'another task')).rejects.toThrow('活动轮次')
    await c.interrupt('thread-test', active.turnId)
  })
  test('start 返回终止状态时不等待永远不会到达的通知', async () => {
    const c = client()
    await c.initialize()
    const active = await c.startTurn('thread-test', 'failed-start')
    expect((await active.done).status).toBe('failed')
  })
  test('原生工具失败后，同一缓冲区剩余的动态调用不能触及宿主', async () => {
    let calls = 0
    const c = client(async () => { calls++; return {} })
    const tid = await c.startThread({ instructions: 'test', tools: [{ name: 'report', description: 'report', inputSchema: { type: 'object' } }] })
    const active = await c.startTurn(tid, 'native-then-tool')
    await expect(active.done).rejects.toThrow('未开放的原生工具')
    await c.close()
    expect(calls).toBe(0)
  })
  test('关闭开始后，同一缓冲区剩余的工具调用不能触及宿主', async () => {
    let calls = 0
    const c = client(async () => { calls++; return {} }, event => { if (event.method === 'test/close-now') void c.close() })
    const tid = await c.startThread({ instructions: 'test', tools: [{ name: 'report', description: 'report', inputSchema: { type: 'object' } }] })
    const active = await c.startTurn(tid, 'working')
    await c.call('test/closing', {})
    await expect(active.done).rejects.toThrow('已关闭')
    await c.close()
    expect(calls).toBe(0)
  })
  test('当前线程中不匹配轮次及已结束轮次的调用都不能触及宿主', async () => {
    let calls = 0
    const c = client(async () => { calls++; return {} })
    const tid = await c.startThread({ instructions: 'test', tools: [{ name: 'report', description: 'report', inputSchema: { type: 'object' } }] })
    const active = await c.startTurn(tid, 'working')
    await c.call('test/tool', { turnId: 'old-turn' })
    expect(calls).toBe(0)
    await c.interrupt(tid, active.turnId)
    await active.done
    await c.call('test/tool', { turnId: active.turnId })
    expect(calls).toBe(0)
  })
  test('合法工具先于 start 响应到达仍按已收到的 started 轮次执行', async () => {
    const calls: CodexToolCall[] = []
    const c = client(async call => { calls.push(call); return {} })
    const tid = await c.startThread({ instructions: 'test', tools: [{ name: 'report', description: 'report', inputSchema: { type: 'object' } }] })
    const active = await c.startTurn(tid, 'early-tool')
    expect(calls).toHaveLength(1)
    expect(calls[0].turnId).toBe(active.turnId)
    await c.interrupt(tid, active.turnId)
  })
})
