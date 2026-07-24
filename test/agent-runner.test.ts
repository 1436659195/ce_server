import { describe, expect, it } from 'bun:test'
import { mapSdkMessageToEvents } from '../src/cli/agent-runner'
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
