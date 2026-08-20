import { test, expect } from 'bun:test'
import { Heartbeat } from '../src/cli/heartbeat'

/** 假 WS:记录 ping/terminate,可手动派发 pong/close。 */
class FakeWs {
  pings = 0
  terminated = false
  stopped = false
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
  const ws = new FakeWs()
  new Heartbeat(ws, fast)
  await tick(15)
  ws.emitPong() // 第 1 次 ping 后回 pong
  await tick(15)
  ws.emitPong()
  await tick(15)
  ws.emitPong()
  expect(ws.terminated).toBe(false)
  expect(ws.pings).toBeGreaterThanOrEqual(3) // 一直在正常心跳
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
