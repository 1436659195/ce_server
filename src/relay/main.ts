import { createRelayServer } from './server'
import { Hub } from './hub'

// 端口:--port=NNNN 或 RELAY_PORT 环境变量,默认 8700
const portArg = process.argv.find((a) => a.startsWith('--port='))
const port = portArg
  ? Number(portArg.split('=')[1])
  : Number(process.env.RELAY_PORT ?? 8700)

const hub = new Hub()
const { server, close } = createRelayServer(hub)
server.listen(port, () => {
  console.log(`[relay] listening on :${port}`)
})

// 优雅退出
process.on('SIGINT', () => {
  close().then(() => process.exit(0))
})
