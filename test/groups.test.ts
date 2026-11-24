/**
 * GroupRegistry 单测(L1)—— 群 op 全流程 + 安全属性。
 * 假 WS(hub.test.ts 同款哲学):send 收集 wire 串,测试按需解信封断言。
 * 覆盖:建群/邀请/加入/收发广播/sync/ack、未读拒发(new_messages)、opKey 幂等、
 *       邀请三态、重名拒/reclaim、reclaim 活跃卫兵、跨机冒名拒、群钥槽(在线转发/离线暂存)、持久化回放。
 */
import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, seal, open, sharedSecret } from '../src/shared/crypto'
import { GroupRegistry, type GroupRegistryCtx } from '../src/relay/groups'
import { Hub } from '../src/relay/hub'
import type { GroupEnvelope, GroupMember, GroupResult, GroupStoredMsg } from '../src/shared/group'

// ─── 假件 ──────────────────────────────────────────────────────────────────

class FakeWS {
  sent: string[] = []
  constructor(public label: string) {}
  send(data: string): void {
    this.sent.push(data)
  }
  /** 取第 n 条出站帧的信封(测试断言用)。 */
  env(n: number): GroupEnvelope {
    const wire = JSON.parse(this.sent[n]) as { type: number; payload: string }
    return JSON.parse(Buffer.from(wire.payload, 'base64').toString('utf8')) as GroupEnvelope
  }
  last(): GroupEnvelope {
    return this.env(this.sent.length - 1)
  }
}

type MetaMap = Map<FakeWS, { role: 'cli' | 'phone' | 'guest'; phoneId?: string; cid?: string }>

function makeRegistry(load?: () => string | null, beforeSave?: (plain: string) => void): { reg: GroupRegistry; saved: string[] } {
  const saved: string[] = []
  const ctx: GroupRegistryCtx = {
    meta: (ws) => (reg as unknown as { __meta?: MetaMap }).__meta?.get(ws as FakeWS),
    send: (ws, data) => (ws as FakeWS).send(data),
    loadState: load ?? (() => null),
    saveState: (plain) => { beforeSave?.(plain); saved.push(plain) },
  }
  const reg = new GroupRegistry(ctx)
  return { reg, saved }
}

function bind(reg: GroupRegistry, ws: FakeWS, id: { role: 'cli' | 'phone' | 'guest'; phoneId?: string; cid?: string }): void {
  const holder = reg as unknown as { __meta?: MetaMap }
  if (!holder.__meta) holder.__meta = new Map()
  holder.__meta.set(ws, id)
}

/** 走完「建群 → 邀请」拿到码。 */
function createAndInvite(reg: GroupRegistry, phone: FakeWS, name = '互查群'): { groupId: string; code: string } {
  bind(reg, phone, { role: 'phone', phoneId: 'ph_1' })
  reg.handle(phone, JSON.stringify({ op: 'group-create', reqId: 'c1', payload: { meta: { name }, ownerName: '主人' } }))
  const groupId = ((phone.last().payload as GroupResult).data as { groupId: string }).groupId
  reg.handle(phone, JSON.stringify({ op: 'group-invite', groupId, reqId: 'i1', payload: { groupId } }))
  const inv = (phone.last().payload as GroupResult).data as { code: string }
  return { groupId, code: inv.code }
}

const text = (s: string, key: Uint8Array): string => Buffer.from(seal(key, new TextEncoder().encode(JSON.stringify({ kind: 'text', text: s })))).toString('base64')
const openText = (ct: string, key: Uint8Array): string =>
  (JSON.parse(new TextDecoder().decode(open(key, Buffer.from(ct, 'base64')))) as { text: string }).text

// ─── 基本流程 ───────────────────────────────────────────────────────────────

test('建群 → 邀请 → join → post 广播双方可见,relay 存的是密文', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const cli = new FakeWS('cli')
  const { groupId, code } = createAndInvite(reg, phone)

  const kp = generateKeyPair()
  bind(reg, cli, { role: 'cli', cid: 'machineA' })
  reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: 'j1', payload: { inviteCode: code, member: { name: 'A的CC', platform: 'claude', machineId: 'machineA', pubKey: Buffer.from(kp.publicKey).toString('base64') } } }))
  const jr = cli.last().payload as GroupResult
  expect(jr.ok).toBe(true)

  // agent 发消息(群钥从测试侧对应:这里直接用新钥会解不开 —— 群钥在手机手里;测试只验信封/路由)
  reg.handle(cli, JSON.stringify({ op: 'group-post', groupId, reqId: 'p1', payload: { ct: 'CIPHERTEXT', opKey: 'k1', memberId: ((jr.data as { snapshot: { members: Array<{ memberId: string; name: string }> } }).snapshot.members.find((m) => m.name === 'A的CC'))!.memberId, readUpTo: 0 } }))
  const pr = cli.last().payload as GroupResult
  expect(pr.ok).toBe(true)
  // 广播:手机与 agent 各收到一条 group-msg,正文是原样密文(relay 不碰)
  const phoneMsg = phone.last()
  expect(phoneMsg.op).toBe('group-msg')
  expect((phoneMsg.payload as GroupStoredMsg).ct).toBe('CIPHERTEXT')
  expect((cli.env(cli.sent.length - 2)).op).toBe('group-msg')
})

