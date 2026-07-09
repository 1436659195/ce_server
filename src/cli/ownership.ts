/**
 * 终端占用裁决:先到先得。纯函数 → 可单测(独立文件,因 main.ts 顶层跑 main() 无法被测试 import)。
 *
 * 规则:
 *   - 终端空闲 → 记占用者为 owner,返回 ok:true。
 *   - 同一 phone 重复 acquire(重连 / 重复 attach)→ ok:true(幂等,不动 owner)。
 *   - 别的 phone 已占 → ok:false + occupiedBy(调用方据此回 RPCResp 错误或静默丢)。
 */
export type AcquireResult = { ok: true } | { ok: false; occupiedBy: string }

export function tryAcquire(
  owner: Map<string, string>,
  name: string,
  phoneId: string
): AcquireResult {
  const cur = owner.get(name)
  if (!cur) {
    owner.set(name, phoneId)
    return { ok: true }
  }
  if (cur === phoneId) return { ok: true } // 自己已占:幂等
  return { ok: false, occupiedBy: cur } // 别人占:先到先得
}
