/**
 * ce —— 跑在被控机的 CLI。编排:
 *   探测/起本地 Jupyter → 连中继(带持久 cid)注册会话 → 生成密钥+二维码 → 配对握手 → 桥接
 *
 * 持久化:ce 身份(cid + 密钥对)存 ~/.ce/identity.json,中继按 cid 复用 sid/token。
 *   → ce/中继重启后,手机存的配对码(cliPub + sid)仍有效、不必重扫;ce 断线自动重连中继
 *   (指数退避),本地 terminado 终端跨重连不丢。
 *
 * 用法:ce --relay=ws://relay.yourserver[:port] [--jupyter=url --jupyter-token=t]
 *       (不传 --jupyter 则先探测、再启动)
 *
 * ⚠️ 整合胶水,无单测;手测见 P3-5 清单(需真实中继 + Jupyter)。
 */
import WebSocket, { type RawData } from 'ws'
import { Heartbeat } from './heartbeat'
import { hostname, homedir } from 'node:os'
import { writeFileSync, mkdirSync, unlinkSync, readFileSync, readdirSync, chmodSync, renameSync, appendFileSync } from 'node:fs'
import { join, resolve, parse as parsePath } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { sharedSecret, seal, open } from '../shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../shared/frame'
import { detectServers, isAlive, toLoopback, resolveOsRoot, sameRoot } from './jupyter-detect'
import { launchJupyter } from './jupyter-launch'
import { makeJupyterClient, handleRpc, listTerminalsRetry, toRemoteTerminals, type RpcRequest, type RpcResponse } from './bridge'
import { UploadSessions } from './uploads'
import { ButlerManager } from './butler'
import { AgentRunner } from './agent-runner'
import { ApprovalDispatcher } from './approval'
import { generateHooksConfig, handleHookBody } from './cc-hooks'
import { TermBuffers } from './term-buffers'
import { loadOrCreateIdentity } from './identity'
import { tryAcquire } from './ownership'
import { loadAuthorized, loadPaired, addAuthorized, removeAuthorized, authorize, loadPin, savePin, type PairingMode } from './pairing'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { loadConfig } from './config'
import { ensureJupyter, type JupyterInstallDeps } from './jupyter-install'
import { resolvePythonBin } from './python'
import { runConsole } from './console'
import { renderQr } from './qr'
import { rotateLogIfBig } from './log'
import { ManagedTerms } from './managed-terms'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** ce 版本(build 时 --define CE_VERSION 注入;dev 直跑为 'dev')。控制台「查版本」用。 */
declare const CE_VERSION: string | undefined
// 兜底两道:未注入(undefined)→ dev;注入了但异常短(<=1 字符,如曾经的 "v")→ 也回退 dev。
const VERSION = typeof CE_VERSION !== 'undefined' && CE_VERSION.length > 1 ? CE_VERSION : 'dev'

/** daemon 单例锁端口(固定,本机独占):同一时刻只能一个 daemon bind = 机器级单例。
 *  进程死(正常/被杀/崩溃)内核自动回收端口 → 不用手动清,比文件锁可靠(文件锁崩溃留残留)。 */
const LOCK_PORT = 48731

function arg(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : undefined
}

