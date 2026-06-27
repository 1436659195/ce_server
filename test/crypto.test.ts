import { test, expect } from 'bun:test'
import { generateKeyPair, sharedSecret, seal, open } from '../src/shared/crypto'

// E2E 加密(X25519 + secretbox),全 TS 共用 tweetnacl。这是 App 与 ce 互通的契约。
// 每个 case 里 alice/bob 各自独立派生 sharedKey —— 本身就验证了两方互通。

const enc = new TextEncoder()
const dec = new TextDecoder()

test('ECDH 对称性:双方独立算出相同 sharedKey', () => {
  const alice = generateKeyPair()
  const bob = generateKeyPair()
  const keyAB = sharedSecret(alice.privateKey, bob.publicKey) // A:己私 + 对方公
  const keyBA = sharedSecret(bob.privateKey, alice.publicKey) // B:己私 + 对方公
  expect(keyAB).toEqual(keyBA) // ECDH 对称 → 相同
})

test('seal/open round-trip:A 加密、B 解密(跨方互通)', () => {
  const alice = generateKeyPair()
  const bob = generateKeyPair()
  const keyAB = sharedSecret(alice.privateKey, bob.publicKey)
  const keyBA = sharedSecret(bob.privateKey, alice.publicKey)

  const sealed = seal(keyAB, enc.encode('hello 加密通信'))
  expect(dec.decode(open(keyBA, sealed))).toBe('hello 加密通信')
})

test('篡改密文 → 解密失败(AEAD 完整性)', () => {
  const alice = generateKeyPair()
  const bob = generateKeyPair()
  const keyAB = sharedSecret(alice.privateKey, bob.publicKey)
  const keyBA = sharedSecret(bob.privateKey, alice.publicKey)

  const sealed = seal(keyAB, enc.encode('secret'))
  const tampered = sealed.slice()
  tampered[tampered.length - 1] ^= 0xff // 翻转最后一字节
  expect(() => open(keyBA, tampered)).toThrow()
})
