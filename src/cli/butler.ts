/**
 * ce 端 AI 管家进程管理器。
 *
 * 每台手机一个 cc(claude -p --input-format stream-json),由 ce 以【全 pipe】stdio spawn
 * (无 PTY)——等同 stream-json 长驻所需的环境(spike 证:pipe stdin 下 cc 多轮长驻)。
 * 手机经 ButlerStdin/ButlerOutput 帧与 cc 收发,ce 只做字节桥接 + 进程生命周期。
 *
 * spawn 经 `sh -c 'exec claude …'`:Bun 的 posix_spawn 直接 exec claude 会 ENOEXEC(Bun exec 不了
 * npm 装的 claude 包装脚本,但 sh 能),故走 shell exec。skill 写临时文件、用 --append-system-prompt-file
 * (避免经 shell 时 skill 的换行/引号破坏命令行)。
 *
 * spawn 的 'error'(ENOENT/ENOEXEC/…)一律兜为 finish(-2):ce **绝不因 cc 起不来而崩**(否则手机断连)。
 *
 * 可单测:spawnCc 注入假 cc(读 stdin、回 JSON),验证 writeStdin→onOutput→stop 闭环。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** cc 启动参数(不含 bin;skill 走文件 --append-system-prompt-file,不经命令行 → 无引号问题)。 */
export function ccArgs(skillFile: string): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', 'Read', 'Grep', 'Glob',
    '--add-dir', '/',
    '--append-system-prompt-file', skillFile,
  ]
}

export interface ButlerProc {
  sid: string
  owner: string // 占用手机 phoneId(ButlerOutput 只定向回它)
  proc: ChildProcess
  skillFile: string // 临时 skill 文件(进程结束时删)
}

/**
 * ce 端管家进程表 + 桥接。
 * - start(skill, owner):写 skill 临时文件 + spawn cc(全 pipe),stdout/stderr → onOutput,exit/error → onExit;返回 butlerSid。
 * - writeStdin(sid, bytes):写 cc.stdin(手机 ButlerStdin)。
 * - stop(sid) / stopAllForPhone(phoneId) / stopAll():kill cc + 删 skill 文件。
 */
export class ButlerManager {
  private procs = new Map<string, ButlerProc>()

  constructor(
    private readonly onOutput: (sid: string, owner: string, chunk: Uint8Array) => void,
    private readonly onExit: (sid: string, owner: string, code: number | null) => void,
    /** 注入点:默认 `sh -c 'exec claude …'`(Bun 直接 exec claude 会 ENOEXEC,经 shell 才行);
     *  测试 spawn 假 cc。全 pipe stdio。 */
    private readonly spawnCc: (args: string[]) => ChildProcess = (args) =>
      spawn('sh', ['-c', `exec claude ${args.join(' ')}`], { stdio: ['pipe', 'pipe', 'pipe'] })
  ) {}

  /** spawn 一个 cc,登记并返回 butlerSid。 */
  start(skill: string, owner: string): string {
    const sid = `butler-${randomBytes(4).toString('hex')}`
    const skillFile = join(tmpdir(), `ce-butler-skill-${sid}.txt`)
    writeFileSync(skillFile, skill, 'utf8')
    const proc = this.spawnCc(ccArgs(skillFile))
    let settled = false // 退出/错误只通知一次
    const feed = (buf: Buffer): void => {
      if (buf.length) this.onOutput(sid, owner, new Uint8Array(buf))
    }
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      this.procs.delete(sid)
      try { unlinkSync(skillFile) } catch { /* 已删 */ }
      this.onExit(sid, owner, code)
    }
    // stdout + stderr 都回传:cc 的 stream-json 在 stdout,启动报错在 stderr。
    proc.stdout?.on('data', feed)
    proc.stderr?.on('data', feed)
    // 任何 spawn 错(ENOENT=路径无/ENOEXEC=Bun exec 不了包装脚本/…)→ finish(-2),ce 不崩。
    proc.on('error', (e) => {
      console.warn('[ce:butler] spawn cc 失败(不崩 ce):', (e as Error).message)
      finish(-2)
    })
    proc.on('exit', (code) => finish(code))
    this.procs.set(sid, { sid, owner, proc, skillFile })
    return sid
  }

  /** 写 cc.stdin。无此 sid(已退/不存在)→ 静默 no-op。 */
  writeStdin(sid: string, bytes: Uint8Array): void {
    const stdin = this.procs.get(sid)?.proc.stdin
    if (stdin && !stdin.destroyed) stdin.write(bytes)
  }

  /** kill 某 sid 的 cc(手机 butlerStop / dispose)。 */
  stop(sid: string): void {
    const p = this.procs.get(sid)
    if (!p) return
    this.procs.delete(sid)
    try { unlinkSync(p.skillFile) } catch { /* 已删 */ }
    try { p.proc.kill() } catch { /* 已退 */ }
  }

  /** kill 某手机的所有 cc(phoneLeft / 中继断)。 */
  stopAllForPhone(phoneId: string): void {
    for (const p of this.procs.values()) {
      if (p.owner === phoneId) this.stop(p.sid)
    }
  }

  /** kill 所有 cc(中继断:手机全失联)。 */
  stopAll(): void {
    for (const sid of [...this.procs.keys()]) this.stop(sid)
  }

  /** 某手机是否有活管家。 */
  hasForPhone(phoneId: string): boolean {
    for (const p of this.procs.values()) if (p.owner === phoneId) return true
    return false
  }

  get size(): number {
    return this.procs.size
  }
}
