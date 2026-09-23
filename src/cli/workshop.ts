/**
 * 插件工坊安装器(工坊自成服务)—— ce 从中继 /workshop/* 提货,自装自验。
 *
 * 分工:手机 APK 与 ce 二进制都【不携带】脚手架知识件(造件技能/打包脚本/插件 SDK);
 * 中继只做静态分发(scaffold.tgz + 其 sha256 + 货架 index.json)。本模块负责
 * 「环境检测 → 提货 → 验签 → 解包 → npm → 自验 → 写 marker」全链,两个入口共用:
 *   - CLI:`ce --workshop=<目录>`(手机经隧道触发同一命令;relay 取 config/--relay)
 *   - 控制台:菜单 [o] 工坊(交互选目录)
 *
 * 幂等:tar 解包按路径覆盖,marker 最后写 = 提交点;任何一步失败重跑即可,无半截状态。
 * 版本即内容:marker 记集装箱 sha256 摘要,下次「远端摘要 vs 本机 marker」一致且三件套在
 * → 免重装;不一致(打包脚本变了/三件套被删)→ 幂等重装。无独立版本号体系,内容寻址自洽。
 *
 * 信任模型与自更新(doUpdate)一致:中继是用户自己部署的基础设施(与 install.sh | sh 同级
 * 信任);sha256 校验防传输损坏/篡改。tar 解包不做路径白名单 —— 集装箱由 ce-platform 打包
 * 脚本受控产出,打包物路径越界属打包脚本的红线(在产出侧测),安装侧不重复设防。
 *
 * 三件套契约(与 ce-platform 手机端核验同源):.ce-workshop-ok(marker)/ node_modules /
 * .claude/skills/plugin-workshop。改集装箱布局必须同步本文件与手机端核验。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { detectServers, isAlive } from './jupyter-detect'

/** CLI 交互未指定目录时的缺省工坊根(用户家目录下,无机器假设)。 */
export function defaultWorkshopRoot(home: string): string {
  return join(home, 'ce-workshop')
}

/** 完成标记(内容 = JSON {v: 集装箱 sha256, at: ISO 时间};三件套之一,最后写 = 提交点)。 */
export const WORKSHOP_OK_MARKER = '.ce-workshop-ok'

/** 造件技能目录(集装箱必含;三件套核验项)。 */
const SKILL_DIR = '.claude/skills/plugin-workshop'

/** 集装箱下载临时文件名(解包成功即删)。 */
const SCAFFOLD_TMP = '.ce-scaffold.tgz.tmp'

export type WorkshopStatus = 'installed' | 'up-to-date'

export interface WorkshopResult {
  status: WorkshopStatus
  /** 本次比对/安装的集装箱 sha256 摘要(十六进制)。 */
  digest: string
}

export interface WorkshopDeps {
  /** 缺省全局 fetch;测试注入假源。 */
  fetchFn?: typeof fetch
  /**
   * 在 root 跑 `npm install`(缺省真 spawn;测试注入记录器跳过真实网络)。
   * 抛错 = 依赖没装上,调用方不写 marker。
   */
  runNpm?: (root: string, log: (line: string) => void) => Promise<void>
  /** npm 可用性检测(缺省探测 npm --version;测试注入模拟缺失/可用)。 */
  ensureNpm?: (log: (line: string) => void) => Promise<void>
  now?: () => Date
}

export interface InstallWorkshopArgs {
  /** 中继 HTTP 基址(ws 地址把 ws→http 即得,与自更新同法)。 */
  relayHttp: string
  /** 工坊根(绝对路径;不存在自动创建)。 */
  root: string
  log?: (line: string) => void
}

/** 读 marker;不存在/损坏 → null(损坏视为未装,重走安装)。 */
export function readMarker(root: string): { v: string; at?: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, WORKSHOP_OK_MARKER), 'utf8')) as { v?: string; at?: string }
    return typeof raw.v === 'string' && raw.v ? { v: raw.v, at: raw.at } : null
  } catch {
    return null
  }
}

/** 三件套核验(本机 fs 直查)。missing 空 = 齐。 */
export function verifyThreePiece(root: string): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (!existsSync(join(root, WORKSHOP_OK_MARKER))) missing.push(`完成标记 ${WORKSHOP_OK_MARKER}`)
  if (!existsSync(join(root, 'node_modules'))) missing.push('依赖目录 node_modules')
  if (!existsSync(join(root, SKILL_DIR))) missing.push(`造件技能 ${SKILL_DIR}`)
  return { ok: missing.length === 0, missing }
}

