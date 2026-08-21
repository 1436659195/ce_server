# CE 被控程序 Mac 安装指南(智能体执行版)

> 本文档面向**编码智能体**(Claude Code / 其他 agent),在 Mac 被控机上一步步安装并验证 CE 被控程序。
> 逐节执行,每节有明确的**预期输出**;不符合预期时停在对应"排障"小节,不要跳步。
> 人类用户版流程相同,可对照使用。
>
> 最后更新:2026-08-21(对应 relay 分发的 ce 版本:含 ws 心跳 / jupyter 127.0.0.1 固化 / listTerminals 重试 / 分段上传)

---

## 0. 前置知识(读一遍,别跳)

- **架构**:被控机跑 `ce`(daemon)。手机 App 经中继(`wss://ce.coding-everywhere.xyz`)连到 ce,ce 再操作本机 Jupyter(终端/文件)。终端能力由 Jupyter 的 terminado 提供。
- **关键目录/文件**(排障都看这里):

| 路径 | 作用 |
|---|---|
| `/usr/local/bin/ce`(或 `~/.local/bin/ce`) | 二进制本体 |
| `~/.ce/config.json` | relay 地址 |
| `~/.ce/identity.json` | 机器身份(cid+密钥)。**删了 = 手机配对码作废,需重扫。别动** |
| `~/.ce/authorized-phones.json` | 已配对手机白名单 |
| `~/.ce/jupyter.json` | 自启 Jupyter 的 url/token/root 记忆(复用免重起) |
| `~/.ce/connection-code.json` | 手机粘码用的连接码 |
| `~/.ce/ce.log` | Jupyter 输出日志(排障第一入口) |

- **单例**:全机只允许一个 `ce --daemon`。重复装/跑会走"复用"路径,不是错误。

---

## 1. 环境预检

```bash
uname -m                          # 期望 x86_64 或 arm64
sw_versions                       # macOS 版本(信息用,无硬性要求)
command -v python3 && python3 --version   # 期望存在;缺失见 1a
command -v curl
```

**预期**:arch 是 `x86_64`/`arm64` 之一;python3 存在。

### 1a. python3 缺失时

```bash
command -v brew || echo "NO_BREW"
```

