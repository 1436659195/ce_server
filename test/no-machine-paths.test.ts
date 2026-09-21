import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * 生产红线:src/ 里不得出现「某台机器」的路径字面量(PROD-PATH-FIXES 验收项)。
 * ce 要跑在任意用户的被控机上 —— 混进开发机目录 / root 家目录 / 固定 /tmp 子目录这类字面量,
 * 轻则启动即 127/ENOENT,重则把 agent cwd base 与上传边界指向错误目录。
 * 路径一律走 os.homedir()/os.tmpdir()/参数注入;测试样例路径用 /srv、/mnt 等中性目录。
 * 要加新禁词:改 FORBIDDEN。
 */
const FORBIDDEN: ReadonlyArray<{ literal: string; why: string }> = [
  { literal: '/AI-project', why: '开发机项目根' },
  { literal: 'personal_xm', why: '开发机目录名' },
  { literal: 'coding_everywhere', why: '仓库名/开发机目录' },
  { literal: '/root/', why: 'root 用户家目录(机器假设)' },
  { literal: '/home/', why: '具体用户家目录(机器假设)' },
  { literal: '/Users/', why: 'macOS 用户目录(机器假设)' },
  { literal: '/tmp/ce-', why: '固定 /tmp 子目录(应 os.tmpdir()+mkdtemp)' },
]

const SRC_DIR = join(import.meta.dir, '..', 'src')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

test('src/ 无机器路径字面量(生产红线)', () => {
  const files = tsFiles(SRC_DIR)
  // 扫描本身失灵(目录改名/搬走)必须红,不能静默绿。
  expect(files.length).toBeGreaterThan(0)
  const offenders: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const { literal } of FORBIDDEN) {
      if (text.includes(literal)) offenders.push(`${relative(process.cwd(), f)} 含 "${literal}"`)
    }
  }
  expect(offenders).toEqual([])
})
