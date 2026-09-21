import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolvePythonBin } from './python'

const pExecFile = promisify(execFile)

export interface JupyterServer {
  /** baseUrl:无 trailing slash、无 token query,如 http://localhost:8888 */
  url: string
  token: string
  /** Jupyter root_dir(OS 路径) */
  root: string
}

/**
 * 解析 `jupyter server list`(或老版 `jupyter notebook list`)的文本输出。
 * 输出形如:
 *   Currently running servers:
 *   http://localhost:8888/?token=xxx :: /srv/app
 *   https://10.0.0.1:9999/?token=yyy :: /mnt/disk
 */
export function parseServerList(output: string): JupyterServer[] {
  const servers: JupyterServer[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('Currently running') || line.startsWith('There are no running')) continue

    const sep = line.indexOf(' :: ')
    if (sep === -1) continue
    const left = line.slice(0, sep).trim()
    const root = line.slice(sep + 4).trim()

    let u: URL
    try {
      u = new URL(left)
    } catch {
      continue // 非 URL 行,跳过
    }
    const token = u.searchParams.get('token') ?? ''
    u.searchParams.delete('token')
    u.hash = ''
    const baseUrl = u.toString().replace(/\/$/, '')
    servers.push({ url: baseUrl, token, root })
  }
  return servers
}

/** 验活:仅 200(token 对当前 Jupyter 有效)才算活;401/403(token 不匹配)/连接拒绝/超时 = 死。
 *  原"任意响应即活"会把 token 拿不到/失效的旧 Jupyter 当活返回 → detectServers 返回它 → 复用后 API 全 403。 */
export async function isAlive(url: string, token: string, ms = 3000): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(`${url}/api/status`, { headers: { Authorization: `Token ${token}` }, signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 跑 `<python 解释器> -m jupyter_server list` 探测本机在跑的 Jupyter(无则空数组)。
 *  结果逐个 fetch 验活——`jupyter list` 会列出已关掉的残留 runtime 条目,不验活会复用死 URL → fetch "Unable to connect"。
 *  pythonBin 由调用方注入(main 用 resolvePythonBin 统一解析);缺省时自解析(解释器缺失 → 空数组 + warn,不再静默)。 */
export async function detectServers(pythonBin?: string): Promise<JupyterServer[]> {
  const bin = pythonBin ?? (await resolvePythonBin())
  if (!bin) {
    console.warn('[ce] 未找到 python 解释器(python3/python 两层实测全失败),无法探测本机 Jupyter;可用 --python=<路径> 或环境变量 CE_PYTHON 指定')
    return []
  }
  let interpreterMissing = false // 两条子命令都 127(解释器缺失,shell:true 下非 ENOENT)→ 收尾 warn
  // 走 `<bin> -m ...` 而非 `jupyter ...`:Bun --compile 的 Windows 二进制 spawn 不了 jupyter.exe,
  // 但 spawn python.exe 正常(见 launchJupyter 注释)。优先 `jupyter_server list`,回退老版 `notebook list`
  for (const sub of [['-m', 'jupyter_server', 'list'], ['-m', 'notebook', 'list']]) {
    try {
      // shell:true —— Windows 上靠 cmd 的 PATHEXT 解析 python.exe(其它平台无影响)
      const { stdout } = await pExecFile(bin, sub, { shell: true, windowsHide: true })
      const parsed = parseServerList(stdout)
      const live: JupyterServer[] = []
      for (const s of parsed) {
        if (await isAlive(s.url, s.token)) live.push(s)
      }
      if (live.length > 0) return live
      // 全是 stale(已关掉的残留)→ 当作没探测到,落到上层自起一个
    } catch (e) {
      // 127 = shell 下解释器不存在(command not found)—— 不再纯静默,给可行动提示;
      // 其余失败(如模块未装退出 1)维持旧行为:试下一个子命令。
      if ((e as { code?: number | string }).code === 127) interpreterMissing = true
    }
  }
  if (interpreterMissing) {
    console.warn(`[ce] python 解释器不可用:「${bin}」退出码 127(command not found),探测不到 Jupyter;请检查 --python= / CE_PYTHON 指定的路径`)
  }
  return []
}

/** baseUrl 里 `localhost` → `127.0.0.1`:Bun 偶把 localhost 解析成 IPv6 `::1`,而 Jupyter 默认只听
 *  IPv4 loopback → fetch 报 "Unable to connect"。127.0.0.1 无歧义、Jupyter 一定在听(它打的 URL 含 127.0.0.1)。
 *  Mac 双栈监听下 v4/v6 在扩展路由上有瞬时差异(配对瞬间 404 竞态入口),统一 v4 消灭歧义。 */
export function toLoopback(url: string): string {
  return url.replace(/:\/\/localhost\b/, '://127.0.0.1')
}

/** 解析 osRoot(Jupyter 自启的 root_dir / 复用判定基准):config.root(install.ps1 选盘写入,
 *  Windows 默认 D: 有则 D:、否则 C:)优先,盘还在才用;盘没了(拔盘/换盘符)warn 后回退 cwd 盘根
 *  —— 不删配置,盘回来下次即恢复。install.sh 不写 root → Linux/Mac 恒走 cwd 根('/')。
 *  exists 可注入(单测喂假结果,同 probePythonBin 惯例)。 */
export function resolveOsRoot(
  configured: string | undefined,
  cwdRoot: string,
  exists: (p: string) => boolean = existsSync,
): string {
  if (!configured) return cwdRoot
  if (exists(configured)) return configured
  console.warn(`[ce] 配置的根 ${configured} 不存在(盘被移除/未挂载?),本次回退 ${cwdRoot}`)
  return cwdRoot
}

/** 盘根相等判定:大小写 + 尾部分隔符归一(`D:\` vs `d:`;`/` 归一后两侧皆空串恒等)。
 *  用于 `jupyter server list` 输出的 root 与 config/osRoot 的比较 —— 换盘后旧 root 的活 Jupyter
 *  靠它挡在复用之外,而不是靠裸 `===`(Windows 大小写/尾斜杠不稳)。 */
export function sameRoot(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}
