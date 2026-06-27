import { test, expect } from 'bun:test'
import { Hub } from '../src/relay/hub'

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
  const { sid, token } = hub.register(cli.ws)
  expect(sid).toBeTruthy()
  expect(token).toBeTruthy()
  expect(hub.joinPhone(sid, token, phone.ws)).toBe(true)

  hub.onMessage(cli.ws, '密文X')
  expect(phone.sent).toEqual(['密文X']) // phone 收到
  expect(cli.sent).toEqual([]) // 中继不回弹给发送方
})

test('phone → cli 反向转发', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const phone = fakeWs()
  const { sid, token } = hub.register(cli.ws)
  hub.joinPhone(sid, token, phone.ws)

  hub.onMessage(phone.ws, '密文Y')
  expect(cli.sent).toEqual(['密文Y'])
})

test('错误 token 拒绝加入(防抢占)', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const phone = fakeWs()
  const { sid } = hub.register(cli.ws)
  expect(hub.joinPhone(sid, '错token', phone.ws)).toBe(false)
  // 加入失败 → cli 发的消息无处去(phone 没连),不抛、不转发
  hub.onMessage(cli.ws, '密文')
  expect(phone.sent).toEqual([])
})

test('phone 未连时缓冲,连上后补发', () => {
  const hub = new Hub()
  const cli = fakeWs()
  const { sid, token } = hub.register(cli.ws)
  // phone 还没连,cli 先发两条 → 应缓冲
  hub.onMessage(cli.ws, '密文A')
  hub.onMessage(cli.ws, '密文B')
  const phone = fakeWs()
  expect(hub.joinPhone(sid, token, phone.ws)).toBe(true)
  expect(phone.sent).toEqual(['密文A', '密文B']) // 补发
})
