import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { Hub, type RelayWS } from './hub'

/** 把 install.ps1 模板里的 __RELAY_URL__ 替换成实际中继 ws 地址(按请求 Host 注入)。纯函数,可单测。 */
export function renderInstallScript(template: string, relayWs: string): string {
  return template.replaceAll('__RELAY_URL__', relayWs)
}

/**
 * 把 Hub(纯逻辑)接到真实 WebSocket 上。
 *
 * URL 约定:
 *   - cli:   `wss://relay/`           → 注册,服务端回 `{type:'registered', sid, token}`
 *   - phone: `wss://relay/{sid}?token=xxx` → token 校验通过则加入,回 `{type:'joined'}`;否则 `{type:'error'}` 后断开
 *
 * 之后 cli/phone 互发的消息都经 Hub 透传(零信任,不解析负载)。
 * 传 opts.cert+key 则上 TLS(wss);否则明文 ws(本地/开发)。
 */
export function createRelayServer(
  hub: Hub,
  opts?: {
    cert?: string
    key?: string
    ceExePath?: string
    installScriptPath?: string
    ceLinuxX64Path?: string
    ceLinuxArm64Path?: string
    installShPath?: string
  }
): { server: Server; close: () => Promise<void> } {
  // 静态下载路由:/install.ps1(注入 __RELAY_URL__)、/dl/ce-windows-x64.exe;其余 404。
  // ws upgrade 仍由下方 WebSocketServer({server}) 接管,与 http requestListener 不冲突。
  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    const host = req.headers.host ?? 'localhost'
    const relayWs = `ws://${host}`
    const path = new URL(req.url ?? '/', 'http://relay').pathname
    if (path === '/install.ps1' && opts?.installScriptPath) {
      try {
        const body = renderInstallScript(readFileSync(opts.installScriptPath, 'utf8'), relayWs)
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(body)
      } catch {
        res.writeHead(500)
        res.end('install.ps1 不可读')
      }
      return
    }
    if (path === '/install.sh' && opts?.installShPath) {
      try {
        const body = renderInstallScript(readFileSync(opts.installShPath, 'utf8'), relayWs)
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(body)
      } catch {
        res.writeHead(500)
        res.end('install.sh 不可读')
      }
      return
    }
    if (path === '/dl/ce-windows-x64.exe' && opts?.ceExePath) {
      try {
        const buf = readFileSync(opts.ceExePath)
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', buf.length)
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end('ce.exe 不可读')
      }
      return
    }
    if (path === '/dl/ce-linux-x64' && opts?.ceLinuxX64Path) {
      try {
        const buf = readFileSync(opts.ceLinuxX64Path)
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', buf.length)
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end('ce-linux-x64 不可读')
      }
      return
    }
    if (path === '/dl/ce-linux-arm64' && opts?.ceLinuxArm64Path) {
      try {
        const buf = readFileSync(opts.ceLinuxArm64Path)
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', buf.length)
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end('ce-linux-arm64 不可读')
      }
      return
    }
    res.writeHead(404)
    res.end('not found')
  }
  const server =
    opts?.cert && opts?.key
      ? createHttpsServer(
          { cert: readFileSync(opts.cert), key: readFileSync(opts.key) },
          requestListener
        )
      : createServer(requestListener)
  const wss = new WebSocketServer({ server })

  // 跟踪所有原始 socket:服务端拒掉/关掉的连接,客户端未必回 close ack —— ws 层虽已移除,
  // 底层 TCP socket 却会残留,导致 server.close 的回调永不触发(测试因此 hang)。close() 时强制 destroy。
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const u = new URL(req.url ?? '/', 'http://relay')
    const path = u.pathname.replace(/\/+$/, '') // 去尾斜杠:'/' → ''
    const token = u.searchParams.get('token') ?? ''

    if (path === '' || path === '/register') {
      // cli 注册:带 cid(机器标识)→ 中继按 cid 复用持久 sid/token(ce/中继重启后手机配对码仍有效)。
      // 旧 ce 无 cid → 临时匿名(每次新 sid,退化为旧行为)。
      const cid = u.searchParams.get('cid') ?? 'anon-' + Math.random().toString(36).slice(2, 12)
      const { sid, token: tok } = hub.register(cid, ws as RelayWS)
      ws.send(JSON.stringify({ type: 'registered', sid, token: tok }))
      wire(ws)
    } else {
      // phone 加入:path = '/{sid}'
      const sid = path.startsWith('/') ? path.slice(1) : path
      const ok = hub.joinPhone(sid, token, ws as RelayWS)
      if (ok) {
        ws.send(JSON.stringify({ type: 'joined' }))
        wire(ws)
      } else {
        // 先把 error 帧刷到 socket 再关,避免 close 抢在数据帧前把消息丢掉(ws 常见坑)
        ws.send(JSON.stringify({ type: 'error', reason: 'bad token or unknown session' }), () =>
          ws.close()
        )
      }
    }
  })

  function wire(ws: WebSocket): void {
    ws.on('message', (data) => {
      // 负载透传(本协议帧是 JSON 文本;二进制场景后续再评估)
      hub.onMessage(ws as RelayWS, data.toString())
    })
    ws.on('close', () => {
      hub.onClose(ws as RelayWS)
    })
  }

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        // destroy 所有底层 socket(含残留的、ws 层已移除但 TCP 未关的);再调 server.close 停止监听。
        // 不 await server.close 的 drain 回调:Bun 下它对"有过连接"的 server 常不触发,会永久 hang。
        // server.close() 调用即释放端口;残留 socket 已被 destroy,故直接 resolve 安全。
        for (const s of sockets) s.destroy()
        server.close()
        resolve()
      }),
  }
}
