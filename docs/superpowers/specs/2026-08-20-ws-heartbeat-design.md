# ce↔relay WebSocket 心跳 设计文档

日期:2026-08-20
状态:已批准(30s 间隔 / 2 次判死)

## 背景与根因

2026-08-19 故障:Windows ce 经手机热点上网,热点断开又恢复后,ce 的 WS 连接变 half-open
——TCP 路径已断但 FIN/RST 未送达,ce 侧 `ws.on('close')` 永不触发 → 永不重连;relay 侧
socket 已死,手机重试(含重扫配对码/PIN)的握手帧全部无应答。

根因:**ce↔relay 链路零心跳**。无数据流动时双方都无法发现死连接。同类故障面:热点断换、
WiFi 切换、睡眠唤醒、NAT 超时。

app 侧已核实无需改动:cliLeft 处理、15s 等待窗口 + 2s 探活轮询、idle≥10min 强制重开均已
存在;平台原生 WS 按 RFC 6455 自动回协议层 pong,relay 主动 ping 无需 app 配合。

## 方案

`ws@8.21` 手动 ping/pong 状态机(8.21 无 `heartbeatInterval` 参数):

- **ce**:连上后每 30s `ws.ping()`;`'pong'` missed 归零;连续 2 次无 pong(≈60-90s)→
  `ws.terminate()` → 已有 close 处理器 → 已有指数退避重连。
- **relay**:每条连接(cli + phone 两条路径)每 30s ping;连续 2 次无 pong → terminate →
  hub.onClose → 已有 cliLeft/phoneLeft 通知自动发出。

零协议改动、零 app 改动、旧版 ce 全兼容(协议层 ping/pong 是 WS 法定义务)。

故障场景预期:热点断 → relay ≤90s 判死 → cliLeft 即时到手机;热点恢复 → ce 同样 ≤90s
自杀重连 → 带 cid 回原 sid(配对/PIN 不失效)→ 手机探活接回,全程无需重扫。

## 改动点(2 个文件)

### ① `src/cli/main.ts` — connect() 内加心跳

- 连上后 `setInterval(30s)` 发 `ws.ping()`;`'pong'` 事件 missed 归零。
- 连续 2 次无 pong:`ws.terminate()` + 日志 `[ce] 心跳超时,重连`。
- close 处理器内 `clearInterval`;ping 发送抛错按判死同路径处理。

### ② `src/relay/server.ts` — wss.on('connection') 统一挂心跳

- 每条连接起 `setInterval(30s)` ping;连续 2 次无 pong → `terminate()` → hub.onClose。
- 连接 close 时清理定时器。
- `createRelayServer` opts 增加 `heartbeat?: { intervalMs: number; maxMissed: number }`,
  默认 `{ intervalMs: 30_000, maxMissed: 2 }`,仅为测试注入小值,不加环境变量/配置面。

## 生产细节

- **terminate 而非 close**:死连接上 close 握手永远完不成;terminate 砍 TCP,立即触发 close。
- **ping 发送异常 = 判死**:发送抛错说明连接已坏,按无 pong 同路径处理。
- **phone 连接同样覆盖**:顺带清理手机侧死连接(锁屏/切后台)。
- 定时器与连接生命周期绑定,close 即清;进程退出由 terminate 兜底。

## 测试计划(沿用 test/relay.test.ts 真连接风格)

1. **relay 判死**:注入 `heartbeat={intervalMs:50, maxMissed:2}`;客户端挂 `'ping'` 监听
   但不回 pong(`ws` 客户端收协议 ping 自动回 pong,故监听中先 `terminate` 底层模拟沉默)→
   断言 hub session 的 cli 置空、cliLeft 发出。
2. **relay 不误杀**:正常客户端(自动回 pong)跑 N 个心跳周期仍活。
3. **ce 心跳状态机**:小类 + 假 WebSocket,断言:2 次无 pong → terminate;pong 归零不误杀;
   close 后定时器已清。

## 非目标

- 不加应用层心跳消息(不动协议、不动零信任边界)。
- 不加配置项/环境变量。
- 不改 app(已核实无需)。
- `cliBuffer` 无上限问题另行处理。
