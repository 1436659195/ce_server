import { stripAnsi } from './ansi'

/**
 * 每终端的输出环形缓冲(ANSI 已剥、\r 去除、跨 chunk 的不完整行正确拼接)。
 *
 * 为什么需要:管家大脑在 ce 上,而终端的 xterm 渲染在手机上——ce 够不着 xterm。
 * 但 ce 是终端字节(terminado stdout)的必经转发路径,顺便缓存一份纯文本即可,
 * 让 read_terminal 工具完全在 ce 本地取数、不回程问手机(比旧 FETCH 还简)。
 *
 * 取尾部 N 行 ≈ 当前帧:全屏重绘型 TUI(cc/codex)每次重画整屏,缓冲尾部就是最近一帧。
 */
export class TermBuffers {
  constructor(private readonly maxLines: number) {}

  /** 完整行(以 \n 结尾过的)。 */
  private lines = new Map<string, string[]>()
  /** 末尾未以 \n 结尾的片段,下次 append 续接(跨 chunk 拼同一行)。 */
  private pending = new Map<string, string>()

  /** 喂一段 terminado 原始字节(含 ANSI):剥样式、拼 pending、按行入缓冲、超上限丢头部。 */
  append(name: string, chunk: Buffer): void {
    const text = stripAnsi(chunk.toString('utf8')).replace(/\r/g, '')
    const combined = (this.pending.get(name) ?? '') + text
    const parts = combined.split('\n')
    this.pending.set(name, parts.pop() ?? '') // 末段(无 \n)留作下次续接
    const cur = this.lines.get(name) ?? []
    for (const l of parts) cur.push(l)
    while (cur.length > this.maxLines) cur.shift()
    this.lines.set(name, cur)
  }

  /** 读某终端最近 n 行(拼成带 \n 的字符串)。无则空串。 */
  read(name: string, n: number): string {
    const cur = this.lines.get(name)
    if (!cur?.length) return ''
    return cur.slice(Math.max(0, cur.length - n)).join('\n')
  }

  /** 所有有缓冲的终端名。 */
  list(): string[] {
    return [...this.lines.keys()]
  }
}
