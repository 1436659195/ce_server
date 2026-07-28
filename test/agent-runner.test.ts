import { describe, expect, it } from 'bun:test'
import { mapSdkMessageToEvents, AgentRunner } from '../src/cli/agent-runner'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '../src/shared/agent-events'

/** 造 SDKMessage(最小形;mapper 只读 type + message.content / subtype / duration_ms)。 */
function msg(m: object): SDKMessage {
  return m as unknown as SDKMessage
}

describe('mapSdkMessageToEvents', () => {
  it('assistant 的 text 块 → text 事件', () => {
    const out = mapSdkMessageToEvents(
      msg({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } }),
    )
    expect(out).toEqual([{ kind: 'text', text: '你好' }])
  })

  it('assistant 的 thinking 块 → thinking 事件', () => {
    const out = mapSdkMessageToEvents(
      msg({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想想' }] } }),
    )
    expect(out).toEqual([{ kind: 'thinking', text: '想想' }])
  })

  it('assistant 的 tool_use 块 → tool-call-start(callId/tool/input)', () => {
    const out = mapSdkMessageToEvents(
      msg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } }],
        },
      }),
    )
    expect(out).toEqual([{ kind: 'tool-call-start', callId: 'toolu_1', tool: 'Read', input: { file_path: '/a' } }])
  })

  it('assistant 多块 → 多事件(顺序保留)', () => {
    const out = mapSdkMessageToEvents(
      msg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先读' },
            { type: 'text', text: '我来读' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          ],
        },
      }),
    ) as AgentEvent[]
    expect(out.map((e) => e.kind)).toEqual(['thinking', 'text', 'tool-call-start'])
  })

  it('user 的 tool_result → tool-call-end(callId/result/isError)', () => {
    const out = mapSdkMessageToEvents(
      msg({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: false }],
        },
      }),
    )
    expect(out).toEqual([{ kind: 'tool-call-end', callId: 'toolu_1', result: 'file body', isError: false }])
  })

  it('user 的 tool_result is_error → isError=true', () => {
    const out = mapSdkMessageToEvents(
      msg({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }] },
      }),
    )
    expect((out[0] as { isError?: boolean }).isError).toBe(true)
  })

  it('user 的 text 块(用户消息回显)→ 忽略(手机本地已显,免重复)', () => {
    const out = mapSdkMessageToEvents(
      msg({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '我发的' }] } }),
    )
    expect(out).toEqual([])
  })

  it('result success → turn-end completed', () => {
    const out = mapSdkMessageToEvents(msg({ type: 'result', subtype: 'success', duration_ms: 1234 }))
    expect(out).toEqual([{ kind: 'turn-end', status: 'completed', durationMs: 1234 }])
  })

  it('result error_during_execution → turn-end failed', () => {
    const out = mapSdkMessageToEvents(msg({ type: 'result', subtype: 'error_during_execution', duration_ms: 5 }))
    expect((out[0] as { status: string }).status).toBe('failed')
  })

  it('system.init / status / 未知类型 → 忽略(噪声不转发)', () => {
    expect(mapSdkMessageToEvents(msg({ type: 'system', subtype: 'init', tools: [] }))).toEqual([])
    expect(mapSdkMessageToEvents(msg({ type: 'status', subtype: 'whatever' }))).toEqual([])
    expect(mapSdkMessageToEvents(msg({ type: 'api_retry' }))).toEqual([])
  })

  it('assistant 无 content / 非数组 → 空数组(防御,不抛)', () => {
    expect(mapSdkMessageToEvents(msg({ type: 'assistant', message: { role: 'assistant' } }))).toEqual([])
    expect(mapSdkMessageToEvents(msg({ type: 'assistant', message: { role: 'assistant', content: 'oops' } }))).toEqual([])
  })
})

