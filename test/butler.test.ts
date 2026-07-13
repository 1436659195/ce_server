import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { ButlerManager, ccArgs } from '../src/cli/butler'

/**
 * 假 cc:读 stdin → 回一行 JSON result(node -e,避免 fixture 路径)。用于验证管家进程桥接收发闭环,
 * 不依赖真 claude(真 claude 的长驻由 spike 证,这里只测 ce 侧的字节桥接 + 生命周期)。
 */
// 假 cc 忽略 args(那些是给真 claude 的;传给 bun 会被当 flag 解析报错)。只读 stdin → 写 result。
const FAKE_CC = (_args: string[]): ReturnType<typeof spawn> =>
  spawn(
    process.execPath, // bun 本体(ce 运行时,必在);避免依赖 node 是否在 PATH
    ['-e', "process.stdin.on('data',d=>{process.stdout.write('{\"type\":\"result\",\"subtype\":\"success\"}\\n')})"],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('ccArgs:全 pipe 长驻命令——带 -p + stream-json、不带 prompt 参数、不带 --bare、skill 为末 arg', () => {
  const a = ccArgs('管家的 skill 文本')
  expect(a).toContain('-p')
  expect(a).toContain('--input-format')
  expect(a[a.indexOf('--input-format') + 1]).toBe('stream-json')
  expect(a).toContain('--output-format')
  expect(a.join(' ')).not.toContain('--bare')
  expect(a[a.length - 1]).toBe('管家的 skill 文本') // skill 直传(--append-system-prompt 的值)
})

test('start → writeStdin → onOutput 收到 cc 输出;stop → onExit;size 归零', async () => {
  const outputs: { sid: string; chunk: Uint8Array }[] = []
  const exits: { sid: string; code: number | null }[] = []
  const mgr = new ButlerManager(
    (sid, _owner, chunk) => outputs.push({ sid, chunk }),
    (sid, _owner, code) => exits.push({ sid, code }),
    FAKE_CC
  )
  const sid = mgr.start('SKILL', 'phone-A')
  expect(sid.startsWith('butler-')).toBe(true)
  expect(mgr.size).toBe(1)

  // 写一帧到 cc.stdin → 假 cc 回 result → onOutput
  mgr.writeStdin(sid, new TextEncoder().encode('{"type":"user"}\n'))
  await wait(300)
  const got = outputs.find((o) => o.sid === sid && new TextDecoder().decode(o.chunk).includes('"type":"result"'))
  expect(got).toBeDefined()

  // stop → cc 被 kill → onExit;map 清
  mgr.stop(sid)
  await wait(150)
  expect(exits.some((e) => e.sid === sid)).toBe(true)
  expect(mgr.size).toBe(0)
})

test('writeStdin 对未知 sid 静默 no-op(不抛)', () => {
  const mgr = new ButlerManager(() => {}, () => {}, FAKE_CC)
  expect(() => mgr.writeStdin('butler-nope', new TextEncoder().encode('x'))).not.toThrow()
})

test('stopAllForPhone:只 kill 该 phone 的 cc,他 phone 保留', async () => {
  const mgr = new ButlerManager(() => {}, () => {}, FAKE_CC)
  mgr.start('S', 'phone-A')
  mgr.start('S', 'phone-B')
  expect(mgr.size).toBe(2)
  mgr.stopAllForPhone('phone-A')
  await wait(150)
  expect(mgr.hasForPhone('phone-A')).toBe(false)
  expect(mgr.hasForPhone('phone-B')).toBe(true)
  mgr.stopAllForPhone('phone-B')
  await wait(100)
  expect(mgr.size).toBe(0)
})

test('spawn claude 失败(ENOENT=未装)→ onExit code -2(butler_nocc)', async () => {
  const exits: { sid: string; code: number | null }[] = []
  const missingBin = (_args: string[]) =>
    spawn('ce-definitely-not-a-real-binary-xyz123', [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const mgr = new ButlerManager(() => {}, (sid, _owner, code) => exits.push({ sid, code }), missingBin)
  mgr.start('S', 'phone-A')
  await wait(200)
  expect(exits.some((e) => e.code === -2)).toBe(true)
  expect(mgr.size).toBe(0)
})
