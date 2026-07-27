import { spawn } from 'node:child_process'
import { parse as parsePath } from 'node:path'
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
 * 启动一个本地 Jupyter(`python -m jupyterlab --no-browser --port=0`),等它打印 URL+token 后返回。
 * root_dir 设为宿主机根目录(Linux/Mac '/'、Windows 当前盘根):手机文件栏从根浏览整个文件系统,而非 ce 的 cwd。返回 stop() 退出杀进程。
 *
 * ⚠️ 走 `python -m jupyterlab` 而非 `jupyter lab`:Bun `--compile` 出的 Windows 二进制里 `shell:true`
 * spawn 不了 `jupyter.exe`(setuptools 入口包装器),但 spawn `python.exe` 正常(ensurePythonOrExit 已证)。
 * `-m` 直接跑模块、绕开坏掉的 `jupyter` 命令 —— 这是你机上「pip 装好了却探测不到 + 启动超时」的根因修复。
 * ⚠️ 需真实 Jupyter,由 main 烟测覆盖(无单测)。
 */
export async function launchJupyter(
  timeoutMs = 30000
): Promise<{ server: JupyterServer; stop: () => void }> {
  // root_dir = 宿主机根目录:parse(cwd).root → Linux/Mac '/';Windows 当前盘根(如 'C:\')。
  // 让 Jupyter 服务整个文件系统,手机文件栏从根起浏览(而非 ce 启动时的 cwd)。
  const rootDir = parsePath(process.cwd()).root
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'python',
      ['-m', 'jupyterlab', '--no-browser', '--port=0', `--ServerApp.root_dir=${rootDir}`],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true, // Windows 上靠 cmd 的 PATHEXT 解析 python.exe;其它平台无影响
      },
    )
    let buf = ''
    let settled = false
    // 超时/提前退出都把 Jupyter 真实输出尾巴带上 reject —— 不再静默卡 30s 把根因埋掉
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(new Error(`启动 Jupyter 超时(${timeoutMs / 1000}s 内未打印 token)。Jupyter 输出末尾:\n${buf.slice(-1500)}`))
    }, timeoutMs)

    const onChunk = (d: Buffer): void => {
      buf += d.toString()
      const parsed = parseLaunchUrl(buf)
      if (parsed && !settled) {
        settled = true
        clearTimeout(timer)
        proc.stdout?.off('data', onChunk)
        proc.stderr?.off('data', onChunk)
        resolve({
          server: { url: parsed.url, token: parsed.token, root: rootDir },
          stop: () => proc.kill(),
        })
      }
    }
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk) // Jupyter 有时把 URL 打到 stderr
    proc.on('close', (code) => {
      // 成功启动的 Jupyter 不会退出;提前退出 = 崩了 → 立刻把输出抛出,不等 30s
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Jupyter 进程提前退出(码 ${code})。输出:\n${buf.slice(-1500)}`))
    })
    proc.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
  })
}
