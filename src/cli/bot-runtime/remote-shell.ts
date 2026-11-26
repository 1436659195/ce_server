/**
 * 远程命令执行 —— 数字人在另一台机器的终端里跑命令。
 * 一台电脑一个终端;命令后面跟一行「哨兵」(回显上一条命令退出码的标记),看到标记才知道命令结束、退出码是多少。
 * 只做执行:连到哪台机器、用哪张票据由调用方给;每条命令的审计在 service.ts。
 */
import { stripAnsi } from '../ansi'
import { RemotePeer, type RemoteTicket } from '../remote-peer'
export type { RemoteTicket } from '../remote-peer'

/** 通道的最小形状:真实实现是 RemotePeer,测试用假对象。 */
export interface RemoteChannel {
  readonly isOpen: boolean
  rpc<T = unknown>(req: Record<string, unknown>, timeoutMs?: number): Promise<T>
  attach(name: string, finger: string | undefined, rows: number, cols: number): void
  stdin(name: string, text: string): void
  close(): void
  onOutput: (sid: string, text: string) => void
  onControl: (msg: Record<string, unknown>) => void
  onState: (state: string) => void
}

/** 给数字人看的「另一台电脑」:不带任何密钥。 */
export interface RemoteComputerTarget {
  id: string
  label: string
  /** 授权目录的逻辑路径(相对对端文件根目录)。 */
  directory: string
  directoryAbs: string
  platform?: string
}

export interface RemoteRunResult {
  opId: string
  state: 'done' | 'running' | 'failed'
  exitCode?: number
  /** 这一段输出(从 offset 起,最多一页)。 */
  output: string
  /** 下一段从这里取;小于 totalChars 说明还没取完。 */
  nextOffset: number
  /** 这条命令到现在为止一共多少字(清理之后)。 */
  totalChars: number
  elapsedMs: number
  error?: string
}

/** 起步参数:真实使用后可调。 */
export const REMOTE_LIMITS = { commandChars: 4000, waitMs: 20_000, maxWaitMs: 60_000, pageChars: 8000, keepChars: 200_000 } as const

const sentinelFor = (opId: string, platform?: string): string =>
  platform === 'win32' ? `echo __CE_RDY_${opId}__%ERRORLEVEL%` : `echo "__CE_RDY_${opId}__$?"`

/** 找结束标记:只认带数字退出码的;回显里的 $? 不是数字,不会误中;紧贴着输出(没有换行)也能认。 */
export function findSentinel(text: string, opId: string): { exitCode: number; start: number; end: number } | undefined {
  const m = new RegExp(`__CE_RDY_${opId}__(\\d{1,3})(?:\\r?\\n|$)`).exec(text)
  return m ? { exitCode: Number(m[1]), start: m.index, end: m.index + m[0].length } : undefined
}

/**
 * 把终端吐出来的原文清成给模型看的输出:去终端转义、去回车、去回显的命令行、去哨兵行。
 * 回显是否算数由第一行决定:第一行以命令的第一行结尾才算回显(被终端折行时对不上,就一行都不删,
 * 免得把恰好和命令同文的输出删掉)。
 */
export class OutputCleaner {
  private pending = ''
  private lines = 0
  private echo: boolean | undefined
  private readonly commandLines: string[]

  constructor(command: string) {
    this.commandLines = command.split('\n')
  }

  /** 喂一段原文,返回要接到输出末尾的文本;flush = 这条命令结束了,把最后半行也当整行。 */
  feed(chunk: string, flush = false): string {
    this.pending += chunk
    const parts = this.pending.split('\n')
    this.pending = flush ? '' : (parts.pop() ?? '')
    if (flush && chunk.endsWith('\n') && this.pending === '' && parts.at(-1) === '') parts.pop() // 结尾的换行符不是一行,别数成空行
    let out = ''
    for (const line of parts) out += this.line(line, true)
    if (flush && this.pending) out += this.line(this.pending, false)
    return out
  }

  private line(text: string, newline: boolean): string {
    const i = this.lines++
    if (text.includes('__CE_RDY_')) return '' // 哨兵的回显或本体:整行删掉,连换行一起(不留下空行)
    const expected = this.commandLines[i]
    if (i === 0) this.echo = expected !== undefined && text.endsWith(expected)
    if (this.echo && expected !== undefined && text.endsWith(expected)) return '' // 回显的命令行(前面带着提示符)
    return newline ? `${text}\n` : text
  }
}

/** 清理一段完整的输出(纯函数,单测用)。 */
export function cleanOutput(raw: string, command: string): string {
  return new OutputCleaner(command).feed(stripAnsi(raw).replace(/\r/g, ''), true)
}

