import { test, expect } from 'bun:test'
import { createRelayServer } from '../src/relay/server'
import { Hub } from '../src/relay/hub'
import { join } from 'node:path'

/** 起一个随机端口 server,等 listen 就绪后返回端口。 */
function listenPort(server: any): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port))
  })
}

test('/lan.py 仍返回纯静态脚本(ce 下载已剥离,局域网直连模式保留)', async () => {
  const hub = new Hub()
  const lanPyPath = join(import.meta.dir, '..', 'scripts', 'lan.py')
  const { server, close } = createRelayServer(hub, { lanPyPath })

  const port = await listenPort(server)
  try {
    const resp = await fetch(`http://localhost:${port}/lan.py`)
    const body = await resp.text()

    expect(resp.ok).toBe(true)
    expect(body).toContain('def main')
    expect(resp.headers.get('content-type')).toBe('text/x-python; charset=utf-8')
  } finally {
    await close()
  }
})

test('ce 下载已从中继剥离:/install.sh、/install.ps1、/dl/ce-linux-x64 一律 404', async () => {
  const hub = new Hub()
  const { server, close } = createRelayServer(hub)

  const port = await listenPort(server)
  try {
    const r1 = await fetch(`http://localhost:${port}/install.sh`)
    expect(r1.status).toBe(404)
    const r2 = await fetch(`http://localhost:${port}/install.ps1`)
    expect(r2.status).toBe(404)
    const r3 = await fetch(`http://localhost:${port}/dl/ce-linux-x64`)
    expect(r3.status).toBe(404)
    const r4 = await fetch(`http://localhost:${port}/dl/sha256.txt`)
    expect(r4.status).toBe(404)
  } finally {
    await close()
  }
})