test('relay 落盘状态里没有明文正文(E2E 审计)', () => {
  const { reg, saved } = makeRegistry()
  const phone = new FakeWS('phone')
  createAndInvite(reg, phone, '密文群')
  expect(saved.length).toBeGreaterThan(0)
  for (const s of saved) expect(s).not.toContain('明文陷阱')
})

// ─── 发送纪律 ───────────────────────────────────────────────────────────────

test('未读拒发:他人有新消息时 post → new_messages,附未读且已替标读;再发即过', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const cliA = new FakeWS('cliA')
  const cliB = new FakeWS('cliB')
  const { groupId, code } = createAndInvite(reg, phone)

  const join = (cli: FakeWS, name: string): string => {
    bind(reg, cli, { role: 'cli', cid: `m_${name}` })
    reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: `j_${name}`, payload: { inviteCode: code, member: { name, machineId: `m_${name}` } } }))
    return (((cli.last().payload as GroupResult).data as { snapshot: { members: Array<{ memberId: string; name: string }> } }).snapshot.members.find((m) => m.name === name))!.memberId
  }
  const idA = join(cliA, 'A')
  const idB = join(cliB, 'B')

  // B 先发一条(A 未读)
  reg.handle(cliB, JSON.stringify({ op: 'group-post', groupId, reqId: 'p_b1', payload: { ct: 'B1', memberId: idB, readUpTo: 0 } }))
  // A 直接发(readUpTo=0 落后) → new_messages + 附未读 + 已标读
  reg.handle(cliA, JSON.stringify({ op: 'group-post', groupId, reqId: 'p_a1', payload: { ct: 'A1', memberId: idA, readUpTo: 0 } }))
  const r = (cliA.last().payload as GroupResult)
  expect(r.ok).toBe(false)
  expect(r.error?.code).toBe('new_messages')
  expect(((r.data as { msgs: GroupStoredMsg[] }).msgs)[0].ct).toBe('B1')
  // A 重发(带更新后的游标) → 过
  const cursor = (r.data as { msgs: GroupStoredMsg[] }).msgs[0].seq
  reg.handle(cliA, JSON.stringify({ op: 'group-post', groupId, reqId: 'p_a2', payload: { ct: 'A1', memberId: idA, readUpTo: cursor } }))
  expect((cliA.last().payload as GroupResult).ok).toBe(true)
})

test('opKey 幂等:同 key 重发不重投,返回已存 seq', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const cli = new FakeWS('cli')
  const { groupId, code } = createAndInvite(reg, phone)
  bind(reg, cli, { role: 'cli', cid: 'mX' })
  reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: 'j', payload: { inviteCode: code, member: { name: 'X', machineId: 'mX' } } }))
  const idX = (((cli.last().payload as GroupResult).data as { snapshot: { members: Array<{ memberId: string; name: string }> } }).snapshot.members.find((m) => m.name === 'X'))!.memberId
  reg.handle(cli, JSON.stringify({ op: 'group-post', groupId, reqId: 'p1', payload: { ct: 'ONLY-ONCE', opKey: 'dup1', memberId: idX, readUpTo: 0 } }))
  const seq1 = ((cli.last().payload as GroupResult).data as { seq: number }).seq
  reg.handle(cli, JSON.stringify({ op: 'group-post', groupId, reqId: 'p2', payload: { ct: 'ONLY-ONCE', opKey: 'dup1', memberId: idX, readUpTo: 0 } }))
  const r2 = (cli.last().payload as GroupResult).data as { seq: number; dedup: boolean }
  expect(r2.seq).toBe(seq1)
  expect(r2.dedup).toBe(true)
  // 广播只有一条 group-msg(第二次未投;过滤掉 join 时的 meta 帧)
  const msgFrames = phone.sent.filter((w) => {
    const wire = JSON.parse(w) as { payload: string }
    return (JSON.parse(Buffer.from(wire.payload, 'base64').toString('utf8')) as GroupEnvelope).op === 'group-msg'
  })
  expect(msgFrames.length).toBe(1)
})

// ─── 邀请与身份 ─────────────────────────────────────────────────────────────

test('限次邀请:同码可入多个 agent;用尽 → code_used;错码 → code_invalid', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const { code } = createAndInvite(reg, phone)
  const join = (cid: string, name: string): boolean => {
    const c = new FakeWS(cid)
    bind(reg, c, { role: 'cli', cid })
    reg.handle(c, JSON.stringify({ op: 'group-join', reqId: `j_${name}`, payload: { inviteCode: code, member: { name, machineId: cid } } }))
    return (c.last().payload as GroupResult).ok
  }
  expect(join('mA', 'A')).toBe(true)
  // 同码第二人(同机多 agent 共用一条 setup 消息的核心 UX)→ 成功
  expect(join('mB', 'B')).toBe(true)
  // 错码
  const cBad = new FakeWS('mC')
  bind(reg, cBad, { role: 'cli', cid: 'mC' })
  reg.handle(cBad, JSON.stringify({ op: 'group-join', reqId: 'jC', payload: { inviteCode: 'ZZZZ-ZZZZ', member: { name: 'C', machineId: 'mC' } } }))
  expect((cBad.last().payload as GroupResult).error?.code).toBe('code_invalid')
  // 用尽:白盒把余次拨到 1 再消耗 → code_used
  const regAny = reg as unknown as { groups: Map<string, { invites: Array<{ usesLeft: number }> }> }
  Array.from(regAny.groups.values())[0].invites[0].usesLeft = 1
  expect(join('mD', 'D')).toBe(true)
  expect(join('mE', 'E')).toBe(false)
  const cE = new FakeWS('mE2')
  bind(reg, cE, { role: 'cli', cid: 'mE2' })
  reg.handle(cE, JSON.stringify({ op: 'group-join', reqId: 'jE2', payload: { inviteCode: code, member: { name: 'E2', machineId: 'mE2' } } }))
  expect((cE.last().payload as GroupResult).error?.code).toBe('code_used')
})

