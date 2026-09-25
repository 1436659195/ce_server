/**
 * Jupyter Kernel 桥(jupyter-ide 插件的 ce 侧半边,2026-09-25)—— kernel 会话管理 + 执行 + 输出推流。
 *
 * 能力面(手机侧契约 write/subscribe 的 kernel 档):
 * - start({notebookPath}):**跨端接管优先** —— 该 notebook 已有 Jupyter session 绑定的活内核
 *   (如电脑浏览器刚跑过)→ 直接接管它(变量状态继承,浏览器与手机同内核、输出双收);
 *   没有 → POST /api/kernels 新建 + POST /api/sessions 绑到该路径(电脑侧打开同一本即接同一个内核)。
 *   Jupyter session 的 path 相对 root_dir(无前导 /),入参的手机路径含前导 / 需剥。
 * - execute():连 /api/kernels/{id}/channels WS 发 execute_request,**每条回包归一成
 *   KernelEvent 经注入的 push 回调推给手机**(复用 AgentEvent 帧:载荷 {kind:'kernel…',kernelId});
 *   RPC 本身立即返回 msgId(输出异步流到,shell execute_reply 到达即该轮完结)
 * - interrupt()/shutdown():REST 控制面
 *
 * 推流语义:输出事件即发即推(不等整轮跑完),手机按 kernelId demux 逐 cell 追加。
 *
 * 协议归一(纯函数,可单测):
 * - buildExecuteRequest(code):Jupyter 消息形状(header/parent_header/content)
 * - normalizeKernelMsg(msg):iopub/shell 各 msg_type → KernelEvent(stream/error/result/image/status);
 *   display_data/execute_result 的 data 优先 image/png > text/plain(富媒体同 notebook 查看器取舍)
 */
import { randomUUID } from 'node:crypto'

/** 推给手机的 kernel 事件(AgentEvent 载荷内层;形状与手机端 shared/nbformat 输出对齐)。 */
export type KernelEvent =
  | { kind: 'kernelOutput'; kernelId: string; msgId: string; output: KernelOutputItem }
  | { kind: 'kernelStatus'; kernelId: string; msgId: string; phase: 'busy' | 'idle' | 'dead' }
  | { kind: 'kernelReply'; kernelId: string; msgId: string; ok: boolean; error?: string }

/** 单条输出(与手机端 NbOutput 归一形状一致,跨端同构省一层翻译)。 */
export type KernelOutputItem =
  | { kind: 'stream'; text: string }
  | { kind: 'error'; ename: string; evalue: string; traceback: string }
  | { kind: 'image'; mime: 'image/png' | 'image/jpeg'; base64: string }
  | { kind: 'text'; text: string }

export interface KernelManagerOpts {
  /** Jupyter base(http://loopback:port) */
  baseUrl: string
  token: string
  /** 内核名(缺省 python3) */
  kernelName?: string
  /** 事件出口(main.ts 注入 broadcastAgentEvent 封装) */
  push: (event: KernelEvent) => void
}

interface KernelConn {
  id: string
  ws: WebSocket | null
  /** 重连前保留的最近 parent msg_id(重连后 resume 用;v1 记录不续跑,新一轮重新执行) */
  lastMsgId: string | null
  /** 本管理器自建的 Jupyter session 绑定(关内核时连带清);接管别人的内核 = 无,不动他人会话 */
  sessionId: string | null
}

export class KernelManager {
  private readonly kernels = new Map<string, KernelConn>()

  constructor(private readonly opts: KernelManagerOpts) {}