- 有 brew:`brew install python`,装完回到第 1 步重验。
- 无 brew:先装 Homebrew(https://brew.sh 的官方一行命令),再 `brew install python`。
- **注意**:Mac 的 `/usr/bin/python3`(3.9.x,无 pip 包)不够用;要的是 brew/官方安装的、带 pip 的 python3。验证:`python3 -m pip --version` 能出版本行。

---

## 2. 一行安装

```bash
curl -fsSL https://ce.coding-everywhere.xyz/install.sh | sh
```

**预期输出**(逐行核对):

```
[install] 平台 darwin-arm64 → https://…/dl/ce-darwin-arm64     ← 架构对上
[install] ce 有更新(本地 … / 远程 …),重新下载    ← 首装没有此行,直接"下载"
################  progress-bar(约 63-68MB)
[install] 已写入配置: /Users/<你>/.ce/config.json
[install] 启动 ce...
```

随后 ce daemon 前台启动,打印 ASCII 二维码 + 连接码 JSON + 一行 PIN:
`[ce] 配对 PIN(新手机首次连接在 App 输入): xxxxxx`

**安装脚本自动处理的坑(无需手工)**:Gatekeeper 隔离标记(xattr quarantine 已去除)、sha256 增量更新(已是最新则跳过 68MB 下载)。

### 2a. 排障

| 症状 | 处置 |
|---|---|
| `无权限写 /usr/local/bin,改用 ~/.local/bin` | 正常回退。第 4 步前把 `~/.local/bin` 加 PATH:`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc` |
| 下载失败/超时 | 网络问题,重跑同一行命令(有断点心智负担:重跑无害,已装且 hash 一致会跳过下载) |
| ce 已在运行(PID xxx),不重复启动 | 见第 5 节"更新流程"—— 先停再装 |
| 启动后 `killed: 9` | Gatekeeper 仍拦截:`xattr -dr com.apple.quarantine $(command -v ce)` 后重跑 `ce` |

---

## 3. 首次启动验证(daemon 侧)

装完那一步 ce 是**前台**跑的(占着终端)。先让它继续跑,新开一个终端窗验证:

```bash
pgrep -fl "ce --daemon"                     # 期望:一个 PID
cat ~/.ce/config.json                       # 期望:{"relay":"wss://ce.coding-everywhere.xyz"}
tail -5 ~/.ce/ce.log 2>/dev/null            # 期望:无 Python traceback;若有 Jupyter 启动横幅则正常
```

**Jupyter 行为说明**:ce 首跑会自探 `jupyter server list`;没有则提示 pip 装 jupyterlab(约 1-2 分钟,清华源)。装好自启一个,`~/.ce/jupyter.json` 记地址。**terminado 随 jupyterlab 一并装上**(0.18.x,终端后端)——不需要单独装。

预期 ce 前台窗口最终稳定显示:二维码 + `连接码(手动粘贴): {"r":"wss://…","s":"…","k":"…","t":"…","n":"<主机名>","p":"darwin"}` + PIN 行。

### 3a. 排障

| 症状 | 处置 |
|---|---|
| `未检测到 python3` | 回 1a |
| pip 装 jupyterlab 失败 | 看 ce 前台输出的 pip 报错;常见是网络,手动:`python3 -m pip install jupyterlab -i https://pypi.tuna.tsinghua.edu.cn/simple` 后重跑 `ce` |
| `已连中继` 后又反复 `中继断开,xxx ms 后重连` | relay 不可达:`curl -sI https://ce.coding-everywhere.xyz/install.sh` 应 200;不通查本机网络/代理 |

---

## 4. 转后台常驻(控制台)

保持前台跑也行,但推荐控制台模式(前台窗口关了 daemon 依旧):

```bash
# 停掉前台的(它同样以 --daemon 身份活着时):
pkill -f "ce --daemon"; sleep 1
# 用 nohup 起后台 daemon + 控制台
nohup ce --daemon >> ~/.ce/daemon.log 2>&1 &
sleep 2 && ce          # 控制台 TUI
```

**控制台预期面板**:

```
┌ ce v0.1.x  ● 已连中继 ─────────────┐
│ PID xxx   手机在线 0   已配对 0     │
│ 中继 wss://ce.coding-everywhere.xyz │
│ Jupyter http://127.0.0.1:<port>  模式 pin  PIN xxxxxx │
└────────────────────────────────────┘
[s]启 [x]停 [r]重启 [u]更新 [c]二维码 [p]改PIN [w]白名单 [l]日志 [d]体检 [q]退出
```

要点:`● 已连中继` 绿点;`Jupyter` 地址应为 `127.0.0.1`(不是 localhost);`q` 只退出 TUI,daemon 继续跑。

### 4a. 开机自启(可选但推荐)

install.sh 的 systemd 自启仅 Linux;Mac 用 launchd:

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.ce.daemon.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ce.daemon</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v ce)</string><string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.ce/daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/.ce/daemon.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.ce.daemon.plist
launchctl list | grep com.ce   # 期望一行,第二列 PID 非 "-"
```

---

## 5. 更新流程(旧机重跑)

```bash
curl -fsSL https://ce.coding-everywhere.xyz/install.sh | sh
```

- ce 在跑 → 脚本提示复用连接码后退出。**Linux 脚本不会自动停旧进程**(自动停是 Windows install.ps1 的行为),Mac 更新需手动:
  ```bash
  pkill -f "ce --daemon"; sleep 1
  curl -fsSL https://ce.coding-everywhere.xyz/install.sh | sh   # 下载新版(sha256 比对)
  # 然后按第 4 节转后台
  ```
- 更新**不丢**:配对白名单、手机配对码、终端会话(Jupyter 复用 `~/.ce/jupyter.json`)。
- 版本核对:`ls -la $(command -v ce)` 的时间戳 + 控制台首行版本;或 `shasum -a 256 $(command -v ce)` 对照 `https://ce.coding-everywhere.xyz/dl/sha256.txt` 里 `ce-darwin-<arch>` 行。

