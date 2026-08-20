# ce↔relay WebSocket 心跳 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ce 客户端与 relay 服务端互相按 30s 间隔发协议层 ping/pong,连续 2 次无 pong 即 terminate 死连接,使 half-open 断线在 ≤90s 内被发现并触发已有重连/通知链路。

**Architecture:** 两侧各加一个与连接生命周期绑定的小心跳状态机(setInterval + missed 计数 + terminate)。relay 侧经 `createRelayServer` 的 `heartbeat` opts 注入参数(生产默认 30s/2,测试传小值);ce 侧抽成独立小类 `Heartbeat`(便于假 WS 单测),在 `connect()` 成功后启动、close 后清理。零协议/零 app 改动。

**Tech Stack:** TypeScript + `ws@8.21`(注意:8.21 **无** `heartbeatInterval` 参数,需手动 ping;客户端支持 `autoPong:false`)、bun test(现有 `bun test`)。

**Spec:** `docs/superpowers/specs/2026-08-20-ws-heartbeat-design.md`

## Global Constraints

- 心跳默认参数:`intervalMs = 30_000`,`maxMissed = 2`(两处一致,写死为默认值)。
- 判死动作必须是 `terminate()`,不是 `close()`(死连接上 close 握手永远完不成)。
- ping 发送抛错按"判死"同路径处理(terminate → close 事件)。
- 不加环境变量/配置文件项;`heartbeat` opts 仅为测试注入。
- 不改 `src/shared/frame.ts` 协议、不改 hub 路由逻辑、不改 app。
- 日志:ce 侧判死打 `[ce] 心跳超时,重连`;relay 侧判死打 `[relay] 心跳判死(terminate)`(hub 的 wsMeta 私有,relay 层拿不到 role,不打)。
- 测试全部走 `bun test`,relay 测试沿用 `test/relay.test.ts` 的真连接风格(`createRelayServer(new Hub())` + `listen(0)` + `connect()`/`shutdown()` 辅助)。

---

### Task 1: relay 侧心跳(判死 + 不误杀)

**Files:**
- Modify: `src/relay/server.ts`(wss.on('connection') 处 + opts 类型)
- Test: `test/relay.test.ts`(文件末尾追加,复用文件顶部已有的 `connect`/`waitForJson`/`shutdown` 辅助)

**Interfaces:**
- Consumes: 现有 `createRelayServer(hub, opts)`、`Hub`(`hub.onClose` 在连接关闭时被 `wire()` 的 close 处理器调用)。
- Produces: `createRelayServer` opts 新增 `heartbeat?: { intervalMs: number; maxMissed: number }`,缺省 `{ intervalMs: 30_000, maxMissed: 2 }`。Task 2 的 ce 侧不依赖它(纯客户端行为)。

- [ ] **Step 1: 写失败测试(判死:沉默客户端被清)**

在 `test/relay.test.ts` 末尾追加(复用文件顶部的 `connect`/`waitForJson`/`shutdown`):

