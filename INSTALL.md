# CE 安装说明(被控机端)

在被控电脑上一行命令装 CE,手机扫码即连。

## 一行安装

**Linux / macOS**(终端):
```sh
curl -fsSL http://<中继地址>/install.sh | sh
```

**Windows**(PowerShell):
```powershell
irm http://<中继地址>/install.ps1 | iex
```

> `<中继地址>` 由服务运营者提供(形如 `your-relay.com:8606`)。通常你拿到的就是一条完整的 `curl … | sh` 命令,复制粘贴执行即可。

## 装的过程(全自动)

1. 自动识别系统(Linux / macOS / Windows × x64 / arm64),下载对应 CE
2. 校验文件指纹(已是最新则跳过下载,免重复拉 ~90MB)
3. 装到 `/usr/local/bin/ce`(无权限则回退 `~/.local/bin/ce`)
4. 写配置 `~/.ce/config.json`(记中继地址)
5. 询问是否开机自启(可选;Linux 走 systemd user service)
6. 启动 CE

## 启动后

CE 自动完成:
- **探测 Jupyter**:找到就用;没找到则引导 `pip install jupyterlab`
- **缺 Python 3**:提示安装命令后退出(装完重跑一行命令)
- **连中继 → 打印二维码 + 连接码**

终端会出现一个二维码和一串连接码。**用手机 App 扫码**(或手动粘码)即完成配对,之后就能在手机上远程终端 / 文件 / CC。

## 前置要求

- **Python 3**(必须,Jupyter 依赖)—— 没有则 CE 会给安装提示
- **JupyterLab**(CE 自动引导装)
- 联网

## 支持平台

| 系统 | 架构 |
|---|---|
| Linux | x64 / arm64 |
| macOS | x64 / arm64 |
| Windows | x64 |

## 更新

重跑一行安装命令即可——指纹变了自动重下,没变跳过。

## 卸载

```sh
rm /usr/local/bin/ce        # 或 ~/.local/bin/ce
rm -rf ~/.ce                # 配置 + 身份 + 连接码
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

**Q: 中继地址从哪来?**
问服务运营者 / 部署管理员。中继在 serve 安装脚本时已把地址注入,你通常拿到的是一条可直接执行的完整命令。

**Q: 防火墙 / 公司网络拦了怎么办?**
CE 走 WebSocket 连中继(出站)。若被拦,让网管放行到中继地址的出站 8606(或运营者指定端口)。
