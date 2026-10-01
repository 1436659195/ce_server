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

  it('system.init → session-init(model/sessionId 提炼);status / api_retry / 未知 → 忽略', () => {
    expect(
      mapSdkMessageToEvents(msg({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5', session_id: 's-1', tools: [] })),
    ).toEqual([{ kind: 'session-init', model: 'claude-sonnet-4-5', sessionId: 's-1' }])
    expect(mapSdkMessageToEvents(msg({ type: 'system', subtype: 'other' }))).toEqual([])
    expect(mapSdkMessageToEvents(msg({ type: 'status', subtype: 'whatever' }))).toEqual([])
    expect(mapSdkMessageToEvents(msg({ type: 'api_retry' }))).toEqual([])
  })

  it('stream_event 的 text_delta / thinking_delta → text-delta / thinking-delta;其余增量忽略', () => {
    const out = mapSdkMessageToEvents(
      msg({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } },
        parent_tool_use_id: null,
      }),
    )
    expect(out).toEqual([{ kind: 'text-delta', text: '你' }])
    const th = mapSdkMessageToEvents(
      msg({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } },
        parent_tool_use_id: null,
      }),
    )
    expect(th).toEqual([{ kind: 'thinking-delta', text: '想' }])
    // input_json_delta / signature_delta(工具入参与签名)是噪声
    expect(
      mapSdkMessageToEvents(
        msg({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } } }),
      ),
    ).toEqual([])
  })

  it('子代理消息(parent_tool_use_id)→ 全事件带 parentCallId(不再平铺进主对话)', () => {
    const sub = { parent_tool_use_id: 'toolu_parent' }
    expect(
      mapSdkMessageToEvents(
        msg({ ...sub, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '子代理说' }] } }),
      ),
    ).toEqual([{ kind: 'text', text: '子代理说', parentCallId: 'toolu_parent' }])
    expect(
      mapSdkMessageToEvents(
        msg({
          ...sub,
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Read', input: {} }] },
        }),
      ),
    ).toEqual([{ kind: 'tool-call-start', callId: 't9', tool: 'Read', input: {}, parentCallId: 'toolu_parent' }])
    expect(
      mapSdkMessageToEvents(
        msg({
          ...sub,
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }] },
        }),
      ),
    ).toEqual([{ kind: 'tool-call-end', callId: 't9', result: 'ok', isError: false, parentCallId: 'toolu_parent' }])
    expect(
      mapSdkMessageToEvents(
        msg({ ...sub, type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '流' } } }),
      ),
    ).toEqual([{ kind: 'text-delta', text: '流', parentCallId: 'toolu_parent' }])
  })

  it('result 带 usage/成本/numTurns → turn-end.usage(手机状态条展示)', () => {
    const out = mapSdkMessageToEvents(
      msg({
        type: 'result',
        subtype: 'success',
        duration_ms: 8000,
        num_turns: 3,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 1200, output_tokens: 560 },
      }),
    )
    expect(out).toEqual([
      {
        kind: 'turn-end',
        status: 'completed',
        durationMs: 8000,
        usage: { inputTokens: 1200, outputTokens: 560, costUsd: 0.0123, numTurns: 3 },
      },
    ])
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

// ── claudeBin=null(探测全失败,PROD-PATH-FIXES C2):不调 SDK,显式提示 + failed 收尾 ──
describe('AgentRunner.claudeBin=null', () => {
  it('首条消息 → text 提示 + turn-end failed,不调 query,proc 收尾', () => {
    const events: AgentEvent[] = []
    let queryCalled = false
    /** 探针 query:被调到即置位(null 路径绝不应调它)。 */
    const probeQuery = async function* (): AsyncGenerator<SDKMessage> {
      queryCalled = true
      yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
    }
    const runner = new AgentRunner({
      onEvent: (_o, _s, ev) => events.push(ev as AgentEvent),
      onExit: () => {},
      claudeBin: null,
      cwd: '/tmp',
      query: probeQuery,
    })
    const sid = runner.start('phoneA', '/')
    runner.writeStdin(sid, 'hi')
    expect(events.map((e) => e.kind)).toEqual(['text', 'turn-end'])
    expect((events[0] as { text: string }).text).toContain('claude')
    expect((events[1] as { status: string }).status).toBe('failed')
    expect(queryCalled).toBe(false) // 绝不裸 spawn
    expect(runner.sids()).toEqual([]) // proc 已收尾
  })
})

// ── resolveApproval 带 answers(AskUserQuestion 正道回传,Happy 同道)──
describe('AgentRunner.resolveApproval answers', () => {
  /** 造一个会触发 canUseTool 的假 query:消费首条用户消息 → canUseTool(捕获返回)→ result。 */
  function makeQuery(tool: string, input: Record<string, unknown>, capture: (v: unknown) => void) {
    return (params: {
      prompt: AsyncIterable<SDKMessage>
      options: { canUseTool: (t: string, i: Record<string, unknown>, o: { toolUseID?: string }) => Promise<unknown> }
    }) => {
      const obj = {
        async *[Symbol.asyncIterator]() {
          const it = params.prompt[Symbol.asyncIterator]()
          await it.next()
          capture(await params.options.canUseTool(tool, input, { toolUseID: 'call_test' }))
          yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
        },
      }
      return obj as never
    }
  }

  it('allow 带 answers → updatedInput = { ...原input, answers };原入参保留', async () => {
    let resolveCanUseTool!: (v: unknown) => void
    const canUseToolResult = new Promise((r) => (resolveCanUseTool = r))
    const events: AgentEvent[] = []
    const runner = new AgentRunner({
      onEvent: (_o, _s, ev) => events.push(ev as AgentEvent),
      onExit: () => {},
      claudeBin: '/x',
      cwd: '/tmp',
      query: makeQuery('AskUserQuestion', { questions: [{ question: '用哪个框架?' }] }, resolveCanUseTool) as never,
    })
    const sid = runner.start('phoneA', '/')
    runner.writeStdin(sid, '问吧')
    await new Promise((r) => setTimeout(r, 20))
    const req = events.find((e) => (e as { kind: string }).kind === 'approval-request') as { reqId: string }
    expect(req.reqId).toBeTruthy()
    expect(runner.resolveApproval(req.reqId, true, { '用哪个框架?': 'React, Vue' })).toBe(true)
    const r = (await canUseToolResult) as { behavior: string; updatedInput: Record<string, unknown> }
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput.answers).toEqual({ '用哪个框架?': 'React, Vue' })
    expect(r.updatedInput.questions).toEqual([{ question: '用哪个框架?' }])
  })

  it('不带 answers → updatedInput = 原 input(老手机语义零变化)', async () => {
    let resolveCanUseTool!: (v: unknown) => void
    const canUseToolResult = new Promise((r) => (resolveCanUseTool = r))
    const events: AgentEvent[] = []
    const runner = new AgentRunner({
      onEvent: (_o, _s, ev) => events.push(ev as AgentEvent),
      onExit: () => {},
      claudeBin: '/x',
      cwd: '/tmp',
      query: makeQuery('Write', { file_path: '/a', content: 'x' }, resolveCanUseTool) as never,
    })
    const sid = runner.start('phoneA', '/')
    runner.writeStdin(sid, '写')
    await new Promise((r) => setTimeout(r, 20))
    const req = events.find((e) => (e as { kind: string }).kind === 'approval-request') as { reqId: string }
    runner.resolveApproval(req.reqId, true)
    const r = (await canUseToolResult) as { updatedInput: Record<string, unknown> }
    expect(r.updatedInput).toEqual({ file_path: '/a', content: 'x' })
  })

  it('空 answers 对象 → 视为没带(updatedInput = 原 input)', async () => {
    let resolveCanUseTool!: (v: unknown) => void
    const canUseToolResult = new Promise((r) => (resolveCanUseTool = r))
    const events: AgentEvent[] = []
    const runner = new AgentRunner({
      onEvent: (_o, _s, ev) => events.push(ev as AgentEvent),
      onExit: () => {},
      claudeBin: '/x',
      cwd: '/tmp',
      query: makeQuery('Bash', { command: 'ls' }, resolveCanUseTool) as never,
    })
    const sid = runner.start('phoneA', '/')
    runner.writeStdin(sid, '跑')
    await new Promise((r) => setTimeout(r, 20))
    const req = events.find((e) => (e as { kind: string }).kind === 'approval-request') as { reqId: string }
    runner.resolveApproval(req.reqId, true, {})
    const r = (await canUseToolResult) as { updatedInput: Record<string, unknown> }
    expect(r.updatedInput).toEqual({ command: 'ls' })
  })
})

