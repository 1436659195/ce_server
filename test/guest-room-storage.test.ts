import { afterEach, expect, test } from 'bun:test'
import nacl from 'tweetnacl'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guestClientJs } from '../src/relay/server'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-guest-rooms-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const client = join(dir, 'client.mjs')
  const store = join(dir, 'rooms')
  writeFileSync(client, guestClientJs(join(import.meta.dir, '../scripts/ce-guest-client.mjs'), join(import.meta.dir, '../node_modules/tweetnacl/nacl-fast.min.js')))
  const calls: Array<{ kind: string; body: any }> = []
  let inboxMessage: any = null
  let history: any[] = []
  let serverCursor = 3
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const kind = new URL(req.url).pathname.split('/').pop()!
      if (kind === 'skill.md') return new Response('Room instructions')
      const body = await req.json() as any
      calls.push({ kind, body })
      if (kind === 'inbox') {
        const msgs = inboxMessage ? [inboxMessage] : []
        inboxMessage = null
        await Bun.sleep(25)
        return Response.json({ ok: true, data: { seq: 4, msgs } })
      }
      if (kind === 'sync' && history.length) {
        const msgs = history.filter(m => m.seq > (body.afterSeq ?? 0)).slice(0, body.limit ?? 200)
        if (body.markRead !== false) serverCursor = Math.max(serverCursor, msgs.at(-1)?.seq ?? 0)
        return Response.json({ ok: true, data: { seq: history.at(-1).seq, msgs } })
      }
      if (kind === 'pair') return Response.json({ ok: true, groupId: `g_${body.code}`, groupName: body.code, memberId: `m_${body.code}`, seq: 3 })
      return Response.json({ ok: true, data: { seq: 4, msgs: [] } })
    },
  })
  cleanup.push(() => { server.stop(true) })
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(['node', client, ...args], { env: { ...process.env, CE_GUEST_DIR: store }, stdout: 'pipe', stderr: 'pipe' })
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code, out: out + err }
  }
  const pair = (code: string, alias?: string) => run('pair', code, '--key', Buffer.alloc(32, 7).toString('base64'), '--relay', server.url.toString(), '--name', '同一个BOT', ...(alias ? ['--room', alias] : []))
  const read = (alias: string) => JSON.parse(readFileSync(join(store, alias + '.json'), 'utf8'))
  const listen = (alias: string, command?: string, extraEnv: Record<string, string> = {}) => {
    const proc = Bun.spawn(['node', client, 'listen', '--room', alias, ...(command ? ['--run', command] : [])], { env: { ...process.env, ...extraEnv, CE_GUEST_DIR: store }, stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => { proc.kill() })
    return proc
  }
  const receive = () => {
    const nonce = nacl.randomBytes(24)
    const ct = nacl.secretbox(new TextEncoder().encode(JSON.stringify({ kind: 'text', text: 'room-specific task' })), nonce, new Uint8Array(32).fill(7))
    inboxMessage = { seq: 5, ct: Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString('base64'), from: { memberId: 'human', name: 'Owner', human: true } }
  }
  return { dir, store, calls, run, pair, read, listen, receive, get serverCursor() { return serverCursor },
    setHistory: (count: number) => { history = Array.from({length:count}, (_,i) => { const nonce=nacl.randomBytes(24);return {seq:i+1,ts:Date.now(),from:{memberId:'human',name:'Owner',human:true},ct:Buffer.concat([Buffer.from(nonce),Buffer.from(nacl.secretbox(new TextEncoder().encode(JSON.stringify({kind:'text',text:'retained message '+(i+1)})),nonce,new Uint8Array(32).fill(7)))]).toString('base64')} }); serverCursor=count },
  }
}

test('guest check explicitly advertises room storage support', async () => {
  const h = harness()
  expect(await h.run('check', '--room-storage')).toEqual({ code: 0, out: 'room-storage: 1\n' })
})

test('same BOT display name can pair with DM and group without overwriting either room', async () => {
  const h = harness()
  expect((await h.pair('dm')).code).toBe(0)
  expect((await h.pair('group')).code).toBe(0)
  expect(h.read('g_dm').name).toBe('同一个BOT')
  expect(h.read('g_group').name).toBe('同一个BOT')
  expect(readFileSync(join(h.store, 'default'), 'utf8')).toBe('g_dm.json')
  const rooms = await h.run('rooms')
  expect(rooms.out).toContain('--room g_dm')
  expect(rooms.out).toContain('--room g_group')
  expect((await h.run('read')).code).toBe(0)
  expect(h.calls.at(-1)?.body.code).toBe('dm')
  expect((await h.run('read', '--room', 'g_group')).code).toBe(0)
  expect(h.calls.at(-1)?.body.code).toBe('group')
  expect((await h.run('send', 'hello', '--room', 'g_dm')).code).toBe(0)
  expect(h.calls.at(-1)).toMatchObject({ kind: 'post', body: { code: 'dm', memberId: 'm_dm' } })
})

