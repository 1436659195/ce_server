import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { relevance } from '../src/cli/bot-runtime/cases'

test('受控换词召回重连，但不把通用网络问题当作同义词', () => {
  for (const query of ['掉线后再也进不去', '断线后连不回来', 'reconnect']) {
    expect(relevance(query, '连接恢复异常')).toBeGreaterThan(0.5)
  }
  expect(relevance('reconnect', '网络带宽测速')).toBe(0)
  expect(relevance('连接恢复异常', '连接恢复异常')).toBeGreaterThan(relevance('reconnect', '连接恢复异常'))
})

test('精确关联不被候选截断；可翻下一页；旧名和实时更新及Bot隔离保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'case-retrieval-'))
  const store = new BotRuntimeStore(join(root, 'runtime.sqlite'))
  try {
    const mandate = { ownerPhoneId: 'o', policyRevision: 1, directory: root, allowedOps: ['read'] as const, exclusions: [], mode: 'execute' as const }
    let seq = 0
    const start = (botId: string, title: string) => {
      const input = store.receive({ botId, groupId: 'dm', seq: ++seq, senderId: 'o', memberId: 'm', text: title, createdAt: seq })
      return store.acceptWork({ inputId: input.id, newCase: { title, object: '', goal: title }, goal: '工作', acceptance: [], mandate: { ...mandate, allowedOps: ['read'] }, replies: [] })
    }
    const first = start('b', '连接恢复异常')
    store.saveCase({ ...store.case(first.caseId)!, aliases: ['旧名称'], updatedAt: 0, createdAt: 0 })
    for (let i = 0; i < 7; i++) start('b', '连接恢复异常')
    const foreign = start('other', '连接恢复异常')
    store.saveArtifact({ id: 'artifact-old', botId: 'b', caseId: first.caseId, taskId: first.id, title: '旧报告', name: 'prior-report.md', mime: 'text/plain', path: '/unused', size: 1, hash: '', revision: 1, createdAt: 1 })
    expect(store.findCases('b', 'reconnect').length).toBe(5)
    const page1 = store.findCases('b', '连接恢复异常')
    const page2 = store.findCases('b', '连接恢复异常', { offset: 5 })
    expect(page1.some(c => c.id === first.caseId)).toBe(false)
    expect(page2.some(c => c.id === first.caseId)).toBe(true)
    expect(new Set([...page1, ...page2].map(c => c.id)).size).toBe(8)
    expect(store.findCases('b', '', { taskId: first.id }).map(c => c.id)).toEqual([first.caseId])
    expect(store.findCases('b', '', { taskId: first.id, offset: 1 })).toEqual([])
    expect(store.findCases('b', '', { taskId: foreign.id, artifactId: 'artifact-old' })).toEqual([])
    expect(() => store.findCases('b', '卷宗', { offset: 30 })).toThrow('0至29')
    expect(() => store.findCases('b', '卷宗', { offset: -1 })).toThrow('0至29')
    expect(store.findCases('b', '别的词', { artifactId: 'artifact-old' }).map(c => c.id)).toEqual([first.caseId])
    expect(store.findCases('b', '', { taskId: foreign.id })).toEqual([])
    expect(store.findCases('other', '', { artifactId: 'artifact-old' })).toEqual([])
    expect(store.findCases('b', '', { taskId: 'missing' })).toEqual([])
    for (const query of ['旧名称', 'prior-report.md']) expect(store.findCases('b', query).map(c => c.id)).toEqual([first.caseId])
    store.updateCase('b', first.caseId, { expectedRevision: 1, title: '新名称' })
    for (const query of ['新名称', '旧名称']) expect(store.findCases('b', query).map(c => c.id)).toContain(first.caseId)
    expect(store.findCases('b', '完全不存在')).toEqual([])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
