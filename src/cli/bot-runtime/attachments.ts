import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { BotRuntimeStore } from './store'
import type { RuntimeArtifact, RuntimeAttachment, RuntimeBot, RuntimeUpload } from './types'

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_CHUNK_BYTES = 256 * 1024
export const ATTACHMENT_MAX_COUNT = 4
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export function attachmentName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 180 || /[/\\\x00-\x1f\x7f]/.test(value) || ['.', '..'].includes(value.trim())) throw new Error('附件文件名无效')
  return value.trim()
}
/** 图片只按文件签名识别；SVG 等主动内容按普通文件下载。 */
export function attachmentMime(name: string, bytes: Buffer): string {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf'
  const textTypes: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.csv': 'text/csv', '.log': 'text/plain', '.ts': 'text/plain', '.js': 'text/plain', '.py': 'text/plain', '.css': 'text/plain' }
  const mime = textTypes[extname(name).toLowerCase()]
  if (mime && !bytes.includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return mime } catch { /* 二进制或其他编码仍可原样下载 */ }
  }
  return 'application/octet-stream'
}
export function artifactReference(a: RuntimeArtifact): RuntimeAttachment {
  return { id: a.id, kind: 'artifact', botId: a.botId, name: a.name ?? a.title, mime: a.mime, size: a.size, hash: a.hash }
}
function uploadReference(upload: RuntimeUpload): RuntimeAttachment {
  if (upload.state !== 'ready' || !upload.hash) throw new Error('附件尚未上传完成或已取消')
  return { id: upload.id, kind: 'upload', botId: upload.botId, name: upload.name, mime: upload.mime, size: upload.size, hash: upload.hash }
}

