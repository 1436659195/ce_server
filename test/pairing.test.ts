import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authorize, loadAuthorized, loadPaired, addAuthorized, removeAuthorized,
  loadPin, savePin,
} from '../src/cli/pairing'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'pair-')), 'auth.json')
const pinTmp = () => join(mkdtempSync(join(tmpdir(), 'pair-')), 'pin.json')

test('authorize: open 模式直放(旧行为兼容)', () => {
  expect(authorize({ mode: 'open', phoneId: 'p1', authorized: new Set(), currentPin: '123456' })).toEqual({ allow: true, pair: false })
})

test('authorize: pin 模式白名单内放行(重连免 PIN)', () => {
  expect(authorize({ mode: 'pin', phoneId: 'p1', authorized: new Set(['p1']), currentPin: '123456' })).toEqual({ allow: true, pair: false })
})

test('authorize: pin 模式新 phone + PIN 对 → 配对入册', () => {
  expect(authorize({ mode: 'pin', phoneId: 'p2', authorized: new Set(), pin: '123456', currentPin: '123456' })).toEqual({ allow: true, pair: true })
})

test('authorize: pin 模式新 phone + PIN 错/缺 → 拒绝 + denyReason(2026-09-21 回手机帧用)', () => {
  const base = { mode: 'pin' as const, phoneId: 'p2', authorized: new Set<string>(), currentPin: '123456' }
  expect(authorize({ ...base, pin: '000000' })).toEqual({ allow: false, pair: false, denyReason: 'pin_mismatch' })
  expect(authorize(base)).toEqual({ allow: false, pair: false, denyReason: 'not_paired' }) // 缺 pin
})

test('loadAuthorized/addAuthorized: round-trip + 幂等 + 持久', () => {
  const p = tmp()
  expect(loadAuthorized(p).size).toBe(0)
  addAuthorized('p1', '', p)
  addAuthorized('p2', '', p)
  addAuthorized('p1', '', p) // 幂等
  expect([...loadAuthorized(p)].sort()).toEqual(['p1', 'p2'])
})

// ─── 2026-09-21 白名单落盘升级 {id,name,pairedAt}[] ──────────────────────────

test('loadPaired: 兼容读旧 string[](name 空、pairedAt 0)', () => {
  const p = tmp()
  writeFileSync(p, JSON.stringify(['p1', 'p2']))
  expect(loadPaired(p)).toEqual([
    { id: 'p1', name: '', pairedAt: 0 },
    { id: 'p2', name: '', pairedAt: 0 },
  ])
})

test('addAuthorized: 新条目记 name+pairedAt;已存在只刷新名字、保留首次配对时间', () => {
  const p = tmp()
  addAuthorized('p1', '我的手机', p)
  const first = loadPaired(p)
  expect(first[0].name).toBe('我的手机')
  expect(first[0].pairedAt).toBeGreaterThan(0)
  addAuthorized('p1', '小米 14', p) // 手机改名 → 传播到落盘
  const second = loadPaired(p)
  expect(second).toHaveLength(1)
  expect(second[0].name).toBe('小米 14')
  expect(second[0].pairedAt).toBe(first[0].pairedAt) // 配对时间不重置
})

test('addAuthorized: 空名字不改已有名字(白名单命中重连的刷新是可选信息)', () => {
  const p = tmp()
  addAuthorized('p1', '我的手机', p)
  addAuthorized('p1', '', p)
  expect(loadPaired(p)[0].name).toBe('我的手机')
})

test('removeAuthorized: 按 id 删,其余保留', () => {
  const p = tmp()
  addAuthorized('p1', 'a', p)
  addAuthorized('p2', 'b', p)
  removeAuthorized('p1', p)
  expect(loadPaired(p).map((x) => x.id)).toEqual(['p2'])
})

test('loadPaired: 损坏/非数组 → 空(不抛)', () => {
  const p = tmp()
  writeFileSync(p, '{bad json')
  expect(loadPaired(p)).toEqual([])
  writeFileSync(p, '"just a string"')
  expect(loadPaired(p)).toEqual([])
})

// ─── PIN 持久化(2026-09-21:此前每次启动随机) ────────────────────────────────

test('loadPin/savePin: round-trip + 非法值不落盘 + 缺文件 null', () => {
  const p = pinTmp()
  expect(loadPin(p)).toBe(null) // 未写过
  savePin('654321', p)
  expect(loadPin(p)).toBe('654321')
  savePin('abc', p) // 非 6 位数字 → 忽略,原值保留
  savePin('12345', p) // 5 位 → 忽略
  expect(loadPin(p)).toBe('654321')
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ pin: '654321' })
})
