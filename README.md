# ce-server

Coding Everywhere 的服务端(Bun + TypeScript)。两个角色:

- **`src/relay/`** — 中继:部署在公网,手机 ↔ 被控机 ce 之间加密帧的中转 + 二进制静态下载。**纯转发、不解密**(E2E 加密在两端),很轻。
- **`src/cli/`** — 被控机 ce:跑在被控电脑,连中继 + 本地 Jupyter + Claude SDK(CC 移动审查)。

## 部署中继(公网服务器)

**一键启动(推荐)**:配置存 `.env`,用 `start.sh` 管理,无需记一长串参数。

```sh
git clone <本仓库> && cd ce-server
bun install
cp .env.example .env       # 复制配置模板
vi .env                     # 填:RELAY_STATE_KEY(密钥)/ RELAY_PUBLIC_URL(对外地址)等
./start.sh                  # 启动(后台,日志进 relay.log)
```

`start.sh` 常用命令:

| 命令 | 作用 |
|---|---|
| `./start.sh` | 启动 |
| `./start.sh stop` | 停止(优雅退出) |
| `./start.sh restart` | 重启 |
| `./start.sh status` | 看是否在跑 |
| `./start.sh logs` | 实时看日志(Ctrl+C 退出查看,不影响中继) |

> `.env` 含密钥,已在 `.gitignore` 里(不进 git);各项含义见 `.env.example` 注释。

**或手动启动**(不用脚本,直接 bun):

```sh
RELAY_STATE_KEY=<密钥> bun run src/relay/main.ts \
  --port=8606 --public-url=ws://<公网地址>:8606
```

中继轻量(实测 ~60MB 内存、几乎不吃 CPU),2C2G 的入门服务器绰绰有余。手机和被控机都连这个公网地址。完整参数、安全机制、运维排障见 [docs/ops.md](docs/ops.md)。

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

## 中继上补齐 `dist/`(让 `curl|sh` 能装 ce)

中继只做转发、不依赖二进制;但被控机用 `curl|sh` 安装时要从中继 `/dl/` 下载 ce。
若 `http://<中继>:8606/dl/ce-linux-x64` 返回 **404**,说明中继机上 `dist/` 没编译 —— 在**中继机本身**上跑:

1. 定位 ce-server 根目录(含 `scripts/build-binaries.sh`):
   ```bash
   ps -ef | grep relay/main.ts | grep -v grep        # 看中继进程,推断目录
   find / -type f -name build-binaries.sh 2>/dev/null
   ```
   `cd` 进该目录。
2. 编译:
   ```bash
   bash scripts/build-binaries.sh
   # → dist/ce-{linux,darwin,windows}-{x64,arm64}[.exe] + sha256.txt(共 ~410M)
   ```
3. 验证(**不用重启中继** —— 它每次请求都现读 `dist/`,编译完立刻生效):
   ```bash
   curl -sI http://localhost:8606/dl/ce-linux-x64 | grep -i content-length   # 期望 90 多 MB
   curl -sI http://localhost:8606/dl/sha256.txt | head -1                     # 期望 HTTP/1.1 200
   ```

**排错**:
- `bun build --compile --target=...` 报错 → 多半 bun 太旧,`bun upgrade` 后重试。
- 没有 `scripts/`(只拷了部分源码)→ 重新 `git clone https://github.com/1436659195/ce_server.git`,在新目录编译,把 `dist/` 拷到中继读取的位置(看第 1 步推断的目录)。

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
