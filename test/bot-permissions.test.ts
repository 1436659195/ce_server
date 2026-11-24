import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botPermissionPreset, operationMode, resolveBotDirectory, validateBotPermissions, type BotPermissions } from '../src/cli/bot-permissions'
import { ChatHub, type ChatHubOpts } from '../src/cli/chat'
import { BotToolService } from '../src/cli/bot-tools'
import { seal, open } from '../src/shared/crypto'
import type { BotTurn } from '../src/cli/bot-runtime'
import type { GroupEnvelope, GroupMember } from '../src/shared/group'

test('权限预设明确区分问答与开发，命令不能绕过文件操作确认', () => {
  expect(botPermissionPreset('readonly')).toMatchObject({ read: 'allow', create: 'deny', edit: 'deny', delete: 'deny', execute: 'deny', commanders: 'owner' })
  const developer = botPermissionPreset('developer')
  expect(developer).toMatchObject({ create: 'allow', edit: 'allow', delete: 'ask', execute: 'ask' })
  expect(operationMode({ ...developer, execute: 'allow' }, 'execute')).toBe('ask')
  expect(() => validateBotPermissions({ ...developer, edit: 'deny' })).toThrow(/执行命令/)
  expect(() => validateBotPermissions({ ...developer, read: 'unknown' })).toThrow(/read/)
})

test('工作范围只接受项目内子目录并按真实路径拒绝符号链接逃逸', () => {
  const root = mkdtempSync(join(tmpdir(), 'ce-bot-policy-path-'))
  const project = join(root, 'project'); mkdirSync(project)
  mkdirSync(join(project, 'src'))
  const p = botPermissionPreset('readonly')
  expect(resolveBotDirectory(project, { ...p, directory: 'src' })).toBe(join(project, 'src'))
  for (const directory of ['../outside', '/etc', 'C:\\Windows', 'src/../../outside', 'bad\0dir']) expect(() => validateBotPermissions({ ...p, directory })).toThrow()
  symlinkSync(root, join(project, 'escape'), 'dir')
  expect(() => resolveBotDirectory(project, { ...p, directory: 'escape' })).toThrow(/范围/)
})

const member = (memberId: string, phoneId: string, guest = false): GroupMember => ({ memberId, name: memberId === 'owner-member' ? 'Owner' : 'Owner', phoneId, human: true, ...(guest ? { guest: true as const } : {}), joinedAt: 0, lastSeenAt: 0, readUpTo: 0 })
function fixture(extra: Partial<ChatHubOpts> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-policy-'))
  let members = [member('owner-member', 'owner-phone'), member('other-member', 'other-phone'), member('guest-member', 'guest-phone', true)]
  let creator = 'owner-phone'
  let postsAllowed = true
  let syncCount = 0; let holdSyncAt = -1; let resumeSync: (() => void) | undefined
  const sent: GroupEnvelope[] = []
  let chat: ChatHub
  const key = new Uint8Array(32).fill(3)
  const opts: ChatHubOpts = {
    cid: 'machine', pubKey: new Uint8Array(32), privKey: new Uint8Array(32), statePath: join(dir, 'state.json'), rootDir: dir,
    rosterSessions: async () => ({ terminals: [], agentSessions: [{ sid: 'cc-source', cwd: dir }] }),
    botCliAvailable: async () => true, procLister: () => [],
    people: () => [{ phoneId: 'owner-phone', name: 'Owner' }, { phoneId: 'other-phone', name: 'Other' }],
    commandSandbox: () => true, approvalTimeoutMs: 50,
    sendEnvelope: env => {
      sent.push(env)
      queueMicrotask(() => {
        const p = env.payload as Record<string, unknown>
        const groupId = String(env.groupId ?? p.inviteCode ?? 'dm')
        const meta = { name: groupId === 'dm' ? '私聊·Policy BOT' : 'Team', createdBy: creator, createdAt: 0 }
        if (env.op === 'group-post' && !postsAllowed) { chat.onEnvelope({ op: 'group-result', payload: { reqId: env.reqId, ok: false, error: { code: 'offline', message: 'offline' } } }); return }
        const data = env.op === 'group-join'
          ? { groupId, snapshot: { meta, members: [...members, { memberId: 'bot', ...(p.member as object) }], seq: 0 } }
          : env.op === 'group-sync' ? { meta, members, msgs: [], seq: 0 } : {}
        const respond = () => chat.onEnvelope({ op: 'group-result', payload: { reqId: env.reqId, ok: true, data } })
        if (env.op === 'group-sync' && ++syncCount === holdSyncAt) resumeSync = respond
        else respond()
      })
    }, ...extra,
  }
  chat = new ChatHub(opts)
  chat.setKey('dm', Buffer.from(key).toString('base64'))
  const add = (permissions?: BotPermissions, actor = 'owner-phone', groupId = 'dm') => chat.addAgent({ name: 'Policy BOT', code: groupId, groupId, sourceSessionId: 'cc-source', platform: 'claude', botProtocol: 1, ...(permissions ? { permissions, botPolicyProtocol: 1 } : {}) }, actor)
  const context = { name: 'Policy BOT', groupId: 'dm', memberId: 'owner-member', requesterName: 'Owner' }
  return { dir, add, context, get chat() { return chat }, sent,
    restart: () => { chat = new ChatHub(opts) },
    holdSync: (at: number) => { holdSyncAt = at },
    resumeSync: () => resumeSync?.(),
    allowPosts: (allowed: boolean) => { postsAllowed = allowed },
    message: (seq: number, memberId = 'owner-member') => chat.onEnvelope({ op: 'group-msg', groupId: 'dm', payload: { seq, ts: Date.now(), from: { memberId, name: 'Owner', human: true }, ct: Buffer.from(seal(key, new TextEncoder().encode(JSON.stringify({ kind: 'text', text: `question ${seq}` })))).toString('base64') } }),
    replies: () => sent.filter(e => e.op === 'group-post').map(e => JSON.parse(new TextDecoder().decode(open(key, new Uint8Array(Buffer.from((e.payload as { ct: string }).ct, 'base64'))))).text as string),
    setMembers: (next: GroupMember[]) => { members = next },
    setCreator: (id: string) => { creator = id },
  }
}

