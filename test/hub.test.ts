import { test, expect } from 'bun:test'
import { Hub } from '../src/relay/hub'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFrame, decodeFrame, FrameType } from '../src/shared/frame'

// 假 WS:记录所有 send 调用(中继只需要 ws.send)
function fakeWs() {
  const sent: string[] = []
  const ws = { send: (d: string) => { sent.push(d) } }
  return { ws, sent }
}

// 中继核心:cli 发的密文,phone 原样收到;反之亦然。中继不解析、不改负载(零信任)。
test('register + joinPhone:cli → phone 转发密文', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const phone = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  expect(sid).toBeTruthy()
  expect(token).toBeTruthy()
  expect(hub.joinPhone(sid, token, phone.ws, 'p1')).toBe(true)

  hub.onMessage(cli.ws, '密文X')
  expect(phone.sent).toEqual(['密文X']) // phone 收到
  expect(cli.sent).toEqual([]) // 中继不回弹给发送方
})

test('phone → cli 反向转发', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const phone = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, phone.ws, 'p1')

  hub.onMessage(phone.ws, '密文Y')
  expect(cli.sent).toEqual(['密文Y'])
})

test('错误 token 拒绝加入(防抢占)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const phone = fakeWs()
  const { sid } = hub.register('c1', cli.ws)
  expect(hub.joinPhone(sid, '错token', phone.ws, 'p1')).toBe(false)
  // 加入失败 → cli 发的消息无处去(phone 没连),不抛、不转发
  hub.onMessage(cli.ws, '密文')
  expect(phone.sent).toEqual([])
})

test('phone 未连时缓冲,连上后补发', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  // phone 还没连,cli 先发两条 → 应缓冲
  hub.onMessage(cli.ws, '密文A')
  hub.onMessage(cli.ws, '密文B')
  const phone = fakeWs()
  expect(hub.joinPhone(sid, token, phone.ws, 'p1')).toBe(true)
  expect(phone.sent).toEqual(['密文A', '密文B']) // 补发
})

test('cid 复用:同 cid 多次 register → 同 sid/token(ce 重连后配对码仍有效)', () => {
  const hub = new Hub()
  const r1 = hub.register('machine-A', fakeWs().ws)
  const r2 = hub.register('machine-A', fakeWs().ws) // ce 重连:新 ws、同 cid
  expect(r2.sid).toBe(r1.sid)
  expect(r2.token).toBe(r1.token)
  const r3 = hub.register('machine-B', fakeWs().ws) // 不同机器 → 不同 sid
  expect(r3.sid).not.toBe(r1.sid)
})

test('cid 持久化:新 Hub 读同一 state → 同 cid 复用 sid(模拟中继重启)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-hub-'))
  const state = join(dir, 'state.json')
  const r1 = new Hub(state).register('machine-A', fakeWs().ws)
  expect(existsSync(state)).toBe(true) // 已落盘
  const r2 = new Hub(state).register('machine-A', fakeWs().ws) // 中继"重启"后新 Hub
  expect(r2.sid).toBe(r1.sid)
  expect(r2.token).toBe(r1.token)
  rmSync(dir, { recursive: true, force: true })
})

// ── 多 phone 共连(Task 2)──────────────────────────────────────────────────────
// hub 从一对一扩成一对多:多手机共连一台被控机,各自 E2E 通道。
// 零信任不变:hub 只读路由元数据(targetPhoneId/sourcePhoneId),不碰 payload 密文。
// frame 辅助:把 payload 字节编成 wire JSON 字符串(hub 透传的是字符串)
function encodeFrameStr(f: Parameters<typeof encodeFrame>[0]): string {
  return new TextDecoder().decode(encodeFrame(f))
}

test('multi-phone: 两 phone join 同 session 都成功', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const p1 = fakeWs()
  const p2 = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  expect(hub.joinPhone(sid, token, p1.ws, 'phoneIdA')).toBe(true)
  expect(hub.joinPhone(sid, token, p2.ws, 'phoneIdB')).toBe(true)
})

