import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { parse as parsePath } from 'node:path'
import type { JupyterServer } from './jupyter-detect'
import { resolvePythonBin } from './python'

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

/** 挑一个空闲端口(listen(0) 让 OS 分配→拿到→关掉)。避开 Jupyter `--port=0` 在某些环境(如本机
 *  Jupyter 2.17)打印成 localhost:0 的毛病:ce 自选端口传给 Jupyter,它打印的 URL 就是对的。 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

/**
 * 启动一个本地 Jupyter(`<python 解释器> -m jupyterlab --no-browser --port=<ce 自选空闲端口>`),等它打印 URL+token 后返回。
 * root_dir 设为宿主机根目录(Linux/Mac '/'、Windows 当前盘根):手机文件栏从根浏览整个文件系统,而非 ce 的 cwd。返回 stop() 退出杀进程。
 *
 * pythonBin 由调用方注入(main 用 resolvePythonBin 统一解析,治「裸 python 在无 python 别名的系统上
 * 退出码 127、daemon exit(1) 起不来」);缺省时自解析,解析不到 → 直接 reject 可行动报错。
 * ⚠️ 走 `<python> -m jupyterlab` 而非 `jupyter lab`:Bun `--compile` 出的 Windows 二进制里 `shell:true`
 * spawn 不了 `jupyter.exe`(setuptools 入口包装器),但 spawn `python.exe` 正常(ensurePythonOrExit 已证)。
 * `-m` 直接跑模块、绕开坏掉的 `jupyter` 命令 —— 这是你机上「pip 装好了却探测不到 + 启动超时」的根因修复。
 * ⚠️ 需真实 Jupyter,由 main 烟测覆盖(无单测)。
 */
export async function launchJupyter(
  rootDir?: string,
  timeoutMs = 30000,
  onLog?: (chunk: Buffer) => void,
  pythonBin?: string,
): Promise<{ server: JupyterServer; stop: () => void }> {
  const bin = pythonBin ?? (await resolvePythonBin())
  if (!bin) {
    throw new Error('未找到 python 解释器(试过 python3/python),无法启动 Jupyter;可用 --python=<路径> 或环境变量 CE_PYTHON 指定')
  }
  // root_dir:传入则用(用户设的工作目录);否则宿主机根(parse(cwd).root → Linux/Mac '/',
  // Windows 当前盘根)——让 Jupyter 服务整个文件系统,手机文件栏从根起浏览。
  // --ServerApp.allow_root=True:root 用户下 Jupyter 默认拒启(要 --allow-root),显式开(非 root 忽略无害)。
  const dir = rootDir ?? parsePath(process.cwd()).root
  const port = await pickFreePort() // ce 自选端口传 Jupyter,避开 --port=0 在某些环境打印 localhost:0
  return new Promise((resolve, reject) => {
    const proc = spawn(
      bin,
      ['-m', 'jupyterlab', '--no-browser', `--port=${port}`, `--ServerApp.root_dir=${dir}`, '--ServerApp.allow_root=True'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true, // Windows 上靠 cmd 的 PATHEXT 解析 python.exe;其它平台无影响
        windowsHide: true, // Windows 下别弹 cmd 控制台窗口(否则用户误关窗口 = 杀掉 Jupyter)
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
        // 拿到 token 后必须继续接走 stdout/stderr:Jupyter 每个请求都打日志,不读会让 pipe buffer(~64KB)
        // 填满 → Jupyter 阻塞在 write → 不响应请求(手机连不上、doctor 探测超时显示「未检测到」)。
        // onLog 由 main 传入写 ~/.ce/ce.log(控制台 [l] 可看 Jupyter 卡死前最后输出);不传则纯 drain 丢弃。
        const drain = (d2: Buffer): void => {
          onLog?.(d2)
        }
        proc.stdout?.on('data', drain)
        proc.stderr?.on('data', drain)
        resolve({
          server: { url: parsed.url, token: parsed.token, root: dir },
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
      // 127 + not found 尾巴 = 解释器缺失(shell:true 下非 ENOENT;生产红线 C1)→ 翻译成可行动报错。
      // 严格 AND:单看退出码或单看文本都会误报(其他错误的输出也可能含 "not found")。
      if (code === 127 && /not found|no such file|is not recognized/i.test(buf)) {
        reject(new Error(`python 解释器不可用:「${bin}」退出码 127(command not found)。可用 --python=<路径> 或环境变量 CE_PYTHON 指定。输出:\n${buf.slice(-1500)}`))
        return
      }
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
