/**
 * ce chat —— 群聊 CLI(薄客户端)。读 ~/.ce/daemon.json 找本地 daemon,POST /chat/op,
 * 本身零状态零网络(daemon 是信任边缘;见 chat.ts 头注)。
 *
 * 用法(agent 手册手册见 docs/agent-chat-manual.md):
 *   ce chat join <code> --name "项目A的CC" [--platform claude] [--reclaim]
 *   ce chat send <groupId|群名> "文本" [--reply seq] [--mention "名字"]...
 *   ce chat read [groupId|群名] [--limit N]
 *   ce chat inbox / ce chat groups / ce chat whoami / ce chat leave <groupId|群名>
 *   全局:--agent <name>(多 agent 机器指定身份) / --json(机器可读输出,fake-agent/脚本用)
 *
 * 退出码:0 成功;1 失败(daemon 不在 / op 失败)。new_messages 时未读消息随 JSON 给出。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface ChatCliResult {
  ok: boolean
  data?: unknown
  error?: string
}

const HELP = `ce chat —— 跨机器智能体群聊(需要 ce daemon 在跑)

  ce chat join <code> --name "名字" [--platform claude] [--reclaim]   认领邀请入群
  ce chat send <groupId|群名> "文本" [--reply seq] [--mention 名字]   发消息
  ce chat read [groupId|群名] [--limit N]                            读未读(读即标读)
  ce chat inbox                                                      各群未读预览(不标读)
  ce chat groups / whoami / leave <groupId|群名>
  ce chat skill                                  # (重)安装群聊成员手册到本项目 .claude/skills/
  全局: --agent <名字> 指定身份(单 agent 机器免填); --json 机器可读输出
`

function fail(msg: string): never {
  console.error(`[ce chat] ${msg}`)
  process.exit(1)
}

/** argv → {flags, positionals}(支持 --flag value / --flag=value / 裸旗标)。 */
function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; pos: string[] } {
  const flags: Record<string, string | boolean> = {}
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      pos.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { flags, pos }
}

export async function runChatCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    console.log(HELP)
    process.exit(0)
  }
  // daemon 发现:~/.ce/daemon.json(daemon 起来时写的 {port,pid})。pid 验活防 stale。
  let port: number | undefined
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.ce', 'daemon.json'), 'utf8')) as { port?: number; pid?: number }
    if (d.port && d.pid) {
      try {
        process.kill(d.pid, 0)
        port = d.port
      } catch {
        /* pid 死 → stale */
      }
    }
  } catch {
    /* 无 daemon.json */
  }
  if (!port) fail('本地 ce daemon 未运行:先启动 ce(--daemon 或控制台),再跑 ce chat')

  const { flags, pos } = parseArgs(argv)
  const cmd = pos[0]

  // ─── 组装 op 入参(与 daemon chat.ts localOp 的形状一一对应)──────────────────
  const body: Record<string, unknown> = { agent: typeof flags.agent === 'string' ? flags.agent : undefined, op: cmd }
  switch (cmd) {
    case 'join':
      body.code = pos[1] ?? flags.code
      body.name = flags.name
      body.platform = typeof flags.platform === 'string' ? flags.platform : undefined
      body.reclaim = flags.reclaim === true
      body.cwd = process.cwd()
      break
    case 'send':
      body.groupId = pos[1]
      body.text = pos.slice(2).join(' ') // --reply/--mention 的值被 parseArgs 吃进 flags,不会混进正文
      body.replyTo = typeof flags.reply === 'string' ? Number(flags.reply) : undefined
      body.mentions = typeof flags.mention === 'string' ? [flags.mention] : undefined
      break
    case 'read':
      body.groupId = pos[1]
      body.limit = typeof flags.limit === 'string' ? Number(flags.limit) : undefined
      break
    case 'inbox':
      body.agent = body.agent ?? pos[1] // `chat inbox <agent 名>` 与 --agent 等效(位置参数此前被丢弃,多 agent 时静默查错)
      break
    case 'groups':
    case 'whoami':
      break
    case 'leave':
      body.groupId = pos[1]
      break
    case 'skill':
      body.cwd = process.cwd()
      break
    default:
      fail(`未知子命令「${cmd}」\n${HELP}`)
  }

  let r: ChatCliResult
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/chat/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    r = (await resp.json()) as ChatCliResult
  } catch (e) {
    fail(`请求本地 daemon 失败:${(e as Error).message}(daemon 刚起?稍等重试)`)
  }

  // ─── 输出:--json 原样;否则人读(fresh agent 两种都能吃)────────────────────────
  if (flags.json === true) {
    console.log(JSON.stringify(r))
    process.exit(r.ok ? 0 : 1)
  }
  if (!r.ok) {
    const msgs = (r.data as { msgs?: Array<{ fromName: string; text: string; seq: number }> } | undefined)?.msgs
    console.error(`[ce chat] ${r.error}`)
    if (msgs?.length) {
      console.error('── 未读消息(已替你标读)──')
      for (const m of msgs) console.error(`  #${m.seq} ${m.fromName}: ${m.text}`)
    }
    process.exit(1)
  }
  const data = r.data as Record<string, unknown> | undefined
  switch (cmd) {
    case 'read':
    case 'inbox': {
      type Item = { groupId?: string; groupName?: string; unread?: number; msgs?: Array<{ seq: number; fromName: string; fromHuman?: boolean; text: string }>; previews?: Array<{ seq: number; fromName: string; text: string }>; mentionsMe?: boolean }
      const items: Item[] =
        cmd === 'read'
          ? [data as unknown as Item]
          : ((data as { items?: Item[] }).items ?? [])
      for (const it of items) {
        const list = it.msgs ?? it.previews ?? []
        const head = cmd === 'read' ? `── ${it.groupName ?? ''} ──` : `${it.groupName}(未读 ${it.unread}${it.mentionsMe ? ' · 有人@你' : ''})`
        console.log(head)
        for (const m of list) console.log(`  #${m.seq} ${m.fromName}${'fromHuman' in m && (m as { fromHuman?: boolean }).fromHuman ? '[人]' : ''}: ${m.text}`)
      }
      if (cmd === 'inbox' && items.every((it) => (it.unread ?? 0) === 0)) console.log('(所有群都无未读)')
      break
    }
    case 'groups': {
      const gs = (data as Array<{ groupId: string; groupName: string }> | undefined) ?? []
      for (const g of gs) console.log(`${g.groupName}  (${g.groupId})`)
      if (!gs.length) console.log('(未入任何群)')
      break
    }
    case 'whoami': {
      const w = (data as { cid?: string; agents?: Array<{ name: string; platform?: string; cwd?: string; groups: Array<{ groupName: string }> }> } | undefined)
      console.log(`本机 cid: ${w?.cid}`)
      for (const a of w?.agents ?? []) console.log(`  ${a.name}  [${a.platform ?? '?'}]  ${a.cwd ?? ''}  群:${a.groups.map((g) => g.groupName).join(', ') || '无'}`)
      break
    }
    case 'join': {
      const j = (data as { groupName?: string; groupId?: string; memberId?: string } | undefined)
      console.log(`已入群「${j?.groupName}」(${j?.groupId}),成员 id ${j?.memberId}`)
      break
    }
    case 'send':
      console.log(`已发 #${(data as { seq?: number }).seq}`)
      break
    case 'skill':
      console.log(`群聊成员手册已装: ${(data as { skillPath?: string }).skillPath}`)
      break
    default:
      console.log('ok')
  }
  process.exit(0)
}
