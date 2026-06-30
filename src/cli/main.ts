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
import { sharedSecret, seal, open } from '../shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../shared/frame'
import { detectServers } from './jupyter-detect'
import { launchJupyter } from './jupyter-launch'
import { makeJupyterClient, handleRpc, type RpcRequest, type RpcResponse } from './bridge'
import { loadOrCreateIdentity } from './identity'
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

/** ensureJupyter 的真实副作用实现:spawn jupyter/pip、stdin y/n。 */
function realJupyterDeps(): JupyterInstallDeps {
  return {
    hasJupyter: async () => {
      try {
        await pExecFile('jupyter', ['--version'], { shell: true })
        return true
      } catch {
        return false
      }
    },
    prompt: (msg) => askYesNo(msg),
    install: async () => {
      console.log('[ce] pip install jupyterlab(约 1-2 分钟,请等待)...')
      await new Promise<void>((resolve, reject) => {
        const p = spawn('pip', ['install', 'jupyterlab'], { shell: true, stdio: 'inherit' })
        p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`pip 退出码 ${c}`))))
        p.on('error', reject)
      })
    },
  }
}

/** 解析 Jupyter:显式 > 探测 > 引导装 > 启动。 */
async function resolveJupyter(): Promise<{ baseUrl: string; token: string; stop?: () => void }> {
  const explicitUrl = arg('jupyter')
  const explicitToken = arg('jupyter-token')
  if (explicitUrl && explicitToken) return { baseUrl: explicitUrl, token: explicitToken }

  const existing = await detectServers()
  if (existing.length > 0) {
    console.log(`[ce] 探测到 Jupyter:${existing[0].url}(root ${existing[0].root})`)
    return { baseUrl: existing[0].url, token: existing[0].token }
  }
  console.log('[ce] 未探测到 Jupyter')
  const r = await ensureJupyter(realJupyterDeps())
  if (r === 'cancelled') {
    console.error('[ce] 未安装 Jupyter,无法继续。手动装:pip install jupyterlab')
    process.exit(1)
  }
  if (r === 'failed') {
    console.error('[ce] 安装 Jupyter 失败。请手动 pip install jupyterlab 后重试')
    process.exit(1)
  }
  console.log('[ce] 启动 Jupyter...')
  const { server, stop } = await launchJupyter()
  console.log(`[ce] 已启动 Jupyter:${server.url}`)
  return { baseUrl: server.url, token: server.token, stop }
}

