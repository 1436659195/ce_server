/**
 * preflight 单测 —— 真环境断言(which/fs/python3 在 CI/开发机都在场):
 * binary/path 用真实命令与文件;pip/script 用确定成败的假命令注入路径无法时退而求结构。
 * versionAtLeast / parseArgs 语义单独直测。
 */
import { describe, expect, test } from 'bun:test'
import { runPreflight, versionAtLeast, type PreflightItem } from '../src/cli/preflight'

describe('versionAtLeast', () => {
  test('按位比较:大于/等于/小于', () => {
    expect(versionAtLeast('3.12.0', '3.10')).toBe(true)
    expect(versionAtLeast('3.10', '3.10')).toBe(true)
    expect(versionAtLeast('3.9.2', '3.10')).toBe(false)
  })
  test('非数字段按 0(pip 的 1.0a1 之类不炸)', () => {
    expect(versionAtLeast('1.0a1', '1.0')).toBe(true) // 1.0.0a? → a 解析 0 → 相等 → true
  })
})

describe('runPreflight 逐项', () => {
  test('binary:存在的命令过(ls/node),不存在的挂', async () => {
    const r = await runPreflight([
      { check: 'binary', name: 'ls' },
      { check: 'binary', name: 'definitely-not-exist-xyz' },
    ])
    expect(r[0].ok).toBe(true)
    expect(r[1].ok).toBe(false)
    expect(r[1].detail).toContain('definitely-not-exist-xyz')
  })

  test('binary:缺 name → 该项失败不炸整批', async () => {
    const r = await runPreflight([{ check: 'binary' }, { check: 'binary', name: 'ls' }])
    expect(r[0].ok).toBe(false)
    expect(r[0].detail).toContain('缺 name')
    expect(r[1].ok).toBe(true)
  })

  test('path:字面路径存在性 + basename 单层 * 通配 + ** 明确拒绝', async () => {
    const r = await runPreflight([
      { check: 'path', glob: '/etc/hosts' }, // 任何 unix 都有
      { check: 'path', glob: '/definitely/not/exist' },
      { check: 'path', glob: '/etc/hos*' }, // /etc 下 hos* → hosts 命中
      { check: 'path', glob: '/etc/**/*.conf' }, // ** 跨层 → 拒绝并引导
    ])
    expect(r[0].ok).toBe(true)
    expect(r[1].ok).toBe(false)
    expect(r[2].ok).toBe(true)
    expect(r[3].ok).toBe(false)
    expect(r[3].detail).toContain('**')
  })

  test('script:exit 0 过;非 0 挂带 stderr;缺 command 挂', async () => {
    const r = await runPreflight([
      { check: 'script', command: 'true' },
      { check: 'script', command: 'sh -c "exit 3"' }, // parseArgs 引号成组 → sh -c exit 3
      { check: 'script' },
    ])
    expect(r[0].ok).toBe(true)
    expect(r[1].ok).toBe(false)
    expect(r[1].detail).toContain('3')
    expect(r[2].ok).toBe(false)
    expect(r[2].detail).toContain('缺 command')
  })

  test('未知档 → 该项失败带原 item(整批不炸)', async () => {
    const r = await runPreflight([{ check: 'npm' } as unknown as PreflightItem])
    expect(r[0].ok).toBe(false)
    expect(r[0].detail).toContain('未知检测档')
    expect(String(r[0].item.check)).toBe('npm')
  })

  test('pip:无 python3 或无包都失败但不抛(python3 在场时包缺失给 人话)', async () => {
    const r = await runPreflight([{ check: 'pip', pkg: 'definitely-not-a-pkg-xyz' }])
    expect(r[0].ok).toBe(false)
    expect(r[0].detail).toContain('definitely-not-a-pkg-xyz')
  })
})