---

## 6. 端到端验证(手机侧,需人类配合或由人类执行)

1. 手机 App → 添加服务器 → 扫 ce 窗口二维码(或粘贴连接码 JSON)
2. 首次连接 App 弹 PIN 输入 → 输 ce 前台/控制台显示的 6 位 PIN
3. 进入后:点 "+" 建终端 → 应直接打开 shell 并可执行命令
4. 文件栏:能浏览 `/`(Jupyter root_dir 是 `/`)
5. 上传一个 >2MB 文件验证分段上传(新版路径);旧 App/旧 ce 会退化提示

**验证通过的标准**:终端能开能敲、手机锁屏再亮回来自动恢复(≤90s,ws 心跳)、文件可传。

### 6a. 手机连上但建终端报错(按序自查)

```bash
# ① Jupyter 活着吗(用 ce 记的地址;应输出 Currently running servers)
cat ~/.ce/jupyter.json
python3 -m jupyter server list
# ② terminado 装了吗(应出版本行)
python3 -m pip show terminado
# ③ 用真实终端名验证 WS(不是假名!):先 POST 建一个,对返回名升级
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.ce/jupyter.json'))['url'].split(':')[2])")
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.ce/jupyter.json'))['token'])")
NAME=$(curl -s -X POST "http://127.0.0.1:$PORT/api/terminals" -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' -d '{"cwd":"/tmp"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['name'])")
curl -s -o /dev/null -w "WS升级HTTP:%{http_code}\n" "http://127.0.0.1:$PORT/terminals/websocket/$NAME" -H "Authorization: Token $TOKEN" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
# 期望 101;404 才是 terminado 问题(但注意:假终端名 404 是预期,必须用 POST 返回的真实名)
```

| 报错文案 | 含义 | 处置 |
|---|---|---|
| `创建终端失败:404` | terminado 缺失/未加载 | `python3 -m pip install terminado -i https://pypi.tuna.tsinghua.edu.cn/simple` 后 `pkill -f jupyterlab && rm ~/.ce/jupyter.json && pkill -f "ce --daemon"`,重启 ce(全新自启 Jupyter 加载插件) |
| `Unable to connect…` | ce 连不上 Jupyter(进程死/换口) | `pkill -f jupyterlab; rm ~/.ce/jupyter.json`;重启 ce |
| 闪一下 404 又好 | 已知瞬态,新版 ce 已有 300ms 重试兜底 | 升级 ce 到最新(第 5 节) |

---

## 7. 卸载

```bash
pkill -f "ce --daemon" 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.ce.daemon.plist 2>/dev/null; rm -f ~/Library/LaunchAgents/com.ce.daemon.plist
rm -f /usr/local/bin/ce ~/.local/bin/ce
rm -rf ~/.ce        # 含配对/身份/Jupyter 记忆;重装后手机需重扫
```

---

## 8. 快速参考

```bash
ce                      # 控制台 TUI(看状态/二维码/PIN/日志/体检)
pgrep -fl "ce --daemon" # daemon 在吗
tail -50 ~/.ce/ce.log   # Jupyter 侧日志
tail -50 ~/.ce/daemon.log  # daemon 侧日志
curl -fsSL https://ce.coding-everywhere.xyz/install.sh | sh   # 安装/更新入口(永远同一条)
```

智能体执行完第 4 节即算安装完成;第 6 节需人类手机配合,报告时注明"待人类验证端到端"即可。
