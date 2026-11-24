import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatHub, type ChatHubOpts } from '../src/cli/chat'
import { botPermissionPreset } from '../src/cli/bot-permissions'
import { seal } from '../src/shared/crypto'
import type { BotTurn, BotTurnResult } from '../src/cli/bot-runtime'
import type { GroupEnvelope } from '../src/shared/group'

const tick = () => new Promise(resolve => setTimeout(resolve, 10))
function fixture(extra: Partial<ChatHubOpts> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-retire-'))
  const sent: GroupEnvelope[] = []
  const revoked: string[] = []
  const key = new Uint8Array(32).fill(7)
  const failLeaves = new Set<string>()
  let holdNextJoin = false; let heldJoin: (() => void) | undefined
  let afterNextSync: (() => void) | undefined
  const members = [{ memberId: 'owner', name: 'Owner', phoneId: 'owner-phone', human: true, joinedAt: 0, lastSeenAt: 0, readUpTo: 0 }]
  let chat: ChatHub
  const opts: ChatHubOpts = {
    cid: 'machine', pubKey: new Uint8Array(32), privKey: new Uint8Array(32), statePath: join(dir, 'chat.json'), rootDir: dir,
    botCliAvailable: async () => true, commandSandbox: () => true, procLister: () => [],
    rosterSessions: async () => ({ terminals: [], agentSessions: [{ sid: 'source', cwd: dir }] }),
    onBotPolicyChanged: name => revoked.push(name),
    sendEnvelope: env => {
      sent.push(env)
      queueMicrotask(() => {
        const p = env.payload as any
        const gid = env.groupId ?? p.inviteCode
        if (env.op === 'group-leave' && failLeaves.has(gid)) return chat.onEnvelope({ op: 'group-result', payload: { reqId: env.reqId, ok: false, error: { code: 'offline', message: 'test offline' } } })
        const data = env.op === 'group-join' ? { groupId: gid, snapshot: { meta: { name: gid === 'dm' ? '私聊·Employee' : 'Team', createdBy: 'owner-phone', createdAt: 0 }, members: [...members, { memberId: `bot-${gid}`, ...p.member }], seq: 0 } }
          : env.op === 'group-sync' ? { meta: { createdBy: 'owner-phone', createdAt: 0 }, members, msgs: [], seq: 0 } : { seq: 10 }
        const respond = () => {
          chat.onEnvelope({ op: 'group-result', payload: { reqId: env.reqId, ok: true, data } })
          if (env.op === 'group-sync' && afterNextSync) {
            const callback = afterNextSync; afterNextSync = undefined; queueMicrotask(callback)
          }
        }
        if (env.op === 'group-join' && holdNextJoin) { holdNextJoin = false; heldJoin = respond } else respond()
      })
    }, ...extra,
  }
  chat = new ChatHub(opts)
  for (const id of ['dm', 'team']) chat.setKey(id, Buffer.from(key).toString('base64'))
  const add = (gid = 'dm') => chat.addAgent({ name: 'Employee', sourceSessionId: 'source', platform: 'claude', groupId: gid, code: gid, botProtocol: 1 }, 'owner-phone')
  return { dir, sent, revoked, failLeaves, add, get chat() { return chat }, restart: () => { chat = new ChatHub(opts) },
    holdJoin: () => { holdNextJoin = true }, releaseJoin: () => heldJoin?.(),
    afterNextSync: (callback: () => void) => { afterNextSync = callback },
    message: (seq: number) => chat.onEnvelope({ op: 'group-msg', groupId: 'dm', payload: { seq, ts: Date.now(), from: members[0], ct: Buffer.from(seal(key, new TextEncoder().encode(JSON.stringify({ kind: 'text', text: `task ${seq}` })))).toString('base64') } }),
  }
}

test('只有已认证创建者可注销；成功退所有群，持久禁止再次入群，来源目录保留', async () => {
  const f = fixture(); await f.add(); await f.add('team')
  expect(await f.chat.botRetire('Employee', '')).toMatchObject({ ok: false })
  expect(await f.chat.botRetire('Employee', 'other-phone')).toMatchObject({ ok: false })
  expect(f.sent.filter(e => e.op === 'group-leave')).toHaveLength(0)
  expect(await f.chat.botRetire('Employee', 'owner-phone')).toEqual({ ok: true, data: { retired: true } })
  expect(f.sent.filter(e => e.op === 'group-leave').map(e => e.groupId).sort()).toEqual(['dm', 'team'])
  expect((await f.chat.roster()).agents).toEqual([])
  f.restart()
  expect(await f.add()).toMatchObject({ ok: false })
  expect(await f.chat.localOp({ op: 'join', name: 'Employee', code: 'dm', cwd: f.dir })).toMatchObject({ ok: false })
  expect(await f.chat.botPolicy('Employee', 'owner-phone')).toMatchObject({ ok: true, data: { canManage: true } })
  expect(await f.chat.botPolicy('Employee', 'other-phone')).toMatchObject({ ok: true, data: { canManage: false } })
  expect(await f.chat.botPolicy('Employee', 'owner-phone', botPermissionPreset('readonly'))).toMatchObject({ ok: false })
  expect(await f.chat.botRetire('Employee', 'owner-phone')).toMatchObject({ ok: true })
  expect(f.sent.filter(e => e.op === 'group-leave')).toHaveLength(2)
  expect(readFileSync(join(f.dir, 'chat.json'), 'utf8')).toContain('retirement')
})

