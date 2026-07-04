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
 *   http://localhost:8888/?token=xxx :: /home/user
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

/** 验活:`jupyter list` 常把已关掉的 server 当在跑报(runtime 文件没清的残留),fetch 一下连得上才算活。
 *  任意 HTTP 响应(含 401)即活;连接被拒/超时 = 死。 */
async function isAlive(url: string, token: string, ms = 3000): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    await fetch(`${url}/api/status`, { headers: { Authorization: `Token ${token}` }, signal: ctrl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 跑 `python -m jupyter_server list` 探测本机在跑的 Jupyter(无则空数组)。
 *  结果逐个 fetch 验活——`jupyter list` 会列出已关掉的残留 runtime 条目,不验活会复用死 URL → fetch "Unable to connect"。 */
export async function detectServers(): Promise<JupyterServer[]> {
  // 走 `python -m ...` 而非 `jupyter ...`:Bun --compile 的 Windows 二进制 spawn 不了 jupyter.exe,
  // 但 spawn python.exe 正常(见 launchJupyter 注释)。优先 `jupyter_server list`,回退老版 `notebook list`
  for (const sub of [['-m', 'jupyter_server', 'list'], ['-m', 'notebook', 'list']]) {
    try {
      // shell:true —— Windows 上靠 cmd 的 PATHEXT 解析 python.exe(其它平台无影响)
      const { stdout } = await pExecFile('python', sub, { shell: true })
      const parsed = parseServerList(stdout)
      const live: JupyterServer[] = []
      for (const s of parsed) {
        if (await isAlive(s.url, s.token)) live.push(s)
      }
      if (live.length > 0) return live
      // 全是 stale(已关掉的残留)→ 当作没探测到,落到上层自起一个
    } catch {
      // 该子命令不存在或失败,试下一个
    }
  }
  return []
}
