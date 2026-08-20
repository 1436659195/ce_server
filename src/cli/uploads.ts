/**
 * 大文件分段上传(手机 → ce 直接 node:fs 落盘,不经 Jupyter REST)。
 *
 * 为什么不走 Jupyter PUT(saveFile):①PUT 是整文件覆盖,大 base64 在 RPC 链路上
 *  ~6 份内存拷贝同存(解密/JSON.parse/stringify/转发),几 MB 就能重蹈 readFile OOM
 *  (bridge.ts readFile 2MB 护栏的同一教训);②saveFile 撞 15s fetchTimeout。
 *  ce 直接收段 append 临时文件,内存恒定单段(~512KB),rename 收尾无超时问题。
 *  同 exec 先例:ce 本地能力用 node:* 直做,由 main.ts 分派(不进 JupyterClient 抽象)。
 *
 * 协议(见 src/shared/spec.md §5;phone 侧 FilesStore.upload 是对端):
 *  uploadBegin  {path, totalSize}        → {uploadId}  目标同目录建 .ce-upload-{id}.part
 *  uploadChunk  {uploadId, offset, content(base64)}     校验 offset === 已写字节数后 append
 *  uploadEnd    {uploadId}               校验字节数后 rename 覆盖目标
 *  uploadAbort  {uploadId}               删临时文件(幂等:未知 id 也 ok)
 *
 * 已知残余(接受,注释存档):
 *  - 上传期间 .part 会出现在该目录的 listDir(Jupyter 列 dotfile);正常时序手机 end 后
 *    才刷新看不到,不做 listDir 过滤(不动存量语义)。
 *  - 无断点续传:任一段失败整个重来(新 uploadId);旧临时文件靠 1h 过期清理。
 */

