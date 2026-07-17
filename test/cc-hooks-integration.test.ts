import { test, expect, afterEach } from 'bun:test'
import { ApprovalDispatcher, type ApprovalRequest } from '../src/cli/approval'
import { generateHooksConfig, handleHookBody } from '../src/cli/cc-hooks'

// 集成测试:真跑 Bun.serve,验证「CC curl → ce hook 端点 → 阻塞审批 → 手机 resolve → 回 CC」整条 HTTP round-trip。
// 单元测试(handleHookBody/dispatcher)不覆盖 Bun.serve + 异步阻塞 fetch,这里补上(main.ts 接线的核心路径)。

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let servers: Array<() => void> = []
afterEach(() => {
  for (const stop of servers) stop()
  servers = []
})

/** 起 main.ts 同款 hook 接收器(dispatcher + handleHookBody + Bun.serve),返回端口 + dispatcher。 */
function startHook(dispatcher: ApprovalDispatcher): { port: number; broadcasted: string[] } {
  const broadcasted: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const raw = await req.text()
      const resp = await handleHookBody(raw, {
        requestApproval: (ev) => dispatcher.request(undefined, ev.tool ?? 'unknown', ev.input ?? {}),
        emitEvent: (ev) =>
          broadcasted.push(JSON.stringify({ kind: ev.hook, tool: ev.tool, input: ev.input })),
      })
      return new Response(JSON.stringify(resp), { headers: { 'content-type': 'application/json' } })
    },
  })
  servers.push(() => server.stop())
  // 广播模拟:把 dispatcher 的 onPending 事件也记进 broadcasted(测「事件真发出去」)
  return { port: server.port!, broadcasted }
}

test('PreToolUse:阻塞等审批 → 手机 resolve(allow) → CC 收到 permissionDecision:allow', async () => {
  const pending: ApprovalRequest[] = []
  const dispatcher = new ApprovalDispatcher({
    onPending: (r) => pending.push(r),
    onResolved: () => {},
    timeoutMs: 5000,
  })
  const { port } = startHook(dispatcher)

  // CC 发 PreToolUse(curl 等价:fetch POST,会阻塞到 ce 回响应)
  const body = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/a.ts', content: 'new' },
    session_id: 's1',
    cwd: '/proj',
  })
  const inflight = fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body })

  // 等 ce 收到、登记 pending、onPending 触发(= 广播给手机的时机)
  await wait(30)
  expect(pending).toHaveLength(1)
  expect(pending[0].tool).toBe('Write')

  // 手机人审 allow → resolve → 阻塞的 fetch 应拿到 allow 响应
  dispatcher.resolve(pending[0].reqId, 'allow')
  const res = await inflight
  const json = (await res.json()) as { hookSpecificOutput: { permissionDecision: string } }
  expect(json.hookSpecificOutput.permissionDecision).toBe('allow')
})

test('PreToolUse:手机 deny → CC 收到 permissionDecision:deny + reason', async () => {
  const pending: ApprovalRequest[] = []
  const dispatcher = new ApprovalDispatcher({ onPending: (r) => pending.push(r), timeoutMs: 5000 })
  const { port } = startHook(dispatcher)

  const inflight = fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
  })
  await wait(30)
  dispatcher.resolve(pending[0].reqId, 'deny')
  const res = await inflight
  const json = (await res.json()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
  expect(json.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(json.hookSpecificOutput.permissionDecisionReason).toContain('拒绝')
})

test('PostToolUse:立即回空放行 + 事件即发(不阻塞、不审批)', async () => {
  const dispatcher = new ApprovalDispatcher({ onPending: () => {}, timeoutMs: 5000 })
  const { port, broadcasted } = startHook(dispatcher)

  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} }),
  })
  const text = await res.text()
  expect(JSON.parse(text)).toEqual({}) // 空响应 → CC 放行
  expect(broadcasted).toHaveLength(1) // 事件已广播给手机
  expect(JSON.parse(broadcasted[0]).kind).toBe('PostToolUse')
})

test('超时未审:55s 太长不好测,用短超时验 ce 先于 CC 结掉 → deny', async () => {
  const pending: ApprovalRequest[] = []
  const resolved: Array<[string, string]> = []
  const dispatcher = new ApprovalDispatcher({
    onPending: (r) => pending.push(r),
    onResolved: (id, r) => resolved.push([id, r]),
    timeoutMs: 30,
  })
  const { port } = startHook(dispatcher)

  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }),
  })
  const json = (await res.json()) as { hookSpecificOutput: { permissionDecision: string } }
  expect(json.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(resolved).toHaveLength(1)
  expect(resolved[0][1]).toBe('denied')
})

test('generateHooksConfig 产物是合法 JSON 且 curl 命令含端口', () => {
  const cfg = generateHooksConfig({ url: 'http://127.0.0.1:9999/hook' })
  // round-trip JSON(确认可落盘、CC 能读)
  const round = JSON.parse(JSON.stringify(cfg)) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>
  }
  expect(round.hooks.PreToolUse[0].hooks[0].type).toBe('command')
  expect(round.hooks.PreToolUse[0].hooks[0].command).toContain('127.0.0.1:9999')
})
