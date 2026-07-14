import { test, expect } from 'bun:test'
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'

/**
 * Agent SDK import 可达性冒烟(Phase 1 Task 1)。
 * 验证 @anthropic-ai/claude-agent-sdk 在 Bun 下能 import,且管家要用到的三个入口都在。
 * 不跑真 cc(那是 spike 干过 + Task 13 手测);仅证明依赖装对、导出对。
 */
test('Agent SDK 三入口可达且为函数', () => {
  expect(typeof query).toBe('function')
  expect(typeof tool).toBe('function')
  expect(typeof createSdkMcpServer).toBe('function')
})