test('创建者由认证通道绑定，同名其他手机不能改策略或借入群提升权限', async () => {
  const f = fixture(); const p = botPermissionPreset('developer')
  expect(await f.add(p)).toMatchObject({ ok: true, data: { botPolicyProtocol: 1, policy: { canManage: true, ownerPhoneId: 'owner-phone' } } })
  expect(await f.chat.botPolicy('Policy BOT', 'other-phone', p)).toMatchObject({ ok: false })
  expect(await f.add(p, 'other-phone', 'team')).toMatchObject({ ok: false })
  expect(await f.add(undefined, 'other-phone', 'team')).toMatchObject({ ok: true })
  expect(await f.chat.botPolicy('Policy BOT', 'other-phone')).toMatchObject({ ok: true, data: { ownerPhoneId: 'owner-phone', canManage: false, approvals: [] } })
  f.restart()
  expect(await f.chat.botPolicy('Policy BOT', 'owner-phone')).toMatchObject({ ok: true, data: { permissions: p, ownerPhoneId: 'owner-phone', revision: 1 } })
  const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'))
  expect(state.agents['Policy BOT'].bot.policy.ownerPhoneId).toBe('owner-phone')
})

test('真实成员 ID 而非显示名授予项目工具权限，guest 不自动获得操作权限', async () => {
  const f = fixture(); const p = botPermissionPreset('developer'); await f.add(p)
  expect(await f.chat.authorizeBotTool(f.context, 'edit', 'edit test')).toMatchObject({ directory: f.dir, revision: 1 })
  await expect(f.chat.authorizeBotTool({ ...f.context, memberId: 'other-member' }, 'edit', 'same name')).rejects.toThrow(/指挥/)
  await expect(f.chat.authorizeBotTool({ ...f.context, memberId: 'fake-owner' }, 'read', 'fake')).rejects.toThrow(/身份/)
  await f.chat.botPolicy('Policy BOT', 'owner-phone', { ...p, commanders: 'members' })
  expect(await f.chat.authorizeBotTool({ ...f.context, memberId: 'other-member' }, 'edit', 'allowed')).toMatchObject({ revision: 2 })
  await expect(f.chat.authorizeBotTool({ ...f.context, memberId: 'guest-member' }, 'edit', 'guest')).rejects.toThrow(/指挥/)
  await f.chat.botPolicy('Policy BOT', 'owner-phone', { ...p, commanders: 'selected', allowedPhoneIds: ['other-phone'] })
  expect(await f.chat.authorizeBotTool({ ...f.context, memberId: 'other-member' }, 'read', 'selected')).toMatchObject({ revision: 3 })
})

