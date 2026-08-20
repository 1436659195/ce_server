# Jupyter 地址落盘固化 + listTerminals 短重试 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭 `~/.ce/jupyter.json` 落盘 `localhost` 造成的 Mac 双栈歧义(配对瞬间 404 竞态的入口),并给 listTerminals 加 300ms×1 短重试兜住剩余瞬态。

**Architecture:** 两个独立小修。①把 `toLoopback` 从 main.ts(不可被测试 import,顶层跑 main())迁到 jupyter-detect.ts 导出 + 单测,落盘行改用它;②在 bridge.ts 加 `listTerminalsRetry(client, opts?)`(重试后仍失败则抛),main.ts RPC 分发处换用它,降级逻辑留在调用点。

**Tech Stack:** TypeScript + bun test。测试风格沿用 `test/bridge.test.ts` 的 noopClient spread 模式。

**Spec:** `docs/superpowers/specs/2026-08-20-jupyter-loopback-retry-design.md`

## Global Constraints

- 重试参数固定:1 次重试、300ms 间隔(方案 A);sleep 可注入(测试传空 sleep 免等)。
- 只重试 listTerminals;createTerminal 不加重试(失败原样报用户)。
- 读回路径(main.ts:221)的 `toLoopback(saved.url)` 保留(防御旧存量 localhost 文件)。
- 降级行为不变:最终失败 → 空列表 + 错误日志,日志文案改含 `重试后仍失败`。
- 显式 `--jupyter-url` 路径不落盘、不受影响。

---

### Task 1: toLoopback 迁移 + 落盘固化 127.0.0.1

**Files:**
- Modify: `src/cli/jupyter-detect.ts`(新增导出 toLoopback)
- Modify: `src/cli/main.ts`(删本地 toLoopback 定义改 import;落盘行 `main.ts:264` 用 `toLoopback(server.url)`)
- Test: `test/jupyter-detect.test.ts`(追加)

**Interfaces:**
- Consumes: 无(首个任务)。
- Produces: `export function toLoopback(url: string): string`(jupyter-detect.ts)—— Task 2 及后续均可用;main.ts 从 `./jupyter-detect` import 它(与现有 `import { detectServers, isAlive } from './jupyter-detect'` 合并)。

- [ ] **Step 1: 写失败测试**

在 `test/jupyter-detect.test.ts` 末尾追加:

```ts
// ── toLoopback:localhost → 127.0.0.1(Mac 上 Bun 解析 localhost→::1 而 Jupyter 终端路由 ──
//    在 v4/v6 双栈间有瞬时差异;统一 127.0.0.1 消灭歧义) ─────────────────────────────────
import { toLoopback } from '../src/cli/jupyter-detect'

test('toLoopback:localhost 替换为 127.0.0.1', () => {
  expect(toLoopback('http://localhost:53358')).toBe('http://127.0.0.1:53358')
})

test('toLoopback:已是 127.0.0.1 不变', () => {
  expect(toLoopback('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888')
})

test('toLoopback:其他 hostname 不动(用户显式指定的外部 jupyter)', () => {
  expect(toLoopback('http://192.168.1.5:8888')).toBe('http://192.168.1.5:8888')
  expect(toLoopback('http://myjupyter.example.com:8888')).toBe('http://myjupyter.example.com:8888')
})

test('toLoopback:端口后带边界字符不误伤(只替换 host 段)', () => {
  expect(toLoopback('http://localhost:8888/lab')).toBe('http://127.0.0.1:8888/lab')
  expect(toLoopback('http://localhostx:8888')).toBe('http://localhostx:8888') // localhost 后是 x 非边界,不改
})
```

