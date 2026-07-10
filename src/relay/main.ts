import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRelayServer } from './server'
import { Hub } from './hub'

// 静态下载文件路径(中继以 bun 脚本模式跑,import.meta.url 解析正常;src/relay/ → dist|scripts/)。
const here = fileURLToPath(new URL('.', import.meta.url))

// 端口:--port=NNNN 或 RELAY_PORT 环境变量,默认 8700
const portArg = process.argv.find((a) => a.startsWith('--port='))
const port = portArg
  ? Number(portArg.split('=')[1])
  : Number(process.env.RELAY_PORT ?? 8700)

const tlsCert = process.argv.find((a) => a.startsWith('--tls-cert='))?.split('=')[1]
const tlsKey = process.argv.find((a) => a.startsWith('--tls-key='))?.split('=')[1]

// cid→sid/token 持久映射文件:中继重启后 ce 重连仍复用同一 sid(手机配对码长期有效)。
// --state=<path> 可覆盖,默认 ./relay-state.json。
const statePath =
  process.argv.find((a) => a.startsWith('--state='))?.split('=')[1] ??
  join(process.cwd(), 'relay-state.json')
const hub = new Hub(statePath)
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
})
server.listen(port, () => {
  console.log(`[relay] listening on :${port}${tlsCert ? ' (wss/TLS)' : ' (ws)'}`)
})

// 优雅退出
process.on('SIGINT', () => {
  close().then(() => process.exit(0))
})
