import { test, expect } from 'bun:test'
import { renderInstallScript, createRelayServer } from '../src/relay/server'
import { Hub } from '../src/relay/hub'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** 起一个随机端口 server,等 listen 就绪后返回端口。 */
function listenPort(server: any): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port))
  })
}

test('renderInstallScript: __RELAY_URL__ 替换成 ws://<host>', () => {
  const out = renderInstallScript("relay='__RELAY_URL__'", 'ws://1.2.3.4:8606')
  expect(out).toBe("relay='ws://1.2.3.4:8606'")
  expect(out).not.toContain('__RELAY_URL__')
})

test('多个占位都替换', () => {
  const out = renderInstallScript('a=__RELAY_URL__ b=__RELAY_URL__', 'ws://h:1')
  expect(out).toBe('a=ws://h:1 b=ws://h:1')
})

test('install.sh 模板的 __RELAY_URL__ 注入', () => {
  const template = "RELAY='__RELAY_URL__'\ndownload $RELAY"
  const out = renderInstallScript(template, 'ws://my-relay:8700')
  expect(out).toContain("RELAY='ws://my-relay:8700'")
  expect(out).not.toContain('__RELAY_URL__')
})

test('中继静态路由：/install.sh 返回注入后的脚本', async () => {
  const hub = new Hub()
  const scriptPath = join(process.cwd(), 'scripts/install.sh')
  const { server, close } = createRelayServer(hub, { installShPath: scriptPath })

  const port = await listenPort(server)
  try {
    const resp = await fetch(`http://localhost:${port}/install.sh`)
    const body = await resp.text()

    expect(body).toContain('RELAY=') // __RELAY_URL__ 被注入
    expect(body).not.toContain('__RELAY_URL__') // 占位符被替换
    expect(resp.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  } finally {
    await close()
  }
})

test('中继静态路由：/dl/ce-linux-x64 返回二进制', async () => {
  const hub = new Hub()
  // 写到 tmpdir 而非 dist/,避免覆盖 build 出的真二进制
  const linuxX64Path = join(tmpdir(), `ce-linux-x64-test-${process.pid}`)
  await Bun.write(linuxX64Path, 'fake-linux-x64-binary')

  const { server, close } = createRelayServer(hub, { ceLinuxX64Path: linuxX64Path })

  const port = await listenPort(server)
  try {
    const resp = await fetch(`http://localhost:${port}/dl/ce-linux-x64`)
    const body = await resp.text()

    expect(body).toBe('fake-linux-x64-binary')
    expect(resp.headers.get('content-type')).toBe('application/octet-stream')
  } finally {
    await close()
    rmSync(linuxX64Path, { force: true })
  }
})

test('中继静态路由：/dl/ce-linux-arm64 返回二进制', async () => {
  const hub = new Hub()
  const linuxArm64Path = join(tmpdir(), `ce-linux-arm64-test-${process.pid}`)
  await Bun.write(linuxArm64Path, 'fake-linux-arm64-binary')

  const { server, close } = createRelayServer(hub, { ceLinuxArm64Path: linuxArm64Path })

  const port = await listenPort(server)
  try {
    const resp = await fetch(`http://localhost:${port}/dl/ce-linux-arm64`)
    const body = await resp.text()

    expect(body).toBe('fake-linux-arm64-binary')
    expect(resp.headers.get('content-type')).toBe('application/octet-stream')
  } finally {
    await close()
    rmSync(linuxArm64Path, { force: true })
  }
})
