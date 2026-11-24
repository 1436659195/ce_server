# 本地终端 & 文件后端服务 —— API 规格 v1.2

> **2026-09-21 · 本文档自足(self-contained),按此实现即可。**
> 不需要、也不建议去参考任何其他项目的源码 —— 以本文档为唯一契约;与参考实现(见 §1)的行为差异以 §9 为准,不要"顺手修正"。
>
> 交付物:一个**独立的本地后端进程**,通过 HTTP + WebSocket 提供两类能力:
> **PTY 终端会话管理** 与 **根目录内的文件树读写**。
> 接口形状刻意与 Jupyter Server 2.x 的相应子集对齐(便于用真 Jupyter 做响应形状对照),
> 但实现完全独立、零 Python 依赖、单二进制分发。

---

## 1. 总览

| 能力 | 端点 | 说明 |
|---|---|---|
| 建终端 | `POST /api/terminals` | 起一个 PTY shell |
| 列终端 | `GET /api/terminals` | 现役终端列表 |
| 删终端 | `DELETE /api/terminals/{name}` | 杀 PTY 进程树 |
| 终端数据 | `WS /terminals/websocket/{name}?token=` | stdin/stdout/resize 双向通道 |
| 列目录 | `GET /api/contents/{path}`(目录) | 目录条目列表 |
| 读文件 | `GET /api/contents/{path}`(文件) | 全文(text 或 base64) |
| 建目录 | `PUT /api/contents/{path}` `{"type":"directory"}` | mkdir |
| 写文件 | `PUT /api/contents/{path}` `{"type":"file",...}` | 全文覆盖/新建 |
| 删除 | `DELETE /api/contents/{path}` | 文件或目录(递归) |
| 重命名/移动 | `PATCH /api/contents/{old}` `{"path":"new"}` | 改名或挪目录 |
| 分段读 | `GET /files/{path}` + `Range` 头 | 字节区间(大文件分段下载用) |
| 分段上传 | `POST /api/uploads` → `PUT /api/uploads/{id}` → commit/abort | 大文件流式上传 |
| 活性 | `GET /api/status` | 探活 |

参考实现提示:响应 JSON 形状可拿真 Jupyter Server 2.x 对照(`jupyter lab --ServerApp.root_dir=某目录` 起一个,curl 同款端点比对字段)。**但 §9 列出的差异点以本文档为准。**

## 2. 认证

- 所有 HTTP 请求带 `Authorization: Token <token>`;WS 用 URL 查询参数 `?token=<token>`(也应接受 Authorization 头)。
- token 错/缺 → `401`。HTTP 层错误体统一 `{"message": "<人类可读>"}`(客户端主要消费状态码,message 尽量有)。
- **只绑定 127.0.0.1**,不监听外网地址;不做 CORS(无浏览器直连场景)、不做 HTTPS、不做多用户/权限分级。

## 3. 通用约定

- **路径编码**:URL 路径段由调用方逐段 percent-encode(`/` 分隔);服务端须逐段 decode。根目录 = 空 path(`GET /api/contents/`,与 `/api/contents` 等价,两者都要接受)。路径一律是**相对 root 的逻辑路径**。
- **时间**:ISO 8601 / RFC3339 UTC(如 `2026-09-21T12:34:56.789Z`),客户端会用 `Date.parse` 解析。
- **大小**:一律字节。
- 文件树包含点开头文件(不过滤);符号链接列出为条目、读取时跟随,但 resolve 后必须仍在 root 内(§7)。

## 4. 文件 API

目录与文件共用 `GET /api/contents/{path}`,按磁盘实际类型返回不同模型。

### 4.1 列目录

`GET /api/contents/{path}`(path 为目录或空)→ `200`:

