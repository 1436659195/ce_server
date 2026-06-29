import { test, expect } from 'bun:test'
import { ensureJupyter, type JupyterInstallDeps } from '../src/cli/jupyter-install'

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
