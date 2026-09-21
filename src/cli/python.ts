/**
 * 解析本机可用的 Python 解释器 —— 统一入口(治 PROD-PATH-FIXES C1 / 生产红线 C1:5 处裸 'python' 字面量)。
 *
 * 背景:标准 Ubuntu/Debian/Fedora 只有 python3,没有裸 `python`。shell 模式下解释器缺失是
 * 退出码 127(非 spawn ENOENT)—— 曾让 detectServers 空 catch 吞掉恒返 []、launchJupyter 起不来,
 * 而 ensurePythonOrExit 探的是 python3 → 前置检查形同虚设。
 *
 * 规则:--python=<路径> / 环境变量 CE_PYTHON 显式覆盖(信用户,不再实测)> 两层实测:
 * 层1 = 已能跑 jupyterlab(直接可用,最优先 —— 同机多解释器时别挑个空的新版本)、
 * 层2 = 至少 pip 可用(自装路径能走)。★ 为什么不只 --version:同机 python/python3 可能
 * 指向不同版本(实测生产机:python→3.10 全套 jupyter,python3→3.12 系统 pip 缺 distutils
 * 直接炸)—— --version 都通过,选错解释器照样起不来。win32 候选只有 python(Windows 惯例,
 * python3.exe 非标准);其余先 python3 再 python。全失败 → null,由调用方显式处理,
 * 绝不静默回退裸 'python'。resolvePythonBin 进程内缓存(解释器不会中途变,detectServers
 * 一趟启动要调多次;probePythonBin 本身不缓存,测试可反复注入)。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

/** 取 --name=value 参数(与 main.ts 的 arg 同式;独立实现避免 main 循环依赖)。 */
function argOf(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : undefined
}

/** python 解释器覆盖来源:`--python=` 参数 > `CE_PYTHON` 环境变量。显式指定即信任
 *  (同 --claude-bin 惯例)—— 不实测,不存在时由下游 127 报错带可行动提示。 */
function pythonOverride(): string | undefined {
  const a = argOf('python')
  if (a) return a
  const env = process.env.CE_PYTHON
  return env && env.trim() ? env : undefined
}

/** 实测候选解释器(两层:先「能跑 jupyterlab」再「至少有 pip」)。probe 可注入(测试喂假结果)。
 *  返回选中的解释器;全失败 → null(不静默猜)。 */
export async function probePythonBin(
  probe: (cmd: string, args: string[]) => Promise<boolean> = async (cmd, args) => {
    try {
      // shell:true:Windows 上靠 cmd 的 PATHEXT 解析 python.exe(仓内既有约定);
      // 缺解释器时 shell 退出码 127 → pExecFile reject → 该候选探败。
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

let cached: string | null | undefined

/** 解析本机可用的 Python 解释器(probePythonBin 的缓存包装)。返回解释器名/绝对路径;
 *  null = 一个都不可用(调用方必须显式处理)。 */
export async function resolvePythonBin(): Promise<string | null> {
  if (cached === undefined) cached = await probePythonBin()
  return cached
}