```json
{
  "name": "docs",
  "path": "docs",
  "type": "directory",
  "mimetype": null,
  "format": "json",
  "content": [
    {
      "name": "note.txt",
      "path": "docs/note.txt",
      "type": "file",
      "mimetype": "text/plain",
      "format": null,
      "content": null,
      "size": 1234,
      "last_modified": "2026-09-21T08:00:00.000Z",
      "created": "2026-09-20T08:00:00.000Z",
      "writable": true
    },
    {
      "name": "sub",
      "path": "docs/sub",
      "type": "directory",
      "mimetype": null,
      "format": null,
      "content": null,
      "size": null,
      "last_modified": "2026-09-21T07:00:00.000Z",
      "created": "2026-09-19T07:00:00.000Z",
      "writable": true
    }
  ],
  "size": null,
  "last_modified": "2026-09-21T08:00:00.000Z",
  "created": "2026-09-19T07:00:00.000Z",
  "writable": true
}
```

- 根目录:`name` 为 `""`、`path` 为 `""`。
- 条目顺序:按 `name` 字母序(大小写不敏感),目录与文件混排,结果须确定。
- `mimetype` 按扩展名猜测(text/plain、image/png、application/json…),未知给 `application/octet-stream`,目录给 `null`。
- 目录的 `size` 为 `null`。

### 4.2 读文件(全文)

`GET /api/contents/{path}`(path 为文件)→ `200`:

```json
{
  "name": "note.txt",
  "path": "docs/note.txt",
  "type": "file",
  "mimetype": "text/plain",
  "format": "text",
  "content": "文件全部内容…",
  "size": 1234,
  "last_modified": "2026-09-21T08:00:00.000Z",
  "created": "2026-09-20T08:00:00.000Z",
  "writable": true
}
```

- **text/base64 判定**:文件内容能严格按 UTF-8 解码 → `format:"text"`、`content` 为解码后字符串;否则 `format:"base64"`、`content` 为字节流的 base64。二进制安全,不许乱码。
- `size` 是**磁盘字节数**(不是 content 字符串长度),必须准确。
- 全文返回即可,无需分页(调用方有大文件保护);大文件序列化建议流式/分块,不得 OOM。
- 文件不存在 → `404`;path 是目录时不会走到这里(按目录模型返回)。

### 4.3 建目录

`PUT /api/contents/{path}`,body `{"type": "directory"}` → `201`。
- 语义等同 `mkdir -p`(含父目录);目录已存在 → **幂等成功 201**(见 §9)。

### 4.4 写文件(全文覆盖 / 新建)

`PUT /api/contents/{path}`,body:

```json
{"type": "file", "format": "text", "content": "新内容…"}
```

或 base64:`{"type":"file","format":"base64","content":"5a2x5ZOl…"}`(按字节写)。
- 覆盖已有文件或新建(含父目录),→ `201`。写入须原子性可见(先写临时文件再 rename 更佳)。

### 4.5 删除

`DELETE /api/contents/{path}` → `204`。
- 文件或目录都可删;**目录递归删除,不需要任何额外查询参数**(见 §9)。
- 目标不存在 → **幂等 `204`**(见 §9)。

### 4.6 重命名 / 移动

`PATCH /api/contents/{oldPath}`,body `{"path": "<新相对路径>"}` → `200`。
- body 里的 `path` 是**未 URL 编码的相对路径**(JSON 字符串,无前导 `/`)。
- 支持改名与移动(新路径可含子目录);目标已存在 → `400`,绝不覆盖。

### 4.7 分段读(字节区间)

`GET /files/{path}`(注意:没有 `/api` 前缀),带 `Range: bytes=<start>-<end>` 头 → `206`:

```
Content-Range: bytes 0-1048575/5242880
Content-Type: application/octet-stream
<body 为请求区间的原始字节>
```

- `Content-Range` 尾部 `/total` 的 total 必须是**文件总字节数**(调用方靠正则 `/\/(\d+)/` 提取)。
- 支持闭区间 `start-end` 与开放区间 `start-`(到文件尾);区间不合法/越界 → `416`。
- 调用方按 `start+本次字节数 >= total` 判 eof,所以 body 长度必须精确等于实际返回的字节数。
- 对目录请求 → `400`。

### 4.8 分段上传(大文件流式写)