/** 探测当前平台 binary 名后缀(linux/darwin/windows + x64/arm64),自更新下载对应文件用。 */
function detectPlatform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${os}-${arch}`
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

/** 随机十六进制 id(老 hub 未注入 sourcePhoneId 时,握手生成匿名 phoneId 用)。 */
function randId(n = 8): string {
  return randomBytes(n).toString('hex')
}

/** 6 位数字配对 PIN(ce 启动生成一次;pin 模式下新手机首次连接需在 App 输入)。 */
function randomPin(): string {
  return String(Math.floor(Math.random() * 900000) + 100000)
}

const pExecFile = promisify(execFile)

/** stdin 问 y/n。 */
async function askYesNo(msg: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const a = await new Promise<string>((r) => rl.question(`${msg} [y/N] `, r))
    return /^[yY]/.test(a.trim())
  } finally {
    rl.close()
  }
}

/** ensureJupyter 的真实副作用实现:spawn <python 解释器>/pip、stdin y/n。
 *  pythonBin 由调用方注入(resolvePythonBin 统一解析;生产红线 C1:不写死 'python' ——
 *  标准发行版只有 python3,写死会让前置检查探 python3 通过、下游全 127)。 */
function realJupyterDeps(pythonBin: string): JupyterInstallDeps {
  return {
    // 走 `<python> -m pip show jupyterlab`(而非 `jupyter --version`):Bun --compile 的 Windows 二进制
    // spawn 不了 jupyter.exe,但 spawn python.exe 正常(见 launchJupyter 注释)。pip show 退码 0=已装。
    hasJupyter: async () => {
      try {
        await pExecFile(pythonBin, ['-m', 'pip', 'show', 'jupyterlab'], { shell: true, windowsHide: true })
        return true
      } catch {
        return false
      }
    },
    prompt: (msg) => askYesNo(msg),
    install: async () => {
      console.log('[ce] pip install jupyterlab(清华源,约 1-2 分钟,请等待)...')
      await new Promise<void>((resolve, reject) => {
        // `<python> -m pip`(而非裸 `pip`):解释器已经 resolvePythonBin 实测过(ensurePythonOrExit 同源解析),更稳。
        // -i 清华 PyPI 源加速(默认源国内慢);--trusted-host 防 SSL 拦截(公司代理/旧证书)
        const p = spawn(
          pythonBin,
          ['-m', 'pip', 'install', 'jupyterlab', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--trusted-host', 'pypi.tuna.tsinghua.edu.cn'],
          { shell: true, stdio: 'inherit', windowsHide: true }
        )
        p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`pip 退出码 ${c}`))))
        p.on('error', reject)
      })
    },
  }
}

/** 命令是否存在于 PATH(linux 用 sh 内建 command -v;仅非 win32 分支调用)。 */
async function commandExists(name: string): Promise<boolean> {
  try {
    await pExecFile('sh', ['-c', `command -v ${name} >/dev/null 2>&1`])
    return true
  } catch {
    return false
  }
}

/**
 * 自装 Jupyter(=要走 pip)前先确保本机有 Python:没有就按平台给安装指引 + 让用户
 * 【重开终端】重跑一行安装器,然后退出。务必在 `pip install jupyterlab` 之前拦下——
 * 否则会拖到 pip 才报错,用户只看到“pip 退出码 1”,不知道根因是没装 Python。
 * 解析复用 resolvePythonBin(与探测/启动同一套:win32=python,否则实测先 python3 再 python,
 * 支持 --python=/CE_PYTHON 覆盖)—— 保证「前置检查过的解释器」=「后面真用的解释器」。
 * 返回解析出的解释器(供 realJupyterDeps / launchJupyter 注入);没有则已 exit(1)。
 */
async function ensurePythonOrExit(relayUrl: string): Promise<string> {
  // 与 detect/launch/deps 同一解析(覆盖参数/环境变量/两层实测;生产红线 C1:旧版这里探
  // python3、下游全用 'python',前置检查形同虚设)—— 保证「前置检查过的解释器」=「后面真用的」
  const isWin = process.platform === 'win32'
  const bin = await resolvePythonBin()
  if (bin) return bin

  const httpBase = relayUrl.replace(/^ws/, 'http')
  console.error('[ce] 未检测到 Python。Coding Everywhere 需要 Python 才能运行 Jupyter。')
  if (isWin) {
    console.error('[ce] 请先安装(任选其一):')
    console.error('     winget install Python.Python.3.12')
    console.error('     或到 https://www.python.org/downloads/ 下载(安装时勾选 “Add to PATH”)')
    console.error('[ce] 安装完成后,请【重新打开】PowerShell,重新执行一行安装命令:')
    console.error(`     irm ${httpBase}/install.ps1 | iex`)
  } else {
    const isMac = process.platform === 'darwin'
    const hasBrew = await commandExists('brew')
    const hasApt = await commandExists('apt-get')
    const hasDnf = await commandExists('dnf')
    console.error('[ce] 请先安装:')
    if (hasBrew) console.error('     brew install python')
    else if (hasApt) console.error('     sudo apt install python3 python3-pip')
    else if (hasDnf) console.error('     sudo dnf install python3 python3-pip')
    else if (isMac) console.error('     请先装 Homebrew(brew.sh)后 brew install python')
    else console.error('     请用系统包管理器安装 python3 和 pip')
    console.error('[ce] 安装完成后,请【重新打开】终端,重新执行一行安装命令:')
    console.error(`     curl -fsSL ${httpBase}/install.sh | sh`)
  }
  process.exit(1)
}

/** 取 url 的 port(无/非法 → '')。用于在同机多 jupyter 里按 port 匹配。 */
function portOf(url: string): string {
  try {
    return new URL(url).port
  } catch {
    return ''
  }
}

/** 从本机 jupyter 探测结果挑 root_dir(OS 路径)。Jupyter Contents API 不暴露 root_dir,
 *  只有 `jupyter server list` 输出的 `:: /path` 才是 OS 路径 → 必须靠 detectServers。
 *  只认按 port 精确匹配(同机多 jupyter 时猜第一个会把 root 安错);对不上 → null,由调用方显式处理。
 *  ★ 绝不兜底 process.cwd()(W1):root 是 agent cwd base 与上传边界,猜错 = 对话树与上传树分叉。 */
function pickRoot(servers: { url: string; root: string }[], url: string): string | null {
  const port = portOf(url)
  if (!port) return null
  return servers.find((s) => portOf(s.url) === port)?.root ?? null
}

/** 解析 Jupyter:显式 > 探测(只复用 root 在配置根的)> 引导装 > 启动。
 *  ce 的 jupyter 服务【配置根】= config.root(Windows install.ps1 选盘,默认 D: 有则 D:)/ Linux-Mac '/'。
 *  探测到的 jupyter 若 root 正好在配置根 → 复用;否则(无 / root 不在配置根,如本机 screen 开的 /data)→ 自启配置根的。
 *  返回 root(jupyter root_dir OS 路径,CC 对话 cwd 的 base)。 */
async function resolveJupyter(
  relayUrl: string
): Promise<{ baseUrl: string; token: string; root: string; stop?: () => void }> {
  const explicitUrl = arg('jupyter')
  const explicitToken = arg('jupyter-token')
  if (explicitUrl && explicitToken) {
    // 显式 url/token 最优先(用户明确指定外部 jupyter)。root 必须可确知(Contents API 不暴露 root_dir):
    // ① 同给 --workdir → 直接用(resolve 绝对化,容相对路径);② 本机探测按 port 精确对上 → 用它;③ 否则 exit(1)。
    // ★ 绝不静默兜底 ce 启动目录(W1):root 是 agent cwd base + 上传边界,猜错 = 对话树与上传树分叉。
    const workdir = arg('workdir')
    if (workdir) return { baseUrl: toLoopback(explicitUrl), token: explicitToken, root: resolve(workdir) }
    const existing = await detectServers()
    const root = pickRoot(existing, explicitUrl)
    if (root === null) {
      console.error(`[ce] --jupyter(${explicitUrl})的 root_dir 无法确定。本机探测候选:${existing.map((s) => `${s.url} → ${s.root}`).join('; ') || '(空)'}`)
      console.error('[ce] 显式指定外部 Jupyter 时请同给 --workdir=<该 Jupyter 的 root_dir>,或改用本机在跑的 Jupyter 端口')
      process.exit(1)
    }
    return { baseUrl: toLoopback(explicitUrl), token: explicitToken, root }
  }
  // osRoot:config.root(Windows install.ps1 选盘写入,默认有 D: 用 D:、否则 C:)优先,盘没了回退 cwd 盘根;
  // install.sh 不写 → Linux/Mac 恒 '/'(原行为)
  const osRoot = resolveOsRoot(loadConfig().root, parsePath(process.cwd()).root)
  // 排障可见性:选盘是否生效一行看穿(配置的盘没了时 resolveOsRoot 另有 warn),否则只能从手机文件栏反推
  console.log(`[ce] 文件根(Jupyter root_dir):${osRoot}`)
  // 优先复用上次自启的 Jupyter(daemon 重启不起新的 → 终端会话/终端名不丢,手机不会因换 Jupyter 而 404)。
  // 比 detectServers 的 jupyter list 解析可靠(Windows 路径格式/大小写坑,正是之前没复用、反复起多个的根因)。
  try {
    const saved = JSON.parse(readFileSync(join(homedir(), '.ce', 'jupyter.json'), 'utf8')) as { url: string; token: string; root?: string }
    // 复用须 root 与当前 osRoot 一致:换盘(config.root 变)后,旧 root 的活 Jupyter 不能把新选择挡住。
    // saved.root 缺失(古老/手改文件)同判不一致 —— root 是 CC 对话 cwd base + 上传边界,不可信就不复用(红线 W1 同源)。
    if (saved.url && saved.token && saved.root && sameRoot(saved.root, osRoot) && (await isAlive(saved.url, saved.token))) {
      console.log(`[ce] 复用上次 Jupyter:${saved.url}`)
      return { baseUrl: toLoopback(saved.url), token: saved.token, root: saved.root }
    }
    if (saved.url && saved.root && !sameRoot(saved.root, osRoot)) {
      console.log(`[ce] 上次 Jupyter root ${saved.root} ≠ 当前根 ${osRoot}(换盘?),不复用、按新根解析`)
    }
  } catch {
    /* 无 jupyter.json 或验活失败 → 落到探测/自启 */
  }
  const existing = await detectServers()
  // 只复用 root 正好在(配置)盘根的现成 jupyter;sameRoot 归一比较防 Windows 大小写/尾斜杠
  const reuse = existing.find((s) => sameRoot(s.root, osRoot))
  if (reuse && (await isAlive(reuse.url, reuse.token))) {
    // 验 token 有效才复用:有的旧 Jupyter runtime stale / jupyter list 没带 token → detectServers 拿到空 token,
    // 盲信复用会让后续所有 API 403。验不过(token 空/失效)就落自启,起一个 token 干净的新 Jupyter。
    console.log(`[ce] 复用根目录 Jupyter:${reuse.url}(root ${reuse.root})`)
    return { baseUrl: toLoopback(reuse.url), token: reuse.token, root: reuse.root }
  }
  if (reuse) console.log(`[ce] 探到的 Jupyter ${reuse.url} token 验证失败(旧实例/runtime stale),改为自启`)
  console.log('[ce] 未发现根目录的 Jupyter,自启...')
  // 自装 Jupyter 前先拦 Python:没 Python 就给指引 + 退出,绝不拖到 pip 报错。
  // 返回的 pyBin 注入后续 deps/launch(同一套解析,前置检查过的 = 真用的)。
  const pyBin = await ensurePythonOrExit(relayUrl)
  const r = await ensureJupyter(realJupyterDeps(pyBin))
  if (r === 'cancelled') {
    console.error('[ce] 未安装 Jupyter,无法继续。手动装:pip install jupyterlab -i https://pypi.tuna.tsinghua.edu.cn/simple')
    process.exit(1)
  }
  if (r === 'failed') {
    console.error('[ce] 安装 Jupyter 失败。请手动 pip install jupyterlab -i https://pypi.tuna.tsinghua.edu.cn/simple 后重试')
    process.exit(1)
  }
  console.log('[ce] 启动 Jupyter...')
  // onLog:把 Jupyter 的 stdout/stderr 持续接走写 ~/.ce/ce.log —— 既 drain pipe(防 Jupyter 被自己日志噎死),
  // 又让控制台 [l] 能看到 Jupyter 输出供排障。
  const { server, stop } = await launchJupyter(osRoot, 30000, (chunk) => {
    try {
      const p = join(homedir(), '.ce', 'ce.log')
      rotateLogIfBig(p) // 写前轮转,防 Jupyter 访问日志撑爆磁盘
      appendFileSync(p, chunk)
    } catch {
      /* 写失败忽略 */
    }
  }, pyBin)
  console.log(`[ce] 已启动 Jupyter:${server.url}`)
  const live = await detectServers() // 启动后再探一次:拿 Jupyter 自己视角的 root_dir(路径规范化)
  const detectedRoot = pickRoot(live, server.url)
  let root: string
  if (detectedRoot !== null) {
    root = detectedRoot
    // 记忆自启的 Jupyter:daemon 重启时 resolveJupyter 开头读它 + 验活复用,不再起新的(终端会话不丢)。
    // 生产红线 W1:只有 port 对上的可靠 root 才落盘;落盘即固化 127.0.0.1(不落 localhost)——
    // isAlive 验活与下次复用全走 v4,消灭 Mac 双栈歧义(配对瞬间 404 竞态入口)。
    try {
      writeFileSync(join(homedir(), '.ce', 'jupyter.json'), JSON.stringify({ url: toLoopback(server.url), token: server.token, root }))
    } catch {
      /* 写失败 → 下次可能再起一个,不致命 */
    }
  } else {
    // 探测没按 port 对上(候选空/对不上)→ root 用启动时传给 Jupyter 的目录(server.root =
    // osRoot 配置根,Windows 取所选盘根 —— by construction 正确,不是猜的)。★ 该 root 不写入
    // jupyter.json(W1):兜底值固化后,后续复用会把对话树与上传树架在未验证的 root 上;
    // 宁可下次重启重探,也不错存。
    root = server.root
    console.warn(`[ce] 启动后探测未按 port 对上 ${server.url}(候选:${live.map((s) => s.url).join('; ') || '空'}),root 用启动目录 ${server.root},且不写入 jupyter.json(防未验证 root 固化)`)
  }
  return { baseUrl: toLoopback(server.url), token: server.token, root, stop }
}

/** 排障日志追加(~/.ce/ce.log,超限轮转)。写失败不致命。 */
function appendCeLog(text: string): void {
  try {
    const p = join(homedir(), '.ce', 'ce.log')
    rotateLogIfBig(p)
    appendFileSync(p, text + '\n')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** claude 候选路径表:PATH 解析到的 + 常见安装位(系统路径 / homebrew / 用户位 ~/.local/bin /
 *  nvm 每版本 bin)。systemd user service 的 PATH 常缺用户位(~/.local/bin / nvm)→ 光靠 PATH 会漏。 */
async function claudeCandidates(): Promise<string[]> {
  if (process.platform === 'win32') {
    // Windows 无 sh;探测时靠 shell:true 经 cmd PATHEXT 解析。固定候选带上 npm 全局位与
    // ~/.local/bin(PATH 缺它们时仍可探到)。
    const home = homedir()
    return ['claude', join(process.env.APPDATA ?? home, 'npm', 'claude.cmd'), join(home, '.local', 'bin', 'claude.exe')]
  }
  const out: string[] = []
  try {
    // command -v 按探测时 PATH 解析(探测用 PATH 已记 ce.log,排障可对照)
    const { stdout } = await pExecFile('sh', ['-c', 'command -v claude 2>/dev/null'])
    const p = stdout.trim().split('\n')[0]
    if (p) out.push(p)
  } catch {
    /* PATH 上无 claude */
  }
  const home = homedir()
  out.push('/usr/local/bin/claude', '/usr/bin/claude', '/opt/homebrew/bin/claude', join(home, '.local', 'bin', 'claude'))
  try {
    // nvm:~/.nvm/versions/node/<ver>/bin/claude;倒序(新版本优先)
    const versions = readdirSync(join(home, '.nvm', 'versions', 'node')).sort().reverse()
    for (const v of versions) out.push(join(home, '.nvm', 'versions', 'node', v, 'bin', 'claude'))
  } catch {
    /* 无 nvm */
  }
  return [...new Set(out)]
}

/** 探测一个能跑的 claude 二进制。机器上可能装多份(系统/nvm/npx),PATH 先解析到的可能是坏的
 *  "native binary not installed"。优先 --claude-bin 参数;否则按候选表逐个跑 --version 验证
 *  (stdout/stderr 合并判:含版本号 + 无 native binary 报错才算可用),用第一个好的。管家/CC 对话用它 spawn。
 *  ★ 不再用 GNU timeout 包裹(macOS 没有、Windows 无 sh;挂起防护交给 pExecFile 自带 timeout)。
 *  ★ 全失败 → 显式返回 null,走 butler_nocc / 提示 —— 绝不裸回 'claude' 假装能用(生产红线 C2,
 *    旧版曾静默假通过)。探测用 PATH + 各候选失败原因记 ~/.ce/ce.log(systemd user service 的
 *    PATH 探不到 ~/.local/bin/nvm,排障要能看到它)。 */
async function resolveClaudeBin(): Promise<string | null> {
  const explicit = arg('claude-bin')
  if (explicit) return explicit
  const isWin = process.platform === 'win32'
  const pathNote = `  PATH=${process.env.PATH ?? '(空)'}`
  appendCeLog(`[ce] claude 探测:PATH\n${pathNote}`)
  const fails: string[] = []
  for (const c of await claudeCandidates()) {
    try {
      // pExecFile 自带 8s timeout 防 npx-stub 触发安装挂起;win 经 shell(cmd)解析,unix 直跑绝对路径。
      const { stdout, stderr } = await pExecFile(c, ['--version'], {
        timeout: 8000,
        ...(isWin ? { shell: true, windowsHide: true } : {}),
      })
      const out = `${stdout}${stderr}`
      if (/\d+\.\d+\.\d+/.test(out) && !/native binary not installed/i.test(out)) {
        console.log(`[ce] 管家用 claude: ${c} (${out.trim().split('\n')[0]})`)
        appendCeLog(`[ce] claude 探测:命中 ${c}`)
        return c
      }
      fails.push(`  ${c}: --version 输出不合规(${out.trim().split('\n')[0] || '(空)'})`)
    } catch (e) {
      fails.push(`  ${c}: ${(e as Error).message}`)
    }
  }
  console.warn('[ce] 未找到能跑的 claude(候选 --version 全失败),管家/CC 对话不可用;装好 claude 后重启 ce,或 --claude-bin=<path> 指定')
  appendCeLog(`[ce] claude 探测:全候选失败(共 ${fails.length})\n${pathNote}\n${fails.join('\n')}`)
  return null
}

/**
 * 写 ~/.ce/cc-settings.json(Claude Code hooks 配置,指向 ce 本地 hook 端点)+ 打印启动指引。
 * ce **不 spawn claude**:CC 由用户在终端里起 —— 这样 CC 可被电脑开 Jupyter Lab 接管(同终端同 CC),
 * 与管家(ce 托管 Agent SDK)区分。ce 只提供 hooks 配置 + 审批/转发管道。
 */
function writeCcSettings(port: number): void {
  const url = `http://127.0.0.1:${port}/hook`
  const cfg = generateHooksConfig({ url })
  try {
    const ceDir = join(homedir(), '.ce')
    mkdirSync(ceDir, { recursive: true })
    writeFileSync(join(ceDir, 'cc-settings.json'), JSON.stringify(cfg, null, 2))
    console.log('[ce] 已生成 CC hooks 配置:~/.ce/cc-settings.json')
    console.log('[ce] 启动 CC 移动审查:在终端里跑  claude --settings ~/.ce/cc-settings.json')
    console.log('[ce]   (PreToolUse 写/执行类 → 手机审批;PostToolUse → 手机审查事件)')
  } catch {
    /* 写失败→忽略(用户可手抄 hooks 配置;审查功能可选,不影响终端/文件/管家) */
  }
}

