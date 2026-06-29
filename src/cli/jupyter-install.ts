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
