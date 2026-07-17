/**
 * CC hooks 层 —— Claude Code 专属知识住这层(hooks JSON 格式、PreToolUse 阻塞语义)。
 *
 * CC 跑在被控机终端里(非 ce 托管进程,区别于管家 butler)。ce 在用户启动 `claude`【前】把 hooks 配置
 * 写到 .claude/settings.json,指向 ce 的本地 hook 接收端点。CC 触发 PreToolUse/PostToolUse → hook 命令
 * (curl)把事件 JSON POST 给 ce → ce 解析:
 *   - PreToolUse → 通用 ApprovalDispatcher 阻塞等手机审批 → 回 allow/deny 的 CC hook 响应体。
 *   - 其余(PostToolUse 等)→ 包成 AgentEvent 即发即忘给手机 → 回空(放行)。
 *
 * 「通用 vs 专属」边界:本文件知「CC 的 hook stdin schema、CC 期望的 permissionDecision 响应体」;
 *   下层的 ApprovalDispatcher(agent 无关)+ AgentEvent 帧(中继零信任透传)是通用的。换 codex/opencode
 *   只换本文件的解析/响应格式,dispatcher 与中继不动。→ 这正是「ce 当哑管道、agent 知识住边缘」。
 */

/** ce 本地 hook 接收端点(写进 hooks 配置,curl 打这)。 */
export interface HookEndpoint {
  /** 完整 URL,如 http://127.0.0.1:8607/hook。 */
  url: string
}

/** CC hook 触发哪些工具的 PreToolUse 审批:写/执行类(改文件、跑命令)需人审;
 *  读类(Read/Grep/Glob)不拦截(对齐管家 READ_TOOLS 自动放行)。matcher 是 CC 正则。 */
const DEFAULT_PRE_TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash'

/**
 * 生成 .claude/settings.json 的 hooks 配置:PreToolUse(写/执行类)→ ce 审批;PostToolUse(全部)→ ce 转发。
 * hook 命令 = curl 读 stdin(--data-binary @-)POST 给 ce、stdout 回显 ce 响应。
 *   PreToolUse 时 ce 响应体 = permissionDecision JSON,curl 原样打到 stdout → CC 据此 allow/deny。
 *   PostToolUse 时 ce 响应空 → curl 无输出 → CC 放行(事件已即发给手机渲染)。
 */
export function generateHooksConfig(
  endpoint: HookEndpoint,
  opts: { preToolMatcher?: string } = {},
): Record<string, unknown> {
  const matcher = opts.preToolMatcher ?? DEFAULT_PRE_TOOL_MATCHER
  // -s 静音进度;--data-binary @- 读 stdin 为 body(保真,不处理);-X POST。curl stdout = ce 响应体。
  const cmd = `curl -s --data-binary @- -X POST ${endpoint.url}`
  return {
    hooks: {
      // matcher='' = 匹配所有工具(PostToolUse 全转发,手机端决定渲染与否)。
      PreToolUse: [{ matcher, hooks: [{ type: 'command', command: cmd }] }],
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: cmd }] }],
    },
  }
}

/** CC hook stdin 解析后的归一化事件(屏蔽 CC 字段细节,下层只认这套)。 */
export interface HookEvent {
  /** CC hook 名:PreToolUse / PostToolUse / ... */
  hook: string
  /** 工具名(Write/Bash/...)。 */
  tool?: string
  /** 工具入参(透传给手机插件渲染;如 Write 的 file_path+content → 插件算 diff)。 */
  input?: Record<string, unknown>
  /** CC 会话 id(手机插件据此关联同一会话的事件流)。 */
  sessionId?: string
  /** CC 工作目录。 */
  cwd?: string
}

/** 解析 CC hook stdin JSON → 归一化 HookEvent。非法/缺 hook_event_name → null(ce 丢弃、放行不卡 CC)。 */
export function parseHookEvent(raw: string): HookEvent | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const hook = typeof o.hook_event_name === 'string' ? o.hook_event_name : ''
  if (!hook) return null
  return {
    hook,
    tool: typeof o.tool_name === 'string' ? o.tool_name : undefined,
    input:
      o.tool_input && typeof o.tool_input === 'object'
        ? (o.tool_input as Record<string, unknown>)
        : undefined,
    sessionId: typeof o.session_id === 'string' ? o.session_id : undefined,
    cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
  }
}

/** 把审批决策转成 CC PreToolUse 期望的 hook 响应体(stdout JSON)。
 *  allow → 显式 permissionDecision:allow;deny → permissionDecision:deny + reason(CC 显示给用户)。 */
export function approvalToHookResponse(
  decision: 'allow' | 'deny',
  reason?: string,
): { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow' | 'deny'; permissionDecisionReason?: string } } {
  if (decision === 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason ?? '手机端拒绝',
    },
  }
}

/** handleHookBody 注入的依赖(让本函数纯逻辑可测,不绑 Bun.serve / dispatcher 实例)。 */
export interface HookHandlerCtx {
  /** PreToolUse:阻塞等手机审批,返回 allow/deny。 */
  requestApproval: (e: HookEvent) => Promise<'allow' | 'deny'>
  /** 非 PreToolUse:即发 AgentEvent 给手机(渲染用)。 */
  emitEvent: (e: HookEvent) => void
}

/**
 * 处理一条 hook POST body,返回 CC 期望的响应体(stdout JSON)。
 *  - PreToolUse → await requestApproval(阻塞)→ 转 permissionDecision 响应。
 *  - 其余 → emitEvent(即发)→ 回 {}(放行)。
 *  - 非法 body → 回 {}(放行,绝不卡 CC)。
 */
export async function handleHookBody(
  raw: string,
  ctx: HookHandlerCtx,
): Promise<Record<string, unknown>> {
  const ev = parseHookEvent(raw)
  if (!ev) return {} // 非法 body → 放行
  if (ev.hook === 'PreToolUse') {
    const decision = await ctx.requestApproval(ev)
    return approvalToHookResponse(decision)
  }
  ctx.emitEvent(ev)
  return {} // 非 PreToolUse:CC 不需要决策,空响应放行
}
