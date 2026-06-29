import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { generateKeyPair } from '../shared/crypto'

const DIR = join(homedir(), '.ce')
const PATH = join(DIR, 'identity.json')

export interface Identity {
  cid: string // 机器稳定标识(中继按它复用 sid/token)
  publicKey: Uint8Array // E2E 公钥(进二维码,手机存;持久 → 手机配对码长期有效)
  privateKey: Uint8Array
}

/**
 * ce 持久身份(机器绑定):cid + E2E 密钥对。首次生成存 ~/.ce/identity.json,之后复用。
 * 这样 ce 重启 / 中继重启后,手机存的 cliPub 与中继里的 sid 仍匹配,不必重扫。
 * 写失败(只读环境)→ 仅本次内存有效,退化为旧的「每次新密钥」行为。
 */
export function loadOrCreateIdentity(): Identity {
  try {
    if (existsSync(PATH)) {
      const raw = JSON.parse(readFileSync(PATH, 'utf8')) as {
        cid: string
        publicKey: number[]
        privateKey: number[]
      }
      return {
        cid: raw.cid,
        publicKey: new Uint8Array(raw.publicKey),
        privateKey: new Uint8Array(raw.privateKey),
      }
    }
  } catch {
    /* 损坏→重建 */
  }
  const kp = generateKeyPair()
  const cid = randomBytes(12).toString('hex')
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      PATH,
      JSON.stringify({
        cid,
        publicKey: Array.from(kp.publicKey),
        privateKey: Array.from(kp.privateKey),
      })
    )
  } catch {
    /* 写失败→仅内存 */
  }
  return { cid, publicKey: kp.publicKey, privateKey: kp.privateKey }
}
