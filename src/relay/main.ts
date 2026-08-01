import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRelayServer } from './server'
import { Hub, deriveStateKey } from './hub'

// 静态下载文件路径(中继以 bun 脚本模式跑,import.meta.url 解析正常;src/relay/ → dist|scripts/)。
const here = fileURLToPath(new URL('.', import.meta.url))

// 端口:--port=NNNN 或 RELAY_PORT 环境变量,默认 8606
const portArg = process.argv.find((a) => a.startsWith('--port='))
const port = portArg
  ? Number(portArg.split('=')[1])
  : Number(process.env.RELAY_PORT ?? 8606)

const tlsCert = process.argv.find((a) => a.startsWith('--tls-cert='))?.split('=')[1]
const tlsKey = process.argv.find((a) => a.startsWith('--tls-key='))?.split('=')[1]
// 对外中继地址(--public-url 或 RELAY_PUBLIC_URL):install 脚本注入用它,防 Host 头伪造。不配则回退请求 Host。
const publicUrl =
  process.argv.find((a) => a.startsWith('--public-url='))?.split('=')[1] ?? process.env.RELAY_PUBLIC_URL

// cid→sid/token 持久映射文件:中继重启后 ce 重连仍复用同一 sid(手机配对码长期有效)。
// --state=<path> 可覆盖,默认 ./relay-state.json。
const statePath =
  process.argv.find((a) => a.startsWith('--state='))?.split('=')[1] ??
  join(process.cwd(), 'relay-state.json')
// state 加密密钥(RELAY_STATE_KEY):有则 AES-256-GCM 加密落盘 token,无则明文(降级 + 告警)。
const stateKey = process.env.RELAY_STATE_KEY ? deriveStateKey(process.env.RELAY_STATE_KEY) : null
if (!stateKey) {
  console.warn('[relay] ⚠ 未设 RELAY_STATE_KEY,relay-state.json 明文存 token(生产建议设)')
}
const hub = new Hub(statePath, 1000, stateKey)
// --rotate:一次性维护,重置所有 token 后退出(手机需重新扫码)。
if (process.argv.includes('--rotate')) {
  hub.rotateTokens()
  console.log('[relay] 所有 token 已轮换,手机需重新扫码配对')
  process.exit(0)
}
const { server, close } = createRelayServer(hub, {
  cert: tlsCert && tlsKey ? tlsCert : undefined,
  key: tlsCert && tlsKey ? tlsKey : undefined,
  ceExePath: join(here, '..', '..', 'dist', 'ce-windows-x64.exe'),
  installScriptPath: join(here, '..', '..', 'scripts', 'install.ps1'),
  ceLinuxX64Path: join(here, '..', '..', 'dist', 'ce-linux-x64'),
  ceLinuxArm64Path: join(here, '..', '..', 'dist', 'ce-linux-arm64'),
  ceDarwinX64Path: join(here, '..', '..', 'dist', 'ce-darwin-x64'),
  ceDarwinArm64Path: join(here, '..', '..', 'dist', 'ce-darwin-arm64'),
  sha256Path: join(here, '..', '..', 'dist', 'sha256.txt'),
  installShPath: join(here, '..', '..', 'scripts', 'install.sh'),
  lanPyPath: join(here, '..', '..', 'scripts', 'lan.py'),
  publicUrl,
})
server.listen(port, () => {
  console.log(`[relay] listening on :${port}${tlsCert ? ' (wss/TLS)' : ' (ws)'}`)
})

// 优雅退出
process.on('SIGINT', () => {
  close().then(() => process.exit(0))
})

// 兜底①:Promise 漏接(最常见的「小意外带崩全场」源)→ 记日志,不退出,保住在用连接。
process.on('unhandledRejection', (reason) => {
  console.error('[relay] ⚠ unhandledRejection(已兜底,不退出):', reason)
})

// 兜底②:未捕获异常 → 进程状态可能已损坏,记日志后优雅退出,交 systemd 拉起(hub 源头已 try/catch,
// 能到这里属罕见漏网;继续跑有数据错乱风险,故退出而非硬扛)。
process.on('uncaughtException', (err) => {
  console.error('[relay] ✗ uncaughtException(将退出,由 systemd 拉起):', err)
  close().finally(() => process.exit(1))
})