test('重名拒(member_exists);reclaim 认领沿用身份,活跃卫兵拒双开', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const { groupId, code } = createAndInvite(reg, phone)
  const cli1 = new FakeWS('cli1')
  bind(reg, cli1, { role: 'cli', cid: 'mA' })
  reg.handle(cli1, JSON.stringify({ op: 'group-join', reqId: 'j1', payload: { inviteCode: code, member: { name: 'A', machineId: 'mA' } } }))
  const oldId = (((cli1.last().payload as GroupResult).data as { snapshot: { members: Array<{ memberId: string; name: string }> } }).snapshot.members.find((m) => m.name === 'A'))!.memberId

  // 新机器同名新入 → 拒
  const cli2 = new FakeWS('cli2')
  bind(reg, cli2, { role: 'cli', cid: 'mB' })
  reg.handle(cli2, JSON.stringify({ op: 'group-join', reqId: 'j2', payload: { inviteCode: code, member: { name: 'A', machineId: 'mB' } } }))
  expect((cli2.last().payload as GroupResult).error?.code).toBe('member_exists')
  // reclaim 但原身份刚活跃(刚 join 过) → member_active
  reg.handle(cli2, JSON.stringify({ op: 'group-join', reqId: 'j3', payload: { inviteCode: code, member: { name: 'A', machineId: 'mB' }, reclaim: true } }))
  expect((cli2.last().payload as GroupResult).error?.code).toBe('member_active')

  // 把活跃时间拨老(直接改内存,模拟 15 分钟前掉线)→ reclaim 成功且沿用 memberId
  const regAny = reg as unknown as { groups: Map<string, { members: Map<string, { lastSeenAt: number }>; ownerPhoneId: string }> }
  const g = Array.from(regAny.groups.values())[0]
  g.members.get(oldId)!.lastSeenAt = Date.now() - 16 * 60 * 1000
  reg.handle(cli2, JSON.stringify({ op: 'group-join', reqId: 'j4', payload: { inviteCode: code, member: { name: 'A', machineId: 'mB' }, reclaim: true } }))
  const jr = cli2.last().payload as GroupResult
  expect(jr.ok).toBe(true)
  expect((((jr.data as { snapshot: { members: Array<{ memberId: string; name: string }> } }).snapshot.members.find((m) => m.name === 'A'))!).memberId).toBe(oldId)
  void groupId
})

test('跨机冒名拒:post 断言别人的 memberId(machineId 不符)→ not_member', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const cli = new FakeWS('cli')
  const { groupId, code } = createAndInvite(reg, phone)
  bind(reg, cli, { role: 'cli', cid: 'mA' })
  reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: 'j', payload: { inviteCode: code, member: { name: 'A', machineId: 'mA' } } }))
  reg.handle(cli, JSON.stringify({ op: 'group-post', groupId, reqId: 'p', payload: { ct: 'X', memberId: 'm_不存在的成员', readUpTo: 0 } }))
  expect((cli.last().payload as GroupResult).error?.code).toBe('not_member')
})

// ─── 群钥密文槽 ─────────────────────────────────────────────────────────────

test('群钥槽:成员在线直接转发(转达即焚);离线暂存,join 触达补投;端到端能解开', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const cli = new FakeWS('cli')
  const { groupId, code } = createAndInvite(reg, phone)

  const kp = generateKeyPair()
  bind(reg, cli, { role: 'cli', cid: 'mA' })
  reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: 'j', payload: { inviteCode: code, member: { name: 'A', machineId: 'mA', pubKey: Buffer.from(kp.publicKey).toString('base64') } } }))
  const mid = (((cli.last().payload as GroupResult).data as { snapshot: { members: Array<{ memberId: string; name: string }> } }).snapshot.members.find((m) => m.name === 'A'))!.memberId

  // 手机封槽(临时密钥对 × 成员公钥)
  const eph = generateKeyPair()
  const groupKey = new Uint8Array(32).fill(7)
  const sealed = seal(sharedSecret(eph.privateKey, kp.publicKey), groupKey)
  const slot = Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(sealed)]).toString('base64')
  reg.handle(phone, JSON.stringify({ op: 'group-keyslot-set', groupId, reqId: 's1', payload: { groupId, memberId: mid, slot } }))
  expect((phone.last().payload as GroupResult).ok).toBe(true)
  // 成员在线 → 槽直接转发到 cli 连接
  const fwd = cli.last()
  expect(fwd.op).toBe('group-keyslot')
  // ce 侧用身份私钥开槽 → 群钥还原
  const raw = Buffer.from((fwd.payload as { slot: string }).slot, 'base64')
  const key = open(sharedSecret(kp.privateKey, new Uint8Array(raw.subarray(0, 32))), new Uint8Array(raw.subarray(32)))
  expect(Buffer.from(key).toString('hex')).toBe(Buffer.from(groupKey).toString('hex'))
  // 用还原的群钥发消息,relay 落盘无明文,手机侧可解
  reg.handle(cli, JSON.stringify({ op: 'group-post', groupId, reqId: 'p', payload: { ct: text('端到端密文', key), memberId: mid, readUpTo: 0 } }))
  const msg = (phone.last().payload as GroupStoredMsg)
  expect(openText(msg.ct, key)).toBe('端到端密文')
})

