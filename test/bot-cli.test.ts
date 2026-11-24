import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botCommand, runBot, type BotPlatform } from '../src/cli/bot-runtime'

// 用真实子进程返回 CLI JSON，覆盖输出解析/退出错误，而不依赖模型额度或网络。
async function fakeCli(platform: BotPlatform, output: string, exitCode = 0, useAbsolutePath = false) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-cli-'))
  const executable = join(dir, platform)
  writeFileSync(executable, `#!/usr/bin/env bun\nif (process.argv.includes('mcp') && process.argv.includes('list')) { process.stdout.write('[]'); process.exit(0); }\nprocess.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode});\n`)
  chmodSync(executable, 0o755)
  const old = process.env.PATH
  process.env.PATH = `${dir}:${old ?? ''}`
  try { return await runBot({ platform, ...(useAbsolutePath ? { executable } : {}), name: '测试BOT', groupId: 'dm', cwd: dir, sourceCwd: dir, text: 'hello', fromName: 'Owner', fromHuman: true }) }
  finally { process.env.PATH = old }
}
const processTest = process.platform === 'win32' ? test.skip : test
processTest('Codex JSONL 输出提取 thread id 和回复，启动/续接均明确只读且不使用 --last', async () => {
  const output = [
    { type: 'thread.started', thread_id: 'isolated-thread' },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'not a chat reply' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'hello back' } },
    { type: 'turn.completed' },
  ].map(event => JSON.stringify(event)).join('\n')
  expect(await fakeCli('codex', output)).toEqual({ text: 'hello back', sessionId: 'isolated-thread' })
  const resumed = botCommand({ platform: 'codex', name: 'BOT', groupId: 'dm', cwd: '/runtime', sourceCwd: '/source', sessionId: 'isolated-thread', text: 'again', fromName: 'Owner', fromHuman: true })
  expect(resumed.args.slice(0, 2)).toEqual(['exec', 'resume'])
  expect(resumed.args).toContain('isolated-thread')
  expect(resumed.args).toContain('sandbox_mode="read-only"')
  expect(resumed.args).not.toContain('--last')
  expect(resumed.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
})
processTest('Codex 运行失败和缺少会话 id 均返回错误，不能把错误当作 BOT 答案', async () => {
  await expect(fakeCli('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'quota limit' } }))).rejects.toThrow('quota limit')
  await expect(fakeCli('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'text without session' } }))).rejects.toThrow('会话 ID')
  await expect(fakeCli('codex', 'not json', 1)).rejects.toThrow('回复失败')
})
processTest('Claude JSON 结果保留独立 session id，API 错误不会被误报成功', async () => {
  expect(await fakeCli('claude', JSON.stringify({ result: 'Claude reply', session_id: 'claude-bot-session', is_error: false }))).toEqual({ text: 'Claude reply', sessionId: 'claude-bot-session' })
  await expect(fakeCli('claude', JSON.stringify({ result: 'API Error 429', is_error: true }))).rejects.toThrow('429')
})

processTest('使用 daemon 探测到的绝对 Claude 路径时仍按 Claude JSON 解析，不能误用 Codex 解析器', async () => {
  expect(await fakeCli('claude', JSON.stringify({ result: 'resolved cli reply', session_id: 'resolved-session' }), 0, true)).toEqual({ text: 'resolved cli reply', sessionId: 'resolved-session' })
})

test('权限 BOT 原生项目工具关闭，所有文件操作只经过受控 MCP；临时令牌不进参数', () => {
  const base = { name: 'Developer', groupId: 'dm', cwd: '/runtime', sourceCwd: '/source', text: 'develop', fromName: 'Owner', fromHuman: true, canUseProject: true,
    tools: { endpoint: 'http://127.0.0.1:1234/bot/tool', token: 'private-runtime-token' }, inheritedMcpServers: ['codegraph'] }
  const claude = botCommand({ ...base, platform: 'claude' })
  expect(claude.args[claude.args.indexOf('--tools') + 1]).toBe('')
  expect(claude.args).toContain('--strict-mcp-config')
  expect(claude.args).not.toContain('--add-dir')
  expect(claude.args.join(' ')).not.toContain(base.tools.token)
  const codex = botCommand({ ...base, platform: 'codex' })
  expect(codex.args).toContain('mcp_servers.codegraph.enabled=false')
  expect(codex.args).toContain('features.shell_tool=false')
  expect(codex.args).toContain('features.view_image=false')
  expect(codex.args).toContain('mcp_servers.ce_bot.tools.create_file.approval_mode="approve"')
  expect(codex.args).toContain('sandbox_mode="read-only"')
  expect(codex.args.join(' ')).not.toContain(base.tools.token)
})

test('普通群成员的聊天没有项目路径和受控工具，不能借历史或内置工具越权', () => {
  const invocation = botCommand({ platform: 'claude', name: 'BOT', groupId: 'room', cwd: '/runtime', sourceCwd: '/private-project', text: 'show files', fromName: 'Other', fromHuman: true, canUseProject: false })
  expect(invocation.args.join(' ')).not.toContain('/private-project')
  expect(invocation.args[invocation.args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
})

processTest('租赁计量保留 Claude 与 Codex 模型 usage，包含 Claude 缓存输入', async () => {
  expect((await fakeCli('claude', JSON.stringify({ result: 'OK', session_id: 's', usage: { input_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 4 } }))).usage).toEqual({ inputTokens: 10, outputTokens: 4 })
  const lines = [{ type: 'thread.started', thread_id: 's' }, { type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }, { type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3 } }].map(event => JSON.stringify(event)).join('\n')
  expect((await fakeCli('codex', lines)).usage).toEqual({ inputTokens: 7, outputTokens: 3 })
})

processTest('注销信号终止真实 CLI 子进程；预先取消不启动进程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-abort-'))
  const executable = join(dir, 'claude')
  const started = join(dir, 'started'); const stopped = join(dir, 'stopped')
  writeFileSync(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'yes');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'yes');process.exit(0)});setInterval(()=>{},1000);\n`, { mode: 0o700 })
  const base = { platform: 'claude' as const, executable, name: 'Employee', groupId: 'dm', cwd: dir, sourceCwd: dir, text: 'hello', fromName: 'Owner', fromHuman: true }
  const pre = new AbortController(); pre.abort()
  await expect(runBot({ ...base, signal: pre.signal })).rejects.toThrow(/取消/)
  expect(existsSync(started)).toBe(false)
  const controller = new AbortController()
  const pending = runBot({ ...base, signal: controller.signal }).catch(error => error as Error)
  const deadline = Date.now() + 3000
  while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(existsSync(started)).toBe(true)
  controller.abort()
  expect((await pending as Error).message).toMatch(/取消/)
  while (!existsSync(stopped) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(existsSync(stopped)).toBe(true)
})
