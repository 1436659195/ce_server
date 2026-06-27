# E2E 加密规格(App 与 ce 共用)

> 两边都用 **libsodium**(`libsodium-wrappers`),按本规格实现 → 互通由库本身保证,**无跨语言互通问题**。
> 这是 App(`src/utils/e2e.ts`)与 ce(`src/shared/crypto.ts`)共同遵守的契约;改这里要两边同步。

## 1. 密钥(pairing 时一次性建立,后续复用)

1. 各自生成 X25519 密钥对:`crypto_box_keypair()` → `{ publicKey, privateKey }`。
2. **ce 的 publicKey 进二维码**;手机扫码后,在 pairing 握手里把自己的 publicKey 发给 ce(用配对码防抢占,Phase 2 实现)。
3. 配对完成后:每方持有「自己的 privateKey + 对方的 publicKey」。

## 2. 共享对称密钥

- `sharedKey = crypto_box_beforenm(peerPublicKey, myPrivateKey)` → 32 字节。
- X25519 的对称性:两边算出的 `sharedKey` **相同**。之后**两个方向用同一个 sharedKey**(对称密钥,无方向歧义)。

## 3. 每条 Frame.payload 加解密(crypto_secretbox,XSalsa20-Poly1305)

**加密:**
```
nonce = randombytes_buf(24)                 // 24 字节随机 nonce,每条都新随机
ct    = crypto_secretbox_easy(payload, nonce, sharedKey)
线路字节 = nonce(24) || ct
```

**解密:**
```
nonce = bytes[0:24]
ct    = bytes[24:]
payload = crypto_secretbox_open_easy(ct, nonce, sharedKey)
```

## 4. 红线

- **nonce 每条必须随机新生成,绝不复用**(同 key + nonce 复用 = 可破解)。
- 一律用 libsodium 成熟原语,**不自造密码学**。
- `sharedKey` 绑定 pairing 一次建立,持久化在手机(下次自动重连不重扫)。
- 中继**零信任**:它只转发密文,从不持 `sharedKey`、无法解密。