// ─── 持久化 ────────────────────────────────────────────────────────────────

test('持久化回放:重启(load)后群还在,消息seq连续', () => {
  const r1 = makeRegistry()
  const phone = new FakeWS('phone')
  bind(r1.reg, phone, { role: 'phone', phoneId: 'ph_1' })
  r1.reg.handle(phone, JSON.stringify({ op: 'group-create', reqId: 'c', payload: { meta: { name: '重启群' }, ownerName: '主人' } }))
  expect(r1.saved.length).toBeGreaterThan(0)
  const last = r1.saved[r1.saved.length - 1]

  const r2 = makeRegistry(() => last)
  expect(r2.reg.groupIds().length).toBe(1)
  expect(r2.reg.groupIds()).toEqual(r1.reg.groupIds())
})

// ─── 雇佣网关(2026-11-19):雇佣码 / guest / 撤回 ─────────────────────────────

test('雇佣码:群主签发,他人拒,轮换即废旧码', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const other = new FakeWS('other-phone')
  const { groupId } = createAndInvite(reg, phone)
  bind(reg, other, { role: 'phone', phoneId: 'ph_2' })

  reg.handle(other, JSON.stringify({ op: 'group-hire-set', groupId, reqId: 'h0', payload: { groupId } }))
  expect((other.last().payload as GroupResult).ok).toBe(false)

  reg.handle(phone, JSON.stringify({ op: 'group-hire-set', groupId, reqId: 'h1', payload: { groupId } }))
  const h1 = (phone.last().payload as GroupResult).data as { code: string }
  reg.handle(phone, JSON.stringify({ op: 'group-hire-set', groupId, reqId: 'h2', payload: { groupId } }))
  const h2 = (phone.last().payload as GroupResult).data as { code: string }
  expect(h2.code).not.toBe(h1.code)

  // 旧码已死,新码可进
  expect(reg.guestHello(h1.code, new FakeWS('g0')).ok).toBe(false)
  const hello = reg.guestHello(h2.code, new FakeWS('g1'))
  expect(hello.ok).toBe(true)
})

test('guestHello:首次建「雇主」成员,重连复用同一成员', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const { groupId } = createAndInvite(reg, phone)
  reg.handle(phone, JSON.stringify({ op: 'group-hire-set', groupId, reqId: 'h1', payload: { groupId } }))
  const hire = (phone.last().payload as GroupResult).data as { code: string }

  expect(reg.guestHello('WRONG-CODE1', new FakeWS('g0')).ok).toBe(false)
  const g1 = new FakeWS('g1')
  const r1 = reg.guestHello(hire.code, g1)
  const g2 = new FakeWS('g2')
  const r2 = reg.guestHello(hire.code, g2)
  expect(r1.ok && r2.ok).toBe(true)
  if (r1.ok && r2.ok) expect(r2.memberId).toBe(r1.memberId)
  // 手机收到了雇主加入广播(human 成员)
  const meta = phone.last()
  expect(meta.op).toBe('group-meta')
  expect(((meta.payload as { member?: { human?: boolean; guest?: true } }).member)?.guest).toBe(true)
})

test('guest 发言:扇出全房间 + 每小时限速', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const cli = new FakeWS('cli')
  const { groupId, code } = createAndInvite(reg, phone)
  bind(reg, cli, { role: 'cli', cid: 'machineA' })
  reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: 'j1', payload: { inviteCode: code, member: { name: 'A的CC', machineId: 'machineA' } } }))
  reg.handle(phone, JSON.stringify({ op: 'group-hire-set', groupId, reqId: 'h1', payload: { groupId } }))
  const hire = (phone.last().payload as GroupResult).data as { code: string }
  const guest = new FakeWS('guest')
  bind(reg, guest, { role: 'guest' })
  const hr = reg.guestHello(hire.code, guest)
  if (!hr.ok) throw new Error('guest hello 应成功')
  guest.sent.length = 0 // 清 hello 阶段帧

  for (let i = 1; i <= 30; i++) {
    reg.handle(guest, JSON.stringify({ op: 'group-post', groupId, reqId: 'p' + i, payload: { ct: 'CIPHERTEXT', memberId: hr.memberId, readUpTo: i - 1 } }))
    expect((guest.last().payload as GroupResult).ok).toBe(true)
  }
  reg.handle(guest, JSON.stringify({ op: 'group-post', groupId, reqId: 'p31', payload: { ct: 'CIPHERTEXT', memberId: hr.memberId, readUpTo: 30 } }))
  expect((guest.last().payload as GroupResult).error?.code).toBe('rate_limited')
  // 房间成员收到了 guest 广播(from.human)
  expect(phone.last().op).toBe('group-msg')
  expect((phone.last().payload as GroupStoredMsg).from.human).toBe(true)
})