/** 路径加引号:非 Windows 用单引号,Windows 用双引号。 */
export function shellQuote(path: string, platform?: string): string {
  return platform === 'win32' ? `"${path.replace(/"/g, '\\"')}"` : `'${path.replace(/'/g, `'\\''`)}'`
}

interface RemoteOp {
  opId: string
  command: string
  startAt: number
  cleaner: OutputCleaner
  /** 原文里已经喂给清理器的位置。 */
  consumed: number
  /** 清理后的输出开头被丢弃的字数(超过保留上限时只留尾部)。 */
  dropped: number
  text: string
  raw: string
  done: boolean
  exitCode?: number
  error?: string
  waiters: Array<() => void>
}

export class RemoteShellSession {
  private ops = new Map<string, RemoteOp>()
  private current: RemoteOp | undefined
  private seq = 0
  private broken: string | undefined
  private closed = false

  private constructor(
    private readonly peer: RemoteChannel,
    private readonly computer: RemoteComputerTarget,
    readonly name: string,
    private readonly limits: { keepChars: number; pageChars: number },
  ) {
    peer.onOutput = (sid, text) => {
      const op = this.current
      // 没有进行中的命令时,终端吐的东西(提示符、上条命令的收尾)不算谁的输出
      if (sid !== name || !op || op.done) return
      this.feed(op, stripAnsi(text).replace(/\r/g, ''))
    }
    peer.onControl = (msg) => {
      if (msg.op === 'grantRevoked') this.breakOff('对端已撤销授权')
      else if (msg.op === 'termGone' && msg.name === name) this.breakOff('对端上的终端已不在')
    }
    peer.onState = () => this.breakOff('连接中断')
  }

  /**
   * 开会话:清掉自己上回留下的终端(A 异常退出会留孤儿)→ 在授权目录里新建 → 接上 → 核对当前目录。
   * 对端建终端时目录不存在会在别处静默启动,所以最后一步必须对得上。
   */
  static async open(peer: RemoteChannel, computer: RemoteComputerTarget, opts: { settleMs?: number; limits?: Partial<{ keepChars: number; pageChars: number }> } = {}): Promise<RemoteShellSession> {
    const limits = { keepChars: opts.limits?.keepChars ?? REMOTE_LIMITS.keepChars, pageChars: opts.limits?.pageChars ?? REMOTE_LIMITS.pageChars }
    const own = await peer.rpc<{ ok: boolean; data?: { terminals?: Array<{ name: string }> }; error?: string }>({ op: 'listTerminals' })
    for (const t of own.data?.terminals ?? []) await peer.rpc({ op: 'deleteTerminal', name: t.name }).catch(() => undefined)
    const created = await peer.rpc<{ ok: boolean; data?: { name: string; finger?: string }; error?: string }>({ op: 'createTerminal', cwd: computer.directory })
    if (!created.ok || !created.data?.name) throw new Error(`对端开不了终端:${created.error ?? '未知原因'}`)
    const session = new RemoteShellSession(peer, computer, created.data.name, limits)
    peer.attach(created.data.name, created.data.finger, 24, 200)
    if (opts.settleMs) await Bun.sleep(opts.settleMs) // 等 shell 起来、吐完横幅,再发第一条命令
    try {
      const check = await session.run(`cd ${shellQuote(computer.directoryAbs, computer.platform)} && pwd`)
      const pwd = check.output.trim().split('\n').at(-1) ?? ''
      if (check.state !== 'done' || check.exitCode !== 0 || pwd.replace(/\/+$/, '') !== computer.directoryAbs.replace(/\/+$/, '')) {
        throw new Error(`对端当前目录对不上:要在 ${computer.directoryAbs},实际在「${pwd}」(state=${check.state} exit=${check.exitCode} output=${JSON.stringify(check.output)})`)
      }
    } catch (error) {
      await session.close()
      throw error
    }
    return session
  }

  /** 执行一条命令,最多等 waitMs;没结束就返回 running,之后用 poll 接着取。 */
  async run(command: string, waitMs: number = REMOTE_LIMITS.waitMs): Promise<RemoteRunResult> {
    if (this.broken) throw new Error(this.broken)
    if (this.current && !this.current.done) throw new Error('上一条命令还没结束:先用 remote_poll 取后续输出;交互式命令用 remote_input 发送 "\\u0003" 中断')
    if (command.length > REMOTE_LIMITS.commandChars) throw new Error(`命令太长(最多 ${REMOTE_LIMITS.commandChars} 字符)`)
    if (command.includes('\r')) throw new Error('命令里不能带回车:多条命令用换行或 && 分开')
    const op: RemoteOp = { opId: `op${++this.seq}`, command, startAt: Date.now(), cleaner: new OutputCleaner(command), consumed: 0, dropped: 0, text: '', raw: '', done: false, waiters: [] }
    this.ops.set(op.opId, op)
    this.current = op
    this.peer.stdin(this.name, `${command}\r`)
    this.peer.stdin(this.name, `${sentinelFor(op.opId, this.computer.platform)}\r`) // 单独一行:$? 是上一条命令的状态
    return this.settle(op, waitMs)
  }

  /** 取某条命令的后续输出;offset 是上次给的 nextOffset。 */
  async poll(opId: string, opts: { waitMs?: number; offset?: number } = {}): Promise<RemoteRunResult> {
    const op = this.ops.get(opId)
    if (!op) throw new Error(`没有这条命令:${opId}`)
    return this.settle(op, opts.waitMs ?? 0, opts.offset ?? 0)
  }

  /** 直接往终端里敲字:应答提示、密码、Ctrl-C 中断。 */
  input(text: string): void {
    if (this.broken) throw new Error(this.broken)
    this.peer.stdin(this.name, text)
  }

  /** 关会话:关掉对端上的终端,再断开连接。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.peer.rpc({ op: 'deleteTerminal', name: this.name }).catch(() => undefined)
    this.breakOff('会话已关闭')
    this.peer.close()
  }

  private settle(op: RemoteOp, waitMs: number, offset = 0): Promise<RemoteRunResult> {
    const limit = Math.min(waitMs, REMOTE_LIMITS.maxWaitMs)
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        // 只留了尾部时,早于保留起点的部分取不回来:从保留下来的第一处给起
        const from = Math.max(offset, op.dropped)
        const output = op.text.slice(from - op.dropped, from - op.dropped + this.limits.pageChars)
        resolve({
          opId: op.opId,
          state: op.error ? 'failed' : op.done ? 'done' : 'running',
          ...(op.exitCode !== undefined ? { exitCode: op.exitCode } : {}),
          output,
          nextOffset: from + output.length,
          totalChars: op.dropped + op.text.length,
          elapsedMs: Date.now() - op.startAt,
          ...(op.error ? { error: op.error } : {}),
        })
      }
      const timer = setTimeout(finish, limit)
      if (op.done || limit === 0) finish()
      else op.waiters.push(finish)
    })
  }

  private feed(op: RemoteOp, text: string): void {
    const combined = op.raw + text
    const kept = combined.length > REMOTE_LIMITS.keepChars * 2 ? combined.slice(-REMOTE_LIMITS.keepChars * 2) : combined
    op.consumed = Math.max(0, op.consumed - (combined.length - kept.length))
    op.raw = kept
    // 只在新到的这一段(带一点重叠,防标记被拆在两段里)里找结束标记,输出再长也不重扫
    const from = Math.max(op.consumed, op.raw.length - text.length - 40)
    const found = findSentinel(op.raw.slice(from), op.opId)
    const end = found ? from + found.start : op.raw.length
    const chunk = op.raw.slice(op.consumed, end)
    op.consumed += chunk.length
    if (chunk.length) this.append(op, op.cleaner.feed(chunk, found !== undefined)) // 空段不喂:flush 空段会把残留的空行当一行
    if (!found) return
    op.done = true
    op.exitCode = found.exitCode
    for (const w of op.waiters.splice(0)) w()
  }

  private append(op: RemoteOp, text: string): void {
    if (!text) return
    op.text += text
    if (op.text.length > this.limits.keepChars) {
      const cut = op.text.length - this.limits.keepChars
      op.text = op.text.slice(cut)
      op.dropped += cut
    }
  }

  /** 连接断了、授权撤销、终端没了:进行中的命令结果未知,会话不再可用。 */
  private breakOff(reason: string): void {
    this.broken ??= `${reason},远程会话已结束`
    const op = this.current
    if (op && !op.done) {
      op.done = true
      op.error = `${reason},命令结果未知`
      for (const w of op.waiters.splice(0)) w()
    }
  }
}

/** 每个数字人、每台电脑一个会话。 */
export class RemoteShellPool {
  private sessions = new Map<string, Map<string, RemoteShellSession>>()

  constructor(private readonly opts: { connect?: (ticket: RemoteTicket) => Promise<RemoteChannel>; settleMs?: number } = {}) {}

  async open(botId: string, computer: RemoteComputerTarget, ticket: RemoteTicket): Promise<RemoteShellSession> {
    const existing = this.sessions.get(botId)?.get(computer.id)
    if (existing) return existing
    const peer = this.opts.connect ? await this.opts.connect(ticket) : ((await RemotePeer.connect(ticket)) as RemoteChannel)
    try {
      const session = await RemoteShellSession.open(peer, computer, { settleMs: this.opts.settleMs ?? 400 })
      let byComputer = this.sessions.get(botId)
      if (!byComputer) this.sessions.set(botId, (byComputer = new Map()))
      byComputer.set(computer.id, session)
      return session
    } catch (error) {
      peer.close()
      throw error
    }
  }

  get(botId: string, computerId: string): RemoteShellSession | undefined {
    return this.sessions.get(botId)?.get(computerId)
  }

  /** 关掉某个数字人在某台(或全部)电脑上的会话。 */
  async close(botId: string, computerId?: string): Promise<void> {
    const byComputer = this.sessions.get(botId)
    if (!byComputer) return
    for (const [id, session] of byComputer) {
      if (computerId && id !== computerId) continue
      byComputer.delete(id)
      await session.close()
    }
    if (!byComputer.size) this.sessions.delete(botId)
  }
}
