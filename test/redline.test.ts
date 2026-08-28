import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 生产红线锁(2026-08-28 双仓审计):app 与 ce 服务代码不得有任何服务器写死路径。
 * 历史问题(均已修):/root/ 本机用户目录、/AI-project 机器特有项目路径、personal_xm 个人标识、
 * /tmp/ce-butler-cwd 固定绝对路径。此测试防复发:src/ 里再出现机器特有路径字面量 → 红。
 *
 * 注意区分:平台标准路径(/usr/local/bin、/opt/homebrew/bin、os.tmpdir())不算「机器特有」——
 * 它们在任何同平台机器上语义一致,探测候选表里允许出现。
 */

const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\/root\//, why: '本机用户目录 /root/(用 homedir()/os.homedir())' },
  { re: /\/AI-project/i, why: '机器特有项目路径 /AI-project' },
  { re: /personal_xm/i, why: '个人标识 personal_xm' },
  { re: /\/home\/[a-z]/i, why: '具体用户家目录 /home/<user>(用 homedir())' },
  { re: /\/Users\/[A-Za-z]/, why: 'macOS 具体用户目录 /Users/<name>(用 homedir())' },
  { re: /ce-butler-cwd/, why: '固定 butler 工作目录(应 mkdtemp(tmpdir()) 随机建)' },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

test('红线:src/ 无机器特有路径/标识字面量(防复发锁)', () => {
  const violations: string[] = []
  for (const f of walk(join(import.meta.dir, '..', 'src'))) {
    const src = readFileSync(f, 'utf8')
    for (const { re, why } of FORBIDDEN) {
      if (re.test(src)) violations.push(`${f} → ${why}`)
    }
  }
  expect(violations).toEqual([])
})
