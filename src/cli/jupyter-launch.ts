import { spawn } from 'node:child_process'
import type { JupyterServer } from './jupyter-detect'

/**
 * 从 Jupyter 启动输出里抓 baseUrl + token。
 * Jupyter 会打印形如 `http://localhost:8888/lab?token=xxx`(可能带 `[I ServerApp]` 前缀、
 * /lab 或 /tree 路径)。baseUrl 取 origin(token 给 REST/WS 用)。
 */
export function parseLaunchUrl(output: string): { url: string; token: string } | null {
  const m = output.match(/https?:\/\/\S*token=\S+/)
  if (!m) return null
  try {
    const u = new URL(m[0])
    const token = u.searchParams.get('token') ?? ''
    return { url: u.origin, token }
  } catch {
    return null
  }
}

/**
 * 启动一个本地 Jupyter(`jupyter lab --no-browser --port=0`),等它打印 URL+token 后返回。
 * root 取启动时的 cwd(Jupyter 默认服务 cwd)。返回 stop() 以退出时杀进程。
 * ⚠️ 需真实 Jupyter,由 main 烟测覆盖(无单测)。
 */
export async function launchJupyter(
  timeoutMs = 30000
): Promise<{ server: JupyterServer; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('jupyter', ['lab', '--no-browser', '--port=0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('启动 Jupyter 超时'))
    }, timeoutMs)

    const onChunk = (d: Buffer): void => {
      buf += d.toString()
      const parsed = parseLaunchUrl(buf)
      if (parsed) {
        clearTimeout(timer)
        proc.stdout?.off('data', onChunk)
        proc.stderr?.off('data', onChunk)
        resolve({
          server: { url: parsed.url, token: parsed.token, root: process.cwd() },
          stop: () => proc.kill(),
        })
      }
    }
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk) // Jupyter 有时把 URL 打到 stderr
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}
