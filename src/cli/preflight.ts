/**
 * 插件环境检测(2026-09-24 安装门禁定案)—— plugin.preflight op 的实现。
 *
 * 手机在安装「服务器级插件」前,把 manifest 的结构化 requirements 逐项发来检测;
 * 全过才放行安装(门禁 UI/记录在手机侧 installState,ce 只做无状态检测)。
 *
 * 设计约束:
 * - **只读、无状态**:检测不改被控机任何东西;每项 10s 超时,串行执行(不并发轰炸主机)。
 * - **不新开任意执行面**:script 档 = 工件自带检测命令,与既有 exec op 同语义
 *   (execFile 无 shell,args 链不起别的程序;程序名白名单在手机侧 permissions 层闸,
 *   ce 侧与 exec 一致不做白名单 —— 两道闸不重复设卡)。
 * - 声明式为主(binary/pip/path/port 覆盖 90% 场景);path 通配 v1 只支持 basename 单层 `*`
 *   (** 跨层不支持,明确报错引导用 script 档 —— 诚实拒绝优于静默错判)。
 *
 * 纯逻辑(execFile/fs/net 通过注入,可单测);main.ts 只做分发。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/** 一条检测项(手机侧 manifest Requirement 直传;字段全可选由 check 分档取)。 */
export interface PreflightItem {
  check: 'binary' | 'pip' | 'path' | 'port' | 'script'
  name?: string // binary:命令名
  pkg?: string // pip:包名
  minVersion?: string // pip:最低版本
  glob?: string // path:路径(可含 basename 单层 *)
  host?: string // port:主机
  port?: number // port:端口
  command?: string // script:检测命令(首 token 白名单在手机侧闸)
}

/** 单项检测结果(item 原样带回,手机侧按原 item 拼人话)。 */
export interface PreflightItemResult {
  item: PreflightItem
  ok: boolean
  detail: string
}

const ITEM_TIMEOUT_MS = 10_000

/** execFile 包装:统一超时/ENOENT→127/输出截断(与 main.ts exec op 同口径,但 maxBuffer 更小)。 */
function run(
  cmd: string,
  args: string[],
  timeout = ITEM_TIMEOUT_MS
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1 << 16 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException
        const exitCode = e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1
        resolve({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? e.message) })
      } else {
        resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) })
      }
    })
  })
}