async function main(): Promise<void> {
  const relayUrl = arg('relay') ?? loadConfig().relay
  if (!relayUrl) {
    console.error('用法:ce --relay=ws://relay.yourserver[:port] [--jupyter=url --jupyter-token=t]')
    console.error('（或先运行一行安装器: curl -fsSL http://<relay>/install.sh | sh）')
    console.error('（Windows: irm http://<relay>/install.ps1 | iex）')
    process.exit(1)
  }

  // 尽早登记 daemon(pid + starting):让控制台立刻发现「daemon 已在启动」并耐心等就绪,
  // 而不是 12s 等不到就绪 daemon.json 就误报失败、还重复 spawn 多个 daemon。
  // (首次 resolveJupyter 要 pip install jupyterlab ~1-2 分钟,远超控制台原 12s 等待。)
  try {
    const ceDir0 = join(homedir(), '.ce')
    mkdirSync(ceDir0, { recursive: true })
    writeFileSync(join(ceDir0, 'daemon.json'), JSON.stringify({ pid: process.pid, port: null, starting: true, version: VERSION, startAt: Date.now() }))
  } catch {
    /* 写失败不阻塞启动 */
  }

  const { baseUrl, token, root, stop } = await resolveJupyter(relayUrl)
  if (stop) {
    // daemon 退出(含崩溃 uncaughtException / process.exit)必杀自启的 Jupyter + 清 daemon.json:
    // 原 only SIGINT 调 stop → 崩溃退出留 Jupyter 孤儿(占端口/内存,越攒越多)。
    const killJupyter = () => { try { stop() } catch { /* 已死 */ } }
    process.on('SIGINT', killJupyter)
    process.on('exit', () => {
      killJupyter() // exit 兜底覆盖所有退出路径
      try { unlinkSync(join(homedir(), '.ce', 'daemon.json')) } catch { /* 清 starting 残留/就绪态 */ }
    })
  }

  // --insecure:容忍自签证书(bun 下 ws 的 rejectUnauthorized 不生效,改设环境变量)
  const insecure = process.argv.includes('--insecure')
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  // 持久身份:cid(机器标识)+ E2E 密钥对(存 ~/.ce/identity.json)。重启复用 →
  // 中继按 cid 复用 sid/token、手机存的 cliPub 长期有效,不必重扫。
  const identity = loadOrCreateIdentity()
  const cliPriv = identity.privateKey
  const cliPubB64 = b64(identity.publicKey)
  const cid = identity.cid

  const jupyter = makeJupyterClient(baseUrl, token, root)
  // 大文件分段上传会话(root 内直接 node:fs 落盘;见 uploads.ts 头注)
  const uploads = new UploadSessions(root)
  const wsBase = baseUrl.replace(/^http/, 'ws')

  let ws: WebSocket | null = null
  // 多手机共连:每台手机一条独立 E2E 通道(phoneId → 派生 sharedKey + 显示名)。
  // 握手按 frame.sourcePhoneId(hub 注入)分通道;加密按 targetPhoneId、解密按 sourcePhoneId 寻路。
  const phoneKeys = new Map<string, { sharedKey: Uint8Array; name: string }>()
  // 握手认证:pin 模式下新手机首次连接须带正确 PIN 才入白名单,已授权 phoneId 重连放行;
  //   --pairing-mode=open 退回旧的「明文 phonePub 即配对」(过渡兼容)。白名单持久 ~/.ce/authorized-phones.json。
  // 2026-09-21:① 内存 Set 与磁盘同步(配对 add/踢出 delete —— 此前只写盘,同进程内新配对手机
  //   一重连(杀 app 重开)就被内存旧名单拒掉,真机"过段时间连不上必须重扫"主根因);
  //   ② PIN 持久 ~/.ce/pin.json(此前每次启动随机 → 白名单意外丢条目即"必须重扫")。
  const pairingMode = (arg('pairing-mode') ?? 'pin') as PairingMode
  const authorized = loadAuthorized()
  let currentPin = pairingMode === 'pin' ? (arg('pin') ?? loadPin() ?? randomPin()) : ''
  if (currentPin) savePin(currentPin) // 显式 --pin 也落盘:下次不带参启动沿用同一枚,手机记住的 PIN 不作废
  // 终端占用:terminalName → owner phoneId。Task 4 的 tryAcquire 接入填充;此处先声明供输出寻路 + phoneLeft 清理。
  const terminalOwner = new Map<string, string>()
  const terms = new Map<string, WebSocket>() // terminalName → 本地 terminado WS(跨重连复用)
  // managed 终端集落盘(~/.ce/managed-terminals.json):terms 是内存态,daemon 重启即空 →
  // listTerminals 全员 managed=false → 手机杀 app 重开不自动恢复(会话管理「清空」观感)。
  // 重启后由它合并标注;终端真没了(Jupyter 列表不含)由 listTerminals 顺手 prune。
  const managedTerms = new ManagedTerms(join(homedir(), '.ce', 'managed-terminals.json'))
  // 终端输出环形缓冲:转发 TermOutput 时旁路 append(与 owner 无关);read_terminal 工具读它(ce 本地,不回程问手机)。
  const buffers = new TermBuffers(500)
  // AI 管家:每台手机一个 cc(stream-json,全 pipe 由 ce spawn),ce 桥接 ButlerStdin/ButlerOutput。
  // claudeBin:探测一个能跑的 claude(候选表 + --version 实测,见 resolveClaudeBin)。可能为 null
  //   (全候选失败)—— 管家/CC 对话此时显式走 nocc/提示路径,不再裸回 'claude' 假装能用。
  const claudeBin = await resolveClaudeBin()
  const butlers = new ButlerManager({
    onOutput: (sid, owner, chunk) => encryptThenSend(FrameType.ButlerOutput, chunk, { sid, targetPhoneId: owner }),
    onExit: (sid, owner, code) => {
      // code -2 = spawn/对话异常(含 ENOENT=claude 没装、ENOEXEC);127 = sh "command not found"。两者 → butler_nocc;其余 = 进程退出。
      const subtype = code === -2 || code === 127 ? 'butler_nocc' : 'butler_exit'
      encryptThenSend(
        FrameType.ButlerOutput,
        enc.encode(JSON.stringify({ type: 'system', subtype, code })),
        { sid, targetPhoneId: owner },
      )
    },
    // 终端工具依赖:list 只列【ce 经手的终端】(= 你 app 里开着的)= terms.keys()。
    //   不用 Jupyter 全量 /api/terminals——那会含机器上没在 app 开的终端,而那些 ce 没中继、读不到也发不了,
    //   列出来反而误导。terms 比 buffers 全:开了但还没喷输出的终端也在 terms 里(缓冲里没有)。
    //   read 走 buffers(输出缓冲),send 写 terminado stdin(复用 TermStdin 同款 ['stdin',text])。
    deps: {
      listTerminals: async () => [...terms.keys()],
      readTerminal: (name, n) => buffers.read(name, n),
      send: async (name, text) => { terms.get(name)?.send(JSON.stringify(['stdin', text])) },
    },
    claudeBin,
  })
  // CC 对话 agent-runner(Agent SDK,「通用口子」):一机一个 cc 会话,跑在 ce 启动目录(= 用户项目)。
  // 与 butler 同源模式但独立(管家是终端监督,CC 对话是项目 coding;两者不共用 proc)。事件走 AgentEvent 帧。
  const agentRunner = new AgentRunner({
    onEvent: (owner, sid, event) =>
      encryptThenSend(FrameType.AgentEvent, enc.encode(JSON.stringify(event)), { sid, targetPhoneId: owner }),
    onExit: (sid, _owner, code) => console.log(`[ce:agent-runner] ${sid} 退出(code=${code})`),
    claudeBin,
    cwd: root, // jupyter root_dir(OS 路径):CC 对话 cwd 的 base,手机传的相对路径相对它拼
  })
  let qrPrinted = false
  let reconnectDelay = 2000

  // ── CC 移动审查楔子(M25 通用审批 + M26 CC hooks 本地接收器)───────────────────────
  // CC 跑在被控机终端里(非 ce 托管),ce 写 hooks 配置指向本地端点:
  //   PreToolUse(写/执行类)→ blocking 等手机审批;PostToolUse(全部)→ 即发事件给手机渲染。
  // 通用(dispatcher / AgentEvent / resolveApproval RPC)= agent 无关;CC 专属(hooks 配置/解析)= cc-hooks.ts。
  /** 广播一条 AgentEvent 给该 ce 上所有已配对手机。
   *  v1 审查楔子:事件/审批请求不定向单机 —— 该 ce 上所有授权手机都可见(多手机任一可审/批,先到先得)。 */
  function broadcastAgentEvent(plaintext: Uint8Array, sid?: string): void {
    for (const [phoneId, info] of phoneKeys) {
      sendFrame({ type: FrameType.AgentEvent, sid, targetPhoneId: phoneId, payload: seal(info.sharedKey, plaintext) })
    }
  }
  const approvals = new ApprovalDispatcher({
    // 审批请求 → 包成 AgentEvent 广播(PreToolUse 事件 = 手机审批卡数据源:tool+input 即够渲染)。
    onPending: (req) =>
      broadcastAgentEvent(
        enc.encode(
          JSON.stringify({ kind: 'PreToolUse', reqId: req.reqId, terminalId: req.terminalId, tool: req.tool, input: req.input }),
        ),
      ),
    // resolved(手机决策 / 超时 / cancelAll)→ 广播通知,手机同步/清卡(多手机下他机卡也清)。
    onResolved: (reqId, resolved) =>
      broadcastAgentEvent(enc.encode(JSON.stringify({ kind: 'approval_resolved', reqId, resolved }))),
    // 55s < CC PreToolUse hook 默认 60s 超时:ce 先于 CC 结掉,手机卡不僵尸、hook 不被 CC 强杀成 block。
    timeoutMs: 55_000,
  })

  /** 重启 daemon:spawn detached 新自己(带原参数)+ 当前进程优雅退出。更新/重启共用。 */
  function restartDaemon(): void {
    const args = process.argv.slice(2)
    if (!args.includes('--daemon')) args.push('--daemon')
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref()
    setTimeout(() => process.kill(process.pid, 'SIGINT'), 50) // 先回 Response 再退
  }

  /** 自更新:比 sha256 → 下载 → 验签 → 替换 binary → 重启。失败不替换(回滚安全)。 */
  async function doUpdate(): Promise<{ ok: boolean; updated?: boolean; error?: string }> {
    if (!relayUrl) return { ok: false, error: '无 relay 配置(无法检查更新)' }
    const httpBase = relayUrl.replace(/^ws/, 'http')
    const binaryName = `ce-${detectPlatform()}${process.platform === 'win32' ? '.exe' : ''}`
    let remoteHash: string | undefined
    try {
      const txt = await (await fetch(`${httpBase}/dl/sha256.txt`)).text()
      remoteHash = txt.split('\n').find((l) => l.includes(binaryName))?.trim().split(/\s+/)[0]
    } catch {
      return { ok: false, error: '取远端 sha256.txt 失败(中继可达?)' }
    }
    if (!remoteHash) return { ok: false, error: `远端清单无 ${binaryName}` }
    const localHash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
    if (localHash === remoteHash) return { ok: true, updated: false }
    const buf = new Uint8Array(await (await fetch(`${httpBase}/dl/${binaryName}`)).arrayBuffer())
    if (createHash('sha256').update(buf).digest('hex') !== remoteHash) {
      return { ok: false, error: '下载内容 sha256 不符(疑似篡改),已中止替换' }
    }
    const target = process.execPath
    const tmp = `${target}.new`
    writeFileSync(tmp, buf)
    chmodSync(tmp, 0o755)
    try {
      renameSync(tmp, target)
    } catch {
      // Windows:运行中 exe 不可直接覆盖 → 先移走旧的
      try { renameSync(target, `${target}.old`) } catch { /* 无旧 */ }
      renameSync(tmp, target)
    }
    restartDaemon()
    return { ok: true, updated: true }
  }

  /** /control/* 控制台 API(只本机 127.0.0.1)。复用 main 闭包状态,零重构。 */
  async function controlRoute(req: Request, url: URL): Promise<Response> {
    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
    const path = url.pathname
    try {
      if (path === '/control/state') {
        // 连接码:daemon 注册中继成功后 printQr 落盘 ~/.ce/connection-code.json;尚未注册则 null(控制台提示稍后再试)
        let connectionCode: string | null = null
        try {
          connectionCode = readFileSync(join(homedir(), '.ce', 'connection-code.json'), 'utf8')
        } catch { /* 文件还没写 */ }
        return json({
          running: true, pid: process.pid, version: VERSION,
          relay: relayUrl, jupyter: baseUrl, pairingMode,
          pin: currentPin,
          phones: [...phoneKeys.entries()].map(([id, v]) => ({ id, name: v.name })),
          paired: loadPaired(), // 带名字+配对时间(控制台白名单页用;此前只是内存 id 集,重启前配对的不显示)
          wsConnected: ws?.readyState === WebSocket.OPEN,
          connectionCode,
        })
      }
      if (path === '/control/stop') {
        setTimeout(() => process.kill(process.pid, 'SIGINT'), 50) // 先回 Response,再优雅退出
        return json({ ok: true })
      }
      if (path === '/control/restart') {
        restartDaemon()
        return json({ ok: true })
      }
      if (path === '/control/update') {
        return json(await doUpdate())
      }
      if (path === '/control/pin' && req.method === 'POST') {
        const { pin } = await req.json() as { pin?: string }
        if (!pin || !/^\d{6}$/.test(pin)) return json({ ok: false, error: 'PIN 须 6 位数字' }, 400)
        currentPin = pin
        savePin(pin) // 2026-09-21:改 PIN 也落盘(此前只在内存,重启即回旧值,用户以为改了)
        return json({ ok: true, pin: currentPin })
      }
      if (path === '/control/unpair' && req.method === 'POST') {
        const { phoneId } = await req.json() as { phoneId?: string }
        if (!phoneId) return json({ ok: false, error: '缺 phoneId' }, 400)
        removeAuthorized(phoneId)
        authorized.delete(phoneId) // 内存同步:此前踢掉的手机在 ce 不重启期间仍能白名单命中重连
        phoneKeys.delete(phoneId)
        return json({ ok: true, paired: loadPaired() })
      }
      if (path === '/control/logs') {
        const n = Number(url.searchParams.get('n') ?? 80)
        try {
          const lines = readFileSync(join(homedir(), '.ce', 'ce.log'), 'utf8').split('\n').slice(-n).join('\n')
          return json({ ok: true, lines })
        } catch {
          return json({ ok: true, lines: '(暂无日志文件)' })
        }
      }
      if (path === '/control/doctor') {
        const servers = await detectServers()
        return json({
          relay: { url: relayUrl, connected: ws?.readyState === WebSocket.OPEN },
          jupyter: servers.length > 0 ? servers[0] : null,
          claude: claudeBin,
          config: loadConfig(),
        })
      }
      return json({ error: 'not found' }, 404)
    } catch (e) {
      return json({ error: (e as Error).message }, 500)
    }
  }

  // CC hooks 本地接收器:Bun.serve 监听空闲端口,curl POST /hook → handleHookBody。
  // listen(0) 让 OS 分配端口(避免固定端口被占),拿到实际端口后写进 hooks 配置;只听 127.0.0.1(hook
  // 命令在本机跑,审批端点绝不应对外暴露)。启动失败不致命:审查功能不可用,终端/文件/管家照常。
  try {
    const hookServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/control/')) return controlRoute(req, url)
        if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
        const raw = await req.text()
        // PreToolUse → approvals.request 阻塞 55s 等手机 → 回 permissionDecision;
        // 其余 → 广播 AgentEvent 即发 → 回空放行。非法 body → 回空(绝不卡 CC)。
        const resp = await handleHookBody(raw, {
          requestApproval: (ev) => approvals.request(undefined, ev.tool ?? 'unknown', ev.input ?? {}),
          emitEvent: (ev) =>
            broadcastAgentEvent(
              enc.encode(
                JSON.stringify({ kind: ev.hook, tool: ev.tool, input: ev.input, sessionId: ev.sessionId, cwd: ev.cwd }),
              ),
            ),
        })
        return new Response(JSON.stringify(resp), { headers: { 'content-type': 'application/json' } })
      },
    })
    const hookPort = hookServer.port
    if (hookPort !== undefined) {
      console.log(`[ce] CC hooks 接收器监听 127.0.0.1:${hookPort}(PreToolUse 审批 / PostToolUse 转发)`)
      writeCcSettings(hookPort)
      // 记 daemon 元信息:控制台据此发现并连上控制端点;退出时清理(避免留 stale 指向)。
      try {
        const ceDir = join(homedir(), '.ce')
        mkdirSync(ceDir, { recursive: true })
        writeFileSync(join(ceDir, 'daemon.json'), JSON.stringify({ port: hookPort, pid: process.pid, starting: false, version: VERSION, startAt: Date.now() }))
      } catch { /* 写失败→控制台发现不了,不致命 */ }
    }
    process.on('SIGINT', () => {
      try { hookServer.stop() } catch { /* 已停 */ }
      try { unlinkSync(join(homedir(), '.ce', 'daemon.json')) } catch { /* 已不在 */ }
    })
  } catch (e) {
    console.warn('[ce] CC hooks 接收器启动失败(审查功能不可用,终端/文件/管家不受影响):', (e as Error).message)
  }

  function sendFrame(f: Frame): void {
    ws?.send(dec.decode(encodeFrame(f)))
  }
  function encryptThenSend(
    type: FrameType,
    plaintext: Uint8Array,
    opts: { sid?: string; reqId?: string; targetPhoneId: string }
  ): void {
    // 多 phone:按 targetPhoneId 取该 phone 的 E2E key 加密;无该 phone(已离开/未配对)→ 不发
    const sk = phoneKeys.get(opts.targetPhoneId)?.sharedKey
    if (!sk) return
    sendFrame({
      type,
      sid: opts.sid,
      reqId: opts.reqId,
      targetPhoneId: opts.targetPhoneId,
      payload: seal(sk, plaintext),
    })
  }

  /** race loser 通知:两手机近乎同时接管同一空闲终端,先到先得裁决后,给落败方(loserPhoneId)
   *  发一条加密 Control{op:'attachDenied'},载 winner 显示名。loser 收到后本地回滚会话 + 提示用户。
   *  用 loser 自己的 sharedKey 加密 + targetPhoneId 路由(中继据此寻路)。 */
  function denyAttach(name: string, loserPhoneId: string, winnerPhoneId: string): void {
    encryptThenSend(
      FrameType.Control,
      enc.encode(
        JSON.stringify({
          op: 'attachDenied',
          name,
          occupiedBy: phoneKeys.get(winnerPhoneId)?.name ?? '?',
        })
      ),
      { targetPhoneId: loserPhoneId }
    )
  }

  // 按 terminal name 懒开/重连 terminado WS(路径无 /api 前缀);输出加密回传。
  // 健壮性:① cached 断开(CLOSING/CLOSED)则重连,不复用死连接;② WS 还在 CONNECTING 时
  // 缓冲 set_size/stdin,open 后补发。否则恢复终端时第一条 resize 落在 CONNECTING 上被
  // "readyState===OPEN" 检查静默丢弃 → bash 收不到 SIGWINCH 不重绘 → 手机卡"正在连接"
  // (直连因 ws.onopen 里 syncSize,连接好了才发,不丢)。
  function ensureTerm(name: string): WebSocket {
    const cached = terms.get(name)
    // OPEN 或 CONNECTING 都复用 —— CONNECTING 必须复用,否则手机 attach 终端时连续几次
    // syncSize/resize 落在 CONNECTING 窗口会各自新开一条 terminado WS,多条 WS 各自把同一份
    // 输出转给手机 → 重复输出 N 次(只有 CLOSING/CLOSED 才重连)。
    if (cached && (cached.readyState === WebSocket.OPEN || cached.readyState === WebSocket.CONNECTING)) return cached
    const tws = new WebSocket(`${wsBase}/terminals/websocket/${name}?token=${token}`)
    const pending: string[] = [] // CONNECTING 期间缓冲,防 set_size/stdin 丢失
    const origSend = tws.send.bind(tws)
    tws.send = ((data: string) => {
      const s = tws.readyState
      if (s === WebSocket.OPEN) origSend(data)
      else if (s === WebSocket.CONNECTING) pending.push(data)
      // CLOSING/CLOSED 丢弃(下次 ensureTerm 会重连)
    }) as typeof tws.send
    tws.on('open', () => {
      for (const d of pending) origSend(d)
      pending.length = 0
    })
    tws.on('message', (data) => {
      try {
        const msg = JSON.parse(dec.decode(data as Uint8Array))
        if (!Array.isArray(msg)) return
        const [etype, content] = msg
        if ((etype === 'stdout' || etype === 'stderr') && typeof content === 'string') {
          // stderr 包红码,对齐直连(terminalConnection 把 stderr 渲染红)
          const out = etype === 'stderr' ? `\x1b[1;31m${content}\x1b[0m` : content
          buffers.append(name, Buffer.from(out)) // 旁路缓存:read_terminal 读尾部≈当前帧(与 owner 无关,无条件存)
          // 输出只发给 owner(Task 4 的 tryAcquire 在 attach 时标 owner);无 owner → 不发(避免泄露给非占用者)
          const owner = terminalOwner.get(name)
          if (owner) {
            encryptThenSend(FrameType.TermOutput, enc.encode(out), { sid: name, targetPhoneId: owner })
          }
        }
      } catch {
        /* setup/exit/控制帧忽略 */
      }
    })
    tws.on('close', () => {
      // 手机关终端 / 进程退出 → terminado WS 断 → 释放占用,别人可重新接管。
      // 守卫:仅当关闭的仍是 terms 当前登记的本条 WS 才释放 —— ensureTerm 重连时,
      // 旧 WS 的延迟 close 不应误清刚由新 WS 的 attach 设上的新 owner。
      if (terms.get(name) === tws) terminalOwner.delete(name)
    })
    tws.on('error', (e) => {
      // 终端 ws 连接失败(Jupyter 里没这个终端名 → upgrade 404;或 Jupyter 重启)必须兜底:
      // ws 'error' 无 listener 会抛 uncaughtException → 拖崩整个 daemon → 重启换 Jupyter →
      // 旧终端名全失效 → 手机再连又 404 → 再崩,死循环(daemon 反复重启的根因)。
      console.error(`[ce] 终端 ws 错误 ${name}:`, (e as Error).message)
      if (terms.get(name) === tws) terms.delete(name)
    })
    terms.set(name, tws)
    managedTerms.add(name) // ce 经手过 → managed(重启后仍能被手机自动恢复)
    return tws
  }

  function printQr(sid: string, relayToken: string): void {
    const qrPayload = JSON.stringify({
      r: relayUrl,
      s: sid,
      k: cliPubB64,
      t: relayToken,
      n: hostname(),
      p: process.platform,
    })
    // 落盘连接码:install.ps1 检测到 ce 已在跑时读此文件复用打印(不必重启 ce)
    try {
      const ceDir = join(homedir(), '.ce')
      mkdirSync(ceDir, { recursive: true })
      writeFileSync(join(ceDir, 'connection-code.json'), qrPayload)
    } catch {
      /* 写失败→忽略(install.ps1 退化为提示原窗口) */
    }
    // 半块字符紧凑渲染(抽到 qr.ts:2 module 行合并 1 行、1 字符/module;控制台 [c] 也复用同一渲染)
    try {
      console.log('\n' + renderQr(qrPayload))
      console.log('用 App 扫码连接(或下方连接码粘码)')
    } catch {
      /* 渲染失败→只给连接码 */
    }
    console.log('连接码(手动粘贴): ' + qrPayload + '\n')
    if (pairingMode === 'pin') console.log(`[ce] 配对 PIN(新手机首次连接在 App 输入): ${currentPin}\n`)
  }

  // 在已注册的 ws 上接主消息循环(握手 + rpc + stdin + resize)。
  // pending:'registered' 之前到达的帧(中继 register 时立刻补发的 cliBuffer —— 旧版中继会先于
  // 'registered' 发出,曾被 connect() 的临时处理器静默丢弃 = 掉线后探活全失败的根因)。
  // 现临时处理器把它们缓冲到此处,挂好正式处理器后按序补处理(双端容错:无论中继补发早晚都不丢)。
  function wireBridge(curWs: WebSocket, pending: RawData[] = []): void {
    const onMessage = async (raw: RawData): Promise<void> => {
      let frame: Frame
      try {
        frame = decodeFrame(raw as Uint8Array)
      } catch {
        // 非 Frame 帧:可能是 hub 的明文控制通知 phoneLeft(hub 生成、非加密帧,缺 payload
        // 致 decodeFrame 抛错)。识别后清该 phone 的 E2E 通道 + 其占用终端(Task 4 terminalOwner)。
        try {
          const notice = JSON.parse(dec.decode(raw as Uint8Array)) as { type?: string; phoneId?: string }
          if (notice.type === 'phoneLeft' && notice.phoneId) {
            // 【保留 phoneKeys(sharedKey)】:让 ce 在手机离线期间仍能加密推 AgentEvent 帧 → 中继 per-phone
            //   缓冲 → 手机重连补发(治「锁屏丢回复」)。sharedKey 配对时建立、持久,重连复用同一把,保留无安全风险
            //   (中继零信任只转密文、不解密)。重连握手时 phoneKeys 被同 key 覆盖,无残留。
            for (const [tname, owner] of terminalOwner) {
              if (owner === notice.phoneId) terminalOwner.delete(tname) // 终端占用随连接重置
            }
            // 【不杀管家/agent】。手机瞬时断连(后台/切应用致 WS 冻结重连)极常见,此时杀进程会让重连后接到
            //   已死 sid → 发消息无响应。留活,重连后续接同一会话。「移除服务器不回来」→ 6h 回收计时兜底(重连取消)。
            butlers.markPhoneLeft(notice.phoneId)
            agentRunner.markPhoneLeft(notice.phoneId)
            console.log(`[ce] 手机离开 phoneId=${notice.phoneId},终端占用已清(管家/agent 留活,sharedKey 保留供中继缓冲补发,6h 不归则回收)`)
          }
        } catch {
          /* 真正的非法帧 → 忽略 */
        }
        return
      }

      // 多 phone:按 frame.sourcePhoneId(hub 注入)查该 phone 的 E2E 通道。
      const srcPhone = frame.sourcePhoneId
      const knownKey = srcPhone ? phoneKeys.get(srcPhone)?.sharedKey : undefined

      // Control 帧:可能是握手 phonePub(明文,手机每次连入/重连都发)或 resize(密文)。
      // 多 phone 下:已配对的 phone 发的 resize 用其 key 解密;未配对/解密失败 → 当握手。
      // 手机每次重连用新公钥 → 必须每次 phonePub 重新派生 sharedKey 并 set 进 phoneKeys
      // (按 phoneId 分通道,不覆盖其它 phone —— 这是「多 E2E」与旧单 sharedKey 的核心区别)。
      if (frame.type === FrameType.Control) {
        if (knownKey && srcPhone) {
          // 先按密文解密(resize 等控制帧是密文)
          try {
            const decrypted = open(knownKey, frame.payload)
            const msg = JSON.parse(dec.decode(decrypted)) as {
              op?: string
              rows?: number
              cols?: number
            }
            if (
              msg.op === 'resize' &&
              frame.sid &&
              typeof msg.rows === 'number' &&
              typeof msg.cols === 'number'
            ) {
              // 占用校验:attach(=首条 resize)时按先到先得裁决;别人已占 → 不 ensureTerm,
              // 并给 loser 发 attachDenied(race 反馈:loser 此前已本地建会话,需回滚 + 提示)。
              const acq = tryAcquire(terminalOwner, frame.sid, srcPhone)
              if (acq.ok) {
                const tws = ensureTerm(frame.sid)
                tws.send(JSON.stringify(['set_size', msg.rows, msg.cols])) // ensureTerm 自缓冲(CONNECTING 时)
              } else {
                denyAttach(frame.sid, srcPhone, acq.occupiedBy)
              }
            }
            return
          } catch {
            /* 解密失败 → 落到下面当握手 phonePub 处理 */
          }
        }
        // 当作握手 phonePub(明文):{ k, n?, pin? } 或兼容老格式(纯 b64 公钥,无 pin)
        try {
          const text = dec.decode(frame.payload).trim()
          let phonePubB64 = ''
          let name = ''
          let framePin: string | undefined
          if (text.startsWith('{')) {
            const obj = JSON.parse(text) as { k?: string; n?: string; pin?: string }
            if (!obj.k || typeof obj.k !== 'string') throw new Error('handshake json missing k')
            phonePubB64 = obj.k
            name = obj.n ?? ''
            framePin = obj.pin
          } else {
            phonePubB64 = text // 老格式:纯 b64 公钥
          }
          const phoneId = srcPhone ?? `anon-${randId(8)}`
          // 认证门禁:open 模式直放;pin 模式下白名单内 phoneId 放行,否则需正确 PIN 首次配对。
          const auth = authorize({ mode: pairingMode, phoneId, authorized, pin: framePin, currentPin })
          if (!auth.allow) {
            // 拒绝必回因(2026-09-21:此前静默丢帧,手机只能 15s 超时、无从分辨)。
            // 明文:握手未成无共享密钥;载荷只有粗粒度原因,不含任何秘密。旧手机端不识
            // PairReject 编号 → 安全降级为原超时行为。
            console.log(`[ce] 拒绝配对 phoneId=${phoneId}(${auth.denyReason})`)
            if (srcPhone) {
              sendFrame({
                type: FrameType.PairReject,
                targetPhoneId: srcPhone,
                payload: enc.encode(JSON.stringify({ reason: auth.denyReason })),
              })
            }
            return
          }
          if (auth.pair) {
            addAuthorized(phoneId, name)
            authorized.add(phoneId) // 内存同步:同进程内该手机断线重连(杀 app 重开)白名单直接命中
          } else if (name) {
            // 白名单命中也刷新名字(手机端改名由此传播到落盘)
            addAuthorized(phoneId, name)
          }
          const sharedKey = sharedSecret(cliPriv, unb64(phonePubB64))
          phoneKeys.set(phoneId, { sharedKey, name })
          butlers.markPhoneBack(phoneId) // 手机(重)连 → 取消其孤儿回收计时(管家续用、保留上下文)
          agentRunner.markPhoneBack(phoneId)
          // 审批卡断线加固(甲方案):手机重连 → 把该 phone 的 pending approval-request 经
          //   agentEvents 流补发(手机 tunnel 晚订阅缓冲兜底 race + 插件 reducer 幂等去重)。
          agentRunner.replayPendingApprovals(phoneId)
          console.log(`[ce] 手机配对 phoneId=${phoneId}${name ? ` name=${name}` : ''}${auth.pair ? '(新配对)' : '(白名单)'},E2E 通道建立`)
        } catch {
          /* 非法帧 */
        }
        return
      }

      // RPCReq / TermStdin:必须已握手 + 密文。按 frame.sourcePhoneId 查该 phone 的 E2E key 解密;
      // 查不到(未配对 / 老 hub 未注入 sourcePhoneId)→ 丢弃。knownKey 存在 ⇒ srcPhone 必非空。
      if (!knownKey || !srcPhone) return
      let plaintext: Uint8Array
      try {
        plaintext = open(knownKey, frame.payload)
      } catch {
        return // 解密失败(篡改/错 key)→ 丢弃
      }

      switch (frame.type) {
        case FrameType.RPCReq: {
          const req = JSON.parse(dec.decode(plaintext)) as RpcRequest
          let resp: RpcResponse
          // butlerStart 的合成 init 要排在 RPCResp 之【后】发(见 butlerStart 分支注释),此处先占位。
          let postRespInit: { sid: string } | null = null
          if (req.op === 'listTerminals') {
            // 转发 GET /api/terminals 拿「Jupyter 上所有终端」+ 用 ce 的 terms map 标 managed。
            // 手机「+」面板显示全部;杀 app 重开自动恢复只挑 managed(= ce 经手过的),零回归。
            let all: { name: string; last_activity?: string }[] = []
            try {
              all = await listTerminalsRetry(jupyter) // 首错 300ms×1 重试:治配对瞬间瞬态 404
            } catch (e) {
              // 重试后仍失败(Jupyter token 失效(403)/卡死/重启中):别让 listTerminals 抛成
              // unhandledRejection 拖累。退化为空列表(手机暂时看不到终端,但不崩;恢复后下次刷新补全量)。
              console.error('[ce] 列终端失败(重试后仍失败),退化为空列表:', (e as Error).message)
            }
            // managed = terms(本次生命周期经手)∪ 落盘集合(上次生命周期经手;daemon 重启后
            // terms 空但终端仍活在 Jupyter,靠它让手机杀 app 重开还能自动恢复会话)。
            const managedSet = new Set(terms.keys())
            for (const n of managedTerms.values()) managedSet.add(n)
            // 顺手清理落盘集合:Jupyter 列表已不含的终端名摘掉(终端真没了,防文件无限膨胀)。
            // 列表获取失败(all 空)不 prune —— 空列表≠终端全死,误清会丢用户会话。
            if (all.length > 0) managedTerms.prune(all.map((t) => t.name))
            // 每条加 occupiedBy(占用者显示名;null=空闲)—— 手机「+」面板据此灰显别人在用的
            const terminals = toRemoteTerminals(all, managedSet).map((t) => ({
              ...t,
              occupiedBy: terminalOwner.has(t.name)
                ? (phoneKeys.get(terminalOwner.get(t.name)!)?.name ?? null)
                : null,
            }))
            // CC 对话 agent 会话(cc-*)不是 Jupyter 终端 → 补进列表让手机恢复(标 managed=true,
            //   occupiedBy=null;手机按持久化的 per-sid type:'cc' 套用,渲染走对话组件而非 xterm)。
            //   按 owner 过滤(只返本机 cc,防他机串入)+ 补 cwd(手机 restore 不再硬编码 '/')。
            for (const a of agentRunner.forPhone(srcPhone)) {
              if (!terminals.some((t) => t.name === a.sid)) {
                terminals.push({ name: a.sid, lastActivityAt: Date.now(), managed: true, occupiedBy: null, cwd: a.cwd })
              }
            }
            resp = { ok: true, data: { terminals } }
          } else if (req.op === 'deleteTerminal' && (req as { name?: string }).name) {
            // 手机「关闭终端」:关 ce 端 terminado + Jupyter DELETE,否则杀 app 重开又恢复回来
            const termName = (req as { name?: string }).name!
            if (termName.startsWith('cc-')) {
              // CC 对话 agent 会话:停 agent-runner(非 Jupyter 终端,无 terminado/DELETE)
              agentRunner.stop(termName)
              resp = { ok: true }
            } else {
              const tws = terms.get(termName)
              if (tws) {
                try {
                  tws.close()
                } catch {
                  /* 已关 */
                }
                terms.delete(termName)
              }
              terminalOwner.delete(termName) // 释放占用(终端已删,owner 无意义)
              managedTerms.remove(termName) // 硬删 → 不再 managed(杀 app 重开不恢复)
              try {
                await fetch(`${baseUrl}/api/terminals/${encodeURIComponent(termName)}`, {
                  method: 'DELETE',
                  headers: { Authorization: `Token ${token}` },
                })
              } catch {
                /* 尽力删,失败不阻塞(至多留服务端孤儿终端) */
              }
              resp = { ok: true }
            }
          } else if (req.op === 'detachTerminal' && (req as { name?: string }).name) {
            // 手机「移除」(软):只关 ce 端 terminado WS、不 Jupyter DELETE。
            // → terms map 移除该 name → 下次 listTerminals managed=false → 杀 app 重开不自动恢复;
            //   Jupyter 终端仍在(GET /api/terminals 仍返回)→「+」面板可见、可重新接管。
            const termName = (req as { name?: string }).name!
            if (termName.startsWith('cc-')) {
              agentRunner.stop(termName) // CC agent 软移除 = 停(无「Jupyter 终端保留」语义)
              resp = { ok: true }
            } else {
              const tws = terms.get(termName)
              if (tws) {
                try {
                  tws.close()
                } catch {
                  /* 已关 */
                }
                terms.delete(termName)
              }
              terminalOwner.delete(termName) // 软移除也释放占用:别人可从「+」面板重新接管
              managedTerms.remove(termName) // 软移除 = 用户显式不要 → 不再 managed(同硬删语义)
              resp = { ok: true }
            }
          } else if (req.op === 'createTerminal') {
            const termType = (req as { type?: string }).type
            if (termType === 'cc' || termType === 'workshop') {
              // CC 对话 / 插件工坊:起 ce 端 Agent SDK runner(不开 Jupyter 终端、不 parse TUI)。一机可多开
              // (各目录独立),每次 createTerminal 新建一个 agent(不复用)。返 sid(形如 cc-xxxx)作「终端名」——
              // 手机据它路由 stdin(TermStdin cc- 分支)+ demux agentEvents(帧带 sid)+ 渲染对话组件。
              // workshop 与 cc 同一个 generic runner,只是手机侧 cwd 传工坊仓路径(技能随项目级 .claude/skills
              // 自动加载)、首条发言由工坊插件自己组织(分档/资源评估提示词在手机侧插件里,ce 保持哑管道)。
              const sid = agentRunner.start(srcPhone, (req as { cwd?: string }).cwd)
              console.log(`[ce] createTerminal(${termType}) → agentRunner sid=${sid} (phone=${srcPhone})`)
              resp = { ok: true, data: { name: sid } }
            } else {
              // 普通终端:Jupyter 分配的新 name 必空闲 → 创建者即 owner(先到先得天然满足)。
              // 成功后【不】在此 eager 开 terminado WS(懒开:等手机首条 resize/stdin 才开,对齐直连,
              // 治「晚到 resize 致 Windows 第一个命令错位」——详见 git 历史)。
              resp = await handleRpc(jupyter, req)
              if (
                resp.ok &&
                resp.data &&
                typeof (resp.data as { name?: string }).name === 'string'
              ) {
                terminalOwner.set((resp.data as { name: string }).name, srcPhone)
                managedTerms.add((resp.data as { name: string }).name) // 新建即经手 → managed
              }
            }
          } else if (req.op === 'butlerStart') {
            // AI 管家:ce 用 SDK query 起 cc,回 butlerSid;手机据此收发 ButlerStdin/ButlerOutput。skill 由手机传。
            // 一机一管家:同手机已有活管家 → 复用 sid(手机重连/重开接回带历史上下文的 cc;phoneLeft 不杀管家)。
            const bSid = butlers.sidForPhone(srcPhone) ?? butlers.start(req.skill ?? '', srcPhone)
            resp = { ok: true, data: { sid: bSid } }
            // 合成 system/init:【复用路径必须发】——cc 每会话只发一次 init、重连时已发过不会重发,
            //   手机新会话收不到 init 会 40s 超时(杀 app 重进 / 休眠重连正是此路径)。
            // ★ 必须排在 RPCResp 之【后】发:手机在 `await tunnel.rpc(butlerStart)` resolve 之后才注册
            //   onButlerOutput 订阅(useButler.open);init 排在 RPCResp 前 → 到达时订阅还没注册 → 被丢
            //   → 复用路径照样 40s 超时(63d7edd 加的合成 init 因此一度无效)。排在 RPCResp 后:手机先
            //   resolve(微任务里设 butlerSid + 注册订阅),再收 init → 接住、清 connect 计时器转 ready。
            //   RPCResp 与 init 是两条独立 WS 帧 = 两个 message 事件,JS 事件循环在两 macrotask 间排空
            //   微任务(rpc 的 await 续体),故「订阅先于 init」时序可靠(Chromium WebView 遵 spec)。
            postRespInit = { sid: bSid }
          } else if (req.op === 'butlerStop' && req.sid) {
            butlers.stop(req.sid)
            resp = { ok: true }
          } else if (req.op === 'resolveApproval' && (req as { reqId?: string }).reqId) {
            // 手机人审回传。先查 agent-runner 的 pending(CC 对话 SDK 审批,带 callId);未命中再走旧
            // cc-hooks dispatcher(终端 CC hooks 审批)。两路都未命中也回 ok(幂等:超时迟到 / 他机先解)。
            const reqId = (req as { reqId?: string }).reqId!
            const allow = (req as { decision?: 'allow' | 'deny' }).decision === 'allow'
            const hit = agentRunner.resolveApproval(reqId, allow) || approvals.resolve(reqId, allow ? 'allow' : 'deny')
            resp = { ok: true, data: { resolved: hit } }
          } else if (req.op === 'exec') {
            // 通用 exec(被控机跑一条命令,无 shell、捕 stdout/stderr/exitCode)。
            // 无 shell(execFile)→ args 无法链式起别的程序,手机侧程序名白名单是唯一闸门。
            // ENOENT(命令不存在)→ exitCode 127,让手机判「未安装」(而非 RPC 失败)。
            const parseArgs = (s: string): string[] => {
              const out: string[] = []
              const re = /"([^"]*)"|'([^']*)'|(\S+)/g
              let m: RegExpExecArray | null
              while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
              return out
            }
            const command = (req as { command?: string }).command ?? ''
            const cwd = (req as { cwd?: string }).cwd
            const tokens = parseArgs(command)
            if (tokens.length === 0) {
              resp = { ok: false, error: 'exec: 空命令' }
            } else {
              resp = await new Promise<{ ok: true; data: { stdout: string; stderr: string; exitCode: number } }>(
                (resolve) => {
                  execFile(
                    tokens[0],
                    tokens.slice(1),
                    { cwd: cwd || undefined, timeout: 15000, maxBuffer: 1 << 20 },
                    (err, stdout, stderr) => {
                      if (err) {
                        const e = err as NodeJS.ErrnoException
                        const exitCode = e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1
                        resolve({
                          ok: true,
                          data: {
                            stdout: '',
                            stderr: (stderr ? String(stderr) + '\n' : '') + String(e.message),
                            exitCode,
                          },
                        })
                      } else {
                        resolve({ ok: true, data: { stdout: String(stdout), stderr: String(stderr), exitCode: 0 } })
                      }
                    },
                  )
                },
              )
            }
          } else if (
            req.op === 'uploadBegin' ||
            req.op === 'uploadChunk' ||
            req.op === 'uploadEnd' ||
            req.op === 'uploadAbort'
          ) {
            // 大文件分段上传:ce 直接 node:fs 落盘(root 内),不走 Jupyter REST —— 整文件 PUT
            // 有 15s 超时 + 大 buffer 内存语义(会重蹈 readFile OOM)。见 uploads.ts / spec.md §5。
            resp = await uploads.handleRpc(req)
          } else {
            resp = await handleRpc(jupyter, req)
          }
          // RPCResp 按发起方 phoneId 定向加密(谁问的回谁;srcPhone 来自 frame.sourcePhoneId,
          // 上方 !knownKey||!srcPhone 守卫保证非空)
          encryptThenSend(FrameType.RPCResp, enc.encode(JSON.stringify(resp)), {
            reqId: frame.reqId,
            targetPhoneId: srcPhone,
          })
          // butlerStart 的合成 init:必须在 RPCResp 之【后】发(见 butlerStart 分支注释)。
          if (postRespInit) {
            encryptThenSend(
              FrameType.ButlerOutput,
              enc.encode(JSON.stringify({ type: 'system', subtype: 'init' })),
              { sid: postRespInit.sid, targetPhoneId: srcPhone },
            )
          }
          break
        }
        case FrameType.TermStdin: {
          const name = frame.sid
          if (!name) break
          const text = dec.decode(plaintext)
          if (name.startsWith('cc-')) {
            // CC 对话 stdin → agent-runner InputQueue(首条触发 SDK query boot)。
            // 剥手机为终端 exec 自动 append 的 \r(cc 是自然语言消息,非终端命令,不要 \r)。
            const ccText = text.replace(/\r+$/, '')
            console.log(`[ce] TermStdin(cc) sid=${name} len=${ccText.length} → agentRunner`)
            agentRunner.writeStdin(name, ccText)
            break
          }
          // 占用校验:懒开 WS 时按先到先得裁决;别人占用的终端其 stdin 不转发,并给 loser 发
          // attachDenied(race 反馈:loser 可能已本地建会话,需回滚 + 提示)。
          const acq = tryAcquire(terminalOwner, name, srcPhone)
          if (!acq.ok) {
            denyAttach(name, srcPhone, acq.occupiedBy)
            break
          }
          const tws = ensureTerm(name)
          tws.send(JSON.stringify(['stdin', text])) // ensureTerm 自缓冲(CONNECTING 时)
          break
        }
        case FrameType.ButlerStdin: {
          // 管家 ButlerStdin 两种 payload:① 审批响应 {type:'butler_approval_response',reqId,allow}
          //   → 解 canUseTool 的 pending;② 用户发言帧(SDKUserMessage)→ writeStdin 入对话队列。
          if (!frame.sid) break
          let p: { type?: string; reqId?: string; allow?: boolean } | null = null
          try { p = JSON.parse(dec.decode(plaintext)) as { type?: string; reqId?: string; allow?: boolean } } catch { p = null }
          if (p?.type === 'butler_approval_response' && p.reqId) butlers.resolveApproval(frame.sid, p.reqId, p.allow !== false)
          else butlers.writeStdin(frame.sid, plaintext)
          break
        }
        default:
          break
      }
    }
    // 先按序补处理 'registered' 前到达的帧,再挂正式处理器(此后走实时路径)。
    for (const r of pending) void onMessage(r)
    curWs.on('message', onMessage)
  }

  // 连中继(带 cid)→ 注册 → 打 qr(首次)→ 接桥接;断开则指数退避重连。
  function connect(): void {
    ws = new WebSocket(`${relayUrl}/?cid=${cid}`)
    // 'registered' 之前到达的帧(旧版中继 register 即刻补发 cliBuffer)不丢:缓冲给 wireBridge
    // 按序补处理 —— 手机掉线期间的重握手/探活帧就靠它,丢了则 phoneKeys 空 → 探活必超时。
    const preRegistered: RawData[] = []
    // 协议层心跳:30s ping × 2 次无 pong → terminate → 下方 close 处理器接管重连。
    // 治 half-open(热点断换/NAT 超时:TCP 死但 close 不来,永不重连)。
    let hb: Heartbeat | null = new Heartbeat(ws)
    ws.on('message', function h(raw) {
      try {
        const m = JSON.parse(dec.decode(raw as Uint8Array))
        if (m.type === 'registered') {
          ws?.off('message', h)
          reconnectDelay = 2000 // 连上即重置退避
          const sid: string = m.sid
          const relayToken: string = m.token
          console.log(`[ce] 已连中继,sid=${sid}`)
          if (!qrPrinted) {
            qrPrinted = true
            printQr(sid, relayToken) // sid/cliPub 持久 → 二维码不变,只首次打
          }
          wireBridge(ws as WebSocket, preRegistered)
        } else if (m.type === 'error') {
          console.error('[ce] 中继注册失败:', m.reason)
        } else if (typeof m.type === 'number') {
          // 隧道帧先于 'registered' 到达(中继补发 cliBuffer):缓冲,wireBridge 按序补处理。
          preRegistered.push(raw)
        }
      } catch {
        /* 非 JSON 帧(理论上 registered 前不会有)→ 丢弃 */
      }
    })
    ws.on('close', () => {
      hb?.stop() // 心跳随连接结束;hb 置 null 防重连前旧定时器误触发 terminate
      hb = null
      console.log(`[ce] 中继断开,${reconnectDelay}ms 后重连`)
      phoneKeys.clear() // 中继断了:所有 phone 通道失效,重连后手机重新握手派生
      terminalOwner.clear() // 占用随连接重置(手机重连后重新 attach/tryAcquire)
      approvals.cancelAll('deny') // 挂起的 hook 审批全拒:手机此刻不可达,deny 让 CC 早结(不干等 55s 超时)
      // 【不杀管家】(同 phoneLeft 理由:管家是 ce 侧长驻进程)。中继重连后手机也重连,管家按 owner 续接;
      //   ce 若整体重启则进程死、管家自然没了,手机端会超时→重开 respawn(useButler.open 见 dead 即重建)。
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    })
    ws.on('error', (e) => console.error('[ce] 中继错误:', (e as Error).message))
  }

  connect()
}

