/**
 * ce 控制台(TUI) —— `ce`(无 --daemon)进这里。
 * 后台 daemon 干活,控制台连它的 /control 端点看状态/发命令;退出控制台不影响 daemon。
 * 零依赖:readline + ANSI + fetch。daemon 不在则启动它(spawn ce --daemon,daemon 自读 ~/.ce/config.json)。
 *
 * 配套:daemon 侧路由见 main.ts 的 controlRoute。
 */
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

const DAEMON_JSON = join(homedir(), '.ce', 'daemon.json')

interface DaemonInfo { port: number; pid: number; version?: string }
interface State {
  running: boolean; pid: number; version: string; relay: string; jupyter: string
  pairingMode: string; pin: string; phones: { id: string; name: string }[]; paired: string[]
  wsConnected: boolean
}

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
}
const clr = '\x1b[2J\x1b[H'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 显示宽度:去掉 ANSI 转义后按码点计长(中文按 1,凑合用;box 对齐够看)。 */
const dispW = (s: string): number => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length

function box(lines: string[]): string {
  const w = Math.max(...lines.map(dispW)) + 2
  const line = (l: string) => '│ ' + l + ' '.repeat(Math.max(0, w - dispW(l) - 1)) + '│'
  return '┌' + '─'.repeat(w) + '┐\n' + lines.map(line).join('\n') + '\n└' + '─'.repeat(w) + '┘'
}

/** daemon 在跑?读 daemon.json + pid 存活探测(kill -0)。 */
function info(): DaemonInfo | null {
  try {
    const d = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')) as DaemonInfo
    if (!d.port || !d.pid) return null
    try { process.kill(d.pid, 0); return d } catch { return null }
  } catch { return null }
}

