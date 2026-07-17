import { test, expect } from 'bun:test'
import { ApprovalDispatcher, type ApprovalRequest } from '../src/cli/approval'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('request → resolve(allow):onPending 发请求、命中解阻塞、pending 清空', async () => {
  const pending: ApprovalRequest[] = []
  const d = new ApprovalDispatcher({ onPending: (r) => pending.push(r), timeoutMs: 60_000 })
  const p = d.request('t1', 'Write', { file: 'a.ts' })
  await wait(5) // 让 onPending 同步回调跑完
  expect(pending).toHaveLength(1)
  expect(pending[0].tool).toBe('Write')
  expect(pending[0].terminalId).toBe('t1')
  expect(pending[0].input).toEqual({ file: 'a.ts' })
  expect(d.size).toBe(1)
  // 手机回 allow
  expect(d.resolve(pending[0].reqId, 'allow')).toBe(true)
  expect(await p).toBe('allow')
  expect(d.size).toBe(0)
})

test('resolve 未知 reqId → false、不抛(幂等:重复 resolve 同一 id 也 false)', async () => {
  const d = new ApprovalDispatcher({ onPending: () => {}, timeoutMs: 60_000 })
  expect(d.resolve('不存在', 'allow')).toBe(false)
  // 命中后再 resolve 同一 id → 已 delete → false(防双解)
  const pending: ApprovalRequest[] = []
  const d2 = new ApprovalDispatcher({ onPending: (r) => pending.push(r), timeoutMs: 60_000 })
  const p = d2.request('t1', 'X', {})
  await wait(5)
  expect(d2.resolve(pending[0].reqId, 'allow')).toBe(true)
  expect(d2.resolve(pending[0].reqId, 'allow')).toBe(false)
  await p
})

test('超时未答 → 自动 deny + onResolved 通知手机(免僵尸卡)', async () => {
  const resolved: Array<[string, 'approved' | 'denied']> = []
  const d = new ApprovalDispatcher({
    onPending: () => {},
    onResolved: (id, r) => resolved.push([id, r]),
    timeoutMs: 20,
  })
  const p = d.request(undefined, 'Bash', { cmd: 'rm -rf' })
  expect(await p).toBe('deny')
  expect(resolved).toHaveLength(1)
  expect(resolved[0][1]).toBe('denied')
  expect(d.size).toBe(0)
})

test('cancelAll → 全部 deny + 逐条 onResolved(ce 退出/断线防 hook 挂起)', async () => {
  const resolved: Array<[string, 'approved' | 'denied']> = []
  const d = new ApprovalDispatcher({
    onPending: () => {},
    onResolved: (id, r) => resolved.push([id, r]),
    timeoutMs: 60_000,
  })
  const p1 = d.request('t1', 'Write', {})
  const p2 = d.request('t2', 'Bash', {})
  await wait(5)
  expect(d.size).toBe(2)
  d.cancelAll()
  expect(await p1).toBe('deny')
  expect(await p2).toBe('deny')
  expect(resolved).toHaveLength(2)
  expect(d.size).toBe(0)
})

test('人审发起的 allow/deny 也触发 onResolved(多手机下其他手机的卡要同步清)', async () => {
  const resolved: Array<[string, 'approved' | 'denied']> = []
  const pending: ApprovalRequest[] = []
  const d = new ApprovalDispatcher({
    onPending: (r) => pending.push(r),
    onResolved: (id, r) => resolved.push([id, r]),
    timeoutMs: 60_000,
  })
  const p = d.request('t1', 'Write', {})
  await wait(5)
  d.resolve(pending[0].reqId, 'deny') // 手机 A 人审 deny
  expect(await p).toBe('deny')
  // 通知带结果:手机 B 据此把仍挂着的卡置「已拒绝」(A 本地卡已先标、幂等 no-op)
  expect(resolved).toHaveLength(1)
  expect(resolved[0][1]).toBe('denied')
})

test('多并发 pending:各自 reqId 独立配对', async () => {
  const pending: ApprovalRequest[] = []
  const d = new ApprovalDispatcher({ onPending: (r) => pending.push(r), timeoutMs: 60_000 })
  const p1 = d.request('t1', 'Write', { n: 1 })
  const p2 = d.request('t1', 'Write', { n: 2 })
  await wait(5)
  expect(d.size).toBe(2)
  // 先解第二条 → 只第二条完
  d.resolve(pending[1].reqId, 'allow')
  expect(await p2).toBe('allow')
  expect(d.size).toBe(1)
  d.resolve(pending[0].reqId, 'deny')
  expect(await p1).toBe('deny')
})

test('terminalId 可空(hook 未携带终端归属)', async () => {
  const pending: ApprovalRequest[] = []
  const d = new ApprovalDispatcher({ onPending: (r) => pending.push(r), timeoutMs: 60_000 })
  d.request(undefined, 'X', {})
  await wait(5)
  expect(pending[0].terminalId).toBeUndefined()
})