```ts
// ── 心跳:沉默客户端被判死 ───────────────────────────────────────────────
test('心跳:客户端不回 pong → 判死 terminate,cli 置空 + phone 收到 cliLeft', async () => {
  // autoPong:false 模拟 half-open 死连接:能收 ping 但永不回 pong
  const { server, close } = createRelayServer(new Hub(), {
    heartbeat: { intervalMs: 50, maxMissed: 2 },
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base = `ws://127.0.0.1:${port}`

  const cli = new WebSocket(base + '/?cid=hb1', { autoPong: false })
  cli.on('error', () => {})
  const reg = await waitForJson(cli, (m) => m.type === 'registered')

  const phone = connect(`${base}/${reg.sid}?token=${reg.token}`)
  await waitForJson(phone, (m) => m.type === 'joined')

  // 2 次无 pong(50ms × 2 + 余量)→ 服务端 terminate cli → hub.onClose → phone 收 cliLeft
  const left = waitForJson(phone, (m) => m.type === 'cliLeft')
  cli.on('close', (code) => {
    // terminate 的 close code 是 1006(异常断),不是 1000(正常关)
    expect([1006, 1000]).toContain(code)
  })
  expect(await left).toEqual({ type: 'cliLeft' })

  await shutdown(close, phone) // cli 已被服务端 terminate,只关 phone
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/relay.test.ts`
Expected: FAIL —— 新测试超时(默认 5s test timeout)或 cliLeft 等不到:服务端不 ping,沉默客户端永远不被判死。注意观察是**新测试**失败、原有测试全过。

- [ ] **Step 3: 实现 relay 心跳**

`src/relay/server.ts` 两处改动:

(a) opts 类型加字段(现有 opts 对象里,`publicUrl?: string` 之后):

```ts
    publicUrl?: string // 对外中继 ws 地址(防 Host 头注入 install 脚本);不配则回退请求 Host
    /** 心跳:每 intervalMs ping 一次,连续 maxMissed 次无 pong 判死 terminate。缺省 30s/2。
     *  测试注入小值加速;治 half-open 死连接(断网/热点切换/NAT 超时,双方无数据则永不发现)。 */
    heartbeat?: { intervalMs: number; maxMissed: number }
```

(b) `wss.on('connection', ...)` 回调体**最前面**(在 `const u = new URL(...)` 之前)插入心跳挂载,并在 `wire(ws)` 定义之后(文件底部 `return` 之前)加辅助函数:

```ts
  // 心跳默认值(生产 30s/2;测试经 opts.heartbeat 注入小值)
  const hb = opts?.heartbeat ?? { intervalMs: 30_000, maxMissed: 2 }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    startHeartbeat(ws)
    const u = new URL(req.url ?? '/', 'http://relay')
    // …原有代码不动…
```

辅助函数(放在 `function wire(ws: WebSocket): void` 后面,风格对齐):

```ts
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
```

(hub 的 wsMeta 私有,relay 层拿不到 role,日志统一打 `[relay] 心跳判死(terminate)`。)

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/relay.test.ts`
Expected: 全部 PASS(含原有测试 + 新判死测试)。

- [ ] **Step 5: 写第二个测试(不误杀)并验证**

```ts
// ── 心跳:正常回 pong 不误杀 ───────────────────────────────────────────
test('心跳:正常客户端(自动回 pong)跨多个心跳周期仍活', async () => {
  const { server, close } = createRelayServer(new Hub(), {
    heartbeat: { intervalMs: 30, maxMissed: 2 }, // 30ms × 5 周期 = 150ms
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const cli = connect(`ws://127.0.0.1:${port}/?cid=hb2`) // connect() 辅助:默认 autoPong 开
  const reg = await waitForJson(cli, (m) => m.type === 'registered')
  expect(reg.sid).toBeTruthy()

  // 跨 5+ 个心跳周期(默认 ws 客户端自动回 pong);若误杀,close 事件触发、发送抛错
  await new Promise((r) => setTimeout(r, 250))
  expect(cli.readyState).toBe(WebSocket.OPEN) // 仍活 = 未被误杀

  await shutdown(close, cli)
})
```

Run: `bun test test/relay.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量回归 + 提交**

Run: `bun test`
Expected: 全过(如有无关 flaky,重跑确认)。

```bash
git add src/relay/server.ts test/relay.test.ts
git commit -m "feat(relay): 协议层心跳 —— 沉默连接 30s×2 判死 terminate,治 half-open 死连接"
```

---

### Task 2: ce 侧心跳(Heartbeat 小类 + 接入 connect)

**Files:**
- Create: `src/cli/heartbeat.ts`
- Modify: `src/cli/main.ts:1084-1125`(connect 函数)
- Test: `test/heartbeat.test.ts`(Create)

**Interfaces:**
- Consumes: `ws.WebSocket` 的 `ping()`/`'pong'`/`terminate()`;Task 1 已在 relay 侧回 pong(server ping → ws 客户端自动回 pong,无需 ce 代码参与)。
- Produces: `class Heartbeat { constructor(ws: { ping(): void; terminate(): void; on(ev: 'pong'|'close', fn: () => void): void }, opts?: { intervalMs?: number; maxMissed?: number }); stop(): void }` —— main.ts 接入用。

