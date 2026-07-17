import WebSocket from 'ws'
const BASE = 'http://127.0.0.1:8888'
const TOKEN = '66668888!?'
const WS = BASE.replace(/^http/, 'ws')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function createTerm() {
  const r = await fetch(`${BASE}/api/terminals`, { method: 'POST', headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' })
  return (await r.json()).name as string
}
function connect(name: string) { return new WebSocket(`${WS}/terminals/websocket/${name}?token=${TOKEN}`) }
function collect(ws: WebSocket, ms: number) {
  return new Promise<string>(resolve => {
    let out = ''
    ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m[0] === 'stdout' || m[0] === 'stderr') out += m[1] } catch {} })
    setTimeout(() => { ws.close(); resolve(out) }, ms)
  })
}

async function main() {
  const name = await createTerm()
  console.log('测试终端:', name)
  // 首连:resize + 打 marker
  let ws = connect(name)
  await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify(['set_size', 24, 80]))
  ws.send(JSON.stringify(['stdin', 'echo __M1__; seq 1 5; echo __M2__\r']))
  const first = await collect(ws, 2000)
  console.log('【首连输出】(应含 M1/1-5/M2):\n' + first.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd().slice(-200))
  await sleep(500)
  // 重连:只发同尺寸 set_size,不发任何 stdin。看 terminado 会不会把历史回放出来。
  ws = connect(name)
  await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify(['set_size', 24, 80]))
  const replay = await collect(ws, 2500)
  console.log('\n【重连后输出】(同尺寸、不敲键):')
  if (replay.length === 0) console.log('>>> 0 字节 —— Jupyter 没回放任何历史!')
  else console.log('>>> 收到 ' + replay.length + ' 字节:\n' + replay.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd().slice(-300))
  console.log('\n回放里有 M1/M2 吗:', /__M[12]__/.test(replay) ? '有(说明回放了)' : '没有(历史没回来)')
  await fetch(`${BASE}/api/terminals/${name}`, { method: 'DELETE', headers: { Authorization: `Token ${TOKEN}` } }).catch(() => {})
  console.log('测试终端已删')
}
main().catch(e => { console.error(e); process.exit(1) })