// ── AgentRunner.pendingApprovalsForPhone:审批卡断线加固(方案B)的核心枚举 ──
// 手机重连后拉取自己 pending 的审批,需 ce 端能按 owner 枚举出 {sid,reqId,callId,tool,input}。
describe('AgentRunner.pendingApprovalsForPhone', () => {
  /**
   * 假 query:调一次 canUseTool(非读类工具 → requestApproval → approvals.set,且永不 resolve
   * 模拟 claude 阻塞等审批),随后挂起。让测试能把 proc 卡在「审批 pending」状态。
   */
  function fakeQueryRequestingApproval(tool: string, callId: string) {
    return async function* ({ options }: {
      options: { canUseTool: (t: string, i: unknown, o: { toolUseID?: string }) => Promise<unknown> }
    }): AsyncGenerator<SDKMessage> {
      await options.canUseTool(tool, { file_path: '/a' }, { toolUseID: callId })
      // canUseTool 永不 resolve(等审批)→ 永远到不了这;留个 yield 仅作类型收尾
      yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
    }
  }

  function newRunner(tool: string, callId: string) {
    return new AgentRunner({
      onEvent: () => {},
      onExit: () => {},
      claudeBin: '/fake/claude',
      cwd: '/tmp/proj',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fakeQueryRequestingApproval(tool, callId) as any,
    })
  }

  it('某 phone 的 pending 审批被完整列出(reqId/callId/tool/input),且不含 resolve 句柄', async () => {
    const runner = newRunner('Write', 'call_1')
    const sid = runner.start('phoneA', '/')
    runner.writeStdin(sid, '帮我写文件') // 首条触发 runConversation → 假 query → canUseTool → pending
    await new Promise((r) => setTimeout(r, 50)) // 等 microtask 跑到 approvals.set

    const pending = runner.pendingApprovalsForPhone('phoneA')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ sid, callId: 'call_1', tool: 'Write', input: { file_path: '/a' } })
    expect(typeof pending[0].reqId).toBe('string')
    // resolve 是 SDK 内部回调句柄,绝不能序列化出 ce(防泄 + 防误调)
    expect((pending[0] as unknown as Record<string, unknown>).resolve).toBeUndefined()
  })

  it('按 owner 过滤:他机的 pending 不串入(多手机隔离)', async () => {
    const runner = newRunner('Write', 'call_2')
    const sidA = runner.start('phoneA', '/')
    runner.writeStdin(sidA, 'go')
    await new Promise((r) => setTimeout(r, 50))
    expect(runner.pendingApprovalsForPhone('phoneB')).toEqual([])
    expect(runner.pendingApprovalsForPhone('phoneA')).toHaveLength(1)
  })

  it('无 pending → 空数组(不抛)', () => {
    const runner = new AgentRunner({ onEvent: () => {}, onExit: () => {}, claudeBin: '/x', cwd: '/tmp' })
    runner.start('phoneA', '/')
    expect(runner.pendingApprovalsForPhone('phoneA')).toEqual([])
  })
})

// ── AgentRunner.replayPendingApprovals:审批卡断线加固(甲方案)的 ce 端补发 ──
// 手机重连后,ce 把该 phone 的 pending approval-request 经 agentEvents 流重发一遍;
// 手机 tunnel 晚订阅缓冲兜底 race + 插件 reducer 幂等去重(见 ce-platform 侧)。
describe('AgentRunner.replayPendingApprovals', () => {
  /** 假 query:调一次 canUseTool(非读类 → pending,永不 resolve 模拟 claude 等审批)。 */
  function fakeQuery(tool: string, callId: string) {
    return async function* ({ options }: {
      options: { canUseTool: (t: string, i: unknown, o: { toolUseID?: string }) => Promise<unknown> }
    }): AsyncGenerator<SDKMessage> {
      await options.canUseTool(tool, { file_path: '/a' }, { toolUseID: callId })
      yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
    }
  }
  /** 起 runner + writeStdin 触发一个 pending 审批,返回 runner/sid/已推事件。 */
  async function primePending(owner: string, tool: string, callId: string) {
    const events: Array<{ owner: string; sid: string; ev: AgentEvent }> = []
    const runner = new AgentRunner({
      onEvent: (o, s, ev) => events.push({ owner: o, sid: s, ev: ev as AgentEvent }),
      onExit: () => {},
      claudeBin: '/fake/claude',
      cwd: '/tmp/proj',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fakeQuery(tool, callId) as any,
    })
    const sid = runner.start(owner, '/')
    runner.writeStdin(sid, 'go')
    await new Promise((r) => setTimeout(r, 50))
    return { runner, sid, events }
  }

  it('把某 phone 的 pending 审批重发为 approval-request 事件(走 onEvent 流)', async () => {
    const { runner, sid, events } = await primePending('phoneA', 'Write', 'call_1')
    events.length = 0 // 清掉原推的 approval-request,只看 replay
    runner.replayPendingApprovals('phoneA')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ owner: 'phoneA', sid })
    expect(events[0].ev).toMatchObject({ kind: 'approval-request', callId: 'call_1', tool: 'Write' })
    expect(typeof (events[0].ev as { reqId?: string }).reqId).toBe('string')
  })

  it('按 owner 过滤:他机的 pending 不被 replay', async () => {
    const { runner, events } = await primePending('phoneA', 'Write', 'c2')
    events.length = 0
    runner.replayPendingApprovals('phoneB')
    expect(events).toHaveLength(0)
  })

  it('无 pending → replay 不发任何事件', () => {
    const events: AgentEvent[] = []
    const runner = new AgentRunner({
      onEvent: (_o, _s, ev) => events.push(ev as AgentEvent),
      onExit: () => {},
      claudeBin: '/x',
      cwd: '/tmp',
    })
    runner.start('phoneA', '/')
    runner.replayPendingApprovals('phoneA')
    expect(events).toEqual([])
  })
})
