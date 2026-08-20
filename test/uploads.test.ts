import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, utimesSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UploadSessions, resolveInRoot } from '../src/cli/uploads'

// 真文件系统测分段上传(tmpdir 隔离;每 case 独立 root,afterEach 清)。
let root = ''
let up: UploadSessions

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ce-uploads-'))
  up = new UploadSessions(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** begin → {uploadId}(失败时 ok:false 直接抛带文案的 Error,方便断言)。 */
async function begin(path: string, totalSize: number): Promise<string> {
  const r = await up.handleRpc({ op: 'uploadBegin', path, totalSize })
  if (!r.ok) throw new Error(r.error)
  return (r.data as { uploadId: string }).uploadId
}

async function chunk(uploadId: string, offset: number, content: string): Promise<void> {
  const r = await up.handleRpc({ op: 'uploadChunk', uploadId, offset, content })
  if (!r.ok) throw new Error(r.error)
}

async function end(uploadId: string): Promise<void> {
  const r = await up.handleRpc({ op: 'uploadEnd', uploadId })
  if (!r.ok) throw new Error(r.error)
}

test('uploadBegin 返回 uploadId 并在目标同目录建 .ce-upload-<id>.part', async () => {
  const id = await begin('/a.bin', 10)
  expect(id).toMatch(/^[0-9a-f]{16}$/)
  expect(readdirSync(root)).toEqual([`.ce-upload-${id}.part`])
})

test('begin + 多段 chunk + end → 目标文件字节与原内容一致(含非 3 倍数末段)', async () => {
  mkdirSync(join(root, 'x'))
  const data = Buffer.from('abcdefg') // 7 字节:两段(4+3,末段非 3 倍数 —— 每段独立 base64/解码,padding 无碍)
  const id = await begin('/x/y.bin', 7)
  await chunk(id, 0, data.subarray(0, 4).toString('base64'))
  await chunk(id, 4, data.subarray(4).toString('base64'))
  await end(id)
  expect(Buffer.from(await Bun.file(join(root, 'x', 'y.bin')).arrayBuffer())).toEqual(data)
  expect(readdirSync(join(root, 'x'))).toEqual(['y.bin']) // 临时文件已 rename 走
})

test('uploadEnd rename 覆盖已存在的同名目标', async () => {
  writeFileSync(join(root, 'old.txt'), '旧内容')
  const id = await begin('/old.txt', 4)
  await chunk(id, 0, Buffer.from('abcd').toString('base64'))
  await end(id)
  expect(Buffer.from(await Bun.file(join(root, 'old.txt')).arrayBuffer()).toString()).toBe('abcd')
})

test('路径 ../ 越界拒绝(../../etc、深层 ../ 均拒)', async () => {
  for (const p of ['/../../etc/x', '/x/../../../y', '/a/../../b']) {
    const r = await up.handleRpc({ op: 'uploadBegin', path: p, totalSize: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('路径越界:超出机器工作区')
  }
})

test('OS 绝对路径注入拒绝(/etc/passwd 不会被当成 root 内路径)', () => {
  // resolve('/root','etc/passwd') —— 前导 / 被剥掉,拼在 root 下,不会逃逸;
  // 真正的逃逸向量是 ../(上一条),这里钉住「绝对路径形态也进不了 root 外」
  const abs = resolveInRoot(root, '/etc/passwd')
  expect(abs.startsWith(root)).toBe(true)
})

test('/x/.. 收敛到 root → 目标是文件夹,拒绝', async () => {
  const r = await up.handleRpc({ op: 'uploadBegin', path: '/x/..', totalSize: 1 })
  expect(r.ok).toBe(false)
  expect(r.error).toBe('目标已是一个文件夹,无法覆盖')
})

test('父目录不存在 → 目标文件夹不存在', async () => {
  const r = await up.handleRpc({ op: 'uploadBegin', path: '/no/such/dir/f.bin', totalSize: 1 })
  expect(r.ok).toBe(false)
  expect(r.error).toBe('目标文件夹不存在,请先创建文件夹再上传')
})

test('目标已是文件夹 → 拒绝', async () => {
  mkdirSync(join(root, 'adir'))
  const r = await up.handleRpc({ op: 'uploadBegin', path: '/adir', totalSize: 1 })
  expect(r.ok).toBe(false)
  expect(r.error).toBe('目标已是一个文件夹,无法覆盖')
})

test('chunk offset 不等于已写长度 → 报错且不追加(乱序/重复段防御)', async () => {
  const id = await begin('/z.bin', 8)
  await chunk(id, 0, Buffer.from('abcd').toString('base64'))
  const r = await up.handleRpc({
    op: 'uploadChunk',
    uploadId: id,
    offset: 0, // 重复旧段(已写到 4)
    content: Buffer.from('xxxx').toString('base64'),
  })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('上传段错位(期望 offset 4,收到 0)')
  // 追加后续正确段仍可完成(offset 校验的是 tmp 实际长度,未被错段污染)
  await chunk(id, 4, Buffer.from('efgh').toString('base64'))
  await end(id)
  expect(Buffer.from(await Bun.file(join(root, 'z.bin')).arrayBuffer()).toString()).toBe('abcdefgh')
})

test('未知 uploadId:chunk/end 报错;abort 幂等返 ok', async () => {
  expect((await up.handleRpc({ op: 'uploadChunk', uploadId: 'deadbeef', offset: 0, content: '' })).ok).toBe(false)
  expect((await up.handleRpc({ op: 'uploadEnd', uploadId: 'deadbeef' })).ok).toBe(false)
  expect((await up.handleRpc({ op: 'uploadAbort', uploadId: 'deadbeef' })).ok).toBe(true)
})

test('end 时字节数 ≠ totalSize → 报错且清临时文件', async () => {
  const id = await begin('/short.bin', 10)
  await chunk(id, 0, Buffer.from('abc').toString('base64')) // 只写 3
  const r = await up.handleRpc({ op: 'uploadEnd', uploadId: id })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('上传不完整(已收 3/10 字节)')
  expect(readdirSync(root)).toEqual([]) // 临时文件已删
})

test('uploadAbort 删临时文件(会话作废)', async () => {
  const id = await begin('/cancel.bin', 100)
  await chunk(id, 0, Buffer.from('ab').toString('base64'))
  expect((await up.handleRpc({ op: 'uploadAbort', uploadId: id })).ok).toBe(true)
  expect(readdirSync(root)).toEqual([])
  // abort 后续传同 id → 会话已没了
  expect((await up.handleRpc({ op: 'uploadChunk', uploadId: id, offset: 2, content: '' })).ok).toBe(false)
})

test('过期清理:2h 前的孤儿 .part 在下次 begin 被删;<1h 的保留', async () => {
  const old = join(root, '.ce-upload-0123456789abcdef.part')
  const fresh = join(root, '.ce-upload-fedcba9876543210.part')
  writeFileSync(old, 'x')
  writeFileSync(fresh, 'y')
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(old, twoHoursAgo, twoHoursAgo)
  // begin 同目录新目标 → 触发该目录 sweep
  const id = await begin('/new.bin', 1)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
  // 命名不合 PART_RE 的用户文件不动
  const userFile = join(root, 'ce-upload-not-hex.part')
  writeFileSync(userFile, 'z')
  utimesSync(userFile, twoHoursAgo, twoHoursAgo)
  const id2 = await begin('/new2.bin', 1)
  expect(existsSync(userFile)).toBe(true)
  void id
  void id2
})