/** 内容件核验(marker 之外的两件;安装后自验用 —— marker 是自验通过才写的提交点,不能自证)。 */
function verifyContent(root: string): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (!existsSync(join(root, 'node_modules'))) missing.push('依赖目录 node_modules')
  if (!existsSync(join(root, SKILL_DIR))) missing.push(`造件技能 ${SKILL_DIR}`)
  return { ok: missing.length === 0, missing }
}

/** npm 缺失时的安装指引(与 ensureJupyter 的「指导安装」同风格:可行动、分平台)。 */
function npmGuidance(): string {
  if (process.platform === 'win32') {
    return '[ce] 未检测到 npm(需要 Node.js)。请先安装:\n' +
      '     winget install OpenJS.NodeJS.LTS\n' +
      '     或到 https://nodejs.org 下载 LTS(装完【重新打开】终端再试)'
  }
  return '[ce] 未检测到 npm(需要 Node.js)。请先安装:\n' +
    '     nvm(推荐)或系统包管理器:apt/dnf install nodejs npm\n' +
    '     或到 https://nodejs.org 下载 LTS(装完重开终端再试)'
}

/** 探测 npm --version(10s 超时;win 走 shell 解析 npm.cmd)。不可用 → 抛带指引的错误。 */
export async function ensureNpm(log: (line: string) => void): Promise<void> {
  const win = process.platform === 'win32'
  const child = spawn('npm', ['--version'], { shell: win, stdio: ['ignore', 'pipe', 'pipe'] })
  const verdict = await new Promise<string | null>((res) => {
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* */ } res(null) }, 10_000)
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', () => { clearTimeout(timer); res(null) })
    child.on('close', (code) => { clearTimeout(timer); res(code === 0 && out.trim() ? out.trim() : null) })
  })
  if (!verdict) throw new Error(npmGuidance())
  log(`[ce:workshop] npm ${verdict} 就绪`)
}