test('每次确认在创建者明确批准前不放行，其他人不能代批，批准仅一次', async () => {
  const f = fixture(); await f.add(botPermissionPreset('developer'))
  let passed = false
  const pending = f.chat.authorizeBotTool(f.context, 'delete', 'delete file').then(value => { passed = true; return value })
  await new Promise(resolve => setTimeout(resolve, 1)); expect(passed).toBe(false)
  const state = await f.chat.botPolicy('Policy BOT', 'owner-phone'); const approval = (state.data as { approvals: Array<{ id: string }> }).approvals[0]
  expect(approval).toBeDefined()
  expect(await f.chat.botApprove('Policy BOT', 'other-phone', approval.id, true)).toMatchObject({ ok: false })
  expect(await f.chat.botApprove('Policy BOT', 'owner-phone', approval.id, true)).toMatchObject({ ok: true })
  await pending; expect(passed).toBe(true)
  expect(await f.chat.botApprove('Policy BOT', 'owner-phone', approval.id, true)).toMatchObject({ ok: false })
})

test('拒绝、过期以及撤权都不会执行旧审批，拒绝操作不生成审批', async () => {
  const f = fixture(); await f.add(botPermissionPreset('developer'))
  const pending = f.chat.authorizeBotTool(f.context, 'delete', 'to deny'); const rejected = pending.catch(error => error as Error)
  await new Promise(resolve => setTimeout(resolve, 1))
  const state = await f.chat.botPolicy('Policy BOT', 'owner-phone'); const id = (state.data as { approvals: Array<{ id: string }> }).approvals[0].id
  await f.chat.botApprove('Policy BOT', 'owner-phone', id, false); expect((await rejected as Error).message).toMatch(/拒绝/)
  await expect(f.chat.authorizeBotTool(f.context, 'delete', 'timeout')).rejects.toThrow(/超时/)
  const old = f.chat.authorizeBotTool(f.context, 'delete', 'revoke'); const invalidated = old.catch(error => error as Error)
  await new Promise(resolve => setTimeout(resolve, 1))
  await f.chat.botPolicy('Policy BOT', 'owner-phone', botPermissionPreset('readonly')); expect((await invalidated as Error).message).toMatch(/权限/)
  await expect(f.chat.authorizeBotTool(f.context, 'edit', 'forbidden')).rejects.toThrow(/禁止/)
  expect(await f.chat.botPolicy('Policy BOT', 'owner-phone')).toMatchObject({ data: { approvals: [] } })
})

test('旧 BOT 只可由最初私聊的真实创建者接管，后入群的群主不能认领', async () => {
  const f = fixture(); await f.add(undefined, '')
  expect(await f.chat.botPolicy('Policy BOT', 'other-phone', botPermissionPreset('developer'))).toMatchObject({ ok: false })
  f.setCreator('other-phone'); await f.add(undefined, 'other-phone', 'team')
  f.setCreator('owner-phone')
  expect(await f.chat.botPolicy('Policy BOT', 'owner-phone', botPermissionPreset('developer'))).toMatchObject({ ok: true, data: { ownerPhoneId: 'owner-phone' } })
})


test('配置必须带认证身份和协议，命令沙箱不可用时拒绝授予执行权限且不入群', async () => {
  const f = fixture({ commandSandbox: () => false })
  expect(await f.add(botPermissionPreset('developer'))).toMatchObject({ ok: false })
  expect(f.sent.filter(e => e.op === 'group-join')).toHaveLength(0)
  expect(await f.add(botPermissionPreset('readonly'), '')).toMatchObject({ ok: false })
  expect(await f.chat.addAgent({ code: 'dm', groupId: 'dm', name: 'Policy BOT', sourceSessionId: 'cc-source', botProtocol: 1, permissions: botPermissionPreset('readonly') }, 'owner-phone')).toMatchObject({ ok: false })
})