/** 命令行解析(与 main.ts exec op 同款:引号成组,无 shell 语义)。 */
function parseArgs(s: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** 版本比较:actual >= min(按 . 拆数字逐位比;非数字段按 0)。 */
export function versionAtLeast(actual: string, min: string): boolean {
  const nums = (s: string): number[] =>
    s
      .trim()
      .split(/[.+-]/)
      .map((x) => parseInt(x, 10))
      .map((x) => (Number.isNaN(x) ? 0 : x))
  const a = nums(actual)
  const b = nums(min)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

async function checkBinary(name: string | undefined): Promise<{ ok: boolean; detail: string }> {
  if (!name) return { ok: false, detail: 'binary 档缺 name' }
  // which/where 探测比跑 `cmd --version` 可靠(有些命令无 --version 或会挂起等 stdin)
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const r = await run(probe, [name])
  if (r.exitCode === 0) return { ok: true, detail: String(r.stdout).trim().split('\n')[0] || name }
  return { ok: false, detail: `被控机未安装命令 ${name}` }
}

async function checkPip(pkg: string | undefined, minVersion: string | undefined): Promise<{ ok: boolean; detail: string }> {
  if (!pkg) return { ok: false, detail: 'pip 档缺 pkg' }
  // python3 -m pip 最便携(裸 pip3 在部分发行版不在 PATH;venv 场景也更准)
  const r = await run('python3', ['-m', 'pip', 'show', pkg])
  if (r.exitCode !== 0) {
    // python3 本身缺失(127)也要说人话
    const hint = r.exitCode === 127 ? '(被控机无 python3)' : ''
    return { ok: false, detail: `未安装 Python 包 ${pkg}${hint}` }
  }
  if (minVersion) {
    const m = /^Version:\s*(.+)$/m.exec(r.stdout)
    const actual = m?.[1]?.trim() ?? ''
    if (actual && !versionAtLeast(actual, minVersion)) {
      return { ok: false, detail: `${pkg} 版本 ${actual} 低于要求的 ${minVersion}` }
    }
  }
  return { ok: true, detail: `${pkg} 已安装` }
}

/** path 档:字面路径 existsSync;basename 含 * 时对父目录 readdir 匹配(** 跨层明确拒绝)。 */
function checkPath(glob: string | undefined): { ok: boolean; detail: string } {
  if (!glob) return { ok: false, detail: 'path 档缺 glob' }
  if (!glob.includes('*')) {
    return fs.existsSync(glob)
      ? { ok: true, detail: '路径存在' }
      : { ok: false, detail: `路径不存在:${glob}` }
  }
  const dir = path.dirname(glob)
  const base = path.basename(glob)
  if (base.includes('**')) {
    return { ok: false, detail: `暂不支持 ** 跨层通配(用单层 * 或 script 档):${glob}` }
  }
  const re = new RegExp(
    '^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'
  )
  try {
    const hit = fs.readdirSync(dir).some((f) => re.test(f))
    return hit ? { ok: true, detail: `${dir} 下有匹配 ${base}` } : { ok: false, detail: `${dir} 下无匹配 ${base}` }
  } catch {
    return { ok: false, detail: `目录不存在或不可读:${dir}` }
  }
}

/** port 档:TCP 连通(3s 超时;只探可达,不发协议数据)。 */
function checkPort(host: string | undefined, port: number | undefined): Promise<{ ok: boolean; detail: string }> {
  if (!host || typeof port !== 'number') return Promise.resolve({ ok: false, detail: 'port 档缺 host/port' })
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (ok: boolean, detail: string): void => {
      s.destroy()
      resolve({ ok, detail })
    }
    s.setTimeout(3000, () => done(false, `连接超时:${host}:${port}`))
    s.on('connect', () => done(true, `${host}:${port} 可达`))
    s.on('error', (e) => done(false, `${host}:${port} 不可达(${(e as Error).message})`))
  })
}

/** script 档:执行工件自带检测命令(execFile 无 shell;exit 0 = 过)。 */
async function checkScript(command: string | undefined): Promise<{ ok: boolean; detail: string }> {
  if (!command) return { ok: false, detail: 'script 档缺 command' }
  const tokens = parseArgs(command)
  if (tokens.length === 0) return { ok: false, detail: 'script 档命令为空' }
  const r = await run(tokens[0], tokens.slice(1))
  if (r.exitCode === 0) return { ok: true, detail: '检测通过' }
  const err = r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`
  return { ok: false, detail: err }
}

/** 逐项检测(串行;单条内部异常不拖垮整批 —— 该项记失败)。 */
export async function runPreflight(items: PreflightItem[]): Promise<PreflightItemResult[]> {
  const out: PreflightItemResult[] = []
  for (const it of items) {
    let r: { ok: boolean; detail: string }
    try {
      switch (it.check) {
        case 'binary':
          r = await checkBinary(it.name)
          break
        case 'pip':
          r = await checkPip(it.pkg, it.minVersion)
          break
        case 'path':
          r = checkPath(it.glob)
          break
        case 'port':
          r = await checkPort(it.host, it.port)
          break
        case 'script':
          r = await checkScript(it.command)
          break
        default:
          r = { ok: false, detail: `未知检测档:${String((it as PreflightItem).check)}` }
      }
    } catch (e) {
      r = { ok: false, detail: `检测异常:${(e as Error).message}` }
    }
    out.push({ item: it, ...r })
  }
  return out
}
