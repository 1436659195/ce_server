import { createServer, type Server, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { Hub, type RelayWS } from './hub'

/**
 * 把 Hub(纯逻辑)接到真实 WebSocket 上。
 *
 * URL 约定:
 *   - cli:   `wss://relay/`           → 注册,服务端回 `{type:'registered', sid, token}`
 *   - phone: `wss://relay/{sid}?token=xxx` → token 校验通过则加入,回 `{type:'joined'}`;否则 `{type:'error'}` 后断开
 *
 * 之后 cli/phone 互发的消息都经 Hub 透传(零信任,不解析负载)。
 */
export function createRelayServer(hub: Hub): { server: Server; close: () => Promise<void> } {
  const server = createServer()
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
      // cli 注册
      const { sid, token: tok } = hub.register(ws as RelayWS)
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
