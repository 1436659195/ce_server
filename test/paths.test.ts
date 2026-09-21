import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse as parsePath } from 'node:path'
import { sameDir, resolveWorkdir } from '../src/cli/paths'

// ---- sameDir:归一化比较(治 Windows 大小写/分隔符/尾斜杠坑)----

test('sameDir:posix 相等/尾斜杠/相对段归一', () => {
  expect(sameDir('/srv/app', '/srv/app')).toBe(true)
  expect(sameDir('/srv/app', '/srv/app/')).toBe(true)
  expect(sameDir('/srv/app', '/srv/app/.')).toBe(true)
  expect(sameDir('/srv/app', '/srv/app/sub')).toBe(false)
  expect(sameDir('/srv/app', '/srv/other')).toBe(false)
})

test('sameDir:win32 大小写不敏感 + 正反斜杠 + 尾斜杠', () => {
  expect(sameDir('C:\\Users\\dev', 'c:/users/dev', 'win32')).toBe(true)
  expect(sameDir('C:\\Work\\Proj', 'C:\\work\\proj\\', 'win32')).toBe(true)
  expect(sameDir('C:\\Work', 'C:\\Work\\Proj', 'win32')).toBe(false)
  expect(sameDir('C:\\Work', 'D:\\Work', 'win32')).toBe(false)
})

test('sameDir:空串/undefined 一律不等(探测缺 root 时不得误判相等)', () => {
  expect(sameDir('', '')).toBe(false)
  expect(sameDir(undefined, '/srv')).toBe(false)
  expect(sameDir('/srv', undefined)).toBe(false)
})

test('sameDir:盘根形态(Windows 自启默认 root)与等价写法一致', () => {
  expect(sameDir('C:\\', 'c:\\', 'win32')).toBe(true)
  expect(sameDir('C:/', 'C:\\', 'win32')).toBe(true)
})

// ---- resolveWorkdir:来源优先级 + 存在性校验 ----

test('resolveWorkdir:都没给 → default = cwd 的宿主机根', () => {
  const r = resolveWorkdir(undefined, undefined, '/srv/app/x')
  expect(r).toEqual({ dir: parsePath('/srv/app/x').root, origin: 'default' })
})

test('resolveWorkdir:CLI 优先于 config;config 空串视为未设', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-wd-'))
  try {
    const r = resolveWorkdir(dir, '/nonexistent-from-config')
    expect(r).toEqual({ dir, origin: 'cli' }) // CLI 有效即赢,不看 config
    const r2 = resolveWorkdir(undefined, '', dir)
    expect(r2).toEqual({ dir: parsePath(dir).root, origin: 'default' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveWorkdir:相对路径相对 cwd resolve;config 来源有效', () => {
  const base = mkdtempSync(join(tmpdir(), 'ce-wd-'))
  try {
    mkdirSync(join(base, 'proj'))
    const r = resolveWorkdir('proj', undefined, base)
    expect(r).toEqual({ dir: join(base, 'proj'), origin: 'cli' })
    const r2 = resolveWorkdir(undefined, 'proj', base)
    expect(r2).toEqual({ dir: join(base, 'proj'), origin: 'config' })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('resolveWorkdir:CLI 无效(不存在/空值)→ invalid + origin cli(调用方 exit(1))', () => {
  expect(resolveWorkdir('/no/such/dir', undefined)).toEqual({ invalid: '/no/such/dir', origin: 'cli' })
  expect(resolveWorkdir('', undefined)).toEqual({ invalid: '', origin: 'cli' }) // --workdir= 敲了没给值
  expect(resolveWorkdir('  ', undefined)).toEqual({ invalid: '  ', origin: 'cli' }) // 纯空白同样拦下
})

test('resolveWorkdir:config 陈旧(目录没了)→ invalid + origin config(调用方告警回退,不变砖)', () => {
  expect(resolveWorkdir(undefined, '/gone/with/the/usb')).toEqual({ invalid: '/gone/with/the/usb', origin: 'config' })
})

test('resolveWorkdir:存在但是文件而非目录 → invalid(上传边界不能架在文件上)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-wd-'))
  try {
    const f = join(dir, 'a-file')
    writeFileSync(f, 'x')
    expect(resolveWorkdir(f, undefined)).toEqual({ invalid: f, origin: 'cli' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
