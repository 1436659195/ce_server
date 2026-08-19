import { statSync, readFileSync, writeFileSync } from 'node:fs'

/** ce.log 轮转:超 maxBytes(默认 5MB)截留尾部 1MB(最新部分最有用),防无限增长撑爆磁盘。
 *  Jupyter 访问日志量大,daemon 长期跑会无限 append → 磁盘撑爆。写前/启动时调一次兜底。 */
export function rotateLogIfBig(path: string, maxBytes = 5_000_000): void {
  try {
    if (statSync(path).size > maxBytes) {
      writeFileSync(path, readFileSync(path, 'utf8').slice(-1_000_000))
    }
  } catch {
    /* 文件不存在/读失败 → 不动 */
  }
}
