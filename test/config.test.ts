import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveRelay, resolveRelaySources, OFFICIAL_RELAY } from '../src/cli/config'

test('saveRelay 后 loadConfig 读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-cfg-'))
  const p = join(dir, 'config.json')
  saveRelay('ws://1.2.3.4:8606', p)
  expect(loadConfig(p)).toEqual({ relay: 'ws://1.2.3.4:8606' })
  rmSync(dir, { recursive: true, force: true })
})

test('文件不存在 → 空对象(不抛)', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'ce-cfg-')), 'nope.json')
  expect(loadConfig(p)).toEqual({})
})

test('损坏 JSON → 空对象(不抛)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-cfg-'))
  const p = join(dir, 'config.json')
  writeFileSync(p, '{不是json')
  expect(loadConfig(p)).toEqual({})
  rmSync(dir, { recursive: true, force: true })
})

test('OFFICIAL_RELAY 是非空 ws 地址(占位符,发布前填真实地址)', () => {
  expect(OFFICIAL_RELAY).toMatch(/^wss?:\/\//)
})

test('resolveRelaySources 优先级:--relay flag > config.json > 交互选择 > 官方默认', () => {
  expect(resolveRelaySources({ flag: 'ws://flag', configRelay: 'ws://cfg', choice: 'ws://ch' })).toBe('ws://flag')
  expect(resolveRelaySources({ configRelay: 'ws://cfg', choice: 'ws://ch' })).toBe('ws://cfg')
  expect(resolveRelaySources({ choice: 'ws://ch' })).toBe('ws://ch')
  expect(resolveRelaySources({})).toBe(OFFICIAL_RELAY)
})
