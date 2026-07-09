import { test, expect } from 'bun:test'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../src/shared/frame'

// 帧协议 round-trip:加密前的明文结构能正确编解码(加密在 crypto 包做,frame 只管结构)
test('frame round-trip: RPC 请求(带 reqId)', () => {
  const f: Frame = {
    type: FrameType.RPCReq,
    reqId: 'r1',
    payload: new TextEncoder().encode('{"op":"listDir","path":"/"}'),
  }
  const out = decodeFrame(encodeFrame(f))
  expect(out.type).toBe(FrameType.RPCReq)
  expect(out.reqId).toBe('r1')
  expect(new TextDecoder().decode(out.payload)).toBe('{"op":"listDir","path":"/"}')
})

test('frame round-trip: 终端输入流(带 sid)', () => {
  const f: Frame = {
    type: FrameType.TermStdin,
    sid: 'term-1',
    payload: new TextEncoder().encode('ls -la\n'),
  }
  const out = decodeFrame(encodeFrame(f))
  expect(out.type).toBe(FrameType.TermStdin)
  expect(out.sid).toBe('term-1')
  expect(new TextDecoder().decode(out.payload)).toBe('ls -la\n')
})

// 多人共连路由字段:cli 用 targetPhoneId 定向发给某手机;hub 用 sourcePhoneId 标注来源。
// 这些是路由元数据(非 E2E 负载,payload 仍加密不变)。
test('frame round-trip: targetPhoneId / sourcePhoneId', () => {
  const f: Frame = {
    type: FrameType.TermOutput,
    sid: 't1',
    targetPhoneId: 'p2',
    payload: new Uint8Array([1, 2, 3]),
  }
  const back = decodeFrame(encodeFrame(f))
  expect(back.targetPhoneId).toBe('p2')
  expect(back.sid).toBe('t1')
})

test('omits route fields when absent (向后兼容)', () => {
  const wire = JSON.parse(
    new TextDecoder().decode(
      encodeFrame({ type: FrameType.Control, payload: new Uint8Array([9]) }),
    ),
  ) as Record<string, unknown>
  expect(wire.targetPhoneId).toBeUndefined()
  expect(wire.sourcePhoneId).toBeUndefined()
})