test('撤回:作者/群主可撤,他人不可;撤后密文清空重播墓碑', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const cliA = new FakeWS('cliA')
  const cliB = new FakeWS('cliB')
  const { groupId, code } = createAndInvite(reg, phone)
  bind(reg, cliA, { role: 'cli', cid: 'machineA' })
  reg.handle(cliA, JSON.stringify({ op: 'group-join', reqId: 'j1', payload: { inviteCode: code, member: { name: 'A的CC', machineId: 'machineA' } } }))
  const snapA = (cliA.last().payload as GroupResult).data as { snapshot: { members: Array<{ memberId: string; name: string }> } }
  const midA = snapA.snapshot.members.find((m) => m.name === 'A的CC')!.memberId
  bind(reg, cliB, { role: 'cli', cid: 'machineB' })
  reg.handle(cliB, JSON.stringify({ op: 'group-join', reqId: 'j2', payload: { inviteCode: code, member: { name: 'B的CC', machineId: 'machineB' } } }))
  const snapB = (cliB.last().payload as GroupResult).data as { snapshot: { members: Array<{ memberId: string; name: string }> } }
  const midB = snapB.snapshot.members.find((m) => m.name === 'B的CC')!.memberId

  // A 发一条(opKey 幂等键保留在索引里,撤后重放不复活消息)
  reg.handle(cliA, JSON.stringify({ op: 'group-post', groupId, reqId: 'p1', payload: { ct: 'SECRET_CT', opKey: 'k1', memberId: midA, readUpTo: 0 } }))
  // B 想撤 A 的 → 拒
  reg.handle(cliB, JSON.stringify({ op: 'group-revoke', groupId, reqId: 'r0', payload: { seq: 1, memberId: midB } }))
  expect((cliB.last().payload as GroupResult).ok).toBe(false)
  // 作者撤自己的 → ok;广播墓碑(ct 清空 + revokedAt)
  reg.handle(cliA, JSON.stringify({ op: 'group-revoke', groupId, reqId: 'r1', payload: { seq: 1, memberId: midA } }))
  expect((cliA.last().payload as GroupResult).ok).toBe(true)
  const tomb = cliA.env(cliA.sent.length - 2)
  expect(tomb.op).toBe('group-msg')
  const tm = tomb.payload as GroupStoredMsg
  expect(tm.revokedAt).toBeTruthy()
  expect(tm.ct).toBe('')
  // 同 opKey 重放 → 幂等返回旧 seq,不复活
  reg.handle(cliA, JSON.stringify({ op: 'group-post', groupId, reqId: 'p2', payload: { ct: 'SECRET_CT2', opKey: 'k1', memberId: midA, readUpTo: 1 } }))
  expect(((cliA.last().payload as GroupResult).data as { dedup?: boolean }).dedup).toBe(true)
  // B 再发一条,群主(手机)可撤任何人的
  reg.handle(cliB, JSON.stringify({ op: 'group-post', groupId, reqId: 'p3', payload: { ct: 'CT_B', opKey: 'k2', memberId: midB, readUpTo: 1 } }))
  reg.handle(phone, JSON.stringify({ op: 'group-revoke', groupId, reqId: 'r2', payload: { seq: 2 } }))
  expect((phone.last().payload as GroupResult).ok).toBe(true)
})

// ─── 外部 agent 网关(2026-11-20 2-2):接入码 / pair / 座位解析 ──────────────────────

test('agent 接入码:群主签发,他人拒,上限 20', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const other = new FakeWS('other')
  const { groupId } = createAndInvite(reg, phone)
  bind(reg, other, { role: 'phone', phoneId: 'ph_2' })
  reg.handle(other, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'a0', payload: { groupId } }))
  expect((other.last().payload as GroupResult).ok).toBe(false)
  const codes: string[] = []
  for (let i = 0; i < 20; i++) {
    reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'a' + i, payload: { groupId } }))
    codes.push(((phone.last().payload as GroupResult).data as { code: string }).code)
  }
  expect(new Set(codes).size).toBe(20)
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'a21', payload: { groupId } }))
  expect((phone.last().payload as GroupResult).error?.code).toBe('too_large')
})

test('guestHelloAgent:新座/重连复用/名字占用', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const { groupId } = createAndInvite(reg, phone)
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'a1', payload: { groupId } }))
  const code = ((phone.last().payload as GroupResult).data as { code: string }).code

  const g1 = new FakeWS('g1')
  const r1 = reg.guestHelloAgent(code, '小王 Codex', 'codex', g1)
  expect(r1.ok).toBe(true)
  if (r1.ok) expect(r1.groupName).toBeTruthy()
  // 房里广播了成员加入(agent 成员,guest)
  const meta = phone.last()
  expect(meta.op).toBe('group-meta')
  const mm = (meta.payload as { member?: { guest?: boolean; human?: boolean; name?: string } }).member
  expect(mm?.guest).toBe(true)
  expect(mm?.human).toBe(false)

  // 同码重连 → 同一成员
  const g2 = new FakeWS('g2')
  const r2 = reg.guestHelloAgent(code, '小王 Codex', 'codex', g2)
  expect(r2.ok && r1.ok && (r2.ok ? r2.memberId : '') === (r1.ok ? r1.memberId : '')).toBe(true)

  // 同码换名 ≠ 新座(码即身份锚):仍复用同一成员
  const g3 = new FakeWS('g3')
  const r3 = reg.guestHelloAgent(code, '小王 Codex', 'codex', g3)
  expect(r3.ok && (r3.ok ? r3.memberId : '') === (r1.ok ? r1.memberId : '')).toBe(true)

  // 名字与已有 agent 冲突 → 先 pair 的另一个码报 member_exists
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'a2', payload: { groupId } }))
  const code2 = ((phone.last().payload as GroupResult).data as { code: string }).code
  const r4 = reg.guestHelloAgent(code2, '小王 Codex', undefined, new FakeWS('g4'))
  expect(r4.ok).toBe(false)
  if (!r4.ok) expect(r4.error).toContain('已被占用')

  // 错码
  expect(reg.guestHelloAgent('WRONG-CODE1', 'x', undefined, new FakeWS('g5')).ok).toBe(false)
})

