import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatHub, type ChatHubOpts } from '../src/cli/chat'
import { seal, open } from '../src/shared/crypto'
import type { GroupEnvelope, GroupStoredMsg } from '../src/shared/group'

const tick = () => new Promise(resolve => setTimeout(resolve, 10))
function fixture(overrides: Partial<ChatHubOpts> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-bot-'))
  const key = new Uint8Array(32).fill(7)
  const sent: GroupEnvelope[] = []
  const delivered: GroupEnvelope[] = []
  const history: Record<string, GroupStoredMsg[]> = {}
  let remainingPosts: number | undefined
  let joinedSeq = 0
  let chat: ChatHub
  const turns: Array<{ platform: string; sessionId?: string; cwd: string; sourceCwd: string; text: string }> = []
  const opts: ChatHubOpts = { cid: 'machine', pubKey: new Uint8Array(32), privKey: new Uint8Array(32), statePath: join(dir, 'chat.json'), rootDir: dir,
    rosterSessions: async () => ({ terminals: [{ name: 'term-codex' }], agentSessions: [{ sid: 'cc-source', cwd: dir }] }),
    botCliAvailable: async () => true,
    runBot: async turn => { turns.push(turn); return { text: 'BOT_REPLY', sessionId: turn.sessionId ?? 'bot-session' } },
    sendEnvelope: env => { sent.push(env); queueMicrotask(() => {
      const p = env.payload as Record<string, unknown>
      let data: unknown = {}
      if (env.op === 'group-join') data = { groupId: p.inviteCode, snapshot: { meta: { name: 'Chat room' }, seq: joinedSeq, members: [{ memberId: 'bot-member', ...(p.member as object) }] } }
      if (env.op === 'group-sync') data = { msgs: (history[env.groupId ?? ''] ?? []).filter(m => m.seq > Number(p.afterSeq ?? 0)), seq: 0 }
      if (env.op === 'group-post') {
        if (String(p.ct).length > 20000) { chat.onEnvelope({ op: 'group-result', payload: { reqId: env.reqId, ok: false, error: { code: 'too_large', message: '正文超限' } } }); return }
        if (remainingPosts === 0) { chat.onEnvelope({ op: 'group-result', payload: { reqId: env.reqId, ok: false, error: { code: 'offline', message: 'relay offline' } } }); return }
        if (remainingPosts !== undefined) remainingPosts--
        delivered.push(env); data = { seq: 10 }
      }
      chat.onEnvelope({ op: 'group-result', payload: { reqId: env.reqId, ok: true, data } })
    }) }, ...overrides }
  chat = new ChatHub(opts)
  chat.setKey('roomA', Buffer.from(key).toString('base64'))
  chat.setKey('roomB', Buffer.from(key).toString('base64'))
  const stored = (seq: number, text: string): GroupStoredMsg => ({ seq, ts: Date.now(), from: { memberId: 'human', name: 'Owner', human: true }, ct: Buffer.from(seal(key, new TextEncoder().encode(JSON.stringify({ kind: 'text', text })))).toString('base64') })
  const message = (seq: number, text: string, room = 'roomA') => chat.onEnvelope({ op: 'group-msg', groupId: room, payload: stored(seq, text) })
  const postTexts = () => delivered.map(e => JSON.parse(new TextDecoder().decode(open(key, new Uint8Array(Buffer.from((e.payload as {ct: string}).ct, 'base64'))))).text as string)
  return { get chat() { return chat }, turns, sent, dir, message, postTexts,
    restart: () => { chat = new ChatHub(opts) },
    allowPosts: (n?: number) => { remainingPosts = n },
    setJoinSeq: (seq: number) => { joinedSeq = seq },
    offlineMessage: (seq: number, text: string, room = 'roomA') => { (history[room] ??= []).push(stored(seq, text)) },
  }
}

const claude = { code: 'roomA', groupId: 'roomA', name: 'Claude BOT', platform: 'claude', sourceSessionId: 'cc-source', botProtocol: 1 as const }

