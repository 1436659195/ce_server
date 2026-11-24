import { test, expect } from 'bun:test'
import { staleStarting, STALE_STARTING_MS, type DaemonInfo } from '../src/cli/daemon-state'

// 2026-11 Kylin 真机事故:daemon 卡死时 daemon.json 恒 {starting:true, port:null},控制台光看
// 「进程活着」无限打点。staleStarting 是时间兜底:starting 超过 STALE_STARTING_MS 即判卡死。

const NOW = 1_000_000_000_000

test('starting 超过容忍期 → 判卡死(杀掉重启的依据)', () => {
  const d: DaemonInfo = { pid: 1, starting: true, startAt: NOW - STALE_STARTING_MS - 1 }
  expect(staleStarting(d, NOW)).toBe(true)
})

test('starting 未超容忍期(正常首次装 Jupyter 1-2 分钟)→ 不判卡死', () => {
  const d: DaemonInfo = { pid: 1, starting: true, startAt: NOW - 60_000 }
  expect(staleStarting(d, NOW)).toBe(false)
})

test('已就绪(port 已定 / starting:false)→ 谈不上卡死,哪怕 startAt 很旧', () => {
  const ready: DaemonInfo = { pid: 1, starting: true, port: 48730, startAt: NOW - STALE_STARTING_MS * 99 }
  expect(staleStarting(ready, NOW)).toBe(false)
  const started: DaemonInfo = { pid: 1, starting: false, startAt: NOW - STALE_STARTING_MS * 99 }
  expect(staleStarting(started, NOW)).toBe(false)
})

test('startAt 未知 → 保守不判卡死(宁可多等,不误杀正常慢启动)', () => {
  const d: DaemonInfo = { pid: 1, starting: true }
  expect(staleStarting(d, NOW)).toBe(false)
  const bad: DaemonInfo = { pid: 1, starting: true, startAt: 0 }
  expect(staleStarting(bad, NOW)).toBe(false)
})

test('无 daemon 状态(null)→ 不判卡死', () => {
  expect(staleStarting(null, NOW)).toBe(false)
})
