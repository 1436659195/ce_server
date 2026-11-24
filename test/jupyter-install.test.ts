import { test, expect } from 'bun:test'
import { ensureJupyter, promptUnanswerable, type JupyterInstallDeps } from '../src/cli/jupyter-install'

function deps(over: Partial<JupyterInstallDeps>): JupyterInstallDeps {
  return { hasJupyter: async () => true, prompt: async () => true, install: async () => {}, ...over }
}

test('已有 jupyter → ready,不问不装', async () => {
  let asked = false
  const r = await ensureJupyter(
    deps({ hasJupyter: async () => true, prompt: async () => { asked = true; return false } })
  )
  expect(r).toBe('ready')
  expect(asked).toBe(false)
})

test('没 jupyter + 同意 → installed', async () => {
  let installed = false
  const r = await ensureJupyter(
    deps({ hasJupyter: async () => false, prompt: async () => true, install: async () => { installed = true } })
  )
  expect(r).toBe('installed')
  expect(installed).toBe(true)
})

test('没 jupyter + 拒绝 → cancelled,不装', async () => {
  let installed = false
  const r = await ensureJupyter(
    deps({ hasJupyter: async () => false, prompt: async () => false, install: async () => { installed = true } })
  )
  expect(r).toBe('cancelled')
  expect(installed).toBe(false)
})

test('装失败 → failed', async () => {
  const r = await ensureJupyter(
    deps({ hasJupyter: async () => false, prompt: async () => true, install: async () => { throw new Error('网络') } })
  )
  expect(r).toBe('failed')
})

// 2026-11 Kylin 真机事故:daemon 卡在无人能答的安装询问上 22 天,daemon.json 恒 starting:true。
// 防线 1 = promptUnanswerable 判「没人能答」就不弹 prompt;防线 2 = main.ts askYesNo 的 EOF 兜底
// + daemon 模式限时作答(install.sh 不装 jupyterlab,终端前台 ce --daemon 是引导安装路径,不能封死)。
test('promptUnanswerable:stdin 非 TTY(管道/服务拉起/</dev/null/systemd)判「没人能答」', () => {
  expect(promptUnanswerable(undefined)).toBe(true)
  expect(promptUnanswerable(false)).toBe(true)
})

test('promptUnanswerable:交互终端(TTY)可以问 —— 引导安装的真人在场路径', () => {
  expect(promptUnanswerable(true)).toBe(false)
})