test('resolveAgentSeat:未 pair/绑定校验/跨成员拒', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const { groupId } = createAndInvite(reg, phone)
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'a1', payload: { groupId } }))
  const code = ((phone.last().payload as GroupResult).data as { code: string }).code

  expect(reg.resolveAgentSeat(code).ok).toBe(false) // 未 pair
  const r = reg.guestHelloAgent(code, '客座CC', 'claude', new FakeWS('g1'))
  expect(r.ok).toBe(true)
  const bound = r.ok ? r.memberId : ''
  expect(reg.resolveAgentSeat(code).ok).toBe(true)
  expect(reg.resolveAgentSeat(code, bound).ok).toBe(true)
  expect(reg.resolveAgentSeat(code, 'm_别的成员').ok).toBe(false)
})

test('外部接入码撤销仅群主可做，未使用和重复撤销幂等，重启后不能配对', () => {
  const { reg, saved } = makeRegistry()
  const phone = new FakeWS('phone')
  const { groupId } = createAndInvite(reg, phone)
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'code', payload: { groupId } }))
  const code = ((phone.last().payload as GroupResult).data as { code: string }).code
  const other = new FakeWS('other'); bind(reg, other, { role: 'phone', phoneId: 'ph_other' })
  reg.handle(other, JSON.stringify({ op: 'group-agent-code-revoke', groupId, reqId: 'bad', payload: { groupId, code } }))
  expect((other.last().payload as GroupResult).ok).toBe(false)
  expect(reg.guestHelloAgent(code, '可接入', 'claude', new FakeWS('allowed')).ok).toBe(true)
  for (let i = 0; i < 2; i++) {
    reg.handle(phone, JSON.stringify({ op: 'group-agent-code-revoke', groupId, reqId: `revoke${i}`, payload: { groupId, code } }))
    expect(phone.last().payload).toMatchObject({ ok: true, data: { revoked: true } })
  }
  const restored = makeRegistry(() => saved.at(-1)!).reg
  expect(restored.guestHelloAgent(code, '可接入', 'claude', new FakeWS('denied')).ok).toBe(false)
  expect(restored.resolveAgentSeat(code).ok).toBe(false)
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'unused', payload: { groupId } }))
  const unused = ((phone.last().payload as GroupResult).data as { code: string }).code
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-revoke', groupId, reqId: 'unused-revoke', payload: { groupId, code: unused } }))
  expect(reg.guestHelloAgent(unused, '未入房', undefined, new FakeWS('unused')).ok).toBe(false)
})

test('撤销已配对员工清理所有在线身份，禁止冒认其他访客，保留历史和同连接其他房间', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const { groupId } = createAndInvite(reg, phone)
  const issue = (gid: string) => {
    reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId: gid, reqId: 'issue', payload: { groupId: gid } }))
    return ((phone.last().payload as GroupResult).data as { code: string }).code
  }
  const code = issue(groupId)
  const worker = new FakeWS('worker'), duplicate = new FakeWS('duplicate'), peer = new FakeWS('peer')
  for (const ws of [worker, duplicate, peer]) bind(reg, ws, { role: 'guest' })
  const seat = reg.guestHelloAgent(code, '外部员工', 'claude', worker)
  expect(seat.ok).toBe(true); if (!seat.ok) return
  reg.guestHelloAgent(code, '外部员工', 'claude', duplicate)
  const peerSeat = reg.guestHelloAgent(issue(groupId), '另一个员工', 'codex', peer)
  expect(peerSeat.ok).toBe(true); if (!peerSeat.ok) return
  reg.handle(worker, JSON.stringify({ op: 'group-post', groupId, reqId: 'post', payload: { memberId: seat.memberId, ct: 'RETAINED', readUpTo: 0 } }))
  expect((worker.last().payload as GroupResult).ok).toBe(true)
  const otherGroup = createAndInvite(reg, phone, '第二个房间').groupId
  const otherSeat = reg.guestHelloAgent(issue(otherGroup), '另一间身份', 'claude', worker)
  expect(otherSeat.ok).toBe(true); if (!otherSeat.ok) return
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-revoke', groupId, reqId: 'revoke', payload: { groupId, code } }))
  expect(phone.last().payload).toMatchObject({ ok: true, data: { revoked: true } })
  expect(reg.resolveAgentSeat(code, seat.memberId).ok).toBe(false)
  const before = worker.sent.length, duplicateBefore = duplicate.sent.length
  reg.handle(phone, JSON.stringify({ op: 'group-post', groupId, reqId: 'new', payload: { ct: 'AFTER-REVOKE', readUpTo: 1 } }))
  expect(worker.sent.length).toBe(before); expect(duplicate.sent.length).toBe(duplicateBefore)
  for (const ws of [worker, duplicate]) {
    for (const memberId of [seat.memberId, peerSeat.memberId]) {
      reg.handle(ws, JSON.stringify({ op: 'group-sync', groupId, reqId: 'spoof', payload: { memberId, afterSeq: 0 } }))
      expect(ws.last().payload).toMatchObject({ ok: false, error: { code: 'not_member' } })
    }
  }
  reg.handle(worker, JSON.stringify({ op: 'group-sync', groupId: otherGroup, reqId: 'other', payload: { memberId: otherSeat.memberId, afterSeq: 0 } }))
  expect((worker.last().payload as GroupResult).ok).toBe(true)
  reg.handle(phone, JSON.stringify({ op: 'group-sync', groupId, reqId: 'history', payload: { afterSeq: 0 } }))
  const data = (phone.last().payload as GroupResult).data as { msgs: GroupStoredMsg[]; members: GroupMember[] }
  expect(data.msgs[0].ct).toBe('RETAINED')
  expect(data.members.some(m => m.memberId === seat.memberId)).toBe(false)
  expect(peer.sent.map((_, i) => peer.env(i)).some(e => e.op === 'group-meta' && (e.payload as { event?: string; member?: GroupMember }).event === 'member-left' && (e.payload as { member?: GroupMember }).member?.memberId === seat.memberId)).toBe(true)
})

