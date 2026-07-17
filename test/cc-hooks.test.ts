import { test, expect } from 'bun:test'
import {
  generateHooksConfig,
  parseHookEvent,
  approvalToHookResponse,
  handleHookBody,
  type HookEvent,
  type HookHandlerCtx,
} from '../src/cli/cc-hooks'

const EP = { url: 'http://127.0.0.1:8607/hook' }

// ── generateHooksConfig ──────────────────────────────────────────────────────
test('generateHooksConfig:PreToolUse + PostToolUse 都打 ce endpoint、curl 读 stdin', () => {
  const cfg = generateHooksConfig(EP) as {
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>
  }
  const pre = cfg.hooks.PreToolUse[0].hooks[0].command
  const post = cfg.hooks.PostToolUse[0].hooks[0].command
  expect(pre).toContain('http://127.0.0.1:8607/hook')
  expect(pre).toContain('--data-binary @-') // 读 stdin(CC hook 事件 JSON)
  expect(post).toContain('http://127.0.0.1:8607/hook')
})

test('generateHooksConfig:PreToolUse matcher 默认含写/执行类、不含读类', () => {
  const cfg = generateHooksConfig(EP) as {
    hooks: Record<string, Array<{ matcher: string }>>
  }
  const m = cfg.hooks.PreToolUse[0].matcher
  expect(m).toContain('Write')
  expect(m).toContain('Bash')
  expect(m).not.toMatch(/(^|\|)Read(\||$)/) // 不含 Read
  expect(m).not.toMatch(/(^|\|)Grep(\||$)/)
})

test('generateHooksConfig:PostToolUse matcher 为空(全转发,手机端决定渲染)', () => {
  const cfg = generateHooksConfig(EP) as {
    hooks: Record<string, Array<{ matcher: string }>>
  }
  expect(cfg.hooks.PostToolUse[0].matcher).toBe('')
})

test('generateHooksConfig:matcher 可覆盖', () => {
  const cfg = generateHooksConfig(EP, { preToolMatcher: 'Write|Edit' }) as {
    hooks: Record<string, Array<{ matcher: string }>>
  }
  expect(cfg.hooks.PreToolUse[0].matcher).toBe('Write|Edit')
})

// ── parseHookEvent ───────────────────────────────────────────────────────────
test('parseHookEvent:PreToolUse 带 tool/input/sessionId/cwd', () => {
  const ev = parseHookEvent(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/a.ts', content: 'x' },
      session_id: 's1',
      cwd: '/proj',
    }),
  )
  expect(ev).toEqual({
    hook: 'PreToolUse',
    tool: 'Write',
    input: { file_path: '/a.ts', content: 'x' },
    sessionId: 's1',
    cwd: '/proj',
  })
})

test('parseHookEvent:缺 hook_event_name / 非 JSON / 空串 → null(放行不卡)', () => {
  expect(parseHookEvent(JSON.stringify({ tool_name: 'X' }))).toBeNull()
  expect(parseHookEvent('not json')).toBeNull()
  expect(parseHookEvent('')).toBeNull()
  expect(parseHookEvent('{}')).toBeNull()
})

test('parseHookEvent:缺 tool_name/tool_input 不抛(tool/input 为 undefined)', () => {
  const ev = parseHookEvent(JSON.stringify({ hook_event_name: 'PostToolUse' }))
  expect(ev?.hook).toBe('PostToolUse')
  expect(ev?.tool).toBeUndefined()
  expect(ev?.input).toBeUndefined()
})

// ── approvalToHookResponse ───────────────────────────────────────────────────
test('approvalToHookResponse:allow/deny 格式符合 CC permissionDecision 期望', () => {
  const allow = approvalToHookResponse('allow')
  expect(allow.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(allow.hookSpecificOutput.permissionDecision).toBe('allow')
  expect(allow.hookSpecificOutput.permissionDecisionReason).toBeUndefined()

  const deny = approvalToHookResponse('deny', '手机拒绝')
  expect(deny.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(deny.hookSpecificOutput.permissionDecisionReason).toBe('手机拒绝')

  // deny 默认 reason
  const denyDefault = approvalToHookResponse('deny')
  expect(denyDefault.hookSpecificOutput.permissionDecisionReason).toBe('手机端拒绝')
})

// ── handleHookBody ───────────────────────────────────────────────────────────
const mkCtx = (over: Partial<HookHandlerCtx> = {}): HookHandlerCtx & {
  approvals: HookEvent[]
  emitted: HookEvent[]
} => {
  const approvals: HookEvent[] = []
  const emitted: HookEvent[] = []
  return {
    approvals,
    emitted,
    requestApproval:
      over.requestApproval ??
      (async (e) => {
        approvals.push(e)
        return 'deny' as const
      }),
    emitEvent: over.emitEvent ?? ((e) => emitted.push(e)),
  }
}

test('handleHookBody:PreToolUse → 阻塞等审批 → 返回决策响应', async () => {
  const ctx = mkCtx({
    emitEvent: () => {
      throw new Error('PreToolUse 不该 emit')
    },
  })
  const resp = await handleHookBody(
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm' } }),
    ctx,
  )
  expect(ctx.approvals).toHaveLength(1)
  expect(ctx.approvals[0].tool).toBe('Bash')
  expect(
    (resp as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
      .permissionDecision,
  ).toBe('deny')
})

test('handleHookBody:PreToolUse allow 透传', async () => {
  const ctx = mkCtx({ requestApproval: async () => 'allow' })
  const resp = await handleHookBody(
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }),
    ctx,
  )
  expect(
    (resp as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
      .permissionDecision,
  ).toBe('allow')
})

test('handleHookBody:PostToolUse → emit 即发、返回空放行(不审批)', async () => {
  const ctx = mkCtx({
    requestApproval: async () => {
      throw new Error('PostToolUse 不该走审批')
    },
  })
  const resp = await handleHookBody(
    JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} }),
    ctx,
  )
  expect(ctx.emitted).toHaveLength(1)
  expect(ctx.emitted[0].hook).toBe('PostToolUse')
  expect(resp).toEqual({})
})

test('handleHookBody:非法 body → 返回空放行(绝不卡 CC)', async () => {
  const ctx = mkCtx()
  expect(await handleHookBody('garbage', ctx)).toEqual({})
  expect(ctx.approvals).toHaveLength(0)
  expect(ctx.emitted).toHaveLength(0)
})
