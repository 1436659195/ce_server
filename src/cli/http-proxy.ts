/**
 * httpProxy RPC 处理器 —— 配对手机把 HTTP 请求经隧道转发到被控机的本地 API 服务
 * (套壳 APP 场景,如「凡鲜凡美团购核销」客户端;与 Jupyter/agent 业务无关,独立通道)。
 * 纯逻辑(fetch 注入)可单测,仿 uploads.ts / preflight.ts 惯例;main.ts RPC 分发链接线。
 *
 * 上游白名单:~/.ce/config.json 的 `apiUpstreams: string[]`(默认无 = 功能关闭)。
 * 请求不带目标字段 → 转发清单第一项;预留未来多服务:请求带 `upstream` 字段时与清单精确匹配才放行。
 *
 * 语义红线(与 APP 端的契约,spec.md §5.2,两边都别单方面改):
 *  - HTTP 4xx/5xx 以 ok:true + status 原样传回(业务错误归 APP 展示 detail);
 *    ok:false 只留给传输/配置层错误(未配上游、path/method 非法、上游不可达、超时、body 超限)。
 *  - body 双向 base64(二进制安全);请求/响应各限 8MB。
 *  - 响应头丢弃 content-encoding/content-length/transfer-encoding/connection(fetch 拿到的
 *    arrayBuffer 已解压,长度与原头不符,原样透传会让按头解码的客户端读错)。
 */
import type { RpcResponse } from './bridge'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 60_000

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

/** 手机发来的 httpProxy 请求(明文 JSON,解密后;main.ts 分发时 as 转型)。 */
export interface HttpProxyRequest {
  op: 'httpProxy'
  method?: string
  /** 含 query 的绝对路径(如 /api/campaigns?status=open),不含 host */
  path?: string
  headers?: Record<string, string>
  bodyBase64?: string
}

/** 上游 URL 拼接:剥上游尾斜杠 + path。path 必须 / 开头且非 //(\ 或协议相对会逃到别的 origin)。
 *  非法 → 抛错(调用方包成 ok:false)。纯函数可单测。 */
export function joinUpstreamPath(upstream: string, path: string): string {
  const base = upstream.replace(/\/+$/, '')
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error(`httpProxy: path 非法("${path.slice(0, 80)}"),须为以单个 / 开头的绝对路径`)
  }
  return base + path
}

/** fetch 形状的注入点(不用 typeof fetch —— Bun 的类型带 preconnect 等扩展,普通函数不满足)。 */
export type ProxyFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * 处理一条 httpProxy 请求。upstreams 传 main.ts 启动时的 cfg.apiUpstreams;
 * fetchImpl 注入真实 fetch(测试注入 fake)。永不 throw —— 一切失败都折成 {ok:false,error}。
 */
export async function handleHttpProxy(
  req: HttpProxyRequest,
  upstreams: string[] | undefined,
  fetchImpl: ProxyFetch = fetch as ProxyFetch
): Promise<RpcResponse> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, error: `httpProxy: 不支持的 method "${method}"` }
  }
  if (!upstreams || upstreams.length === 0) {
    return { ok: false, error: '被控机未配置 apiUpstreams(~/.ce/config.json),httpProxy 不可用' }
  }
  let url: string
  try {
    url = joinUpstreamPath(upstreams[0], req.path ?? '/')
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  let body: Uint8Array | undefined
  if (req.bodyBase64) {
    body = new Uint8Array(Buffer.from(req.bodyBase64, 'base64'))
    if (body.length > MAX_BODY_BYTES) {
      return { ok: false, error: `httpProxy: 请求 body 超 8MB 上限(${body.length} 字节)` }
    }
  }
  let res: Response
  try {
    res = await fetchImpl(url, {
      method,
      headers: { ...req.headers },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, error: `httpProxy: 上游请求失败(${(e as Error).message})` }
  }
  let buf: Uint8Array
  try {
    buf = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    return { ok: false, error: `httpProxy: 读上游响应失败(${(e as Error).message})` }
  }
  if (buf.length > MAX_BODY_BYTES) {
    return { ok: false, error: `httpProxy: 响应 body 超 8MB 上限(${buf.length} 字节)` }
  }
  const outHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') {
      return
    }
    outHeaders[lk] = outHeaders[lk] !== undefined ? `${outHeaders[lk]}, ${v}` : v
  })
  return {
    ok: true,
    data: {
      status: res.status,
      headers: outHeaders,
      bodyBase64: Buffer.from(buf).toString('base64'),
    },
  }
}