const tick = () => new Promise(resolve => setTimeout(resolve, 10))
test('非指挥者不能续接含项目工具结果的会话，工具授权每轮关闭且撤权清除旧上下文', async () => {
  const turns: BotTurn[] = []; const opened: string[] = []; let closed = 0
  const f = fixture({ runBot: async turn => { turns.push(turn); return { text: 'answer', sessionId: turn.sessionId ?? `session-${turns.length}` } },
    openBotTools: context => { opened.push(context.memberId); return { connection: { endpoint: 'http://tools', token: 'grant' }, close: () => { closed++ } } } })
  await f.add(botPermissionPreset('readonly'))
  f.message(1); await tick()
  f.message(2, 'other-member'); await tick()
  f.message(3); await tick()
  expect(turns).toHaveLength(3)
  expect(turns[0]).toMatchObject({ canUseProject: true, tools: { token: 'grant' } })
  expect(turns[1]).toMatchObject({ canUseProject: false })
  expect(turns[1].sessionId).toBeUndefined()
  expect(turns[2].sessionId).toBe('session-1')
  expect(opened).toEqual(['owner-member', 'owner-member']); expect(closed).toBe(2)
  await f.chat.botPolicy('Policy BOT', 'owner-phone', botPermissionPreset('readonly'))
  f.message(4); await tick()
  expect(turns[3].sessionId).toBeUndefined()
})

test('执行中撤权会关闭工具且丢弃旧模型结果，不恢复旧会话', async () => {
  let finish: ((result: { text: string; sessionId: string }) => void) | undefined
  let closed = 0; const turns: BotTurn[] = []
  const f = fixture({ runBot: async turn => { turns.push(turn); if (turns.length === 1) return new Promise(resolve => { finish = resolve }); return { text: 'new-answer' } },
    openBotTools: () => ({ connection: { endpoint: 'http://tools', token: 'grant' }, close: () => { closed++ } }) })
  await f.add(botPermissionPreset('readonly')); f.message(1); await tick()
  await f.chat.botPolicy('Policy BOT', 'owner-phone', botPermissionPreset('readonly'))
  finish?.({ text: 'OLD_PROJECT_SECRET', sessionId: 'revoked-session' }); await tick()
  expect(closed).toBe(1)
  expect(f.replies().join()).not.toContain('OLD_PROJECT_SECRET')
  f.message(2); await tick(); expect(turns[1].sessionId).toBeUndefined()
})


test('审批后重新验证真实成员；已经退出的成员即使获准也不能继续操作', async () => {
  const f = fixture(); await f.add(botPermissionPreset('developer'))
  const pending = f.chat.authorizeBotTool(f.context, 'delete', 'removed member').catch(error => error as Error)
  await tick()
  const state = await f.chat.botPolicy('Policy BOT', 'owner-phone')
  const id = state.data!.approvals[0].id
  f.setMembers([member('other-member', 'other-phone')])
  expect(await f.chat.botApprove('Policy BOT', 'owner-phone', id, true)).toMatchObject({ ok: true })
  expect((await pending as Error).message).toMatch(/身份/)
})


test('撤权同时作废尚未送达的旧回复，重连不能补发旧项目结果', async () => {
  const f = fixture({ runBot: async () => ({ text: 'OLD_PROJECT_SECRET', sessionId: 'old-session' }) })
  await f.add(botPermissionPreset('readonly')); f.allowPosts(false)
  f.message(1); await tick()
  await f.chat.botPolicy('Policy BOT', 'owner-phone', botPermissionPreset('readonly'))
  const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'))
  expect(state.agents['Policy BOT'].groups.dm.botQueue[0].reply.text).not.toContain('OLD_PROJECT_SECRET')
})

test('发送者执行途中退出，旧项目结果不再发送', async () => {
  let finish: ((result: { text: string }) => void) | undefined
  const f = fixture({ runBot: async () => new Promise(resolve => { finish = resolve }) })
  await f.add(botPermissionPreset('readonly')); f.message(1); await tick()
  f.setMembers([member('other-member', 'other-phone')])
  finish?.({ text: 'OLD_PROJECT_SECRET' }); await tick()
  expect(f.replies().join()).not.toContain('OLD_PROJECT_SECRET')
})


test('指挥者退出事件及掉线后成员快照都会撤销正在使用的工具授权，BOT 解散也撤销', async () => {
  const revoked: string[] = []; const f = fixture({ onBotPolicyChanged: name => revoked.push(name) })
  await f.add(botPermissionPreset('readonly')); revoked.length = 0
  f.chat.onEnvelope({ op: 'group-meta', groupId: 'dm', payload: { event: 'member-left', groupId: 'dm', member: member('owner-member', 'owner-phone') } })
  expect(revoked).toEqual(['Policy BOT'])
  f.chat.onEnvelope({ op: 'group-meta', groupId: 'dm', payload: { event: 'member-joined', groupId: 'dm', member: member('owner-member', 'owner-phone') } })
  f.setMembers([member('other-member', 'other-phone')])
  await expect(f.chat.authorizeBotTool(f.context, 'read', 'removed offline')).rejects.toThrow(/身份/)
  expect(revoked).toHaveLength(2)
  f.chat.onEnvelope({ op: 'group-meta', groupId: 'dm', payload: { event: 'dissolved', groupId: 'dm' } })
  expect(revoked).toHaveLength(3)
})