整文件小上传用 §4.4(PUT base64)即可;本节给大文件提供流式通道,共四个操作:

**① 开会话** `POST /api/uploads`,body:

```json
{"path": "docs/big.bin", "totalSize": 52428800}
```

→ `201` `{"uploadId": "<随机不可猜 id>", "received": 0}`
- `path` 为相对 root 的逻辑路径,过 §7 牢笼校验(越界 `403`);目标已存在 → 提交时覆盖。
- 同时进行的会话数上限 16,超出 `429`。

**② 追加字节** `PUT /api/uploads/{uploadId}`,body 为**原始字节**(`Content-Type: application/octet-stream`,不做 base64):

→ `200` `{"received": <累计已收字节数>}`
- 调用方保证分片**按顺序**发,服务端顺序追加,无 offset/随机写语义。
- 累计超过 `totalSize` → `400` 且会话作废。
- 会话 10 分钟无任何请求 → 自动作废(临时数据丢弃)。

**③ 提交** `POST /api/uploads/{uploadId}/commit`:

→ `201` `{"path": "docs/big.bin", "size": 52428800}`
- 仅当 `received == totalSize` 允许提交,否则 `400`。
- 落盘原子(先写临时文件再 rename 到目标),已存在则覆盖。

**④ 中止** `DELETE /api/uploads/{uploadId}` → `204`,丢弃临时数据。

## 5. 终端 REST

### 5.1 建终端

`POST /api/terminals`,body:

```json
{"cwd": "C:\\Users\\me\\projects\\demo"}
```

- `cwd` 是**绝对 OS 路径**,且必须位于 root 目录内(否则 `400`)。
- 可选 `{"name": "<id>"}`:该名终端已存在 → 直接返回它(幂等);不存在 → 以该名新建。
- 无 `name` 时服务端生成唯一 id(UUID hex 即可)。
- → `200`:

```json
{"name": "6f9a…", "last_activity": "2026-09-21T08:00:00.000Z"}
```

- 语义:spawn 一个 PTY 跑默认 shell(cwd=给定路径),返回即代表终端可用(不要求 shell 已产出输出)。

### 5.2 列终端

`GET /api/terminals` → `200`,数组:

```json
[{"name": "6f9a…", "last_activity": "2026-09-21T08:05:00.000Z"}]
```

- `last_activity` 在有 stdin(必须)与 stdout(建议)活动时刷新 —— 调用方展示"最近活跃"。

### 5.3 删终端

`DELETE /api/terminals/{name}` → `204`;不存在 → `404`。
- 必须杀死整个进程树(Windows:递归杀子进程)。

## 6. 终端 WebSocket

- URL:`ws://127.0.0.1:<port>/terminals/websocket/{name}?token=<token>`(**无 `/api` 前缀**)。
- 子协议为 JSON 数组文本帧:

| 方向 | 帧 | 含义 |
|---|---|---|
| 服务端→客户端 | `["stdout", "<字符串>"]` | 终端输出(UTF-8,含 ANSI 转义,原样透传) |
| 服务端→客户端 | `["stderr", "<字符串>"]` | 错误通道输出(可选;客户端会以红色渲染。PTY 场景可全部走 stdout,不强制分离) |
| 客户端→服务端 | `["stdin", "<字符串>"]` | 用户键入 |
| 客户端→服务端 | `["set_size", <rows>, <cols>]` | resize(先 rows 后 cols,整数) |
| 服务端→客户端 | `["disconnect", <code>]` | PTY 进程退出(可选发;随后关 WS) |

- 未知帧类型:忽略不报错。
- **终端名不存在 → WS 握手阶段拒绝(HTTP 404)**;token 错 → 握手拒绝(401/403)。客户端依赖握手失败来清理状态、择机重建。
- **生命周期与连接解耦**:所有 WS 客户端断开,终端必须继续存活(直到 DELETE);新连接只收**新产出**的输出,**无需、也不要**回放历史。
- 允许同一终端多条并发 WS:stdout 广播给所有连接,stdin 任一连接可写。
- 终端进程退出:向所有连接发 `["disconnect",…]`(可选)并关闭 WS;终端从列表消失。
- 认证失败:WS 握手阶段拒绝(403/401)。