- [ ] **Step 1: 写失败测试**

`test/heartbeat.test.ts`(新建):

```ts
import { test, expect } from 'bun:test'
import { Heartbeat } from '../src/cli/heartbeat'

/** 假 WS:记录 ping/terminate,可手动派发 pong/close。 */
class FakeWs {
  pings = 0
  terminated = false
  stopped = false
  private pongFns: (() => void)[] = []
  private closeFns: (() => void)[] = []
  ping(): void {
    this.pings++
  }
  terminate(): void {
    this.terminated = true
    this.closeFns.forEach((f) => f())
  }
  on(ev: 'pong' | 'close', fn: () => void): void {
    if (ev === 'pong') this.pongFns.push(fn)
    else this.closeFns.push(fn)
  }
  emitPong(): void {
    this.pongFns.forEach((f) => f())
  }
  emitClose(): void {
    this.closeFns.forEach((f) => f())
  }
}

const fast = { intervalMs: 10, maxMissed: 2 }
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('连续 2 次无 pong → terminate', async () => {
  const ws = new FakeWs()
  new Heartbeat(ws, fast) // eslint-disable-line @typescript-eslint/no-unused-vars
  await tick(80) // 10ms 间隔,2 次判死在 ~30ms 内
  expect(ws.terminated).toBe(true)
})

test('收到 pong 归零,不误杀', async () => {
  const ws = new FakeWs()
  new Heartbeat(ws, fast)
  await tick(15)
  ws.emitPong() // 第 1 次 ping 后回 pong
  await tick(15)
  ws.emitPong()
  await tick(15)
  ws.emitPong()
  expect(ws.terminated).toBe(false)
  expect(ws.pings).toBeGreaterThanOrEqual(3) // 一直在正常心跳
})

test('close 后定时器已清(stop 幂等)', async () => {
  const ws = new FakeWs()
  const hb = new Heartbeat(ws, fast)
  hb.stop()
  const pingsAtStop = ws.pings
  await tick(50)
  expect(ws.pings).toBe(pingsAtStop) // 不再 ping
  expect(ws.terminated).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/heartbeat.test.ts`
Expected: FAIL —— `Cannot find module '../src/cli/heartbeat'`。

- [ ] **Step 3: 实现 Heartbeat 类**

`src/cli/heartbeat.ts`(新建):

```ts
/**
 * ce↔中继 协议层心跳:每 intervalMs 发 ws.ping(),连续 maxMissed 次无 pong → terminate。
 * 治 half-open 死连接(热点断换/NAT 超时/睡眠唤醒:TCP 已断但 FIN/RST 未达,close 永不触发,
 * ce 抱死连接永不重连 —— 2026-08-19 Windows 被控机失联根因)。terminate 触发既有 close
 * 处理器 → 指数退避重连 → 带 cid 回原 sid,手机配对不失效。
 * 依赖对端为标准 WS(relay 用 ws 库自动回 pong;ws 服务端 ping 时本端也自动回 pong)。
 */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private missed = 0

  constructor(
    private ws: {
      ping(): void
      terminate(): void
      on(ev: 'pong' | 'close', fn: () => void): void
    },
    private opts: { intervalMs?: number; maxMissed?: number } = {}
  ) {
    this.ws.on('pong', () => (this.missed = 0))
    this.ws.on('close', () => this.stop())
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 30_000)
  }

  private tick(): void {
    const maxMissed = this.opts.maxMissed ?? 2
    if (this.missed >= maxMissed) {
      console.log('[ce] 心跳超时,重连')
      this.stop()
      this.ws.terminate()
      return
    }
    try {
      this.ws.ping()
      this.missed++
    } catch {
      // 发送抛错 = 连接已坏,同判死
      console.log('[ce] 心跳 ping 异常,重连')
      this.stop()
      this.ws.terminate()
    }
  }

  /** 停止心跳(连接关闭/主动断开时调;幂等)。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/heartbeat.test.ts`
