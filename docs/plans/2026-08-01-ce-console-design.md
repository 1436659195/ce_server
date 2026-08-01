# ce 控制台(console)设计

> 2026-08-01。把被控 ce 从「单进程前台跑 + 输出日志」升级成「守护进程 + TUI 控制台」。
> 设计原则:**最少代码、最大化复用现有代码、懒人优雅**。

## 背景 / 动机

ce 目前是单进程前台跑,被控机用户 `curl|sh` 装完后只能盯着日志。痛点:
- **忘 PIN 无从查**:PIN 只在启动输出里,不存盘;忘了解决办法只有重启重设。
- **看不到状态**:连接了几台手机、当前配置、版本,都没有查询口子。
- **不能启停 / 更新**:换版本要手动 kill + 重新拉取安装;没法后台常驻。

目标:加一个**交互式 TUI 控制台**,daemon 后台常驻干活,`ce` 进控制台管理它(启停/状态/更新/PIN/连接数/白名单/日志/doctor/配置)。

## 目标 / 非目标(YAGNI)

- ✅ **核心**:启停/重启 daemon、查版本、检查 + 一键更新、查 PIN、查在线手机数
- ✅ **实用扩展**:TUI 改 PIN、白名单管理(看/踢)、日志查看、doctor 健康检查、配置查看
- ❌ **首版不做**(高级档,留后续):轮换配对凭证、连接诊断 ping、开机自启管理

## 架构

**双进程 + 本地 HTTP IPC**,单 binary 双角色:

```
┌─────────────────┐     本地 HTTP      ┌──────────────────┐
│  ce 控制台(TUI) │ ◄──────────────► │  ce 守护进程(daemon)│
│  ce (无 flag)    │  fetch /control   │  ce --daemon       │
│  readline+ANSI   │                   │  = 现有 main.ts    │
└─────────────────┘                    └──────────────────┘
```

- **同一个 `ce` 文件,按 flag 分角色**:`ce` → 控制台;`ce --daemon` → 守护进程。
- console 启动 daemon = 后台 `spawn` 自己(`ce --daemon`,detached,退出终端不死)。
- IPC = **复用 ce 现有 hook 端点**(`Bun.serve` 127.0.0.1),上面加 `/control/*` 路由。不新建 server、不引 socket 库(跨平台麻烦)。

## 组件与改动

### 1. `main.ts` 入口分叉(新增 ~5 行)
```ts
if (arg('daemon')) runDaemon()   // = 现有 main() 全部逻辑(+控制路由 + daemon.json + 崩溃兜底)
else runConsole()                // → console.ts
```

### 2. `/control` 路由(加在现有 hook `Bun.serve`,~80 行)
现有 fetch handler 只处理 `POST /hook`;加路由分发,新增:
| 路由 | 作用 | 数据来源(全复用) |
|---|---|---|
| `GET /control/state` | 状态总览 | `currentPin`、`phoneKeys.size`、`authorized`、版本、config |
| `POST /control/stop` | 优雅退出 | 现有 SIGINT `stop` |
| `POST /control/restart` | 重启 daemon | stop + spawn 新自己 |
| `POST /control/update` | 检查+更新 | 见下「更新流程」 |
| `POST /control/pin` `{pin}` | 改 PIN | 改内存 `currentPin` |
| `POST /control/unpair` `{phoneId}` | 踢手机 | `loadAuthorized` 改写 |
| `GET /control/logs?n=` | 读日志 | 日志文件 tail |
| `GET /control/doctor` | 健康检查 | `detectServers`/`resolveClaudeBin`/ws 状态 |

### 3. `~/.ce/daemon.json`(端口发现)
daemon 启动写 `{port, pid, version, startAt}`;console 读它 → `fetch http://127.0.0.1:{port}/control/*`。console 检测 pid 不活 = daemon 没跑 → 提示启动。

### 4. `src/cli/console.ts`(新增,TUI,~150 行,零依赖)
- `readline` 单键菜单 + ANSI 画框(状态面板 + 操作键)
- `fetch` daemon `/control/state` 刷新状态;按键 → POST 对应路由
- daemon 不在 → 显示「未运行,[s] 启动」→ 启动后连上

### 5. 更新流程(daemon 内 `update()`,~50 行)
1. `fetch` 中继 `/dl/sha256.txt` → 取本平台 hash
2. 比对本地 `process.execPath` 的 sha256
3. 不同 → 下载 `/dl/ce-{platform}` → **验 sha256** → 替换 binary
   - Linux:直接覆盖;Windows:先重命名旧版再写(避锁)
4. daemon 退出 → console 检测掉线 → 重启 → 新版起来

### 6. 崩溃兜底(daemon,~10 行)
`process.on('uncaughtException'/'unhandledRejection')`,记日志(同 relay 那套)。daemon 崩了 console 能检测(pid 不活)→ 提示重启。

## 功能 → 复用映射

| 功能 | 复用的现有模块 |
|---|---|
| 启停/重启、单实例 | `ownership.ts` `tryAcquire` |
| 查/改 PIN | `main.ts` `currentPin` / `randomPin` |
| 查连接数 | `main.ts` `phoneKeys` |
| 白名单管理 | `pairing.ts` `loadAuthorized`/`addAuthorized` |
| 配置查看 | `config.ts` `loadConfig` |
| doctor | `jupyter-detect.ts` `detectServers`、`main.ts` `resolveClaudeBin` |
| 更新下载源 | 中继 `/dl/` + `/dl/sha256.txt`(现成) |
| daemon 主逻辑 | 现有 `main()` 全部(连中继/Jupyter/agent/hook)**一个不动** |

**identity / pairing / config / ownership / jupyter / bridge / butler / agent-runner 全部不改。**

## 错误处理

- daemon 全局错误 → 记日志、退出(console/systemd 拉起)
- console fetch 失败(daemon 无响应)→ 显示「daemon 已停止/无响应」+ 启动入口
- 更新失败(下载/验签不符)→ **不替换**,报错回滚

## 测试

- `/control` 路由:单元测试(mock daemon 状态对象,验各路由返回)
- `update` 的 sha256 比对逻辑:单测
- console TUI 渲染:手测为主(交互式,难自动化)
- 现有测试(pairing/config/ownership/jupyter-detect 等)不受影响,保持绿

## 新增量

- **1 个新文件** `src/cli/console.ts`(~150 行)
- `main.ts` 改 ~150 行(入口分叉 + `/control` 路由 + daemon.json + update + 崩溃兜底)
- `scripts/build-binaries.sh` 加版本注入(`bun build --define CE_VERSION=...`,供「查版本」)
- 合计 **~300 行**,换一整个控制台——因为现有 daemon 逻辑已写好,只是套个遥控器

## 开放问题(实施时定,不影响整体)

- daemon 重启:自重启(spawn 新自己 + 退出)vs console 重启——倾向 console 重启(简单)
- 日志载体:daemon stdout → 文件(`~/.ce/ce.log`),console `tail`——简单,先用文件
- 控制端点安全:只听 127.0.0.1(本机信任,同 hook 端点策略),不加认证