test('explicit room alias cannot overwrite a different room', async () => {
  const h = harness()
  expect((await h.pair('dm', 'chosen')).code).toBe(0)
  const second = await h.pair('group', 'chosen')
  expect(second.code).toBe(1)
  expect(second.out).toContain('已用于另一个房间')
  expect(h.read('chosen').groupId).toBe('g_dm')
})

test('pairing again preserves same-member read cursor and runtime session', async () => {
  const h = harness()
  expect((await h.pair('dm', 'g_dm')).code).toBe(0)
  const cfg = h.read('g_dm')
  writeFileSync(join(h.store, 'g_dm.json'), JSON.stringify({ ...cfg, lastSeq: 91, twinSessionId: 'persistent-session' }))
  expect((await h.pair('dm', 'g_dm')).code).toBe(0)
  expect(h.read('g_dm')).toMatchObject({ lastSeq: 91, twinSessionId: 'persistent-session' })
})

test('legacy display-name room files remain usable and are not overwritten by new pairing', async () => {
  const h = harness()
  expect((await h.pair('dm', 'legacy-name')).code).toBe(0)
  const cfg = h.read('legacy-name')
  delete cfg.alias
  writeFileSync(join(h.store, 'legacy-name.json'), JSON.stringify(cfg))
  expect((await h.pair('group')).code).toBe(0)
  expect((await h.run('read', '--room', 'legacy-name')).code).toBe(0)
  expect(h.calls.at(-1)?.body.code).toBe('dm')
  expect((await h.run('rooms')).out).toContain('--room legacy-name')
})

test('leaving a nondefault room retains the default and leaving default selects a remaining room', async () => {
  const h = harness()
  await h.pair('dm')
  await h.pair('group')
  expect((await h.run('leave', '--room', 'g_group')).code).toBe(0)
  expect(readFileSync(join(h.store, 'default'), 'utf8')).toBe('g_dm.json')
  await h.pair('group')
  expect((await h.run('leave', '--room', 'g_dm')).code).toBe(0)
  expect(readFileSync(join(h.store, 'default'), 'utf8')).toBe('g_group.json')
  expect(readdirSync(h.store)).toContain('g_group.json')
})

test('pairing again does not advance the local cursor past unread messages', async () => {
  const h = harness()
  await h.pair('dm')
  const cfg = h.read('g_dm')
  writeFileSync(join(h.store, 'g_dm.json'), JSON.stringify({ ...cfg, lastSeq: 1 }))
  await h.pair('dm')
  expect(h.read('g_dm').lastSeq).toBe(1)
})