test('发送前同步等待期间撤权，不能继续发送持有旧引用的回复片段', async () => {
  const f = fixture({ runBot: async () => ({ text: 'OLD_PROJECT_SECRET' }) })
  await f.add(botPermissionPreset('readonly')); f.holdSync(3)
  f.message(1); await tick()
  await f.chat.botPolicy('Policy BOT', 'owner-phone', botPermissionPreset('readonly'))
  f.resumeSync(); await tick()
  expect(f.replies().join()).not.toContain('OLD_PROJECT_SECRET')
})


test('文件修改审批保留完整新内容，创建者能看到尾部变更', async () => {
  const f = fixture(); await f.add({ ...botPermissionPreset('readonly'), edit: 'ask' })
  const summary = 'edit_file: src/main.ts\n' + 'x'.repeat(6000) + 'TAIL_CHANGE'
  const pending = f.chat.authorizeBotTool(f.context, 'edit', summary).catch(error => error as Error)
  await tick()
  const state = await f.chat.botPolicy('Policy BOT', 'owner-phone')
  expect(state.data!.approvals[0].summary).toBe(summary)
  await f.chat.botApprove('Policy BOT', 'owner-phone', state.data!.approvals[0].id, false)
  await pending
})


test('真实项目工具通过 ChatHub 审批后才落盘，拒绝权限和撤销授权均阻止后续文件操作', async () => {
  let service: BotToolService | undefined
  const revoked: string[] = []
  const f = fixture({ approvalTimeoutMs: 1000, onBotPolicyChanged: name => { revoked.push(name); service?.revoke(name) } })
  service = new BotToolService({ endpoint: () => 'http://127.0.0.1/bot/tool', authorize: (context, operation, summary) => f.chat.authorizeBotTool(context, operation, summary) })
  expect(await f.add({ ...botPermissionPreset('readonly'), create: 'ask', edit: 'allow' })).toMatchObject({ ok: true })
  const grant = service.open(f.context)
  const target = join(f.dir, 'src', 'approved.ts')
  const content = 'export const approved = true;\n// 审批通过才写入\n'
  let completed = false
  const creating = service.call(grant.connection.token, 'create_file', { path: 'src/approved.ts', content }).then(result => { completed = true; return result })
  await tick()
  expect(existsSync(target)).toBe(false)
  expect(completed).toBe(false)
  const state = await f.chat.botPolicy('Policy BOT', 'owner-phone')
  const approval = state.data!.approvals[0]
  expect(approval).toMatchObject({ operation: 'create', groupId: 'dm' })
  expect(approval.summary).toContain(content)
  expect(await f.chat.botApprove('Policy BOT', 'other-phone', approval.id, true)).toMatchObject({ ok: false })
  expect(existsSync(target)).toBe(false)
  expect(completed).toBe(false)
  expect(await f.chat.botApprove('Policy BOT', 'owner-phone', approval.id, true)).toMatchObject({ ok: true })
  expect(await creating).toContain('已创建')
  expect(readFileSync(target, 'utf8')).toBe(content)

  const revocationsBeforeUpdate = revoked.length
  expect(await f.chat.botPolicy('Policy BOT', 'owner-phone', botPermissionPreset('readonly'))).toMatchObject({ ok: true })
  expect(revoked.length).toBe(revocationsBeforeUpdate + 1)
  await expect(service.call(grant.connection.token, 'read_file', { path: 'src/approved.ts' })).rejects.toThrow(/授权已结束/)
  const restricted = service.open(f.context)
  await expect(service.call(restricted.connection.token, 'edit_file', { path: 'src/approved.ts', content: 'SHOULD_NOT_BE_WRITTEN' })).rejects.toThrow(/禁止/)
  expect(readFileSync(target, 'utf8')).toBe(content)
  expect(await service.call(restricted.connection.token, 'read_file', { path: 'src/approved.ts' })).toBe(content)
  service.revoke('Policy BOT')
  await expect(service.call(restricted.connection.token, 'read_file', { path: 'src/approved.ts' })).rejects.toThrow(/授权已结束/)
  expect(readFileSync(target, 'utf8')).toBe(content)
  grant.close(); restricted.close()
})
