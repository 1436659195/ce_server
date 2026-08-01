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
import WebSocket from 'ws'
import qrcode from 'qrcode'
import { hostname, homedir } from 'node:os'
import { writeFileSync, mkdirSync, unlinkSync, readFileSync, chmodSync, renameSync } from 'node:fs'
import { join, parse as parsePath } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { sharedSecret, seal, open } from '../shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../shared/frame'
import { detectServers } from './jupyter-detect'
import { launchJupyter } from './jupyter-launch'
import { makeJupyterClient, handleRpc, toRemoteTerminals, type RpcRequest, type RpcResponse } from './bridge'
import { ButlerManager } from './butler'
import { AgentRunner } from './agent-runner'
import { ApprovalDispatcher } from './approval'
import { generateHooksConfig, handleHookBody } from './cc-hooks'
import { TermBuffers } from './term-buffers'
import { loadOrCreateIdentity } from './identity'
import { tryAcquire } from './ownership'
import { loadAuthorized, addAuthorized, removeAuthorized, authorize, type PairingMode } from './pairing'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { loadConfig } from './config'
import { ensureJupyter, type JupyterInstallDeps } from './jupyter-install'
import { runConsole } from './console'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** ce 版本(build 时 --define CE_VERSION 注入;dev 直跑为 'dev')。控制台「查版本」用。 */
declare const CE_VERSION: string | undefined
// 兜底两道:未注入(undefined)→ dev;注入了但异常短(<=1 字符,如曾经的 "v")→ 也回退 dev。
const VERSION = typeof CE_VERSION !== 'undefined' && CE_VERSION.length > 1 ? CE_VERSION : 'dev'

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

