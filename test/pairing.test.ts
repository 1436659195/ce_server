import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorize, loadAuthorized, addAuthorized } from '../src/cli/pairing'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'pair-')), 'auth.json')

test('authorize: open 模式直放(旧行为兼容)', () => {
  expect(authorize({ mode: 'open', phoneId: 'p1', authorized: new Set(), currentPin: '123456' })).toEqual({ allow: true, pair: false })
})

test('authorize: pin 模式白名单内放行(重连免 PIN)', () => {
  expect(authorize({ mode: 'pin', phoneId: 'p1', authorized: new Set(['p1']), currentPin: '123456' })).toEqual({ allow: true, pair: false })
})

test('authorize: pin 模式新 phone + PIN 对 → 配对入册', () => {
  expect(authorize({ mode: 'pin', phoneId: 'p2', authorized: new Set(), pin: '123456', currentPin: '123456' })).toEqual({ allow: true, pair: true })
})

test('authorize: pin 模式新 phone + PIN 错/缺 → 拒绝', () => {
  const base = { mode: 'pin' as const, phoneId: 'p2', authorized: new Set<string>(), currentPin: '123456' }
  expect(authorize({ ...base, pin: '000000' }).allow).toBe(false)
  expect(authorize(base).allow).toBe(false) // 缺 pin
})

test('loadAuthorized/addAuthorized: round-trip + 幂等 + 持久', () => {
  const p = tmp()
  expect(loadAuthorized(p).size).toBe(0)
  addAuthorized('p1', p)
  addAuthorized('p2', p)
  addAuthorized('p1', p) // 幂等
  expect([...loadAuthorized(p)].sort()).toEqual(['p1', 'p2'])
})
