/**
 * 通用审批派发器 —— blocking approval round-trip 的 ce 侧核心(**非 CC 专属**)。
 *
 * 场景:被控机上某 agent(如终端里跑的 CC)要做一个写操作、需人工放行。ce 收到 blocking hook →
 *   `request()` 发请求事件给手机(onPending)→ 手机人审后回 `resolveApproval` RPC → `resolve()`
 *   解阻塞 → hook 放行/拒绝。
 *
 * 「通用」:dispatcher 不知「CC / PreToolUse / diff」—— 只管 reqId 配对 + 超时 + 取消。agent 专属
 *   知识(hook JSON 格式、事件 schema)住 `cc-hooks.ts` + 手机插件,不进这里。中继零信任不变:
 *   审批请求/响应仍是加密帧内 JSON,ce 只在 E2E 端点解密/加密,中继只转密文。
 *
 * 与管家 `butler.ts` 的审批同形(reqId pending map + 超时拒 + onResolved 同步手机),但解耦出来:
 *   ① 不绑 sid=butlerSid(终端 CC 的审批只按 reqId 配对,可多并发 pending);② 任何 agent 复用。
 */
import { randomBytes } from 'node:crypto'

/** 一条 pending 审批的请求信息(经 onPending 发给手机,手机据此渲染审批卡)。 */
export interface ApprovalRequest {
  reqId: string
  /** 哪个终端的 agent(hook 携带的终端归属;可空)。ce 不解读,透传给手机插件做关联。 */
  terminalId?: string
  /** 工具名(如 Write/Bash)。ce 不解读语义,只透传。 */
  tool: string
  /** 工具入参。ce 不解读,透传给手机渲染(插件决定怎么展示,如 Write → diff)。 */
  input: Record<string, unknown>
}

export type ApprovalDecision = 'allow' | 'deny'

export interface ApprovalDispatcherOpts {
  /** 新 pending 产生时回调:ce 据此把请求作为 AgentEvent 加密发给手机。 */
  onPending: (req: ApprovalRequest) => void
  /** ce 单方面结掉 pending(超时 / cancelAll)时回调:ce 据此通知手机同步审批卡,免僵尸卡。
   *  手机人审发起的 allow/deny **不走这**(手机本地卡已先标好,见 resolve)。 */
  onResolved?: (reqId: string, resolved: 'approved' | 'denied') => void
  /** 超时毫秒;到点未答 → 自动 deny。**必传(无默认)**:审批超时必须【小于】调用方 agent 自身的 hook 超时
   *  (CC PreToolUse 默认 60s → ce 传 55s),否则 agent 会先强杀 hook 成 block、ce 的 deny 到不了。agent 的
   *  hook 超时是调用方才知道的专属知识(通用 dispatcher 不知是 CC 还是别的 agent),故不进默认、强制传。 */
  timeoutMs: number
}

interface Pending {
  req: ApprovalRequest
  resolve: (d: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalDispatcher {
  private readonly pending = new Map<string, Pending>()
  private readonly onPending: (req: ApprovalRequest) => void
  private readonly onResolved?: (reqId: string, resolved: 'approved' | 'denied') => void
  private readonly timeoutMs: number

  constructor(opts: ApprovalDispatcherOpts) {
    this.onPending = opts.onPending
    this.onResolved = opts.onResolved
    this.timeoutMs = opts.timeoutMs
  }

  /** 发起一条 blocking 审批:生成 reqId、登记 pending、回调 onPending(发手机)、返回等结果的 Promise。
   *  调用方(hook 接收器)`await` 此 Promise → 拿到 allow/deny → 回 hook。 */
  request(
    terminalId: string | undefined,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<ApprovalDecision> {
    const reqId = randomBytes(4).toString('hex')
    const req: ApprovalRequest = { reqId, terminalId, tool, input }
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        // 超时:ce 单方面 deny + 通知手机(免僵尸卡:用户后点「允许」显示「已发」但 ce 早 delete、
        // agent 实际拿到 deny)。
        if (this.pending.delete(reqId)) {
          this.onResolved?.(reqId, 'denied')
          resolve('deny')
        }
      }, this.timeoutMs)
      this.pending.set(reqId, { req, resolve, timer })
      // onPending 在登记 pending【之后】调:手机极快回 resolveApproval 时,resolve 必能命中。
      this.onPending(req)
    })
  }

  /** 手机 `resolveApproval` RPC 来 → 解对应 pending。返回是否命中(命中=true;未知 reqId=false,幂等)。
   *  **也调 onResolved**(区别于管家单主手机):通用 dispatcher 面向多手机共连,一个手机决策后,其他手机
   *  仍挂着的审批卡要同步清掉。发起方手机本地卡已先标好,收到自己的 resolved 通知是幂等 no-op。 */
  resolve(reqId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(reqId)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(reqId)
    this.onResolved?.(reqId, decision === 'allow' ? 'approved' : 'denied')
    p.resolve(decision)
    return true
  }

  /** ce 退出 / 中继断 → 全部 pending 结掉(默认 deny,防 hook 永久挂起)。走 onResolved 通知手机。 */
  cancelAll(decision: ApprovalDecision = 'deny'): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      this.onResolved?.(p.req.reqId, decision === 'allow' ? 'approved' : 'denied')
      p.resolve(decision)
    }
    this.pending.clear()
  }

  get size(): number {
    return this.pending.size
  }
}
