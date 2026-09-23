import { test, describe, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { installWorkshop, readMarker, verifyThreePiece, defaultWorkshopRoot, resolveWorkshopDir } from '../src/cli/workshop'

/**
 * 工坊安装器测试:fetch 注入假中继(摘要 + 集装箱),npm 注入记录器,tar 用真命令
 * (fixture 现场打包,测试环境必有 tar)。核心锁:幂等(marker 比对免重装)/ 验签
 * (不符中止且老安装不动)/ 提交点(npm 失败 marker 不写)/ 三件套自验。
 */

/** 打真 tgz:srcTree → fixture.tgz,返回 { bytes, digest }。 */
async function packFixture(srcTree: string): Promise<{ bytes: Uint8Array; digest: string }> {
  const tgz = join(srcTree, '..', 'fixture.tgz')
  const proc = Bun.spawn(['tar', '-czf', tgz, '-C', srcTree, '.'])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error('fixture 打包失败')
  const bytes = new Uint8Array(readFileSync(tgz))
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
}

/** 假中继:GET /workshop/scaffold.tgz.sha256 → digest;/workshop/scaffold.tgz → bytes。 */
function fakeRelay(bytes: Uint8Array, digest: string, opts?: { digestStatus?: number; corrupt?: boolean }): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/workshop/scaffold.tgz.sha256')) {
      const status = opts?.digestStatus ?? 200
      return new Response(status === 200 ? digest : 'nope', { status })
    }
    if (u.endsWith('/workshop/scaffold.tgz')) {
      if (opts?.corrupt) {
        const bad = new Uint8Array(bytes); bad[0] = bad[0]! ^ 0xff
        return new Response(bad.buffer as ArrayBuffer, { status: 200 })
      }
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

/** 标准集装箱内容:三件套之二(skills + package.json);node_modules 由「npm」装。 */
function makeScaffoldTree(): string {
  const tree = mkdtempSync(join(tmpdir(), 'ws-src-'))
  mkdirSync(join(tree, '.claude', 'skills', 'plugin-workshop'), { recursive: true })
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  writeFileSync(join(tree, '.claude', 'skills', 'plugin-workshop', 'SKILL.md'), '# 造件手册\n')
  writeFileSync(join(tree, 'scripts', 'build-plugin.mjs'), '// packer\n')
  writeFileSync(join(tree, 'package.json'), '{"name":"ce-workshop","private":true}')
  return tree
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ws-root-'))
}

const noopLog = (): void => undefined

test('首次安装:解包落盘 + npm 装依赖 + 三件套齐 + marker 记摘要', async () => {
  const tree = makeScaffoldTree()
  const { bytes, digest } = await packFixture(tree)
  const root = tmpRoot()
  const npmCalls: string[] = []
  try {
    const r = await installWorkshop(
      { relayHttp: 'http://relay.test', root, log: noopLog },
      { fetchFn: fakeRelay(bytes, digest), runNpm: async (dir) => { npmCalls.push(dir); mkdirSync(join(dir, 'node_modules'), { recursive: true }) } }
    )
    expect(r.status).toBe('installed')
    expect(r.digest).toBe(digest)
    // 集装箱内容真的落在 root(原相对路径)
    expect(readFileSync(join(root, '.claude', 'skills', 'plugin-workshop', 'SKILL.md'), 'utf8')).toContain('造件手册')
    expect(readFileSync(join(root, 'scripts', 'build-plugin.mjs'), 'utf8')).toContain('packer')
    expect(existsSync(join(root, 'package.json'))).toBe(true)
    // marker = 提交点,记录摘要
    expect(readMarker(root)?.v).toBe(digest)
    expect(verifyThreePiece(root).ok).toBe(true)
    expect(npmCalls).toEqual([root])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(tree, { recursive: true, force: true })
    rmSync(join(tree, '..', 'fixture.tgz'), { force: true })
  }
})

test('幂等跳过:远端摘要 = marker 且三件套在 → up-to-date,npm 不跑', async () => {
  const tree = makeScaffoldTree()
  const { bytes, digest } = await packFixture(tree)
  const root = tmpRoot()
  let npmCalls = 0
  try {
    const deps = {
      fetchFn: fakeRelay(bytes, digest),
      runNpm: async (dir: string) => { npmCalls++; mkdirSync(join(dir, 'node_modules'), { recursive: true }) },
    }
    await installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, deps)
    expect(npmCalls).toBe(1)
    const r2 = await installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, deps)
    expect(r2.status).toBe('up-to-date')
    expect(npmCalls).toBe(1) // 第二次免重装
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(tree, { recursive: true, force: true })
    rmSync(join(tree, '..', 'fixture.tgz'), { force: true })
  }
})