test('租赁账本持久保存品牌，旧账本从员工身份补全，不依赖仍打开的来源会话', async () => {
  const f = fixture()
  expect((await f.chat.hireSetup({ ...claude, name: '设计师' })).ok).toBe(true)
  expect(f.chat.hireStatus().data).toMatchObject([{ agent: '设计师', platform: 'claude' }])
  const path = join(f.dir, 'chat.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  expect(state.hires.roomA.platform).toBe('claude')
  delete state.hires.roomA.platform
  writeFileSync(path, JSON.stringify(state))
  f.restart()
  expect(f.chat.hireStatus().data).toMatchObject([{ agent: '设计师', platform: 'claude' }])
})

test('独立 Claude BOT: 精确验证来源、确认真实目录和协议，不投同目录的任何 Agent', async () => {
  const injected: string[] = []
  const f = fixture({ agentRunner: { sessions: () => [{ sid: 'cc-source', cwd: '/same', started: true }, { sid: 'cc-other', cwd: '/same', started: true }], writeStdin: sid => injected.push(sid) } })
  const result = await f.chat.addAgent({ ...claude, sourceCwd: '/untrusted/path' })
  expect(result).toMatchObject({ ok: true, data: { botProtocol: 1, cwd: f.dir } })
  f.message(1, 'hello')
  await tick()
  expect(injected).toEqual([])
  expect(f.turns).toHaveLength(1)
  expect(f.turns[0].cwd.startsWith(join(f.dir, 'bots'))).toBe(true)
  expect(f.turns[0].sourceCwd).toBe(f.dir)
  expect(f.postTexts()).toContain('BOT_REPLY')
})

test('Codex BOT: 验证终端存在并按 Jupyter 根解析来源路径，Gemini 拒绝', async () => {
  const f = fixture()
  const result = await f.chat.addAgent({ ...claude, name: 'Codex BOT', platform: 'codex', sourceSessionId: 'term-codex', sourceCwd: '/' })
  expect(result).toMatchObject({ ok: true, data: { botProtocol: 1, cwd: f.dir } })
  f.message(1, 'hello codex'); await tick()
  expect(f.turns[0].platform).toBe('codex')
  expect((await f.chat.addAgent({ ...claude, name: 'Unknown', sourceSessionId: 'missing' })).ok).toBe(false)
  expect((await f.chat.addAgent({ ...claude, name: 'Gemini', platform: 'gemini' })).ok).toBe(false)
})

test('addAgent 幂等重试，不重复 join；来源退出后仍可邀请同一 BOT 到新群', async () => {
  let sources = true
  const project = mkdtempSync(join(tmpdir(), 'bot-source-'))
  const f = fixture({ rosterSessions: async () => ({ terminals: [], agentSessions: sources ? [{ sid: 'cc-source', cwd: project }] : [] }) })
  expect((await f.chat.addAgent(claude)).ok).toBe(true)
  sources = false
  expect((await f.chat.addAgent(claude)).ok).toBe(true)
  expect(f.sent.filter(e => e.op === 'group-join')).toHaveLength(1)
  expect((await f.chat.addAgent({ ...claude, groupId: 'roomB', code: 'roomB' })).ok).toBe(true)
  expect(f.sent.filter(e => e.op === 'group-join')).toHaveLength(2)
  expect((await f.chat.addAgent({ ...claude, sourceSessionId: 'other-source' })).ok).toBe(false)
})

test('每房间串行且不丢快发消息，持久会话续接、房间上下文隔离', async () => {
  let finish: ((r: {text: string; sessionId: string}) => void) | undefined
  const calls: Array<{ sessionId?: string; text: string }> = []
  const f = fixture({ runBot: async turn => { calls.push(turn); if (calls.length === 1) return new Promise(resolve => { finish = resolve }); return { text: turn.text, sessionId: turn.sessionId ?? 'other-room-session' } } })
  await f.chat.addAgent(claude)
  await f.chat.addAgent({ ...claude, code: 'roomB', groupId: 'roomB' })
  f.message(1, 'first'); f.message(2, 'second'); f.message(2, 'second')
  await tick(); expect(calls).toHaveLength(1)
  finish?.({ text: 'first reply', sessionId: 'room-a-session' }); await tick()
  expect(calls).toHaveLength(2)
  expect(calls[1].sessionId).toBe('room-a-session')
  f.message(1, 'separate', 'roomB'); await tick()
  expect(calls[2].sessionId).toBeUndefined()
  const saved = JSON.parse(readFileSync(join(f.dir, 'chat.json'), 'utf8'))
  expect(saved.agents['Claude BOT'].groups.roomA.botSessionId).toBe('room-a-session')
})

test('CLI 缺失在入群前失败；运行失败发可见 system 消息，后续新消息可重试', async () => {
  const unavailable = fixture({ botCliAvailable: async () => false })
  expect((await unavailable.chat.addAgent(claude)).ok).toBe(false)
  expect(unavailable.sent.filter(e => e.op === 'group-join')).toHaveLength(0)
  let fail = true
  const f = fixture({ runBot: async () => { if (fail) throw new Error('API quota exceeded'); return { text: 'recovered' } } })
  await f.chat.addAgent(claude)
  f.message(1, 'hello'); await tick()
  expect(f.postTexts().some(t => t.includes('API quota exceeded'))).toBe(true)
  fail = false; f.message(2, 'retry'); await tick()
  expect(f.postTexts()).toContain('recovered')
  expect((await f.chat.roster()).botProtocol).toBe(1)
})


test('越根/不存在来源目录拒绝，长回复按消息限额发送而不丢内容', async () => {
  const f = fixture({ runBot: async () => ({ text: 'x'.repeat(10005) }) })
  expect((await f.chat.addAgent({ ...claude, sourceSessionId: 'term-codex', sourceCwd: '../' })).ok).toBe(false)
  expect((await f.chat.addAgent({ ...claude, sourceSessionId: 'term-codex', sourceCwd: '/missing-directory' })).ok).toBe(false)
  await f.chat.addAgent(claude); f.message(1, 'long reply'); await tick()
  expect(f.postTexts().join('')).toBe('x'.repeat(10005))
  expect(f.postTexts().every(text => text.length <= 10000)).toBe(true)
})


test('断线/重启保留 outbox 和分条游标，恢复只重发未确认分条，不重复运行模型', async () => {
  let runs = 0
  const f = fixture({ runBot: async () => { runs++; return { text: 'x'.repeat(10005), sessionId: 'persistent-bot-session' } } })
  await f.chat.addAgent(claude)
  f.allowPosts(1); f.message(1, 'hello'); await tick()
  expect(f.postTexts()).toHaveLength(1)
  const stored = JSON.parse(readFileSync(join(f.dir, 'chat.json'), 'utf8'))
  expect(stored.agents['Claude BOT'].groups.roomA.botQueue[0].reply.offset).toBe(10000)
  expect(runs).toBe(1)
  f.restart(); await tick()
  expect(runs).toBe(1)
  expect(f.postTexts()).toHaveLength(1)
  f.allowPosts(); f.chat.bootSync(); await tick()
  expect(runs).toBe(1)
  expect(f.postTexts().join('')).toBe('x'.repeat(10005))
  const posted = f.sent.filter(e => e.op === 'group-post')
  expect((posted[1].payload as {opKey: string}).opKey).toBe((posted[2].payload as {opKey: string}).opKey)
})

test('离线时的消息从 BOT 工作游标恢复，并与在线消息去重', async () => {
  const f = fixture()
  await f.chat.addAgent(claude)
  f.offlineMessage(1, 'while offline')
  f.chat.bootSync(); await tick()
  expect(f.turns.map(t => t.text)).toEqual(['while offline'])
  f.chat.bootSync(); f.message(1, 'while offline'); await tick()
  expect(f.turns).toHaveLength(1)
  f.offlineMessage(2, 'new offline message')
  f.chat.bootSync(); await tick()
  expect(f.turns.map(t => t.text)).toEqual(['while offline', 'new offline message'])
})

test('邀请码错房间会撤回成员且不登记 BOT', async () => {
  const f = fixture()
  const result = await f.chat.addAgent({ ...claude, code: 'roomB', groupId: 'roomA' })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('已撤回')
  expect(f.sent.some(e => e.op === 'group-leave' && e.groupId === 'roomB')).toBe(true)
  expect((await f.chat.roster()).agents).toEqual([])
})


test('新 BOT 入已有历史群不会回复入群前消息，之后离线消息正常恢复', async () => {
  const f = fixture()
  f.setJoinSeq(8)
  f.offlineMessage(1, 'old task'); f.offlineMessage(8, 'old chat')
  await f.chat.addAgent(claude)
  f.chat.bootSync(); await tick()
  expect(f.turns).toHaveLength(0)
  f.offlineMessage(9, 'after joining')
  f.chat.bootSync(); await tick()
  expect(f.turns.map(turn => turn.text)).toEqual(['after joining'])
})

test('恢复 BOT 离线历史不会再次向同群 legacy Agent 注入旧消息', async () => {
  const injected: string[] = []
  const legacyCwd = mkdtempSync(join(tmpdir(), 'legacy-source-'))
  const f = fixture({ agentRunner: { sessions: () => [{ sid: 'legacy-source', cwd: legacyCwd, started: true }], writeStdin: (_sid, text) => injected.push(text) } })
  await f.chat.addAgent(claude)
  await f.chat.localOp({ op: 'join', code: 'roomA', name: 'Legacy', cwd: legacyCwd, platform: 'claude' })
  f.offlineMessage(1, 'offline task')
  f.chat.bootSync(); await tick()
  expect(f.turns.map(turn => turn.text)).toEqual(['offline task'])
  expect(injected).toHaveLength(0)
})


test('离线漏消息后先收到较新实时消息，不会跳过历史缺口', async () => {
  const f = fixture()
  f.setJoinSeq(8)
  await f.chat.addAgent(claude)
  f.offlineMessage(9, 'offline nine')
  f.message(10, 'live ten')
  await tick()
  f.chat.bootSync(); await tick()
  expect(f.turns.map(turn => turn.text).sort()).toEqual(['live ten', 'offline nine'])
  f.message(10, 'live ten'); f.chat.bootSync(); await tick()
  expect(f.turns).toHaveLength(2)
})


test('已读游标领先工作游标时，发送前同步仍补齐历史缺口', async () => {
  const f = fixture()
  await f.chat.addAgent(claude)
  const stateFile = join(f.dir, 'chat.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.agents['Claude BOT'].groups.roomA.lastReadSeq = 10
  writeFileSync(stateFile, JSON.stringify(state))
  f.offlineMessage(9, 'missed nine')
  f.restart(); f.message(11, 'live eleven'); await tick()
  expect(f.turns.map(turn => turn.text).sort()).toEqual(['live eleven', 'missed nine'])
})


test('中文/emoji/JSON转义长回复按真实密文预算分条，且不阻塞后续消息', async () => {
  const longText = '中文😀\\"\n'.repeat(3000)
  let runs = 0
  const f = fixture({ runBot: async () => ({ text: ++runs === 1 ? longText : 'next reply' }) })
  await f.chat.addAgent(claude)
  f.message(1, 'long unicode answer'); await tick()
  expect(f.postTexts().join('')).toBe(longText)
  expect(f.sent.filter(e => e.op === 'group-post').every(e => String((e.payload as {ct: string}).ct).length <= 20000)).toBe(true)
  expect(f.postTexts().every(text => !/[\uD800-\uDBFF]$/.test(text))).toBe(true)
  f.message(2, 'continue'); await tick()
  expect(f.postTexts().at(-1)).toBe('next reply')
})

test('租赁按明确来源创建独立 Claude/Codex 数字员工，不按名字猜目录', async () => {
  for (const platform of ['claude', 'codex'] as const) {
    const f = fixture()
    const result = await f.chat.hireSetup({ ...claude, name: `Leased ${platform}`, platform, sourceSessionId: platform === 'codex' ? 'term-codex' : 'cc-source', sourceCwd: '/', quota: { maxRuns: 1 } })
    expect(result.ok).toBe(true)
    const saved = JSON.parse(readFileSync(join(f.dir, 'chat.json'), 'utf8'))
    expect(saved.agents[`Leased ${platform}`].bot?.sourceSessionId).toBe(platform === 'codex' ? 'term-codex' : 'cc-source')
    f.message(1, 'hello'); await tick()
    expect(f.turns[0].platform).toBe(platform)
    expect(f.turns[0].sourceCwd).toBe(f.dir)
    expect(f.postTexts()).toContain('BOT_REPLY')
  }
})

test('租赁来源失效拒绝创建，不默默用 daemon 目录，也不留下租赁记录', async () => {
  const f = fixture()
  const result = await f.chat.hireSetup({ ...claude, sourceSessionId: 'missing', quota: {} })
  expect(result.ok).toBe(false)
  expect(f.sent.filter(e => e.op === 'group-join')).toHaveLength(0)
  expect(f.chat.hireStatus().data).toEqual([])
})

test('租赁数字员工按模型使用量计费，队列及重启恢复同样受额度限制', async () => {
  let runs = 0
  const f = fixture({ runBot: async () => { runs++; return { text: 'DONE', usage: { inputTokens: 7, outputTokens: 3 } } } })
  await f.chat.hireSetup({ ...claude, quota: { maxTokens: 10, maxRuns: 1 } })
  f.message(1, 'first'); f.message(2, 'queued'); await tick(); await tick()
  expect(runs).toBe(1)
  expect(f.chat.hireStatus().data).toMatchObject([{ used: { tokens: 10, runs: 1 } }])
  f.offlineMessage(3, 'offline'); f.restart(); f.chat.bootSync(); await tick(); await tick()
  expect(runs).toBe(1)
})

test('Token 租赁在代理未返回 usage 时明确暂停，不能无限免费继续运行', async () => {
  const f = fixture()
  await f.chat.hireSetup({ ...claude, quota: { maxTokens: 1000 } })
  f.message(1, 'first'); await tick(); await tick()
  f.message(2, 'second'); await tick(); await tick()
  expect(f.turns).toHaveLength(1)
  expect(f.postTexts().some(text => text.includes('未返回用量'))).toBe(true)
})
