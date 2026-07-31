/**
 * 握手认证 —— 把「明文 phonePub 即建 E2E 通道」改成「白名单 / PIN 门禁」。
 * 从 main.ts 提出以可单测(main.ts 顶层跑 main(),不可被测试 import)。纯逻辑 + 最小 IO。
 *
 * 威胁边界:白名单 key 是 phoneId(URL query 自报,中继不校验)。pin 模式下陌生人(新 phoneId)
 *   须带正确 PIN 才入册;已配对 phoneId 重连直接放行。冒充「已配对 phoneId」需先嗅探到该随机串
 *   —— 在 TLS 下不可行(传输层加固见阶段 2)。故本模块安全性以「中继有 TLS」为前提;本机 ws 自测无嗅探风险。
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const PATH = join(homedir(), '.ce', 'authorized-phones.json')

export type PairingMode = 'open' | 'pin'

/** 读已授权 phoneId;不存在/损坏 → 空。path 注入便于测试。 */
export function loadAuthorized(path: string = PATH): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(path, 'utf8')) as string[])
  } catch {
    return new Set()
  }
}

/** 追加 phoneId 并落盘;失败静默(内存仍有效)。path 注入便于测试。 */
export function addAuthorized(phoneId: string, path: string = PATH): void {
  const s = loadAuthorized(path)
  s.add(phoneId)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify([...s]))
  } catch {
    /* 写失败→仅内存有效 */
  }
}

/** 门禁裁决。allow=可建 E2E 通道;pair=本次为首次配对(调用方据此 addAuthorized)。 */
export function authorize(opts: {
  mode: PairingMode
  phoneId: string
  authorized: Set<string>
  pin?: string
  currentPin: string
}): { allow: boolean; pair: boolean } {
  if (opts.mode === 'open') return { allow: true, pair: false }
  if (opts.authorized.has(opts.phoneId)) return { allow: true, pair: false }
  if (opts.pin && opts.pin === opts.currentPin) return { allow: true, pair: true }
  return { allow: false, pair: false }
}
