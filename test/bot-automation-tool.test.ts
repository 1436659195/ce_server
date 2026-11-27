import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { AUTOMATION_TOOL, AUTOMATION_INSTRUCTIONS, parseAutomationArgs } from '../src/cli/bot-runtime/automation/tool'

test('事件工具schema能被Claude实际使用的Zod转换并解析创建和更新参数', () => {
  const schema = z.fromJSONSchema(AUTOMATION_TOOL.inputSchema)
  expect(schema.safeParse({ action: 'create', slot: 1, definition: { name: '天气', payload: '查上海天气', schedule: { kind: 'cron', expr: '0 8 * * *', timezone: 'Asia/Shanghai' } } }).success).toBe(true)
  expect(schema.safeParse({ action: 'update', jobId: 'job1', revision: 1, definition: { name: '新名字', condition: null } }).success).toBe(true)
  expect(schema.safeParse({ action: 'create', slot: 1, ownerId: 'forged' }).success).toBe(false)
})

test.each([
  { action: 'create', slot: 0, definition: {} }, { action: 'remove', jobId: 'x' },
  { action: 'inspect', jobId: 'x', limit: 100 }, { action: 'list', ownerId: 'o' },
])('事件工具宿主拒绝非法参数 %#', args => {
  expect(() => parseAutomationArgs(args)).toThrow()
})

test('使用规则保持简短，不包含调度实现或所有事件清单', () => {
  expect(AUTOMATION_INSTRUCTIONS.length).toBeLessThan(400)
})
