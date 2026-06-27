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

/** 跑 `jupyter server list` 探测本机在跑的 Jupyter(无则空数组)。 */
export async function detectServers(): Promise<JupyterServer[]> {
  // 优先 `server list`,回退老版 `notebook list`
  for (const sub of [['server', 'list'], ['notebook', 'list']]) {
    try {
      const { stdout } = await pExecFile('jupyter', sub)
      const servers = parseServerList(stdout)
      if (servers.length > 0) return servers
    } catch {
      // 该子命令不存在或失败,试下一个
    }
  }
  return []
}
