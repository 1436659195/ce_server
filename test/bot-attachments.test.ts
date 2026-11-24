import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotAttachmentFiles } from '../src/cli/bot-runtime/attachments'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot } from '../src/cli/bot-runtime/types'

const cleanup: Array<() => void> = []
afterEach(() => { for (const f of cleanup.splice(0)) f() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ce-attachment-'))
  let store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
  let files = new BotAttachmentFiles(root, store)
  const bot = { botId: 'bot-a', groupId: 'dm-a', ownerPhoneId: 'owner' } as RuntimeBot
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, bot, get store() { return store }, get files() { return files }, restart() { store.close(); store = new BotRuntimeStore(join(root, 'runtime.sqlite')); files = new BotAttachmentFiles(root, store) } }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function uploaded(f: ReturnType<typeof fixture>, name = '材料.txt', bytes = Buffer.from('用户提供的材料')) {
  const upload = f.files.begin(f.bot, 'owner', { requestId: crypto.randomUUID(), name, size: bytes.length, mime: 'text/plain' })
  f.files.chunk(f.bot, 'owner', { uploadId: upload.id, offset: 0, data: bytes.toString('base64') })
  return f.files.finish(f.bot, 'owner', { uploadId: upload.id, hash: hash(bytes) })
}

test('分段上传在重启后可续传；重复分段不重复写入，完成后读取原字节', () => {
  const f = fixture(); const bytes = Buffer.from('你好，上传的正文')
  const begin = { requestId: 'request-one', name: '材料.txt', size: bytes.length, mime: 'text/plain' }
  const upload = f.files.begin(f.bot, 'owner', begin)
  expect(f.files.begin(f.bot, 'owner', begin).id).toBe(upload.id)
  const part = { uploadId: upload.id, offset: 0, data: bytes.subarray(0, 6).toString('base64') }
  expect(f.files.chunk(f.bot, 'owner', part).offset).toBe(6)
  expect(f.files.chunk(f.bot, 'owner', part).offset).toBe(6)
  f.restart()
  f.files.chunk(f.bot, 'owner', { uploadId: upload.id, offset: 6, data: bytes.subarray(6).toString('base64') })
  const ref = f.files.finish(f.bot, 'owner', { uploadId: upload.id, hash: hash(bytes) })
  expect(f.files.finish(f.bot, 'owner', { uploadId: upload.id, hash: hash(bytes) })).toEqual(ref)
  expect(f.files.read(f.bot, 'owner', ref, 0, 6)).toMatchObject({ bytes: 6, totalSize: bytes.length, eof: false })
  const first = f.files.read(f.bot, 'owner', ref, 0, 6)
  const rest = f.files.read(f.bot, 'owner', ref, 6, 256 * 1024)
  expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(rest.data, 'base64')])).toEqual(bytes)
})
test('未完成、哈希错误、越界分段及覆盖已完成附件均拒绝', () => {
  const f = fixture(); const bytes = Buffer.from('hello')
  const upload = f.files.begin(f.bot, 'owner', { requestId: 'r', name: 'x.txt', size: 5, mime: 'text/plain' })
  expect(() => f.files.finish(f.bot, 'owner', { uploadId: upload.id, hash: hash(bytes) })).toThrow()
  expect(() => f.files.chunk(f.bot, 'owner', { uploadId: upload.id, offset: 2, data: bytes.toString('base64') })).toThrow()
  f.files.chunk(f.bot, 'owner', { uploadId: upload.id, offset: 0, data: bytes.toString('base64') })
  expect(() => f.files.finish(f.bot, 'owner', { uploadId: upload.id, hash: '0'.repeat(64) })).toThrow()
  const ref = f.files.finish(f.bot, 'owner', { uploadId: upload.id, hash: hash(bytes) })
  expect(() => f.files.chunk(f.bot, 'owner', { uploadId: upload.id, offset: 0, data: Buffer.from('other').toString('base64') })).toThrow()
  expect(f.files.read(f.bot, 'owner', ref, 0, 100).data).toBe(bytes.toString('base64'))
})
test('附件绑定 owner、Bot 和私聊；忽略客户端伪造的名称与文件类型', () => {
  const f = fixture(); const ref = uploaded(f)
  expect(() => f.files.incoming(f.bot, 'stranger', [ref])).toThrow()
  expect(() => f.files.incoming({ ...f.bot, botId: 'bot-b' }, 'owner', [ref])).toThrow()
  expect(() => f.files.incoming({ ...f.bot, groupId: 'other-dm' }, 'owner', [ref])).toThrow()
  expect(() => f.files.read(f.bot, 'stranger', ref, 0, 10)).toThrow()
  expect(f.files.incoming(f.bot, 'owner', [{ ...ref, name: '伪造.png', mime: 'image/png' }])[0]).toEqual(ref)
  expect(() => f.files.incoming(f.bot, 'owner', [{ ...ref, kind: 'artifact' }])).toThrow()
})
test('同名材料不覆盖，安全文件名校验；超过大小或数量上限明确拒绝', () => {
  const f = fixture(); const one = uploaded(f); const two = uploaded(f)
  expect(one.id).not.toBe(two.id)
  expect(f.store.upload(one.id)?.path).not.toBe(f.store.upload(two.id)?.path)
  expect(readFileSync(f.store.upload(one.id)!.path, 'utf8')).toBe('用户提供的材料')
  for (const name of ['../x.txt', '/etc/passwd', 'x\\evil', '\0bad']) expect(() => f.files.begin(f.bot, 'owner', { requestId: name, name, size: 1, mime: 'text/plain' })).toThrow()
  expect(() => f.files.begin(f.bot, 'owner', { requestId: 'big', name: 'big.bin', size: 10 * 1024 * 1024 + 1, mime: 'application/octet-stream' })).toThrow()
  expect(() => f.files.incoming(f.bot, 'owner', [one, two, one, two, one])).toThrow()
})
test('发送后附件不可取消；未发送的可取消，取消后不能继续或读取', () => {
  const f = fixture(); const used = uploaded(f)
  f.files.claim(f.bot, 'owner', [used])
  expect(() => f.files.cancel(f.bot, 'owner', used.id)).toThrow()
  const unused = uploaded(f)
  f.files.cancel(f.bot, 'owner', unused.id)
  expect(() => f.files.read(f.bot, 'owner', unused, 0, 10)).toThrow()
  expect(() => f.files.incoming(f.bot, 'owner', [unused])).toThrow()
})
test('扩展名与声明不能伪造图片；真实 PNG 按字节识别', () => {
  const f = fixture()
  const fake = uploaded(f, 'not-an-image.png', Buffer.from('<script>alert(1)</script>'))
  expect(fake.mime).not.toStartWith('image/')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64')
  const image = uploaded(f, '图片.png', png)
  expect(image.mime).toBe('image/png')
})
