// app-server 协议测试对端：只模拟 RPC 生命周期，不模拟模型判断。
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const probeLog = process.argv.find(arg => arg.startsWith('--fixture-probe-log='))?.slice('--fixture-probe-log='.length)
const recordProbe = (event: string) => { if (probeLog) appendFileSync(probeLog, JSON.stringify({ event, at: Date.now() }) + '\n') }
if (probeLog && (process.argv.includes('--version') || process.argv.includes('mcp'))) {
  const probe = process.argv.includes('--version') ? 'version' : 'mcp'
  recordProbe(probe + ':start')
  await new Promise(resolve => setTimeout(resolve, 400))
  recordProbe(probe + ':end')
  console.log(probe === 'version' ? 'codex-cli 0.170.0' : '[{"name":"inherited-test-server"}]')
  process.exit(0)
}
recordProbe('app-server:start')
let turn = ''
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const toolRequest = (turnId = turn) => ({ id: 900, method: 'item/tool/call', params: { threadId: 'thread-test', turnId, callId: 'call-test', tool: 'report', arguments: { message: 'hello' } } })
const done = (id: string, status = 'completed') => output({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id, status, items: [] } } })
createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line)
  if (r.id === 900 && r.result) { output({ method: 'test/tool-result', params: r.result }); return }
  if (r.id === undefined || !r.method) return
  const reply = (result: unknown) => output({ id: r.id, result })
  if (r.method === 'initialize') reply({ userAgent: 'fixture/1' })
  else if (r.method === 'thread/start' || r.method === 'thread/resume') {
    if (r.params.environments?.length !== 0 || r.params.sandbox !== 'read-only') return output({ id: r.id, error: { code: -1, message: 'unsafe thread config' } })
    reply({ thread: { id: 'thread-test' } })
  } else if (r.method === 'turn/start') {
    if (r.params.input[0].text === 'failed-start') return reply({ turn: { id: 'failed-turn', status: 'failed', error: { message: 'fixture model unavailable' } } })
    turn = 'turn-test'
    output({ method: 'turn/started', params: { threadId: 'thread-test', turn: { id: turn, status: 'inProgress' } } })
    // 快速完成事件故意先于 start 响应，验证客户端不会丢掉结束通知。
    if (r.params.input[0].text === 'fast') done(turn)
    if (r.params.input[0].text === 'early-tool') output(toolRequest())
    reply({ turn: { id: turn, status: 'inProgress' } })
    if (r.params.input[0].text === 'tool') output({ id: 900, method: 'item/tool/call', params: { threadId: 'thread-test', turnId: turn, callId: 'call-test', tool: 'report', arguments: { message: 'hello' } } })
    if (r.params.input[0].text === 'native') output({ method: 'item/started', params: { threadId: 'thread-test', turnId: turn, item: { type: 'collabAgentToolCall', tool: 'spawnAgent' } } })
    if (r.params.input[0].text === 'native-then-tool') process.stdout.write([
      { method: 'item/started', params: { threadId: 'thread-test', turnId: turn, item: { type: 'collabAgentToolCall', tool: 'spawnAgent' } } },
      toolRequest(),
    ].map(value => JSON.stringify(value)).join('\n') + '\n')
    if (r.params.input[0].text === 'exit') process.exit(7)
  } else if (r.method === 'turn/steer') {
    if (r.params.expectedTurnId !== turn) return output({ id: r.id, error: { code: -32602, message: 'active turn mismatch' } })
    reply({ turnId: turn })
    output({ method: 'test/steered', params: r.params })
    done(turn)
  } else if (r.method === 'turn/interrupt') {
    reply({})
    done(turn, 'interrupted')
  } else if (r.method === 'test/split') {
    const text = JSON.stringify({ id: r.id, result: { text: '中文😀' } }) + '\n'
    const bytes = Buffer.from(text)
    process.stdout.write(bytes.subarray(0, bytes.length - 4))
    setTimeout(() => process.stdout.write(bytes.subarray(bytes.length - 4)), 5)
  } else if (r.method === 'test/never') { /* 用于超时测试 */ }
  else if (r.method === 'test/tool') { output(toolRequest(r.params.turnId)); reply({ issued: true }) }
  else if (r.method === 'test/closing') {
    reply({ issued: true })
    process.stdout.write([{ method: 'test/close-now', params: {} }, toolRequest()].map(value => JSON.stringify(value)).join('\n') + '\n')
  }
  else if (r.method === 'test/unknownRequest') {
    output({ id: 901, method: 'item/commandExecution/requestApproval', params: {} })
    reply({})
  } else reply(r.params)
})