// 入口分叉:--daemon 跑守护进程(main);否则跑控制台 TUI(console.ts)。
// daemon 加全局错误兜底:小意外记日志不退,严重错误退出(由控制台/系统拉起)+清 stale daemon.json。
if (process.argv.includes('--daemon')) {
  // 单例锁:占固定端口。listen 成功 = 唯一 daemon;EADDRINUSE = 端口被占,需区分是谁占的。
  //   - daemon.json 里 pid 还活 = 另一个 ce daemon 在跑 → 静默退出(真单例);
  //   - pid 死 / 无 daemon.json = 48731 被别的程序占(假阳性)→ 警告并继续(放弃端口锁,单例降级),
  //     别让被控机用户面对「ce 起不来且无提示」的死锁(编译版端口号改不了)。
  const startMain = () => {
    process.on('unhandledRejection', (r) => console.error('[ce] ⚠ unhandledRejection(已兜底,不退出):', r))
    process.on('uncaughtException', (e) => {
      console.error('[ce] ✗ uncaughtException(将退出,由控制台/系统拉起):', e)
      try { unlinkSync(join(homedir(), '.ce', 'daemon.json')) } catch { /* */ }
      process.exit(1)
    })
    main().catch((e) => {
      console.error('[ce] 启动失败:', (e as Error).message)
      process.exit(1)
    })
  }
  const lock = createServer()
  lock.once('error', () => {
    // 端口被占:判活已有 daemon?读 daemon.json 的 pid 验活。
    let daemonRunning = false
    try {
      const d = JSON.parse(readFileSync(join(homedir(), '.ce', 'daemon.json'), 'utf8')) as { pid?: number }
      if (d.pid) { try { process.kill(d.pid, 0); daemonRunning = true } catch { /* pid 不活 */ } }
    } catch { /* 无 daemon.json */ }
    if (daemonRunning) {
      console.log('[ce] 已有 daemon 在跑,本进程退出')
      process.exit(0)
    }
    console.warn('[ce] ⚠ 单例锁端口 48731 被其他程序占用(非 ce daemon),放弃端口锁继续运行')
    startMain()
  })
  lock.listen(LOCK_PORT, '127.0.0.1', startMain)
} else {
  runConsole().catch((e) => {
    console.error('[ce] 控制台错误:', (e as Error).message)
    process.exit(1)
  })
}
