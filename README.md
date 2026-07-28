# ce-server

Coding Everywhere 的服务端(Bun + TypeScript)。两个角色:

- **`src/relay/`** — 中继:部署在公网,手机 ↔ 被控机 ce 之间加密帧的中转 + 二进制静态下载。**纯转发、不解密**(E2E 加密在两端),很轻。
- **`src/cli/`** — 被控机 ce:跑在被控电脑,连中继 + 本地 Jupyter + Claude SDK(CC 移动审查)。

## 部署中继(公网服务器)

```sh
git clone <本仓库> && cd ce-server
bun install
bun run src/relay/main.ts --port=8606 --state=relay-state.json
```

中继轻量(实测 ~60MB 内存、几乎不吃 CPU),2C2G 的入门服务器绰绰有余。手机和被控机都连这个公网地址(`ws://你的中继:8606`)。

## 部署被控机 ce

**源码直跑**(开发/自测):
```sh
bun install
bun run src/cli/main.ts --relay=ws://<中继>:8606 --jupyter=http://localhost:8888
```

**一行装二进制**(给被控机用户,无需 clone 本仓库):见 [INSTALL.md](INSTALL.md)。

## 编译分发二进制

```sh
bash scripts/build-binaries.sh
# → dist/ce-{linux,darwin,windows}-{x64,arm64}[.exe](单文件,无运行时依赖)
```

把 `dist/` 上传到中继的下载目录,被控机就能 `curl|sh` 拉到最新版。

## 测试

```sh
bun test            # 全量
bun test test/agent-runner.test.ts   # 单文件
```

## 目录

```
src/
├── relay/   中继(hub + server + session 管理)
├── cli/     被控机 ce(主流程 main.ts + agent-runner + bridge + jupyter)
└── shared/  共享(加密 crypto + 帧 frame + 事件 agent-events)
scripts/     install.sh / build-binaries.sh 等
```
