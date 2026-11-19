/**
 * session-scan —— 会话识别判定链 + 注入安全闸(agent-group S2 机侧)。
 *
 * 终端 ≠ 智能体:roster 列工位只为了发现,成员资格由工位里的东西亲自 `ce chat join` 认领
 * (能力证明);本模块回答两个问题:
 *   ①「这个会话里是什么?」—— 判定链:注册表/join ✅ > hooks 心跳 ✅ > 进程特征 ⚠️疑似 >
 *      无证据 → 待确认❓(用户点选归类)。
 *   ②「此刻能不能注入?」—— 安全闸(每次投递前重判):负闸(前台≠shell 一票否决,防打断
 *      脚本/防 TTY 行缓冲延迟引爆)优先于正闸(hooks 说 idle);无 hooks 信号永不注入,转人工。
 *
 * 纯逻辑 + 可注入 /proc 读取器(osProcReader 为真实实现,测试喂假进程表)。
 * 特征表是数据(可由配置/插件贡献扩展),ce 不硬编码任何 agent 名 —— 红线④。
 */

// ─── 特征表(数据)──────────────────────────────────────────────────────────

export interface AgentSignature {
  /** 平台 id(与群协议 platform 字段同空间;claude/codex/gemini/...) */
  platform: string
  /** 展示名 */
  label: string
  /** argv 全文匹配(小写后测);正则由特征表作者负责精度 */
  pattern: RegExp
}

/** 内置默认特征表(常见 coding agent 的进程名;工坊/配置可追加,不可覆盖语义)。 */
export const DEFAULT_AGENT_SIGNATURES: readonly AgentSignature[] = [
  { platform: 'claude', label: 'CC', pattern: /(?:^|\/)claude(?:$|[\s])/ },
  { platform: 'codex', label: 'Codex', pattern: /(?:^|\/)codex(?:$|[\s])/ },
  { platform: 'gemini', label: 'Gemini', pattern: /(?:^|\/)gemini(?:$|[\s])/ },
  { platform: 'cursor', label: 'Cursor', pattern: /(?:^|\/)cursor-agent(?:$|[\s])/ },
  { platform: 'opencode', label: 'OpenCode', pattern: /(?:^|\/)opencode(?:$|[\s])/ },
  { platform: 'aider', label: 'Aider', pattern: /(?:^|\/)aider(?:$|[\s])/ },
]

// ─── 进程证据(可注入)────────────────────────────────────────────────────────

export interface ProcEntry {
  pid: number
  ppid: number
  /** /proc/<pid>/comm(短名) */
  comm: string
  /** /proc/<pid>/cmdline 拼接(空格分隔) */
  argv: string
  /** /proc/<pid>/cwd readlink(读不到 → undefined) */
  cwd?: string
}

export type ProcLister = () => ProcEntry[]

/** 某进程是否命中特征表(argv 全文小写匹配;返回第一个命中)。 */
export function matchSignature(argv: string, sigs: readonly AgentSignature[] = DEFAULT_AGENT_SIGNATURES): AgentSignature | null {
  const lower = argv.toLowerCase()
  for (const s of sigs) if (s.pattern.test(lower)) return s
  return null
}

/**
 * 会话进程树里的 agent 进程:从会话的根 pid(它自己的 shell/runner)沿 ppid 索引收集全部
 * 子孙,逐个过特征表。返回命中的(带 platform/cwd);无 → []。
 */
export function scanSessionProcs(rootPid: number, list: ProcEntry[], sigs: readonly AgentSignature[] = DEFAULT_AGENT_SIGNATURES): Array<ProcEntry & { sig: AgentSignature }> {
  const byParent = new Map<number, ProcEntry[]>()
  for (const p of list) {
    const arr = byParent.get(p.ppid) ?? []
    arr.push(p)
    byParent.set(p.ppid, arr)
  }
  const hits: Array<ProcEntry & { sig: AgentSignature }> = []
  const seen = new Set<number>([rootPid])
  const walk = (pid: number): void => {
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue // 防环
      seen.add(child.pid)
      const sig = matchSignature(child.argv, sigs) ?? matchSignature(child.comm, sigs)
      if (sig) hits.push({ ...child, sig })
      walk(child.pid)
    }
  }
  walk(rootPid)
  return hits
}

