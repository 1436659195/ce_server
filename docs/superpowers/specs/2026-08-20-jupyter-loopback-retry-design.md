# Jupyter 地址落盘固化 + listTerminals 短重试 设计文档

日期:2026-08-20
状态:已批准(方案 A:300ms × 1 次重试)

## 背景

Mac 被控机排查反馈(debug 结论见会话记录):手机(重)配对瞬间 `GET/POST /api/terminals`
瞬时 404,同进程同 token 随后恢复 200;terminado 已装且 WS 101 正常。被控机侧智能体
判定为"配对瞬间冷启动竞态";中继侧复核锁定歧义入口:**`~/.ce/jupyter.json` 落盘的是
Jupyter 打印的 `http://localhost:<port>`**,而 `isAlive(saved.url)` 验活与首次请求用
未转换的 `localhost` —— Mac 上 Bun 将 localhost 解析到 `::1`(IPv6),Jupyter 双栈监听
(127.0.0.1 + ::1),两栈行为在扩展加载/请求路由上存在瞬时差异窗口。

## 修复

### ① 落盘即固化 127.0.0.1(main.ts:264)

- `writeFileSync(... jupyter.json ...)` 的 `url: server.url` → `url: toLoopback(server.url)`
- `isAlive(saved.url)`(main.ts:219)随之自然打 v4
- 读回路径(main.ts:221)的 `toLoopback` 转换保留:防御旧存量文件(盘上还是 localhost)
- 显式 `--jupyter-url` 不受影响(不经落盘)

### ② listTerminals 首错 300ms 重试 1 次(main.ts RPC 分发处)

- 单次调用改小循环:失败 → sleep 300ms → 重试 1 次 → 仍失败才降级空列表
- 降级日志改标 `重试后仍失败`;成功路径零变化
- 只重试 listTerminals;createTerminal 失败原样报给用户(不吞错)

## 测试

- ①:断言落盘 URL 含 `127.0.0.1` 不含 `localhost`
- ②:fake JupyterClient —— 首抛次成 → 拿到数据;两抛 → 降级空列表不抛出

## 非目标

- 不改 toLoopback 支持其他 host;不给 createTerminal 加重试
- 不迁移存量 jupyter.json(升级重启后 isAlive 失败 → 自起新 Jupyter → 落盘新地址,自然收敛)
