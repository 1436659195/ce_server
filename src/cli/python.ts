/**
 * 解析本机可用的 Python 解释器 —— 统一入口(治 PROD-PATH-FIXES C1:5 处裸 'python' 字面量)。
 *
 * 背景:标准 Ubuntu/Debian/Fedora 只有 python3,没有裸 `python`。shell 模式下解释器缺失是
 * 退出码 127(非 spawn ENOENT)—— 曾让 detectServers 空 catch 吞掉恒返 []、launchJupyter 起不来,
 * 而 ensurePythonOrExit 探的是 python3 → 前置检查形同虚设。
 *
 * 规则:--python=<路径> / 环境变量 CE_PYTHON 显式覆盖(信用户,不再实测)> win32 只试 python
 * > 其余先 python3 再 python(各经 `--version` 实测)。全失败 → null,由调用方显式处理,
 * 绝不静默回退裸 'python'。进程内缓存(解释器不会中途变,detectServers 一趟启动要调多次)。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

/** 取 --name=value 参数(与 main.ts 的 arg 同式;独立实现避免 main 循环依赖)。 */
function argOf(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : undefined
}

let cached: string | null | undefined

/** 解析本机可用的 Python 解释器。返回解释器名/绝对路径;null = 一个都不可用(调用方必须显式处理)。 */
export async function resolvePythonBin(): Promise<string | null> {
  if (cached !== undefined) return cached
  const override = argOf('python') ?? process.env.CE_PYTHON
  if (override && override.trim()) {
    cached = override
    return cached
  }
  // win32 只试 python(标准装法;python3 是 Microsoft Store 的占位 stub);其余先 python3 后 python。
  const candidates = process.platform === 'win32' ? ['python'] : ['python3', 'python']
  for (const c of candidates) {
    try {
      // shell:true:Windows 上靠 cmd 的 PATHEXT 解析 python.exe(仓内既有约定);
      // 缺解释器时 shell 退出码 127 → pExecFile reject → 试下一个。
      await pExecFile(c, ['--version'], { shell: true, windowsHide: true })
      cached = c
      return cached
    } catch {
      /* 此候选不可用,试下一个 */
    }
  }
  cached = null
  return null
}
