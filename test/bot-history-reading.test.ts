import { test, expect } from 'bun:test'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { selectCases } from '../src/cli/bot-runtime/cases'
import { mkdirSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'

const root = `${import.meta.dir}/../.task-tmp`
mkdirSync(root, { recursive: true })
test('数据库分页、旧活动任务、关联隔离及全历史搜索保持正确', async () => {
  const path = `${root}/history-${crypto.randomUUID()}.sqlite`
  const store = new BotRuntimeStore(path)
  try {
    const db = new Database(path)
    for (let i = 0; i < 120; i++) {
      const c = { id: `c${i}`, botId: 'b', title: `卷宗${i}`, aliases: i === 0 ? ['远古档案', 'ÄBC'] : [], object: '', goal: '', summary: '', createdAt: i, updatedAt: i }
      store.saveCase(c)
      const t = { id: `t${i}`, botId: 'b', caseId: c.id, state: i === 0 ? 'waiting_user' : 'completed', goal: i === 0 ? 'websocket 重连' : '普通工作', summary: '', createdAt: i === 0 ? 9999 : i, updatedAt: i }
      db.query('INSERT INTO tasks VALUES(?,?,?)').run(t.id, 'b', JSON.stringify(t))
      store.saveArtifact({ id: `a${i}`, botId: 'b', caseId: c.id, taskId: t.id, title: i === 0 ? '古老成果' : '成果', name: `file${i}`, mime: 'text/plain', path: '/unused', size: 1, hash: '', revision: 1, createdAt: i })
    }
    store.saveCase({ id: 'foreign', botId: 'other', title: '远古档案', object: '', goal: '', summary: '', createdAt: 1000, updatedAt: 1000 })
    const page1 = store.queryTasks('b', { limit: 10 })
    const page2 = store.queryTasks('b', { limit: 10, offset: 10 })
    expect(page1.map(t => t.id)).toEqual(Array.from({ length: 10 }, (_, i) => `t${110 + i}`))
    expect(new Set([...page1, ...page2].map(t => t.id)).size).toBe(20)
    expect(store.viewTasks('b').map(t => t.id)).toContain('t0')
    expect(store.viewTasks('b')).toHaveLength(31)
    expect(store.viewTasks('b')[0].id).toBe('t0')
    expect(store.queryTasks('b', { caseIds: ['c0'] }).map(t => t.id)).toEqual(['t0'])
    expect(store.queryArtifacts('b', { caseIds: ['c0'] }).map(a => a.id)).toEqual(['a0'])
    expect(store.queryCases('other', ['c0'])).toEqual([])
    const connection = (store as any).db as Database
    const originalQuery = connection.query.bind(connection)
    let searchSql = ''
    connection.query = ((sql: string) => { if (sql.startsWith('WITH')) searchSql = sql; return originalQuery(sql) }) as any
    for (const query of ['远古档案', 'websocket 重连', '古老成果', 'äbc', '卷宗', '', '不存在']) {
      const expected = selectCases(store.cases('b'), store.tasks('b'), store.artifacts('b'), { query, searchOnly: true })
      expect(store.findCases('b', query).map(c => c.id)).toEqual(expected.map(c => c.id))
    }
    const searchPlan = JSON.stringify(db.query('EXPLAIN QUERY PLAN ' + searchSql).all('b', 'b', 'b'))
    expect(searchPlan).not.toContain('SCAN work LEFT-JOIN')
    expect(searchPlan).not.toContain('SCAN files LEFT-JOIN')
    const plan = db.query("EXPLAIN QUERY PLAN SELECT body FROM tasks WHERE bot_id='b' AND json_extract(body,'$.caseId')='c0' ORDER BY rowid").all()
    expect(JSON.stringify(plan)).toContain('tasks_case')
    // 快照辅助信息也必须在SQL里限量，不能每两秒解析无关历史。
    for (let i = 0; i < 80; i++) {
      for (const [table, body] of [
        ['inbox', { id: `in${i}`, botId: 'b', text: '失败消息', memoryJob: { state: 'failed' } }],
        ['memories', { id: `m${i}`, botId: 'b', status: i < 10 ? 'retired' : 'active', needsReview: i === 10 }],
        ['experiences', { id: `e${i}`, botId: 'b', state: 'active', object: '历史任务', goal: `报告${i}`, approach: '核对结果', detail: '完成普通任务', checks: [], verified: false, sourceTaskId: `t${i}`, sourceCaseId: `c${i}`, uses: 0, platform: 'codex', toolFingerprint: 'legacy', createdAt: i, updatedAt: i }],
      ] as const) db.query(`INSERT INTO ${table} VALUES(?,?,?)`).run(body.id, 'b', JSON.stringify(body))
    }
    expect(store.failedMemoryJobs('b').map(i => i.id)).toEqual(Array.from({ length: 10 }, (_, i) => `in${70 + i}`))
    const reopened = new BotRuntimeStore(path)
    expect(reopened.viewMemories('b').active).toHaveLength(50)
    expect(reopened.viewMemories('b').review.map(m => m.id)).toEqual(['m10'])
    reopened.close()
    const bot = { botId: 'b', ownerPhoneId: 'owner', platform: 'codex' } as any
    const service = new BotRuntimeService({ store, rootDir: root, getBot: () => bot, sendReply: async () => {} } as any)
    const original = new Map<string, any>()
    for (const name of ['tasks', 'cases', 'artifacts', 'runs', 'operations', 'memories', 'experiences'] as const) {
      original.set(name, store[name])
      store[name] = (() => { throw new Error(`刷新不能全量读取 ${name}`) }) as any
    }
    try {
    const view = service.view('b', 'owner')
    expect(view.tasks).toHaveLength(31)
    expect(view.artifacts).toHaveLength(30)
    expect(view.memory.active).toHaveLength(50)
    expect(view.memory.review.map(m => m.id)).toEqual(['m10'])
    expect(view.experiences).toHaveLength(50)
    expect(view.cases.map(c => c.id)).toContain('c0')
    } finally {
      for (const [name, fn] of original) (store as any)[name] = fn
      await service.close()
      db.close()
    }
  } finally {
    store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
})
