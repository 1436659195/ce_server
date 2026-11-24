/** 模型只有这些项目工具；每次调用由 daemon 复核发送者、策略和确认。 */
import { randomBytes } from 'node:crypto'
import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { runProjectCommand } from './bot-command-sandbox'
import type { BotPermissions, BotOperation, BotToolContext } from './bot-permissions'

type Authorization = { directory: string; permissions: BotPermissions; revision: number }
interface Options {
  endpoint: () => string
  authorize(context: BotToolContext, operation: BotOperation, summary: string): Promise<Authorization>
}
interface Grant { context: BotToolContext; expiresAt: number; abort: AbortController; authorize?: Options['authorize'] }
const MAX_CONTENT = 200000
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } })
const path = { type: 'string', description: '项目工作范围内的相对路径；不能使用绝对路径或 ..' }
const content = { type: 'string', description: '文件完整的新文本（最多 200000 字符）' }
export const BOT_EXPORT_TOOL = definition('export_file', '把项目中的实际文件或图片制作成聊天交付附件，最多 10 MiB。读取受 owner 权限控制。', { path }, ['path'])
export const BOT_TOOLS = [
  definition('list_files', '列出项目内目录。文件操作均由创建者设定的权限控制。', { path }),
  definition('read_file', '读取项目内文本文件。', { path }, ['path']),
  definition('create_file', '创建新文件，不能覆盖已有文件；可创建所需子目录。', { path, content }, ['path', 'content']),
  definition('edit_file', '修改已有文件，不会创建不存在的文件。', { path, content }, ['path', 'content']),
  definition('delete_file', '删除单个普通文件，不支持递归删除目录。', { path }, ['path']),
  definition('run_command', '在项目范围内执行开发命令。创建者可能需要先确认。文件系统受 OS 沙箱限制，禁止联网及连接本机服务，最长 60 秒。', { command: { type: 'string' } }, ['command']),
]
const operations: Record<string, BotOperation> = { list_files: 'read', read_file: 'read', export_file: 'read', create_file: 'create', edit_file: 'edit', delete_file: 'delete', run_command: 'execute' }

export class BotToolService {
  private grants = new Map<string, Grant>()
  constructor(private readonly options: Options) {}

  open(context: BotToolContext, authorize?: Options['authorize']): { connection: { endpoint: string; token: string }; close(): void } {
    const token = randomBytes(32).toString('base64url')
    const grant = { context, expiresAt: Date.now() + 330000, abort: new AbortController(), authorize }
    this.grants.set(token, grant)
    return { connection: { endpoint: this.options.endpoint(), token }, close: () => this.close(token) }
  }

  private close(token: string): void {
    this.grants.get(token)?.abort.abort()
    this.grants.delete(token)
  }

  revoke(name: string): void {
    for (const [token, grant] of this.grants) if (grant.context.name === name) this.close(token)
  }

  private grant(token: string): Grant {
    const grant = this.grants.get(token)
    if (!grant || grant.expiresAt <= Date.now() || grant.abort.signal.aborted) {
      this.close(token)
      throw new Error('BOT 本回合授权已结束，请重新发送消息')
    }
    return grant
  }

