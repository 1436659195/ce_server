import { test, expect } from 'bun:test'
import { tryAcquire } from '../src/cli/ownership'

// tryAcquire:终端占用裁决(先到先得)。纯函数,操作传入的 owner Map → 不依赖 main.ts
// (main.ts 顶层会跑 main(),无法被测试 import)。

test('空 owner + acquire(A) → ok 且 owner 记 A', () => {
  const owner = new Map<string, string>()
  const r = tryAcquire(owner, 't1', 'A')
  expect(r).toEqual({ ok: true })
  expect(owner.get('t1')).toBe('A')
})

test('已被 A 占用,再 acquire(B) 同一终端 → ok:false, occupiedBy:A,owner 不变', () => {
  const owner = new Map<string, string>([['t1', 'A']])
  const r = tryAcquire(owner, 't1', 'B')
  expect(r).toEqual({ ok: false, occupiedBy: 'A' })
  expect(owner.get('t1')).toBe('A')
})

test('A 再 acquire 自己已占的终端 → ok:true(幂等,重连/重复 attach)', () => {
  const owner = new Map<string, string>([['t1', 'A']])
  const r = tryAcquire(owner, 't1', 'A')
  expect(r).toEqual({ ok: true })
  expect(owner.get('t1')).toBe('A')
})

test('acquire(C) 另一空闲终端 → ok:true,不影响 A 的占用', () => {
  const owner = new Map<string, string>([['t1', 'A']])
  const r = tryAcquire(owner, 't2', 'C')
  expect(r).toEqual({ ok: true })
  expect(owner.get('t2')).toBe('C')
  expect(owner.get('t1')).toBe('A')
})
