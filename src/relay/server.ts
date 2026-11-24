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
 * 静态文件响应:200 + Content-Type/Length,HEAD 只回头;不可读 → 404(文件未上传/路径未配)。
 * /dl/* 与 /workshop/* 静态分发共用(插件工坊集装箱/校验和/货架清单,见下方路由)。
 */
function serveStatic(res: ServerResponse, req: IncomingMessage, filePath: string, contentType: string, label: string): void {
  try {
    const body = readFileSync(filePath)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', body.length)
    if (req.method === 'HEAD') {
      // install.sh 防呆 B 同款:HEAD 拿 Content-Length 比对,不回 body 免浪费带宽
      res.end()
      return
    }
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end(`${label} 不可读`)
  }
}

/** tweetnacl 浏览器版(访客页内嵌;读一次缓存)。文件缺失抛错 → /hire 500(部署缺件可见)。 */
let naclCache: string | null = null
function hireNaclJs(path: string): string {
  if (naclCache === null) naclCache = readFileSync(path, 'utf8')
  return naclCache
}

/** 外部 agent 客户端拼装(2026-11-20 2-2):ESM shim + tweetnacl 源 + 客户端源码 → 单文件零依赖。
 *  导出供测试使用(L2 直跑拼装产物)。
 *  nacl 的 UMD 尾 `typeof module…:self.nacl` 在 ESM 下走 self 分支,故 shim 先补 `const self = globalThis`。 */