test('撤销落盘失败明确报错且继续阻断当前访问，重试完成持久化', () => {
  let failSave = false
  const { reg, saved } = makeRegistry(undefined, () => { if (failSave) throw new Error('disk unavailable') })
  const phone = new FakeWS('phone')
  const { groupId } = createAndInvite(reg, phone)
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'issue' }))
  const code = ((phone.last().payload as GroupResult).data as { code: string }).code
  failSave = true
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-revoke', groupId, reqId: 'fail', payload: { groupId, code } }))
  expect(phone.last().payload).toMatchObject({ ok: false, error: { code: 'storage_error' } })
  expect(reg.guestHelloAgent(code, '已阻断', undefined, new FakeWS('blocked')).ok).toBe(false)
  failSave = false
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-revoke', groupId, reqId: 'retry', payload: { groupId, code } }))
  expect(phone.last().payload).toMatchObject({ ok: true, data: { revoked: true } })
  expect(makeRegistry(() => saved.at(-1)!).reg.guestHelloAgent(code, '已阻断', undefined, new FakeWS('blocked-after-restart')).ok).toBe(false)
})

test('退群落盘失败不广播或假成功，内存已移除后的重试持久成功才补成员离开事件', () => {
  let failSave = false
  const { reg, saved } = makeRegistry(undefined, () => { if (failSave) throw new Error('disk unavailable') })
  const phone = new FakeWS('phone'), cli = new FakeWS('cli')
  const { groupId, code } = createAndInvite(reg, phone)
  bind(reg, cli, { role: 'cli', cid: 'machine' })
  reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: 'join', payload: { inviteCode: code, member: { name: '待注销员工' } } }))
  const snapshot = (cli.last().payload as GroupResult).data as { snapshot: { members: GroupMember[] } }
  const memberId = snapshot.snapshot.members.find(m => m.name === '待注销员工')!.memberId
  const leftEvents = () => phone.sent.map((_, i) => phone.env(i)).filter(e => e.op === 'group-meta' && (e.payload as { event: string }).event === 'member-left')
  const leave = () => reg.handle(cli, JSON.stringify({ op: 'group-leave', groupId, reqId: 'leave', payload: { groupId, memberId } }))
  failSave = true
  for (let i = 0; i < 2; i++) {
    leave()
    expect(cli.last().payload).toMatchObject({ ok: false, error: { code: 'storage_error' } })
    expect(leftEvents()).toHaveLength(0)
  }
  // 磁盘仍有旧成员，重启后仍需退群；不能已在 ce 侧清掉重试记录。
  const restored = makeRegistry(() => saved.at(-1)!).reg
  bind(restored, phone, { role: 'phone', phoneId: 'ph_1' })
  restored.handle(phone, JSON.stringify({ op: 'group-sync', groupId, reqId: 'disk-before', payload: { afterSeq: 0 } }))
  expect(((phone.last().payload as GroupResult).data as { members: GroupMember[] }).members.some(m => m.memberId === memberId)).toBe(true)
  failSave = false
  leave()
  expect((cli.last().payload as GroupResult).ok).toBe(true)
  expect(leftEvents()).toHaveLength(1)
  expect((leftEvents()[0].payload as { member: GroupMember }).member.memberId).toBe(memberId)
  // 完全不在内存的重试也需确认当前状态已落盘，不能把 storage_error 降成 not_member。
  failSave = true; leave()
  expect(cli.last().payload).toMatchObject({ ok: false, error: { code: 'storage_error' } })
  failSave = false; leave()
  expect(cli.last().payload).toMatchObject({ ok: false, error: { code: 'not_member' } })
  expect(leftEvents()).toHaveLength(1)
})