/** 全机 agent 进程扫描(roster 用):逐进程过特征表;调用方按 platform+cwd 自行去重。 */
export function scanAgentProcsAll(list: ProcEntry[], sigs: readonly AgentSignature[] = DEFAULT_AGENT_SIGNATURES): Array<ProcEntry & { sig: AgentSignature }> {
  const hits: Array<ProcEntry & { sig: AgentSignature }> = []
  for (const p of list) {
    const sig = matchSignature(p.argv, sigs) ?? matchSignature(p.comm, sigs)
    if (sig) hits.push({ ...p, sig })
  }
  return hits
}

/** 真实 /proc 读取器(linux;/proc 不可用 → 空表,调用方按「无进程证据」降级)。 */
export function osProcLister(): ProcLister {
  return () => {
    const out: ProcEntry[] = []
    let ids: number[] = []
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs')
      ids = fs
        .readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number)
    } catch {
      return out
    }
    for (const pid of ids) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs')
        const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
        const argvBuf = fs.readFileSync(`/proc/${pid}/cmdline`)
        const argv = argvBuf.toString('utf8').split('\0').filter(Boolean).join(' ')
        let cwd: string | undefined
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
        } catch {
          /* 权限/已退出 */
        }
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        // stat: pid (comm) state ppid ... (comm 含空格/括号 → 取右括号后第一个数)
        const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')
        const ppid = Number(after[1])
        if (Number.isFinite(ppid)) out.push({ pid, ppid, comm, argv, cwd })
      } catch {
        /* 竞态:进程已退出 */
      }
    }
    return out
  }
}

// ─── 四档归类(判定链)────────────────────────────────────────────────────────

export type SessionAgentStatus =
  | 'connected' // ✅ 注册表在册(join 过/hooks 接入过)—— roster 主档
  | 'suspect' // ⚠️ 进程特征命中但未接入 —— 邀请入口(顺手补 hooks)
  | 'unconfirmed' // ❓ 证据不足 —— 用户点选归类,回写注册表
  | 'plain' // 🚫 无智能体 —— 不可加成员

export interface ClassifyInput {
  /** 注册表在册(ce chat join 过的 / hooks 接入过的),带名字与平台 */
  registry?: { name: string; platform: string }
  /** hooks 心跳近活(agentEvents 最近有事件) */
  hooksAlive?: boolean
  /** 会话进程树里命中的 agent 特征 */
  matchedProc?: { platform: string; label: string; cwd?: string }
}

export interface ClassifyResult {
  status: SessionAgentStatus
  platform?: string
  /** roster 展示的理由(中文,给手机端) */
  reason: string
}

/** 判定链(优先级递减):注册表 > hooks > 进程特征 > 待确认。 */
export function classifySession(input: ClassifyInput): ClassifyResult {
  if (input.registry) {
    return { status: 'connected', platform: input.registry.platform, reason: '已接入群聊' }
  }
  if (input.hooksAlive) {
    return { status: 'connected', platform: 'claude', reason: 'hooks 心跳活跃(已接入的智能体)' }
  }
  if (input.matchedProc) {
    return {
      status: 'suspect',
      platform: input.matchedProc.platform,
      reason: `检测到 ${input.matchedProc.label} 进程,未接入群聊`,
    }
  }
  return { status: 'unconfirmed', reason: '未检测到智能体;确认后归类或按纯终端处理' }
}

// ─── 注入安全闸(每次投递前重判;负闸优先)──────────────────────────────────────

export type GateDecision = 'inject' | 'queue' | 'manual'

export interface GateInput {
  /** hooks 心跳状态(null = 该会话无 hooks 信号) */
  hooksState: 'idle' | 'working' | null
  /** 前台进程组 == 会话 shell?(null = 无法判定,如 jupyter 托管的 PTY) */
  foregroundIsShell: boolean | null
}

/**
 * 投递决策:
 *  - inject:hooks 证明 idle 且前台可判为 shell(或前台不可判但 hooks idle 是正面证据)
 *  - queue:hooks 说 working → 攒着等 Stop 边界
 *  - manual:负闸命中(前台非 shell = 有脚本/程序在跑,**绝不注入**)或无 hooks 证据(转人工粘贴)
 *
 * 为什么负闸先于正闸:注入文本落在 TTY 行缓冲里,前台脚本结束后会被 shell 当命令逐行执行
 * (延迟引爆);前台非 shell 一票否决,哪怕 hooks 说 idle。
 */
export function injectionGate(input: GateInput): GateDecision {
  if (input.foregroundIsShell === false) return 'manual'
  if (input.hooksState === 'idle') return 'inject'
  if (input.hooksState === 'working') return 'queue'
  return 'manual'
}