test('版本追平:远端摘要变了 → 幂等重装(marker 更新为新摘要)', async () => {
  const tree = makeScaffoldTree()
  const { bytes, digest } = await packFixture(tree)
  const root = tmpRoot()
  let npmCalls = 0
  try {
    const deps = {
      fetchFn: fakeRelay(bytes, digest),
      runNpm: async (dir: string) => { npmCalls++; mkdirSync(join(dir, 'node_modules'), { recursive: true }) },
    }
    await installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, deps)
    // 换集装箱内容(新摘要)= 打包脚本更新了
    writeFileSync(join(tree, 'scripts', 'build-plugin.mjs'), '// packer v2\n')
    const v2 = await packFixture(tree)
    const r2 = await installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, { ...deps, fetchFn: fakeRelay(v2.bytes, v2.digest) })
    expect(r2.status).toBe('installed')
    expect(r2.digest).toBe(v2.digest)
    expect(npmCalls).toBe(2)
    expect(readFileSync(join(root, 'scripts', 'build-plugin.mjs'), 'utf8')).toContain('v2')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(tree, { recursive: true, force: true })
    rmSync(join(tree, '..', 'fixture.tgz'), { force: true })
  }
})

test('三件套被用户删了(摘要一致)→ 补装而不是误判最新', async () => {
  const tree = makeScaffoldTree()
  const { bytes, digest } = await packFixture(tree)
  const root = tmpRoot()
  let npmCalls = 0
  try {
    const deps = {
      fetchFn: fakeRelay(bytes, digest),
      runNpm: async (dir: string) => { npmCalls++; mkdirSync(join(dir, 'node_modules'), { recursive: true }) },
    }
    await installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, deps)
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    const r2 = await installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, deps)
    expect(r2.status).toBe('installed')
    expect(npmCalls).toBe(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(tree, { recursive: true, force: true })
    rmSync(join(tree, '..', 'fixture.tgz'), { force: true })
  }
})

test('集装箱被篡改(sha256 不符)→ 中止,老安装与 marker 原样不动', async () => {
  const tree = makeScaffoldTree()
  const { bytes, digest } = await packFixture(tree)
  const root = tmpRoot()
  try {
    // 先装一份好的
    await installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, {
      fetchFn: fakeRelay(bytes, digest),
      runNpm: async (dir) => { mkdirSync(join(dir, 'node_modules'), { recursive: true }) },
    })
    // 远端声明了新摘要(触发更新分支)+ 内容被改 → 验签必须拦下(同摘要 + 三件套在会走免重装,
    // 到不了验签,所以这里必须声明新摘要才构成真篡改场景)
    await expect(
      installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, {
        fetchFn: fakeRelay(bytes, 'f'.repeat(64), { corrupt: true }),
        runNpm: async () => undefined,
      })
    ).rejects.toThrow(/sha256 不符/)
    expect(readMarker(root)?.v).toBe(digest) // marker 未动
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(tree, { recursive: true, force: true })
    rmSync(join(tree, '..', 'fixture.tgz'), { force: true })
  }
})

