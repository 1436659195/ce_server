import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import cases from './fixtures/router-conversation-cases.json'
import { assessDecision, buildFixture, createReplay, validateCases } from '../scripts/bot-router-conversation-eval'
import { bindRouterDecision } from '../src/cli/bot-runtime/router'

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })
function replay(id: string) {
  const scenario = validateCases(cases).find(c => c.id === id)!
  const f = buildFixture(scenario, 'codex')
  const dir = mkdtempSync(join(tmpdir(), 'ce-eval-test-'))
  const r = createReplay(f, dir)
  cleanups.push(() => { r.store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { ...r, f }
}

test('回放使用真实提交校验，拒绝无依据的静默交付与伪造引用', () => {
  const r = replay('limits-unverified')
  expect(() => r.decide({ decision: { action: 'reply' }, feasibility: 'can', replies: [] })).toThrow('依据')
  expect(() => r.decide({ decision: { action: 'reply' }, feasibility: 'can', replies: ['还未核实'], memoryIds: ['unknown'] })).toThrow('记忆')
  expect(() => r.decide({ decision: { action: 'reply' }, feasibility: 'can', replies: ['还未核实'], cancelReplyIds: ['unknown'] })).toThrow('取消')
  expect(r.store.replies(r.f.bot.botId).filter(m => m.author === 'router')).toEqual([])
})

test('回放聊天查询包含 Bot 原话并遵循作者和分页筛选', () => {
  const r = replay('conversation-hash')
  const page = r.store.chatHistory(r.f.bot.botId, { groupId: r.f.bot.groupId, author: 'router', limit: 1 })
  expect(page.messages).toHaveLength(1)
  expect(page.messages[0].text).toContain('SHA-256')
  expect(r.store.chatMessage(r.f.bot.botId, { groupId: r.f.bot.groupId, messageId: page.messages[0].id })?.text).toContain('SHA-256')
})

test('没有可见回复的补充仍真实写入原任务输入', () => {
  const r = replay('ack-addition')
  r.decide({ decision: { action: 'append', taskId: r.f.task!.id }, feasibility: 'can', replies: [] })
  expect(r.store.inputs(r.f.task!.id).some(i => i.text.includes('日志发生的时间'))).toBe(true)
  expect(r.store.inbox(r.f.inputs[0].id)?.state).toBe('routed')
})

test('文件交付由真实账本保留附件绑定，必要问题不能静默丢弃', () => {
  const file = replay('limits-attachment')
  expect(() => file.decide({ decision: { action: 'reply' }, feasibility: 'can', replies: [], basis: '略' })).toThrow('文件')
  file.decide({ decision: { action: 'reply' }, feasibility: 'can', replies: ['TXT 在附件里。'] })
  expect(file.store.replies(file.f.bot.botId).find(r => r.author === 'router')?.artifactIds).toEqual(file.f.artifacts.map(a => a.id))
  const question = replay('preference-question')
  expect(() => question.decide({ decision: { action: 'reply' }, feasibility: 'can', replies: [], basis: '略' })).toThrow('必要问题')
})

test('固定集有六类24组，8组留出；缺少事实与评分说明的样本拒绝运行', () => {
  const parsed = validateCases(cases)
  expect(parsed).toHaveLength(24)
  expect(parsed.filter(c => c.split === 'holdout')).toHaveLength(8)
  expect(() => validateCases(parsed.slice(1))).toThrow()
  expect(() => validateCases(parsed.map((c, i) => i ? c : { ...c, facts: [] }))).toThrow()
})

test('模型只看生产上下文，不泄露评分要求或期待动作，回放输入时间稳定', () => {
  const scenario = validateCases(cases)[0]
  const first = buildFixture(scenario, 'codex')
  const second = buildFixture(scenario, 'codex')
  expect(first.context).toBe(second.context)
  expect(first.context).not.toContain(scenario.rubric)
  const context = JSON.parse(first.context)
  expect(context.expected).toBeUndefined()
  expect(context.currentMessages.map((m: { text: string }) => m.text)).toEqual(scenario.current)
})

test('评估记录实际动作，空回复不冒充提交了补充需求', () => {
  const scenario = validateCases(cases).find(c => c.id === 'ack-addition')!
  const f = buildFixture(scenario, 'codex')
  const wrong = bindRouterDecision({ decision: { action: 'reply' }, feasibility: 'can', replies: [] }, f.bot, f.bindings)
  expect(assessDecision(scenario, wrong, f)).toContain('action: reply; expected append')
  const right = bindRouterDecision({ decision: { action: 'append', taskId: f.task!.id }, feasibility: 'can', replies: [] }, f.bot, f.bindings)
  expect(assessDecision(scenario, right, f)).toEqual([])
})

test('评估拒绝把同一成果修订变成口头交付或新卷宗', () => {
  const scenario = validateCases(cases).find(c => c.id === 'continuity-revision')!
  const f = buildFixture(scenario, 'codex')
  const d = bindRouterDecision({
    decision: { action: 'start', goal: '修订步骤', allowedOps: ['read', 'create'], delivery: 'chat',
      dossier: { kind: 'new', title: '新报告', object: '报告', goal: '修订', reason: '另开一个' } },
    feasibility: 'can', replies: ['开始修订。'],
  }, f.bot, f.bindings)
  expect(assessDecision(scenario, d, f)).toEqual(expect.arrayContaining(['delivery: expected files', 'case: expected existing']))
})

test('事实和自然度评分保持人工待评，不把格式合法当成事实正确', () => {
  const scenario = validateCases(cases).find(c => c.id === 'limits-failure')!
  const f = buildFixture(scenario, 'codex')
  const d = bindRouterDecision({ decision: { action: 'reply' }, feasibility: 'can', replies: [] }, f.bot, f.bindings)
  expect(assessDecision(scenario, d, f)).toContain('reply: required')
  expect(scenario.facts.length).toBeGreaterThan(0)
})
