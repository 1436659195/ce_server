import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotToolService } from '../src/cli/bot-tools'

const permissions = { version: 1 as const, directory: '.', read: 'allow' as const, create: 'allow' as const, edit: 'allow' as const, delete: 'allow' as const, execute: 'allow' as const, commanders: 'owner' as const, allowedPhoneIds: [] }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ce-tools-'))
  const outside = mkdtempSync(join(tmpdir(), 'ce-private-'))
  let denied = false
  let pending: (() => void) | undefined
  const calls: string[] = []
  const service = new BotToolService({ endpoint: () => 'http://127.0.0.1:1234/bot/tool',
    authorize: async (_context, operation) => {
      calls.push(operation)
      if (pending) await new Promise<void>(resolve => { pending = resolve })
      if (denied) throw new Error('权限已撤销')
      return { directory, permissions, revision: 1 }
    },
  })
  const grant = service.open({ name: 'Developer', groupId: 'room', memberId: 'owner', requesterName: 'Owner' })
  return { service, grant, directory, outside, calls, deny: () => { denied = true }, wait: () => { pending = () => {} }, allow: () => pending?.() }
}

test('项目工具逐项授权，创建不能覆盖、编辑不能冒充创建，删除不递归', async () => {
  const f = fixture()
  await f.service.call(f.grant.connection.token, 'create_file', { path: 'hello.txt', content: 'first' })
  expect(readFileSync(join(f.directory, 'hello.txt'), 'utf8')).toBe('first')
  await expect(f.service.call(f.grant.connection.token, 'create_file', { path: 'hello.txt', content: 'overwrite' })).rejects.toThrow()
  await expect(f.service.call(f.grant.connection.token, 'edit_file', { path: 'missing.txt', content: 'new' })).rejects.toThrow()
  await f.service.call(f.grant.connection.token, 'edit_file', { path: 'hello.txt', content: 'second' })
  expect(await f.service.call(f.grant.connection.token, 'read_file', { path: 'hello.txt' })).toContain('second')
  await f.service.call(f.grant.connection.token, 'delete_file', { path: 'hello.txt' })
  expect(existsSync(join(f.directory, 'hello.txt'))).toBe(false)
  expect(f.calls).toEqual(['create', 'create', 'edit', 'edit', 'read', 'delete'])
})

test('绝对路径、父级穿越和符号链接不可通过受控工具读取或修改', async () => {
  const f = fixture()
  writeFileSync(join(f.outside, 'private.txt'), 'secret')
  symlinkSync(f.outside, join(f.directory, 'escape'))
  for (const path of [join(f.outside, 'private.txt'), '../private.txt', 'escape/private.txt']) {
    await expect(f.service.call(f.grant.connection.token, 'read_file', { path })).rejects.toThrow()
    await expect(f.service.call(f.grant.connection.token, 'create_file', { path, content: 'bad' })).rejects.toThrow()
  }
  expect(readFileSync(join(f.outside, 'private.txt'), 'utf8')).toBe('secret')
})

test('关闭或撤销回合授权后不能执行，等待确认时关闭也不会落盘', async () => {
  const f = fixture()
  f.wait()
  const operation = f.service.call(f.grant.connection.token, 'create_file', { path: 'later.txt', content: 'no' })
  await Promise.resolve()
  f.grant.close()
  f.allow()
  await expect(operation).rejects.toThrow()
  expect(existsSync(join(f.directory, 'later.txt'))).toBe(false)
  await expect(f.service.call(f.grant.connection.token, 'read_file', { path: 'later.txt' })).rejects.toThrow()
  const another = f.service.open({ name: 'Developer', groupId: 'room', memberId: 'owner', requesterName: 'Owner' })
  f.service.revoke('Developer')
  await expect(f.service.call(another.connection.token, 'list_files', {})).rejects.toThrow()
})

test('每次调用重新检查权限，未知工具和其他回合不能访问', async () => {
  const f = fixture()
  await expect(f.service.call('wrong-token', 'list_files', {})).rejects.toThrow()
  await expect(f.service.call(f.grant.connection.token, 'unrestricted_shell', {})).rejects.toThrow()
  await f.service.call(f.grant.connection.token, 'create_file', { path: 'one.txt', content: 'one' })
  f.deny()
  await expect(f.service.call(f.grant.connection.token, 'edit_file', { path: 'one.txt', content: 'two' })).rejects.toThrow('撤销')
  expect(readFileSync(join(f.directory, 'one.txt'), 'utf8')).toBe('one')
})

test('导出聊天文件保留二进制字节，并受读取权限和真实路径边界约束', async () => {
  const f = fixture()
  const bytes = Buffer.from([0, 255, 23, 75, 0, 15])
  writeFileSync(join(f.directory, 'result.bin'), bytes)
  const output = JSON.parse(await f.service.call(f.grant.connection.token, 'export_file', { path: 'result.bin' }))
  expect(Buffer.from(output.data, 'base64')).toEqual(bytes)
  expect(output.name).toBe('result.bin')
  expect(f.calls).toEqual(['read'])
  writeFileSync(join(f.outside, 'secret.bin'), bytes)
  symlinkSync(f.outside, join(f.directory, 'escape'))
  linkSync(join(f.outside, 'secret.bin'), join(f.directory, 'hard.bin'))
  for (const path of ['../secret.bin', 'escape/secret.bin', 'hard.bin']) await expect(f.service.call(f.grant.connection.token, 'export_file', { path })).rejects.toThrow()
  f.deny()
  await expect(f.service.call(f.grant.connection.token, 'export_file', { path: 'result.bin' })).rejects.toThrow('撤销')
})
