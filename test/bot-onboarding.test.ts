import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatHub } from '../src/cli/chat'
import { botPermissionPreset } from '../src/cli/bot-permissions'
import type { BotRuntimeService } from '../src/cli/bot-runtime/service'
import type { GroupEnvelope } from '../src/shared/group'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-onboard-')); mkdirSync(join(dir, 'project'))
  const sent: GroupEnvelope[] = []; const probes: string[] = []; let fail = false
  let release: (() => void) | undefined
  let hold = false
  let busy = false; let invalidations = 0
  let closeGate: Promise<void> | undefined; let finishClose: (() => void) | undefined
  const statePath = join(dir, 'chat.json')
  const chat = new ChatHub({ cid: 'test', privKey: new Uint8Array(32), pubKey: new Uint8Array(32), statePath,
    rootDir: dir, botCliAvailable: async () => true, procLister: () => [],
    sendEnvelope: env => { sent.push(env); queueMicrotask(() => chat.onEnvelope({ op: 'group-result', payload: {
      reqId: env.reqId, ok: true, data: env.op === 'group-join' ? { groupId: 'dm', snapshot: {
        meta: { name: '私聊' }, seq: 0, members: [{ ...(env.payload as { member: object }).member, memberId: 'bot' }, { memberId: 'owner', name: 'Owner', human: true, phoneId: 'owner' }],
      } } : env.op === 'group-sync' ? { members: [{ memberId: 'owner', name: 'Owner', human: true, phoneId: 'owner' }] } : {} } })) },
  })
  chat.attachBotRuntime({ initializeBot: async (_id: string, _actor: string, profile: string) => {
    probes.push(profile)
    if (hold) await new Promise<void>(resolve => { release = resolve })
    if (fail) throw new Error('模型账号不可用')
    return { settings: { mode: 'router-worker' } }
  }, enabled: () => true, approvals: () => [], assertDirectoryChangeAllowed: () => { if (busy) throw new Error('请先完成或停止当前任务') }, policyChanged: async () => { invalidations++; await closeGate } } as unknown as BotRuntimeService)
  const input = { code: 'invite', groupId: 'dm', name: '小林', platform: 'codex', botProtocol: 1, botPolicyProtocol: 1,
    permissions: botPermissionPreset('readonly'), onboarding: { version: 1, creationId: 'create_12345678', directory: '/project',
      identity: { gender: '女', age: 28, avatar: { kind: 'custom', text: '林', color: '#b56146' } },
      guidance: { role: '营销助理', responsibilities: '优化意图识别', scope: '营销项目', exclusions: '不负责上架' } } }
  return { chat, dir, input, probes, sent, state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    fail: (v: boolean) => { fail = v }, hold: () => { hold = true }, release: () => release?.(), busy: (v: boolean) => { busy = v }, invalidations: () => invalidations,
    holdClose: () => { closeGate = new Promise<void>(resolve => { finishClose = resolve }) }, finishClose: () => finishClose?.() }
}

test('目录保存等待旧运行上下文关闭，成功后才能立即接收新目录任务', async () => {
  const f = fixture(); await f.chat.addAgent(f.input, 'owner'); mkdirSync(join(f.dir, 'other')); f.holdClose()
  let finished = false
  const result = f.chat.botDirectory('小林', 'owner', 1, '/other').then(value => { finished = true; return value })
  await Bun.sleep(10)
  expect(f.invalidations()).toBe(1)
  expect(finished).toBe(false)
  f.finishClose()
  expect(await result).toMatchObject({ ok: true, data: { workDirectory: { path: '/other' } } })
})

test('owner 可切到另一项目，保存实际目录与版本，保留身份和创建配置', async () => {
  const f = fixture(); await f.chat.addAgent(f.input, 'owner'); mkdirSync(join(f.dir, 'other'))
  const before = f.state().agents['小林']
  expect((await f.chat.botPolicy('小林', 'owner')).data?.workDirectory).toEqual({ path: '/project', cwd: join(f.dir, 'project') })
  expect(await f.chat.botDirectory('小林', 'owner', 1, '/other')).toMatchObject({ ok: true, data: { revision: 2, workDirectory: { path: '/other', cwd: join(f.dir, 'other') }, permissions: { directory: '.' } } })
  expect(f.chat.runtimeBot('小林')).toMatchObject({ botId: before.bot.id, directory: join(f.dir, 'other'), policyRevision: 2 })
  expect(f.state().agents['小林']).toMatchObject({ cwd: join(f.dir, 'other'), bot: { id: before.bot.id, dmGroupId: 'dm', onboarding: before.bot.onboarding } })
  expect(f.invalidations()).toBe(1)
  expect(await f.chat.botDirectory('小林', 'owner', 2, '/other/.')).toMatchObject({ ok: true, data: { revision: 2 } })
  expect(f.invalidations()).toBe(1)
})