test('cli 带 targetPhoneId → 只目标 phone 收到(其他 phone 收不到)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const p1 = fakeWs()
  const p2 = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, p1.ws, 'phoneIdA')
  hub.joinPhone(sid, token, p2.ws, 'phoneIdB')
  // cli 发一条定向给 phoneIdB 的密文帧(payload 内容无所谓, hub 不解密)
  const frame = encodeFrameStr({
    type: FrameType.TermOutput,
    sid: 't1',
    targetPhoneId: 'phoneIdB',
    payload: new Uint8Array([1, 2, 3]),
  })
  hub.onMessage(cli.ws, frame)
  expect(p2.sent.length).toBe(1) // P2 收到
  expect(p2.sent[0]).toBe(frame) // 原帧透传(hub 不改负载/不改路由字段)
  expect(p1.sent).toEqual([]) // P1 收不到
})

test('cli 无 targetPhoneId → 广播所有 phone(向后兼容)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const p1 = fakeWs()
  const p2 = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, p1.ws, 'phoneIdA')
  hub.joinPhone(sid, token, p2.ws, 'phoneIdB')
  const frame = encodeFrameStr({
    type: FrameType.TermOutput,
    payload: new Uint8Array([9]),
  })
  hub.onMessage(cli.ws, frame)
  expect(p1.sent).toEqual([frame]) // 两个 phone 都收到
  expect(p2.sent).toEqual([frame])
})

test('phone 发 → cli 收到的帧被注入 sourcePhoneId(hub 注入,非 phone 提供)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const p1 = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, p1.ws, 'phoneIdA')
  // phone 发的帧本身不带 sourcePhoneId(hub 负责注入)
  const frame = encodeFrameStr({
    type: FrameType.TermStdin,
    sid: 't1',
    payload: new Uint8Array([1]),
  })
  hub.onMessage(p1.ws, frame)
  expect(cli.sent.length).toBe(1)
  const got = decodeFrame(new TextEncoder().encode(cli.sent[0]))
  expect(got.sourcePhoneId).toBe('phoneIdA') // hub 注入了来源标识
})

test('phone 断 → cli 收到 phoneLeft 明文通知(hub 生成,非用户负载)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const p1 = fakeWs()
  const p2 = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, p1.ws, 'phoneIdA')
  hub.joinPhone(sid, token, p2.ws, 'phoneIdB')
  hub.onClose(p2.ws)
  // cli 收到一条明文控制通知(非加密帧;hub 生成,零信任边界不变)
  expect(cli.sent).toEqual([JSON.stringify({ type: 'phoneLeft', phoneId: 'phoneIdB' })])
  // p1 不受影响:仍在 session,能继续收到广播
  hub.onMessage(cli.ws, encodeFrameStr({ type: FrameType.Control, payload: new Uint8Array([0]) }))
  expect(p1.sent.length).toBe(1)
  expect(p2.sent.length).toBe(0) // 已断开,不再收
})

test('phone 断且 cli 不在线 → 不抛(无 phoneLeft 可发)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const p1 = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, p1.ws, 'phoneIdA')
  hub.onClose(cli.ws) // cli 先断
  expect(() => hub.onClose(p1.ws)).not.toThrow() // phone 再断,无 cli 可通知,不抛
})

// ── AgentEvent(CC 审查楔子,spec §8)─────────────────────────────────────────
// hub 是零信任哑管道:agent 事件帧与其他 cli→phone 帧一样透传,hub 不解析事件语义。
test('AgentEvent 帧 cli→phone 透传(hub 不解析 agent 事件语义)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const phone = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, phone.ws, 'p1')
  const frame = encodeFrameStr({
    type: FrameType.AgentEvent,
    sid: 't1',
    payload: new Uint8Array([1, 2, 3]), // 密文,hub 不解密
  })
  hub.onMessage(cli.ws, frame)
  expect(phone.sent).toEqual([frame]) // 原样透传
  expect(cli.sent).toEqual([]) // 不回弹发送方
})

test('AgentEvent wire 编号=7(与手机端 ce-platform 同步,改了就破坏互通)', () => {
  expect(FrameType.AgentEvent).toBe(7)
})

