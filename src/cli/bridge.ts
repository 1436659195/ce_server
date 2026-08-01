/**
 * 桥:把手机的 RPC 请求映射到本地 Jupyter REST。
 * - handleRpc:纯分派逻辑(可单测,注入 fake JupyterClient)。
 * - makeJupyterClient:真实 REST 实现(localhost Jupyter,main 烟测覆盖)。
 * 终端流(TermStdin ↔ terminado WS)在 main.ts 接,因它带 WS 生命周期、需真实环境验。
 */

import { join } from 'node:path'

/** 本地 Jupyter 的 REST 调用抽象(ce 用 makeJupyterClient 实现;测试用 fake 注入)。 */
export interface JupyterClient {
  createTerminal(cwd: string): Promise<{ name: string }> // POST /api/terminals {cwd}
  listDir(path: string): Promise<unknown> // GET /api/contents/{path}(目录)
  readFile(path: string): Promise<unknown> // GET /api/contents/{path}(文件)
  createDir(path: string): Promise<void> // PUT /api/contents/{path} {type:directory}
  deleteFile(path: string): Promise<void> // DELETE /api/contents/{path}
  renameFile(oldPath: string, newPath: string): Promise<void> // PATCH /api/contents/{old} {path:relNew}(body 不 encode)
  saveFile(path: string, content: string, format: 'text' | 'base64'): Promise<void> // PUT /api/contents/{path} {type:file,format,content}
  readFileRange(
    path: string,
    offset: number,
    length: number
  ): Promise<{
    data: string // 段字节 base64
    totalSize: number // 全文字节(Content-Range;无则 = 段长)
    bytes: number // 本段实际字节数
    eof: boolean // offset+bytes >= totalSize
  }>
  listTerminals(): Promise<RawTerminal[]> // GET /api/terminals
}

/** 手机发来的 RPC 请求(明文 JSON,解密后)。op 为 string 以兜住未知操作。 */
export interface RpcRequest {
  op: string // 'listDir'|'readFile'|'readFileRange'|'createTerminal'|'createDir'|'deleteFile'|'renameFile'|'saveFile'(或未知)
  path?: string
  cwd?: string
  offset?: number
  length?: number
  newPath?: string // renameFile:去前导/的新路径(PATCH body.path,JSON 值不 encode)
  content?: string // saveFile:文本(text)或 base64(base64)
  format?: 'text' | 'base64' // saveFile
  skill?: string // butlerStart:管家 skill 文本(ce 据此 spawn cc 的 --append-system-prompt)
  sid?: string // butlerStart/butlerStop:管家 sid(butlerStop 指定杀哪个 cc)
}

/** ce 回的 RPC 响应(明文 JSON,加密前)。 */
export interface RpcResponse {
  ok: boolean
  data?: unknown
  error?: string
}

/** GET /api/terminals 返回的单条(只取我们关心的字段;字段名沿用 Jupyter 原样) */
export interface RawTerminal {
  name: string
  last_activity?: string
}

/** 列表项(= 手机端 RemoteTerminalInfo 同构;权威契约见 ce-server/src/shared/spec.md)。
 *  ce 端独立定义此类型 —— ce 与手机是两套 tsconfig,不能跨项目 import。 */
export interface RemoteTerminalInfo {
  name: string
  lastActivityAt: number | null
  managed: boolean
  /** 启动目录(jupyter 相对路径,带前导 /);cc agent 由 ce 补返(让手机 restore 不硬编码 /),jupyter 终端无此字段。 */
  cwd?: string
}

/**
 * 把 Jupyter GET /api/terminals 的原始数组转成手机可用的 RemoteTerminalInfo[],
 * 用 managedSet 标注「ce 经手过的」(手机自动恢复只挑这些)。纯函数 → 可单测。
 */
export function toRemoteTerminals(
  all: RawTerminal[],
  managedSet: Set<string>
): RemoteTerminalInfo[] {
  return all.map((t) => ({
    name: t.name,
    lastActivityAt: t.last_activity ? Date.parse(t.last_activity) || null : null,
    managed: managedSet.has(t.name),
  }))
}

