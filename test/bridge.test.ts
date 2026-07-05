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
    async createDir() {},
    async readFileRange() {
      return { data: '', totalSize: 0, bytes: 0, eof: true }
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
    async createDir() {},
    async readFileRange() {
      return { data: '', totalSize: 0, bytes: 0, eof: true }
    },
  }
  const res = await handleRpc(client, { op: 'createTerminal', cwd: '/proj' })
  expect(res).toEqual({ ok: true, data: { name: 'term-7' } })
  expect(got).toBe('/proj')
})

test('createDir 路由且透传 path,响应 ok:true(无 data)', async () => {
  let got = ''
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
    async createDir(path) {
      got = path
    },
    async readFileRange() {
      return { data: '', totalSize: 0, bytes: 0, eof: true }
    },
  }
  const res = await handleRpc(client, { op: 'createDir', path: '/sub/new' })
  expect(res).toEqual({ ok: true })
  expect(got).toBe('/sub/new')
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
    async createDir() {},
    async readFileRange() {
      return { data: '', totalSize: 0, bytes: 0, eof: true }
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
    async createDir() {},
    async readFileRange() {
      return { data: '', totalSize: 0, bytes: 0, eof: true }
    },
  }
  const res = await handleRpc(client, { op: 'listDir', path: '/' })
  expect(res).toEqual({ ok: false, error: 'token 无效' })
})

test('readFileRange 路由且透传 path/offset/length', async () => {
  let gotPath = '',
    gotOffset = -1,
    gotLength = -1
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
    async createDir() {},
    async readFileRange(path, offset, length) {
      gotPath = path
      gotOffset = offset
      gotLength = length
      return { data: 'QUJD', totalSize: 100, bytes: 3, eof: false }
    },
  }
  const res = await handleRpc(client, {
    op: 'readFileRange',
    path: '/a.apk',
    offset: 0,
    length: 524288,
  })
  expect(res).toEqual({
    ok: true,
    data: { data: 'QUJD', totalSize: 100, bytes: 3, eof: false },
  })
  expect(gotPath).toBe('/a.apk')
  expect(gotOffset).toBe(0)
  expect(gotLength).toBe(524288)
})
