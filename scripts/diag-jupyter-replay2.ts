import WebSocket from 'ws'
const BASE = 'http://127.0.0.1:8888', TOKEN = '66668888!?', WS = BASE.replace(/^http/, 'ws')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function createTerm() { const r = await fetch(`${BASE}/api/terminals`, { method: 'POST', headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' }); return (await r.json()).name as string }
function connect(name: string) { return new WebSocket(`${WS}/terminals/websocket/${name}?token=${TOKEN}`) }
function collect(ws: WebSocket, ms: number) { return new Promise<string>(resolve => { let out = ''; ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m[0] === 'stdout' || m[0] === 'stderr') out += m[1] } catch {} }); setTimeout(() => { ws.close(); resolve(out) }, ms) }) }

async function main() {
  const name = await createTerm()
  console.log('测试终端:', name, '(打 3000 行,远超一屏)')
  let ws = connect(name); await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify(['set_size', 24, 80]))
  ws.send(JSON.stringify(['stdin', 'seq 1 3000\r']))   // 3000 行
  await collect(ws, 2000)  // 首连:让它输出完,丢弃
  await sleep(500)
  // 重连,同尺寸,不敲键
  ws = connect(name); await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify(['set_size', 24, 80]))
  const replay = await collect(ws, 3000)
  const nums = replay.match(/^\d+$/gm) || []
  const max = nums.length ? Math.max(...nums.map(Number)) : 0
  const min = nums.length ? Math.min(...nums.map(Number)) : 0
  console.log(`重连回放 ${replay.length} 字节,其中行号 ${nums.length} 个,范围 ${min}~${max}`)
  console.log(nums.length >= 3000 ? '>>> 整段 1~3000 都回来了!terminado 回放完整 scrollback' : `>>> 只回放了部分(约 ${nums.length} 行)—— 可能只回放近期/一屏`)
  await fetch(`${BASE}/api/terminals/${name}`, { method: 'DELETE', headers: { Authorization: `Token ${TOKEN}` } }).catch(() => {})
}
main().catch(e => { console.error(e); process.exit(1) })
