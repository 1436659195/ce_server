import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
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
  }, enabled: () => true, approvals: () => [] } as unknown as BotRuntimeService)
  const input = { code: 'invite', groupId: 'dm', name: '小林', platform: 'codex', botProtocol: 1, botPolicyProtocol: 1,
    permissions: botPermissionPreset('readonly'), onboarding: { version: 1, creationId: 'create_12345678', directory: '/project',
      identity: { gender: '女', age: 28, avatar: { kind: 'custom', text: '林', color: '#b56146' } },
      guidance: { role: '营销助理', responsibilities: '优化意图识别', scope: '营销项目', exclusions: '不负责上架' } } }
  return { chat, dir, input, probes, sent, state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    fail: (v: boolean) => { fail = v }, hold: () => { hold = true }, release: () => release?.() }
}

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
