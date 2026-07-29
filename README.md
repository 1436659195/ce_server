# ce-server

Coding Everywhere 的**服务端**(Bun + TypeScript)。本仓库含**两个独立角色**,分别部署在不同机器:

| 角色 | 代码 | 跑在哪 | 职责 |
|---|---|---|---|
| **中继 relay** | `src/relay/` | 公网服务器 | 手机 ↔ ce 之间加密帧的中转。**纯转发、不解密**(E2E 加密在两端,中继没密钥)。 |
| **被控机 ce** | `src/cli/` | 被控电脑 | 连中继 + 本地 Jupyter + Claude SDK(CC 移动审查 / AI 管家)。 |

> 手机 App 是**另一个仓库**(`ce-platform`),不在本仓库。

## 拓扑:谁连谁、ce 从哪下

```
                      GitHub Releases
                 ── ce 二进制的唯一下载渠道 ──
                           │  install.sh / install.ps1 + ce 二进制都从 GitHub 拉
                           ▼
  ┌────────────┐  WS 加密帧  ┌──────────────┐  WS 加密帧  ┌──────────────┐
  │  被控机 ce  │◄───────────►│   中继 relay  │◄───────────►│   手机 App    │
  │  (src/cli) │             │  (src/relay)  │             │ (ce-platform) │
  └────────────┘             └──────────────┘             └──────────────┘
        │
        │ 本地 REST / WS
        ▼
   本地 Jupyter + Claude SDK
```

**下载与中继已解耦(本仓库最近的关键改动)**

- **ce 二进制只有一个下载渠道:GitHub Releases**。安装脚本和二进制都从 GitHub 拉,**跟中继无关**。
- **中继回归纯转发**:不再 serve 二进制或安装脚本(`/dl/*`、`/install.*` 已移除,一律 404)。HTTP 层只剩 `/lan.py`(同 WiFi 局域网直连模式的脚本)。
- **为什么这么分**:未来中继会有很多个(官方 / 自建 / 第三方),但下载渠道只该有一个。剥离后,用户装 ce 时**不需要先知道任何中继地址** —— 中继在 ce 首跑时再选。
- **手机侧无需改动**:二维码里带中继地址(`r` 字段),手机连的是二维码指定的那个中继,天然支持任意中继。

## 部署中继(公网服务器)

```sh
git clone <本仓库> && cd ce-server
bun install
bun run src/relay/main.ts --port=8606 --state=relay-state.json
```

- 中继很轻(实测 ~60MB 内存、几乎不吃 CPU),2C2G 入门服务器够用。
- 手机和被控机都连这个公网地址:`ws://你的中继:8606`。
- 中继**不需要 `dist/`、不需要二进制** —— 它只转发。
- 可选 TLS:`--tls-cert=... --tls-key=...`(走 `wss://`)。
- `--state=<file>` 存 `cid → sid/token` 映射:中继重启后 ce 重连仍拿到同一 sid,手机的配对码长期有效、不必重扫。

## 部署被控机 ce

**给被控机用户(无需 clone 本仓库)—— 一行装,详见 [INSTALL.md](INSTALL.md):**
```sh
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/1436659195/ce_server/main/scripts/install.sh | sh
# Windows PowerShell
irm https://raw.githubusercontent.com/1436659195/ce_server/main/scripts/install.ps1 | iex
```
装好后 **ce 首跑交互选中继**(官方 / 自建 / 第三方),连上即弹二维码。**安装时不需要中继地址。**

**源码直跑(开发 / 自测):**
```sh
bun install
bun run src/cli/main.ts --relay=ws://<中继>:8606
#   --jupyter=url --jupyter-token=t 可选;不传则 ce 自动探测 / 引导装本地 Jupyter
```

**ce 选中继的优先级**(只有 `--relay` 和 config 都没给时才弹问,选完存 `~/.ce/config.json`):
```
--relay=<url>   >   ~/.ce/config.json 的 relay   >   首跑交互选择   >   官方默认(OFFICIAL_RELAY)
```
> 官方默认在 `src/cli/config.ts` 的 `OFFICIAL_RELAY` —— **★ 发布前必须填真实地址**(仓库里是占位符 `ws://OFFICIAL_RELAY_PLACEHOLDER:8606`)。

## 编译与发布

```sh
bash scripts/build-binaries.sh
# → dist/ce-{linux,darwin,windows}-{x64,arm64}[.exe] + sha256.txt(单文件二进制,无运行时依赖)
```

**发布 checklist:**
1. 填 `src/cli/config.ts` 的 `OFFICIAL_RELAY`(真实官方中继 `ws://host:port`)。
2. `bash scripts/build-binaries.sh` 产出 `dist/*`。
3. 把 `dist/` 下所有文件作为 **GitHub Release assets** 上传(`gh release create <tag> dist/*`,或走 CI)。
   → 安装脚本从 `https://github.com/1436659195/ce_server/releases/latest/download` 拉 `ce-<平台>` + `sha256.txt`(按 sha256 判更新)。

## 测试

```sh
bun test                             # 全量
bun test test/agent-runner.test.ts   # 单文件
```

## 目录

```
src/
├── relay/   中继(hub + server,纯转发 + session 管理)
├── cli/     被控机 ce(main.ts 主流程 + agent-runner + bridge + jupyter + config + butler + cc-hooks)
└── shared/  两端共享的 wire 协议(crypto + frame + agent-events + spec.md)
scripts/     install.sh / install.ps1(GitHub 下载)/ build-binaries.sh / lan.py(局域网直连)
test/        单测(hub / relay / config / lan-route / agent-runner / butler / …)
```