注意:import 语句放文件顶部与现有 import 合并,不留在用例处。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/jupyter-detect.test.ts`
Expected: FAIL —— `toLoopback` 不是 `jupyter-detect` 的导出(模块没有该 export)。

- [ ] **Step 3: 实现 —— 迁移函数**

(a) `src/cli/jupyter-detect.ts` 末尾追加(实现从 main.ts:176-180 原样搬,注释带上):

```ts
/** baseUrl 里 `localhost` → `127.0.0.1`:Bun 偶把 localhost 解析成 IPv6 `::1`,而 Jupyter 默认只听
 *  IPv4 loopback → fetch 报 "Unable to connect"。127.0.0.1 无歧义、Jupyter 一定在听(它打的 URL 含 127.0.0.1)。
 *  Mac 双栈监听下 v4/v6 在扩展路由上有瞬时差异(配对瞬间 404 竞态入口),统一 v4 消灭歧义。 */
export function toLoopback(url: string): string {
  return url.replace(/:\/\/localhost\b/, '://127.0.0.1')
}
```

(b) `src/cli/main.ts`:删除本地 `toLoopback` 定义(约 176-180 行,连同其注释),把顶部
`import { detectServers, isAlive } from './jupyter-detect'` 改为
`import { detectServers, isAlive, toLoopback } from './jupyter-detect'`。

(c) `src/cli/main.ts:264` 落盘行,Jupyter 地址固化 v4:

```ts
      writeFileSync(join(homedir(), '.ce', 'jupyter.json'), JSON.stringify({ url: toLoopback(server.url), token: server.token, root }))
```

(注释加一行:`// 落盘即固化 127.0.0.1(不落 localhost):isAlive 验活与下次复用全走 v4,消灭 Mac 双栈歧义`)

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/jupyter-detect.test.ts && bun test`
Expected: 新 4 例 PASS;全量无回归(145+4)。

- [ ] **Step 5: Commit**

```bash
git add src/cli/jupyter-detect.ts src/cli/main.ts test/jupyter-detect.test.ts
git commit -m "fix(cli): jupyter.json 落盘固化 127.0.0.1 —— 消灭 localhost 双栈歧义(配对瞬间 404 竞态入口)"
```

---

### Task 2: listTerminalsRetry —— 300ms×1 重试

**Files:**
- Modify: `src/cli/bridge.ts`(新增导出 listTerminalsRetry)
- Modify: `src/cli/main.ts:849-861`(RPC 分发处换用)
- Test: `test/bridge.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 无依赖(独立)。`JupyterClient.listTerminals(): Promise<RawTerminal[]>`(bridge.ts 已有)。
- Produces: `export async function listTerminalsRetry(client: JupyterClient, opts?: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<{ name: string; last_activity?: string }[]>` —— 失败重试(默认 1 次/300ms),重试后仍失败抛最后错误。main.ts 调用点拿它替换裸 `jupyter.listTerminals()`。

- [ ] **Step 1: 写失败测试**

在 `test/bridge.test.ts` 末尾追加(noopClient 已在文件顶部):

```ts
// ── listTerminalsRetry:首错 300ms×1 重试(治配对瞬间 Jupyter 瞬态 404;Mac 侧实测同进程 ──
//    下一秒即恢复) ────────────────────────────────────────────────────────────────────────
import { listTerminalsRetry } from '../src/cli/bridge'

const noSleep = async (): Promise<void> => {} // 注入空 sleep,测试不等 300ms

test('listTerminalsRetry:首抛次成 → 返回数据(重试兜住瞬态)', async () => {
  let n = 0
  const client: JupyterClient = {
    ...noopClient,
    async listTerminals() {
      if (++n === 1) throw new Error('列终端失败:404 Not Found')
      return [{ name: 't1' }, { name: 't2' }]
    },
  }
  const res = await listTerminalsRetry(client, { sleep: noSleep })
  expect(res).toEqual([{ name: 't1' }, { name: 't2' }])
  expect(n).toBe(2)
})

test('listTerminalsRetry:两次都抛 → 抛最后错误(降级留给调用点)', async () => {
  const client: JupyterClient = {
    ...noopClient,
    async listTerminals() {
      throw new Error('列终端失败:404 Not Found')
    },
  }
  await expect(listTerminalsRetry(client, { sleep: noSleep })).rejects.toThrow('列终端失败:404')
})

test('listTerminalsRetry:首次成功不重试', async () => {
  let n = 0
  const client: JupyterClient = {
    ...noopClient,
    async listTerminals() {
      n++
      return [{ name: 'ok' }]
    },
  }
  const res = await listTerminalsRetry(client, { sleep: noSleep })
  expect(res).toEqual([{ name: 'ok' }])
  expect(n).toBe(1)
})

test('listTerminalsRetry:重试间隔确实传给 sleep(默认 300ms)', async () => {
  const got: number[] = []
  const sleep = async (ms: number): Promise<void> => {
    got.push(ms)
  }
  const client: JupyterClient = {
    ...noopClient,
    async listTerminals() {
      throw new Error('x')
    },
  }
  await listTerminalsRetry(client, { sleep }).catch(() => {})
  expect(got).toEqual([300])
})
```