test('listen routes model read and reply instructions to the selected room instead of the default', async () => {
  const h = harness()
  await h.pair('dm')
  await h.pair('group')
  const command = join(h.dir, 'capture-prompt')
  const output = join(h.dir, 'prompt.txt')
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs'); let text = ''; process.stdin.on('data', c => text += c); process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(output)}, text));
`, { mode: 0o700 })
  h.receive()
  const proc = h.listen('g_group', command)
  const deadline = Date.now() + 3000
  while (!existsSync(output) && Date.now() < deadline) await Bun.sleep(20)
  proc.kill()
  await proc.exited
  expect(existsSync(output)).toBe(true)
  const prompt = readFileSync(output, 'utf8')
  expect(prompt).toContain("read --room 'g_group'")
  expect(prompt).toContain("send --room 'g_group'")
  expect(h.calls.find(c => c.kind === 'inbox')?.body.code).toBe('group')
  expect(existsSync(join(h.store, 'g_group.log'))).toBe(true)
})

test('read --history N returns recent already-read messages without changing local file or server cursor', async () => {
  const h = harness(); await h.pair('dm');h.setHistory(10)
  writeFileSync(join(h.store,'g_dm.json'),JSON.stringify({...h.read('g_dm'),lastSeq:10}))
  const before = readFileSync(join(h.store, 'g_dm.json'), 'utf8')
  const result = await h.run('read', '--history', '2', '--room', 'g_dm')
  expect(result.code).toBe(0)
  expect(result.out).toContain('历史')
  expect(result.out).toContain('retained message 9');expect(result.out).toContain('retained message 10');expect(result.out).not.toContain('retained message 8');expect(h.serverCursor).toBe(10)
  expect(h.calls.filter(c => c.kind === 'sync').every(c => c.body.markRead === false)).toBe(true)
  expect(readFileSync(join(h.store, 'g_dm.json'), 'utf8')).toBe(before)
  expect(h.calls.at(-1)?.body).toMatchObject({ afterSeq: 8, limit: 2, markRead: false })
})

test('unknown flags, missing values, invalid counts and extra positionals fail before network or state changes', async () => {
  const h = harness()
  for (const args of [['rooms','--__proto__','ignored'], ['constructor'], ['read','--all'], ['read','--history'], ['read','--history','0'], ['read','--history','2.5'], ['read','--history','NaN'], ['read','--limit','-2'], ['read','--history','10','--limit','5'], ['read','unexpected'], ['rooms','--room','x']]) {
    expect((await h.run(...args)).code).toBe(1)
  }
  expect(h.calls).toHaveLength(0)
})

test('listen records child stdout, stderr and nonzero exit with a per-wake private log', async () => {
  const h = harness(); await h.pair('dm')
  const command = join(h.dir, 'failing-worker')
  writeFileSync(command, '#!/usr/bin/env node\nprocess.stdout.write("WORKER_STDOUT\\n");process.stderr.write("WORKER_STDERR\\n");process.exit(7)\n', { mode: 0o700 })
  h.receive(); const proc = h.listen('g_dm', command)
  const logs = join(h.store, 'logs', 'g_dm')
  let content = ''; const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (existsSync(logs)) content = readdirSync(logs).map(f => readFileSync(join(logs, f), 'utf8')).join('\n')
    if (content.includes('exitCode=7')) break
    await Bun.sleep(20)
  }
  proc.kill(); await proc.exited
  expect(content).toContain('WORKER_STDOUT');expect(content).toContain('WORKER_STDERR');expect(content).toContain('exitCode=7')
  expect(content).toContain('seq=5')
  expect(h.calls.some(c=>c.kind==='post')).toBe(false)
  if(process.platform!=='win32'){expect(statSync(logs).mode&0o777).toBe(0o700);expect(statSync(join(logs,readdirSync(logs)[0])).mode&0o777).toBe(0o600)}
})

test('default listener uses valid isolated Claude session and history instructions, records launch failures', async () => {
  const h = harness();await h.pair('dm')
  writeFileSync(join(h.store,'g_dm.json'),JSON.stringify({...h.read('g_dm'),twinSessionId:'legacy+invalid=='}))
  const capture=join(h.dir,'default-args.json')
  writeFileSync(join(h.dir,'claude'),`#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),nested:process.env.CLAUDECODE}));console.log('DEFAULT_STDOUT');console.error('DEFAULT_STDERR');process.exit(9)
`,{mode:0o700})
  h.receive();const proc=h.listen('g_dm',undefined,{PATH:h.dir+':'+process.env.PATH,CLAUDECODE:'1'})
  const deadline=Date.now()+3000
  while(!existsSync(capture)&&Date.now()<deadline)await Bun.sleep(20)
  expect(existsSync(capture)).toBe(true)
  const captured=JSON.parse(readFileSync(capture,'utf8'))
  expect(captured.args[captured.args.indexOf('--session-id')+1]).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)
  expect(captured.nested).toBeUndefined()
  expect(captured.args.at(-1)).toContain('read --history')
  expect(captured.args.at(-1)).not.toContain('[object Object]')
  const logdir=join(h.store,'logs','g_dm');let content=''
  while(Date.now()<deadline){if(existsSync(logdir))content=readdirSync(logdir).map(f=>readFileSync(join(logdir,f),'utf8')).join('\n');if(content.includes('exitCode=9'))break;await Bun.sleep(20)}
  proc.kill();await proc.exited
  expect(content).toContain('DEFAULT_STDOUT');expect(content).toContain('DEFAULT_STDERR');expect(content).toContain('exitCode=9')
  expect(h.read('g_dm').twinSessionId).toBe('legacy+invalid==')
  rmSync(capture);h.receive();const retry=h.listen('g_dm',undefined,{PATH:h.dir+':'+process.env.PATH})
  const retryDeadline=Date.now()+3000;while(!existsSync(capture)&&Date.now()<retryDeadline)await Bun.sleep(20)
  expect(JSON.parse(readFileSync(capture,'utf8')).args).toContain('--session-id');retry.kill();await retry.exited
})