import { randomBytes } from 'node:crypto'
import { open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { RpcRequest, RpcResponse } from './bridge'

/** 临时文件过期阈值:超时未活动的 .part 视为孤儿(begin 时清理)。 */
const MAX_AGE_MS = 60 * 60 * 1000

/** 临时文件名(严格 16 位 hex,防清理误删用户恰如此命名的文件)。 */
const PART_RE = /^\.ce-upload-[0-9a-f]{16}\.part$/

/** 一个进行中的上传会话(Map<uploadId, entry>;ts 随 chunk 刷新)。 */
interface UploadEntry {
  /** 目标绝对路径(root 内,begin 时已校验)。 */
  target: string
  /** 目标同目录的临时文件(同 fs 保证 end 时 rename 原子)。 */
  tmp: string
  /** 手机声明的总字节数(end 时核对)。 */
  totalSize: number
  /** 最近活动时间(chunk 时刷新;过期清理依据)。 */
  ts: number
}

/**
 * 把手机发的 Jupyter 逻辑路径(前导 /,相对 root_dir)解析成 root 内的 OS 绝对路径。
 * 越界(../、绝对路径注入)抛错 —— 直接 fs 写的新增红线:Jupyter REST 时代由 Jupyter
 * 自己兜 root_dir 界,现在 ce 兜。resolve 是词法归一化(不跟 symlink),与 Jupyter
 * PUT 行为同水位,接受。
 */
export function resolveInRoot(root: string, phonePath: string): string {
  const rel = phonePath.replace(/^\/+/, '')
  const abs = resolve(root, rel || '.')
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('路径越界:超出机器工作区')
  return abs
}

/** 分段上传会话管理。root = Jupyter root_dir 的 OS 路径(main.ts 解析后注入)。 */
export class UploadSessions {
  private readonly root: string
  private readonly sessions = new Map<string, UploadEntry>()

  constructor(root: string) {
    this.root = resolve(root) // 归一化(检测来的 root 可能带尾斜杠等)
  }

  /** RPC 入口(与 bridge.handleRpc 同形):按 op 分派,异常 → {ok:false, error}。 */
  async handleRpc(req: RpcRequest): Promise<RpcResponse> {
    try {
      switch (req.op) {
        case 'uploadBegin':
          return { ok: true, data: await this.begin(req) }
        case 'uploadChunk':
          await this.chunk(req)
          return { ok: true }
        case 'uploadEnd':
          await this.end(req)
          return { ok: true }
        case 'uploadAbort':
          await this.abort(req)
          return { ok: true }
        default:
          return { ok: false, error: `未知操作: ${req.op}` }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  private async begin(req: RpcRequest): Promise<{ uploadId: string }> {
    if (typeof req.totalSize !== 'number' || !Number.isFinite(req.totalSize) || req.totalSize < 0) {
      throw new Error('上传大小非法')
    }
    const target = resolveInRoot(this.root, req.path ?? '/')
    const dir = dirname(target)

    // 父目录必须已存在(对齐 saveFile/Jupyter PUT 语义,不 mkdir -p —— 目标位置是用户选的)
    let dirStat
    try {
      dirStat = await stat(dir)
    } catch {
      throw new Error('目标文件夹不存在,请先创建文件夹再上传')
    }
    if (!dirStat.isDirectory()) throw new Error('目标文件夹不存在,请先创建文件夹再上传')

    // 目标已存在且是目录 → 无法覆盖(存在且是文件 → 允许,end 时 rename 覆盖)
    let targetIsDir = false
    try {
      targetIsDir = (await stat(target)).isDirectory()
    } catch {
      /* 目标不存在 = 正常新建;stat 其他异常(权限)后面建临时文件时会暴露 */
    }
    if (targetIsDir) throw new Error('目标已是一个文件夹,无法覆盖')

    await this.sweepExpired(dir)

    const uploadId = randomBytes(8).toString('hex') // 16 位 hex,与 PART_RE 对齐
    const tmp = join(dir, `.ce-upload-${uploadId}.part`)
    // eager 建空文件:chunk 的 offset 校验以 0 为基准
    const fh = await open(tmp, 'w')
    await fh.close()
    this.sessions.set(uploadId, { target, tmp, totalSize: req.totalSize, ts: Date.now() })
    return { uploadId }
  }

  private async chunk(req: RpcRequest): Promise<void> {
    const entry = this.requireEntry(req.uploadId ?? '')
    const offset = req.offset ?? -1
    // 每段 open/close,fd 不跨 RPC 持有(手机断连不漏 fd)
    const fh = await open(entry.tmp, 'a')
    try {
      const size = (await fh.stat()).size
      if (size !== offset) {
        throw new Error(`上传段错位(期望 offset ${size},收到 ${offset}),请重新上传`)
      }
      await fh.write(Buffer.from(req.content ?? '', 'base64')) // 每段独立解码,段长无须 3 倍数
    } finally {
      await fh.close()
    }
    entry.ts = Date.now()
  }

  private async end(req: RpcRequest): Promise<void> {
    const uploadId = req.uploadId ?? ''
    const entry = this.requireEntry(uploadId)
    const got = (await stat(entry.tmp)).size
    if (got !== entry.totalSize) {
      await this.dropEntry(uploadId, entry)
      throw new Error(`上传不完整(已收 ${got}/${entry.totalSize} 字节),请重新上传`)
    }
    await this.commit(entry)
    this.sessions.delete(uploadId)
  }

  /** rename 覆盖:POSIX 原子;Windows 目标已存在抛 EPERM/EEXIST → 删目标重试。 */
  private async commit(entry: UploadEntry): Promise<void> {
    try {
      await rename(entry.tmp, entry.target)
      return
    } catch {
      /* Windows 已存在目标的 rename 走这;POSIX 原子覆盖不会失败到这 */
    }
    try {
      await rm(entry.target, { force: true })
      await rename(entry.tmp, entry.target)
    } catch {
      // 删/重命名失败 = 目标被占用(Windows 常见)或权限;临时文件留着靠 1h 过期清理
      throw new Error('目标文件被占用,无法完成上传(请关闭占用它的程序后重试)')
    }
  }

  private async abort(req: RpcRequest): Promise<void> {
    // 幂等:未知 id 也 ok(手机端 fire-and-forget 清理;chunk/end 对未知 id 报错才是真失败)
    const uploadId = req.uploadId ?? ''
    const entry = this.sessions.get(uploadId)
    if (entry) await this.dropEntry(uploadId, entry)
  }

  /** 删 Map 项 + 尽力删临时文件(吞错:文件可能已被清)。 */
  private async dropEntry(uploadId: string, entry: UploadEntry): Promise<void> {
    this.sessions.delete(uploadId)
    await rm(entry.tmp, { force: true }).catch(() => undefined)
  }

  private requireEntry(uploadId: string): UploadEntry {
    const entry = this.sessions.get(uploadId)
    if (!entry) throw new Error('上传已失效或已过期,请重新上传')
    return entry
  }

  /**
   * 过期清理(begin 时调,只扫目标目录一次 readdir):
   *  ①Map 里超 1h 无活动的会话(断连/取消没走 abort 的);
   *  ②目录里 mtime 超 1h 的孤儿 .part(ce 重启后 Map 丢失,只能按文件名+mtime 认)。
   * 活跃上传不受影响:chunk 持续刷新 ts 与 mtime。
   */
  private async sweepExpired(dir: string): Promise<void> {
    const now = Date.now()
    for (const [id, e] of [...this.sessions]) {
      if (now - e.ts > MAX_AGE_MS) await this.dropEntry(id, e)
    }
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return // 目录不可读:交给调用方建临时文件时暴露
    }
    for (const name of names) {
      if (!PART_RE.test(name)) continue
      const p = join(dir, name)
      try {
        if (now - (await stat(p)).mtimeMs > MAX_AGE_MS) await rm(p, { force: true })
      } catch {
        /* 竞态消失:下一个 begin 再扫 */
      }
    }
  }
}
