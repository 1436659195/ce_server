# CE 安装说明(被控机端)

在被控电脑上一行命令装 CE,装好后选个中继,手机扫码即连。

## 一行安装(从 GitHub,与中继无关)

**Linux / macOS**(终端):
```sh
curl -fsSL https://raw.githubusercontent.com/1436659195/ce_server/main/scripts/install.sh | sh
```

**Windows**(PowerShell):
```powershell
irm https://raw.githubusercontent.com/1436659195/ce_server/main/scripts/install.ps1 | iex
```

> 脚本和 ce 二进制都从 GitHub 拉,安装时**不需要任何中继地址**。中继在装完之后、ce 首跑时再选。

## 装的过程(全自动)

1. 自动识别系统(Linux / macOS / Windows × x64 / arm64),从 GitHub Releases 下对应 CE
2. 校验文件指纹(已是最新则跳过下载,免重复拉 ~90MB)
3. 装到 `/usr/local/bin/ce`(无权限则回退 `~/.local/bin/ce`)
4. 询问是否开机自启(可选;Linux 走 systemd user service)
5. 启动 CE

## 启动后:选中继 → 二维码

CE 首次启动会问你选中继(没有 `--relay`、也没配过时):

```
[ce] 请选择中继:
  [1] 官方中继 ws://... (默认)
  [2] 自建 / 第三方中继:粘贴 ws:// 地址
请输入序号或直接粘贴地址 (回车=官方):
```

- **官方** —— 回车或输 `1`。
- **自建 / 第三方** —— 粘贴 `ws://你的中继:8606`(中继部署见 ce-server 的 README)。

选完 CE 记到 `~/.ce/config.json`(下次不再问;可用 `--relay=...` 临时覆盖)。然后 CE 连中继、打印二维码 + 连接码。**用手机 App 扫码**(或手动粘码)即完成配对。

之后 CE 自动完成:
- **探测 Jupyter**:找到就用;没找到则引导 `pip install jupyterlab`
- **缺 Python 3**:提示安装命令后退出(装完重跑一行安装命令)

## 前置要求

- **Python 3**(必须,Jupyter 依赖)—— 没有则 CE 会给安装提示
- **JupyterLab**(CE 自动引导装)
- 联网(下 ce 从 GitHub;连中继走 WebSocket 出站)

## 支持平台

| 系统 | 架构 |
|---|---|
| Linux | x64 / arm64 |
| macOS | x64 / arm64 |
| Windows | x64 |

## 更新

重跑一行安装命令即可 —— GitHub 上的指纹变了自动重下,没变跳过。

## 卸载

```sh
rm /usr/local/bin/ce        # 或 ~/.local/bin/ce
rm -rf ~/.ce                # 配置(选中继)+ 身份 + 连接码
```
若当初装了开机自启,再停掉服务:
```sh
systemctl --user disable --now ce.service
```

## 常见问题

**Q: 重装后二维码没出来?**
CE 已在跑时,安装器会复用原 CE 的连接码(不重启)。看原 CE 窗口的二维码,或 `cat ~/.ce/connection-code.json`。

**Q: 提示「未检测到 Python」?**
先装 Python 3,然后**重开终端**,再跑一次安装命令:
- Linux:`sudo apt install python3 python3-pip`(或 dnf)
- macOS:`brew install python`
- Windows:`winget install Python.Python.3.12`

**Q: 中继地址从哪来 / 怎么换?**
CE 首跑会让你选(官方 / 自建 / 第三方)。自建中继的部署见 ce-server 的 README。换中继:改 `~/.ce/config.json` 的 `relay`,或启动加 `--relay=ws://...`。

**Q: 无界面 / systemd 自启场景,没法交互选中继?**
无交互终端时 CE 自动用官方中继(`OFFICIAL_RELAY`)。要用自建中继,事先写 `~/.ce/config.json`:`{"relay":"ws://你的中继:8606"}`,或在 systemd unit 里 `ExecStart=/path/to/ce --relay=ws://...`。

**Q: 防火墙 / 公司网络拦了怎么办?**
CE 走 WebSocket 连中继(出站)。若被拦,让网管放行到中继地址的出站端口(默认 8606)。