  async call(token: string, tool: string, input: Record<string, unknown>): Promise<string> {
    const grant = this.grant(token)
    const operation = operations[tool]
    if (!operation) throw new Error('未知项目工具')
    const target = typeof input.path === 'string' ? input.path : ''
    const command = typeof input.command === 'string' ? input.command : ''
    if (target.length > 1024) throw new Error('文件路径过长')
    if (tool === 'run_command' && (!command.trim() || command.length > 4000)) throw new Error('命令必须为 4000 字符以内的完整命令')
    const writesContent = tool === 'create_file' || tool === 'edit_file'
    if (writesContent && (typeof input.content !== 'string' || input.content.length > MAX_CONTENT)) throw new Error('文件内容必须为 200000 字符以内的文本')
    const description = tool === 'run_command' ? command : `${tool}: ${target || '.'}${writesContent ? `\n完整写入内容：\n${input.content}` : ''}`
    const authorization = await (grant.authorize ?? this.options.authorize)(grant.context, operation, description)
    this.grant(token) // 等待确认期间回合可能已经结束或权限已撤销。
    const root = realpathSync(authorization.directory)
    if (tool === 'run_command') return runProjectCommand({ directory: root, command, signal: grant.abort.signal })
    const anchored = anchoredPath(root, target, tool === 'list_files', tool === 'create_file')
    const full = anchored.path
    try {
    if (tool === 'list_files') {
      const fd = openSync(full, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { return readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300).map(entry => entry.name + (entry.isDirectory() ? '/' : '')).join('\n') || '（空目录）' }
      finally { closeSync(fd) }
    }
    if (tool === 'read_file' || tool === 'export_file') {
      const fd = openSync(full, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = fstatSync(fd)
        const limit = tool === 'export_file' ? 10 * 1024 * 1024 : MAX_CONTENT
        if (!info.isFile() || info.nlink > 1 || info.size > limit) throw new Error(`只支持读取 ${limit} 字节以内的普通文件，不读取硬链接`)
        if (tool === 'export_file') {
          const bytes = readFileSync(fd)
          if (bytes.length > limit) throw new Error('文件读取时超过大小限制')
          return JSON.stringify({ name: basename(target), data: bytes.toString('base64') })
        }
        const text = readFileSync(fd, 'utf8')
        if (text.includes('\0')) throw new Error('不支持读取二进制文件')
        return text
      } finally { closeSync(fd) }
    }
    if (tool === 'delete_file') {
      const info = lstatSync(full)
      if (!info.isFile() || info.nlink > 1) throw new Error('只支持删除单个普通文件，不递归删除目录或操作硬链接')
      unlinkSync(full)
      return `已删除 ${target}`
    }
    if (tool === 'create_file') {
      const fd = openSync(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644)
      try { writeFileSync(fd, input.content as string) } finally { closeSync(fd) }
      return `已创建 ${target}`
    }
    // 打开后先校验文件句柄，再截断；拒绝设备、FIFO、目录和硬链接。
    const fd = openSync(full, constants.O_WRONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).nlink > 1) throw new Error('只支持修改已有普通文件，不操作硬链接')
      this.grant(token)
      ftruncateSync(fd, 0)
      writeFileSync(fd, input.content as string)
    } finally { closeSync(fd) }
    return `已修改 ${target}`
    } finally { anchored.close() }
  }

  async handle(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
      this.grant(token)
      if (Number(request.headers.get('content-length') ?? 0) > 1000000) throw new Error('工具请求过大')
      const raw = await request.text()
      if (raw.length > 1000000) throw new Error('工具请求过大')
      const body = JSON.parse(raw) as { method: string; name?: string; arguments?: Record<string, unknown> }
      if (body.method === 'tools/list') return Response.json({ tools: BOT_TOOLS })
      if (body.method !== 'tools/call' || !body.name) throw new Error('未知工具请求')
      const text = await this.call(token, body.name, body.arguments ?? {})
      return Response.json({ content: [{ type: 'text', text }] })
    } catch (error) {
      return Response.json({ isError: true, content: [{ type: 'text', text: (error as Error).message }] })
    }
  }
}

function anchoredPath(root: string, input: string, allowRoot = false, createParents = false): { path: string; close(): void } {
  if (process.platform !== 'linux') throw new Error('当前系统暂不支持安全的 BOT 项目工具；普通聊天仍可使用')
  const cleaned = input.replace(/\\/g, '/')
  if (cleaned.includes('\0') || cleaned.includes(':') || isAbsolute(cleaned) || cleaned.split('/').includes('..')) throw new Error('路径必须位于项目范围内，不能使用绝对路径或父目录')
  const full = resolve(root, cleaned)
  const rel = relative(root, full)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || (!allowRoot && !rel)) throw new Error('路径超出项目工作范围')
  const parts = rel.split(sep).filter(Boolean)
  const leaf = parts.pop()
  const handles: number[] = []
  const close = () => { for (const fd of handles.reverse()) closeSync(fd) }
  try {
    let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(fd)
    for (const part of parts) {
      const path = `/proc/self/fd/${fd}/${part}`
      if (createParents) {
        try { mkdirSync(path) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      handles.push(fd)
    }
    // 空路径以 "/." 打开已固定的根，不把 proc 的 fd 符号链接当成最终文件。
    return { path: `/proc/self/fd/${fd}/${leaf ?? '.'}`, close }
  } catch (error) {
    close()
    throw error
  }
}

/** MCP stdio 适配器只有随机回合凭据，没有项目路径/权限决定权。 */
export async function runBotToolBridge(endpoint: string, token: string): Promise<void> {
  const url = new URL(endpoint)
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/bot/tool' || url.protocol !== 'http:') throw new Error('BOT 工具只连接本机 daemon')
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const respond = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  for await (const line of lines) {
    if (line.length > 1000000) throw new Error('MCP 请求过大')
    let message: { id?: unknown; method: string; params?: Record<string, unknown> }
    try { message = JSON.parse(line) } catch { continue }
    if (message.id === undefined) continue
    if (message.method === 'initialize') { respond(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ce_bot', version: '1' } }); continue }
    if (message.method === 'ping') { respond(message.id, {}); continue }
    if (!['tools/list', 'tools/call'].includes(message.method)) { respond(message.id, {}); continue }
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method: message.method, ...message.params }) })
      respond(message.id, await response.json())
    } catch { respond(message.id, { isError: true, content: [{ type: 'text', text: 'BOT 工具连接中断，本次操作未完成' }] }) }
  }
}
