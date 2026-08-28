import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
 *   http://localhost:8888/?token=xxx :: /home/<user>
 *   https://10.0.0.1:9999/?token=yyy :: /data
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

/** python 解释器覆盖来源:`--python=` 参数 > `CE_PYTHON` 环境变量。显式指定即信任
 *  (同 --claude-bin 惯例)——不存在时由下游 127 报错带可行动提示,不在这里拦。 */
function pythonOverride(): string | undefined {
  const a = process.argv.find((x) => x.startsWith('--python='))
  if (a) return a.slice('--python='.length)
  const env = process.env.CE_PYTHON
  return env && env.trim() ? env : undefined
}

/** 实测候选解释器,两层(而非只 --version):层1 = 已能跑 jupyterlab(直接可用,最优先 ——
 *  同机多解释器时别挑个空的新版本);层2 = 至少 pip 可用(自装路径能走)。probe 可注入(测试喂假结果)。
 *  ★ 为什么 --version 不够:同机 python/python3 可能指向不同版本(实测生产机:python→3.10 全套
 *  jupyter,python3→3.12 系统 pip 缺 distutils 直接炸)—— --version 都通过,选错解释器照样起不来。
 *  win32 候选只有 python(Windows 惯例,python3.exe 非标准);其余先 python3(标准发行版
 *  只有它,裸 python 是 Debian family 的 python-is-python3 包才有的软链)再退 python。 */
export async function probePythonBin(
  probe: (cmd: string, args: string[]) => Promise<boolean> = async (cmd, args) => {
    try {
      await pExecFile(cmd, args, { shell: true, windowsHide: true })
      return true
    } catch {
      return false
    }
  },
): Promise<string | null> {
  const ovr = pythonOverride()
  if (ovr) return ovr
  const cands = process.platform === 'win32' ? ['python'] : ['python3', 'python']
  for (const c of cands) if (await probe(c, ['-m', 'jupyterlab', '--version'])) return c
  for (const c of cands) if (await probe(c, ['-m', 'pip', '--version'])) return c
  return null
}

/** probePythonBin 的取值兜底:全失败也回退 'python3'(调用方 detect/launch 只要一个字符串),
 *  但 warn 给出可行动提示,不再纯静默(生产红线 C1:旧版写死 'python',标准发行版 127 被空 catch 吞掉)。 */
export async function resolvePythonBin(): Promise<string> {
  const b = await probePythonBin()
  if (b) return b
  console.warn('[ce] 未找到可用 python 解释器(python3/python 均无法跑 jupyterlab/pip);可用 --python=<路径> 或环境变量 CE_PYTHON 指定')
  return 'python3'
}

/** 跑 `python -m jupyter_server list` 探测本机在跑的 Jupyter(无则空数组)。
 *  结果逐个 fetch 验活——`jupyter list` 会列出已关掉的残留 runtime 条目,不验活会复用死 URL → fetch "Unable to connect"。 */
export async function detectServers(): Promise<JupyterServer[]> {
  const py = await resolvePythonBin()
  // 走 `python -m ...` 而非 `jupyter ...`:Bun --compile 的 Windows 二进制 spawn 不了 jupyter.exe,
  // 但 spawn python.exe 正常(见 launchJupyter 注释)。优先 `jupyter_server list`,回退老版 `notebook list`
  let interpreterMissing = false // 两条子命令都 127(解释器缺失,shell:true 下非 ENOENT)→ 收尾 warn
  for (const sub of [['-m', 'jupyter_server', 'list'], ['-m', 'notebook', 'list']]) {
    try {
      // shell:true —— Windows 上靠 cmd 的 PATHEXT 解析 python.exe(其它平台无影响)
      const { stdout } = await pExecFile(py, sub, { shell: true, windowsHide: true })
      const parsed = parseServerList(stdout)
      const live: JupyterServer[] = []
      for (const s of parsed) {
        if (await isAlive(s.url, s.token)) live.push(s)
      }
      if (live.length > 0) return live
      // 全是 stale(已关掉的残留)→ 当作没探测到,落到上层自起一个
    } catch (e) {
      if ((e as { code?: number | string }).code === 127) interpreterMissing = true
      // 该子命令不存在或失败,试下一个
    }
  }
  if (interpreterMissing) {
    console.warn(`[ce] python 解释器不可用(${py} 退出 127),探测不到 Jupyter;可用 --python=<路径> 或环境变量 CE_PYTHON 指定`)
  }
  return []
}

/** baseUrl 里 `localhost` → `127.0.0.1`:Bun 偶把 localhost 解析成 IPv6 `::1`,而 Jupyter 默认只听
 *  IPv4 loopback → fetch 报 "Unable to connect"。127.0.0.1 无歧义、Jupyter 一定在听(它打的 URL 含 127.0.0.1)。
 *  Mac 双栈监听下 v4/v6 在扩展路由上有瞬时差异(配对瞬间 404 竞态入口),统一 v4 消灭歧义。 */
export function toLoopback(url: string): string {
  return url.replace(/:\/\/localhost\b/, '://127.0.0.1')
}
