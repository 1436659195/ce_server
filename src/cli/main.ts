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
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { sharedSecret, seal, open } from '../shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../shared/frame'
import { detectServers } from './jupyter-detect'
import { launchJupyter } from './jupyter-launch'
import { makeJupyterClient, handleRpc, toRemoteTerminals, type RpcRequest, type RpcResponse } from './bridge'
import { ButlerManager } from './butler'
import { TermBuffers } from './term-buffers'
import { loadOrCreateIdentity } from './identity'
import { tryAcquire } from './ownership'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { loadConfig } from './config'
import { ensureJupyter, type JupyterInstallDeps } from './jupyter-install'

const enc = new TextEncoder()
const dec = new TextDecoder()

function arg(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : undefined
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

/** 随机十六进制 id(老 hub 未注入 sourcePhoneId 时,握手生成匿名 phoneId 用)。 */
function randId(n = 8): string {
  return randomBytes(n).toString('hex')
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

/** 解析 Jupyter:显式 > 探测 > 引导装 > 启动。 */
async function resolveJupyter(
  relayUrl: string
): Promise<{ baseUrl: string; token: string; stop?: () => void }> {
  const explicitUrl = arg('jupyter')
  const explicitToken = arg('jupyter-token')
  if (explicitUrl && explicitToken) return { baseUrl: toLoopback(explicitUrl), token: explicitToken }

  const existing = await detectServers()
  if (existing.length > 0) {
    console.log(`[ce] 探测到 Jupyter:${existing[0].url}(root ${existing[0].root})`)
    return { baseUrl: toLoopback(existing[0].url), token: existing[0].token }
  }
  console.log('[ce] 未探测到 Jupyter')
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
  const { server, stop } = await launchJupyter()
  console.log(`[ce] 已启动 Jupyter:${server.url}`)
  return { baseUrl: toLoopback(server.url), token: server.token, stop }
}

/** 探测一个能跑的 claude 二进制。机器上可能装多份(系统/nvm/npx),PATH 先解析到的可能是坏的
 *  "native binary not installed"。优先 --claude-bin 参数;否则试 /usr/bin/claude 等绝对路径,
 *  跑 --version 验证(含版本号 + 无 native binary 报错),用第一个好的。管家 cc 用它 spawn。 */
async function resolveClaudeBin(): Promise<string> {
  const explicit = arg('claude-bin')
  if (explicit) return explicit
  for (const c of ['/usr/bin/claude', '/usr/local/bin/claude', 'claude']) {
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

async function main(): Promise<void> {
  const relayUrl = arg('relay') ?? loadConfig().relay
  if (!relayUrl) {
    console.error('用法:ce --relay=ws://relay.yourserver[:port] [--jupyter=url --jupyter-token=t]')
    console.error('（或先运行一行安装器: curl -fsSL http://<relay>/install.sh | sh）')
    console.error('（Windows: irm http://<relay>/install.ps1 | iex）')
    process.exit(1)
  }

  const { baseUrl, token, stop } = await resolveJupyter(relayUrl)
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

  const jupyter = makeJupyterClient(baseUrl, token)
  const wsBase = baseUrl.replace(/^http/, 'ws')

  let ws: WebSocket | null = null
  // 多手机共连:每台手机一条独立 E2E 通道(phoneId → 派生 sharedKey + 显示名)。
  // 握手按 frame.sourcePhoneId(hub 注入)分通道;加密按 targetPhoneId、解密按 sourcePhoneId 寻路。
  const phoneKeys = new Map<string, { sharedKey: Uint8Array; name: string }>()
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
    // 终端工具依赖:list 走 Jupyter /api/terminals(权威:机器上所有终端;缓冲会漏没喷过输出的),
    // read 走 buffers(输出缓冲),send 写 terminado stdin(复用 TermStdin 同款 ['stdin',text])。
    deps: {
      listTerminals: async () => (await jupyter.listTerminals()).map((t) => t.name),
      readTerminal: (name, n) => buffers.read(name, n),
      send: async (name, text) => { terms.get(name)?.send(JSON.stringify(['stdin', text])) },
    },
    claudeBin,
  })
  let qrPrinted = false
  let reconnectDelay = 2000

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
            phoneKeys.delete(notice.phoneId) // E2E 通道失效(安全:断连后该 phone 密钥不可再用于解密)
            for (const [tname, owner] of terminalOwner) {
              if (owner === notice.phoneId) terminalOwner.delete(tname) // 终端占用随连接重置
            }
            // 【不杀管家】。管家是 ce 侧长驻进程,和终端一样——手机瞬时断连(后台/切应用致 WS 冻结重连)极常见,
            // 此时杀管家会让手机重连后接到一个已死的 sid(stop 不发 butler_exit)→ 发消息无响应、120s 超时
            // (这正是「接着上次的」开管家后超时的根因)。管家留活,手机重连后重新握手派生 phoneKeys、按
            // owner=phoneId 续接同一 cc(下次 butlerStart 也由 sidForPhone 复用接回)。
            console.log(`[ce] 手机离开 phoneId=${notice.phoneId},已清其 E2E 通道与终端占用(管家保留,等重连续接)`)
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
        // 当作握手 phonePub(明文):{ k: phonePub(b64), n?: name } 或兼容老格式(纯 b64 公钥)
        try {
          const text = dec.decode(frame.payload).trim()
          let phonePubB64: string
          let name = ''
          if (text.startsWith('{')) {
            const obj = JSON.parse(text) as { k?: string; n?: string }
            if (!obj.k || typeof obj.k !== 'string') throw new Error('handshake json missing k')
            phonePubB64 = obj.k
            name = obj.n ?? ''
          } else {
            phonePubB64 = text // 老格式:纯 b64 公钥
          }
          const phonePub = unb64(phonePubB64)
          const sharedKey = sharedSecret(cliPriv, phonePub)
          const phoneId = srcPhone ?? `anon-${randId(8)}`
          phoneKeys.set(phoneId, { sharedKey, name })
          console.log(`[ce] 手机配对 phoneId=${phoneId}${name ? ` name=${name}` : ''},E2E 通道建立`)
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
            resp = { ok: true, data: { terminals } }
          } else if (req.op === 'deleteTerminal' && (req as { name?: string }).name) {
            // 手机「关闭终端」:关 ce 端 terminado + Jupyter DELETE,否则杀 app 重开又恢复回来
            const termName = (req as { name?: string }).name!
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
          } else if (req.op === 'detachTerminal' && (req as { name?: string }).name) {
            // 手机「移除」(软):只关 ce 端 terminado WS、不 Jupyter DELETE。
            // → terms map 移除该 name → 下次 listTerminals managed=false → 杀 app 重开不自动恢复;
            //   Jupyter 终端仍在(GET /api/terminals 仍返回)→「+」面板可见、可重新接管。
            const termName = (req as { name?: string }).name!
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
          } else if (req.op === 'createTerminal') {
            // 新建终端:Jupyter 分配的新 name 必空闲 → 创建者即 owner(先到先得天然满足)。
            // 成功后【不】在此 eager 开 terminado WS。此时 ce 还不知道手机的列宽,一旦开 WS,
            // terminado 就按默认 80×24 起进程、PowerShell banner 按 80 列打印;等手机
            // mount→fit→syncSize 的 resize 晚到再 set_size,Windows conpty 对这种「晚到的 resize」
            // 会整屏 re-serialize,把用户敲入的第一个命令错位打到 banner 行(PSReadLine 此时还没
            // 就绪,光回显不执行)、并在下方留一个空的新 prompt——中继连 Windows「第一个命令错位」
            // 即此。直连无此问题:直连是手机自己开 WS 并在 ws.onopen 里立即 set_size(PTY 起步即
            // 正确列宽,无晚到 resize)。
            // 改懒开以对齐直连:手机首条 resize(useTerminals.attachXterm 的 nextTick fit+syncSize,
            // 兜底由 tunnel onReady 的 syncSize)到 ce 时,上面 Control-resize 分支自会 ensureTerm
            // 开 WS(并 tryAcquire 标 owner),并把 set_size 缓冲到 open 后立即补发——set_size 抵达
            // 时机与直连 ws.onopen 的 set_size 完全一致。stdin(TermStdin)分支同样懒开兜底,故此处
            // 不预开也安全。
            // (旧注释担心不预开会「停正在连接、要点输入才蹦出」——那是因为当时手机 mount 后不发
            //  resize;现已由 attachXterm/onReady 可靠发 resize,懒开不再卡。)
            resp = await handleRpc(jupyter, req)
            if (
              resp.ok &&
              resp.data &&
              typeof (resp.data as { name?: string }).name === 'string'
            ) {
              terminalOwner.set((resp.data as { name: string }).name, srcPhone)
            }
          } else if (req.op === 'butlerStart') {
            // AI 管家:ce 用 SDK query 起 cc,回 butlerSid;手机据此收发 ButlerStdin/ButlerOutput。skill 由手机传。
            // 一机一管家:同手机已有活管家 → 复用 sid(手机重连/重开接回带历史上下文的 cc;phoneLeft 不杀管家)。
            const bSid = butlers.sidForPhone(srcPhone) ?? butlers.start(req.skill ?? '', srcPhone)
            resp = { ok: true, data: { sid: bSid } }
            // 不发合成 init:SDK 的 cc 启动自然吐 system/init 事件 → 手机据其 ready。
          } else if (req.op === 'butlerStop' && req.sid) {
            butlers.stop(req.sid)
            resp = { ok: true }
          } else {
            resp = await handleRpc(jupyter, req)
          }
          // RPCResp 按发起方 phoneId 定向加密(谁问的回谁;srcPhone 来自 frame.sourcePhoneId,
          // 上方 !knownKey||!srcPhone 守卫保证非空)
          encryptThenSend(FrameType.RPCResp, enc.encode(JSON.stringify(resp)), {
            reqId: frame.reqId,
            targetPhoneId: srcPhone,
          })
          break
        }
        case FrameType.TermStdin: {
          const name = frame.sid
          if (!name) break
          // 占用校验:懒开 WS 时按先到先得裁决;别人占用的终端其 stdin 不转发,并给 loser 发
          // attachDenied(race 反馈:loser 可能已本地建会话,需回滚 + 提示)。
          const acq = tryAcquire(terminalOwner, name, srcPhone)
          if (!acq.ok) {
            denyAttach(name, srcPhone, acq.occupiedBy)
            break
          }
          const tws = ensureTerm(name)
          tws.send(JSON.stringify(['stdin', dec.decode(plaintext)])) // ensureTerm 自缓冲(CONNECTING 时)
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
      // 【不杀管家】(同 phoneLeft 理由:管家是 ce 侧长驻进程)。中继重连后手机也重连,管家按 owner 续接;
      //   ce 若整体重启则进程死、管家自然没了,手机端会超时→重开 respawn(useButler.open 见 dead 即重建)。
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    })
    ws.on('error', (e) => console.error('[ce] 中继错误:', (e as Error).message))
  }

  connect()
}

main().catch((e) => {
  console.error('[ce] 启动失败:', (e as Error).message)
  process.exit(1)
})