// ── AgentRunner.interrupt(2026-10-01 加菜,手机「停止」按钮)──────────────────
describe('AgentRunner.interrupt', () => {
  it('query 已起 → 调 conversation.interrupt() 并返回 true;会话未起/未知 sid → false', async () => {
    let interrupted = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fakeQuery = (params: { prompt: AsyncIterable<SDKMessage> }) => {
      const obj: AsyncIterable<SDKMessage> & { interrupt?: () => Promise<unknown> } = {
        async *[Symbol.asyncIterator]() {
          const it = params.prompt[Symbol.asyncIterator]()
          const first = await it.next() // 首条用户消息(启动触发)
          if (!first.done) yield first.value
          await gate // 挂住:模拟回合进行中,interrupt 之后放行收尾
          yield { type: 'result', subtype: 'success', duration_ms: 1 } as unknown as SDKMessage
        },
        interrupt: () => {
          interrupted++
          return Promise.resolve(undefined)
        },
      }
      return obj
    }
    const runner = new AgentRunner({ onEvent: () => {}, onExit: () => {}, claudeBin: '/x', cwd: '/tmp', query: fakeQuery as any })
    const sid = runner.start('phoneA', '/')
    expect(runner.interrupt(sid)).toBe(false) // 会话未起(懒启动)→ false
    runner.writeStdin(sid, '跑个长任务')
    await new Promise((r) => setTimeout(r, 10)) // 让 query 迭代走到 gate
    expect(runner.interrupt(sid)).toBe(true)
    expect(interrupted).toBe(1)
    release()
    expect(runner.interrupt('cc-nope')).toBe(false) // 未知 sid
  })

  it('interrupt 后回合以 interrupted result 收尾 → turn-end(failed);agent 不被杀(可继续下一轮)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const events: AgentEvent[] = []
    const fakeQuery = (params: { prompt: AsyncIterable<SDKMessage> }) => {
      const obj: AsyncIterable<SDKMessage> & { interrupt?: () => Promise<unknown> } = {
        async *[Symbol.asyncIterator]() {
          const it = params.prompt[Symbol.asyncIterator]()
          const first = await it.next()
          if (!first.done) yield first.value
          await gate
          yield { type: 'result', subtype: 'error_during_execution', duration_ms: 2 } as unknown as SDKMessage
        },
        interrupt: () => Promise.resolve(undefined),
      }
      return obj
    }
    let exitCode: number | null | undefined
    const runner = new AgentRunner({
      onEvent: (_o, _s, ev) => events.push(ev as AgentEvent),
      onExit: (_sid, _o, code) => (exitCode = code),
      claudeBin: '/x',
      cwd: '/tmp',
      query: fakeQuery as any,
    })
    const sid = runner.start('phoneA', '/')
    runner.writeStdin(sid, '干')
    await new Promise((r) => setTimeout(r, 10))
    runner.interrupt(sid)
    release()
    await new Promise((r) => setTimeout(r, 10))
    expect(events.map((e) => e.kind)).toEqual(['turn-end'])
    expect((events[0] as { status: string }).status).toBe('failed')
    expect(exitCode).toBe(0) // 正常收尾(流结束),非崩溃
  })
})