test('换目录仅允许已就绪数字人的owner，拒绝过期版本与无效目录且不改现状', async () => {
  const f = fixture(); await f.chat.addAgent(f.input, 'owner'); mkdirSync(join(f.dir, 'other')); symlinkSync(tmpdir(), join(f.dir, 'escape')); writeFileSync(join(f.dir, 'file'), 'x')
  const before = f.state().agents['小林']
  expect(await f.chat.botDirectory('小林', 'intruder', 1, '/other')).toMatchObject({ ok: false, error: expect.stringContaining('创建者') })
  expect(await f.chat.botDirectory('小林', '', 1, '/other')).toMatchObject({ ok: false })
  expect(await f.chat.botDirectory('小林', 'owner', 0, '/other')).toMatchObject({ ok: false, error: expect.stringContaining('版本') })
  for (const path of ['', '/missing', '/file', '/../', '/escape', '/other\n', '/other\\x', null]) expect(await f.chat.botDirectory('小林', 'owner', 1, path)).toMatchObject({ ok: false })
  f.busy(true)
  expect(await f.chat.botDirectory('小林', 'owner', 1, '/other')).toMatchObject({ ok: false, error: expect.stringContaining('任务') })
  expect(f.state().agents['小林']).toEqual(before); expect(f.invalidations()).toBe(0)
  const failed = fixture(); failed.fail(true); await failed.chat.addAgent(failed.input, 'owner')
  expect(await failed.chat.botDirectory('小林', 'owner', 1, '/project')).toMatchObject({ ok: false, error: expect.stringContaining('初始化') })
})

test('换目录保存失败会回滚内存，不伪报成功或使Session失效', async () => {
  const f = fixture(); await f.chat.addAgent(f.input, 'owner'); mkdirSync(join(f.dir, 'other'))
  const path = join(f.dir, 'chat.json'); renameSync(path, path + '.backup'); mkdirSync(path)
  expect(await f.chat.botDirectory('小林', 'owner', 1, '/other')).toMatchObject({ ok: false })
  expect(f.chat.runtimeBot('小林')).toMatchObject({ directory: join(f.dir, 'project'), policyRevision: 1 })
  expect(f.invalidations()).toBe(0)
  rmSync(path, { recursive: true }); renameSync(path + '.backup', path)
  expect(await f.chat.botDirectory('小林', 'owner', 1, '/other')).toMatchObject({ ok: true })
})

test('独立数字人不能用旧权限接口绕过工作目录切换校验', async () => {
  const f = fixture(); await f.chat.addAgent(f.input, 'owner'); mkdirSync(join(f.dir, 'project', 'nested'))
  f.busy(true)
  expect(await f.chat.botPolicy('小林', 'owner', { ...f.input.permissions, directory: 'nested' })).toMatchObject({ ok: false, error: expect.stringContaining('工作目录') })
  expect(f.chat.runtimeBot('小林')).toMatchObject({ directory: join(f.dir, 'project'), policyRevision: 1 })
})

test('换目录后旧联系人恢复返回当前目录，不要求原目录存在也不重复入职', async () => {
  const f = fixture(); await f.chat.addAgent(f.input, 'owner'); mkdirSync(join(f.dir, 'other'))
  await f.chat.botDirectory('小林', 'owner', 1, '/other'); renameSync(join(f.dir, 'project'), join(f.dir, 'old-project'))
  expect(await f.chat.addAgent(f.input, 'owner')).toMatchObject({ ok: true, data: { cwd: join(f.dir, 'other'), policy: { revision: 2, workDirectory: { path: '/other' } } } })
  expect((await f.chat.addAgent({ ...f.input, onboarding: { ...f.input.onboarding, directory: '/other' } }, 'owner')).ok).toBe(false)
  expect(f.probes).toHaveLength(1); expect(f.sent.filter(e => e.op === 'group-join')).toHaveLength(1)
})

test('独立入职不依赖来源会话；真实目录和身份持久化，初始化完成才ready', async () => {
  const f = fixture(); f.hold()
  const pending = f.chat.addAgent(f.input, 'owner')
  await Bun.sleep(20)
  expect(f.probes).toHaveLength(1)
  expect(f.state().agents['小林'].bot.onboarding.status).toBe('initializing')
  f.release()
  expect(await pending).toMatchObject({ ok: true, data: { onboardingProtocol: 1, ready: true, cwd: join(f.dir, 'project') } })
  expect(f.probes[0]).toContain('不负责上架')
  expect(f.probes[0]).toContain('女')
  expect(f.state().agents['小林'].bot.onboarding.identity.age).toBe(28)
  expect((await f.chat.roster()).botOnboardingProtocol).toBe(1)
})