Expected: 3 个测试全 PASS。

- [ ] **Step 5: 接入 main.ts connect()**

`src/cli/main.ts` 两处:

(a) 文件顶部 import 区(`import WebSocket ... from 'ws'` 之后任意相邻位置):

```ts
import { Heartbeat } from './heartbeat'
```

(b) `connect()` 内(`src/cli/main.ts:1084` 起),`ws = new WebSocket(...)` 之后、`ws.on('message', function h(raw)` 之前插入:

```ts
    // 协议层心跳:30s ping × 2 次无 pong → terminate → 下方 close 处理器接管重连。
    // 治 half-open(热点断换/NAT 超时:TCP 死但 close 不来,永不重连)。
    let hb: Heartbeat | null = new Heartbeat(ws)
```

(c) 现有 `ws.on('close', ...)` 回调体**第一行**(`console.log(\`[ce] 中继断开...\`)` 之前)插入:

```ts
      hb?.stop() // 心跳随连接结束;hb 置 null 防重连前旧定时器误触发 terminate
      hb = null
```

注意:心跳在 `new WebSocket` 后立即启动(不必等 `registered`)——CONNECTING 状态 ping 会抛错?**不会**:`ws` 的 ping() 在 OPEN 前调用抛 `InvalidStateError`,会被 tick 的 try/catch 捕获计入 missed。但 CONNECTING 通常 <1s 而 interval 30s,实际首个 tick 时早已 OPEN。保持"构造即启动"的简单性,不做 CONNECTING 特判(YAGNI)。

- [ ] **Step 6: 全量回归 + 提交**

Run: `bun test`
Expected: 全过。

```bash
git add src/cli/heartbeat.ts src/cli/main.ts test/heartbeat.test.ts
git commit -m "feat(cli): ce 侧协议层心跳 —— half-open 死连接 ≤90s 自愈重连"
```

---

### Task 3: 部署验证(生产)

**Files:**
- Modify: 无代码。运维动作:重新构建分发 ce 二进制、重启 ce-relay。

**Interfaces:**
- Consumes: Task 1(relay 心跳生效需重启 ce-relay)、Task 2(ce 心跳生效需重编分发 Windows/Linux 二进制,install 脚本按 sha256 自动更新)。

- [ ] **Step 1: 重建 ce 二进制(Windows + Linux)**

Run: `bash scripts/build-binaries.sh`(现有构建脚本,产出 dist/ce-windows-x64.exe 等 + sha256.txt)
Expected: 构建成功,`ls -la dist/ | grep ce-` 时间戳为当前。

- [ ] **Step 2: 重启 relay 并观察日志**

```bash
systemctl restart ce-relay
journalctl -u ce-relay -f --since "1 min ago"
```

Expected: `[relay] listening on 127.0.0.1:8606 (ws)`,无报错;本机 ce-agent 自动重连(`[ce] 已连中继,sid=…`)。

- [ ] **Step 3: 真机验证 half-open 自愈(复现 2026-08-19 场景)**

Windows 机装新版 ce(一行安装命令,install.ps1 按 sha256 自动更新)→ 连手机热点正常连上 → **关热点 2 分钟 → 重开热点**。
Expected(对照日志):
- relay:`[relay] 心跳判死(terminate)` 出现在热点断后 ≤90s,紧接 phone 收 cliLeft(app 端服务器转"等待/离线"态)。
- Windows ce:`[ce] 心跳超时,重连` → 热点恢复后 `[ce] 已连中继,sid=<同一 sid>`。
- 手机:点该服务器重连(或等待窗口内自动探活成功)→ 终端恢复,无需重扫配对码/PIN。

- [ ] **Step 4: 验证提交(如有日志/文档补充)**

无代码变更则无提交。若发现修复性问题,回 Task 1/2 修完后重新走本任务。
