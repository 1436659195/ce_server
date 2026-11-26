import { test, expect, describe } from 'bun:test'
import { RemoteShellPool, cleanOutput, findSentinel, shellQuote, type RemoteChannel, type RemoteRunResult } from '../src/cli/bot-runtime/remote-shell'

// 远程命令执行:一台电脑一个终端,命令后面跟一行「哨兵」(回显退出码的标记)。
// 这里用一个假的通道扮演对端:回显输入、按哨兵回退出码,可以扣住哨兵不回来(模拟长命令)。

const COMPUTER = { id: 'c1', label: '运维@机器B', directory: '/proj', directoryAbs: '/srv/proj' }
const TICKET = { grantId: 'grant_abc', key: 'k', peerId: 'grant-abc', relayUrl: 'ws://relay.test', sid: 's', cliPub: 'p', token: 't' }

function fake(opts: { pwd?: string } = {}) {
  const calls: Array<Record<string, unknown>> = []
  const replies = new Map<string, string[]>()
  const held = new Set<string>()
  const waiting: Array<() => void> = []
  const state = { nextExit: 0 }
  const api: { emit: (text: string) => void } = { emit: (text) => channel.onOutput('3', text) }
  const channel = {
    isOpen: true,
    onOutput: (() => {}) as (sid: string, text: string) => void,
    onControl: (() => {}) as (msg: Record<string, unknown>) => void,
    onState: (() => {}) as (state: string) => void,
    async rpc<T = unknown>(req: Record<string, unknown>): Promise<T> {
      calls.push({ kind: 'rpc', ...req })
      if (req.op === 'listTerminals') return { ok: true, data: { terminals: [{ name: '7', ownedByMe: true }] } } as T
      if (req.op === 'createTerminal') return { ok: true, data: { name: '3', finger: 'f3' } } as T
      return { ok: true } as T
    },
    attach: (name: string, finger: string | undefined, rows: number, cols: number) => {
      calls.push({ kind: 'attach', name, finger, rows, cols })
    },
    stdin: (name: string, text: string) => {
      calls.push({ kind: 'stdin', name, text })
      const sentinel = /^echo "__CE_RDY_(op\d+)__\$\?"\r$/.exec(text) // 精确匹配哨兵行(引号包着字面 $?)
      if (sentinel) {
        const finish = () => api.emit(`__CE_RDY_${sentinel[1]}__${state.nextExit}\r\n`)
        if (held.size) waiting.push(finish)
        else queueMicrotask(finish)
        return
      }
      const command = text.slice(0, -1)
      queueMicrotask(() => {
        api.emit(`\x1b[?2004h${text}\r\n`) // 回显,顺带一个终端转义
        if (command.includes('pwd')) api.emit(`${opts.pwd ?? '/srv/proj'}\r\n`)
        for (const line of replies.get(command) ?? []) api.emit(`${line}\r\n`)
      })
    },
    close() {
      ;(channel as { isOpen: boolean }).isOpen = false // 测试要模拟断开:关掉 isOpen
      calls.push({ kind: 'close' })
    },
  } satisfies RemoteChannel
  return {
    channel, calls, state,
    respond: (command: string, ...lines: string[]) => { replies.set(command, lines) },
    hold: (command: string) => { held.add(command) },
    release: () => { held.clear(); for (const w of waiting.splice(0)) w() },
    /** 假装对端吐了一段终端输出。 */
    emit: (text: string) => api.emit(text),
  }
}

async function open(opts: { pwd?: string } = {}) {
  const f = fake(opts)
  const pool = new RemoteShellPool({ connect: async () => f.channel, settleMs: 0 })
  const session = await pool.open('bot-1', COMPUTER, TICKET)
  return { f, pool, session }
}

