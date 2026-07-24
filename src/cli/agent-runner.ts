/**
 * ce 端通用 Agent SDK runner ——「通用口子」(plugin-architecture.md §3 / happy-coder-analysis.md §4)。
 *
 * 用 @anthropic-ai/claude-agent-sdk 的 query() 在被控机跑 claude(**不开终端、不 parse TUI** —— 治旧版
 * cc-hooks+terminalOutput 的「TUI 输出乱码」根因)。把 SDKMessage 映射成结构化 AgentEvent
 * (text/thinking/tool-call-start/end/turn-end),经 onEvent 回调加密推手机。写类工具过 canUseTool
 * → 问手机审批(带 callId 精确挂到对应工具卡)。
 *
 * 这是 ce 为 agent 开的**通用口子**:CC 对话是它的一个 config(项目 cwd + 全工具集);未来三方 agent
 * 只要能产结构化事件,复用同一条 runner。ce 不知「CC 是何物」—— 只知「跑个 SDK 对话、映射事件、转发」。
 *
 * 设计借鉴同仓库 butler.ts 已验证的模式(InputQueue 长驻、canUseTool 单门、allow 回灌 updatedInput、
 * 孤儿回收),但按新架构干净重写(非复制):映射成结构化事件(非裸转发 SDKMessage)、懒启动(首条
 * 用户消息才 boot,免 butler 的 BOOTSTRAP「就绪」噪声)、审批带 callId。
 *
 * 长驻:query 的 prompt 是永不结束的 InputQueue → cc 多轮常驻,跨手机瞬时重连存活。
 */
import { query, type SDKMessage, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { AgentEvent } from '../shared/agent-events'

/** 审批【无超时】:审批是人在决定,可能要想很久 / 离开一下 —— 超时自动拒会打断 claude 工作流(用户已踩)。
 *  故 canUseTool 的 Promise 不设超时,让用户慢慢批。兜底:agent 关闭(用户关 CC 会话)/ 手机长期断连
 *  (6h 回收)时,finish() 统一清掉 pending 审批(deny),不会永远卡住 claude。 */
/** 孤儿回收:phoneLeft 后该手机 6h 不回来 → 回收其 agent(免常驻泄漏)。与 butler 对齐。 */
const RECLAIM_MS = 6 * 60 * 60 * 1000
/** 读类工具:canUseTool 直接放行(不问手机)。permissionMode='default' 下读类本就不触发 canUseTool,
 *  这里是 belt(防止某些工具意外触达时也无害放行)。 */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite'])

/** 推入式异步队列:writeStdin push,query 当 AsyncIterable<SDKUserMessage> 消费。永不 end → cc 长驻。 */
class InputQueue {
  private buf: SDKUserMessage[] = []
  private waiters: Array<() => void> = []
  private done = false
  push(msg: SDKUserMessage): void {
    this.buf.push(msg)
    this.waiters.shift()?.()
  }
  close(): void {
    this.done = true
    for (const w of this.waiters.splice(0)) w()
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    while (true) {
      while (this.buf.length) yield this.buf.shift()!
      if (this.done) return
      await new Promise<void>((r) => this.waiters.push(r))
    }
  }
}

/** SDKMessage → AgentEvent[] 纯映射(易测;runner 的核心 = 「口子」的翻译逻辑)。
 *  只关心 assistant(text/thinking/tool_use)/ user(tool_result)/ result;system/status/噪声忽略。 */
export function mapSdkMessageToEvents(msg: SDKMessage): AgentEvent[] {
  const type = (msg as { type?: string }).type
  const out: AgentEvent[] = []
  if (type === 'assistant') {
    const content = (msg as { message?: { content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }> } }).message?.content
    if (!Array.isArray(content)) return out
    for (const b of content) {
      if (b.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', text: b.text })
      else if (b.type === 'thinking' && typeof b.thinking === 'string') out.push({ kind: 'thinking', text: b.thinking })
      else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        out.push({ kind: 'tool-call-start', callId: b.id, tool: b.name, input: b.input ?? {} })
      }
      // redacted_thinking / 未知块 → 忽略
    }
    return out
  }
  if (type === 'user') {
    const content = (msg as { message?: { content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string }> } }).message?.content
    if (!Array.isArray(content)) return out
    for (const b of content) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        out.push({ kind: 'tool-call-end', callId: b.tool_use_id, result: b.content, isError: b.is_error === true })
      }
      // user 的 text 块 = 手机已发的用户消息回显 → 忽略(手机本地已显,免重复)
    }
    return out
  }
  if (type === 'result') {
    const subtype = (msg as { subtype?: string }).subtype
    const durationMs = (msg as { duration_ms?: number }).duration_ms
    out.push({ kind: 'turn-end', status: subtype === 'success' ? 'completed' : 'failed', durationMs })
    return out
  }
  // system.init / status / api_retry / partial / hook_* / … → 噪声,忽略(不转发,免撑爆手机)
  return out
}

