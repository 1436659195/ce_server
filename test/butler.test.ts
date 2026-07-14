import { test, expect } from 'bun:test'
import { type SDKMessage, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk'
import { ButlerManager, InputQueue } from '../src/cli/butler'
import type { ToolDeps } from '../src/cli/butler-tools'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const userMsg = (t: string): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } }) as SDKUserMessage

/** 假 query:吐一条 system/init,然后排空 prompt 队列(直到 close)。不 spawn cc,让生命周期可单测。 */
const fakeQuery = async function* (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): AsyncGenerator<SDKMessage> {
  yield { type: 'system', subtype: 'init', session_id: 'fake' } as SDKMessage
  for await (const _m of params.prompt) { /* 排空,忽略 */ }
}

const fakeDeps: ToolDeps = { buffers: { list: () => [], read: () => '' }, send: async () => {} }
const newMgr = (onOutput: (sid: string, _o: string, chunk: Uint8Array) => void) =>
  new ButlerManager({ onOutput, onExit: () => {}, deps: fakeDeps, claudeBin: 'claude', query: fakeQuery })

test('InputQueue:按序消费 + close 后迭代器结束', async () => {
  const q = new InputQueue()
  const a = userMsg('a')
  const b = userMsg('b')
  const got: SDKUserMessage[] = []
  const drain = (async () => { for await (const m of q) got.push(m) })()
  q.push(a)
  q.push(b)
  await wait(30)
  q.close()
  await drain
  expect(got).toEqual([a, b])
})

test('start:吐 system/init;同 owner 第二次 start 复用 sid', async () => {
  const outs: Uint8Array[] = []
  const mgr = newMgr((_, __, chunk) => outs.push(chunk))
  const s1 = mgr.start('SKILL', 'phone-A')
  await wait(30) // 让 fakeQuery 吐 init
  expect(outs.some((c) => new TextDecoder().decode(c).includes('"subtype":"init"'))).toBe(true)
  const s2 = mgr.start('SKILL', 'phone-A')
  expect(s2).toBe(s1) // 复用,不二次 spawn
  mgr.stopAll()
})

test('stopAllForPhone:只杀该 owner,他 owner 保留', async () => {
  const mgr = newMgr(() => {})
  mgr.start('S', 'phone-A')
  mgr.start('S', 'phone-B')
  await wait(20)
  expect(mgr.size).toBe(2)
  mgr.stopAllForPhone('phone-A')
  expect(mgr.hasForPhone('phone-A')).toBe(false)
  expect(mgr.hasForPhone('phone-B')).toBe(true)
  mgr.stopAll()
})

test('writeStdin:未知 sid 静默 no-op(不抛)', () => {
  const mgr = newMgr(() => {})
  expect(() => mgr.writeStdin('butler-nope', new TextEncoder().encode('{}'))).not.toThrow()
})
