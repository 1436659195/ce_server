import { test, expect, describe } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GRANT_LIMIT, GRANT_PEER_PREFIX, GRANT_RPC_OPS, RemoteGrants,
  cwdWithinGrant, grantHandshake, grantMac, grantRpcAllowed, grantTerminalAllowed, grantTicket,
  loadRemoteGrants, normalizeLogical, resolveGrantDirectory,
} from '../src/cli/remote-grants'
import type { RemoteGrant } from '../src/cli/remote-grants'

const dir = () => mkdtempSync(join(tmpdir(), 'grants-'))
const file = () => join(dir(), 'nested', 'remote-grants.json')
const PUB = Buffer.from('phone-public-key').toString('base64')

function sample(over: Partial<RemoteGrant> = {}): RemoteGrant {
  return { id: 'grant_abc123def456', peerId: 'grant-abc123def456', label: '数字人甲@机器A', directory: '/proj', directoryAbs: '/srv/proj', key: Buffer.alloc(32, 7).toString('base64'), createdBy: 'owner-phone', createdAt: 1, ...over }
}

describe('凭证的建立、落盘与撤销', () => {
  test('开一张凭证：编号和对端编号由本机生成，落盘 0600，重新加载一致', () => {
    const path = file(); const store = new RemoteGrants(path)
    const grant = store.create({ label: '运维@机器A', directory: '/proj', directoryAbs: '/srv/proj', createdBy: 'owner-phone' })
    expect(grant.id).toMatch(/^grant_[a-f0-9]{12}$/)
    expect(grant.peerId).toMatch(/^grant-[a-f0-9]{12}$/)
    expect(Buffer.from(grant.key, 'base64')).toHaveLength(32)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const reloaded = loadRemoteGrants(path)
    expect(reloaded).toEqual([grant])
    expect(new RemoteGrants(path).get(grant.id)).toEqual(grant)
  })

  test('撤销后不再有效，但对端编号仍算登记过；最近使用时间会更新', () => {
    const store = new RemoteGrants(file())
    const grant = store.create({ label: 'x', directory: '/proj', directoryAbs: '/srv/proj', createdBy: 'o' })
    store.touch(grant.id, 123)
    expect(store.get(grant.id)?.lastUsedAt).toBe(123)
    expect(store.byPeer(grant.peerId)?.id).toBe(grant.id)
    expect(store.revoke(grant.id)?.revokedAt).toBeGreaterThan(0)
    expect(store.byPeer(grant.peerId)).toBeUndefined()
    expect(store.everRegistered(grant.peerId)).toBe(true)
    expect(store.revoke(grant.id)).toBeUndefined()
  })

  test('最多 20 张有效凭证；对外列表不带密钥', () => {
    const store = new RemoteGrants(file())
    for (let i = 0; i < GRANT_LIMIT; i++) store.create({ label: `c${i}`, directory: '/proj', directoryAbs: '/srv/proj', createdBy: 'o' })
    expect(() => store.create({ label: '多出来', directory: '/proj', directoryAbs: '/srv/proj', createdBy: 'o' })).toThrow(/最多/)
    expect(store.publicList()).toHaveLength(GRANT_LIMIT)
    expect(JSON.stringify(store.publicList())).not.toContain('key')
    expect(new Set(store.list().map(g => g.peerId)).size).toBe(GRANT_LIMIT)
  })

  test('文件不存在或损坏时为空表', () => {
    expect(loadRemoteGrants(join(dir(), 'nope.json'))).toEqual([])
    const path = file(); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '{"not":[]')
    expect(loadRemoteGrants(path)).toEqual([])
  })
})

describe('握手裁决', () => {
  test('登记过凭证的对端编号：凭证正确才放行，证明绑定这一次的临时公钥', () => {
    const grant = sample()
    const claim = { id: grant.id, mac: grantMac(grant.key, PUB) }
    expect(grantHandshake({ grants: [grant], phoneId: grant.peerId, claim, phonePubB64: PUB })).toEqual({ kind: 'admit', grant })
    expect(grantHandshake({ grants: [grant], phoneId: grant.peerId, claim, phonePubB64: 'another-public-key' }).kind).toBe('reject')
    expect(grantHandshake({ grants: [grant], phoneId: grant.peerId, claim: { id: grant.id, mac: 'bad' }, phonePubB64: PUB }).kind).toBe('reject')
    expect(grantHandshake({ grants: [grant], phoneId: grant.peerId, claim: { id: 'grant_other', mac: claim.mac }, phonePubB64: PUB }).kind).toBe('reject')
  })

  test('登记过凭证的对端编号必须带凭证：不带凭证时不交给白名单或免配对模式', () => {
    const grant = sample()
    expect(grantHandshake({ grants: [grant], phoneId: grant.peerId, phonePubB64: PUB }).kind).toBe('reject')
    // 已撤销同样只认凭证，而凭证已失效
    expect(grantHandshake({ grants: [{ ...grant, revokedAt: 9 }], phoneId: grant.peerId, claim: { id: grant.id, mac: grantMac(grant.key, PUB) }, phonePubB64: PUB }).kind).toBe('reject')
  })

  test('没登记过的编号：不带凭证照旧走原有配对；带了凭证但编号对不上就拒绝', () => {
    const grant = sample()
    expect(grantHandshake({ grants: [grant], phoneId: 'phone-1', phonePubB64: PUB })).toEqual({ kind: 'pass' })
    const mac = grantMac(grant.key, PUB)
    expect(grantHandshake({ grants: [grant], phoneId: 'phone-1', claim: { id: grant.id, mac }, phonePubB64: PUB }).kind).toBe('reject')
    // 凭证不能挪给别的编号用
    expect(grantHandshake({ grants: [grant], phoneId: `${GRANT_PEER_PREFIX}deadbeef1234`, claim: { id: grant.id, mac }, phonePubB64: PUB }).kind).toBe('reject')
  })
})