## 7. 安全边界(root 牢笼)

- 服务端持有一个配置的 `root` 目录;所有 `{path}` 解析后必须落在 root 内,越界(`..`、绝对路径注入、符号链接逃逸)→ `403`。
- 终端 `cwd` 同样必须落在 root 内。
- 终端里 shell 本身可以 `cd` 到 root 之外 —— 这是终端的天然能力,**不做拦截**;牢笼只约束上述 API 的路径参数。

## 8. 进程与运维要求

**启动参数**(命令行旗标,`--key=value` 形式):

| 旗标 | 必填 | 说明 |
|---|---|---|
| `--root=<dir>` | 是 | 根目录;不存在则启动失败退出非 0 |
| `--port=<n>` | 否 | 缺省 0 = 自动选空闲端口 |
| `--token=<s>` | 否 | 缺省自动生成随机 token |
| `--shell=<path>` | 否 | 覆盖默认 shell 探测 |
| `--host=<ip>` | 否 | 缺省 127.0.0.1(一般不该改) |

**就绪信号**:监听成功后向 **stdout 输出单行 JSON**(之后 stdout 不再有任何输出,日志一律走 stderr):

```json
{"ready": true, "url": "http://127.0.0.1:51717", "token": "随机生成时才有此字段", "root": "/home/me/workspace"}
```

**进程纪律**:
- SIGINT/SIGTERM → 杀掉全部 PTY 子进程树后退出码 0。
- 服务自身被 kill -9 时,子进程不得成为孤儿继续存活(Linux:进程组或 `PR_SET_PDEATHSIG`;Windows:Job Object)。
- 崩溃时日志含可定位的错误栈(stderr)。

**平台矩阵**(交叉编译、单静态二进制、零运行时依赖):

| 目标 | 必需 |
|---|---|
| windows/amd64 | ✅(conPTY;默认 shell 探测 `pwsh.exe`→`powershell.exe`→`%COMSPEC%`;UTF-8 输出;不弹控制台窗口) |
| linux/amd64 | ✅ |
| linux/arm64 | ✅ |
| darwin/arm64 | ✅(darwin/amd64 加分) |

Linux/macOS 默认 shell:`$SHELL` → 按 OS 兜底(`bash`/`zsh`/`sh`)。

## 9. 与 Jupyter 参考行为的差异(有意为之,**不要"修正"**)

| # | 差异 | 原因 |
|---|---|---|
| 1 | `DELETE /api/contents/{path}` 目录直接递归删,无需 `?recursive=true`;不存在幂等 204 | 调用方不带 recursive 参数,且重试场景需要幂等 |
| 2 | `PUT` 建目录幂等(已存在也 201) | 交互重试容错 |
| 3 | 无 notebook / kernel / session / contents 分页等一切本表之外的端点 | 只需本表子集;多的不做 |
| 4 | WS 无输出历史回放 | 调用方自行管理重连后的界面状态 |
| 5 | `POST /api/terminals` 的 `cwd` 强制必须在 root 内(Jupyter 不强制) | 服务边界一致性 |

## 10. 技术选型建议(非约束,按成熟度推荐)

- **Go**:`creack/pty`(v1.1.19+ 自带 Windows conPTY 支持)+ `net/http` + `gorilla/websocket`;单静态二进制、`GOOS/GOARCH` 交叉编译开箱即用,与本规格的分发要求天然吻合。
- Rust 亦可(`portable-pty` + `axum` + `tokio-tungstenite`),迭代成本略高。
- **不建议**绑定 Node.js 生态实现 PTY(原生模块分发与单二进制目标冲突)。

## 11. 验收清单(实现完成后的自测,全部通过才算交付)

