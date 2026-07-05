/**
 * 桥:把手机的 RPC 请求映射到本地 Jupyter REST。
 * - handleRpc:纯分派逻辑(可单测,注入 fake JupyterClient)。
 * - makeJupyterClient:真实 REST 实现(localhost Jupyter,main 烟测覆盖)。
 * 终端流(TermStdin ↔ terminado WS)在 main.ts 接,因它带 WS 生命周期、需真实环境验。
 */

/** 本地 Jupyter 的 REST 调用抽象(ce 用 makeJupyterClient 实现;测试用 fake 注入)。 */
export interface JupyterClient {
  createTerminal(cwd: string): Promise<{ name: string }> // POST /api/terminals {cwd}
  listDir(path: string): Promise<unknown> // GET /api/contents/{path}(目录)
  readFile(path: string): Promise<unknown> // GET /api/contents/{path}(文件)
  createDir(path: string): Promise<void> // PUT /api/contents/{path} {type:directory}
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
}

/** 手机发来的 RPC 请求(明文 JSON,解密后)。op 为 string 以兜住未知操作。 */
export interface RpcRequest {
  op: string // 'listDir' | 'readFile' | 'readFileRange' | 'createTerminal'(或未知)
  path?: string
  cwd?: string
  offset?: number
  length?: number
}

/** ce 回的 RPC 响应(明文 JSON,加密前)。 */
export interface RpcResponse {
  ok: boolean
  data?: unknown
  error?: string
}

/** 把一条 RPC 请求分派到 JupyterClient 对应方法。纯逻辑,异常 → ok:false。 */
export async function handleRpc(client: JupyterClient, req: RpcRequest): Promise<RpcResponse> {
  try {
    switch (req.op) {
      case 'listDir':
        return { ok: true, data: await client.listDir(req.path ?? '/') }
      case 'readFile':
        return { ok: true, data: await client.readFile(req.path ?? '/') }
      case 'createTerminal':
        return { ok: true, data: await client.createTerminal(req.cwd ?? '/') }
      case 'createDir':
        await client.createDir(req.path ?? '/')
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
export function makeJupyterClient(baseUrl: string, token: string): JupyterClient {
  const headers = { Authorization: `Token ${token}` }
  return {
    async createTerminal(cwd) {
      const rel = cwd.replace(/^\/+/, '') // root_dir 相对;根 → ''
      const res = await fetchTimeout(`${baseUrl}/api/terminals`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: rel }),
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
  }
}
