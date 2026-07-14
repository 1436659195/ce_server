import { test, expect } from 'bun:test'
import { TermBuffers } from '../src/cli/term-buffers'

test('append 带 ANSI → read 返纯文本尾行', () => {
  const b = new TermBuffers(50)
  b.append('t1', Buffer.from('\x1b[31mhello\x1b[0m\nworld\n'))
  expect(b.read('t1', 10)).toBe('hello\nworld')
})

test('超上限:丢头部,留尾部', () => {
  const b = new TermBuffers(3)
  b.append('t1', Buffer.from('hello\nworld\n'))
  b.append('t1', Buffer.from('line3\nline4\n'))
  expect(b.read('t1', 10)).toBe('world\nline3\nline4') // 上限 3 行:hello 被丢
})

test('未知 name → 空串', () => {
  expect(new TermBuffers(10).read('nope', 5)).toBe('')
})

test('list 返所有 name', () => {
  const b = new TermBuffers(10)
  b.append('a', Buffer.from('x'))
  b.append('b', Buffer.from('y'))
  expect(b.list().sort()).toEqual(['a', 'b'])
})

test('跨 chunk 的不完整行正确拼接(无 \n 的片段续接)', () => {
  const b = new TermBuffers(50)
  b.append('t', Buffer.from('abc')) // 无 \n,部分行
  b.append('t', Buffer.from('def\n')) // 拼成 abcdef
  expect(b.read('t', 10)).toBe('abcdef')
})

test('\\r 被去除(终端光标回车不污染行)', () => {
  const b = new TermBuffers(50)
  b.append('t', Buffer.from('pro\rgress\n')) // 进度条式 \r 覆盖
  expect(b.read('t', 10)).toBe('progress')
})
