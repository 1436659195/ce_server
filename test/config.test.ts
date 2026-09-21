import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveRelay, saveWorkdir } from '../src/cli/config'

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

test('saveWorkdir 合并已有字段(不覆盖 relay),重复写覆盖旧 workdir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-cfg-'))
  const p = join(dir, 'config.json')
  saveRelay('ws://1.2.3.4:8606', p)
  expect(saveWorkdir('/srv/proj', p)).toBe(true)
  expect(loadConfig(p)).toEqual({ relay: 'ws://1.2.3.4:8606', workdir: '/srv/proj' })
  expect(saveWorkdir('/srv/next', p)).toBe(true)
  expect(loadConfig(p)).toEqual({ relay: 'ws://1.2.3.4:8606', workdir: '/srv/next' })
  rmSync(dir, { recursive: true, force: true })
})

test('saveWorkdir 无父目录时创建并成功', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-cfg-'))
  const p = join(dir, 'nested', 'deep', 'config.json')
  expect(saveWorkdir('/srv/proj', p)).toBe(true)
  expect(loadConfig(p)).toEqual({ workdir: '/srv/proj' })
  rmSync(dir, { recursive: true, force: true })
})
