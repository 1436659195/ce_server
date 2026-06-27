import { createRelayServer } from './server'
import { Hub } from './hub'

// 端口:--port=NNNN 或 RELAY_PORT 环境变量,默认 8700
const portArg = process.argv.find((a) => a.startsWith('--port='))
const port = portArg
  ? Number(portArg.split('=')[1])
  : Number(process.env.RELAY_PORT ?? 8700)

const tlsCert = process.argv.find((a) => a.startsWith('--tls-cert='))?.split('=')[1]
const tlsKey = process.argv.find((a) => a.startsWith('--tls-key='))?.split('=')[1]

const hub = new Hub()
const { server, close } = createRelayServer(
  hub,
  tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : undefined
)
server.listen(port, () => {
  console.log(`[relay] listening on :${port}${tlsCert ? ' (wss/TLS)' : ' (ws)'}`)
})

// 优雅退出
process.on('SIGINT', () => {
  close().then(() => process.exit(0))
})
