/**
 * ce 端 AI 管家进程管理器。
 *
 * 每台手机一个 cc(claude -p --input-format stream-json),由 ce 以【全 pipe】stdio spawn
 * (无 PTY)——等同 stream-json 长驻所需的环境(spike 证:pipe stdin 下 cc 多轮长驻)。
 * 手机经 ButlerStdin/ButlerOutput 帧与 cc 收发,ce 只做字节桥接 + 进程生命周期。
 *
 * 不经 shell:cc args(含 skill)直传 spawn → 无引号/base64 问题(终端方案走 shell 才需 base64)。
 *
 * 可单测:spawnCc 注入假 cc(读 stdin、回 JSON),验证 writeStdin→onOutput→stop 闭环。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'

/** cc 启动参数(不含 bin 本身;skill 直传 arg)。不带 prompt 参数(cc 从 stdin 读 stream-json 长驻);
 *  不带 --bare(用 OAuth,--bare 强制 API-key 拒 OAuth)。 */
export function ccArgs(skill: string): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', 'Read', 'Grep', 'Glob',
    '--add-dir', '/',
    '--append-system-prompt', skill,
  ]
}

export interface ButlerProc {
  sid: string
  owner: string // 占用手机 phoneId(ButlerOutput 只定向回它)
  proc: ChildProcess
}

/**
 * ce 端管家进程表 + 桥接。
 * - start(skill, owner):spawn cc(全 pipe),stdout/stderr → onOutput,exit → onExit;返回 butlerSid。
 * - writeStdin(sid, bytes):写 cc.stdin(手机 ButlerStdin)。
 * - stop(sid) / stopAllForPhone(phoneId):kill cc(phoneLeft/中继断/手机 butlerStop)。
 */
export class ButlerManager {
  private procs = new Map<string, ButlerProc>()

  constructor(
    /** cc stdout/stderr 有字节 → 回调(main.ts 据此加密发 ButlerOutput 给 owner 手机)。 */
    private readonly onOutput: (sid: string, owner: string, chunk: Uint8Array) => void,
    /** cc 进程退出 → 回调(main.ts 发 butler_exit 通知 owner 手机)。 */
    private readonly onExit: (sid: string, owner: string, code: number | null) => void,
    /** 注入点:生产 spawn claude;测试 spawn 假 cc。默认全 pipe stdio。 */
    private readonly spawnCc: (args: string[]) => ChildProcess = (args) =>
      spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  ) {}

  /** spawn 一个 cc,登记并返回 butlerSid。 */
  start(skill: string, owner: string): string {
    const sid = `butler-${randomBytes(4).toString('hex')}`
    const proc = this.spawnCc(ccArgs(skill))
    const feed = (buf: Buffer): void => {
      if (buf.length) this.onOutput(sid, owner, new Uint8Array(buf))
    }
    // stdout + stderr 都回传:cc 的 stream-json 在 stdout,启动报错/未装 claude 的诊断在 stderr。
    proc.stdout?.on('data', feed)
    proc.stderr?.on('data', feed)
    proc.on('exit', (code) => {
      // 先通知(onExit 内 main.ts 还能据 owner 定向),再清 map
      this.onExit(sid, owner, code)
      this.procs.delete(sid)
    })
    this.procs.set(sid, { sid, owner, proc })
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
    this.procs.delete(sid) // 先删:onExit 回调再触发时已是 no-op
    try {
      p.proc.kill()
    } catch {
      /* 已退 */
    }
  }

  /** kill 某手机的所有 cc(phoneLeft / 中继断:该 phone 的管家都失效)。 */
  stopAllForPhone(phoneId: string): void {
    for (const p of this.procs.values()) {
      if (p.owner === phoneId) this.stop(p.sid)
    }
  }

  /** kill 所有 cc(中继断:手机全失联,ce 上 cc 无意义)。 */
  stopAll(): void {
    for (const sid of [...this.procs.keys()]) this.stop(sid)
  }

  /** 某手机是否有活管家(诊断/调试用)。 */
  hasForPhone(phoneId: string): boolean {
    for (const p of this.procs.values()) if (p.owner === phoneId) return true
    return false
  }

  get size(): number {
    return this.procs.size
  }
}