test('npm 失败 → 抛错且 marker 不写(提交点语义,重跑即续)', async () => {
  const tree = makeScaffoldTree()
  const { bytes, digest } = await packFixture(tree)
  const root = tmpRoot()
  try {
    await expect(
      installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, {
        fetchFn: fakeRelay(bytes, digest),
        runNpm: async () => { throw new Error('npm install 退出码 1') },
      })
    ).rejects.toThrow(/npm install/)
    expect(readMarker(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(tree, { recursive: true, force: true })
    rmSync(join(tree, '..', 'fixture.tgz'), { force: true })
  }
})

test('npm 缺失 → 指导安装文案(不下载不落盘)', async () => {
  const tree = makeScaffoldTree()
  const { bytes, digest } = await packFixture(tree)
  const root = tmpRoot()
  try {
    await expect(
      installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, {
        fetchFn: fakeRelay(bytes, digest),
        ensureNpm: async () => { throw new Error('未检测到 npm(需要 Node.js)。请先安装') },
      })
    ).rejects.toThrow(/npm/)
    expect(existsSync(join(root, '.ce-workshop-ok'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(tree, { recursive: true, force: true })
    rmSync(join(tree, '..', 'fixture.tgz'), { force: true })
  }
})

test('中继未上架(sha256 404)→ 明说「未上架」而非模糊报错', async () => {
  const root = tmpRoot()
  const notFound = (async (_u: string | URL | Request) => new Response('not found', { status: 404 })) as unknown as typeof fetch
  try {
    await expect(
      installWorkshop({ relayHttp: 'http://relay.test', root, log: noopLog }, {
        fetchFn: notFound,
        ensureNpm: async () => undefined,
      })
    ).rejects.toThrow(/未上架/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('defaultWorkshopRoot:家目录下 ce-workshop(无机器假设)', () => {
  expect(defaultWorkshopRoot('/home/x')).toBe('/home/x/ce-workshop')
})

describe('resolveWorkshopDir(J 视角 ↔ OS 视角 收口)', () => {
  /** 造一个「jupyter root_dir」临时世界 + 注入探测面。 */
  function makeWorld(opts?: { jupyterRoot?: string; alive?: boolean }) {
    const base = mkdtempSync(join(tmpdir(), 'ws-res-'))
    const jupyterRoot = opts?.jupyterRoot ?? join(base, 'root')
    mkdirSync(jupyterRoot, { recursive: true })
    return {
      base,
      jupyterRoot,
      deps: {
        detectServersFn: (async () => [{ url: 'http://127.0.0.1:8888', token: 't', root: jupyterRoot }]) as never,
        isAliveFn: (async () => opts?.alive ?? true) as never,
      },
    }
  }

  test('① 原样(OS 绝对)存在 → 直接用(jupyter 探测不发生)', async () => {
    const w = makeWorld()
    const dir = mkdirSync(join(w.base, 'os-root', 'ce-workshop'), { recursive: true }) as string
    let probed = false
    const r = await resolveWorkshopDir(dir, {
      ...w.deps,
      detectServersFn: (async () => { probed = true; return [] }) as never,
    })
    expect(r).toBe(dir)
    expect(probed).toBe(false) // 存在即定,不探测
    rmSync(w.base, { recursive: true, force: true })
  })

  test('② 原样不存在 + jupyter 视角存在 → 归一到 root_dir 下(手机看得见的世界)', async () => {
    const w = makeWorld()
    // 原样路径必须是 jupyter 视角形态(/xxx 且 OS 上确定不存在)
    const raw = `/ws-res-no-such-${process.pid}/ce-workshop`
    mkdirSync(join(w.jupyterRoot, `ws-res-no-such-${process.pid}/ce-workshop`), { recursive: true })
    const r = await resolveWorkshopDir(raw, w.deps)
    expect(r).toBe(join(w.jupyterRoot, `ws-res-no-such-${process.pid}/ce-workshop`))
    rmSync(w.base, { recursive: true, force: true })
  })

  test('②′ 两边都不存在 → 也归一到 jupyter 视角(新建落在手机看得见的世界)', async () => {
    const w = makeWorld()
    const r = await resolveWorkshopDir('/fresh/ce-workshop', w.deps)
    expect(r).toBe(join(w.jupyterRoot, 'fresh/ce-workshop'))
    expect(existsSync(r)).toBe(false) // 本函数不建目录(建目录归 installWorkshop)
    rmSync(w.base, { recursive: true, force: true })
  })

  test('③ 无存活 jupyter → 退回原样 OS 路径', async () => {
    const w = makeWorld({ alive: false })
    const r = await resolveWorkshopDir('/fresh/ce-workshop', w.deps)
    expect(r).toBe('/fresh/ce-workshop')
    rmSync(w.base, { recursive: true, force: true })
  })

  test('③′ jupyter 探测抛错(未装/未起)→ 退回原样,不炸', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ws-res-'))
    const r = await resolveWorkshopDir(join(base, 'x'), {
      detectServersFn: (async () => { throw new Error('no jupyter') }) as never,
    })
    expect(r).toBe(join(base, 'x'))
    rmSync(base, { recursive: true, force: true })
  })
})
