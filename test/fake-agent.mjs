#!/usr/bin/env node
/**
 * fake-agent —— 假智能体(群聊管道测试基石,L2 用)。
 *
 * 按 `ce chat` CLI 的节奏收发:轮询 inbox → 有未读就 read → 对别人的消息回一句固定话术。
 * 全程不依赖真 CC(快/可重复/零 token 成本);真 CC 冒烟是 L3 的事。
 *
 * 用法:
 *   node test/fake-agent.mjs <agent名> [--reply "话术"] [--interval 5] [--once]
 *   CE_CMD="ce" node test/fake-agent.mjs A --reply "A 收到:#{seq} {text}"
 *
 * CE_CMD 环境变量指定 ce 命令(dev 默认 `bun run src/cli/main.ts`;生产二进制 `ce`)。
 * 话术支持占位:{seq} {from} {text} {name}。--once 跑一轮就退(脚本化测试)。
 */
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const name = argv.find((a, i) => i === 0 && !a.startsWith('--'))
const get = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const replyTpl = get('reply', `[{name}] 收到 {from} 的 #{seq}: {text}`)
const intervalMs = Number(get('interval', 5)) * 1000
const once = argv.includes('--once')
const CE_CMD = process.env.CE_CMD || 'bun run src/cli/main.ts'

if (!name) {
  console.error('用法: node test/fake-agent.mjs <agent名> [--reply 话术] [--interval 秒] [--once]')
  process.exit(1)
}

function chat(args) {
  const out = execFileSync(CE_CMD.split(' ')[0], [...CE_CMD.split(' ').slice(1), 'chat', ...args, '--agent', name, '--json'], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  const line = out.trim().split('\n').find((l) => l.startsWith('{'))
  return line ? JSON.parse(line) : { ok: false, error: 'no json output' }
}

function render(tpl, m) {
  return tpl.replaceAll('{seq}', String(m.seq)).replaceAll('{from}', m.fromName).replaceAll('{text}', m.text).replaceAll('{name}', name)
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

let round = 0
for (;;) {
  round++
  try {
    const inbox = chat(['inbox'])
    const items = inbox.ok ? (inbox.data?.items ?? []) : []
    for (const it of items) {
      if (!it.unread) continue
      const read = chat(['read', it.groupName])
      const msgs = read.ok ? (read.data?.msgs ?? []) : []
      for (const m of msgs) {
        if (m.fromHuman || m.fromName === name) continue // 人的话要听但不自动回话术;自己的跳过
        console.log(`[fake-agent:${name}] 回复 ${it.groupName} #${m.seq}`)
        chat(['send', it.groupName, render(replyTpl, m)])
      }
    }
  } catch (e) {
    console.error(`[fake-agent:${name}] 第 ${round} 轮失败:`, e.message?.slice(0, 200))
  }
  if (once) break
  await sleep(intervalMs)
}
