import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, linkSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSandboxAvailable, runProjectCommand } from '../src/cli/bot-command-sandbox'

const linux = process.platform === 'linux' ? test : test.skip
linux('真实命令可以修改项目，但不能读取/写入其他项目或连接本机服务', async () => {
  expect(await commandSandboxAvailable()).toBe(true)
  const project = mkdtempSync(join(tmpdir(), 'ce-command-'))
  const other = mkdtempSync(join(tmpdir(), 'ce-command-private-'))
  writeFileSync(join(other, 'secret.txt'), 'PRIVATE')
  const result = await runProjectCommand({ directory: project, command: "printf success > result.txt; cat result.txt" })
  expect(result).toContain('success')
  expect(readFileSync(join(project, 'result.txt'), 'utf8')).toBe('success')
  const blocked = await runProjectCommand({ directory: project, command: `cat '${other}/secret.txt'; printf bad > '${other}/written.txt'; node -e 'require("net").connect(48731,"127.0.0.1").on("error",e=>console.log("NETWORK_DENIED:"+e.code))'` })
  expect(blocked).not.toContain('PRIVATE')
  expect(blocked).toContain('NETWORK_DENIED:')
  expect(existsSync(join(other, 'written.txt'))).toBe(false)
})

linux('命令取消会终止整个进程组，确认超时不留下继续写文件的后台进程', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ce-command-cancel-'))
  const abort = new AbortController()
  const run = runProjectCommand({ directory: project, command: 'sleep 2; printf should-not-exist > after.txt', signal: abort.signal })
  setTimeout(() => abort.abort(), 80)
  await expect(run).rejects.toThrow()
  await new Promise(resolve => setTimeout(resolve, 2100))
  expect(existsSync(join(project, 'after.txt'))).toBe(false)
})

linux('取消 Promise 结束时命令主进程已退出，不能提前让下一个 Worker 写入', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ce-command-exit-'))
  const abort = new AbortController()
  const run = runProjectCommand({ directory: project, command: 'echo $$ > pid.txt; sleep 30', signal: abort.signal })
  const failure = run.catch(error => error)
  for (let i = 0; i < 100 && !existsSync(join(project, 'pid.txt')); i++) await Bun.sleep(10)
  const pid = Number(readFileSync(join(project, 'pid.txt'), 'utf8').trim())
  abort.abort(); await failure
  expect(() => process.kill(pid, 0)).toThrow()
})

linux('命令拒绝包含现有硬链接的项目，避免变更目录外的同一文件', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ce-command-links-'))
  const outside = join(mkdtempSync(join(tmpdir(), 'ce-command-linked-')), 'outside.txt')
  writeFileSync(outside, 'KEEP')
  linkSync(outside, join(project, 'linked.txt'))
  await expect(runProjectCommand({ directory: project, command: 'printf changed > linked.txt' })).rejects.toThrow('硬链接')
  expect(readFileSync(outside, 'utf8')).toBe('KEEP')
})

const rootLinux = process.platform === 'linux' && process.getuid?.() === 0 ? test : test.skip
rootLinux('旧版 Linux 的只读系统范围也禁止只读打开时截断文件', async () => {
  const fixture = `/usr/local/share/ce-bot-sandbox-${randomUUID()}.txt`
  const project = mkdtempSync(join(tmpdir(), 'ce-command-truncate-'))
  writeFileSync(fixture, 'KEEP')
  try {
    const result = await runProjectCommand({ directory: project, command: `python3 -c 'import os; os.open("${fixture}",os.O_RDONLY|os.O_TRUNC)'` })
    expect(result).toContain('PermissionError')
    expect(readFileSync(fixture, 'utf8')).toBe('KEEP')
  } finally { unlinkSync(fixture) }
})

linux('开发命令可以通过 npm 执行本地项目测试，不需要读取用户凭据', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ce-command-npm-'))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('tested.txt','NPM_OK')"` } }))
  const result = await runProjectCommand({ directory: project, command: 'npm test' })
  expect(result).toContain('退出码：0')
  expect(readFileSync(join(project, 'tested.txt'), 'utf8')).toBe('NPM_OK')
})
