/**
 * AgentEvent —— ce 端 agent-runner → 手机 的结构化事件契约(AgentEvent 帧 type 7 的明文载荷)。
 *
 * ce 端 agent-runner(见 cli/agent-runner.ts)用 @anthropic-ai/claude-agent-sdk 的 query() 跑 claude
 * (不开终端、不 parse TUI),把 SDKMessage 映射成本文件的事件,加密推手机。手机 CC 对话窗口
 * (ce-platform/src/plugins/cc-review)订阅 agentEvents → 归约成消息渲染。
 *
 * ★ 权威契约:本文件与 ce-platform/src/plugins/cc-review/events.ts 的 AgentEvent 类型必须一致
 *   (两仓库独立 tsconfig,无法共享代码;spec.md 是单一事实源)。加 kind = 两边同加(向前兼容兜底
 *   `{ kind: string }` 让单边先升级不破)。
 *
 * 设计参考 Happy Coder 的 session-protocol 事件集,取最小完备子集 + 审批。
 */

/** 工具调用生命周期:start(assistant tool_use)→ [approval-request] → end(user tool_result)。callId 贯穿。
 *  2026-10-01 加菜(向后兼容:未知 kind 老手机忽略):
 *   - text-delta / thinking-delta:流式增量(includePartialMessages;子代理的带 parentCallId)。
 *   - session-init:模型名 + SDK 会话 id(system/init 提炼)。
 *   - turn-end.usage:token 用量 / 成本 / numTurns(SDK result 提炼)。
 *   - 全事件:子代理消息带 parentCallId(此前漏打,子代理输出平铺进主对话)。 */
export type AgentEvent =
  | { kind: 'turn-start' }
  | {
      kind: 'turn-end';
      status: 'completed' | 'failed';
      durationMs?: number;
      usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; numTurns?: number };
    }
  | { kind: 'text'; text: string; parentCallId?: string }
  | { kind: 'thinking'; text: string; parentCallId?: string }
  | { kind: 'text-delta'; text: string; parentCallId?: string }
  | { kind: 'thinking-delta'; text: string; parentCallId?: string }
  | { kind: 'session-init'; model: string; sessionId?: string }
  | { kind: 'tool-call-start'; callId: string; tool: string; input: Record<string, unknown>; parentCallId?: string }
  | { kind: 'tool-call-end'; callId: string; result?: unknown; isError?: boolean; parentCallId?: string }
  | { kind: 'approval-request'; reqId: string; callId: string; tool: string; input: Record<string, unknown> }
  | { kind: 'approval-resolved'; reqId: string; resolved: 'approved' | 'denied' }
  | { kind: string; [k: string]: unknown };
