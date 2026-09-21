/**
 * 握手认证 —— 把「明文 phonePub 即建 E2E 通道」改成「白名单 / PIN 门禁」。
 * 从 main.ts 提出以可单测(main.ts 顶层跑 main(),不可被测试 import)。纯逻辑 + 最小 IO。
 *
 * 威胁边界:白名单 key 是 phoneId(URL query 自报,中继不校验)。pin 模式下陌生人(新 phoneId)
 *   须带正确 PIN 才入册;已配对 phoneId 重连直接放行。冒充「已配对 phoneId」需先嗅探到该随机串
 *   —— 在 TLS 下不可行(传输层加固见阶段 2)。故本模块安全性以「中继有 TLS」为前提;本机 ws 自测无嗅探风险。
 *
 * 2026-09-21 三项加固(真机反馈"过段时间连不上必须重扫"根因修复):
 *  - 白名单落盘升级 {id,name,pairedAt}[]:兼容读旧 string[];名字随每次握手刷新(手机端可改名,
 *    ce 侧持久),多台手机在控制台可区分(此前全是无名 uuid / 全叫「我的手机」)。
 *  - PIN 落盘 ~/.ce/pin.json:此前每次启动随机 → 白名单意外丢条目(写盘失败/环境变化)即演变成
 *    "必须重扫"(手机存的旧 PIN 永远对不上新 PIN)。持久化后降级为"重输一次 PIN 即可"。
 *  - authorize 拒绝时给 denyReason(not_paired/pin_mismatch),main.ts 据此回 PairReject 帧
 *    (此前静默丢帧,手机只能 15s 超时,无从分辨原因)。
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const DIR = join(homedir(), '.ce')
const PATH = join(DIR, 'authorized-phones.json')
const PIN_PATH = join(DIR, 'pin.json')

export type PairingMode = 'open' | 'pin'

/** 白名单条目(2026-09-21 起带名字;旧格式 string[] 读时升级:name 空、pairedAt 0)。 */
export interface PairedPhone {
  id: string
  name: string
  /** 首次配对时间(ms;0 = 旧格式迁移,未知)。 */
  pairedAt: number
}

/** 读白名单(兼容旧 string[] 条目);不存在/损坏 → 空。path 注入便于测试。 */
export function loadPaired(path: string = PATH): PairedPhone[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: PairedPhone[] = []
  for (const e of raw) {
    if (typeof e === 'string') {
      out.push({ id: e, name: '', pairedAt: 0 }) // 旧格式条目
    } else if (typeof e === 'object' && e !== null && typeof (e as PairedPhone).id === 'string') {
      const o = e as Partial<PairedPhone>
      out.push({
        id: o.id as string,
        name: typeof o.name === 'string' ? o.name : '',
        pairedAt: typeof o.pairedAt === 'number' ? o.pairedAt : 0,
      })
    }
  }
  return out
}

/** 读已授权 phoneId 集(authorize 门禁用;自 loadPaired 派生)。 */
export function loadAuthorized(path: string = PATH): Set<string> {
  return new Set(loadPaired(path).map((p) => p.id))
}

/** 落盘(尽力;写失败静默 → 内存仍有效,调用方重启后回退上次成功写入)。 */
function savePaired(list: PairedPhone[], path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(list))
  } catch {
    /* 写失败→仅内存有效 */
  }
}

/** 追加/更新白名单条目并落盘。已存在 → 只刷新显示名(手机改名由此传播),保留 pairedAt。 */
export function addAuthorized(phoneId: string, name = '', path: string = PATH): void {
  const list = loadPaired(path)
  const i = list.findIndex((p) => p.id === phoneId)
  if (i >= 0) {
    if (name) list[i] = { ...list[i], name }
  } else {
    list.push({ id: phoneId, name, pairedAt: Date.now() })
  }
  savePaired(list, path)
}

/** 移除 phoneId(踢手机)并落盘。 */
export function removeAuthorized(phoneId: string, path: string = PATH): void {
  const list = loadPaired(path).filter((p) => p.id !== phoneId)
  savePaired(list, path)
}

/**
 * 门禁裁决。allow=可建 E2E 通道;pair=本次为首次配对(调用方据此 addAuthorized);
 * denyReason=拒绝原因(allow=false 时必有;main.ts 回 PairReject 帧给手机,替代静默丢帧)。
 */
export function authorize(opts: {
  mode: PairingMode
  phoneId: string
  authorized: Set<string>
  pin?: string
  currentPin: string
}): { allow: boolean; pair: boolean; denyReason?: 'not_paired' | 'pin_mismatch' } {
  if (opts.mode === 'open') return { allow: true, pair: false }
  if (opts.authorized.has(opts.phoneId)) return { allow: true, pair: false }
  if (opts.pin && opts.pin === opts.currentPin) return { allow: true, pair: true }
  return { allow: false, pair: false, denyReason: opts.pin ? 'pin_mismatch' : 'not_paired' }
}

// ── PIN 持久化(2026-09-21:此前每次启动随机,见头注)──────────────────────────

/** 读持久 PIN;无/非法 → null(调用方回落随机生成)。 */
export function loadPin(path: string = PIN_PATH): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { pin?: string }
    return typeof raw.pin === 'string' && /^\d{6}$/.test(raw.pin) ? raw.pin : null
  } catch {
    return null
  }
}

/** 持久化 PIN(仅收 6 位数字;写失败静默,内存仍有效)。 */
export function savePin(pin: string, path: string = PIN_PATH): void {
  if (!/^\d{6}$/.test(pin)) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ pin }))
  } catch {
    /* 写失败→仅内存有效 */
  }
}
