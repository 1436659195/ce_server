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

手机发 `RPCReq { op, ... }`,ce 回 `RPCResp { ok, data?, error? }`。除 `listTerminals`/`deleteTerminal` 为特例外,其余 `op`(`listDir`/`readFile`/`createDir`/`readFileRange`/`createTerminal`)由 `bridge.ts` 的 `handleRpc` 分派到本地 Jupyter REST。

- **`listTerminals`**(特例,`main.ts` 处理 —— 需访问 ce 的 `terms` map 算 `managed`):返回 `{ ok: true, data: { terminals: RemoteTerminalInfo[] } }`,其中
  - `RemoteTerminalInfo = { name: string; lastActivityAt: number | null; managed: boolean }`
  - ce 转发本地 `GET /api/terminals`,用 `toRemoteTerminals(all, managedSet)`(`bridge.ts`)映射:`name` = 终端名(= terminado session name = 隧道 TermOutput 的 sid);`lastActivityAt` = 解析 `last_activity` 的 ms 时间戳(无则 null);`managed` = 该终端是否在 ce `terms` map 里(= ce 经手过、有 terminado WS)。
  - 手机:**杀 app 重开自动恢复只挑 `managed=true`**(零回归);**「+」面板显示全部**。
- **`deleteTerminal`**(`{ name }`,特例):关 ce 端 terminado WS + 本地 `DELETE /api/terminals/{name}`。
