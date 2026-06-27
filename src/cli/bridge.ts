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
}

/** 手机发来的 RPC 请求(明文 JSON,解密后)。op 为 string 以兜住未知操作。 */
export interface RpcRequest {
  op: string // 'listDir' | 'readFile' | 'createTerminal'(或未知)
  path?: string
  cwd?: string
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

/** 真实 JupyterClient:用 fetch 打本地 Jupyter 的 Contents / terminals REST。 */
export function makeJupyterClient(baseUrl: string, token: string): JupyterClient {
  const headers = { Authorization: `Token ${token}` }
  return {
    async createTerminal(cwd) {
      const rel = cwd.replace(/^\/+/, '') // root_dir 相对;根 → ''
      const res = await fetch(`${baseUrl}/api/terminals`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: rel }),
      })
      if (!res.ok) throw new Error(`创建终端失败:${res.status} ${res.statusText}`)
      return (await res.json()) as { name: string }
    },
    async listDir(path) {
      const res = await fetch(`${baseUrl}/api/contents/${encodePath(path)}`, { headers })
      if (!res.ok) throw new Error(`列目录失败:${res.status} ${res.statusText}`)
      return res.json()
    },
    async readFile(path) {
      const res = await fetch(`${baseUrl}/api/contents/${encodePath(path)}`, { headers })
      if (!res.ok) throw new Error(`读文件失败:${res.status} ${res.statusText}`)
      return res.json()
    },
  }
}
