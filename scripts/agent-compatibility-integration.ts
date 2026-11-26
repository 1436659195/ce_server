/** Explicit opt-in; temporary contexts, synthetic text and host-only tools. No social messages. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import { CodexAppServer, type CodexToolCall, type CodexToolSpec } from '../src/cli/bot-runtime/codex'
import type { RuntimeClient } from '../src/cli/bot-runtime/service'

if (!process.argv.includes('--live')) throw new Error('Explicit --live is required')
const platform = process.argv.includes('--codex') ? 'codex' : 'claude'
const root = mkdtempSync(join(tmpdir(), `ce-agent-compat-${platform}-`))
const nonce = randomUUID()
const events: Array<Record<string, unknown>> = []
const record = (stage: string, detail: Record<string, unknown> = {}) => { const entry = { platform, stage, ...detail }; events.push(entry); console.log(JSON.stringify(entry)) }
const tools: CodexToolSpec[] = [
  { name: 'compat_note', description: 'Confirm a test phase using the original nonce.', inputSchema: { type: 'object', properties: { phase: { type: 'string', enum: ['initial', 'append', 'resume'] }, nonce: { type: 'string' } }, required: ['phase', 'nonce'], additionalProperties: false } },
  { name: 'compat_step', description: 'Perform one harmless step; continue until done=true.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]
let phase: 'initial' | 'append' | 'resume' | 'stop' = 'initial'
const notes = new Set<string>()
let steps = 0
let appendedTurn = ''
const handler = async (call: CodexToolCall) => {
  if (call.tool === 'compat_note') {
    if (call.arguments.nonce !== nonce || call.arguments.phase !== phase) throw new Error('Wrong nonce or phase')
    notes.add(String(call.arguments.phase))
    if (phase === 'append') appendedTurn = call.turnId
    record('tool', { phase: call.arguments.phase })
    return { ok: true }
  }
  if (call.tool !== 'compat_step') throw new Error('Unexpected tool')
  steps++
  await Bun.sleep(350)
  return { done: phase !== 'stop' && notes.has('append'), instruction: 'Handle any new user input first; otherwise call compat_step again.' }
}
const clients: RuntimeClient[] = []
const make = (): RuntimeClient => {
  const options = { cwd: root, onToolCall: handler }
  const client = platform === 'claude' ? new ClaudeRuntime(options) : new CodexAppServer(options)
  clients.push(client); return client
}
async function waitFor(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 45_000
  while (!test()) { if (Date.now() > deadline) throw new Error('Expected tool activity timed out'); await Bun.sleep(50) }
}
const timer = setTimeout(() => { for (const client of clients) void client.close() }, 180_000)
try {
  const client = make()
  const thread = await client.startThread({ instructions: 'You are a protocol compatibility tester. Only use compat_note and compat_step. Preserve the original nonce for later phases. Follow tool instructions and new user inputs. Do not use files, shell, web, agents or any other tools.', tools })
  const initial = await client.startTurn(thread, `Original nonce: ${nonce}. Call compat_note with phase=initial and this nonce, then finish.`)
  if ((await initial.done).status !== 'completed' || !notes.has('initial')) throw new Error('Initial tool roundtrip failed')
  record('initial:PASS')
  phase = 'append'
  const active = await client.startTurn(thread, 'Call compat_step repeatedly until it returns done=true. Do not stop early. Handle any new message immediately.')
  await waitFor(() => steps > 0)
  await client.steer(thread, active.turnId, 'New input: call compat_note with phase=append and the original nonce now; then continue compat_step until done=true.')
  if ((await active.done).status !== 'completed' || !notes.has('append') || appendedTurn !== active.turnId) throw new Error('Supplement did not run in the original active turn')
  record('append:PASS')
  await client.close()
  phase = 'resume'
  const resumed = make()
  if (await resumed.resumeThread(thread, { instructions: 'Resume the protocol test. Use only the two host tools and recall the original nonce.', tools }) !== thread) throw new Error('Session identity changed')
  const next = await resumed.startTurn(thread, 'Call compat_note with phase=resume and the original nonce from the earlier conversation, then finish.')
  if ((await next.done).status !== 'completed' || !notes.has('resume')) throw new Error('Session context or tools were not restored')
  record('resume:PASS')
  phase = 'stop'; steps = 0
  const stopping = await resumed.startTurn(thread, 'Call compat_step repeatedly until done=true. This phase tests host interruption; keep going until interrupted.')
  await waitFor(() => steps > 0)
  await resumed.interrupt(thread, stopping.turnId)
  if ((await stopping.done).status !== 'interrupted') throw new Error('Interrupt was not confirmed')
  record('interrupt:PASS')
  record('PASS', { retainedSession: true })
} catch (error) { process.exitCode = 1; record('FAIL', { error: error instanceof Error ? error.message : String(error) }) }
finally {
  clearTimeout(timer)
  await Promise.all(clients.map(client => client.close()))
  writeFileSync(join(root, 'verification.json'), JSON.stringify(events, null, 2), { mode: 0o600 })
  console.log(`Evidence: ${join(root, 'verification.json')}`)
}