/** 把一条 RPC 请求分派到 JupyterClient 对应方法。纯逻辑,异常 → ok:false。 */
export async function handleRpc(client: JupyterClient, req: RpcRequest): Promise<RpcResponse> {
  try {
    switch (req.op) {
      case 'listDir':
        return { ok: true, data: await client.listDir(req.path ?? '/') }
      case 'readFile': {
        // 护栏:content 超 2MB 不带回 —— 否则 JSON.stringify(中文 \uXXXX 转义放大 ~6 倍)+ encode + 加密
        // 三个大 buffer 同存,会撑爆 ce 进程 OOM(曾崩于此)。手机端据 size/tooLarge 显「文件过大」,
        // 跟客户端 MAX_FILE_BYTES 语义一致。下载仍走 readFileRange 分段,不受影响。
        const MAX_READFILE_BYTES = 2 * 1024 * 1024
        const data = (await client.readFile(req.path ?? '/')) as {
          content?: string
          size?: number
          format?: string
          mimetype?: string
          type?: string
        }
        const size = typeof data.size === 'number' ? data.size : (data.content?.length ?? 0)
        if (size > MAX_READFILE_BYTES) {
          return { ok: true, data: { ...data, content: '', tooLarge: true, size } }
        }
        return { ok: true, data }
      }
      case 'createTerminal':
        return { ok: true, data: await client.createTerminal(req.cwd ?? '/') }
      case 'createDir':
        await client.createDir(req.path ?? '/')
        return { ok: true }
      case 'deleteFile':
        await client.deleteFile(req.path ?? '/')
        return { ok: true }
      case 'renameFile':
        await client.renameFile(req.path ?? '/', req.newPath ?? '/')
        return { ok: true }
      case 'saveFile':
        await client.saveFile(req.path ?? '/', req.content ?? '', req.format ?? 'text')
        return { ok: true }
      case 'readFileRange':
        return {
          ok: true,
          data: await client.readFileRange(req.path ?? '/', req.offset ?? 0, req.length ?? 0),
        }
      default:
        return { ok: false, error: `未知操作: ${req.op}` }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 路径编码(同 useFiles.encodePath):去前导斜杠、逐段 encodeURIComponent;根 → '' */
function encodePath(path: string): string {
  const stripped = path.replace(/^\/+/, '')
  return stripped ? stripped.split('/').map(encodeURIComponent).join('/') : ''
}

/** fetch + 超时:Jupyter 卡死(wedged)时请求不会永久挂——15s 超时抛错,handleRpc 捕获返回 ok:false。 */
async function fetchTimeout(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error('Jupyter 响应超时(可能卡死)')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 真实 JupyterClient:用 fetchTimeout 打本地 Jupyter 的 Contents / terminals REST(带超时)。 */
export function makeJupyterClient(baseUrl: string, token: string, root: string): JupyterClient {
  const headers = { Authorization: `Token ${token}` }
  return {
    async createTerminal(cwd) {
      // cwd 是相对 jupyter root_dir 的逻辑路径(带前导 /,'/' = root_dir 本身;见 spec.md)。
      // Jupyter Server 2.x 终端 API 只收【绝对路径】(相对/空 → HTTP 500 "Unhandled error"),
      // 故拼成绝对(root + rel)再发。修前直发相对路径,2.x 必 500(创建终端失败:500)。
      const rel = cwd.replace(/^\/+/, '')
      const abs = join(root, rel || '.')
      const res = await fetchTimeout(`${baseUrl}/api/terminals`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: abs }),
      })
      if (!res.ok) throw new Error(`创建终端失败:${res.status} ${res.statusText}`)
      return (await res.json()) as { name: string }
    },
    async listDir(path) {
      const res = await fetchTimeout(`${baseUrl}/api/contents/${encodePath(path)}`, { headers })
      if (!res.ok) throw new Error(`列目录失败:${res.status} ${res.statusText}`)
      return res.json()
    },
    async readFile(path) {
      const res = await fetchTimeout(`${baseUrl}/api/contents/${encodePath(path)}`, { headers })
      if (!res.ok) throw new Error(`读文件失败:${res.status} ${res.statusText}`)
      return res.json()
    },
    async createDir(path) {
      // PUT 一步建命名目录(同 useFiles.createDir:POST 会建 untitled、PATCH 又被 CORS 挡)
      const res = await fetchTimeout(`${baseUrl}/api/contents/${encodePath(path)}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'directory' }),
      })
      if (!res.ok) throw new Error(`创建文件夹失败:${res.status} ${res.statusText}`)
    },
    async deleteFile(path) {
      const res = await fetchTimeout(`${baseUrl}/api/contents/${encodePath(path)}`, {
        method: 'DELETE',
        headers,
      })
      if (!res.ok) throw new Error(`删除失败:${res.status} ${res.statusText}`)
    },
    async renameFile(oldPath, newPath) {
      // PATCH body.path 是相对 root_dir 的逻辑路径(去前导/),JSON 值不 URL-encode(区别于 URL 段的 encodePath)
      const rel = newPath.replace(/^\/+/, '')
      const res = await fetchTimeout(`${baseUrl}/api/contents/${encodePath(oldPath)}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: rel }),
      })
      if (!res.ok) throw new Error(`重命名失败:${res.status} ${res.statusText}`)
    },
    async saveFile(path, content, format) {
      // PUT 整文件覆盖(无分段语义):新建空文件/编辑保存/上传(base64)共用
      const res = await fetchTimeout(`${baseUrl}/api/contents/${encodePath(path)}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'file', format, content }),
      })
      if (!res.ok) throw new Error(`保存失败:${res.status} ${res.statusText}`)
    },
    async readFileRange(path, offset, length) {
      // Range 拉段;Jupyter(/files/ 走 Tornado 静态)通常返 206+Content-Range。
      // 若服务器忽略 Range → 返 200 全文:totalSize=段长(=全文)、eof=true,phone 一次收完。
      const end = offset + length - 1
      const res = await fetchTimeout(`${baseUrl}/files/${encodePath(path)}`, {
        headers: { ...headers, Range: `bytes=${offset}-${end}` },
      })
      if (!res.ok) throw new Error(`读字节失败:${res.status} ${res.statusText}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const cr = res.headers.get('content-range') || ''
      const m = /\/(\d+)/.exec(cr)
      const totalSize = m ? parseInt(m[1], 10) : buf.length
      const bytes = buf.length
      return { data: buf.toString('base64'), totalSize, bytes, eof: offset + bytes >= totalSize }
    },
    async listTerminals() {
      const res = await fetchTimeout(`${baseUrl}/api/terminals`, { headers })
      if (!res.ok) throw new Error(`列终端失败:${res.status} ${res.statusText}`)
      return (await res.json()) as RawTerminal[]
    },
  }
}
