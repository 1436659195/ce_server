# E2E 加密规格(App 与 ce 共用)

> 两边都用 **tweetnacl**(纯 JS nacl 实现,无 WASM;Bun / Capacitor WebView 都稳),按本规格实现 → 互通由同一套原语保证,**无跨语言互通问题**。
> 原语:X25519(nacl.box)+ XSalsa20-Poly1305(nacl.secretbox),与 libsodium 的 crypto_box/crypto_secretbox 同源、密文兼容。
> 这是 App(`src/utils/e2e.ts`,Phase 4)与 ce(`src/shared/crypto.ts`)共同遵守的契约;改这里要两边同步。

## 1. 密钥(pairing 时一次性建立,后续复用)

1. 各自生成 X25519 密钥对:`nacl.box.keyPair()` → `{ publicKey, secretKey }`(本仓库统一叫 `privateKey`)。
2. **ce 的 publicKey 进二维码**;手机扫码后,在 pairing 握手里把自己的 publicKey 发给 ce(用配对码防抢占,Phase 2/3 实现)。
3. 配对完成后:每方持有「自己的 privateKey + 对方的 publicKey」。

## 2. 共享对称密钥

- `sharedKey = nacl.box.before(peerPublicKey, myPrivateKey)` → 32 字节。
- X25519 的对称性:两边算出的 `sharedKey` **相同**。之后**两个方向用同一个 sharedKey**(对称密钥,无方向歧义)。

## 3. 每条 Frame.payload 加解密(nacl.secretbox,XSalsa20-Poly1305)

**加密:**
```
nonce = nacl.randomBytes(24)                 // 24 字节随机 nonce,每条都新随机
ct    = nacl.secretbox(payload, nonce, sharedKey)
线路字节 = nonce(24) || ct
```

**解密:**
```
nonce = bytes[0:24]
ct    = bytes[24:]
payload = nacl.secretbox.open(ct, nonce, sharedKey)   // 失败返回 null → 当作篡改/密钥不匹配,丢弃
```

## 4. 红线

- **nonce 每条必须随机新生成,绝不复用**(同 key + nonce 复用 = 可破解)。
- 一律用 tweetnacl 成熟原语,**不自造密码学**。
- `sharedKey` 绑定 pairing 一次建立,持久化在手机(下次自动重连不重扫)。
- 中继**零信任**:它只转发密文,从不持 `sharedKey`、无法解密。

## 5. RPC 操作契约(手机 ↔ ce,密文帧内)

手机发 `RPCReq { op, ... }`,ce 回 `RPCResp { ok, data?, error? }`。除 `listTerminals`/`deleteTerminal`/`detachTerminal` 为特例外,其余 `op`(`listDir`/`readFile`/`createDir`/`readFileRange`/`createTerminal`/`deleteFile`/`renameFile`/`saveFile`)由 `bridge.ts` 的 `handleRpc` 分派到本地 Jupyter REST。

文件写操作(直连与中继对称,见 `useFiles.ts` ↔ `bridge.ts`):

- **`deleteFile`**(`{ path }`):`DELETE /api/contents/{path}`(目录递归删)。
- **`renameFile`**(`{ path, newPath }`):`PATCH /api/contents/{path}` body `{path: newPath}`。`newPath` 是去前导 `/` 的逻辑路径(JSON 值,**不** URL-encode;URL 段才走 `encodePath`)。仅同目录改名。
- **`saveFile`**(`{ path, content, format }`):`PUT /api/contents/{path}` body `{type:'file', format:'text'|'base64', content}`。整文件覆盖(无分段语义):新建空文件(`content:''`)/ 编辑保存(text)/ 上传(base64)共用。

- **`listTerminals`**(特例,`main.ts` 处理 —— 需访问 ce 的 `terms` map 算 `managed`):返回 `{ ok: true, data: { terminals: RemoteTerminalInfo[] } }`,其中
  - `RemoteTerminalInfo = { name: string; lastActivityAt: number | null; managed: boolean; occupiedBy: string | null }`
  - ce 转发本地 `GET /api/terminals`,用 `toRemoteTerminals(all, managedSet)`(`bridge.ts`)映射:`name` = 终端名(= terminado session name = 隧道 TermOutput 的 sid);`lastActivityAt` = 解析 `last_activity` 的 ms 时间戳(无则 null);`managed` = 该终端是否在 ce `terms` map 里(= ce 经手过、有 terminado WS);`occupiedBy` = 当前占用者显示名(按 `terminalOwner` map 查 phone 显示名;空闲=`null`)。
  - 手机:**杀 app 重开自动恢复只挑 `managed=true`**(零回归);**「+」面板显示全部**,并据 `occupiedBy` 灰显别人正在用的(自己占用的仍可切)。