  /**
   * 起一个内核 → {kernelId, attached}。失败抛错(main.ts 分发层捕获回 ok:false)。
   * notebookPath 在场:先查 /api/sessions 找该路径的既有绑定 → 活内核**接管**(attached=true,
   * 变量状态从电脑侧继承);没有 → 新建内核 + 建绑定(电脑侧开同一本即接同一内核)。
   */
  async start(opts: { notebookPath?: string } = {}): Promise<{ kernelId: string; attached: boolean }> {
    const rel = opts.notebookPath ? opts.notebookPath.replace(/^\/+/, '') : ''
    if (rel) {
      const sessions = (await this.fetchJson('GET', '/api/sessions')) as unknown
      const hit = Array.isArray(sessions)
        ? (sessions as { path?: string; kernel?: { id?: string } }[]).find(
            (s) => s.path === rel && s.kernel?.id,
          )
        : undefined
      if (hit?.kernel?.id) {
        this.kernels.set(hit.kernel.id, { id: hit.kernel.id, ws: null, lastMsgId: null, sessionId: null })
        return { kernelId: hit.kernel.id, attached: true }
      }
    }
    const res = await this.fetchJson('POST', '/api/kernels', {
      name: this.opts.kernelName ?? 'python3',
    })
    const id = (res as { id?: string }).id
    if (!id) throw new Error('Jupyter 未返回 kernel id')
    this.kernels.set(id, { id, ws: null, lastMsgId: null, sessionId: null })
    if (rel) {
      // 绑定 kernel↔notebook 路径:电脑 JupyterLab 打开同一本 = 接同一个内核(跨端共享状态)。
      // 失败不阻断(内核可用,只是电脑侧无关联显示)。
      try {
        const sess = (await this.fetchJson('POST', '/api/sessions', {
          type: 'notebook',
          name: rel,
          path: rel,
          kernel: { id },
        })) as { id?: string }
        this.kernels.get(id)!.sessionId = sess.id ?? null
      } catch {
        /* 绑定失败静默 */
      }
    }
    return { kernelId: id, attached: false }
  }

  /**
   * 执行一段代码:保证 WS 在场(懒连接)→ 发 execute_request → 立即返回 msgId。
   * 输出/状态/reply 全部走 push 流异步到达。
   */
  async execute(kernelId: string, code: string): Promise<string> {
    const conn = this.kernels.get(kernelId)
    if (!conn) throw new Error(`内核不存在或已关闭:${kernelId}`)
    const msgId = randomUUID()
    const msg = buildExecuteRequest(msgId, code)
    const ws = await this.ensureWs(conn)
    ws.send(JSON.stringify(msg))
    conn.lastMsgId = msgId
    return msgId
  }

  /** 中断当前执行(SIGINT 语义;空闲时无害)。 */
  async interrupt(kernelId: string): Promise<void> {
    if (!this.kernels.has(kernelId)) throw new Error(`内核不存在:${kernelId}`)
    await this.fetchJson('POST', `/api/kernels/${kernelId}/interrupt`, {})
  }

  /** 关内核 + 断 WS(幂等);自建的 session 绑定连带清,接管的他人会话不动。 */
  async shutdown(kernelId: string): Promise<void> {
    const conn = this.kernels.get(kernelId)
    if (!conn) return
    this.kernels.delete(kernelId)
    try {
      conn.ws?.close()
    } catch {
      /* 已断 */
    }
    if (conn.sessionId) {
      try {
        await this.fetchJson('DELETE', `/api/sessions/${conn.sessionId}`)
      } catch {
        /* 会话已被 Jupyter 清(内核死连带)→ 静默 */
      }
    }
    await this.fetchJson('DELETE', `/api/kernels/${kernelId}`)
    this.opts.push({ kind: 'kernelStatus', kernelId, msgId: '', phase: 'dead' })
  }

  /** 全量清场(进程退出路径调,防内核孤儿)。 */
  async shutdownAll(): Promise<void> {
    for (const id of [...this.kernels.keys()]) await this.shutdown(id)
  }

  // ─── 内部:WS 懒连接 + 分发 ─────────────────────────────────────────

