import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createSdkMcpServer, query, tool, type Options as SDKOptions, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'
import { CodexToolOutput, type CodexActiveTurn, type CodexToolCall, type CodexToolSpec, type CodexTurn } from './codex'
import type { WorkerAccessMode } from './worker-policy'
import { cliVersion, compatibilityKey, rememberCompatible, requireCliOptions, RuntimeCompatibilityError, runtimeFailure, wasCompatible } from './compatibility'

interface Options {
  cwd: string; model?: string; effort?: 'low' | 'medium' | 'high'; executable?: string
  accessMode?: WorkerAccessMode
  onToolCall(call: CodexToolCall): Promise<unknown>
  /** Host-only test seams; never populated from chat or remote RPC. */
  query?: (params: { prompt: AsyncIterable<SDKUserMessage>; options: SDKOptions }) => Query
  probe?: (args: string[]) => Promise<string>
}
interface Thread { id: string; instructions: string; tools: CodexToolSpec[]; resume: boolean; ephemeral: boolean }
interface Turn { id: string; promise: Promise<CodexTurn>; resolve(value: CodexTurn): void; reject(error: Error): void; pendingInputs: Set<string>; interrupted: boolean }
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = []
  private waiting?: (result: IteratorResult<SDKUserMessage>) => void
  private ended = false
  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error('CC 输入通道已关闭')
    const waiting = this.waiting; this.waiting = undefined
    if (waiting) waiting({ value: message, done: false }); else this.values.push(message)
  }
  end(): void { this.ended = true; this.values = []; this.waiting?.({ value: undefined!, done: true }); this.waiting = undefined }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => this.values.length ? Promise.resolve({ value: this.values.shift()!, done: false }) : this.ended ? Promise.resolve({ value: undefined!, done: true }) : new Promise(resolve => { this.waiting = resolve }) }
  }
}

/** Router 仅使用宿主工具；全权限 Worker 在项目目录使用完整 CC。 */
export class ClaudeRuntime {
  private initialization?: Promise<void>
  private thread?: Thread
  private active?: Turn
  private conversation?: Query
  private reading?: Promise<void>
  private inputs = new InputQueue()
  private abort = new AbortController()
  private closing = false
  private failure?: Error
  private executable: string
  private version = 'unknown'
  private initVerified = false
  private initTimer?: ReturnType<typeof setTimeout>
  private pendingWrites = new Map<string, Promise<unknown>>()
  private interruptedWrites = new Map<string, Promise<unknown>>()
  constructor(private readonly options: Options) { this.executable = options.executable ?? Bun.which('claude') ?? 'claude' }

