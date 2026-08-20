import { test, expect } from 'bun:test'
import { handleRpc, listTerminalsRetry, toRemoteTerminals, type JupyterClient } from '../src/cli/bridge'

// 用 fake JupyterClient 测 RPC 分派逻辑(不碰真实 Jupyter)。
// noopClient 给全方法空默认:新增 JupyterClient 方法只在此补一处;各 test 用 spread + override 关注的方法。
const noopClient: JupyterClient = {
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
  async deleteFile() {},
  async renameFile() {},
  async saveFile() {},
  async readFileRange() {
    return { data: '', totalSize: 0, bytes: 0, eof: true }
  },
  async listTerminals() {
    return []
  },
}

test('listDir 路由到 client.listDir 且透传 path', async () => {
  let got = ''
  const client: JupyterClient = {
    ...noopClient,
    async listDir(path) {
      got = path
      return { entries: ['a', 'b'] }
    },
  }
  const res = await handleRpc(client, { op: 'listDir', path: '/x' })
  expect(res).toEqual({ ok: true, data: { entries: ['a', 'b'] } })
  expect(got).toBe('/x')
})

test('readFile 小文件(≤2MB)正常回 content', async () => {
  const client: JupyterClient = {
    ...noopClient,
    async readFile() {
      return { type: 'file', content: 'hello', size: 5, format: 'text', mimetype: 'text/plain' }
    },
  }
  const res = await handleRpc(client, { op: 'readFile', path: '/a.txt' })
  expect(res).toEqual({
    ok: true,
    data: { type: 'file', content: 'hello', size: 5, format: 'text', mimetype: 'text/plain' },
  })
})

test('readFile 超 2MB 不带 content、标 tooLarge(防 ce 序列化 OOM)', async () => {
  const client: JupyterClient = {
    ...noopClient,
    async readFile() {
      return { type: 'file', content: 'x'.repeat(3_000_000), size: 3_000_000, format: 'text' }
    },
  }
  const res = await handleRpc(client, { op: 'readFile', path: '/big.txt' })
  expect(res.ok).toBe(true)
  const data = res.data as { tooLarge: boolean; content: string; size: number }
  expect(data.tooLarge).toBe(true)
  expect(data.content).toBe('')
  expect(data.size).toBe(3_000_000)
})

test('createTerminal 路由且透传 cwd', async () => {
  let got = ''
  const client: JupyterClient = {
    ...noopClient,
    async createTerminal(cwd) {
      got = cwd
      return { name: 'term-7' }
    },
  }
  const res = await handleRpc(client, { op: 'createTerminal', cwd: '/proj' })
  expect(res).toEqual({ ok: true, data: { name: 'term-7' } })
  expect(got).toBe('/proj')
})

test('createDir 路由且透传 path,响应 ok:true(无 data)', async () => {
  let got = ''
  const client: JupyterClient = {
    ...noopClient,
    async createDir(path) {
      got = path
    },
  }
  const res = await handleRpc(client, { op: 'createDir', path: '/sub/new' })
  expect(res).toEqual({ ok: true })
  expect(got).toBe('/sub/new')
})

test('deleteFile 路由且透传 path,响应 ok:true(无 data)', async () => {
  let got = ''
  const client: JupyterClient = {
    ...noopClient,
    async deleteFile(path) {
      got = path
    },
  }
  const res = await handleRpc(client, { op: 'deleteFile', path: '/a/b.txt' })
  expect(res).toEqual({ ok: true })
  expect(got).toBe('/a/b.txt')
})

test('renameFile 路由且透传 path/newPath', async () => {
  let gotOld = ''
  let gotNew = ''
  const client: JupyterClient = {
    ...noopClient,
    async renameFile(oldPath, newPath) {
      gotOld = oldPath
      gotNew = newPath
    },
  }
  const res = await handleRpc(client, { op: 'renameFile', path: '/a/b.txt', newPath: 'a/c.txt' })
  expect(res).toEqual({ ok: true })
  expect(gotOld).toBe('/a/b.txt')
  expect(gotNew).toBe('a/c.txt')
})

