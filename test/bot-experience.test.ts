import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { EXPERIENCE_LESSON_SCHEMA, EXPERIENCE_REFS_SCHEMA, readExperience } from '../src/cli/bot-runtime/experience-tools'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-experience-')); const path = join(dir, 'runtime.sqlite')
  let store = new BotRuntimeStore(path)
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { get store() { return store }, reopen() { store.close(); store = new BotRuntimeStore(path) } }
}
const content = { title: '端口变化后的恢复', object: 'CE 服务', goal: '恢复连接', applicability: 'CE 重启后连接失效', pitfalls: ['不能写死端口'], steps: ['读取 daemon.json'], verification: ['核对连接状态'] }

test('experience proposals require complete structure and updates identify both target and version', () => {
  expect(EXPERIENCE_LESSON_SCHEMA.safeParse({ content, changeSummary: '复盘' }).success).toBe(true)
  expect(EXPERIENCE_LESSON_SCHEMA.safeParse({ content, changeSummary: '复盘', id: 'x' }).success).toBe(false)
  expect(EXPERIENCE_LESSON_SCHEMA.safeParse({ content: { ...content, steps: [] }, changeSummary: '复盘' }).success).toBe(false)
  expect(EXPERIENCE_REFS_SCHEMA.safeParse([{ experienceId: 'x', version: 1 }, { experienceId: 'x', version: 2 }]).success).toBe(false)
})

test('owner status controls authenticate identity and version source-less migrated lessons with durable receipts', () => {
  const f = fixture(); const bot = { botId: 'b', ownerPhoneId: 'owner' }
  f.store.saveExperience({ id: 'legacy', botId: 'b', state: 'active', object: '经验', goal: '旧手工经验', approach: '读端口', detail: '读配置里的端口', checks: [], verified: false, sourceTaskId: '', sourceCaseId: '', uses: 11, platform: '', toolFingerprint: 'legacy', migrated: true, createdAt: 1, updatedAt: 1 })
  f.reopen()
  const command = { requestId: 'owner-revoke', id: 'legacy', expectedVersion: 1, state: 'retired' as const, reason: '主人发现已不适用' }
  expect(() => f.store.experienceLibrary.changeStateByOwner(bot, 'stranger', command)).toThrow(/主人|身份|权限/)
  expect(() => f.store.experienceLibrary.changeStateByOwner(bot, 'owner', { ...command, requestId: ' ' })).toThrow(/参数|请求/)
  const receipt = f.store.experienceLibrary.changeStateByOwner(bot, 'owner', command)
  expect(receipt).toMatchObject({ version: 2, created: false })
  expect(f.store.experienceLibrary.get('b', 'legacy')).toMatchObject({ state: 'retired', source: { ownerControl: { actorId: 'owner', requestId: 'owner-revoke' } } })
  expect(f.store.experienceLibrary.history('b', 'legacy').map(e => [e.version, e.state])).toEqual([[1, 'active'], [2, 'retired']])
  f.reopen()
  expect(f.store.experienceLibrary.changeStateByOwner(bot, 'owner', command)).toEqual(receipt)
  expect(f.store.experienceLibrary.history('b', 'legacy')).toHaveLength(2)
  expect(() => f.store.experienceLibrary.save('b', { requestId: 'forged-content', content, changeSummary: '伪造来源' }, { ownerControl: { actorId: 'owner', requestId: 'owner-revoke' } })).toThrow(/来源/)
})

test('progressive experience reads page detail while worker history stays outside selected grants', () => {
  const f = fixture(); const msg = f.store.receive({ botId: 'b', groupId: 'dm', seq: 1, text: '总结', senderId: 'owner', memberId: 'om', createdAt: 1 })
  const receipt = f.store.experienceLibrary.save('b', { requestId: 'save', content: { ...content, detail: '甲'.repeat(11000) }, changeSummary: '复盘' }, { inboxId: msg.id })
  const first = readExperience(f.store, 'b', { experienceId: receipt.id, section: 'detail', offset: 0, length: 2000 }, { maxText: 16000 })
  expect(first.text).toHaveLength(2000); expect(first.nextOffset).toBe(2000)
  expect(() => readExperience(f.store, 'b', { experienceId: receipt.id, version: 1, section: 'history' }, { selected: [{ experienceId: receipt.id, version: 1 }] })).toThrow(/历史|权限|派发/)
})
