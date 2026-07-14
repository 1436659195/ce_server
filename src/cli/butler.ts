/**
 * ce 端 AI 管家进程管理器 —— Agent SDK 版(Phase 1)。
 *
 * 管家大脑 = 一个 cc,经 @anthropic-ai/claude-agent-sdk 的 query() 长驻跑。终端操作(list/read/send)
 * 是 createSdkMcpServer 里的自定义工具(handler 在本进程,直读 ce 缓冲/直写 terminado stdin)。
 * 手机经 ButlerStdin/Output 隧道帧与管家收发:用户发言帧喂 InputQueue → query 消费;管家吐的每个
 * SDKMessage 事件经 onOutput 加密回手机(白盒)。写类工具(send_terminal)过 canUseTool → 问手机审批。
 *
 * 长驻机制:query 的 prompt 是一个【永不结束】的 InputQueue(推入式异步迭代器)→ cc 多轮常驻,
 * 跨手机瞬时重连存活(phoneLeft 不杀管家;butlerStart 用 sidForPhone 复用)。
 */
import { query, createSdkMcpServer, type SDKMessage, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { makeButlerTools, type ToolDeps } from './butler-tools'

/** 管家隔离工作目录(空)→ cc 不加载任何项目 CLAUDE.md,身份只由 skill 决定。 */
const BUTLER_CWD = '/tmp/ce-butler-cwd'
/** 写类工具(非 allowedTools)走手机审批;15s 不答 → 自动拒。 */
const APPROVAL_TIMEOUT_MS = 15000

/** 推入式异步队列:writeStdin push,query 当 AsyncIterable<SDKUserMessage> 消费。永不 end → cc 长驻。 */
class InputQueue {
  private buf: SDKUserMessage[] = []
  private waiters: Array<() => void> = []
  private done = false
  push(msg: SDKUserMessage): void {
    this.buf.push(msg)
    this.waiters.shift()?.()
  }
  /** 结束迭代器:让 query 的 prompt 流完结 → 对话循环收尾(stop 用)。 */
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

export interface ButlerOpts {
  onOutput: (sid: string, owner: string, chunk: Uint8Array) => void
  onExit: (sid: string, owner: string, code: number | null) => void
  /** 终端工具依赖(buffers + send),全 ce 共享一份。 */
  deps: ToolDeps
  /** resolveClaudeBin() 结果;SDK 经 pathToClaudeCodeExecutable 复用系统 claude(连带 auth)。 */
  claudeBin: string
  /** 注入点(测试用):喂假 query 避免真 spawn cc。默认用 SDK 的 query。签名同 SDK query(单 params 对象)。 */
  query?: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>
}

interface Approval {
  resolve: (v: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void
  timer: ReturnType<typeof setTimeout>
}
interface ButlerProc {
  sid: string
  owner: string
  queue: InputQueue
  approvals: Map<string, Approval>
  stopping: boolean
}

/** 只转发管家 UI 关心的事件:assistant(人话+工具调用)/ user(tool_result)/ result(一轮完)/ system.init(就绪)。
 *  hook_*(SessionStart 注入的 superpowers 等巨量 skill 文本)/ status / api_retry 等噪声一律丢——
 *  它们对管家无用,且单条可达数 MB,转发会让手机解析超时、把 init 挤到 40s 窗口外。 */
function isButlerRelevant(msg: SDKMessage): boolean {
  const t = (msg as { type?: string }).type
  if (t === 'assistant' || t === 'user' || t === 'result') return true
  if (t === 'system') return (msg as { subtype?: string }).subtype === 'init'
  return false
}

/** 读类工具:canUseTool 直接放行(不问手机)。其余(send_terminal 等)走手机审批。 */
const READ_TOOLS = new Set(['mcp__ce-butler__list_terminals', 'mcp__ce-butler__read_terminal', 'Read', 'Grep', 'Glob'])

export class ButlerManager {
  private procs = new Map<string, ButlerProc>()
  constructor(private readonly opts: ButlerOpts) {}

  /** 启动/复用一个管家(按 owner 一机一管家)。返回 butlerSid。 */
  start(skill: string, owner: string): string {
    const existing = this.sidForPhone(owner)
    if (existing) return existing
    try { mkdirSync(BUTLER_CWD, { recursive: true }) } catch { /* 已在 */ }
    const sid = `butler-${randomBytes(4).toString('hex')}`
    const proc: ButlerProc = { sid, owner, queue: new InputQueue(), approvals: new Map(), stopping: false }
    this.procs.set(sid, proc)
    // 后台跑对话循环;query 自身 spawn cc,异常 → finish(-2)(ce 不崩)。
    this.runConversation(proc, skill).catch((e) => {
      console.warn('[ce:butler] 对话循环异常(不崩 ce):', (e as Error).message)
      this.finish(proc, -2)
    })
    return sid
  }

  /** 跑一轮长驻对话:createSdkMcpServer(工具) + query(流式输入) → 逐事件 onOutput。 */
  private async runConversation(proc: ButlerProc, skill: string): Promise<void> {
    const server = createSdkMcpServer({ name: 'ce-butler', tools: makeButlerTools(this.opts.deps), instructions: skill })
    const run = this.opts.query ?? query
    const conversation = run({
      prompt: proc.queue,
      options: {
        mcpServers: { 'ce-butler': server },
        cwd: BUTLER_CWD,
        pathToClaudeCodeExecutable: this.opts.claudeBin,
        tools: ['Read', 'Grep', 'Glob'], // 内置只留只读三件
        includeHookEvents: false, // 不发 PreToolUse/Stop 类 hook 事件(SessionStart 仍始终发,靠下方 filter 丢)
        // 不用 allowedTools:它会让条目绕过 canUseTool 直接 auto-approve,SDK 报 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED 警告。
        // 所有工具都走 canUseTool 单门:读类直接放行、send_terminal 问手机审批。
        canUseTool: async (toolName, input) => this.canUseTool(proc, toolName, input),
      },
    })
    // 只转发管家 UI 关心的事件;hook_*(SessionStart 在装 superpowers 的机器上吐巨量 skill 文本,
    //   几 MB 一坨,转发会把手机撑爆、system/init 排其后导致 40s 超时)/ status / api_retry 等噪声全丢。
    for await (const msg of conversation) {
      if (proc.stopping) break
      if (!isButlerRelevant(msg)) continue
      this.opts.onOutput(proc.sid, proc.owner, Buffer.from(JSON.stringify(msg) + '\n', 'utf8'))
    }
    this.finish(proc, 0)
  }

  /** canUseTool 单门:读类(READ_TOOLS)直接放行;其余(send_terminal)→ 问手机审批。 */
  private async canUseTool(proc: ButlerProc, toolName: string, input: Record<string, unknown>): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> {
    if (READ_TOOLS.has(toolName)) return { behavior: 'allow' }
    return this.requestApproval(proc, toolName, input)
  }

  /** 发审批事件问手机,等 butler_approval_response 或 15s 超时。 */
  private requestApproval(
    proc: ButlerProc,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> {
    const reqId = randomBytes(4).toString('hex')
    this.opts.onOutput(
      proc.sid, proc.owner,
      Buffer.from(JSON.stringify({ type: 'system', subtype: 'butler_approval', reqId, tool: toolName, input }) + '\n', 'utf8'),
    )
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (proc.approvals.delete(reqId)) resolve({ behavior: 'deny', message: '审批超时(15s 未答)' }) }, APPROVAL_TIMEOUT_MS)
      proc.approvals.set(reqId, { resolve, timer })
    })
  }

  /** 手机审批响应(ButlerStdin 来)→ 解对应 pending。 */
  resolveApproval(sid: string, reqId: string, allow: boolean): void {
    const proc = this.procs.get(sid)
    const a = proc?.approvals.get(reqId)
    if (!proc || !a) return
    clearTimeout(a.timer)
    proc.approvals.delete(reqId)
    a.resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: '用户拒绝' })
  }

  /** 喂用户发言帧(手机 ButlerStdin 来的 SDKUserMessage JSON 字节)→ 入队,cc 下一轮消费。 */
  writeStdin(sid: string, bytes: Uint8Array): void {
    const proc = this.procs.get(sid)
    if (!proc) return
    try {
      proc.queue.push(JSON.parse(new TextDecoder().decode(bytes)) as SDKUserMessage)
    } catch { /* 非法 JSON 丢弃 */ }
  }

  /** 收尾:去重,删表,关队列,拒所有未决审批,onExit。 */
  private finish(proc: ButlerProc, code: number | null): void {
    if (!this.procs.has(proc.sid)) return
    this.procs.delete(proc.sid)
    proc.stopping = true
    proc.queue.close()
    for (const [, a] of proc.approvals) { clearTimeout(a.timer); a.resolve({ behavior: 'deny', message: '管家退出' }) }
    proc.approvals.clear()
    this.opts.onExit(proc.sid, proc.owner, code)
  }

  stop(sid: string): void {
    const proc = this.procs.get(sid)
    if (!proc) return
    this.finish(proc, null)
  }
  stopAllForPhone(phoneId: string): void {
    for (const p of [...this.procs.values()]) if (p.owner === phoneId) this.stop(p.sid)
  }
  stopAll(): void {
    for (const sid of [...this.procs.keys()]) this.stop(sid)
  }
  sidForPhone(phoneId: string): string | null {
    for (const p of this.procs.values()) if (p.owner === phoneId) return p.sid
    return null
  }
  hasForPhone(phoneId: string): boolean { return this.sidForPhone(phoneId) !== null }
  get size(): number { return this.procs.size }
}

// 仅测用导出(单测验 InputQueue 的有序 + close 收尾)。
export { InputQueue }