/** spawn 跑命令并收集合并输出;exit 非零 → 抛(带输出尾部,排障可见)。 */
async function runCollect(cmd: string, args: string[], opts: { cwd?: string; shell?: boolean; timeoutMs?: number }): Promise<string> {
  const child = spawn(cmd, args, { cwd: opts.cwd, shell: opts.shell ?? false, stdio: ['ignore', 'pipe', 'pipe'] })
  return await new Promise<string>((res, rej) => {
    let buf = ''
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill() } catch { /* */ } rej(new Error(`${cmd} 超时(${Math.round(opts.timeoutMs! / 1000)}s)`)) }, opts.timeoutMs) : null
    child.stdout.on('data', (d: Buffer) => { buf += d.toString() })
    child.stderr.on('data', (d: Buffer) => { buf += d.toString() })
    child.on('error', (e) => { if (timer) clearTimeout(timer); rej(e) })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) res(buf)
      else {
        const tail = buf.trim().split('\n').slice(-15).join('\n')
        rej(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}\n${tail}`))
      }
    })
  })
}

/**
 * 安装/更新工坊(幂等,可安全重跑)。
 *
 * 流程:npm 就绪 → 拉远端摘要 → marker 比对(一致且三件套在 → up-to-date)→ 拉集装箱 →
 * sha256 验签 → tar 解包进 root → npm install → 三件套自验 → 写 marker(提交点)。
 */
export async function installWorkshop(args: InstallWorkshopArgs, deps: WorkshopDeps = {}): Promise<WorkshopResult> {
  const log = args.log ?? ((line: string): void => { console.log(line) })
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? ((): Date => new Date())
  const ensureNpmFn = deps.ensureNpm ?? ensureNpm
  const root = resolve(args.root)

  // ── ① 环境检测:npm 就绪(ce 自身能跑不代表被控机有 node;npm 是工坊的物理底线)──
  await ensureNpmFn(log)

  // ── ② 远端摘要(内容寻址的「最新版本标识」)──
  const digestUrl = `${args.relayHttp}/workshop/scaffold.tgz.sha256`
  const digestRes = await fetchFn(digestUrl)
  if (!digestRes.ok) throw new Error(`中继未上架工坊集装箱(${digestUrl} → ${digestRes.status});请在 ce-platform 打包上传 scaffold.tgz`)
  const digest = (await digestRes.text()).trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('远端摘要格式非法(scaffold.tgz.sha256 应为 64 位十六进制)')

  // ── ③ marker 比对:一致且三件套在 → 免重装(三件套核验防「marker 在但依赖被删」)──
  const marker = readMarker(root)
  if (marker && marker.v === digest && verifyThreePiece(root).ok) {
    log(`[ce:workshop] 工坊已是最新(集装箱 ${digest.slice(0, 12)}…),跳过重装`)
    return { status: 'up-to-date', digest }
  }
  if (marker && marker.v !== digest) log(`[ce:workshop] 本机集装箱 ${marker.v.slice(0, 12)}… ≠ 远端 ${digest.slice(0, 12)}…,更新…`)
  else log('[ce:workshop] 未安装/不完整,开始安装…')

  // ── ④ 拉集装箱 + 验签(损坏/篡改在此拦下,老安装原样不动)──
  const tgzUrl = `${args.relayHttp}/workshop/scaffold.tgz`
  const tgzRes = await fetchFn(tgzUrl)
  if (!tgzRes.ok) throw new Error(`拉取集装箱失败(${tgzUrl} → ${tgzRes.status})`)
  const bytes = new Uint8Array(await tgzRes.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== digest) throw new Error(`集装箱 sha256 不符(远端声明 ${digest.slice(0, 12)}…,实收 ${actual.slice(0, 12)}…),已中止,老安装原样保留`)

  // ── ⑤ 落盘 + 解包(mkdir -p root;tar 覆盖同路径 = 幂等;成功后删临时文件)──
  mkdirSync(root, { recursive: true })
  const tmp = join(root, SCAFFOLD_TMP)
  writeFileSync(tmp, bytes)
  const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar'
  try {
    await runCollect(tarBin, ['-xzf', tmp, '-C', root], { timeoutMs: 120_000 })
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* 删不掉不致命 */ }
  }

  // ── ⑥ 依赖安装(集装箱 package.json:esbuild/react 等;失败 → 抛,marker 不写)──
  log('[ce:workshop] npm install 中(esbuild/react 等,首次几分钟)…')
  const runNpmFn = deps.runNpm ?? ((r: string, lg: (line: string) => void): Promise<void> =>
    runCollect('npm', ['install', '--no-audit', '--no-fund'], { cwd: r, shell: process.platform === 'win32', timeoutMs: 20 * 60_000 }).then((out) => {
      const tail = out.trim().split('\n').slice(-3).join('\n')
      if (tail) lg(`[ce:workshop] npm:${tail}`)
    }))
  await runNpmFn(root, log)

  // ── ⑦ 内容件自验(node 亲自查,不信转述)→ ⑧ 写 marker(提交点)──
  const piece = verifyContent(root)
  if (!piece.ok) throw new Error(`安装后三件套不齐:${piece.missing.join('、')}(npm 是否真的装上了?)`)
  writeFileSync(join(root, WORKSHOP_OK_MARKER), JSON.stringify({ v: digest, at: now().toISOString() }))
  log(`[ce:workshop] 工坊就绪:${root}(集装箱 ${digest.slice(0, 12)}…)`)
  return { status: 'installed', digest }
}

/** 目录存在且是文件夹(防呆:工坊根不能架在幻觉目录/文件上)。 */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** resolveWorkshopDir 的可注入探测面(测试喂假 jupyter/假 fs)。 */
export interface ResolveDirDeps {
  detectServersFn?: typeof detectServers
  isAliveFn?: typeof isAlive
  isDirFn?: (p: string) => boolean
}

/**
 * 解析工坊根(OS 绝对目录)—— 路径语义收口(J 视角 ↔ OS 视角)。
 *
 * 同一路径字符串在两个世界各有所指:手机目录选择器/文件栏展示的是 **jupyter 视角**
 * (相对 root_dir、去前缀),`--workshop=` 落盘要用 **OS 绝对路径**。ce 是唯一同时
 * 认识两个世界的组件(它就跑在 jupyter 旁边)→ 换算收口在这里;与手机端核验/货架的
 * 读径候选(jupyterPathCandidates)同 rationale,读侧写侧对称。
 *
 * 规则:
 *  ① 原样(OS 绝对)存在 → 用它(显式 OS 路径是用户明确意愿);
 *  ② 否则换算到 jupyter 视角(root_dir + 路径):存在 → 用;不存在 → 也归一到它
 *     (新建必须落在手机文件栏看得见的世界,否则核验/货架永远对不上);
 *  ③ 无存活 jupyter(手机侧一切读写都依赖它)→ 退回原样。
 */
export async function resolveWorkshopDir(raw: string, deps: ResolveDirDeps = {}): Promise<string> {
  const isDirFn = deps.isDirFn ?? isDir
  const direct = resolve(raw)
  if (isDirFn(direct)) return direct
  try {
    const servers = await (deps.detectServersFn ?? detectServers)()
    for (const s of servers) {
      if (!(await (deps.isAliveFn ?? isAlive)(s.url, s.token))) continue
      // 活着的 jupyter 即本机「手机可见世界」的根:存在与否都归一到它下面(新建同理)
      return join(s.root, direct.replace(/^\/+/, ''))
    }
  } catch {
    /* 探测失败(jupyter 未装/未起)→ 退回原样 */
  }
  return direct
}
