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
import { hostname } from 'node:os'
import { sharedSecret, seal, open } from '../shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../shared/frame'
import { detectServers } from './jupyter-detect'
import { launchJupyter } from './jupyter-launch'
import { makeJupyterClient, handleRpc, type RpcRequest } from './bridge'
import { loadOrCreateIdentity } from './identity'

const enc = new TextEncoder()
const dec = new TextDecoder()

function arg(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : undefined
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

/** 解析 Jupyter:显式 > 探测 > 启动。 */
async function resolveJupyter(): Promise<{ baseUrl: string; token: string; stop?: () => void }> {
  const explicitUrl = arg('jupyter')
  const explicitToken = arg('jupyter-token')
  if (explicitUrl && explicitToken) return { baseUrl: explicitUrl, token: explicitToken }

  const existing = await detectServers()
  if (existing.length > 0) {
    console.log(`[ce] 探测到 Jupyter:${existing[0].url}(root ${existing[0].root})`)
    return { baseUrl: existing[0].url, token: existing[0].token }
  }
  console.log('[ce] 未探测到 Jupyter,启动一个...')
  const { server, stop } = await launchJupyter()
  console.log(`[ce] 已启动 Jupyter:${server.url}`)
  return { baseUrl: server.url, token: server.token, stop }
}

async function main(): Promise<void> {
  const relayUrl = arg('relay')
  if (!relayUrl) {
    console.error('用法:ce --relay=ws://relay.yourserver[:port] [--jupyter=url --jupyter-token=t]')
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

  // 按 terminal name 懒开 terminado WS(路径无 /api 前缀);输出加密回传
  function ensureTerm(name: string): WebSocket {
    const cached = terms.get(name)
    if (cached) return cached
    const tws = new WebSocket(`${wsBase}/terminals/websocket/${name}?token=${token}`)
    tws.on('message', (data) => {
      try {
        const msg = JSON.parse(dec.decode(data as Uint8Array))
        if (!Array.isArray(msg)) return
        const [etype, content] = msg
        if ((etype === 'stdout' || etype === 'stderr') && typeof content === 'string') {
          encryptThenSend(FrameType.TermOutput, enc.encode(content), { sid: name })
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
    void qrcode.toString(qrPayload, { type: 'terminal' }).then((qr) => {
      console.log('\n' + qr)
      console.log('用 App 扫码连接')
      console.log('连接码(手动粘贴): ' + qrPayload + '\n')
    })
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

      // 配对握手:第一条 Control 帧载 phone 公钥(明文 b64)→ 据此派生 sharedKey
      if (!sharedKey) {
        if (frame.type === FrameType.Control) {
          const phonePub = unb64(dec.decode(frame.payload))
          sharedKey = sharedSecret(cliPriv, phonePub)
          console.log('[ce] 手机已配对,E2E 通道建立')
        }
        return
      }

      let plaintext: Uint8Array
      try {
        plaintext = open(sharedKey, frame.payload)
      } catch {
        return // 解密失败(篡改/错 key)→ 丢弃
      }

      switch (frame.type) {
        case FrameType.RPCReq: {
          const req = JSON.parse(dec.decode(plaintext)) as RpcRequest
          const resp = await handleRpc(jupyter, req)
          // createTerminal 成功后立即开本地 terminado WS,让 shell 初始输出(prompt/banner)
          // 立即流向手机。ensureTerm 本是懒开,不在这开则手机"标签绿却停正在连接,要点输入才蹦出"。
          if (
            req.op === 'createTerminal' &&
            resp.ok &&
            (resp.data as { name?: string } | undefined)?.name
          ) {
            ensureTerm((resp.data as { name: string }).name)
          }
          encryptThenSend(FrameType.RPCResp, enc.encode(JSON.stringify(resp)), { reqId: frame.reqId })
          break
        }
        case FrameType.TermStdin: {
          const name = frame.sid
          if (!name) break
          const tws = ensureTerm(name)
          if (tws.readyState === WebSocket.OPEN)
            tws.send(JSON.stringify(['stdin', dec.decode(plaintext)]))
          break
        }
        case FrameType.Control: {
          // resize:plaintext = {op:'resize', rows, cols};sid = terminal name → terminado set_size
          const msg = JSON.parse(dec.decode(plaintext)) as {
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
            if (tws.readyState === WebSocket.OPEN) {
              tws.send(JSON.stringify(['set_size', msg.rows, msg.cols]))
            }
          }
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