// 治「杀 app 重开 → RPC 超时」:phoneId 持久,手机重连用同一 phoneId,但旧 WS 可能残留。
// joinPhone 必须踢掉同 phoneId 的旧 WS,否则 cli→phone 按 phoneId 定向会先命中死的旧 WS。
test('同 phoneId 重连踢旧 WS:cli 按 phoneId 定向只到新 WS,旧 WS 收不到', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const oldPhone = fakeWs()
  const newPhone = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, oldPhone.ws, 'p1') // 首次连(旧 WS)
  hub.joinPhone(sid, token, newPhone.ws, 'p1') // 重连(同 phoneId,新 WS)

  // cli 按 phoneId=p1 定向发一条(模拟 ce 回 RPCResp)
  const frame = new TextDecoder().decode(
    encodeFrame({ type: FrameType.RPCResp, targetPhoneId: 'p1', reqId: 'r1', payload: new Uint8Array([1, 2]) }),
  )
  hub.onMessage(cli.ws, frame)

  expect(newPhone.sent).toEqual([frame]) // ★ 新 WS 收到
  expect(oldPhone.sent).toEqual([]) // ★ 旧 WS 不收(否则新手机 RPC 超时)
})

test('同 phoneId 重连后:旧 WS 迟到 onClose 不发 phoneLeft(免 ce 误清新通道)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const oldPhone = fakeWs()
  const newPhone = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, oldPhone.ws, 'p1')
  hub.joinPhone(sid, token, newPhone.ws, 'p1') // 踢掉旧 WS(连带 wsMeta)

  hub.onClose(oldPhone.ws) // 旧 WS 此时才被 TCP 检测到关闭
  // cli 不应收到 phoneLeft(否则 ce 会清掉同 phoneId 的新 E2E 通道)
  expect(cli.sent.every((m) => !m.includes('phoneLeft'))).toBe(true)
  // 新 phone 仍能正常收定向消息
  const frame = new TextDecoder().decode(
    encodeFrame({ type: FrameType.RPCResp, targetPhoneId: 'p1', reqId: 'r1', payload: new Uint8Array() }),
  )
  hub.onMessage(cli.ws, frame)
  expect(newPhone.sent).toEqual([frame])
})

// 治「锁屏/切后台断连 → claude 回复/审批丢失」:定向帧(AgentEvent/RPCResp 带 targetPhoneId)在目标
// phone 离线时缓冲,重连(joinPhone)补发。旧实现直接丢弃,故锁屏后看不到 claude 回复。
test('定向帧 phone 离线时缓冲,重连补发(治锁屏丢回复)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const phone = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  hub.joinPhone(sid, token, phone.ws, 'p1')
  hub.onClose(phone.ws) // phone 离线(锁屏/断连)→ 从 phones 移除
  // cli 发定向 AgentEvent 给 p1 → p1 不在线 → 缓冲(旧实现会丢)
  const frame = new TextDecoder().decode(
    encodeFrame({ type: FrameType.AgentEvent, targetPhoneId: 'p1', payload: new Uint8Array([1, 2, 3]) }),
  )
  hub.onMessage(cli.ws, frame)
  expect(phone.sent).toEqual([]) // 旧 phone 已断,没收到
  // phone 重连(同 phoneId)→ 补发缓冲的定向帧
  const phone2 = fakeWs()
  hub.joinPhone(sid, token, phone2.ws, 'p1')
  expect(phone2.sent).toHaveLength(1)
  const got = decodeFrame(new TextEncoder().encode(phone2.sent[0]))
  expect(got.type).toBe(FrameType.AgentEvent)
  expect(got.targetPhoneId).toBe('p1')
})

test('定向帧缓冲有上限:超 DIRECTED_BUFFER_MAX(500)丢最早(防长任务+长断连 OOM)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const { sid, token } = hub.register('c1', cli.ws)
  for (let i = 0; i < 510; i++) {
    const f = new TextDecoder().decode(
      encodeFrame({ type: FrameType.AgentEvent, targetPhoneId: 'p1', payload: new Uint8Array([i % 256]) }),
    )
    hub.onMessage(cli.ws, f) // phone 从未连 → 全缓冲到 directedBuffer['p1']
  }
  const phone = fakeWs()
  hub.joinPhone(sid, token, phone.ws, 'p1')
  expect(phone.sent.length).toBe(500) // 超上限丢最早 10 条,恰好 500
})
