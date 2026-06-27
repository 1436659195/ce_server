import { test, expect } from 'bun:test'
import { handleRpc, type JupyterClient } from '../src/cli/bridge'

// 用 fake JupyterClient 测 RPC 分派逻辑(不碰真实 Jupyter)。

test('listDir 路由到 client.listDir 且透传 path', async () => {
  let got = ''
  const client: JupyterClient = {
    async listDir(path) {
      got = path
      return { entries: ['a', 'b'] }
    },
    async readFile() {
      return null
    },
    async createTerminal() {
      return { name: 'x' }
    },
  }
  const res = await handleRpc(client, { op: 'listDir', path: '/x' })
  expect(res).toEqual({ ok: true, data: { entries: ['a', 'b'] } })
  expect(got).toBe('/x')
})

test('createTerminal 路由且透传 cwd', async () => {
  let got = ''
  const client: JupyterClient = {
    async listDir() {
      return null
    },
    async readFile() {
      return null
    },
    async createTerminal(cwd) {
      got = cwd
      return { name: 'term-7' }
    },
  }
  const res = await handleRpc(client, { op: 'createTerminal', cwd: '/proj' })
  expect(res).toEqual({ ok: true, data: { name: 'term-7' } })
  expect(got).toBe('/proj')
})

test('未知 op → ok:false', async () => {
  const client: JupyterClient = {
    async listDir() {
      return null
    },
    async readFile() {
      return null
    },
    async createTerminal() {
      return { name: 'x' }
    },
  }
  const res = await handleRpc(client, { op: '删除' })
  expect(res.ok).toBe(false)
  expect(res.error).toContain('未知')
})

test('client 抛错 → ok:false + 错误信息(不向上抛)', async () => {
  const client: JupyterClient = {
    async listDir() {
      throw new Error('token 无效')
    },
    async readFile() {
      return null
    },
    async createTerminal() {
      return { name: 'x' }
    },
  }
  const res = await handleRpc(client, { op: 'listDir', path: '/' })
  expect(res).toEqual({ ok: false, error: 'token 无效' })
})