async function main(): Promise<void> {
  const relayUrl = arg('relay') ?? loadConfig().relay
  if (!relayUrl) {
    console.error('用法:ce --relay=ws://relay.yourserver[:port] [--jupyter=url --jupyter-token=t]')
    console.error('（或先运行一行安装器: curl -fsSL http://<relay>/install.sh | sh）')
    console.error('（Windows: irm http://<relay>/install.ps1 | iex）')
    process.exit(1)
  }

  const { baseUrl, token, stop } = await resolveJupyter()
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
  let sharedKey: Uint8Array | null = null
  const terms = new Map<string, WebSocket>() // terminalName → 本地 terminado WS(跨重连复用)
  let qrPrinted = false
  let reconnectDelay = 2000

  function sendFrame(f: Frame): void {
    ws?.send(dec.decode(encodeFrame(f)))
  }
  function encryptThenSend(
    type: FrameType,
    plaintext: Uint8Array,
    opts: { sid?: string; reqId?: string }
  ): void {
    if (!sharedKey) return
    sendFrame({ type, sid: opts.sid, reqId: opts.reqId, payload: seal(sharedKey, plaintext) })
  }

  // 按 terminal name 懒开/重连 terminado WS(路径无 /api 前缀);输出加密回传。
  // 健壮性:① cached 断开(CLOSING/CLOSED)则重连,不复用死连接;② WS 还在 CONNECTING 时
  // 缓冲 set_size/stdin,open 后补发。否则恢复终端时第一条 resize 落在 CONNECTING 上被
  // "readyState===OPEN" 检查静默丢弃 → bash 收不到 SIGWINCH 不重绘 → 手机卡"正在连接"
  // (直连因 ws.onopen 里 syncSize,连接好了才发,不丢)。
  function ensureTerm(name: string): WebSocket {
    const cached = terms.get(name)
    if (cached && cached.readyState === WebSocket.OPEN) return cached
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
          encryptThenSend(FrameType.TermOutput, enc.encode(out), { sid: name })
        }
      } catch {
        /* setup/exit/控制帧忽略 */
      }
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
        return
      }

      // Control 帧:可能是握手 phonePub(明文,手机每次连入/重连都发)或 resize(密文)。
      // 手机每次重连用新公钥 → 必须每次 phonePub 重新派生 sharedKey,不能只首次
      // (否则重连后 ce 还用旧 sharedKey,新 phonePub 被当密文丢弃 → createTerminal 无响应)。
      if (frame.type === FrameType.Control) {
        if (sharedKey) {
          // 先按密文解密(resize 等控制帧是密文)
          try {
            const decrypted = open(sharedKey, frame.payload)
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
              const tws = ensureTerm(frame.sid)
              tws.send(JSON.stringify(['set_size', msg.rows, msg.cols])) // ensureTerm 自缓冲(CONNECTING 时)
            }
            return
          } catch {
            /* 解密失败 → 落到下面当握手 phonePub 处理 */
          }
        }
        // 当作握手 phonePub(明文 b64)→ (重新)派生 sharedKey
        try {
          const phonePub = unb64(dec.decode(frame.payload))
          sharedKey = sharedSecret(cliPriv, phonePub)
          console.log('[ce] 手机已配对,E2E 通道(重新)建立')
        } catch {
          /* 非法帧 */
        }
        return
      }

      // RPCReq / TermStdin:必须已握手 + 密文
      if (!sharedKey) return
      let plaintext: Uint8Array
      try {
        plaintext = open(sharedKey, frame.payload)
      } catch {
        return // 解密失败(篡改/错 key)→ 丢弃
      }

      switch (frame.type) {
        case FrameType.RPCReq: {
          const req = JSON.parse(dec.decode(plaintext)) as RpcRequest
          let resp: RpcResponse
          if (req.op === 'listTerminals') {
            // 列 ce 端当前活着的终端,供手机杀 app 重开时恢复(而不是新建一个空终端)
            resp = { ok: true, data: { names: Array.from(terms.keys()) } }
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
            try {
              await fetch(`${baseUrl}/api/terminals/${encodeURIComponent(termName)}`, {
                method: 'DELETE',
                headers: { Authorization: `Token ${token}` },
              })
            } catch {
              /* 尽力删,失败不阻塞(至多留服务端孤儿终端) */
            }
            resp = { ok: true }
          } else {
            resp = await handleRpc(jupyter, req)
            // createTerminal 成功后立即开本地 terminado WS,让 shell 初始输出(prompt/banner)
            // 立即流向手机。ensureTerm 本是懒开,不在这开则手机"标签绿却停正在连接,要点输入才蹦出"。
            if (
              req.op === 'createTerminal' &&
              resp.ok &&
              (resp.data as { name?: string } | undefined)?.name
            ) {
              ensureTerm((resp.data as { name: string }).name)
            }
          }
          encryptThenSend(FrameType.RPCResp, enc.encode(JSON.stringify(resp)), { reqId: frame.reqId })
          break
        }
        case FrameType.TermStdin: {
          const name = frame.sid
          if (!name) break
          const tws = ensureTerm(name)
          tws.send(JSON.stringify(['stdin', dec.decode(plaintext)])) // ensureTerm 自缓冲(CONNECTING 时)
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
      sharedKey = null // 重连后手机重新握手派生
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
