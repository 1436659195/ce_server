/**
 * WS 断开触发的「即时死亡点名」合并器。
 *
 * 背景:终端死亡时 Jupyter 会立刻挂断其 terminado WS(操作系统级推事件,毫秒级)——
 * ce 据此可秒级验活,不必等 60s 轮询。但 close 事件会成串到达(Jupyter 重启会同时断掉
 * 全部终端 WS;一次刷新也 detach→close),不能一条 close 打一次 GET —— 用本类把
 * 时间上贴近的多次 trigger 合并成一次 run。
 *
 * 与 Heartbeat 同款可注入风格,便于单测。忙碌守卫在 run 内部(调用方自查 inFlight)。
 */
export class CloseProbe {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly run: () => Promise<void>,
    /** 合并窗口:窗口内的多次 trigger 只跑一次 run(窗口过后新 trigger 再起一轮)。 */
    private readonly coalesceMs = 100,
  ) {}

  /** 报告一次 WS 断开(窗口内重复调用合并为一次 run)。 */
  trigger(): void {
    if (this.timer !== null) return // 已有待执行的窗口
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, this.coalesceMs)
  }

  /** 停止(daemon 退出/测试收尾;幂等)。 */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
