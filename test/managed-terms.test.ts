import { test, expect } from 'bun:test'
import { ManagedTerms } from '../src/cli/managed-terms'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ManagedTerms:managed 终端集持久化。daemon 重启后 terms map 空,靠它让
// listTerminals 仍标 managed → 手机杀 app 重开能自动恢复会话(「会话清空」根因之一)。

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ce-managed-')), 'managed-terminals.json')
}

test('无文件 → 空集;add 落盘;新实例(模拟 daemon 重启)读回', () => {
  const path = tmpFile()
  const m1 = new ManagedTerms(path)
  expect(m1.has('t-a')).toBe(false)
  m1.add('t-a')
  m1.add('t-b')
  expect(m1.has('t-a')).toBe(true)

  const m2 = new ManagedTerms(path) // daemon 重启 → 新实例从盘上读回
  expect(m2.has('t-a')).toBe(true)
  expect(m2.has('t-b')).toBe(true)
  expect([...m2.values()].sort()).toEqual(['t-a', 't-b'])
  rmSync(dirname(path), { recursive: true, force: true })
})

test('add 已在集合 → 不重复写;remove 不在集合 → no-op', () => {
  const path = tmpFile()
  const m = new ManagedTerms(path)
  m.add('t-a')
  const raw1 = readFileSync(path, 'utf8')
  m.add('t-a') // 已在 → 不再落盘
  const raw2 = readFileSync(path, 'utf8')
  expect(raw2).toBe(raw1)
  m.remove('not-exist') // 不在 → no-op 不抛
  expect(m.has('t-a')).toBe(true)
  rmSync(dirname(path), { recursive: true, force: true })
})

test('remove 摘除并落盘(delete/detach 后不再 managed)', () => {
  const path = tmpFile()
  const m1 = new ManagedTerms(path)
  m1.add('t-a')
  m1.add('t-b')
  m1.remove('t-a') // 用户硬删/软移除 → 摘
  expect(m1.has('t-a')).toBe(false)

  const m2 = new ManagedTerms(path)
  expect(m2.has('t-a')).toBe(false) // 重启后仍摘着(没复活)
  expect(m2.has('t-b')).toBe(true)
  rmSync(dirname(path), { recursive: true, force: true })
})

test('prune:摘掉不在 alive 列表的;全活着不动(防文件无限膨胀)', () => {
  const path = tmpFile()
  const m = new ManagedTerms(path)
  m.add('t-a')
  m.add('t-dead')
  m.prune(['t-a', 't-other']) // Jupyter 现役列表:t-dead 不在 → 摘
  expect(m.has('t-a')).toBe(true)
  expect(m.has('t-dead')).toBe(false)

  const m2 = new ManagedTerms(path) // prune 落了盘
  expect(m2.has('t-dead')).toBe(false)
  rmSync(dirname(path), { recursive: true, force: true })
})

test('损坏 JSON → 空集不抛(半写/手改坏都能起)', () => {
  const path = tmpFile()
  writeFileSync(path, '{not json', 'utf8')
  const m = new ManagedTerms(path)
  expect(m.has('t-a')).toBe(false)
  expect(() => m.add('t-a')).not.toThrow() // save 覆盖坏文件
  expect(readFileSync(path, 'utf8')).toBe('["t-a"]')
  rmSync(dirname(path), { recursive: true, force: true })
})

/** bun/path 的 dirname 简写(本文件多处清理临时目录用)。 */
function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}
