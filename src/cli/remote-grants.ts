/**
 * 远程授权 —— 让另一台机器上的 ce（带着数字人）以「受限制的设备」身份连到本机，且只能操作终端。
 * 从 main.ts 提出以可单测(main.ts 顶层跑 main(),不可被测试 import)。纯逻辑 + 最小 IO,仿 pairing.ts。
 *
 * 信任模型(与手机配对同一量级,不更弱):
 *  - 凭证的编号、对端编号、密钥都由本机生成,手机只负责转交;
 *  - 握手不带密钥明文,只带「密钥对本次临时公钥的 HMAC」,中继仍然只转密文;
 *  - 对端编号一旦登记过凭证(含已撤销),握手只认凭证,不回落白名单 / PIN / 免配对;
 *  - 「只开终端」是接口白名单,不是沙箱:终端里的命令拥有本机用户的全部权限。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const DIR = join(homedir(), '.ce')
const PATH = join(DIR, 'remote-grants.json')

/** 对端握手时自报的编号前缀:与真手机的 uuid 区分开。 */
export const GRANT_PEER_PREFIX = 'grant-'
export const GRANT_LIMIT = 20
const MAC_CONTEXT = 'ce-remote-grant:v1:'

/** 一张凭证:哪个对端、能在哪个目录开终端。 */
export interface RemoteGrant {
  /** 凭证编号 grant_<hex12>。 */
  id: string
  /** 对端编号 grant-<hex12>:对端握手时自报的 phoneId,与凭证一一绑定。 */
  peerId: string
  /** 给人看的标签:哪台机器的哪个数字人。 */
  label: string
  /** 工作目录的逻辑路径(相对本机文件根目录,以 / 开头)。 */
  directory: string
  directoryAbs: string
  /** 32 字节随机数的 base64:对端用它出示握手证明。 */
  key: string
  createdBy: string
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
}
export type RemoteGrantPublic = Omit<RemoteGrant, 'key'>

/** 交给对端保存的票据:凭证加本机的连接信息。 */
export interface RemoteGrantTicket {
  grantId: string
  key: string
  peerId: string
  label: string
  directory: string
  directoryAbs: string
  relayUrl: string
  sid: string
  cliPub: string
  token: string
  platform?: string
}

/** 读凭证表;不存在/损坏 → 空。path 注入便于测试。 */
export function loadRemoteGrants(path: string = PATH): RemoteGrant[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: RemoteGrant[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const g = e as Partial<RemoteGrant>
    if (typeof g.id !== 'string' || typeof g.peerId !== 'string' || typeof g.key !== 'string' || typeof g.directory !== 'string') continue
    out.push({
      id: g.id, peerId: g.peerId,
      label: typeof g.label === 'string' ? g.label : '',
      directory: g.directory,
      directoryAbs: typeof g.directoryAbs === 'string' ? g.directoryAbs : '',
      key: g.key,
      createdBy: typeof g.createdBy === 'string' ? g.createdBy : '',
      createdAt: typeof g.createdAt === 'number' ? g.createdAt : 0,
      ...(typeof g.lastUsedAt === 'number' ? { lastUsedAt: g.lastUsedAt } : {}),
      ...(typeof g.revokedAt === 'number' ? { revokedAt: g.revokedAt } : {}),
    })
  }
  return out
}

/** 凭证表:内存为准、变更即落盘(0600,先写临时文件再改名)。 */
export class RemoteGrants {
  private map = new Map<string, RemoteGrant>()

  constructor(private readonly path: string = PATH) {
    for (const g of loadRemoteGrants(this.path)) this.map.set(g.id, g)
  }

  /** 全部凭证(含已撤销),先开的在前。 */
  list(): RemoteGrant[] {
    return [...this.map.values()]
  }
  active(): RemoteGrant[] {
    return this.list().filter(g => !g.revokedAt)
  }
  get(id: string): RemoteGrant | undefined {
    return this.map.get(id)
  }
  /** 该对端编号当前有效的凭证。 */
  byPeer(peerId: string): RemoteGrant | undefined {
    return this.active().find(g => g.peerId === peerId)
  }
  /** 该对端编号是否登记过凭证(含已撤销):登记过就只认凭证。 */
  everRegistered(peerId: string): boolean {
    return this.list().some(g => g.peerId === peerId)
  }
  create(p: { label: string; directory: string; directoryAbs: string; createdBy: string }): RemoteGrant {
    if (this.active().length >= GRANT_LIMIT) throw new Error(`远程授权最多 ${GRANT_LIMIT} 张,请先撤销不用的`)
    const grant: RemoteGrant = {
      id: `grant_${randomBytes(6).toString('hex')}`,
      peerId: GRANT_PEER_PREFIX + randomBytes(6).toString('hex'),
      label: p.label, directory: p.directory, directoryAbs: p.directoryAbs,
      key: randomBytes(32).toString('base64'),
      createdBy: p.createdBy, createdAt: Date.now(),
    }
    this.map.set(grant.id, grant)
    this.save()
    return grant
  }
  /** 撤销:标记时间,不删记录(对端编号从此只认凭证,而凭证已失效)。 */
  revoke(id: string): RemoteGrant | undefined {
    const grant = this.map.get(id)
    if (!grant || grant.revokedAt) return undefined
    grant.revokedAt = Date.now()
    this.save()
    return grant
  }
  touch(id: string, at: number): void {
    const grant = this.map.get(id)
    if (!grant) return
    grant.lastUsedAt = at
    this.save()
  }
  /** 给人看的列表:不带密钥。 */
  publicList(): RemoteGrantPublic[] {
    return this.list().map(({ key: _key, ...rest }) => rest)
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify([...this.map.values()]))
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.path)
    } catch {
      /* 写失败 → 仅内存有效 */
    }
  }
}