注意:`JupyterClient` 类型已在文件顶部 import;新增的 `listTerminalsRetry` import 合并进顶部现有 bridge import 行。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/bridge.test.ts`
Expected: FAIL —— `listTerminalsRetry` 未导出。

- [ ] **Step 3: 实现**

(a) `src/cli/bridge.ts` 在 `handleRpc` 之前(或 `makeJupyterClient` 之后均可,靠近使用处)加:

```ts
/**
 * listTerminals 带短重试:失败 → delayMs 后再试 retries 次,仍败抛最后错误。
 * 治「手机(重)配对瞬间 Jupyter /api/terminals 瞬态 404」(Mac 实测同进程同 token 下一秒即 200,
 * 首错即降级空列表会让手机「+」面板闪空)。降级(空列表+日志)留在调用点(main.ts RPC 分发)。
 * sleep 注入仅为测试加速;默认 setTimeout。只包 listTerminals —— createTerminal 失败
 * 原样报用户更诚实,不吞错重试。
 */
export async function listTerminalsRetry(
  client: JupyterClient,
  opts: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ name: string; last_activity?: string }[]> {
  const retries = opts.retries ?? 1
  const delayMs = opts.delayMs ?? 300
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(delayMs)
    try {
      return await client.listTerminals()
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}
```

(b) `src/cli/main.ts:849-861` RPC 分发处,把裸调用换掉(main.ts 顶部 bridge import 行加 `listTerminalsRetry`):

```ts
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
```

(下方 managed/prune 逻辑不动。)

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/bridge.test.ts && bun test`
Expected: 新 4 例 PASS;全量无回归。

- [ ] **Step 5: Commit**

```bash
git add src/cli/bridge.ts src/cli/main.ts test/bridge.test.ts
git commit -m "fix(cli): listTerminals 首错 300ms×1 重试 —— 兜住配对瞬间 Jupyter 瞬态 404"
```

---

### Task 3: 构建分发(生产)

**Files:**
- Modify: 无代码。运维:重建二进制(Windows/Linux/macOS 全平台),relay 不需重启(改动只在 ce 客户端)。

**Interfaces:**
- Consumes: Task 1 + Task 2 的代码。
- Produces: 新 dist/ + sha256.txt;Mac/Windows 重跑一行安装命令即自动更新。

- [ ] **Step 1: 重建全平台二进制**

Run: `bash scripts/build-binaries.sh`
Expected: dist/ 五个产物 + sha256.txt 时间戳为当前。

- [ ] **Step 2: 真机验证(Mac)**

Mac 重跑一行安装命令(会自动停旧 ce → 覆盖 → 重启)。预期:
- ce 日志出现 `[ce] 复用上次 Jupyter:http://localhost:53358`(存量文件,读回仍转换,兼容)
- 手机重配对 + 建「+」面板刷新:不再闪 404/空列表
- 可选坐实:Mac 上 `cat ~/.ce/jupyter.json` 在下次自启后变 `127.0.0.1`(存量收敛需等 Jupyter 换代;不强制)
