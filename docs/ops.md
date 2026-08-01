# ce-server 运维手册

> 中继(relay)+ 被控机(ce)+ 手机 App 三方的部署、安全、运维、排障。
> 基于实际部署验证;命令均可直接抄。

## 一句话架构

```
手机 App  ←─E2E 密文─→  中继 relay  ←─E2E 密文─→  被控机 ce
                        (零信任哑管道               (落地 Jupyter /
                         只转发不解密)              Claude Code)
```

- 中继**不持 E2E 密钥**,只按 sessionId 转发密文(`hub.ts`)
- ce 与手机各持 X25519 密钥对,握手换公钥派生 `sharedKey`(tweetnacl)
- 配对凭证 `sid`+`token` 在中继,手机扫码所得;E2E 密钥只在两端

## 部署

### 中继 relay(公网服务器)

```bash
RELAY_STATE_KEY=<强密钥> \
bun run src/relay/main.ts \
  --port=8606 --state=relay-state.json \
  --public-url=ws://<公网IP或域名>:8606 \
  [--tls-cert=cert.pem --tls-key=key.pem]   # 上 wss 用,强烈建议
```

| 参数 | 作用 |
|---|---|
| `RELAY_STATE_KEY` | state 加密密钥(**必设**,生产用强随机串,不进 git) |
| `--public-url` | 对外地址;install 脚本注入用它,**防 Host 头伪造** |
| `--tls-cert/--tls-key` | wss/TLS 证书(堵传输层明文) |
| `--state` | cid→sid/token 持久文件,默认 `./relay-state.json` |

产物:`relay-state.json`(加密 + 权限 0600)、`relay.log`。

### 被控机 ce

```bash
bun run src/cli/main.ts \
  --relay=ws://<中继>:8606 \
  [--jupyter=http://127.0.0.1:8888 --jupyter-token=t] \
  --pairing-mode=pin \
  [--pin=NNNNNN]
```

- 不传 `--jupyter` 则探测本机 → 引导装 → 自启动
- `--pairing-mode=pin`(默认):新手机首次配对须 PIN;`open` 回退旧行为
- `--pin`:指定固定 PIN;**不传则每次启动随机**
- 启动打印二维码 + PIN 到终端(`[ce] 配对 PIN: XXXXXX`)
- 持久身份:`~/.ce/identity.json`(cid + 密钥对,重启复用 → 配对码长期有效)

### 手机 App

扫码(或手粘连接码 `{"r","s","k","t"}`)+ 输 PIN(pin 模式首次)。配对后 phoneId 入 ce 白名单,之后重连免 PIN。

## 安全机制

1. **握手认证**(pin 模式):新 phoneId 须带 ce 显示的 PIN 才入白名单(`~/.ce/authorized-phones.json`);已配对 phoneId 重连放行。堵「拿到配对码即能解密」。
2. **零信任中继**:relay 不持 E2E 密钥,即便被攻陷也只拿到密文。
3. **Host 注入防护**:install 脚本用 `--public-url`,不信任请求 Host(防伪造中继地址写入 install.sh/ps1)。
4. **注册限流**:每 IP 每分钟 20 次 + `cidToEntry` 上限 1000 LRU 淘汰(防匿名刷爆 state/内存)。
5. **state 加密**:`relay-state.json` AES-256-GCM + 权限 0600。
6. **token 轮换**:`--rotate` 一次性重置所有 token(手机重扫)。

> ⚠️ 完整安全性以**中继有 TLS** 为前提(phoneId 在 URL,无 TLS 可被嗅探冒充)。生产务必上 wss/反代。

## 运维操作

### 重启 relay(几乎无感)

relay 重启 → ce 和手机**自动重连**(sid/token 复用,pin 白名单在 ce 不受影响)→ **免 PIN** 恢复。配 systemd `Restart=always`。

### 重启 / 切换 ce(关键!)

```bash
# ⚠️ 必须 kill【全部】ce,含编译版 binary(进程名 ce,不是 bun)!
#   它们共用 ~/.ce/identity.json(同 cid),漏一个就会抢占 relay 的 cli 槽位
#   → 手机握手被错的 ce 接走 → 配对失败 / 连接混乱
ps -ef | grep -E 'cli/main|/ce[ ]' | grep -v relay   # 列全
# kill 它们(保 relay),再起新 ce
ss -tnp | grep :8606                                  # 确认只剩一个 ce pid
```

### 加新手机(第二个人)

给新人:**连接码 + 当前 PIN**。新人扫码/粘码 + PIN → phoneId 自动入白名单。之后免 PIN。
> PIN 是 ce 级共享码:谁拿到「连接码+PIN」谁能配对。要「只允许指定人」需改预共享密钥方案(每手机唯一凭证)。

### 换 PIN / 切 pin 模式

重启 ce 带 `--pairing-mode=pin --pin=<新PIN>`。已配对手机免 PIN;新人要新 PIN。

### 轮换 token(怀疑泄露)

```bash
bun run src/relay/main.ts --rotate    # 重置所有 token 后退出
# 再正常起 relay;所有手机重新扫码
```

## 排障

| 症状 | 原因 | 处理 |
|---|---|---|
| 手机配对失败,ce 日志无握手记录 | 老 ce(常是编译版)抢占 cli 槽位 | kill 全部 ce,只起一个 |
| 手机突然连不上 | 多 ce 抢占 / relay session 悬空 | 重启 relay(ce/手机自动重连) |
| 老手机「PIN 变了」连不上 | ce 重启没带 `--pin`(随机了) | 已配对的免 PIN;新人从 ce 日志读新 PIN |
| `relay-state.json` 损坏 | 磁盘/手动改坏 | 删它(代价:所有手机重扫) |
| ce 日志 `拒绝配对…PIN 错/缺` | 手机没带 PIN 或 PIN 错 | 确认 ce 当前 PIN(pin 模式新人首次要) |

## 关键文件

| 路径 | 内容 |
|---|---|
| `relay-state.json`(relay 侧) | cid→sid/token,加密+0600,**丢了=所有人重扫** |
| `~/.ce/identity.json`(ce 侧) | cid + X25519 密钥对,持久 |
| `~/.ce/connection-code.json` | 配对码 r/s/k/t(ce 打印/落盘) |
| `~/.ce/authorized-phones.json` | pin 白名单(phoneId 数组) |
| `relay.log` / ce 启动重定向 | 运行日志 |

## 后置强化(部署期,非纯代码层)

- **TLS/wss** 或 Caddy/nginx 反代 + 证书自动续(堵传输层)
- **systemd** 托管 relay/ce(`Restart=always`)
- **监控**:连接数、`relay-state.json` 大小、内存;异常告警
- **ce 二进制签名**:install 脚本验签后再装
- **relay-state 备份**:定期备份(丢了所有人重扫)
- **token 移出 URL**:上反代(access log 记 URL)时做「首帧 token」版
