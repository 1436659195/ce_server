/**
 * managed 终端集持久化(~/.ce/managed-terminals.json)。
 *
 * 背景:terms map(terminalName → terminado WS)是内存态,daemon 一重启即空 → listTerminals
 * 里所有终端 managed=false → 手机杀 app 重开自动恢复只挑 managed → 会话管理看起来「全没了」
 * (终端其实还活在被复用的 Jupyter 里)。把「ce 经手过的终端名」落盘,重启后合并标注,
 * 手机即可自动恢复原有会话(与 jupyter.json 复用配套:Jupyter 不换,终端名才有效)。
 *
 * 生命周期对齐 terms map 语义:create/ensure 时记入;delete(硬删)/detach(软移除)时摘除;
 * terminado WS 意外断开【不】摘(终端在 Jupyter 里多半仍活,下次 attach 懒重开)。
 * cc-* agent 会话不进此文件(agent 进程随 daemon 生灭,重启后无可恢复的实体)。
 *
 * 纯 I/O 无状态依赖 → 独立文件可单测(main.ts 顶层跑 main() 无法被测试 import)。
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** ~/.ce/managed-terminals.json 的读写封装:损坏/缺失按空集处理,写失败静默(仅内存有效)。 */
export class ManagedTerms {
  private set = new Set<string>()

  constructor(private readonly path: string) {
    try {
      const arr = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (Array.isArray(arr)) for (const n of arr) if (typeof n === 'string') this.set.add(n)
    } catch {
      /* 无文件/损坏 → 空集 */
    }
  }

  has(name: string): boolean {
    return this.set.has(name)
  }

  /** 现集合全部名字(快照迭代;listTerminals 合并标注用)。 */
  *values(): IterableIterator<string> {
    yield* this.set
  }

  /** 记入并落盘(已在该终端 → 不重复写)。 */
  add(name: string): void {
    if (this.set.has(name)) return
    this.set.add(name)
    this.save()
  }

  /** 摘除并落盘(不在集合 → no-op)。 */
  remove(name: string): void {
    if (!this.set.delete(name)) return
    this.save()
  }

  /** 摘除所有不在 aliveNames 里的名字(终端真没了:Jupyter 列表已不含它)。
   *  调用点:listTerminals 拿到 Jupyter 现役列表后顺手清理,防文件无限膨胀。 */
  prune(aliveNames: Iterable<string>): void {
    const alive = new Set(aliveNames)
    let changed = false
    for (const n of this.set) {
      if (!alive.has(n)) {
        this.set.delete(n)
        changed = true
      }
    }
    if (changed) this.save()
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify([...this.set], null, 0))
    } catch {
      /* 写失败 → 忽略(本次内存有效,下次变更再试) */
    }
  }
}
