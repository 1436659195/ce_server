import { test, expect } from 'bun:test'
import { makeButlerTools, type ToolDeps } from '../src/cli/butler-tools'

/** mock deps:listTerminals 返预设名表,readTerminal 按名返内容,send 记录。 */
const mockDeps = (list: string[], read: (n: string) => string, sendFn?: (n: string, t: string) => void): ToolDeps => ({
  listTerminals: async () => list,
  readTerminal: (n: string, _lines: number) => read(n),
  send: async (n, t) => sendFn?.(n, t),
})

/** 数组里各工具 schema 不同、handler 参数被宽化 → 测试里取 handler 转 any 调用(运行时 SDK 按类型喂参)。 */
const h = (tools: ReturnType<typeof makeButlerTools>, name: string) =>
  tools.find((t) => t.name === name)!.handler as (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>

test('list_terminals:返每终端名 + 末行', async () => {
  const tools = makeButlerTools(mockDeps(['t1', 't2'], (n) => (n === 't1' ? 'hello' : '')))
  const r = await h(tools, 'list_terminals')({}, undefined)
  const text = JSON.stringify(r)
  expect(text).toContain('#1 t1')
  expect(text).toContain('hello')
  expect(text).toContain('#2 t2')
})

test('read_terminal:读指定 tid 的尾行', async () => {
  const tools = makeButlerTools(mockDeps(['t1', 't2'], () => 'a\nb\nc'))
  const r = await h(tools, 'read_terminal')({ tid: 2, lines: 2 }, undefined)
  expect(JSON.stringify(r)).toContain('b') // 尾 2 行含 b、c
})

test('read_terminal:tid 不存在 → 提示', async () => {
  const tools = makeButlerTools(mockDeps(['t1'], () => 'x'))
  const r = await h(tools, 'read_terminal')({ tid: 9, lines: 5 }, undefined)
  expect(JSON.stringify(r)).toContain('不存在')
})

test('send_terminal:调 send(name, text)', async () => {
  const sent: [string, string][] = []
  const tools = makeButlerTools(mockDeps(['t1'], () => '', (n, t) => { sent.push([n, t]) }))
  await h(tools, 'send_terminal')({ tid: 1, text: 'ls\r' }, undefined)
  expect(sent).toEqual([['t1', 'ls\r']])
})

test('send_terminal:tid 不存在 → isError 且不调 send', async () => {
  let called = false
  const tools = makeButlerTools(mockDeps(['t1'], () => '', () => { called = true }))
  const r = await h(tools, 'send_terminal')({ tid: 9, text: 'x' }, undefined)
  expect(r.isError).toBe(true)
  expect(called).toBe(false)
})