  private async ensureWs(conn: KernelConn): Promise<WebSocket> {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) return conn.ws
    const wsBase = this.opts.baseUrl.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsBase}/api/kernels/${conn.id}/channels?token=${encodeURIComponent(this.opts.token)}`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('内核通道连接超时')), 5000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('内核通道连接失败'))
      })
    })
    ws.addEventListener('message', (ev) => this.onMessage(conn, String(ev.data)))
    ws.addEventListener('close', () => {
      if (conn.ws === ws) conn.ws = null
      this.opts.push({ kind: 'kernelStatus', kernelId: conn.id, msgId: '', phase: 'dead' })
    })
    conn.ws = ws
    return ws
  }

  private onMessage(conn: KernelConn, raw: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const parent = (msg as { parent_header?: { msg_id?: string } }).parent_header?.msg_id ?? ''
    const item = normalizeKernelMsg(msg)
    if (!item) return
    if (item.kind === 'status') {
      this.opts.push({ kind: 'kernelStatus', kernelId: conn.id, msgId: parent, phase: item.phase })
    } else if (item.kind === 'reply') {
      this.opts.push({ kind: 'kernelReply', kernelId: conn.id, msgId: parent, ok: item.ok, error: item.error })
    } else {
      this.opts.push({ kind: 'kernelOutput', kernelId: conn.id, msgId: parent, output: item })
    }
  }

  private async fetchJson(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Token ${this.opts.token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) throw new Error(`Jupyter ${method} ${path} → ${res.status} ${res.statusText}`)
    if (res.status === 204) return {}
    return res.json()
  }
}

// ─── 协议纯函数(可单测)──────────────────────────────────────────────────

/** 构造 execute_request(Jupyter 消息协议 5.x 形状)。 */
export function buildExecuteRequest(msgId: string, code: string): {
  header: Record<string, unknown>
  parent_header: Record<string, unknown>
  metadata: Record<string, unknown>
  content: Record<string, unknown>
  channel: string
} {
  return {
    header: {
      msg_id: msgId,
      username: 'ce',
      session: 'ce-kernel-bridge',
      date: new Date().toISOString(),
      msg_type: 'execute_request',
      version: '5.3',
    },
    parent_header: {},
    metadata: {},
    content: { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false },
    channel: 'shell',
  }
}

type RawMsg = {
  header?: { msg_type?: string }
  content?: Record<string, unknown>
}

/** iopub/shell 回包 → 归一事件;无关消息(status:starting 等前置)返回 null。 */
export function normalizeKernelMsg(
  msg: unknown
): KernelOutputItem | { kind: 'status'; phase: 'busy' | 'idle' | 'dead' } | { kind: 'reply'; ok: boolean; error?: string } | null {
  const m = msg as RawMsg
  const type = m?.header?.msg_type
  const c = m?.content ?? {}
  switch (type) {
    case 'stream':
      return { kind: 'stream', text: typeof c.text === 'string' ? c.text : '' }
    case 'error':
      return {
        kind: 'error',
        ename: typeof c.ename === 'string' ? c.ename : 'Error',
        evalue: typeof c.evalue === 'string' ? c.evalue : '',
        traceback: Array.isArray(c.traceback) ? c.traceback.filter((t) => typeof t === 'string').join('\n') : '',
      }
    case 'display_data':
    case 'execute_result': {
      const data = (c.data ?? {}) as Record<string, unknown>
      if (typeof data['image/png'] === 'string') {
        return { kind: 'image', mime: 'image/png', base64: data['image/png'] }
      }
      if (typeof data['image/jpeg'] === 'string') {
        return { kind: 'image', mime: 'image/jpeg', base64: data['image/jpeg'] }
      }
      const plain = data['text/plain']
      if (typeof plain === 'string') return { kind: 'text', text: plain }
      return null // 富媒体 v1 不推(与 notebook 查看器同取舍)
    }
    case 'status': {
      const phase = c.execution_state
      if (phase === 'busy' || phase === 'idle' || phase === 'dead') {
        return { kind: 'status', phase }
      }
      return null
    }
    case 'execute_reply': {
      const ok = c.status === 'ok'
      return {
        kind: 'reply',
        ok,
        ...(ok ? {} : { error: typeof c.ename === 'string' ? `${c.ename}: ${String(c.evalue ?? '')}` : '执行失败' }),
      }
    }
    default:
      return null
  }
}
