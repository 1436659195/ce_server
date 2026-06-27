/**
 * ce —— 跑在被控机的 CLI。编排:
 *   探测/起本地 Jupyter → 连中继注册会话 → 生成密钥+二维码 → 配对握手 → 桥接(手机↔本地 Jupyter)
 *
 * 用法:ce --relay=ws://relay.yourserver[:port] [--jupyter=url --jupyter-token=t]
 *       (不传 --jupyter 则先探测、再启动)
 *
 * ⚠️ 整合胶水,无单测;手测见 P3-5 清单(需真实中继 + Jupyter)。
 */
import WebSocket from 'ws'
import qrcode from 'qrcode'
import { generateKeyPair, sharedSecret, seal, open } from '../shared/crypto'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '../shared/frame'
import { detectServers } from './jupyter-detect'
import { launchJupyter } from './jupyter-launch'
import { makeJupyterClient, handleRpc, type RpcRequest } from './bridge'

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

  // 1. 连中继、注册会话
  const ws = new WebSocket(`${relayUrl}/`)
  const reg = await new Promise<{ sid: string; token: string }>((resolve, reject) => {
    ws.on('message', function h(raw) {
      try {
        const m = JSON.parse(dec.decode(raw as Uint8Array))
        if (m.type === 'registered') {
          ws.off('message', h)
          resolve({ sid: m.sid, token: m.token })
        } else if (m.type === 'error') {
          reject(new Error(m.reason))
        }
      } catch {
        /* 非控制帧 */
      }
    })
    ws.on('error', reject)
  })
  const { sid, token: relayToken } = reg

  // 2. 生成密钥对 + 二维码({r:relay, s:sid, k:cliPub(b64), t:relayToken})
  const cliKp = generateKeyPair()
  const qrPayload = JSON.stringify({ r: relayUrl, s: sid, k: b64(cliKp.publicKey), t: relayToken })
  console.log('\n' + (await qrcode.toString(qrPayload, { type: 'terminal' })))
  console.log('用 App 扫码连接')
  // 手动连接码兜底(App 摄像头扫码未就绪时,在「扫码连接」里粘贴这串 JSON)
  console.log('连接码(手动粘贴): ' + qrPayload + '\n')

  // 3. 桥接状态
  const jupyter = makeJupyterClient(baseUrl, token)
  const wsBase = baseUrl.replace(/^http/, 'ws')
  let sharedKey: Uint8Array | null = null
  const terms = new Map<string, WebSocket>() // terminalName → 本地 terminado WS

  function sendFrame(f: Frame): void {
    ws.send(dec.decode(encodeFrame(f))) // 帧是 JSON 文本,发字符串
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

  // 4. 主消息循环
  ws.on('message', async (raw) => {
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
        sharedKey = sharedSecret(cliKp.privateKey, phonePub)
        console.log('[ce] 手机已配对,E2E 通道建立')
      }
      return
    }

    // 之后所有 payload 都是密文
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
        encryptThenSend(FrameType.RPCResp, enc.encode(JSON.stringify(resp)), { reqId: frame.reqId })
        break
      }
      case FrameType.TermStdin: {
        const name = frame.sid
        if (!name) break
        const tws = ensureTerm(name)
        if (tws.readyState === WebSocket.OPEN) tws.send(JSON.stringify(['stdin', dec.decode(plaintext)]))
        break
      }
      default:
        break
    }
  })

  ws.on('close', () => console.log('[ce] 中继连接断开'))
  ws.on('error', (e) => console.error('[ce] 中继错误:', (e as Error).message))
}

main().catch((e) => {
  console.error('[ce] 启动失败:', (e as Error).message)
  process.exit(1)
})