test('saveFile 路由且透传 path/content/format', async () => {
  let gotPath = ''
  let gotContent = ''
  let gotFormat = ''
  const client: JupyterClient = {
    ...noopClient,
    async saveFile(path, content, format) {
      gotPath = path
      gotContent = content
      gotFormat = format
    },
  }
  const res = await handleRpc(client, {
    op: 'saveFile',
    path: '/a/c.txt',
    content: '你好',
    format: 'text',
  })
  expect(res).toEqual({ ok: true })
  expect(gotPath).toBe('/a/c.txt')
  expect(gotContent).toBe('你好')
  expect(gotFormat).toBe('text')
})

test('未知 op → ok:false', async () => {
  const res = await handleRpc(noopClient, { op: '删除' })
  expect(res.ok).toBe(false)
  expect(res.error).toContain('未知')
})

test('client 抛错 → ok:false + 错误信息(不向上抛)', async () => {
  const client: JupyterClient = {
    ...noopClient,
    async listDir() {
      throw new Error('token 无效')
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
    ...noopClient,
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

test('toRemoteTerminals 解析 last_activity + managed 标记', () => {
  const all = [
    { name: '1', last_activity: '2026-07-05T10:00:00Z' },
    { name: '2', last_activity: '2026-07-05T09:00:00Z' },
    { name: '3' },
  ]
  const out = toRemoteTerminals(all, new Set(['1']))
  expect(out).toEqual([
    { name: '1', lastActivityAt: Date.parse('2026-07-05T10:00:00Z'), managed: true },
    { name: '2', lastActivityAt: Date.parse('2026-07-05T09:00:00Z'), managed: false },
    { name: '3', lastActivityAt: null, managed: false },
  ])
})

test('toRemoteTerminals 空数组 → 空数组', () => {
  expect(toRemoteTerminals([], new Set())).toEqual([])
})

// ── listTerminalsRetry:首错 300ms×1 重试(治配对瞬间 Jupyter 瞬态 404;Mac 侧实测同进程 ──
//    下一秒即恢复) ────────────────────────────────────────────────────────────────────────
const noSleep = async (): Promise<void> => {} // 注入空 sleep,测试不等 300ms

test('listTerminalsRetry:首抛次成 → 返回数据(重试兜住瞬态)', async () => {
  let n = 0
  const client: JupyterClient = {
    ...noopClient,
    async listTerminals() {
      if (++n === 1) throw new Error('列终端失败:404 Not Found')
      return [{ name: 't1' }, { name: 't2' }]
    },
  }
  const res = await listTerminalsRetry(client, { sleep: noSleep })
  expect(res).toEqual([{ name: 't1' }, { name: 't2' }])
  expect(n).toBe(2)
})

test('listTerminalsRetry:两次都抛 → 抛最后错误(降级留给调用点)', async () => {
  const client: JupyterClient = {
    ...noopClient,
    async listTerminals() {
      throw new Error('列终端失败:404 Not Found')
    },
  }
  await expect(listTerminalsRetry(client, { sleep: noSleep })).rejects.toThrow('列终端失败:404')
})

test('listTerminalsRetry:首次成功不重试', async () => {
  let n = 0
  const client: JupyterClient = {
    ...noopClient,
    async listTerminals() {
      n++
      return [{ name: 'ok' }]
    },
  }
  const res = await listTerminalsRetry(client, { sleep: noSleep })
  expect(res).toEqual([{ name: 'ok' }])
  expect(n).toBe(1)
})

test('listTerminalsRetry:重试间隔确实传给 sleep(默认 300ms)', async () => {
  const got: number[] = []
  const sleep = async (ms: number): Promise<void> => {
    got.push(ms)
  }
  const client: JupyterClient = {
    ...noopClient,
    async listTerminals() {
      throw new Error('x')
    },
  }
  await listTerminalsRetry(client, { sleep }).catch(() => {})
  expect(got).toEqual([300])
})

test('未知 op(uploadBegin)→ 「未知操作」(旧 ce 对分段上传的降级文案,手机端据此提示更新)', async () => {
  // 新 op 由 main.ts 拦截到 uploads.ts,不进 handleRpc —— 但旧版 ce 二进制没有那段拦截,
  // 会落到这里。钉住文案形状:手机端 FilesStore.upload 靠 includes('未知操作') 识别。
  const res = await handleRpc(noopClient, { op: 'uploadBegin', path: '/a.bin', totalSize: 3 })
  expect(res).toEqual({ ok: false, error: '未知操作: uploadBegin' })
})