- **`deleteTerminal`**(`{ name }`,特例):关 ce 端 terminado WS + 本地 `DELETE /api/terminals/{name}`(硬删:杀服务器终端进程)。
- **`detachTerminal`**(`{ name }`,特例):只关 ce 端 terminado WS + 从 ce `terms` map 移除,**不** Jupyter DELETE(软移除:服务器终端保留)。→ 该终端 `managed` 变 false(杀 app 重开不自动恢复),但 `GET /api/terminals` 仍返回 →「+」面板可见、可重新接管。

## 6. Control 帧的密文 op(ce→手机,定向加密 + targetPhoneId 路由)

除手机→ce 的握手(明文 phonePub)/resize(密文)外,ce→手机 也用 `FrameType.Control` 发密文控制通知:

- **`attachDenied`**(`{ op:'attachDenied', name, occupiedBy }`):race 反馈。两手机近乎同时接管同一空闲终端,ce `tryAcquire` 按先到先得裁决,落败方(loser)此前已在本地建会话(接管面板点的)→ ce 给 loser 发此通知(用 loser 的 sharedKey 加密 + `targetPhoneId=loser` 路由)。loser 收到后**本地回滚该 session(软移除,`localOnly=true`:不再对 ce 发 `detachTerminal`,否则会误杀 winner 刚抢到的终端/占用)** + 弹 toast(`「name」刚被 occupiedBy 占用了`)。`occupiedBy` = winner 的显示名。

## 7. AI 管家(ce 托管,B 方案)

管家 cc 跑在 **ce 里**(被控机),由 ce 以**全 pipe** stdio spawn(`claude -p --input-format stream-json --output-format stream-json --verbose --allowedTools Read Grep Glob --add-dir / --append-system-prompt <skill>`)→ 等同 stream-json 长驻所需环境(无 PTY/TTY)。手机经新隧道帧与 ce 上的 cc 收发,**管家是中继专属**(直连无 ce,无管家)。

- **skill 由手机在 `butlerStart` RPC 里传**(`req.skill`),ce 不另存 skill 文本(避免两边复制)。
- cc 的 **stdout+stderr** 都回传(诊断:未装 claude 的报错在 stderr)。

### 7.1 RPC(复用 RPCReq/Resp)

- **`butlerStart`**(`{ op:'butlerStart', skill }`):ce spawn cc、登记 `owner=srcPhoneId`、回 `{ ok:true, data:{ sid } }`(`sid` 形如 `butler-<hex>`)。
- **`butlerStop`**(`{ op:'butlerStop', sid }`):ce kill 该 cc、清 map、回 `{ ok:true }`。

### 7.2 流帧(新增 FrameType)

- **`ButlerStdin`**(手机→ce,`sid`=butlerSid,payload 密文 = stream-json user 帧字节):ce 解密后 `writeStdin` 到 cc.stdin。
- **`ButlerOutput`**(ce→手机,`sid`=butlerSid,`targetPhoneId`=owner,payload 密文 = cc.stdout/stderr 原始字节):手机喂 stream-json 解析器。
- cc 进程退出时,ce 发一条 `ButlerOutput`,payload = `{"type":"system","subtype":"butler_exit","code":N}`(哨兵);手机见之转 `dead` + 提示。

### 7.3 生命周期

- **phoneLeft**:ce `stopAllForPhone(phoneId)`(该手机管家 cc 全 kill)。
- **中继断**:ce `stopAll()`(手机全失联,cc 全清);手机重连后重新 `butlerStart`(cc 新进程,旧对话不保留——MVP 可接受)。
- **多手机**:管家 `owner`=发起 `butlerStart` 的 phoneId;`ButlerOutput` 只定向该 phone(同终端占用语义)。