```bash
# 环境变量 T=<token> U=http://127.0.0.1:<port>
# 1) 活性
curl -s -H "Authorization: Token $T" $U/api/status            # → 200 {"ok":true}
# 2) 建目录 → 列目录 → 写文件 → 读回 → 分段读 → 改名 → 删除
curl -s -X PUT -H "Authorization: Token $T" -d '{"type":"directory"}'    $U/api/contents/a/b
curl -s    -H "Authorization: Token $T"                                  $U/api/contents/ | jq '.content[].name'
curl -s -X PUT -H "Authorization: Token $T" -d '{"type":"file","format":"text","content":"hello 世界"}' $U/api/contents/a/b/hello.txt
curl -s    -H "Authorization: Token $T"                                  $U/api/contents/a/b/hello.txt | jq '.format,.content,.size'
printf '\x00\xff\xfe' > /tmp/bin.dat  # 二进制走 base64 分支:
curl -s -X PUT -H "Authorization: Token $T" -d "$(jq -n --arg b "$(base64 -w0 /tmp/bin.dat)" '{"type":"file","format":"base64","content":$b}')" $U/api/contents/a/bin.dat
curl -s -H "Authorization: Token $T" $U/api/contents/a/bin.dat | jq '.format'   # → "base64"
curl -s -H "Authorization: Token $T" -H "Range: bytes=0-4" $U/files/a/b/hello.txt -D - -o /dev/null | grep -i content-range
curl -s -X PATCH -H "Authorization: Token $T" -d '{"path":"a/b/hi.txt"}' $U/api/contents/a/b/hello.txt
curl -s -X DELETE -H "Authorization: Token $T" $U/api/contents/a/b/hi.txt -w '%{http_code}\'  # → 204
# 3) 越界一律 403
curl -s -o /dev/null -w '%{http_code}\' -H "Authorization: Token $T" "$U/api/contents/..%2F..%2Fetc"
# 4) 终端:建 → WS 打字/回显/resize → 列表 last_activity 变化 → 删
curl -s -X POST -H "Authorization: Token $T" -d "{\"cwd\":\"$ROOT_ABS\"}" $U/api/terminals   # 记下 name
websocat "ws://127.0.0.1:<port>/terminals/websocket/<name>?token=$T"      # 手动发 ["stdin","echo hi\r"] 与 ["set_size",24,80]
curl -s -X DELETE -H "Authorization: Token $T" $U/api/terminals/<name> -w '%{http_code}\'    # → 204
# 5) 断 WS 后终端存活:断开 websocat → GET /api/terminals 仍列出 → 重连仍能收新输出
# 7) 分段上传:开会话 → 两段追加 → commit → 校验大小/内容一致 → 再开一个走 abort
UID=$(curl -s -X POST -H "Authorization: Token $T" -d '{"path":"a/big.bin","totalSize":6}' $U/api/uploads | jq -r .uploadId)
curl -s -X PUT -H "Authorization: Token $T" --data-binary 'abc' $U/api/uploads/$UID    # → {"received":3}
curl -s -X PUT -H "Authorization: Token $T" --data-binary 'def' $U/api/uploads/$UID    # → {"received":6}
curl -s -X POST -H "Authorization: Token $T" $U/api/uploads/$UID/commit
curl -s -H "Authorization: Token $T" $U/api/contents/a/big.bin | jq '.size,.content'   # → 6, "abcdef"
UID2=$(curl -s -X POST -H "Authorization: Token $T" -d '{"path":"a/x.bin","totalSize":99}' $U/api/uploads | jq -r .uploadId)
curl -s -X DELETE -H "Authorization: Token $T" $U/api/uploads/$UID2 -w '%{http_code}\'  # → 204,无残留临时文件
# 8) 信号:SIGTERM 后进程退出码 0 且无残留 shell 子进程(Windows 上任务管理器验证进程树被杀)
```

交付物清单:四平台二进制 + 上述清单自测记录 + README(启动参数、ready 行格式)。

---
*版本 v1.2(2026-09-21;v1.1 增补 §4.8 分段上传,v1.2 增补 stderr 帧、WS 握手 404、根路径等价写法)。契约问题以本文档为准;发现文档自身矛盾,按"更严格/更安全"的解释实现并标注。*
