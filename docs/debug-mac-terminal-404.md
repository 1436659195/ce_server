# Mac 被控机排查指令(来自中继侧 Claude)

你在 Mac 被控机上。手机经中继连 ce 正常,但**建终端报错**(先是 `404`,后是 `Unable to connect`)。中继已确认链路健康(注册成功、手机加入成功、零判死),问题在**本机 ce ↔ 本机 Jupyter** 这一段。

## 背景结论(中继侧已完成的分析)

- ce 建终端链路:手机 → 中继 → ce → 本机 Jupyter:
  1. `POST http://127.0.0.1:<port>/api/terminals`(创建)
  2. `WS ws://127.0.0.1:<port>/terminals/websocket/<name>`(attach 输出流)
- 404 最可能落在第 2 步:**jupyterlab 4.x 的 `pip install jupyterlab` 不自带 terminado**(终端后端插件),该 WS 路由只有 terminado 存在才注册。`GET /api/terminals` 可能仍 200(Jupyter 核心活着),所以"curl 自测 200"不代表终端可用 —— 请勿用 `/api/terminals` 的 200 排除此问题。
- `Unable to connect` 是 Bun fetch 连不上 Jupyter:多半是旧 Jupyter 进程已死/换口,ce 还按 `~/.ce/jupyter.json` 里的旧地址打。

## 请依次执行并记录输出

### 第 1 步:确认环境

```bash
cat ~/.ce/jupyter.json                                  # ce 记住的 Jupyter 地址
python -m jupyter server list 2>&1                      # 实际活着的 Jupyter 列表
python -m pip show terminado 2>&1 | head -3             # 终端插件在不在(核心怀疑)
tail -30 ~/.ce/ce.log 2>/dev/null                       # ce 拉 Jupyter 的日志尾部
```

### 第 2 步:用 ce 的地址复现 404

把 `<port>` 换成 `~/.ce/jupyter.json` 里的端口:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:<port>/api/terminals" -H "Authorization: Token <token>"
curl -i "http://127.0.0.1:<port>/terminals/websocket/probe" \
  -H "Authorization: Token <token>" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" | head -3
```

判定:
- 第一条 200、第二条 **404/4044** → 坐实 terminado 缺失(WS 路由未注册)
- 第一条也连不上 → Jupyter 死了/换口,`jupyter server list` 里找活口或走第 3 步重来
- 注意 token 从 `~/.ce/jupyter.json` 里取,别用猜的

### 第 3 步:修复(按判定结果)

**缺 terminado(预期情况):**

```bash
python -m pip install terminado -i https://pypi.tuna.tsinghua.edu.cn/simple
```

**然后无论如何都要干净重启**(Jupyter 必须重启才加载插件;旧地址不可信):

```bash
pkill -f jupyterlab
rm ~/.ce/jupyter.json
```

重启 ce daemon(Mac 上):

```bash
pkill -f "ce --daemon" 2>/dev/null; sleep 1
nohup ce --daemon >> ~/.ce/daemon.log 2>&1 &   # 或按你们机器上的启动方式
```

观察新 daemon 输出,应看到 `[ce] 已启动 Jupyter:http://127.0.0.1:<新端口>`(全新自启,带 terminado)。

### 第 4 步:验证

- 本机:`curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://127.0.0.1:<新端口>/api/terminals" -H "Authorization: Token <新token>" -H "Content-Type: application/json" -d '{"cwd":"/tmp"}'` → 期望 200
- 端到端:手机上对这台机器点"+"建终端 → 应直接打开 shell

## 回报格式

把以下内容回传(手机上直接粘贴即可):
1. 第 1 步四条命令的完整输出
2. 第 2 步两条 curl 的 http_code
3. 第 3 步执行到哪一步、第 4 步结果
4. 如仍失败:`tail -50 ~/.ce/ce.log` + `~/.ce/daemon.log` 尾部

## 边界

- 不要动 `~/.ce/identity.json`(删了会换 cid,手机配对码作废要重扫)
- 不要同时跑两个 `ce --daemon`(有单例锁,但别手动绕)
- pip 装包只用上面给的清华源命令,不要升级 jupyterlab 本身(避免连带变动)
