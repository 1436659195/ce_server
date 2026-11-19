/**
 * session-scan 单测(L1)—— 识别判定链 + 注入安全闸。
 * 安全闸是安全关键:每个拒绝路径都有专属用例(负闸优先于正闸;无 hooks 永不注入)。
 */
import { test, expect } from 'bun:test'
import {
  DEFAULT_AGENT_SIGNATURES,
  classifySession,
  injectionGate,
  matchSignature,
  osProcLister,
  scanSessionProcs,
  type ProcEntry,
} from '../src/cli/session-scan'

// ─── 特征表 ────────────────────────────────────────────────────────────────

test('特征表:claude argv 命中;非 agent 进程不误报', () => {
  expect(matchSignature('node /usr/local/bin/claude --help')?.platform).toBe('claude')
  expect(matchSignature('claude')?.platform).toBe('claude')
  expect(matchSignature('codex exec --json')?.platform).toBe('codex')
  expect(matchSignature('python train.py')).toBeNull()
  expect(matchSignature('bash')).toBeNull()
  expect(matchSignature('vim main.py')).toBeNull()
  // 前缀不误伤:claudette/claude-sdk-docs 这类非进程名不命中
  expect(matchSignature('claudette')).toBeNull()
})

// ─── 进程树扫描 ────────────────────────────────────────────────────────────

const procs: ProcEntry[] = [
  { pid: 1, ppid: 0, comm: 'bash', argv: 'bash', cwd: '/' },
  { pid: 100, ppid: 1, comm: 'bash', argv: 'bash', cwd: '/proj/A' }, // 会话 A 的 shell
  { pid: 101, ppid: 100, comm: 'node', argv: 'node /usr/local/bin/claude', cwd: '/proj/A' },
  { pid: 102, ppid: 101, comm: 'node', argv: 'node worker.js', cwd: '/proj/A' },
  { pid: 200, ppid: 1, comm: 'bash', argv: 'bash', cwd: '/proj/B' }, // 会话 B:跑脚本
  { pid: 201, ppid: 200, comm: 'python', argv: 'python train.py', cwd: '/proj/B' },
  { pid: 300, ppid: 1, comm: 'zsh', argv: 'zsh', cwd: '/home' }, // 会话 C:空 shell
]

test('scanSessionProcs:沿会话树收集 agent 进程;跑脚本/空 shell 无命中', () => {
  const hitsA = scanSessionProcs(100, procs)
  expect(hitsA).toHaveLength(1)
  expect(hitsA[0].sig.platform).toBe('claude')
  expect(hitsA[0].cwd).toBe('/proj/A')
  expect(scanSessionProcs(200, procs)).toHaveLength(0) // python 不在特征表
  expect(scanSessionProcs(300, procs)).toHaveLength(0)
})

// ─── 判定链 ────────────────────────────────────────────────────────────────

test('classifySession:注册表 > hooks > 进程特征 > 待确认(优先级递减)', () => {
  expect(classifySession({ registry: { name: 'A的CC', platform: 'claude' } })).toMatchObject({ status: 'connected' })
  expect(classifySession({ hooksAlive: true, matchedProc: { platform: 'claude', label: 'CC' } })).toMatchObject({ status: 'connected' })
  expect(classifySession({ matchedProc: { platform: 'codex', label: 'Codex', cwd: '/proj/B' } })).toMatchObject({
    status: 'suspect',
    platform: 'codex',
  })
  expect(classifySession({}).status).toBe('unconfirmed')
})

// ─── 注入安全闸(安全关键:穷举拒绝路径)──────────────────────────────────────

test('安全闸:负闸一票否决 —— 前台非 shell 时哪怕 hooks 说 idle 也绝不注入', () => {
  expect(injectionGate({ hooksState: 'idle', foregroundIsShell: false })).toBe('manual')
  expect(injectionGate({ hooksState: 'working', foregroundIsShell: false })).toBe('manual')
  expect(injectionGate({ hooksState: null, foregroundIsShell: false })).toBe('manual')
})

test('安全闸:正闸 —— hooks idle 且前台是 shell(或不可判)→ 注入', () => {
  expect(injectionGate({ hooksState: 'idle', foregroundIsShell: true })).toBe('inject')
  expect(injectionGate({ hooksState: 'idle', foregroundIsShell: null })).toBe('inject')
})

test('安全闸:working → 排队;无 hooks 信号 → 永不注入(转人工)', () => {
  expect(injectionGate({ hooksState: 'working', foregroundIsShell: true })).toBe('queue')
  expect(injectionGate({ hooksState: 'working', foregroundIsShell: null })).toBe('queue')
  expect(injectionGate({ hooksState: null, foregroundIsShell: true })).toBe('manual')
  expect(injectionGate({ hooksState: null, foregroundIsShell: null })).toBe('manual')
})

// ─── 真实 /proc 读取器(冒烟:本机至少能列出自身进程)───────────────────────────

test('osProcLister:本机冒烟 —— 能列出进程且自身在列', () => {
  const list = osProcLister()()
  expect(list.length).toBeGreaterThan(10)
  const me = list.find((p) => p.argv.includes('bun')) // bun test 自身
  expect(me).toBeTruthy()
  expect(me!.ppid).toBeGreaterThan(0)
})

// ─── 特征表数据性:默认表可扩展(不覆盖语义)────────────────────────────────────

test('特征表可扩展:自定义表参与匹配', () => {
  const ext = [...DEFAULT_AGENT_SIGNATURES, { platform: 'myagent', label: 'My', pattern: /(?:^|\/)myagent(?:$|[\s])/ }]
  expect(matchSignature('node bin/myagent serve', ext)?.platform).toBe('myagent')
  expect(matchSignature('node bin/myagent serve')).toBeNull() // 默认表不含
})