describe('打开和关闭会话', () => {
  test('先清掉自己上回留下的终端,再在授权目录里新建、接上,并核对当前目录', async () => {
    const { f, pool, session } = await open()
    expect(f.calls.slice(0, 5)).toEqual([
      { kind: 'rpc', op: 'listTerminals' },
      { kind: 'rpc', op: 'deleteTerminal', name: '7' },
      { kind: 'rpc', op: 'createTerminal', cwd: '/proj' },
      { kind: 'attach', name: '3', finger: 'f3', rows: 24, cols: 200 },
      { kind: 'stdin', name: '3', text: "cd '/srv/proj' && pwd\r" },
    ])
    expect(pool.get('bot-1', 'c1')).toBe(session)
    expect(await pool.open('bot-1', COMPUTER, TICKET)).toBe(session) // 同一台电脑复用同一个会话
    await pool.close('bot-1')
    expect(f.calls.filter(c => c.kind === 'rpc').at(-1)).toMatchObject({ op: 'deleteTerminal', name: '3' })
    expect(f.calls.at(-1)).toEqual({ kind: 'close' })
    expect(pool.get('bot-1', 'c1')).toBeUndefined()
  })

  test('当前目录和票据对不上:会话不开,终端顺手关掉', async () => {
    const { f, pool } = await (async () => {
      const f = fake({ pwd: '/elsewhere' })
      const pool = new RemoteShellPool({ connect: async () => f.channel, settleMs: 0 })
      await expect(pool.open('bot-1', COMPUTER, TICKET)).rejects.toThrow(/目录/)
      return { f, pool }
    })()
    expect(pool.get('bot-1', 'c1')).toBeUndefined()
    expect(f.calls.filter(c => c.kind === 'rpc').at(-1)).toMatchObject({ op: 'deleteTerminal', name: '3' })
    expect(f.calls.at(-1)).toEqual({ kind: 'close' })
  })
})

describe('执行命令', () => {
  test('拿到退出码和去掉回显、转义、哨兵之后的输出;多行命令也可以', async () => {
    const { f, session } = await open()
    f.respond('echo hi', 'hi')
    const r = await session.run('echo hi')
    expect(r).toMatchObject({ state: 'done', exitCode: 0 })
    expect(r.output).toBe('hi\n')
    expect(r.totalChars).toBe(3)
    f.respond("cat <<'EOF'\nline1\nline2\nEOF", 'line1', 'line2')
    const m = await session.run("cat <<'EOF'\nline1\nline2\nEOF")
    expect(m).toMatchObject({ state: 'done', exitCode: 0 })
    expect(m.output).toBe('line1\nline2\n')
    f.state.nextExit = 3
    expect(await session.run('false')).toMatchObject({ state: 'done', exitCode: 3 })
    f.state.nextExit = 0
  })

  test('等不到结束:先返回 running;它没结束前发不出第二条;之后用 poll 接着取', async () => {
    const { f, session } = await open()
    f.hold('sleep 2')
    const first = (await session.run('sleep 2', 80)) as RemoteRunResult
    expect(first.state).toBe('running')
    await expect(session.run('echo again')).rejects.toThrow(/还没结束/)
    expect(await session.poll(first.opId, { waitMs: 50 })).toMatchObject({ state: 'running' })
    f.release()
    expect(await session.poll(first.opId, { waitMs: 1000 })).toMatchObject({ state: 'done', exitCode: 0 })
    f.respond('echo again', 'again')
    expect(await session.run('echo again')).toMatchObject({ state: 'done', exitCode: 0, output: 'again\n' })
  })

  test('输出太长:一页一页取,带下一次的起点', async () => {
    const { f, session } = await open()
    f.respond('yes', ...Array.from({ length: 300 }, (_, i) => `line-${i}-${'x'.repeat(60)}`))
    const first = await session.run('yes')
    expect(first.state).toBe('done')
    expect(first.output.length).toBe(8000)
    expect(first.nextOffset).toBe(8000)
    expect(first.totalChars).toBeGreaterThan(8000)
    const second = await session.poll(first.opId, { offset: first.nextOffset })
    expect(second.output.length).toBe(8000)
    expect(second.output.startsWith(first.output.slice(-20).slice(0, 0))).toBe(true)
    const tail = await session.poll(first.opId, { offset: second.nextOffset })
    expect(tail.output.length).toBeLessThan(8000)
    expect(first.totalChars).toBe(8000 + 8000 + tail.output.length)
  })

  test('直接输入原样发给终端(应答提示、Ctrl-C 中断)', async () => {
    const { f, session } = await open()
    session.input('\u0003')
    expect(f.calls.at(-1)).toEqual({ kind: 'stdin', name: '3', text: '\u0003' })
  })

  test('命令本身有问题:太长或带回车,不发出去', async () => {
    const { session } = await open()
    await expect(session.run('x'.repeat(4001))).rejects.toThrow(/太长/)
    await expect(session.run('echo a\recho b')).rejects.toThrow(/回车/)
  })
})

