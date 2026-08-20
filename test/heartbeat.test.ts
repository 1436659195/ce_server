import { test, expect } from 'bun:test'
import { Heartbeat } from '../src/cli/heartbeat'

/** 假 WS:记录 ping/terminate,可手动派发 pong/close。 */
class FakeWs {
  pings = 0
  terminated = false
  stopped = false
  readyState?: number // 不设 = undefined → Heartbeat 不 guard(兼容无该字段的假对象)
  private pongFns: (() => void)[] = []
  private closeFns: (() => void)[] = []
  ping(): void {
    this.pings++
  }
  terminate(): void {
    this.terminated = true
    this.closeFns.forEach((f) => f())
  }
  on(ev: 'pong' | 'close', fn: () => void): void {
    if (ev === 'pong') this.pongFns.push(fn)
    else this.closeFns.push(fn)
  }
  emitPong(): void {
    this.pongFns.forEach((f) => f())
  }
  emitClose(): void {
    this.closeFns.forEach((f) => f())
  }
}

const fast = { intervalMs: 10, maxMissed: 2 }
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('连续 2 次无 pong → terminate', async () => {
  const ws = new FakeWs()
  new Heartbeat(ws, fast) // eslint-disable-line @typescript-eslint/no-unused-vars
  await tick(80) // 10ms 间隔,2 次判死在 ~30ms 内
  expect(ws.terminated).toBe(true)
})

test('收到 pong 归零,不误杀', async () => {
  // 余量加厚:25ms 间隔 vs 10ms pong 周期,跨 8 个周期 ~200ms,杜绝真 flaky
  const ws = new FakeWs()
  new Heartbeat(ws, { intervalMs: 25, maxMissed: 2 })
  const end = Date.now() + 200
  while (Date.now() < end) {
    await tick(10)
    ws.emitPong() // pong 派发周期 10ms,远快于心跳间隔
  }
  expect(ws.terminated).toBe(false)
  expect(ws.pings).toBeGreaterThanOrEqual(3) // 一直在正常心跳
})

test('CONNECTING 期(readyState=0)跳过 tick:不 ping 不 terminate', async () => {
  const ws = new FakeWs()
  ws.readyState = 0 // ws 库 CONNECTING;此期 ping() 会抛 InvalidStateError,不能误判死
  new Heartbeat(ws, fast)
  await tick(80)
  expect(ws.terminated).toBe(false) // 慢握手 ≠ 死连接
  expect(ws.pings).toBe(0) // 未 OPEN 不发 ping
})

test('close 后定时器已清(stop 幂等)', async () => {
  const ws = new FakeWs()
  const hb = new Heartbeat(ws, fast)
  hb.stop()
  const pingsAtStop = ws.pings
  await tick(50)
  expect(ws.pings).toBe(pingsAtStop) // 不再 ping
  expect(ws.terminated).toBe(false)
})