/** 握手证明:密钥对「本次连接的临时公钥」的 HMAC。对端每次连接换新公钥,重放的旧帧和旧证明都失效。 */
export function grantMac(keyB64: string, phonePubB64: string): string {
  return createHmac('sha256', Buffer.from(keyB64, 'base64')).update(MAC_CONTEXT + phonePubB64).digest('base64')
}

function macEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'base64')
  const right = Buffer.from(b, 'base64')
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

export type GrantHandshake = { kind: 'pass' } | { kind: 'reject' } | { kind: 'admit'; grant: RemoteGrant }

/**
 * 握手裁决(纯函数)。对端编号登记过凭证(含已撤销)→ 只认凭证,证明有效才放行;
 * 没登记过且没带凭证 → 交给原有配对门禁;带了凭证但编号或证明对不上 → 拒绝。
 */
export function grantHandshake(input: { grants: RemoteGrant[]; phoneId: string; claim?: unknown; phonePubB64: string }): GrantHandshake {
  const forced = input.grants.some(g => g.peerId === input.phoneId)
  if (!forced && input.claim === undefined) return { kind: 'pass' }
  const grant = input.grants.find(g => g.peerId === input.phoneId && !g.revokedAt)
  const claim = input.claim && typeof input.claim === 'object' ? input.claim as { id?: unknown; mac?: unknown } : undefined
  if (!grant || !claim || claim.id !== grant.id || typeof claim.mac !== 'string' || !macEqual(claim.mac, grantMac(grant.key, input.phonePubB64))) return { kind: 'reject' }
  return { kind: 'admit', grant }
}

/** 逻辑路径(相对文件根目录):统一成以 / 开头、无尾斜杠;根目录是 /。 */
export function normalizeLogical(path: string): string {
  const parts: string[] = []
  for (const seg of path.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

/**
 * 开凭证时解析工作目录:必须在本机文件根目录之内、真实存在;不许带 . 或 .. 段
 * (ce 建终端时目录不存在会在别处静默启动,所以这里先拦)。
 */
export function resolveGrantDirectory(rootDir: string, logical: string): { ok: true; directory: string; abs: string } | { ok: false; error: string } {
  if (typeof logical !== 'string' || !logical.startsWith('/') || /[\r\n\0\\]/u.test(logical)) return { ok: false, error: '目录路径无效' }
  if (logical.split('/').some(seg => seg === '.' || seg === '..')) return { ok: false, error: '目录路径不能包含 . 或 ..' }
  const directory = normalizeLogical(logical)
  const root = resolve(rootDir)
  const abs = resolve(root, '.' + directory)
  // 根目录本身就是 / 时,任何绝对路径都在根之内;不能用 root + sep 前缀判(会变成 '//' 开头,永不匹配)
  const insideRoot = root === sep || abs === root || abs.startsWith(root + sep)
  if (!insideRoot) return { ok: false, error: '目录不在本机文件根目录之内' }
  let stat
  try {
    stat = statSync(abs)
  } catch {
    return { ok: false, error: `目录不存在:${directory}` }
  }
  if (!stat.isDirectory()) return { ok: false, error: `不是目录:${directory}` }
  return { ok: true, directory, abs }
}

/** 建终端的目录只能落在授权目录之内(根目录 / 表示整个文件根)。 */
export function cwdWithinGrant(directory: string, cwd: string): boolean {
  const base = normalizeLogical(directory)
  const target = normalizeLogical(cwd)
  return base === '/' || target === base || target.startsWith(base + '/')
}

/** 对端能用的接口:只有终端四个。其余(exec、文件、内核、转发、chat.*、管家、上传)一律拒绝。 */
export const GRANT_RPC_OPS: ReadonlySet<string> = new Set(['createTerminal', 'listTerminals', 'deleteTerminal', 'detachTerminal'])
export function grantRpcAllowed(op: string): boolean {
  return GRANT_RPC_OPS.has(op)
}

/** 对端只能动自己建的终端;cc 会话(agent-runner)一律不行。 */
export function grantTerminalAllowed(owner: { id: string } | undefined, peerId: string, name: string): boolean {
  return !name.startsWith('cc-') && owner?.id === peerId
}

/** 交给对端的票据:凭证加本机的连接信息。 */
export function grantTicket(grant: RemoteGrant, conn: { relayUrl: string; sid: string; cliPub: string; token: string; platform?: string }): RemoteGrantTicket {
  return {
    grantId: grant.id, key: grant.key, peerId: grant.peerId, label: grant.label,
    directory: grant.directory, directoryAbs: grant.directoryAbs,
    relayUrl: conn.relayUrl, sid: conn.sid, cliPub: conn.cliPub, token: conn.token,
    ...(conn.platform ? { platform: conn.platform } : {}),
  }
}
