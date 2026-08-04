/**
 * 二维码渲染 —— 纯函数,daemon 的 printQr 与控制台的 [c] 视图共用同一份渲染。
 *
 * 半块字符紧凑渲染:2 个 module 行合并成 1 行、每个 module 占 1 个字符
 * (比 qrcode-terminal 的 ANSI「2 空格/module」小一半多,终端里更紧凑)。
 */
import qrcode from 'qrcode'

/**
 * 把连接码 payload 渲染成多行 ANSI 字符串(不含尾随提示)。渲染失败抛错,调用方自行 try/catch 降级。
 * payload 形如 printQr 里的 JSON:{ r, s, k, t, n, p }。
 */
export function renderQr(payload: string): string {
  const qr = qrcode.create(payload)
  const size = qr.modules.size
  let out = ''
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x++) {
      const top = qr.modules.get(x, y)
      const bot = y + 1 < size && qr.modules.get(x, y + 1)
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
    }
    out += line + '\n'
  }
  return out
}