describe('授权目录', () => {
  test('逻辑路径：必须在本机文件根目录内、真实存在，不能带 . 或 ..', () => {
    const root = dir(); mkdirSync(join(root, 'proj', 'sub'), { recursive: true }); writeFileSync(join(root, 'note.txt'), 'x')
    expect(resolveGrantDirectory(root, '/proj')).toEqual({ ok: true, directory: '/proj', abs: join(root, 'proj') })
    expect(resolveGrantDirectory(root, '/proj/sub/')).toEqual({ ok: true, directory: '/proj/sub', abs: join(root, 'proj', 'sub') })
    expect(resolveGrantDirectory(root, '/nope').ok).toBe(false)
    expect(resolveGrantDirectory(root, '/note.txt').ok).toBe(false)
    expect(resolveGrantDirectory(root, '/proj/../note.txt').ok).toBe(false)
    expect(resolveGrantDirectory(root, 'proj').ok).toBe(false)
    expect(resolveGrantDirectory(root, '/proj\n').ok).toBe(false)
  })

  test('建终端的目录只能落在授权目录之内', () => {
    expect(cwdWithinGrant('/proj', '/proj')).toBe(true)
    expect(cwdWithinGrant('/proj', '/proj/sub')).toBe(true)
    expect(cwdWithinGrant('/proj', '/')).toBe(false)
    expect(cwdWithinGrant('/proj', '/project')).toBe(false)
    expect(cwdWithinGrant('/proj', '/proj/../etc')).toBe(false)
    expect(normalizeLogical('/a//b/c/')).toBe('/a/b/c')
    expect(normalizeLogical('a/b')).toBe('/a/b')
  })
})

describe('只开终端', () => {
  test('接口白名单：只有四个终端接口', () => {
    for (const op of ['createTerminal', 'listTerminals', 'deleteTerminal', 'detachTerminal']) expect(grantRpcAllowed(op)).toBe(true)
    for (const op of ['exec', 'listDir', 'readFile', 'saveFile', 'kernelStart', 'httpProxy', 'chat.roster', 'chat.botPolicy', 'butlerStart', 'uploadBegin', 'resolveApproval']) expect(grantRpcAllowed(op)).toBe(false)
    expect([...GRANT_RPC_OPS].sort()).toEqual(['createTerminal', 'deleteTerminal', 'detachTerminal', 'listTerminals'])
  })

  test('只能动自己建的终端，cc 会话一律不行', () => {
    expect(grantTerminalAllowed({ id: 'grant-1' }, 'grant-1', '3')).toBe(true)
    expect(grantTerminalAllowed({ id: 'phone-9' }, 'grant-1', '3')).toBe(false)
    expect(grantTerminalAllowed(undefined, 'grant-1', '3')).toBe(false)
    expect(grantTerminalAllowed({ id: 'grant-1' }, 'grant-1', 'cc-abc')).toBe(false)
  })

  test('交给对端的票据带连接信息和密钥', () => {
    const ticket = grantTicket(sample(), { relayUrl: 'wss://relay.example', sid: 'sid-1', cliPub: 'cli-pub', token: 'tok' })
    expect(ticket).toEqual({ grantId: 'grant_abc123def456', key: sample().key, peerId: 'grant-abc123def456', label: '数字人甲@机器A', directory: '/proj', directoryAbs: '/srv/proj', relayUrl: 'wss://relay.example', sid: 'sid-1', cliPub: 'cli-pub', token: 'tok' })
  })

  test('落盘内容里撤销和密钥都在，读取时丢掉形状不对的条目', () => {
    const path = file(); const store = new RemoteGrants(path)
    store.create({ label: 'a', directory: '/proj', directoryAbs: '/srv/proj', createdBy: 'o' })
    expect(readFileSync(path, 'utf8')).toContain('"key"')
    writeFileSync(path, JSON.stringify([{ id: 'grant_x' }, null, 'junk']))
    expect(loadRemoteGrants(path)).toEqual([])
  })
})