let guestClientCache: string | null = null
export function guestClientJs(clientPath: string, naclPath: string): string {
  if (guestClientCache === null) {
    const shim = `const self = globalThis;\n`
    const client = readFileSync(clientPath, 'utf8').replace(/^#![^\n]*\n/, '') // shebang 挪到首行(夹中间=语法错)
    // nacl 的 UMD 尾引用 `module` 标识符 → Bun 把整文件判成 CommonJS(与 import 冲突);换成纯 self 形式
    const nacl = readFileSync(naclPath, 'utf8').replace('"undefined"!=typeof module&&module.exports?module.exports:self.nacl=self.nacl||{}', 'self.nacl=self.nacl||{}')
    guestClientCache = `#!/usr/bin/env node\n` + shim + nacl + '\n' + client
  }
  return guestClientCache
}

/** 静态文本(手册类):同 serveStatic 但强制 no-store —— 手册迭代期老缓存会误导外部 agent。 */
function serveStaticNoStore(res: ServerResponse, req: IncomingMessage, filePath: string, contentType: string, label: string): void {
  try {
    const body = readFileSync(filePath)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Length', body.length)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end(`${label} 不可读`)
  }
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
    ceDarwinX64Path?: string
    ceDarwinArm64Path?: string
    sha256Path?: string
    installShPath?: string
    lanPyPath?: string
    /** 插件工坊分发(缺一该路由 404):脚手架集装箱 / 其 sha256(即版本标识)/ 货架清单 */
    workshopScaffoldPath?: string
    workshopScaffoldSha256Path?: string
    workshopIndexPath?: string
    /** 雇佣网关(2026-11-19):访客聊天页模板(缺则 /hire 404)+ tweetnacl 浏览器版
     *  (模板 __NACL_JS__ 占位处内嵌;与手机/ce 同一套密文格式)。 */
    hirePagePath?: string
    hireNaclPath?: string
    /** 外部 agent 网关(2026-11-20 2-2):客户端脚本源码(拼装内嵌 nacl)+ 两份手册(缺则路由 404)。 */
    guestClientPath?: string
    guestSkillPath?: string
    guestInstallPath?: string
    publicUrl?: string // 对外中继 ws 地址(防 Host 头注入 install 脚本);不配则回退请求 Host
    /** 心跳:每 intervalMs ping 一次,连续 maxMissed 次无 pong 判死 terminate。缺省 30s/2。
     *  测试注入小值加速;治 half-open 死连接(断网/热点切换/NAT 超时,双方无数据则永不发现)。 */
    heartbeat?: { intervalMs: number; maxMissed: number }
  }
): { server: Server; close: () => Promise<void> } {
  // 静态下载路由:/install.ps1 + /install.sh(注入 __RELAY_URL__)、/lan.py(纯静态,无占位)、
  // /dl/ce-{windows-x64.exe,linux-x64,linux-arm64}、/workshop/{scaffold.tgz,scaffold.tgz.sha256,index.json};其余 404。
  // ws upgrade 仍由下方 WebSocketServer({server}) 接管,与 http requestListener 不冲突。
  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    const host = req.headers.host ?? 'localhost'
    const relayWs = opts?.publicUrl ?? `ws://${host}`
    // 畸形请求行(如扫描器发 "//")会让 new URL 抛 ERR_INVALID_URL → uncaughtException 整进程退出,这里直接 400 掉。
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://relay').pathname
    } catch {
      console.warn(`[relay] 畸形请求已拒(400): ${req.method} ${JSON.stringify(req.url)} from ${req.socket.remoteAddress}`)
      res.writeHead(400)
      res.end('bad request')
      return
    }
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
    if (path === '/lan.py' && opts?.lanPyPath) {
      try {
        const body = readFileSync(opts.lanPyPath, 'utf8')
        res.setHeader('Content-Type', 'text/x-python; charset=utf-8')
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(body)
      } catch {
        res.writeHead(500)
        res.end('lan.py 不可读')
      }
      return
    }
    if (path === '/dl/ce-windows-x64.exe' && opts?.ceExePath) {
      try {
        const buf = readFileSync(opts.ceExePath)
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', buf.length)
        if (req.method === 'HEAD') {
          // 防呆 B(install.sh)用 HEAD 拿 Content-Length 比对本地 size;不回 body 免浪费带宽
          res.end()
          return
        }
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
        if (req.method === 'HEAD') {
          // 防呆 B(install.sh)用 HEAD 拿 Content-Length 比对本地 size;不回 body 免浪费带宽
          res.end()
          return
        }
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
        if (req.method === 'HEAD') {
          // 防呆 B(install.sh)用 HEAD 拿 Content-Length 比对本地 size;不回 body 免浪费带宽
          res.end()
          return
        }
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end('ce-linux-arm64 不可读')
      }
      return
    }
    if (path === '/dl/ce-darwin-x64' && opts?.ceDarwinX64Path) {
      try {
        const buf = readFileSync(opts.ceDarwinX64Path)
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', buf.length)
        if (req.method === 'HEAD') {
          // 防呆 B(install.sh)用 HEAD 拿 Content-Length 比对本地 size;不回 body 免浪费带宽
          res.end()
          return
        }
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end('ce-darwin-x64 不可读')
      }
      return
    }
    if (path === '/dl/ce-darwin-arm64' && opts?.ceDarwinArm64Path) {
      try {
        const buf = readFileSync(opts.ceDarwinArm64Path)
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', buf.length)
        if (req.method === 'HEAD') {
          // 防呆 B(install.sh)用 HEAD 拿 Content-Length 比对本地 size;不回 body 免浪费带宽
          res.end()
          return
        }
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end('ce-darwin-arm64 不可读')
      }
      return
    }
    if (path === '/dl/sha256.txt' && opts?.sha256Path) {
      // 聚合 sha256 清单(install.sh/ps1 据此判更新,比 size 比对可靠:同 size 不同内容也检出)
      try {
        const body = readFileSync(opts.sha256Path, 'utf8')
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('sha256.txt 不可读')
      }
      return
    }
    // ── 插件工坊分发(工坊自成服务:手机 APK / ce 二进制都不携带脚手架,ce 从这里提货)──
    // 版本即内容:scaffold.tgz.sha256 的摘要就是版本标识,ce 装完把摘要写进工坊 marker,
    // 下次比对「远端摘要 vs 本机 marker」判新旧 → 不同则重装(幂等),无需独立版本号体系。
    if (path === '/workshop/scaffold.tgz' && opts?.workshopScaffoldPath) {
      serveStatic(res, req, opts.workshopScaffoldPath, 'application/gzip', 'scaffold.tgz')
      return
    }
    if (path === '/workshop/scaffold.tgz.sha256' && opts?.workshopScaffoldSha256Path) {
      serveStatic(res, req, opts.workshopScaffoldSha256Path, 'text/plain; charset=utf-8', 'scaffold.tgz.sha256')
      return
    }
    if (path === '/workshop/index.json' && opts?.workshopIndexPath) {
      // 货架清单(插件 id/名/版本/描述/工件 sha256);ce 拉它给手机工坊页陈列,及取 .ceplugin 工件
      serveStatic(res, req, opts.workshopIndexPath, 'application/json; charset=utf-8', 'index.json')
      return
    }
    if (path === '/hire' || path.startsWith('/hire/')) {
      // 雇佣网关访客页(单文件;code 从 path、房钥从 URL fragment —— fragment 不随请求上行,relay 不见钥)
      if (!opts?.hirePagePath || !opts?.hireNaclPath) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      try {
        const tpl = readFileSync(opts.hirePagePath, 'utf8')
        const body = tpl.replaceAll('__NACL_JS__', () => hireNaclJs(opts.hireNaclPath!)) // 函数替换:防 $ 序列被解释
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        // no-store:页面迭代期访客浏览器缓存旧版 = 「发了不显示」类玄学(2026-11-20 实测教训)
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(body)
      } catch {
        res.writeHead(500)
        res.end('hire page 不可读')
      }
      return
    }
    // ── 外部 agent 网关(2026-11-20 2-2;Pachat 三件套同形态)──────────────────────────
    if (path === '/guest/ce-guest.mjs' && opts?.guestClientPath && opts?.hireNaclPath) {
      try {
        const body = guestClientJs(opts.guestClientPath, opts.hireNaclPath)
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(body)
      } catch {
        res.writeHead(500)
        res.end('ce-guest.mjs 不可读')
      }
      return
    }
    if (path === '/guest/skill.md' && opts?.guestSkillPath) {
      serveStaticNoStore(res, req, opts.guestSkillPath, 'text/markdown; charset=utf-8', 'skill.md')
      return
    }
    if (path === '/guest/install.md' && opts?.guestInstallPath) {
      serveStaticNoStore(res, req, opts.guestInstallPath, 'text/markdown; charset=utf-8', 'install.md')
      return
    }
    if (path.startsWith('/guest/api/') && req.method === 'POST') {
      handleGuestApi(req, res, path.slice('/guest/api/'.length))
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

  // 注册限流:每 IP 每分钟上限,防匿名 cid 刷爆 cidToEntry/state(正常 ce 重连复用 cid,远低于上限)。
  const REGISTER_MAX = 20
  const registerHits = new Map<string, { t: number; n: number }>()
  const allowRegister = (ip: string): boolean => {
    const now = Date.now()
    const e = registerHits.get(ip)
    if (!e || now - e.t > 60_000) {
      registerHits.set(ip, { t: now, n: 1 })
      return true
    }
    e.n++
    return e.n <= REGISTER_MAX
  }

  // 雇佣码防爆破(Pachat 入口同款):错码 3 次/IP → 锁 24h。内存态(v1 取舍:relay 重启清零,
  // 码空间 32^8 足够大,24h 窗口内重启窗口可忽略;持久化是 v2)。
  const GUEST_FAIL_MAX = 3
  const GUEST_LOCK_MS = 24 * 60 * 60 * 1000
  const guestFails = new Map<string, { n: number; lockedUntil: number }>()
  const noteGuestFail = (ip: string): void => {
    const e = guestFails.get(ip) ?? { n: 0, lockedUntil: 0 }
    e.n++
    if (e.n >= GUEST_FAIL_MAX) e.lockedUntil = Date.now() + GUEST_LOCK_MS
    guestFails.set(ip, e)
  }

  // 心跳默认值(生产 30s/2;测试经 opts.heartbeat 注入小值)
  const hb = opts?.heartbeat ?? { intervalMs: 30_000, maxMissed: 2 }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // 畸形 upgrade 路径(如 "//")同样会让 new URL 抛 ERR_INVALID_URL → 崩进程,拒掉并记来源。
    let u: URL
    try {
      u = new URL(req.url ?? '/', 'http://relay')
    } catch {
      console.warn(`[relay] 畸形 ws 请求已拒: ${JSON.stringify(req.url)} from ${req.socket.remoteAddress}`)
      ws.close(1008, 'bad request')
      return
    }
    startHeartbeat(ws)
    const path = u.pathname.replace(/\/+$/, '') // 去尾斜杠:'/' → ''
    const token = u.searchParams.get('token') ?? ''

    if (path === '' || path === '/register') {
      // 注册限流:防匿名 cid 刷。正常 ce 重连复用 cid,远低于上限。
      const ip = req.socket.remoteAddress ?? '?'
      if (!allowRegister(ip)) {
        ws.send(JSON.stringify({ type: 'error', reason: '注册过于频繁,稍后再试' }), () => ws.close())
        return
      }
      // cli 注册:带 cid(机器标识)→ 中继按 cid 复用持久 sid/token(ce/中继重启后手机配对码仍有效)。
      // 旧 ce 无 cid → 临时匿名(每次新 sid,退化为旧行为)。
      const cid = u.searchParams.get('cid') ?? 'anon-' + Math.random().toString(36).slice(2, 12)
      const { sid, token: tok } = hub.register(cid, ws as RelayWS)
      ws.send(JSON.stringify({ type: 'registered', sid, token: tok }))
      wire(ws)
    } else if (path === '/guest') {
      // 雇佣网关访客通路(2026-11-19):code 走首帧 guest-hello(不进 URL/日志);防爆破错 3 次/IP 锁 24h。
      const ip = req.socket.remoteAddress ?? '?'
      const lock = guestFails.get(ip)
      if (lock && lock.lockedUntil > Date.now()) {
        ws.send(JSON.stringify({ type: 'error', reason: '尝试次数过多,已锁定 24 小时' }), () => ws.close())
        return
      }
      let helloed = false
      ws.on('message', (data) => {
        if (helloed) return // 已入房:交给 wire 的正式处理器
        helloed = true
        let code = ''
        try {
          code = String((JSON.parse(data.toString()) as { type?: string; code?: string }).code ?? '')
        } catch {
          /* 非 JSON:code 保持空,走同一条错码路径 */
        }
        const r = hub.guestJoin(ws as RelayWS, code)
        if (!r.ok) {
          noteGuestFail(ip)
          ws.send(JSON.stringify({ type: 'error', reason: r.error }), () => ws.close())
          return
        }
        guestFails.delete(ip) // 成功即清计数
        ws.send(JSON.stringify({ type: 'guest-joined', groupId: r.groupId, memberId: r.memberId, groupName: r.groupName }))
        wire(ws)
      })
    } else {
      // phone 加入:path = '/{sid}?token=xxx&phoneId=yyy'
      // phoneId 为手机持久身份(多 phone 共连路由用);老 phone 无 phoneId → 匿名(退化可用)
      const sid = path.startsWith('/') ? path.slice(1) : path
      const phoneId = u.searchParams.get('phoneId') ?? 'anon-' + Math.random().toString(36).slice(2, 12)
      const ok = hub.joinPhone(sid, token, ws as RelayWS, phoneId)
      if (ok) {
        console.log(`[relay] phone 加入 sid=${sid.slice(0, 8)}… phoneId=${phoneId}`)
        ws.send(JSON.stringify({ type: 'joined' }))
        wire(ws)
      } else {
        // 中继重启后 cli 尚未回注(session 不在)会走到这 —— 手机 2s 重试环会再进来,属正常
        // 恢复窗口;token 错也在此路。日志区分排查用(掉线恢复链路的观测点)。
        console.log(`[relay] phone 被拒(会话未建/token 错) sid=${sid.slice(0, 8)}… phoneId=${phoneId}`)
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
      // try/catch:hub 源头已防脏数据,这里再兜一道——回调内任何漏网异常都不让其冒泡成
      // uncaughtException 崩进程(殃及其他连接),记日志即止。
      try {
        hub.onMessage(ws as RelayWS, data.toString())
      } catch (e) {
        console.error('[relay] onMessage 异常(已兜底,不断连接):', e)
      }
    })
    ws.on('close', () => {
      try {
        hub.onClose(ws as RelayWS)
      } catch (e) {
        console.error('[relay] onClose 异常(已兜底):', e)
      }
    })
  }

  /** 挂协议层心跳:每 intervalMs ping,连续 maxMissed 次无 pong → terminate(死连接上 close
   *  握手完不成,必须 terminate 砍 TCP)→ 触发既有 close 处理器 → hub.onClose → cliLeft/phoneLeft。
   *  pong 归零;ping 发送抛错同判死(连接已坏)。close 时清定时器,防泄漏/防对死对象继续 ping。 */
  function startHeartbeat(ws: WebSocket): void {
    let missed = 0
    ws.on('pong', () => (missed = 0))
    const t = setInterval(() => {
      if (missed >= hb.maxMissed) {
        console.log('[relay] 心跳判死(terminate)')
        clearInterval(t)
        ws.terminate()
        return
      }
      try {
        ws.ping()
        missed++
      } catch {
        console.log('[relay] 心跳 ping 异常,判死(terminate)')
        clearInterval(t)
        ws.terminate()
      }
    }, hb.intervalMs)
    ws.on('close', () => clearInterval(t))
  }

  // ── 外部 agent HTTP API(2026-11-20 2-2)──────────────────────────────────────
  // 每分钟每 IP 上限(正常外部 agent 的轮询远低于此;防匿名刷)。
  const GUEST_API_MAX = 120
  const guestApiHits = new Map<string, { t: number; n: number }>()
  const allowGuestApi = (ip: string): boolean => {
    const now = Date.now()
    const e = guestApiHits.get(ip)
    if (!e || now - e.t > 60_000) {
      guestApiHits.set(ip, { t: now, n: 1 })
      return true
    }
    e.n++
    return e.n <= GUEST_API_MAX
  }
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let out = ''
      req.on('data', (c) => {
        out += c
        if (out.length > 1_000_000) {
          reject(new Error('body 过大'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(out))
      req.on('error', reject)
    })

  // 长轮询 waiter(按群挂;onPosted 唤醒)
  const waiters = new Map<string, Set<{ afterSeq: number; memberId: string; wake: () => void; revoke: () => void }>>()
  hub.groups?.onPosted((groupId, msg) => {
    for (const w of waiters.get(groupId) ?? []) {
      if (msg.seq > w.afterSeq && msg.from.memberId !== w.memberId) w.wake()
    }
  })
  hub.groups?.onMemberRemoved((groupId, memberId) => {
    for (const waiter of waiters.get(groupId) ?? []) {
      if (waiter.memberId === memberId) waiter.revoke()
    }
  })

  const handleGuestApi = (req: IncomingMessage, res: ServerResponse, kind: string): void => {
    const ip = req.socket.remoteAddress ?? '?'
    const json = (r: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(r))
    }
    void (async () => {
      if (!allowGuestApi(ip)) {
        json({ ok: false, error: { code: 'rate_limited', message: '请求太频繁,稍后再试' } })
        return
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>
      } catch {
        json({ ok: false, error: { code: 'no_group', message: 'body 不是合法 JSON' } })
        return
      }
      const registry = hub.groups
      if (!registry) {
        json({ ok: false, error: { code: 'no_group', message: '群注册表未启用' } })
        return
      }
      const str = (v: unknown): string => (typeof v === 'string' ? v : '')
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const reqId = 'h_' + Math.random().toString(36).slice(2, 10)
      if (kind === 'pair') {
        const lock = guestFails.get(ip)
        if (lock && lock.lockedUntil > Date.now()) {
          json({ ok: false, error: { code: 'locked', message: '尝试次数过多,已锁定 24 小时' } })
          return
        }
        const shim = { send: () => {} }
        const r = registry.guestHelloAgent(str(body.code), str(body.name), body.platform ? str(body.platform) : undefined, shim)
        registry.onClose(shim)
        if (!r.ok) {
          noteGuestFail(ip)
          json({ ok: false, error: { code: 'code_invalid', message: r.error } })
          return
        }
        guestFails.delete(ip)
        const sync = registry.callAsGuest({ op: 'group-sync', groupId: r.groupId, reqId, payload: { groupId: r.groupId, memberId: r.memberId, afterSeq: 0, markRead: false, limit: 1 } })
        const seq = (sync.data as { seq?: number } | undefined)?.seq ?? 0
        json({ ok: true, groupId: r.groupId, memberId: r.memberId, groupName: r.groupName, seq })
        return
      }
      const seat = registry.resolveAgentSeat(str(body.code), str(body.memberId))
      if (!seat.ok) {
        json({ ok: false, error: { code: 'code_invalid', message: seat.error } })
        return
      }
      if (kind === 'sync') {
        json(registry.callAsGuest({ op: 'group-sync', groupId: seat.groupId, reqId, payload: { groupId: seat.groupId, memberId: seat.memberId, afterSeq: num(body.afterSeq) ?? 0, markRead: body.markRead !== false, limit: num(body.limit) ?? 200 } }))
        return
      }
      if (kind === 'post') {
        json(registry.callAsGuest({ op: 'group-post', groupId: seat.groupId, reqId, payload: { ct: str(body.ct), opKey: str(body.opKey) || undefined, readUpTo: num(body.readUpTo) ?? 0, replyTo: num(body.replyTo), mentions: Array.isArray(body.mentions) ? (body.mentions as unknown[]).map(String) : undefined, memberId: seat.memberId } }))
        return
      }
      if (kind === 'ack') {
        json(registry.callAsGuest({ op: 'group-ack', groupId: seat.groupId, reqId, payload: { groupId: seat.groupId, memberId: seat.memberId, upToSeq: num(body.upToSeq) ?? 0 } }))
        return
      }
      if (kind === 'leave') {
        json(registry.callAsGuest({ op: 'group-leave', groupId: seat.groupId, reqId, payload: { groupId: seat.groupId, memberId: seat.memberId } }))
        return
      }
      if (kind === 'inbox') {
        const afterSeq = num(body.afterSeq) ?? 0
        const waitSec = Math.min(Math.max(num(body.waitSec) ?? 0, 0), 25)
        const check = (): { idle: boolean; msgs?: unknown; seq?: number } => {
          const r = registry.callAsGuest({ op: 'group-sync', groupId: seat.groupId, reqId: 'h_' + Math.random().toString(36).slice(2, 10), payload: { groupId: seat.groupId, memberId: seat.memberId, afterSeq, markRead: false, limit: 200 } })
          if (!r.ok) return { idle: true }
          const all = (r.data as { msgs?: Array<{ from: { memberId: string } }>; seq: number }).msgs ?? []
          const fresh = all.filter((m) => m.from.memberId !== seat.memberId)
          return fresh.length ? { idle: false, msgs: all, seq: (r.data as { seq: number }).seq } : { idle: true }
        }
        const first = check()
        if (!first.idle || waitSec <= 0) {
          json({ ok: true, data: first })
          return
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.get(seat.groupId)?.delete(waiter)
            json({ ok: true, data: { idle: true } })
            resolve()
          }, waitSec * 1000)
          const waiter = {
            afterSeq,
            memberId: seat.memberId,
            wake: () => {
              clearTimeout(timer)
              waiters.get(seat.groupId)?.delete(waiter)
              json({ ok: true, data: check() })
              resolve()
            },
            revoke: () => {
              clearTimeout(timer)
              waiters.get(seat.groupId)?.delete(waiter)
              json({ ok: false, error: { code: 'not_member', message: '外部 agent 接入已被撤销' } })
              resolve()
            },
          }
          let set = waiters.get(seat.groupId)
          if (!set) {
            set = new Set()
            waiters.set(seat.groupId, set)
          }
          set.add(waiter)
        })
        return
      }
      json({ ok: false, error: { code: 'no_group', message: `未知 api ${kind}` } })
    })().catch(() => {
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'no_group', message: '内部错误' } }))
      } catch {
        /* 已结束 */
      }
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
