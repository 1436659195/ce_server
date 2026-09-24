/**
 * 终端注册表:实例指纹 + 归属状态,持久化(~/.ce/terminal-registry.json)。
 * 独立文件可单测(main.ts 顶层跑 main() 无法被测试 import),仿 managed-terms.ts 模式。
 *
 * 解决两个「Jupyter 只有数字终端名」引出的问题:
 *  1. **指纹**:数字名会被复用(杀 5 建 5 还是 "5",Jupyter 重启后更是从头计数)。
 *     ce 给每个终端实例发 uuid,手机的重命名/类型持久化绑定到实例而非编号 —— 复用编号
 *     的「新 5」不会再继承「旧 5」的名字。
 *  2. **归属**:多台手机连同一被控机时,终端分两态 ——
 *       游离态:从未被任何手机接管 → 任何人可接管;
 *       归属态:已被某手机接管 → 只有属主能用;属主杀 app 归属仍在(磁盘态),
 *               未「释放」(软移除)前别人接管被拒。
 *
 * 记录生命周期:
 *   - 出生/收养:observe() 发现 live 列表里的新名字 → 分配 finger(游离态);
 *     createTerminal 成功 → assign(创建者即属主)。
 *   - 归属变更:接管成功 setOwner;软移除 releaseOwner(finger 保留 —— 终端还活着,
 *     属主再接管可凭 finger 找回改名);硬删 remove;解绑手机 releaseAllOf。
 *   - 死亡:observe() 发现 registry 有、live 列表无 → 整条记录删除(finger 与归属一起消失
 *     —— 编号被新终端复用时天然拿到新身份),死亡名单返回给调用方(推 termGone 用)。
 *
 * 关键语义:**死亡判定 = 成功拉取的 live 列表缺席**。Jupyter 拉取失败 ≠ 全部死亡
 * (与 managed-terms 的 prune 同约定),调用方必须在 try/catch 里区分。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/** 单条终端记录:实例身份 + 可选属主。 */
export interface TermRecord {
  /** 实例指纹:出生/收养时分配的 uuid,Jupyter 侧无此概念,纯 ce 本地身份。 */
  finger: string
  /** 归属态属主(undefined = 游离态):手机 id + 配对时的显示名(name 必须落盘 ——
   *  phoneKeys 是内存态,relay 重连即清,显示名要活过重启)。 */
  owner?: { id: string; name: string }
}

/** 归属记录的属主(id + 显示名)。 */
export type TermOwner = NonNullable<TermRecord['owner']>

export class TermRegistry {
  private map = new Map<string, TermRecord>()

  constructor(private readonly path: string) {
    try {
      const obj = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (obj && typeof obj === 'object') {
        for (const [name, rec] of Object.entries(obj as Record<string, unknown>)) {
          if (rec && typeof rec === 'object' && typeof (rec as TermRecord).finger === 'string') {
            const r = rec as TermRecord
            // 防御:owner 形状不对 → 丢弃 owner 保 finger(指纹是身份底线,归属可重建)
            this.map.set(name, {
              finger: r.finger,
              owner:
                r.owner && typeof r.owner.id === 'string' && typeof r.owner.name === 'string'
                  ? r.owner
                  : undefined,
            })
          }
        }
      }
    } catch {
      /* 无文件/损坏 → 空表 */
    }
  }

  fingerOf(name: string): string | undefined {
    return this.map.get(name)?.finger
  }

  ownerOf(name: string): TermOwner | undefined {
    return this.map.get(name)?.owner
  }

  /**
   * 对账:拿「成功拉到的 live 名单」校准 registry。返回**本次死亡的名单**(调用方推 termGone)。
   *  - live 里 registry 没有的名字 → 分配新 finger(出生或收养,游离态);
   *  - registry 里 live 没有的名字 → 整条删除(死亡),进返回名单。
   * 只在拉取成功时调用(失败时调用会把 Jupyter 不可达误判为全部死亡)。
   */
  observe(liveNames: Iterable<string>): string[] {
    const live = new Set(liveNames)
    const died: string[] = []
    for (const name of this.map.keys()) {
      if (!live.has(name)) {
        this.map.delete(name)
        died.push(name)
      }
    }
    let changed = died.length > 0
    for (const name of live) {
      if (!this.map.has(name)) {
        this.map.set(name, { finger: randomUUID() })
        changed = true
      }
    }
    if (changed) this.save()
    return died
  }

  /** 新建终端:分配 finger 并返回(创建者随即将 owner 设为自己)。 */
  assign(name: string): string {
    const rec: TermRecord = { finger: randomUUID() }
    this.map.set(name, rec)
    this.save()
    return rec.finger
  }

  /** 归属:接管/创建成功时记属主(游离 → 归属态;已是同属主 → 幂等)。 */
  setOwner(name: string, owner: TermOwner): void {
    const rec = this.map.get(name)
    if (!rec) return // 不在册 = 不在 live 列表,不凭空造记录(下次 observe 会处理)
    if (rec.owner?.id === owner.id) return
    rec.owner = owner
    this.save()
  }

  /** 释放(软移除):归属 → 游离;finger 保留(终端还活着,凭 finger 找回改名)。 */
  releaseOwner(name: string): void {
    const rec = this.map.get(name)
    if (!rec?.owner) return
    delete rec.owner
    this.save()
  }

  /** 释放某手机的全部归属(解绑/移除白名单时;返回被释放的终端名,日志用)。 */
  releaseAllOf(phoneId: string): string[] {
    const freed: string[] = []
    for (const [name, rec] of this.map) {
      if (rec.owner?.id === phoneId) {
        delete rec.owner
        freed.push(name)
      }
    }
    if (freed.length > 0) this.save()
    return freed
  }

  /** 硬删(关闭终端):整条移除。 */
  remove(name: string): void {
    if (!this.map.delete(name)) return
    this.save()
  }

  private save(): void {
    try {
      writeFileSync(
        this.path,
        JSON.stringify(Object.fromEntries(this.map), null, 0),
      )
    } catch {
      /* 写失败 → 忽略(本次内存有效,下次变更再试) */
    }
  }
}

/**
 * 接管门禁(纯函数,可单测):一条 resize/stdin 想接上某终端时的裁决。
 *  - 别人的归属终端 → denied(附属主显示名,手机回 attachDenied 提示「X 正在使用」);
 *  - 手机带的指纹与在册不符 → gone(编号被复用:接的是「同名不同实例」,原实例已死);
 *  - 名字不在册 → unknown(可能只是 observe 陈旧 —— 终端刚在 PC 端建;调用方刷新
 *    observe 后重判,仍不在册 = 真不活 → gone);
 *  - 其余(游离 / 自己的 / 旧手机不带指纹)→ ok。
 */
export type AttachGate =
  | { verdict: 'ok' }
  | { verdict: 'denied'; occupiedBy: string }
  | { verdict: 'gone' }
  | { verdict: 'unknown' }

export function gateAttach(input: {
  owner?: TermOwner
  /** 在册指纹(undefined = 名字不在 live 注册表) */
  finger?: string
  /** 手机自称的指纹(旧手机不带 = undefined → 跳过指纹校验,向后兼容) */
  presentedFinger?: string
  phoneId: string
}): AttachGate {
  if (input.owner && input.owner.id !== input.phoneId) {
    return { verdict: 'denied', occupiedBy: input.owner.name }
  }
  if (input.presentedFinger && input.finger && input.presentedFinger !== input.finger) {
    return { verdict: 'gone' }
  }
  if (!input.finger) return { verdict: 'unknown' }
  return { verdict: 'ok' }
}