test('数字员工默认全权限，不依赖命令沙箱，但只有owner有权指挥', async () => {
  const f = fixture()
  const result = await f.chat.addAgent(f.input, 'owner')
  expect(result).toMatchObject({ ok: true, data: { policy: { workerAccessMode: 'full-access', permissions: { execute: 'allow', delete: 'allow' } } } })
  expect(f.chat.runtimeBot(f.input.name)).toMatchObject({ workerAccessMode: 'full-access', directory: join(f.dir, 'project') })
  expect(await f.chat.checkRuntimeAccess(f.chat.runtimeBot(f.input.name).botId, 'owner', 'execute')).toMatchObject({ permissions: { execute: 'allow', delete: 'allow' } })
  await expect(f.chat.checkRuntimeAccess(f.chat.runtimeBot(f.input.name).botId, 'stranger', 'execute')).rejects.toThrow()
})

test('旧联系人收到全权限有效配置后仍能恢复同一数字人，不把可变权限当作创建身份', async () => {
  const f = fixture()
  const first = await f.chat.addAgent(f.input, 'owner')
  const permissions = (first.data as { policy: { permissions: unknown } }).policy.permissions
  expect((await f.chat.addAgent({ ...f.input, permissions }, 'owner')).ok).toBe(true)
  expect(f.probes).toHaveLength(1)
  expect((await f.chat.addAgent({ ...f.input, permissions, platform: 'claude' }, 'owner')).ok).toBe(false)
  expect((await f.chat.addAgent({ ...f.input, permissions, onboarding: { ...f.input.onboarding, guidance: { ...f.input.onboarding.guidance, role: 'changed-role' } } }, 'owner')).ok).toBe(false)
})

test('初始化失败保留失败记录；同请求重试不重复入群，成功后幂等不重建runtime', async () => {
  const f = fixture(); f.fail(true)
  expect(await f.chat.addAgent(f.input, 'owner')).toMatchObject({ ok: false, error: '模型账号不可用' })
  expect(f.state().agents['小林'].bot.onboarding.status).toBe('failed')
  f.fail(false)
  expect((await f.chat.addAgent(f.input, 'owner')).ok).toBe(true)
  expect((await f.chat.addAgent(f.input, 'owner')).ok).toBe(true)
  expect(f.probes).toHaveLength(2)
  expect(f.sent.filter(e => e.op === 'group-join')).toHaveLength(1)
})

test('创建请求校验owner与原始配置，不能被另一台手机接管或静默覆盖', async () => {
  const f = fixture()
  expect((await f.chat.addAgent(f.input)).ok).toBe(false)
  expect((await f.chat.addAgent(f.input, 'owner')).ok).toBe(true)
  expect((await f.chat.addAgent(f.input, 'intruder')).ok).toBe(false)
  expect((await f.chat.addAgent({ ...f.input, onboarding: { ...f.input.onboarding, directory: '/' } }, 'owner')).ok).toBe(false)
  expect((await f.chat.addAgent({ ...f.input, onboarding: { ...f.input.onboarding, creationId: 'different123' } }, 'owner')).ok).toBe(false)
  expect(f.probes).toHaveLength(1)
})

test('目录必须存在且不能通过 .. 或符号链接逃出服务器文件根', async () => {
  const f = fixture(); symlinkSync(tmpdir(), join(f.dir, 'escape'))
  for (const directory of ['../', '/missing', '/escape']) {
    expect((await f.chat.addAgent({ ...f.input, onboarding: { ...f.input.onboarding, directory } }, 'owner')).ok).toBe(false)
  }
  expect(f.sent).toHaveLength(0)
})

test('初始化失败不能从设置绕过检测；就绪数字人不能切到legacy', async () => {
  const f = fixture(); f.fail(true)
  await f.chat.addAgent(f.input, 'owner')
  expect(await f.chat.botRuntimeUpdate('小林', 'owner', 0, { mode: 'router-worker' })).toMatchObject({ ok: false, error: expect.stringContaining('先完成数字人初始化') })
  f.fail(false); await f.chat.addAgent(f.input, 'owner')
  expect(await f.chat.botRuntimeUpdate('小林', 'owner', 1, { mode: 'legacy' })).toMatchObject({ ok: false, error: expect.stringContaining('不能切换') })
})

test('拒绝不完整指导、无效身份和非owner指挥策略', async () => {
  const f = fixture()
  for (const change of [
    { guidance: { ...f.input.onboarding.guidance, scope: '' } },
    { identity: { ...f.input.onboarding.identity, age: -1 } },
    { identity: { ...f.input.onboarding.identity, avatar: { kind: 'upload', data: 'javascript:alert(1)' } } },
  ]) expect((await f.chat.addAgent({ ...f.input, onboarding: { ...f.input.onboarding, ...change } }, 'owner')).ok).toBe(false)
  expect((await f.chat.addAgent({ ...f.input, permissions: { ...f.input.permissions, commanders: 'members' } }, 'owner')).ok).toBe(false)
  expect(f.sent).toHaveLength(0)
})
