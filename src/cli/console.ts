/**
 * ce 控制台(TUI) —— `ce`(无 --daemon)进这里。
 * 后台 daemon 干活,控制台连它的 /control 端点看状态/发命令;退出控制台不影响 daemon。
 * 零依赖:readline + ANSI + fetch。daemon 不在则启动它(spawn ce --daemon,daemon 自读 ~/.ce/config.json)。
 *
 * 配套:daemon 侧路由见 main.ts 的 controlRoute。
 */
import { createInterface } from 'node:readline'
import { openSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { renderQr } from './qr'
import { rotateLogIfBig } from './log'
import { installWorkshop, defaultWorkshopRoot, resolveWorkshopDir } from './workshop'
import { readDaemonInfo, staleStarting, STALE_STARTING_MS, type DaemonInfo } from './daemon-state'
import { resolveWorkdir } from './paths'
import { saveWorkdir } from './config'

interface PairedPhone { id: string; name: string; pairedAt: number }
interface State {
  running: boolean; pid: number; version: string; relay: string; jupyter: string
  pairingMode: string; pin: string; phones: { id: string; name: string }[]; paired: PairedPhone[]
  wsConnected: boolean
  connectionCode: string | null
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

/** daemon 进程在不在:读 daemon.json + pid 存活探测(kill -0)。starting(还没就绪/port 未定)也算"在"。
 *  实现在 daemon-state.ts(含 startAt 缺失回退 mtime、卡死启动态判定),console 只消费。 */
function procInfo(): DaemonInfo | null {
  return readDaemonInfo()
}
/** daemon 就绪(进程在 + 控制端点 port 已定)。控制台进 menu 前要就绪。 */
function readyInfo(): DaemonInfo | null {
  const d = procInfo()
  return d?.port ? d : null
}

async function api<T>(d: DaemonInfo, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${d.port}${path}`, init)
  return (await r.json()) as T
}

/** 把控制台收到的 CLI 参数透传给 daemon(--relay/--workdir/--jupyter/--jupyter-token/--python/...):
 *  真正消费这些参数的是 daemon(main()),不透传 = 控制台敲的参数被静默吞掉 —— 真实事故:
 *  `ce --workdir=/aiprojrct` 起的 daemon 按默认根解析,jupyter.json root 记成 /,与用户自跑的
 *  Jupyter(root_dir=/aiprojrct)对不上 → 不复用、又自启第二个 Jupyter。
 *  daemon 收到 --workdir 还会 saveWorkdir 落盘(config.json),与「开机自启不带参」通道合流。
 *  滤掉 --daemon(spawn 时自己补)与 --workshop(旁路模式:装工坊即退,不该由 daemon 执行)。 */
function forwardArgs(): string[] {
  return process.argv.slice(2).filter((a) => a !== '--daemon' && !(a === '--workshop' || a.startsWith('--workshop=')))
}

/** 启动 daemon(spawn detached ce --daemon);relay 由 daemon 自读 config.json / 透传的 --relay。 */
function startDaemon(): void {
  // dev(bun main.ts):spawn bun + 脚本路径;编译版(ce):spawn ce。两者都带 --daemon + 透传参数。
  const isDev = process.argv[1]?.endsWith('.ts') ?? false
  const cmd = isDev ? process.argv[0]! : process.execPath
  const extra = forwardArgs()
  const args = isDev ? [process.argv[1]!, '--daemon', ...extra] : ['--daemon', ...extra]
  // daemon stdout/stderr → ~/.ce/ce.log(append):否则 stdio:'ignore' 吞掉 [ce] 日志 + uncaughtException,
  // daemon 崩溃/重连时无据可查(控制台 [l] 只看得到 Jupyter 日志)。
  let stdio: Array<'ignore' | number> = ['ignore', 'ignore', 'ignore']
  try {
    const logPath = join(homedir(), '.ce', 'ce.log')
    rotateLogIfBig(logPath) // 启动时轮转一次,防 daemon 长期跑撑爆 ce.log
    const fd = openSync(logPath, 'a')
    stdio = ['ignore', fd, fd]
  } catch {
    /* 开日志失败 → 退回 ignore,不阻塞启动 */
  }
  spawn(cmd, args, { detached: true, stdio, cwd: process.cwd() }).unref()
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

/** 杀掉卡死在启动态的 daemon 并重新 spawn。SIGTERM 即默认终止(daemon 无 SIGTERM 处理器);
 *  此态下 port 未定 = daemon 尚未走完 resolveJupyter 之后的就绪写入,通常无自启 Jupyter 可成孤儿;
 *  即便有(卡在更后面的阶段),daemon 重启后会经 jupyter.json 验活复用,不受影响。 */
async function restartStuckDaemon(): Promise<void> {
  const d = procInfo()
  if (!d) return
  const waited = d.startAt ? Math.round((Date.now() - d.startAt) / 60000) : Math.round(STALE_STARTING_MS / 60000)
  console.log(C.yellow + `\ndaemon 卡在启动态约 ${waited} 分钟(疑似卡死,如卡在没人能答的安装询问),杀旧进程重启...` + C.reset)
  try { process.kill(d.pid) } catch { /* 已死 */ }
  try { unlinkSync(join(homedir(), '.ce', 'daemon.json')) } catch { /* 已不在 */ }
  // 给旧进程一点退场时间:防新 daemon 撞单例锁(48731 未释放)误走「放弃端口锁」降级甚至双跑
  await sleep(1500)
  startDaemon()
}

/** 控制台路径也处理 --workdir(校验 + 落盘 config.json):daemon 收到透传参数后本会自己落,
 *  但 daemon 已在跑时 spawn 会被单例挡掉、参数根本传不到 —— 这里补一份,保证「至少重启后生效」,
 *  不再静默吞参数。目录无效:用户就在控制台前,与 daemon CLI 路径同语义直接报错退出。 */
function applyWorkdirArg(): void {
  const wdArg = process.argv.find((a) => a.startsWith('--workdir='))
  if (!wdArg) return
  const wd = resolveWorkdir(wdArg.slice('--workdir='.length), undefined)
  if ('invalid' in wd) {
    console.error(`[ce] --workdir 指向的目录无效:"${wd.invalid}"(不存在或不是文件夹),请检查路径后重试。`)
    process.exit(1)
  }
  if (procInfo()?.port) {
    if (!saveWorkdir(wd.dir)) console.error('[ce] 警告:工作目录写入 ~/.ce/config.json 失败,重启后将回退默认根目录')
    else console.log(`[ce] 已记住工作目录:${wd.dir}。当前 daemon 已在跑,重启 daemon 后生效(控制台 [x] 停再 [s] 启)`)
  }
}

export async function runConsole(): Promise<void> {
  process.stdout.write(clr)
  console.log(`${C.bold}ce 控制台${C.reset}`)
  applyWorkdirArg()
  let d = procInfo()
  if (staleStarting(d)) {
    await restartStuckDaemon()
    d = procInfo()
  } else if (!d) {
    console.log('daemon 未运行,启动中...')
    startDaemon()
  } else if (!d.port) {
    console.log('daemon 启动中(首次正在准备 Jupyter,约 1-2 分钟)...')
  }
  // 等就绪(port 出现),最长 ~3 分钟(首次 pip install jupyterlab)。daemon 进程消失 = 真失败。
  // 老逻辑只等 12s 就报失败 → 首次装 Jupyter 时必然误报 + 重复 spawn 多个 daemon。
  // 等待中发现 daemon 卡死在启动态(starting 超 STALE_STARTING_MS,如卡在没人能答的安装询问上)
  // → 杀掉重启并重给等待预算,不再无限打点(Kylin 真机:卡 22 天,每次 ce 干等后仍不恢复)。
  // daemon.json 要等 spawn 的进程真正 boot 后才写上,连续 3s 读不到才算「进程已退出」防误判。
  let missing = 0
  for (let i = 0; i < 180; i++) {
    if (d?.port) break
    await sleep(1000)
    d = procInfo()
    if (!d) {
      if (++missing >= 3) {
        console.error(C.red + '\ndaemon 启动失败(进程已退出)。排查:终端跑 ce --daemon 看报错,或看 ~/.ce/ce.log' + C.reset)
        process.exit(1)
      }
      continue
    }
    missing = 0
    if (staleStarting(d)) {
      await restartStuckDaemon()
      d = procInfo()
      i = 0 // 新 daemon 重新给满等待预算;它若因同一环境问题再退出,由上方「进程已退出」分支接住
      continue
    }
    process.stdout.write('.')
  }
  process.stdout.write('\n')
  if (!d?.port) {
    console.error(C.red + 'daemon 启动超时(首次装 Jupyter 较慢)。可先跑 ce --daemon 看进度,起来后再 ce' + C.reset)
    process.exit(1)
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
    const help = `${C.dim}[s]启 [x]停 [r]重启 [u]更新 [c]二维码 [p]改PIN [w]白名单 [o]工坊 [l]日志 [d]体检 [q]退出${C.reset}`
    process.stdout.write(clr + panel + '\n' + help + '\n> ')
    const k = await readKey()
    if (k === 'q') { console.log('\n再见(daemon 继续后台跑)。'); return }
    try {
      if (k === 's') { console.log('\ndaemon 已在运行。'); await sleep(1200) }
      if (k === 'x') { await api(d, '/control/stop', { method: 'POST' }); console.log('\n已请求停止。'); await sleep(1500); return }
      if (k === 'r') {
        await api(d, '/control/restart', { method: 'POST' })
        console.log('\n重启中...'); await sleep(2500)
        const nd = readyInfo(); if (nd) d = nd
      }
      if (k === 'u') {
        const r = await api<{ ok: boolean; updated?: boolean; error?: string }>(d, '/control/update', { method: 'POST' })
        console.log('\n' + (r.ok ? (r.updated ? C.green + '✓ 已更新,重启中...' + C.reset : '已是最新,无需更新') : C.red + '✗ ' + r.error + C.reset))
        if (r.ok && r.updated) { await sleep(2500); const nd = readyInfo(); if (nd) d = nd }
        await sleep(1500)
      }
      if (k === 'c') await showQr(d)
      if (k === 'p') await changePin(d)
      if (k === 'w') await whitelist(d)
      if (k === 'o') await workshopItem(st.relay)
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

/** [o] 工坊:安装/更新插件工坊(选目录;与 CLI `ce --workshop=<目录>` 同一安装器)。
 *  装完手机工坊页即可用;marker 记集装箱摘要,之后每次安装自动判新旧、幂等更新。 */
async function workshopItem(relayWs: string): Promise<void> {
  const def = defaultWorkshopRoot(homedir())
  const raw = (await prompt(`\n工坊安装目录(回车 = ${def}): `)).trim()
  console.log('')
  try {
    const root = await resolveWorkshopDir(raw ? resolve(raw) : def)
    const r = await installWorkshop({ relayHttp: relayWs.replace(/^ws/, 'http'), root })
    console.log(r.status === 'up-to-date'
      ? C.green + '✓ 工坊已是最新,无需重装' + C.reset
      : C.green + '✓ 工坊安装完成 —— 手机工坊页即可使用' + C.reset)
  } catch (e) {
    console.log(C.red + '✗ 工坊安装失败: ' + (e as Error).message + C.reset)
  }
  await sleep(2000)
}

async function whitelist(d: DaemonInfo): Promise<void> {
  const st = await api<State>(d, '/control/state')
  // 2026-09-21:白名单页列【磁盘持久名单】(带名字/配对时间/在线标记),不再是内存会话表
  // —— 此前 ce 重启后显示 (无),配对过的手机全不可见、无法区分谁是谁。
  const online = new Set(st.phones.map((p) => p.id))
  console.log('\n已配对手机:')
  if (st.paired.length === 0) console.log('  (无)')
  st.paired.forEach((p, i) => {
    const when = p.pairedAt ? new Date(p.pairedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间'
    console.log(
      `  ${i}  ${p.name || '(未命名)'}  ${when}${online.has(p.id) ? ' ' + C.green + '●在线' + C.reset : ''}  ${C.dim}${p.id}${C.reset}`,
    )
  })
  const idx = await prompt('\n踢掉第几个?(数字,留空取消): ')
  if (!idx) return
  const p = st.paired[Number(idx)]
  if (!p) { console.log(C.red + '序号无效' + C.reset); await sleep(1500); return }
  await api(d, '/control/unpair', { method: 'POST', body: JSON.stringify({ phoneId: p.id }) })
  console.log(C.green + '\n✓ 已踢 ' + (p.name || p.id) + C.reset)
  await sleep(1500)
}

/** 全屏显示二维码 + 连接码 + PIN(daemon 注册成功后才有 connectionCode)。按任意键返回。 */
async function showQr(d: DaemonInfo): Promise<void> {
  const st = await api<State>(d, '/control/state')
  if (!st.connectionCode) {
    console.log(clr + C.yellow + '尚未生成连接码(daemon 还在连中继,稍候按 [c] 再试)。' + C.reset)
    await readKey()
    return
  }
  let qr = ''
  try { qr = renderQr(st.connectionCode) } catch { /* 渲染失败→只给连接码文本 */ }
  const pinLine = st.pairingMode === 'pin'
    ? `\n配对 PIN(新手机首次连接在 App 输入): ${C.bold}${st.pin}${C.reset}`
    : ''
  const head = qr ? qr + '\n' + C.dim + '用 App 扫码,或手动粘贴下方连接码:' + C.reset + '\n' : ''
  console.log(clr + head + st.connectionCode + pinLine + '\n\n' + C.dim + '(按任意键返回)' + C.reset)
  await readKey()
}

async function showLogs(d: DaemonInfo): Promise<void> {
  const r = await api<{ lines: string }>(d, '/control/logs?n=40')
  console.log(clr + C.dim + '── 日志(最近 40 行,按任意键返回)──' + C.reset)
  console.log(r.lines)
  await readKey()
}

async function doctor(d: DaemonInfo): Promise<void> {
  const r = await api<{ relay: { url: string; connected: boolean }; jupyter: { url: string } | null; claude: string | null }>(d, '/control/doctor')
  const lines = [
    `中继    ${r.relay.connected ? C.green + '✓ 已连' : C.red + '✗ 未连'}${C.reset}  ${r.relay.url}`,
    `Jupyter ${r.jupyter ? C.green + '✓ ' + r.jupyter.url : C.red + '✗ 未检测到'}${C.reset}`,
    `claude  ${r.claude ? C.green + '✓ ' + r.claude + C.reset : C.red + '✗ 未检测到(管家/CC 对话不可用)' + C.reset}`,
  ]
  console.log(clr + box(lines) + '\n(按任意键返回)')
  await readKey()
}