  initialize(): Promise<void> {
    if (this.closing) return Promise.reject(this.failure ?? new Error('CC runtime 已关闭'))
    return this.initialization ??= (async () => {
      mkdirSync(this.options.cwd, { recursive: true, mode: 0o700 })
      try {
        this.version = cliVersion(await this.probe(['--version']), 'claude')
      } catch (error) { throw error instanceof RuntimeCompatibilityError ? error : new Error('无法启动 Claude Code，请检查工作设备上的 CC 安装') }
      if (this.closing) throw new Error('CC runtime 已关闭')
      const key = this.options.probe ? undefined : compatibilityKey('claude', this.executable, this.version, this.options.accessMode ?? 'controlled')
      if (!key || !wasCompatible(key)) {
        const help = await this.probe(['--help']).catch(error => { throw runtimeFailure('Claude Code', error, '无法检查 Claude Code CLI 参数，请核对安装') })
        requireCliOptions(help, ['--print', '--input-format', '--output-format', '--replay-user-messages', '--include-partial-messages', '--tools', '--allowedTools', '--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config', '--system-prompt', '--append-system-prompt', '--agents', '--disable-slash-commands', '--resume', '--session-id', '--no-session-persistence', '--permission-mode'], `Claude Code ${this.version}`)
        if (this.closing) throw new Error('CC runtime 已关闭')
        if (key) rememberCompatible(key)
      }
    })()
  }
  private probe(args: string[]): Promise<string> {
    return this.options.probe?.(args) ?? new Promise<string>((resolve, reject) => {
      execFile(this.executable, args, { cwd: this.options.cwd, timeout: 5000, maxBuffer: 100000, signal: this.abort.signal, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
    })
  }
  async startThread(options: { instructions: string; tools: CodexToolSpec[]; ephemeral?: boolean }): Promise<string> {
    await this.initialize()
    if (this.thread) throw new Error('CC runtime 已绑定会话')
    this.thread = { id: randomUUID(), instructions: options.instructions, tools: options.tools, resume: false, ephemeral: options.ephemeral ?? false }
    return this.thread.id
  }
  async resumeThread(id: string, options: { instructions: string; tools?: CodexToolSpec[] }): Promise<string> {
    await this.initialize()
    if (this.thread || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('CC 恢复会话 ID 无效')
    this.thread = { id, instructions: options.instructions, tools: options.tools ?? [], resume: true, ephemeral: false }
    return id
  }
  private assertThread(id: string): Thread {
    if (this.closing || this.failure) throw this.failure ?? new Error('CC runtime 已关闭')
    if (!this.thread || this.thread.id !== id) throw new Error('CC 会话不匹配')
    return this.thread
  }
  private assertTurn(threadId: string, turnId: string): Turn {
    this.assertThread(threadId)
    if (!this.active || this.active.id !== turnId || this.active.interrupted) throw new Error('CC 活动轮次已变化')
    return this.active
  }
  async startTurn(threadId: string, text: string, inputId?: string): Promise<CodexActiveTurn> {
    const thread = this.assertThread(threadId)
    if (this.active) throw new Error('CC 此会话已有活动轮次')
    let resolve!: Turn['resolve']; let reject!: Turn['reject']
    const promise = new Promise<CodexTurn>((yes, no) => { resolve = yes; reject = no })
    // close can race the caller obtaining the promise.
    void promise.catch(() => undefined)
    const turn: Turn = { id: randomUUID(), promise, resolve, reject, pendingInputs: new Set(), interrupted: false }
    this.interruptedWrites.clear()
    this.active = turn
    try {
      if (!this.conversation) this.boot(thread)
      this.sendInput(turn, text, inputId)
    } catch (error) { this.fail(error instanceof Error ? error : new Error('CC 启动失败')); throw error }
    return { threadId, turnId: turn.id, done: promise }
  }
  private sendInput(turn: Turn, text: string, _inputId?: string, priority?: 'now'): void {
    const uuid = randomUUID()
    turn.pendingInputs.add(uuid)
    this.inputs.push({ type: 'user', uuid, session_id: this.thread!.id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] }, ...(priority ? { priority } : {}) })
  }
  async steer(threadId: string, turnId: string, text: string, inputId?: string): Promise<string> {
    const turn = this.assertTurn(threadId, turnId)
    // Only in-flight writes can lose their result when CC interrupts for immediate input.
    for (const [key, result] of this.pendingWrites) this.interruptedWrites.set(key, result)
    this.sendInput(turn, text, inputId, 'now')
    return turnId
  }
  async interrupt(threadId: string, turnId: string): Promise<void> {
    const turn = this.assertTurn(threadId, turnId)
    turn.interrupted = true
    await this.conversation?.interrupt()
    // The service closes the client after interruption; the result may arrive first.
  }
  private boot(thread: Thread): void {
    const fullAccess = this.options.accessMode === 'full-access'
    const names = thread.tools.map(t => `mcp__ce_runtime__${t.name}`)
    const allowed = new Set(names)
    const tools = thread.tools.map(spec => {
      const schema = z.fromJSONSchema(spec.inputSchema) as z.ZodObject
      if (!schema.shape) throw new Error('CC 工具参数必须是对象')
      return tool(spec.name, spec.description, schema.shape, async args => {
        try {
          if (!this.initVerified) throw new RuntimeCompatibilityError('CC 初始化信息尚未验证，禁止执行工具')
          const turn = this.active
          if (!turn) throw new Error('CC 无活动轮次，工具调用已失效')
          this.assertTurn(thread.id, turn.id)
          const writes = ['project_create_file', 'project_edit_file', 'project_delete_file', 'project_run_command'].includes(spec.name)
          const key = JSON.stringify([spec.name, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))])
          let result = writes ? this.interruptedWrites.get(key) : undefined
          if (result) this.interruptedWrites.delete(key)
          else {
            // Any new write invalidates the replay window: a later identical test
            // command must actually run against the newly edited project.
            if (writes) this.interruptedWrites.clear()
            result = this.options.onToolCall({ threadId: thread.id, turnId: turn.id, callId: randomUUID(), tool: spec.name, arguments: args as Record<string, unknown> })
            if (writes) this.pendingWrites.set(key, result)
          }
          let output: unknown
          try { output = await result }
          finally { if (this.pendingWrites.get(key) === result) this.pendingWrites.delete(key) }
          this.assertTurn(thread.id, turn.id)
          if (output instanceof CodexToolOutput) return { content: output.contentItems.map(item => {
            if (item.type === 'inputText') return { type: 'text' as const, text: item.text }
            const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(item.imageUrl)
            if (!match) throw new Error('图片必须来自宿主的本地附件')
            return { type: 'image' as const, mimeType: match[1], data: match[2] }
          }) }
          return { content: [{ type: 'text' as const, text: typeof output === 'string' ? output : JSON.stringify(output) ?? 'null' }] }
        } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '宿主工具失败' }] } }
      })
    })
    this.conversation = (this.options.query ?? query)({ prompt: this.inputs, options: {
      cwd: this.options.cwd, pathToClaudeCodeExecutable: this.executable, abortController: this.abort,
      ...(fullAccess ? { tools: { type: 'preset' as const, preset: 'claude_code' as const }, settingSources: ['user', 'project', 'local'] as SDKOptions['settingSources'], sandbox: { enabled: false } }
        : { tools: [], allowedTools: [], settingSources: [], strictMcpConfig: true, skills: [], agents: {}, plugins: [], settings: { disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {} } }),
      mcpServers: { ce_runtime: createSdkMcpServer({ name: 'ce_runtime', version: '1', tools }) },
      canUseTool: async (name, input) => this.initVerified && (fullAccess || allowed.has(name)) && !!this.active && !this.closing && !this.active.interrupted
        ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '数字人只能使用当前宿主明确授权的工具' },
      permissionMode: 'default',
      systemPrompt: fullAccess ? { type: 'preset', preset: 'claude_code', append: thread.instructions } : thread.instructions, ...(thread.resume ? { resume: thread.id } : { sessionId: thread.id }),
      persistSession: !thread.ephemeral, model: this.options.model, effort: this.options.effort ?? 'low',
      includePartialMessages: true, extraArgs: { 'replay-user-messages': null },
      env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' },
      stderr: () => { /* SDK stderr may contain auth configuration; do not forward it. */ },
    } })
    this.initTimer = setTimeout(() => this.fail(new RuntimeCompatibilityError(`Claude Code ${this.version} 未及时提供可验证的初始化信息，请检查 CLI 与 SDK 兼容性`)), 30_000)
    this.initTimer.unref?.()
    this.reading = this.read(this.conversation, thread, allowed)
  }
  private async read(conversation: Query, thread: Thread, allowed: Set<string>): Promise<void> {
    try {
      for await (const message of conversation) {
        if (this.closing) break
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.session_id !== thread.id || !Array.isArray(message.tools) || (this.options.accessMode !== 'full-access' && message.tools.some(name => !allowed.has(name)))) throw new RuntimeCompatibilityError('CC 运行环境包含未授权工具或会话不匹配')
          if ([...allowed].some(name => !message.tools.includes(name))) throw new RuntimeCompatibilityError(`Claude Code ${this.version} 未提供必要宿主工具，不能开始数字人工作`)
          if (message.permissionMode !== 'default') throw new RuntimeCompatibilityError(`Claude Code ${this.version} 实际权限模式与 CE 要求不符`)
          this.initVerified = true
          clearTimeout(this.initTimer)
        }
        if (message.type === 'user' && message.uuid) this.active?.pendingInputs.delete(message.uuid)
        if (message.type === 'result') {
          if (!this.initVerified) {
            if (message.subtype !== 'success' || message.is_error) throw runtimeFailure('Claude Code', 'errors' in message ? message.errors.join('\n') : '')
            throw new RuntimeCompatibilityError(`Claude Code ${this.version} 缺少经过验证的初始化信息，未接受本轮结果`)
          }
          this.finishResult(message)
        }
      }
      if (!this.closing) this.fail(new Error('CC 会话意外结束'))
    } catch (error) { if (!this.closing) this.fail(runtimeFailure('Claude Code', error, 'CC 运行中断，请检查工作设备的模型连接并重试')) }
  }
  private finishResult(message: Extract<SDKMessage, { type: 'result' }>): void {
    const turn = this.active
    if (!turn) return
    const failed = message.subtype !== 'success' || message.is_error
    // An earlier completion can race an input enqueued with priority now. Wait
    // for the SDK to echo that input before treating a completion as final.
    if (!failed && !turn.interrupted && turn.pendingInputs.size) return
    this.active = undefined
    turn.resolve({ id: turn.id, status: turn.interrupted ? 'interrupted' : failed ? 'failed' : 'completed',
      ...(failed ? { error: { message: runtimeFailure('Claude Code', 'errors' in message ? message.errors.join('\n') : '').message } } : {}),
      ...(message.subtype === 'success' ? { items: [{ type: 'agentMessage', text: message.result }] } : {}) })
  }
  private fail(error: Error): void { clearTimeout(this.initTimer); this.initVerified = false; this.failure ??= error; const turn = this.active; this.active = undefined; turn?.reject(error); this.inputs.end(); this.conversation?.close() }
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true; this.fail(new Error('CC runtime 已关闭')); this.abort.abort()
    await this.reading
  }
}
