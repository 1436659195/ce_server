import nacl from 'tweetnacl'

/**
 * E2E 加密(App 与 ce 共用,见 src/shared/spec.md)。全 TS → 两边都用 tweetnacl
 * (纯 JS nacl 实现,无 WASM;Bun / Capacitor WebView 都稳),互通由同一套原语保证。
 *
 * 原语:X25519(nacl.box)+ XSalsa20-Poly1305(nacl.secretbox),与 libsodium 的
 * crypto_box/crypto_secretbox 同源、密文兼容。
 */
export interface KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

/** 生成 X25519 密钥对(ce 启动 / 手机配对时各生成一次)。 */
export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair() // tweetnacl 字段名为 secretKey
  return { publicKey: kp.publicKey, privateKey: kp.secretKey }
}

/**
 * ECDH 共享密钥:用「己方私钥 + 对方公钥」算出 32 字节对称 key。
 * 两方各自算出的结果相同(X25519 对称性);两个方向用同一个 key。
 */
export function sharedSecret(myPrivateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  // tweetnacl: nacl.box.before(publicKey, secretKey)
  return nacl.box.before(peerPublicKey, myPrivateKey)
}

/** 加密:随机 24B nonce + secretbox 密文,拼成 nonce || ciphertext 传输。 */
export function seal(sharedKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength) // 24
  const ct = nacl.secretbox(plaintext, nonce, sharedKey)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce, 0)
  out.set(ct, nonce.length)
  return out
}

/** 解密:拆 nonce(前 24B)+ 密文 → secretbox.open;认证失败抛错(AEAD 完整性)。 */
export function open(sharedKey: Uint8Array, sealed: Uint8Array): Uint8Array {
  const n = nacl.secretbox.nonceLength
  const nonce = sealed.subarray(0, n)
  const ct = sealed.subarray(n)
  const pt = nacl.secretbox.open(ct, nonce, sharedKey)
  if (!pt) throw new Error('解密失败:密文被篡改或密钥不匹配')
  return pt
}
