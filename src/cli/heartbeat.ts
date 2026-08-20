/**
 * ce↔中继 协议层心跳:每 intervalMs 发 ws.ping(),连续 maxMissed 次无 pong → terminate。
 * 治 half-open 死连接(热点断换/NAT 超时/睡眠唤醒:TCP 已断但 FIN/RST 未达,close 永不触发,
 * ce 抱死连接永不重连 —— 2026-08-19 Windows 被控机失联根因)。terminate 触发既有 close
 * 处理器 → 指数退避重连 → 带 cid 回原 sid,手机配对不失效。
 * 依赖对端为标准 WS(relay 用 ws 库自动回 pong;ws 服务端 ping 时本端也自动回 pong)。
 */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private missed = 0

  constructor(
    private ws: {
      ping(): void
      terminate(): void
      on(ev: 'pong' | 'close', fn: () => void): void
      /** ws 库 WebSocket 有 readyState(1=OPEN);测试假对象可不带(undefined → 不 guard) */
      readyState?: number
    },
    private opts: { intervalMs?: number; maxMissed?: number } = {}
  ) {
    this.ws.on('pong', () => (this.missed = 0))
    this.ws.on('close', () => this.stop())
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 30_000)
  }

  private tick(): void {
    // CONNECTING 期(慢握手)不是死连接:ws.ping() 在非 OPEN 态会抛 InvalidStateError,
    // 若不 guard 会被下面的 catch 误判为死连接而 terminate。故未 OPEN 时跳过本 tick,
    // 不计 missed、不 terminate,等握手完成后正常心跳。
    if (this.ws.readyState !== undefined && this.ws.readyState !== 1) return
    const maxMissed = this.opts.maxMissed ?? 2
    if (this.missed >= maxMissed) {
      console.log('[ce] 心跳超时,重连')
      this.stop()
      this.ws.terminate()
      return
    }
    try {
      this.ws.ping()
      this.missed++
    } catch {
      // 发送抛错 = 连接已坏,同判死
      console.log('[ce] 心跳 ping 异常,重连')
      this.stop()
      this.ws.terminate()
    }
  }

  /** 停止心跳(连接关闭/主动断开时调;幂等)。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
