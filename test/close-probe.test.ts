import { test, expect } from 'bun:test'
import { CloseProbe } from '../src/cli/close-probe'

// CloseProbe:WS 断开 → 即时死亡点名的合并器。close 事件会成串到达
// (Jupyter 重启同时断掉全部终端 WS),窗口内多次 trigger 必须只跑一次 run。

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test('合并窗口内的多次 trigger 只跑一次 run;窗口过后可再触发', async () => {
  let runs = 0
  const p = new CloseProbe(async () => {
    runs++
  }, 20)
  p.trigger()
  p.trigger()
  p.trigger() // 同窗口合并成一次
  await sleep(70)
  expect(runs).toBe(1)
  p.trigger() // 窗口已过 → 新一轮
  await sleep(70)
  expect(runs).toBe(2)
  p.stop()
})

test('stop 后挂起的 run 不再执行(daemon 退出/测试收尾)', async () => {
  let runs = 0
  const p = new CloseProbe(async () => {
    runs++
  }, 20)
  p.trigger()
  p.stop()
  await sleep(70)
  expect(runs).toBe(0)
})