async function api<T>(d: DaemonInfo, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${d.port}${path}`, init)
  return (await r.json()) as T
}

/** 启动 daemon(spawn detached ce --daemon);relay 由 daemon 自读 config.json。 */
function startDaemon(): void {
  // dev(bun main.ts):spawn bun + 脚本路径;编译版(ce):spawn ce。两者都带 --daemon。
  const isDev = process.argv[1]?.endsWith('.ts') ?? false
  const cmd = isDev ? process.argv[0]! : process.execPath
  const args = isDev ? [process.argv[1]!, '--daemon'] : ['--daemon']
  spawn(cmd, args, { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref()
}

/** 单键读取(raw mode);Ctrl+C/Ctrl+D 转 'q'。 */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.once('data', (k) => {
      stdin.setRawMode?.(false)
      stdin.pause()
      const c = k.toString().toLowerCase()
      resolve(c === '\x03' || c === '\x04' ? 'q' : c)
    })
  })
}

/** 行输入(改 PIN / 选序号用)。 */
async function prompt(msg: string): Promise<string> {
  process.stdout.write(msg)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return await new Promise<string>((r) => rl.question('', (a) => r(a.trim()))) } finally { rl.close() }
}

export async function runConsole(): Promise<void> {
  process.stdout.write(clr)
  console.log(`${C.bold}ce 控制台${C.reset}`)
  let d = info()
  if (!d) {
    console.log('daemon 未运行,启动中...')
    startDaemon()
    for (let i = 0; i < 40 && !d; i++) { await sleep(300); d = info() }
    if (!d) { console.error(C.red + 'daemon 启动失败。手动排查:ce --daemon' + C.reset); process.exit(1) }
  }
  await menu(d)
}

async function menu(d: DaemonInfo): Promise<void> {
  while (true) {
    let st: State
    try { st = await api<State>(d, '/control/state') }
    catch { console.log('\n' + C.yellow + 'daemon 已断开(停止/重启中)。' + C.reset); return }
    const dot = st.wsConnected ? C.green + '●' : C.yellow + '●'
    const pinPart = st.pairingMode === 'pin' ? `  PIN ${C.bold}${C.yellow}${st.pin}${C.reset}` : ''
    const panel = box([
      `${C.bold}ce ${st.version}${C.reset}  ${dot} ${st.wsConnected ? '已连中继' : '未连中继'}${C.reset}`,
      `PID ${st.pid}   手机在线 ${C.green}${st.phones.length}${C.reset}   已配对 ${st.paired.length}`,
      `中继 ${C.cyan}${st.relay}${C.reset}`,
      `Jupyter ${C.cyan}${st.jupyter}${C.reset}  模式 ${st.pairingMode}${pinPart}`,
    ])
    const help = `${C.dim}[s]启 [x]停 [r]重启 [u]更新 [p]改PIN [w]白名单 [l]日志 [d]体检 [q]退出${C.reset}`
    process.stdout.write(clr + panel + '\n' + help + '\n> ')
    const k = await readKey()
    if (k === 'q') { console.log('\n再见(daemon 继续后台跑)。'); return }
    try {
      if (k === 's') { console.log('\ndaemon 已在运行。'); await sleep(1200) }
      if (k === 'x') { await api(d, '/control/stop', { method: 'POST' }); console.log('\n已请求停止。'); await sleep(1500); return }
      if (k === 'r') {
        await api(d, '/control/restart', { method: 'POST' })
        console.log('\n重启中...'); await sleep(2500)
        const nd = info(); if (nd) d = nd
      }
      if (k === 'u') {
        const r = await api<{ ok: boolean; updated?: boolean; error?: string }>(d, '/control/update', { method: 'POST' })
        console.log('\n' + (r.ok ? (r.updated ? C.green + '✓ 已更新,重启中...' + C.reset : '已是最新,无需更新') : C.red + '✗ ' + r.error + C.reset))
        if (r.ok && r.updated) { await sleep(2500); const nd = info(); if (nd) d = nd }
        await sleep(1500)
      }
      if (k === 'p') await changePin(d)
      if (k === 'w') await whitelist(d)
      if (k === 'l') await showLogs(d)
      if (k === 'd') await doctor(d)
    } catch (e) {
      console.log(C.red + '\n操作失败: ' + (e as Error).message + C.reset); await sleep(1500)
    }
  }
}

async function changePin(d: DaemonInfo): Promise<void> {
  const pin = await prompt('\n新 PIN(6 位数字,留空取消): ')
  if (!pin) return
  const r = await api<{ ok: boolean; error?: string }>(d, '/control/pin', { method: 'POST', body: JSON.stringify({ pin }) })
  console.log(r.ok ? C.green + '\n✓ PIN 已改(已配对手机免影响)' + C.reset : C.red + '\n✗ ' + r.error + C.reset)
  await sleep(1500)
}

async function whitelist(d: DaemonInfo): Promise<void> {
  const st = await api<State>(d, '/control/state')
  console.log('\n已配对手机:')
  if (st.phones.length === 0) console.log('  (无)')
  st.phones.forEach((p, i) => console.log(`  ${i}  ${p.name || '(无名)'}  ${C.dim}${p.id}${C.reset}`))
  const idx = await prompt('\n踢掉第几个?(数字,留空取消): ')
  if (!idx) return
  const p = st.phones[Number(idx)]
  if (!p) { console.log(C.red + '序号无效' + C.reset); await sleep(1500); return }
  await api(d, '/control/unpair', { method: 'POST', body: JSON.stringify({ phoneId: p.id }) })
  console.log(C.green + '\n✓ 已踢 ' + (p.name || p.id) + C.reset)
  await sleep(1500)
}

async function showLogs(d: DaemonInfo): Promise<void> {
  const r = await api<{ lines: string }>(d, '/control/logs?n=40')
  console.log(clr + C.dim + '── 日志(最近 40 行,按任意键返回)──' + C.reset)
  console.log(r.lines)
  await readKey()
}

async function doctor(d: DaemonInfo): Promise<void> {
  const r = await api<{ relay: { url: string; connected: boolean }; jupyter: { url: string } | null; claude: string }>(d, '/control/doctor')
  const lines = [
    `中继    ${r.relay.connected ? C.green + '✓ 已连' : C.red + '✗ 未连'}${C.reset}  ${r.relay.url}`,
    `Jupyter ${r.jupyter ? C.green + '✓ ' + r.jupyter.url : C.red + '✗ 未检测到'}${C.reset}`,
    `claude  ${r.claude}`,
  ]
  console.log(clr + box(lines) + '\n(按任意键返回)')
  await readKey()
}
