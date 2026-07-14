import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * 管家大脑可调的【终端工具】——工具无关的终端管理接口。
 *
 * 这三个工具是管家"凌驾所有终端之上"的手:list 看有哪些、read 读屏(任意工具的输出都行)、
 * send 敲键(给 cc/codex/opencode/裸 shell 发输入都一样)。handler 跑在 ce 进程内。
 *
 * tid = 终端在 list 里的序号(1..N),管家据此引用。
 *
 * ⚠️ list 的数据源是【Jupyter /api/terminals】(机器上所有终端,权威),不是 ce 的输出缓冲
 *   (缓冲只含 ce 见过输出的终端——没喷过输出的终端会漏,曾导致"只列出 1 个"的 bug)。
 */
export interface ToolDeps {
  /** 列机器上所有终端名(查 Jupyter /api/terminals)。权威来源。 */
  listTerminals: () => Promise<string[]>
  /** 读某终端最近 N 行(ce 输出缓冲)。 */
  readTerminal: (name: string, lines: number) => string
  /** 往某终端写输入(写其 terminado stdin)。 */
  send: (name: string, text: string) => Promise<void>
}

export function makeButlerTools(deps: ToolDeps): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      'list_terminals',
      '列出当前所有终端及各自最后一行。tid 是这里给每个终端的编号(1..N),供 read/send 引用。',
      {},
      async () => {
        const names = await deps.listTerminals()
        const lines = names.map(
          (n, i) => `#${i + 1} ${n} · 末行: ${(deps.readTerminal(n, 1) || '(无输出)').slice(0, 80)}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') || '(无终端)' }] }
      },
    ),
    tool(
      'read_terminal',
      '读某终端最近 N 行输出(已剥样式;尾部≈当前帧)。读 cc/codex/opencode/服务/裸 shell 都一样。tid 为 list_terminals 编号。',
      { tid: z.number().describe('终端编号,见 list_terminals'), lines: z.number().default(50).describe('读最近 N 行,上限 200') },
      async (a) => {
        const names = await deps.listTerminals()
        const name = names[a.tid - 1]
        const body = name ? deps.readTerminal(name, Math.min(a.lines, 200)) : `(tid ${a.tid} 不存在)`
        return { content: [{ type: 'text', text: body }] }
      },
    ),
    tool(
      'send_terminal',
      '往某终端发送输入(回车用 \\r;给 cc/codex/opencode/shell 发都一样)。会请求用户审批。tid 为 list_terminals 编号。',
      { tid: z.number().describe('终端编号'), text: z.string().describe('要发送的输入,回车用 \\r') },
      async (a) => {
        const names = await deps.listTerminals()
        const name = names[a.tid - 1]
        if (!name) return { content: [{ type: 'text', text: `(tid ${a.tid} 不存在)` }], isError: true }
        await deps.send(name, a.text)
        return { content: [{ type: 'text', text: '已发送' }] }
      },
    ),
  ]
}
