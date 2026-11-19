/** 副作用注入:检测/交互/安装都经此,便于单测 mock。真实实现(spawn jupyter/pip、stdin y/n)在 main.ts 注入。 */
export interface JupyterInstallDeps {
  /** 本机是否已有 jupyter(跑 `jupyter --version`)。 */
  hasJupyter: () => Promise<boolean>
  /** 问用户是否同意装;返回 true=同意。 */
  prompt: (msg: string) => Promise<boolean>
  /** 装 jupyterlab(`pip install jupyterlab`);成功 resolve、失败 reject。 */
  install: () => Promise<void>
}

export type EnsureResult = 'ready' | 'installed' | 'cancelled' | 'failed'

/**
 * 判定「没人能答 y/n」的环境:stdin 非 TTY(控制台 spawn 的 daemon、`< /dev/null`、管道、systemd)。
 * 此场景弹 prompt = 永久卡死:readline 的 question 回调在 EOF 流上永不来,await 挂死 → daemon.json
 * 恒 starting:true(真实事故:Kylin V10 aarch64,daemon 卡 22 天,之后每次 ce 控制台无限「启动中」)。
 * 调用方(main.ts realJupyterDeps)须按「拒绝安装」处理并给可行动指引,绝不无限等待。
 * 注意 --daemon 不在此判定:终端前台 `ce --daemon` 是 jupyterlab 的引导安装路径(install.sh 不装,
 * 全靠这个询问),此时真人在场能作答;daemon 侧改用限时作答兜底(main.ts askYesNoBounded)。
 * 参数化(不直读 process.*)→ 可单测。
 */
export function promptUnanswerable(isTTY: boolean | undefined): boolean {
  return isTTY !== true
}

/**
 * 确保本机有 jupyter:有 → ready;没 → 问用户 → 同意则装(installed/failed)、拒绝 cancelled。
 * 纯逻辑,副作用经 deps 注入 → 可单测。
 */
export async function ensureJupyter(deps: JupyterInstallDeps): Promise<EnsureResult> {
  if (await deps.hasJupyter()) return 'ready'
  const ok = await deps.prompt('未检测到 Jupyter,是否用 pip 安装 jupyterlab?')
  if (!ok) return 'cancelled'
  try {
    await deps.install()
    return 'installed'
  } catch {
    return 'failed'
  }
}