describe('连接出状况', () => {
  test('连接断了:进行中的命令结果未知,之后的命令发不出去', async () => {
    const { f, session } = await open()
    f.hold('sleep 9')
    const r = (await session.run('sleep 9', 50)) as RemoteRunResult
    expect(r.state).toBe('running')
    f.channel.onState('closed')
    expect(await session.poll(r.opId)).toMatchObject({ state: 'failed', error: expect.stringContaining('结果未知') })
    await expect(session.run('echo hi')).rejects.toThrow(/断开|中断/)
  })

  test('授权被撤销:同样结束', async () => {
    const { f, session } = await open()
    f.channel.onControl({ op: 'grantRevoked', grantId: 'grant_abc' })
    await expect(session.run('echo hi')).rejects.toThrow(/撤销/)
  })
})

describe('纯函数', () => {
  test('哨兵:只认带数字退出码的结束标记;回显里的 $? 不算;紧贴输出也能认', () => {
    const plain = findSentinel('ok\r\n__CE_RDY_op1__0\r\n', 'op1')
    expect(plain?.exitCode).toBe(0)
    expect('ok\r\n__CE_RDY_op1__0\r\n'.slice(plain!.start, plain!.end)).toBe('__CE_RDY_op1__0\r\n')
    expect(findSentinel('done__CE_RDY_op1__127', 'op1')).toMatchObject({ exitCode: 127, start: 4, end: 21 })
    expect(findSentinel('echo "__CE_RDY_op1__$?"\r\n', 'op1')).toBeUndefined()
    expect(findSentinel('__CE_RDY_op2__0\n', 'op1')).toBeUndefined()
    expect(findSentinel('__CE_RDY_op1__0', 'op1')).toMatchObject({ exitCode: 0 }) // 换行还没到也算结束
  })

  test('清理输出:去回显行、去哨兵行、去回车;回显被折行时不动输出', () => {
    const raw = 'user@b:/srv/proj$ echo hi\r\nhi\r\nuser@b:/srv/proj$ echo "__CE_RDY_op1__$?"\r\n__CE_RDY_op1__0\r\n'
    expect(cleanOutput(raw, 'echo hi')).toBe('hi\n')
    expect(cleanOutput('$ echo hi\r\nfirst\r\nsecond\r\n', 'echo "wrapped')).toBe('$ echo hi\nfirst\nsecond\n') // 回显被折行对不上:整段保留,一个字不删
    // 多行命令:回显的每一行都删,输出里和命令同文的行不删
    expect(cleanOutput("$ cat <<'EOF'\r\n> line1\r\n> line2\r\n> EOF\r\nline1\r\nline2\r\n$ echo \"__CE_RDY_op1__$?\"\r\n__CE_RDY_op1__0\r\n", "cat <<'EOF'\nline1\nline2\nEOF")).toBe('line1\nline2\n')
  })

  test('路径加引号:非 Windows 用单引号,Windows 用双引号', () => {
    expect(shellQuote("/srv/it's here", 'linux')).toBe("'/srv/it'\\''s here'")
    expect(shellQuote('/srv/plain', 'linux')).toBe("'/srv/plain'")
    expect(shellQuote('C:\\work dir', 'win32')).toBe('"C:\\work dir"')
  })
})