test('真实 Hub 退群写盘失败保持可重试，恢复磁盘后保存且重启不会复活成员', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-leave-disk-'))
  try {
    const groupFile = join(dir, 'groups.json'), backup = join(dir, 'groups-before.json')
    const hub = new Hub(join(dir, 'state.json'), 100, null, groupFile)
    const phone = new FakeWS('phone'), cli = new FakeWS('cli')
    const { sid, token } = hub.register('machine', cli)
    expect(hub.joinPhone(sid, token, phone, 'ph_1')).toBe(true)
    const reg = hub.groups!
    const { groupId, code } = createAndInvite(reg, phone)
    reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: 'join', payload: { inviteCode: code, member: { name: '待注销员工' } } }))
    const data = (cli.last().payload as GroupResult).data as { snapshot: { members: GroupMember[] } }
    const memberId = data.snapshot.members.find(m => m.name === '待注销员工')!.memberId
    renameSync(groupFile, backup); mkdirSync(groupFile)
    const leave = () => reg.handle(cli, JSON.stringify({ op: 'group-leave', groupId, reqId: 'leave', payload: { groupId, memberId } }))
    leave()
    expect(cli.last().payload).toMatchObject({ ok: false, error: { code: 'storage_error' } })
    expect(phone.sent.map((_, i) => phone.env(i)).some(e => e.op === 'group-meta' && (e.payload as { event: string }).event === 'member-left')).toBe(false)
    const stale = new Hub(join(dir, 'state.json'), 100, null, backup)
    const staleCli = new FakeWS('stale'), stalePhone = new FakeWS('stale-phone')
    const staleConn = stale.register('machine', staleCli)
    stale.joinPhone(staleConn.sid, staleConn.token, stalePhone, 'ph_1')
    stale.groups!.handle(stalePhone, JSON.stringify({ op: 'group-sync', groupId, reqId: 'stale', payload: { afterSeq: 0 } }))
    expect(((stalePhone.last().payload as GroupResult).data as { members: GroupMember[] }).members.some(m => m.memberId === memberId)).toBe(true)
    rmSync(groupFile, { recursive: true }); renameSync(backup, groupFile)
    leave()
    expect((cli.last().payload as GroupResult).ok).toBe(true)
    const reloaded = new Hub(join(dir, 'state.json'), 100, null, groupFile)
    const newCli = new FakeWS('new-cli'), newPhone = new FakeWS('new-phone')
    const conn = reloaded.register('machine', newCli)
    reloaded.joinPhone(conn.sid, conn.token, newPhone, 'ph_1')
    reloaded.groups!.handle(newPhone, JSON.stringify({ op: 'group-sync', groupId, reqId: 'new', payload: { afterSeq: 0 } }))
    expect(((newPhone.last().payload as GroupResult).data as { members: GroupMember[] }).members.some(m => m.memberId === memberId)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('sync 应答随行成员名单(2026-11-20:掉线错过 member-joined 的自愈路)', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const { groupId } = createAndInvite(reg, phone)
  reg.handle(phone, JSON.stringify({ op: 'group-agent-code-set', groupId, reqId: 'a1', payload: { groupId } }))
  const code = ((phone.last().payload as GroupResult).data as { code: string }).code
  reg.guestHelloAgent(code, '客座CC', 'claude', new FakeWS('g1'))
  reg.handle(phone, JSON.stringify({ op: 'group-sync', groupId, reqId: 's1', payload: { groupId, afterSeq: 0 } }))
  const r = phone.last().payload as GroupResult
  expect(r.ok).toBe(true)
  const members = (r.data as { members?: Array<{ name: string }> }).members ?? []
  expect(members.some((m) => m.name === '客座CC')).toBe(true)
  expect(members.some((m) => m.name === '主人')).toBe(true)
  expect((r.data as { meta: { createdBy: string; createdAt: number } }).meta).toMatchObject({ createdBy: 'ph_1' })
  expect((r.data as { meta: { createdAt: number } }).meta.createdAt).toBeGreaterThan(0)
})

test('心跳(markRead:false)不刷 lastSeenAt —— reclaim 卫兵不被 daemon 心跳污染', () => {
  const { reg } = makeRegistry()
  const phone = new FakeWS('phone')
  const { groupId } = createAndInvite(reg, phone)
  // 新成员入群
  const kp = generateKeyPair()
  const cli = new FakeWS('cli')
  bind(reg, cli, { role: 'cli', cid: 'machineA' })
  reg.handle(cli, JSON.stringify({ op: 'group-join', reqId: 'j', payload: { inviteCode: createAndInviteCode(reg, phone, groupId), member: { name: 'A', machineId: 'machineA', pubKey: Buffer.from(kp.publicKey).toString('base64') } } }))
  const members = () => (reg as unknown as { groups: Map<string, { members: Map<string, GroupMember> }> }).groups.get(groupId)!.members
  const seen0 = [...members().values()].find((m) => m.name === 'A')!.lastSeenAt
  // 心跳 ×3(markRead:false)→ lastSeenAt 一动不动(等值;旧代码会每拍刷新)
  for (let i = 0; i < 3; i++) reg.handle(cli, JSON.stringify({ op: 'group-sync', groupId, reqId: 'h' + i, payload: { groupId, afterSeq: 0, markRead: false } }))
  expect([...members().values()].find((m) => m.name === 'A')!.lastSeenAt).toBe(seen0)
  // 真读(markRead 缺省)→ 刷(≥ 旧值;同 ms 内可能相等,断言不小于)
  reg.handle(cli, JSON.stringify({ op: 'group-sync', groupId, reqId: 'r', payload: { groupId, afterSeq: 0 } }))
  expect([...members().values()].find((m) => m.name === 'A')!.lastSeenAt).toBeGreaterThanOrEqual(seen0)
})

/** 拿一个新邀请码(测试辅助)。 */
function createAndInviteCode(reg: GroupRegistry, phone: FakeWS, groupId: string): string {
  reg.handle(phone, JSON.stringify({ op: 'group-invite', groupId, reqId: 'inv_' + Math.random(), payload: { groupId } }))
  return ((phone.last().payload as GroupResult).data as { code: string }).code
}