test('注销立即 abort、撤销工具与待批请求，迟到模型结果和排队消息不回帖', async () => {
  let finish!: (r: BotTurnResult) => void
  const turns: BotTurn[] = []
  const f = fixture({ runBot: async turn => { turns.push(turn); return new Promise(resolve => { finish = resolve }) } })
  await f.add(); f.message(1); f.message(2); await tick()
  expect(turns).toHaveLength(1)
  await f.chat.botPolicy('Employee', 'owner-phone', { ...botPermissionPreset('readonly'), delete: 'ask' })
  const approval = f.chat.authorizeBotTool({ name: 'Employee', groupId: 'dm', memberId: 'owner', requesterName: 'Owner' }, 'delete', 'delete').catch(error => error as Error)
  await tick()
  expect((await f.chat.botPolicy('Employee', 'owner-phone')).data!.approvals).toHaveLength(1)
  expect(await f.chat.botRetire('Employee', 'owner-phone')).toMatchObject({ ok: true })
  expect(turns[0].signal?.aborted).toBe(true)
  expect((await approval as Error).message).toMatch(/权限|注销/)
  expect(f.revoked).toContain('Employee')
  finish({ text: 'LATE_SECRET', sessionId: 'late-session' }); await tick(); f.message(3); f.chat.bootSync(); await tick()
  expect(turns).toHaveLength(1)
  expect(f.sent.filter(e => e.op === 'group-post')).toHaveLength(0)
})

test('注销等待在途入群并清理返回的成员，不能让异步 join 复活员工', async () => {
  const f = fixture(); await f.add()
  f.holdJoin(); const joining = f.add('team'); await tick()
  const retiring = f.chat.botRetire('Employee', 'owner-phone'); await tick()
  expect((await f.chat.roster()).agents).toHaveLength(0)
  f.releaseJoin()
  expect(await joining).toMatchObject({ ok: false })
  expect(await retiring).toMatchObject({ ok: true })
  expect(f.sent.filter(e => e.op === 'group-leave').map(e => e.groupId).sort()).toEqual(['dm', 'team'])
  expect(await f.add('team')).toMatchObject({ ok: false })
})

test('部分退群失败仍停止接单；重启保留创建者，重试只处理未退出的群', async () => {
  let turns = 0
  const f = fixture({ runBot: async () => { turns++; return { text: 'should not run' } } })
  await f.add(); await f.add('team'); f.failLeaves.add('team')
  expect(await f.chat.botRetire('Employee', 'owner-phone')).toMatchObject({ ok: false })
  f.message(1); f.chat.bootSync(); await tick(); expect(turns).toBe(0)
  expect(await f.add('team')).toMatchObject({ ok: false })
  f.restart(); f.chat.bootSync(); await tick(); expect(turns).toBe(0)
  expect(await f.chat.botPolicy('Employee', 'owner-phone')).toMatchObject({ ok: true, data: { canManage: true } })
  f.failLeaves.clear()
  expect(await f.chat.botRetire('Employee', 'owner-phone')).toMatchObject({ ok: true, data: { retired: true } })
  expect(f.sent.filter(e => e.op === 'group-leave' && e.groupId === 'dm')).toHaveLength(1)
  expect(f.sent.filter(e => e.op === 'group-leave' && e.groupId === 'team')).toHaveLength(2)
})

test('旧 CLI 在途 join 同样等待清理，不允许注销后遗留成员', async () => {
  const f = fixture(); await f.add()
  f.holdJoin()
  const joining = f.chat.localOp({ op: 'join', name: 'Employee', code: 'team', cwd: f.dir })
  await tick()
  const retiring = f.chat.botRetire('Employee', 'owner-phone'); await tick()
  f.releaseJoin()
  expect(await joining).toMatchObject({ ok: false })
  expect(await retiring).toMatchObject({ ok: true })
  expect(f.sent.filter(e => e.op === 'group-leave').map(e => e.groupId).sort()).toEqual(['dm', 'team'])
})

test('授权校验完成与 ask 审批入表之间注销，不得在清表后再创建审批', async () => {
  const f = fixture({ approvalTimeoutMs: 150 }); await f.add()
  await f.chat.botPolicy('Employee', 'owner-phone', { ...botPermissionPreset('readonly'), delete: 'ask' })
  let retiring: ReturnType<ChatHub['botRetire']> | undefined
  // 中继回应后启动注销：成员校验先完成，注销 continuation 先于授权返回后的 continuation。
  f.afterNextSync(() => { retiring = f.chat.botRetire('Employee', 'owner-phone') })
  const pending = f.chat.authorizeBotTool({ name: 'Employee', groupId: 'dm', memberId: 'owner', requesterName: 'Owner' }, 'delete', 'late approval').catch(error => error as Error)
  await tick()
  expect(await retiring).toMatchObject({ ok: true })
  expect((await f.chat.botPolicy('Employee', 'owner-phone')).data!.approvals).toHaveLength(0)
  expect((await pending as Error).message).toMatch(/注销|停止/)
})