interface Approval {
  input: Record<string, unknown>
  resolve: (v: { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }) => void
}
interface AgentProc {
  sid: string
  owner: string
  /** claude 工作目录（OS 绝对 = jupyter root_dir + 用户选的子目录） */
  cwd: string
  queue: InputQueue
  approvals: Map<string, Approval>
  started: boolean
  stopping: boolean
}

export interface AgentRunnerOpts {
  /** SDK 事件 → 手机(回调;main.ts 接到后加密成 AgentEvent 帧发给 owner)。 */
  onEvent: (owner: string, event: AgentEvent) => void
  onExit: (sid: string, owner: string, code: number | null) => void
  /** resolveClaudeBin() 结果;SDK 经 pathToClaudeCodeExecutable 复用系统 claude(连带 auth)。 */
  claudeBin: string
  /** 注入点(测试用):喂假 query 避免真 spawn cc。签名同 SDK query。 */
  query?: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>
  /** 工作目录(claude 的项目根;CC 对话跑在用户项目,butler 跑 /tmp)。 */
  cwd: string
}

/** 一台手机一个 agent 会话(CC 对话)。manager 管 sid→proc + 孤儿回收。 */
export class AgentRunner {
  private procs = new Map<string, AgentProc>()
  private reclaimTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private readonly opts: AgentRunnerOpts) {}

  /** 启动/复用一个 agent 会话(按 owner 一机一个)。返回 sid(形如 cc-xxxx)。懒启动:仅注册,
   *  首条 writeStdin 才真起 query(免 BOOTSTRAP「就绪」噪声)。 */
  /** 启动/复用 agent 会话。rel = 用户在文件栏选的子目录(jupyter root_dir 相对,去前导 /);
   *  cwd = opts.cwd(jupyter root_dir)+ rel。rel 空 → root_dir。 */
  start(owner: string, rel?: string): string {
    const existing = this.sidForPhone(owner)
    if (existing) {
      console.log(`[ce:agent-runner] 复用现有 agent sid=${existing} (owner=${owner})`)
      return existing
    }
    const sid = `cc-${randomBytes(4).toString('hex')}`
    const cwd = rel ? path.resolve(this.opts.cwd, rel) : this.opts.cwd
    this.procs.set(sid, { sid, owner, cwd, queue: new InputQueue(), approvals: new Map(), started: false, stopping: false })
    console.log(`[ce:agent-runner] 新建 agent sid=${sid} (owner=${owner}, cwd=${cwd}, claude=${this.opts.claudeBin})`)
    return sid
  }

  /** 喂用户发言(手机 stdin 来的文本)→ 入队 SDKUserMessage。首条触发 query 启动。 */
  writeStdin(sid: string, text: string): void {
    const proc = this.procs.get(sid)
    if (!proc) {
      console.warn(`[ce:agent-runner] writeStdin: 未知 sid=${sid}(agent 未起 / 已退 / ce 旧版?)`)
      return
    }
    // ★ parent_tool_use_id: null 必带(SDK 顶层 user 消息要求;Happy/但ler 都带,缺了 SDK 行为异常)。
    const msg = {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    } as unknown as SDKUserMessage
    proc.queue.push(msg)
    if (!proc.started) {
      proc.started = true
      console.log(`[ce:agent-runner] ${sid} 首条消息,启动 SDK query(cwd=${proc.cwd}, claude=${this.opts.claudeBin})`)
      this.runConversation(proc).catch((e) => {
        console.error(`[ce:agent-runner] ${sid} 对话循环异常(不崩 ce):`, (e as Error).message)
        this.finish(proc, -2)
      })
    }
  }

  /** 跑长驻对话:query(流式输入)→ 逐 SDKMessage 映射成 AgentEvent → onEvent。 */
  private async runConversation(proc: AgentProc): Promise<void> {
    const run = this.opts.query ?? query
    console.log(`[ce:agent-runner] ${proc.sid} 调 query()...`)
    const conversation = run({
      prompt: proc.queue,
      options: {
        cwd: proc.cwd,
        pathToClaudeCodeExecutable: this.opts.claudeBin,
        includeHookEvents: false, // 不转发 hook 噪声(我们直接映射 SDKMessage)
        canUseTool: async (toolName, input, options) => this.canUseTool(proc, toolName, input, options),
      } as Options,
    })
    try {
      for await (const msg of conversation) {
        if (proc.stopping) break
        const events = mapSdkMessageToEvents(msg)
        for (const ev of events) this.opts.onEvent(proc.owner, ev)
        console.log(`[ce:agent-runner] ${proc.sid} SDK msg type=${(msg as { type?: string }).type} → ${events.length} 事件已推`)
      }
      console.log(`[ce:agent-runner] ${proc.sid} 对话流正常结束`)
      this.finish(proc, 0)
    } catch (e) {
      console.error(`[ce:agent-runner] ${proc.sid} query/遍历抛错:`, (e as Error).message)
      this.finish(proc, -2)
    }
  }

  /** canUseTool 单门:读类直接放行;其余 → 问手机审批(带 callId)。allow 回灌 updatedInput
   *  (否则 SDK 以 undefined 调工具 → ZodError,butler 踩过)。 */
  private async canUseTool(
    proc: AgentProc,
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID?: string },
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    if (READ_TOOLS.has(toolName)) {
      console.log(`[ce:agent-runner] ${proc.sid} canUseTool(${toolName}) 读类直接放行`)
      return { behavior: 'allow', updatedInput: input }
    }
    console.log(`[ce:agent-runner] ${proc.sid} canUseTool(${toolName}) → 问手机审批(callId=${options.toolUseID ?? '?'})`)
    return this.requestApproval(proc, toolName, input, options.toolUseID ?? '')
  }

  /** 发 approval-request 问手机,**无超时**等 resolveApproval(用户慢慢批)。
   *  兜底:agent 关闭(finish)/ 6h 回收时统一 deny 所有 pending,不会永远卡 claude。 */
  private requestApproval(
    proc: AgentProc,
    toolName: string,
    input: Record<string, unknown>,
    callId: string,
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    const reqId = randomBytes(4).toString('hex')
    console.log(`[ce:agent-runner] ${proc.sid} 发 approval-request reqId=${reqId} tool=${toolName} → 等手机审批(无超时)`)
    this.opts.onEvent(proc.owner, { kind: 'approval-request', reqId, callId, tool: toolName, input })
    return new Promise((resolve) => {
      proc.approvals.set(reqId, { input, resolve })
    })
  }

  /** 手机审批响应(resolveApproval RPC 来,只带 reqId 不带 sid)→ 跨所有 proc 找对应 pending 解掉。 */
  resolveApproval(reqId: string, allow: boolean): boolean {
    for (const proc of this.procs.values()) {
      const a = proc.approvals.get(reqId)
      if (a) {
        console.log(`[ce:agent-runner] ${proc.sid} 收到手机审批 reqId=${reqId} → ${allow ? 'allow' : 'deny'}`)
        proc.approvals.delete(reqId)
        this.opts.onEvent(proc.owner, { kind: 'approval-resolved', reqId, resolved: allow ? 'approved' : 'denied' })
        a.resolve(allow ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: '用户拒绝' })
        return true
      }
    }
    console.warn(`[ce:agent-runner] resolveApproval reqId=${reqId} 未命中(agent 已关 / 他机先解)`)
    return false
  }

  /** reqId 是否在某 agent 的 pending 中(resolveApproval 路由用:先 agent-runner 后旧 dispatcher)。 */
  hasPendingReqId(reqId: string): boolean {
    for (const p of this.procs.values()) if (p.approvals.has(reqId)) return true
    return false
  }

  /** 收尾:删表、关队列、拒所有未决审批(同步通知手机免僵尸卡)、onExit。 */
  private finish(proc: AgentProc, code: number | null): void {
    if (!this.procs.has(proc.sid)) return
    this.procs.delete(proc.sid)
    proc.stopping = true
    proc.queue.close()
    for (const [rid, a] of proc.approvals) {
      this.opts.onEvent(proc.owner, { kind: 'approval-resolved', reqId: rid, resolved: 'denied' })
      a.resolve({ behavior: 'deny', message: 'agent 退出' })
    }
    proc.approvals.clear()
    this.opts.onExit(proc.sid, proc.owner, code)
  }

  stop(sid: string): void {
    const proc = this.procs.get(sid)
    if (proc) this.finish(proc, null)
  }
  stopAllForPhone(phoneId: string): void {
    for (const p of [...this.procs.values()]) if (p.owner === phoneId) this.stop(p.sid)
  }
  sidForPhone(phoneId: string): string | null {
    for (const p of this.procs.values()) if (p.owner === phoneId) return p.sid
    return null
  }
  /** 列所有 agent sid(listTerminals 用:让手机能恢复 cc session)。 */
  sids(): string[] {
    return [...this.procs.keys()]
  }

  /** phoneLeft:6h 回收计时(防「移除服务器」后孤儿 cc 常驻泄漏;瞬时断连不立即杀)。 */
  markPhoneLeft(phoneId: string): void {
    if (!this.sidForPhone(phoneId)) return
    if (this.reclaimTimers.has(phoneId)) return
    const t = setTimeout(() => {
      this.reclaimTimers.delete(phoneId)
      if (this.sidForPhone(phoneId)) {
        this.stopAllForPhone(phoneId)
        console.log(`[ce:agent-runner] phone ${phoneId} ${Math.round(RECLAIM_MS / 60000)}min 未归,回收其 agent`)
      }
    }, RECLAIM_MS)
    this.reclaimTimers.set(phoneId, t)
  }
  markPhoneBack(phoneId: string): void {
    const t = this.reclaimTimers.get(phoneId)
    if (t) {
      clearTimeout(t)
      this.reclaimTimers.delete(phoneId)
    }
  }
}