/** ensureJupyter 的真实副作用实现:spawn python/pip、stdin y/n。 */
function realJupyterDeps(): JupyterInstallDeps {
  return {
    // 走 `python -m pip show jupyterlab`(而非 `jupyter --version`):Bun --compile 的 Windows 二进制
    // spawn 不了 jupyter.exe,但 spawn python.exe 正常(见 launchJupyter 注释)。pip show 退码 0=已装。
    hasJupyter: async () => {
      try {
        await pExecFile('python', ['-m', 'pip', 'show', 'jupyterlab'], { shell: true })
        return true
      } catch {
        return false
      }
    },
    prompt: (msg) => askYesNo(msg),
    install: async () => {
      console.log('[ce] pip install jupyterlab(清华源,约 1-2 分钟,请等待)...')
      await new Promise<void>((resolve, reject) => {
        // `python -m pip`(而非裸 `pip`):python 已确认在 PATH 上(ensurePythonOrExit),更稳。
        // -i 清华 PyPI 源加速(默认源国内慢);--trusted-host 防 SSL 拦截(公司代理/旧证书)
        const p = spawn(
          'python',
          ['-m', 'pip', 'install', 'jupyterlab', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--trusted-host', 'pypi.tuna.tsinghua.edu.cn'],
          { shell: true, stdio: 'inherit' }
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
 */
async function ensurePythonOrExit(relayUrl: string): Promise<void> {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'python' : 'python3'
  let hasPython = true
  try {
    await pExecFile(cmd, ['--version'], { shell: true })
  } catch {
    hasPython = false
  }
  if (hasPython) return

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

/** baseUrl 里 `localhost` → `127.0.0.1`:Bun 偶把 localhost 解析成 IPv6 `::1`,而 Jupyter 默认只听
 *  IPv4 loopback → fetch 报 "Unable to connect"。127.0.0.1 无歧义、Jupyter 一定在听(它打的 URL 含 127.0.0.1)。 */
function toLoopback(url: string): string {
  return url.replace(/:\/\/localhost\b/, '://127.0.0.1')
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
 *  按 port 匹配同机唯一 jupyter;无 port 或不匹配 → 取第一个;空 → fallback process.cwd()。 */
function pickRoot(servers: { url: string; root: string }[], url: string): string {
  const port = portOf(url)
  const byPort = port ? servers.find((s) => portOf(s.url) === port) : undefined
  return (byPort ?? servers[0])?.root ?? process.cwd()
}

/** 解析 Jupyter:显式 > 探测(只复用 root 在根目录的)> 引导装 > 启动。
 *  ce 的 jupyter 永远服务【宿主机根目录】(手机文件栏从根浏览整个文件系统)。
 *  探测到的 jupyter 若 root 正好在根目录 → 复用;否则(无 / root 不在根目录,如本机 screen 开的 /data)→ 自启根目录的。
 *  返回 root(jupyter root_dir OS 路径,CC 对话 cwd 的 base)。 */
async function resolveJupyter(
  relayUrl: string
): Promise<{ baseUrl: string; token: string; root: string; stop?: () => void }> {
  const explicitUrl = arg('jupyter')
  const explicitToken = arg('jupyter-token')
  if (explicitUrl && explicitToken) {
    // 显式 url/token 最优先(用户明确指定外部 jupyter);root 从探测结果取(API 不暴露 root_dir)。
    const existing = await detectServers()
    return { baseUrl: toLoopback(explicitUrl), token: explicitToken, root: pickRoot(existing, explicitUrl) }
  }
  const osRoot = parsePath(process.cwd()).root // Linux/Mac '/',Windows 当前盘根 = ce 自启用的 root_dir
  const existing = await detectServers()
  const reuse = existing.find((s) => s.root === osRoot) // 只复用 root 正好在根目录的现成 jupyter
  if (reuse) {
    console.log(`[ce] 复用根目录 Jupyter:${reuse.url}(root ${reuse.root})`)
    return { baseUrl: toLoopback(reuse.url), token: reuse.token, root: reuse.root }
  }
  console.log('[ce] 未发现根目录的 Jupyter,自启...')
  // 自装 Jupyter 前先拦 Python:没 Python 就给指引 + 退出,绝不拖到 pip 报错。
  await ensurePythonOrExit(relayUrl)
  const r = await ensureJupyter(realJupyterDeps())
  if (r === 'cancelled') {
    console.error('[ce] 未安装 Jupyter,无法继续。手动装:pip install jupyterlab -i https://pypi.tuna.tsinghua.edu.cn/simple')
    process.exit(1)
  }
  if (r === 'failed') {
    console.error('[ce] 安装 Jupyter 失败。请手动 pip install jupyterlab -i https://pypi.tuna.tsinghua.edu.cn/simple 后重试')
    process.exit(1)
  }
  console.log('[ce] 启动 Jupyter...')
  const { server, stop } = await launchJupyter() // 不传 rootDir → 默认宿主机根目录
  console.log(`[ce] 已启动 Jupyter:${server.url}`)
  const live = await detectServers() // 启动后再探一次拿 root_dir
  return { baseUrl: toLoopback(server.url), token: server.token, root: pickRoot(live, server.url), stop }
}

/** 探测一个能跑的 claude 二进制。机器上可能装多份(系统/nvm/npx),PATH 先解析到的可能是坏的
 *  "native binary not installed"。优先 --claude-bin 参数;否则试 /usr/bin/claude 等绝对路径,
 *  跑 --version 验证(含版本号 + 无 native binary 报错),用第一个好的。管家 cc 用它 spawn。 */
async function resolveClaudeBin(): Promise<string> {
  const explicit = arg('claude-bin')
  if (explicit) return explicit
  for (const c of ['claude', '/usr/local/bin/claude', '/usr/bin/claude']) {
    try {
      // timeout 6 防 npx-stub 触发安装挂起;要含版本号且无 native binary 报错才算可用。
      const { stdout } = await pExecFile('sh', ['-c', `timeout 6 "${c}" --version 2>&1`], { timeout: 8000 })
      if (/\d+\.\d+\.\d+/.test(stdout) && !/native binary not installed/i.test(stdout)) {
        console.log(`[ce] 管家用 claude: ${c} (${stdout.trim().split('\n')[0]})`)
        return c
      }
    } catch {
      /* 此候选不行(超时/报错),试下一个 */
    }
  }
  console.warn('[ce] 未找到能跑的 claude(--version 都失败),管家可能起不来;可用 --claude-bin=<path> 指定')
  return 'claude'
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

  const { baseUrl, token, root, stop } = await resolveJupyter(relayUrl)
  if (stop) process.on('SIGINT', stop)

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
  const wsBase = baseUrl.replace(/^http/, 'ws')

  let ws: WebSocket | null = null
  // 多手机共连:每台手机一条独立 E2E 通道(phoneId → 派生 sharedKey + 显示名)。
  // 握手按 frame.sourcePhoneId(hub 注入)分通道;加密按 targetPhoneId、解密按 sourcePhoneId 寻路。
  const phoneKeys = new Map<string, { sharedKey: Uint8Array; name: string }>()
  // 握手认证:pin 模式下新手机首次连接须带正确 PIN 才入白名单,已授权 phoneId 重连放行;
  //   --pairing-mode=open 退回旧的「明文 phonePub 即配对」(过渡兼容)。白名单持久 ~/.ce/authorized-phones.json。
  const pairingMode = (arg('pairing-mode') ?? 'pin') as PairingMode
  const authorized = loadAuthorized()
  let currentPin = pairingMode === 'pin' ? (arg('pin') ?? randomPin()) : ''
  // 终端占用:terminalName → owner phoneId。Task 4 的 tryAcquire 接入填充;此处先声明供输出寻路 + phoneLeft 清理。
  const terminalOwner = new Map<string, string>()
  const terms = new Map<string, WebSocket>() // terminalName → 本地 terminado WS(跨重连复用)
  // 终端输出环形缓冲:转发 TermOutput 时旁路 append(与 owner 无关);read_terminal 工具读它(ce 本地,不回程问手机)。
  const buffers = new TermBuffers(500)
  // AI 管家:每台手机一个 cc(stream-json,全 pipe 由 ce spawn),ce 桥接 ButlerStdin/ButlerOutput。
  // claudeBin:探测一个能跑的 claude——机器上常装多份(系统/nvm/npx),PATH 先解析到的可能是坏的
  //   "native binary not installed"。优先绝对路径、跑 --version 验证,用第一个好的;管家 cc 用它 spawn。
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
        return json({
          running: true, pid: process.pid, version: VERSION,
          relay: relayUrl, jupyter: baseUrl, pairingMode,
          pin: currentPin,
          phones: [...phoneKeys.entries()].map(([id, v]) => ({ id, name: v.name })),
          paired: [...authorized],
          wsConnected: ws?.readyState === WebSocket.OPEN,
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
        return json({ ok: true, pin: currentPin })
      }
      if (path === '/control/unpair' && req.method === 'POST') {
        const { phoneId } = await req.json() as { phoneId?: string }
        if (!phoneId) return json({ ok: false, error: '缺 phoneId' }, 400)
        removeAuthorized(phoneId)
        phoneKeys.delete(phoneId)
        return json({ ok: true, paired: [...loadAuthorized()] })
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
        writeFileSync(join(ceDir, 'daemon.json'), JSON.stringify({ port: hookPort, pid: process.pid, version: VERSION, startAt: Date.now() }))
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
    terms.set(name, tws)
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
    // 半块字符紧凑渲染(2 module 行合并成 1 行、1 字符/module;比 qrcode terminal 的 ANSI 2空格/module 小一半多)
    try {
      const qr = qrcode.create(qrPayload)
      const size = qr.modules.size
      let out = ''
      for (let y = 0; y < size; y += 2) {
        let line = ''
        for (let x = 0; x < size; x++) {
          const top = qr.modules.get(x, y)
          const bot = y + 1 < size && qr.modules.get(x, y + 1)
          line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
        }
        out += line + '\n'
      }
      console.log('\n' + out)
      console.log('用 App 扫码连接(或下方连接码粘码)')
    } catch {
      /* 渲染失败→只给连接码 */
    }
    console.log('连接码(手动粘贴): ' + qrPayload + '\n')
    if (pairingMode === 'pin') console.log(`[ce] 配对 PIN(新手机首次连接在 App 输入): ${currentPin}\n`)
  }

  // 在已注册的 ws 上接主消息循环(握手 + rpc + stdin + resize)
  function wireBridge(curWs: WebSocket): void {
    curWs.on('message', async (raw) => {
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
            console.log(`[ce] 拒绝配对 phoneId=${phoneId}(pin 模式:非白名单且 PIN 错/缺)`)
            return
          }
          if (auth.pair) addAuthorized(phoneId)
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
            const all = await jupyter.listTerminals()
            // 每条加 occupiedBy(占用者显示名;null=空闲)—— 手机「+」面板据此灰显别人在用的
            const terminals = toRemoteTerminals(all, new Set(terms.keys())).map((t) => ({
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
              resp = { ok: true }
            }
          } else if (req.op === 'createTerminal') {
            const termType = (req as { type?: string }).type
            if (termType === 'cc') {
              // CC 对话:起 ce 端 Agent SDK runner(不开 Jupyter 终端、不 parse TUI)。一机可多 CC(各目录独立),
              // 每次 createTerminal 新建一个 agent(不复用)。返 sid(形如 cc-xxxx)作「终端名」——
              // 手机据它路由 stdin(TermStdin cc- 分支)+ demux agentEvents(帧带 sid)+ 渲染对话组件(type:'cc')。
              const sid = agentRunner.start(srcPhone, (req as { cwd?: string }).cwd)
              console.log(`[ce] createTerminal(cc) → agentRunner sid=${sid} (phone=${srcPhone})`)
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
    })
  }

  // 连中继(带 cid)→ 注册 → 打 qr(首次)→ 接桥接;断开则指数退避重连。
  function connect(): void {
    ws = new WebSocket(`${relayUrl}/?cid=${cid}`)
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
          wireBridge(ws as WebSocket)
        } else if (m.type === 'error') {
          console.error('[ce] 中继注册失败:', m.reason)
        }
      } catch {
        /* 非控制帧(registered 之后的消息由 wireBridge 处理,h 已 off) */
      }
    })
    ws.on('close', () => {
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
} else {
  runConsole().catch((e) => {
    console.error('[ce] 控制台错误:', (e as Error).message)
    process.exit(1)
  })
}