/** 仅由已认证的 Bot RPC 和宿主工具调用，文件始终留在 CE 本机。 */
export class BotAttachmentFiles {
  constructor(private readonly root: string, private readonly store: BotRuntimeStore) {}
  private owner(bot: RuntimeBot, actor: string): void {
    if (!actor || actor !== bot.ownerPhoneId) throw new Error('只有 owner 可以操作此 Bot 的附件')
  }
  private upload(bot: RuntimeBot, actor: string, id: string): RuntimeUpload {
    this.owner(bot, actor)
    const upload = this.store.upload(id)
    if (!upload || upload.botId !== bot.botId || upload.ownerPhoneId !== actor || upload.groupId !== bot.groupId) throw new Error('附件不存在或无权访问')
    if (upload.state === 'cancelled') throw new Error('附件已取消，请重新选择')
    return upload
  }
  begin(bot: RuntimeBot, actor: string, p: { requestId: string; name: string; size: number; mime: string }): { id: string; offset: number } {
    this.owner(bot, actor)
    const name = attachmentName(p.name)
    if (typeof p.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.requestId)) throw new Error('上传请求 ID 无效')
    if (!Number.isSafeInteger(p.size) || p.size < 0 || p.size > ATTACHMENT_MAX_BYTES) throw new Error('每个附件最多 10 MiB')
    const uploads = this.store.uploads(bot.botId)
    const previous = uploads.find(u => u.requestId === p.requestId && u.ownerPhoneId === actor)
    if (previous) {
      this.upload(bot, actor, previous.id)
      if (previous.name !== name || previous.size !== p.size) throw new Error('上传请求已用于不同文件')
      return { id: previous.id, offset: previous.offset }
    }
    for (const upload of uploads.filter(u => !u.claimed && u.state !== 'cancelled' && u.createdAt < Date.now() - 24 * 3600_000)) this.cancel(bot, actor, upload.id)
    const pending = this.store.uploads(bot.botId).filter(u => !u.claimed && u.state !== 'cancelled')
    if (pending.length >= 16 || pending.reduce((sum, u) => sum + u.size, p.size) > 80 * 1024 * 1024) throw new Error('待发送附件过多，请先发送或移除已有附件')
    const id = `upload_${randomUUID()}`
    const directory = join(this.root, 'bot-uploads', bot.botId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, id)
    writeFileSync(path, Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
    this.store.saveUpload({ id, botId: bot.botId, groupId: bot.groupId, ownerPhoneId: actor, requestId: p.requestId, name, mime: 'application/octet-stream', size: p.size, path, offset: 0, state: 'uploading', createdAt: Date.now() })
    return { id, offset: 0 }
  }
  chunk(bot: RuntimeBot, actor: string, p: { uploadId: string; offset: number; data: string }): { offset: number } {
    const upload = this.upload(bot, actor, p.uploadId)
    if (!Number.isSafeInteger(p.offset) || p.offset < 0 || typeof p.data !== 'string' || p.data.length > Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data)) throw new Error('上传分段格式无效')
    const bytes = Buffer.from(p.data, 'base64')
    if (!bytes.length || p.offset > upload.offset || p.offset + bytes.length > upload.size) throw new Error('上传分段范围无效')
    const current = readFileSync(upload.path)
    // 写入成功而账本更新前进程退出：已有的相同字节可以安全认领，不重写。
    if (p.offset < current.length) {
      if (!current.subarray(p.offset, p.offset + bytes.length).equals(bytes)) throw new Error('上传分段与已接收内容冲突')
      const offset = Math.max(upload.offset, p.offset + bytes.length)
      this.store.saveUpload({ ...upload, offset }); return { offset }
    }
    if (upload.state !== 'uploading' || current.length !== p.offset) throw new Error('上传已完成或分段状态不一致')
    appendFileSync(upload.path, bytes)
    const offset = p.offset + bytes.length
    this.store.saveUpload({ ...upload, offset }); return { offset }
  }
  finish(bot: RuntimeBot, actor: string, p: { uploadId: string; hash: string }): RuntimeAttachment {
    const upload = this.upload(bot, actor, p.uploadId)
    if (upload.offset !== upload.size) throw new Error('附件尚未上传完整')
    const bytes = readFileSync(upload.path)
    if (!/^[a-f0-9]{64}$/.test(p.hash) || bytes.length !== upload.size || sha256(bytes) !== p.hash) throw new Error('附件校验失败，请重试上传')
    const completed: RuntimeUpload = { ...upload, state: 'ready', hash: p.hash, mime: attachmentMime(upload.name, bytes) }
    this.store.saveUpload(completed)
    return uploadReference(completed)
  }
  cancel(bot: RuntimeBot, actor: string, id: string): void {
    const upload = this.upload(bot, actor, id)
    if (upload.claimed) throw new Error('附件已经发送，不能移除原文件')
    this.store.saveUpload({ ...upload, state: 'cancelled' })
    rmSync(upload.path, { force: true })
  }
  incoming(bot: RuntimeBot, actor: string, values: unknown): RuntimeAttachment[] {
    this.owner(bot, actor)
    if (values === undefined) return []
    if (!Array.isArray(values) || values.length > ATTACHMENT_MAX_COUNT) throw new Error('每条消息最多 4 个附件')
    return values.map(value => {
      if (!value || value.kind !== 'upload' || typeof value.id !== 'string') throw new Error('用户消息附件引用无效')
      return uploadReference(this.upload(bot, actor, value.id))
    }).filter((value, index, all) => all.findIndex(other => other.id === value.id) === index)
  }
  claim(bot: RuntimeBot, actor: string, values: unknown): RuntimeAttachment[] {
    const refs = this.incoming(bot, actor, values)
    for (const ref of refs) this.store.saveUpload({ ...this.upload(bot, actor, ref.id), claimed: true })
    return refs
  }
  bytes(bot: RuntimeBot, actor: string, ref: Pick<RuntimeAttachment, 'id' | 'kind'>): { attachment: RuntimeAttachment; bytes: Buffer; path: string } {
    this.owner(bot, actor)
    let path: string; let attachment: RuntimeAttachment
    if (ref.kind === 'upload') {
      const upload = this.upload(bot, actor, ref.id)
      attachment = uploadReference(upload); path = upload.path
    } else if (ref.kind === 'artifact') {
      const artifact = this.store.artifact(ref.id)
      if (!artifact || artifact.botId !== bot.botId) throw new Error('成果不存在或无权访问')
      attachment = artifactReference(artifact); path = artifact.path
    } else throw new Error('附件引用无效')
    const bytes = readFileSync(path)
    if (bytes.length !== attachment.size || sha256(bytes) !== attachment.hash) throw new Error('附件快照已改变，请重新上传或生成')
    return { attachment, bytes, path }
  }
  read(bot: RuntimeBot, actor: string, ref: Pick<RuntimeAttachment, 'id' | 'kind'>, offset: number, length: number): { data: string; bytes: number; totalSize: number; eof: boolean } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 524286) throw new Error('附件读取范围无效')
    const result = this.bytes(bot, actor, ref)
    if (offset > result.bytes.length) throw new Error('读取位置超过附件长度')
    const chunk = result.bytes.subarray(offset, offset + length)
    return { data: chunk.toString('base64'), bytes: chunk.length, totalSize: result.bytes.length, eof: offset + chunk.length >= result.bytes.length }
  }
}
