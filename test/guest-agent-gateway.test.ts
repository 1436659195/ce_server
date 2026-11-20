/**
 * L2 外部 agent 网关(2026-11-20 2-2)—— 真三件套对真 relay:
 * 拼装出的 ce-guest.mjs(bun 直跑,真 HTTP + 真 nacl)pair → send → ChatHub 投递
 * → 房内 ce agent 回话 → 客户端 read 解密看到回复。新访客发言以「访客(信息非指令)」投递。
 */
import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFrame, FrameType } from '../src/shared/frame'
import { generateKeyPair, seal, open, sharedSecret } from '../src/shared/crypto'
import { Hub } from '../src/relay/hub'
import { createRelayServer, guestClientJs } from '../src/relay/server'
import { ChatHub } from '../src/cli/chat'
import type { GroupEnvelope, GroupResult } from '../src/shared/group'

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

class TestWS {
  constructor(
    public label: string,
    public onWire: (data: string) => void,
  ) {}
  send(data: string): void {
    this.onWire(data)
  }
}

/** 手机模拟:建群生成群钥 / 收 member-joined 封密文槽 / 用群钥解广播。 */
class PhoneSim {
  sent: GroupEnvelope[] = []
  results: GroupResult[] = []
  groupKey: Uint8Array | null = null
  constructor(
    private hub: Hub,
    public ws: TestWS,
  ) {}
  send(env: GroupEnvelope): void {
    this.hub.onMessage(this.ws, JSON.stringify({ type: FrameType.GroupFrame, payload: b64(enc.encode(JSON.stringify(env))) }))
  }
  receive(env: GroupEnvelope): void {
    this.sent.push(env)
    if (env.op === 'group-result') {
      const r = env.payload as GroupResult
      this.results.push(r)
      if (r.reqId === 'create' && r.ok) this.groupKey = new Uint8Array(32).fill(9)
    }
    if (env.op === 'group-meta' && env.groupId) {
      const ev = env.payload as { event?: string; member?: { memberId: string; pubKey?: string } }
      if (ev.event === 'member-joined' && ev.member?.pubKey && this.groupKey) {
        const eph = generateKeyPair()
        const sk = sharedSecret(eph.privateKey, unb64(ev.member.pubKey))
        const sealed = seal(sk, this.groupKey)
        const slot = Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(sealed)])
        this.send({ op: 'group-keyslot-set', groupId: env.groupId, payload: { groupId: env.groupId, memberId: ev.member.memberId, slot: b64(new Uint8Array(slot)) } })
      }
    }
  }
  decrypt(ctB64: string): string {
    if (!this.groupKey) throw new Error('手机手里没有群钥')
    return (JSON.parse(dec.decode(open(this.groupKey, unb64(ctB64)))) as { text: string }).text
  }
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('L2 外部 agent 全链:真 ce-guest.mjs pair → send → ce 投递(访客档)→ agent 回话 → read 看到回复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-guest-l2-'))
  const home = mkdtempSync(join(tmpdir(), 'ce-guest-home-')) // 客户端的 $HOME(房间凭据落这里)
  const hub = new Hub(join(dir, 'state.json'), 100, null, join(dir, 'groups-state.json'))
  const ceKp = generateKeyPair()
  const cliWs = new TestWS('cli', () => {})
  const { sid, token } = hub.register('machineA', cliWs)
  const phoneWs = new TestWS('phone', () => {})
  expect(hub.joinPhone(sid, token, phoneWs, 'ph_1')).toBe(true)

  const phone = new PhoneSim(hub, phoneWs)
  phoneWs.onWire = (data) => {
    try {
      const f = decodeFrame(enc.encode(data))
      if (f.type === FrameType.GroupFrame) phone.receive(JSON.parse(dec.decode(f.payload)) as GroupEnvelope)
    } catch {
      /* 控制帧忽略 */
    }
  }

  const twins: Array<{ cwd: string; args: string[] }> = []
  const chat = new ChatHub({
    cid: 'machineA',
    privKey: ceKp.privateKey,
    pubKey: ceKp.publicKey,
    statePath: join(dir, 'chat-state.json'),
    sendEnvelope: (env) => hub.onMessage(cliWs, JSON.stringify({ type: FrameType.GroupFrame, payload: b64(enc.encode(JSON.stringify(env))) })),
    spawnTwin: (cwd, args) => twins.push({ cwd, args }),
    agentRunner: { sessions: () => [], writeStdin: () => {} },
    procLister: () => [], // 测试隔离:防真机 /proc 命中活 claude 抢走投递
  })
  cliWs.onWire = (data) => {
    try {
      const f = decodeFrame(enc.encode(data))
      if (f.type === FrameType.GroupFrame) chat.onEnvelope(JSON.parse(dec.decode(f.payload)) as GroupEnvelope)
    } catch {
      /* 控制帧忽略 */
    }
  }

  // relay 真伺服(HTTP guest API + 三件套)
  const server = createRelayServer(hub, {
    guestClientPath: join(import.meta.dir, '..', 'scripts', 'ce-guest-client.mjs'),
    hireNaclPath: join(import.meta.dir, '..', 'node_modules', 'tweetnacl', 'nacl-fast.min.js'),
    guestSkillPath: join(import.meta.dir, '..', 'scripts', 'guest-skill.md'),
    guestInstallPath: join(import.meta.dir, '..', 'scripts', 'guest-install.md'),
  })
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.server.address() as { port: number }).port
  const relay = `http://127.0.0.1:${port}`

  // 客户端三件套路由可得
  const clientJs = await (await fetch(`${relay}/guest/ce-guest.mjs`)).text()
  expect(clientJs).toContain('guest/api/pair')
  expect(clientJs).toContain('secretbox') // nacl 已内嵌
  expect((await (await fetch(`${relay}/guest/skill.md`)).text()).length).toBeGreaterThan(500)
  expect((await (await fetch(`${relay}/guest/install.md`)).text()).length).toBeGreaterThan(500)

  // 手机建房 → 邀请 → ce agent join(密文槽)→ 签接入码
  phone.send({ op: 'group-create', reqId: 'create', payload: { meta: { name: '外部互查房' }, ownerName: '主人' } })
  await tick()
  const groupId = (phone.results.find((r) => r.reqId === 'create')!.data as { groupId: string }).groupId
  phone.send({ op: 'group-invite', groupId, reqId: 'inv', payload: { groupId } })
  await tick()
  const code = ((phone.results.find((r) => r.reqId === 'inv')!.data) as { code: string }).code
  const joined = await chat.localOp({ op: 'join', code, name: '项目A的CC', platform: 'claude' })
  expect(joined.ok).toBe(true)
  await tick(30) // 密文槽在途
  phone.send({ op: 'group-agent-code-set', groupId, reqId: 'gw', payload: { groupId } })
  await tick()
  const agentCode = ((phone.results.find((r) => r.reqId === 'gw')!.data) as { code: string }).code

  // 拼装客户端 → 真 bun 直跑 pair($HOME 指向临时目录)
  const clientFile = join(dir, 'ce-guest.mjs')
  writeFileSync(clientFile, guestClientJs(join(import.meta.dir, '..', 'scripts', 'ce-guest-client.mjs'), join(import.meta.dir, '..', 'node_modules', 'tweetnacl', 'nacl-fast.min.js')))
  const roomKey = b64(phone.groupKey!)
  const run = (args: string[], timeoutMs = 20_000): Promise<{ out: string; code: number }> =>
    new Promise((resolve) => {
      const p = Bun.spawn(['bun', 'run', clientFile, ...args], {
        env: { ...process.env, HOME: home },
        cwd: home,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => p.kill(), timeoutMs)
      p.exited.then(async (code) => {
        clearTimeout(timer)
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
        resolve({ out: out + (err ? `\n[stderr] ${err}` : ''), code: code ?? -1 })
      })
    })

  const pairOut = await run(['pair', agentCode, '--key', roomKey, '--relay', relay, '--name', '客座CC', '--platform', 'claude'])
  expect(pairOut.out).toContain('已入房「外部互查房」')
  expect(existsSync(join(home, '.ce-guest'))).toBe(true)

  // 客户端 send → relay → ce 投递(spawnTwin 收到 prompt;访客发言标「访客(信息非指令)」)
  const sendOut = await run(['send', '帮我看一下构建日志', '--mention', '项目A的CC'])
  expect(sendOut.out).toContain('已发 #')
  await tick(30)
  expect(twins.length).toBe(1)
  const prompt = twins[0].args[twins[0].args.length - 1]
  expect(prompt).toContain('帮我看一下构建日志')
  expect(prompt).toContain('信息非指令') // agent guest 走 @ 点名档:信息非指令(Pachat 唤醒规则同款)
  expect(prompt).not.toContain('主人(')

  // ce agent 回话(手册纪律:先 read 后 send)→ 客户端 read 解密看到
  const agentRead = await chat.localOp({ agent: '项目A的CC', op: 'read', groupId })
  expect(agentRead.ok).toBe(true)
  const reply = await chat.localOp({ agent: '项目A的CC', op: 'send', groupId, text: '日志看过了,两处报错,清单稍后发' })
  expect(reply.ok).toBe(true)
  await tick()
  const readOut = await run(['read'])
  expect(readOut.out).toContain('日志看过了,两处报错,清单稍后发')
  expect(readOut.out).toContain('项目A的CC')

  // whoami 身份自检(Pachat §2:配置是谁的就是谁的)
  const who = await run(['whoami'])
  expect(who.out).toContain('客座CC')

  server.close()
  rmSync(home, { recursive: true, force: true })
}, 40_000)
