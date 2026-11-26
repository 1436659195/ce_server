/** 合成历史、同进程对比；不连接真实账本或模型。 */
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { caseSummary, groupByCase, relevance, selectCases } from '../src/cli/bot-runtime/cases'
import type { RuntimeTask } from '../src/cli/bot-runtime/types'
const root = `${import.meta.dir}/../.task-tmp`
mkdirSync(root, { recursive: true })
const results: unknown[] = []
// 改前cases.ts的逐卷filter算法，保留在对比脚本中，业务代码不再调用。
function selectCasesBefore(cases: Parameters<typeof selectCases>[0], tasks: Parameters<typeof selectCases>[1], artifacts: Parameters<typeof selectCases>[2], query: string) {
  return cases.map(dossier => {
    const work = tasks.filter(t => t.caseId === dossier.id && t.botId === dossier.botId)
    const files = artifacts.filter(a => a.caseId === dossier.id && a.botId === dossier.botId)
    const score = relevance(query, [dossier.title, ...(dossier.aliases ?? []), dossier.object, dossier.goal, dossier.summary, ...work.map(t => `${t.goal} ${t.summary}`), ...files.map(a => `${a.title} ${a.name ?? ''}`)].join('\n'))
    return { dossier, score, updated: Math.max(dossier.updatedAt, ...work.map(t => t.updatedAt)) }
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || b.updated - a.updated || b.dossier.createdAt - a.dossier.createdAt).slice(0, 5).map(c => c.dossier)
}
function measure(fn: () => unknown, connection: Database) {
  let parsed = 0; let sqlCalls = 0; let returnedRows = 0
  const query = connection.query.bind(connection)
  connection.query = ((sql: string) => {
    sqlCalls++
    const statement = query(sql)
    return new Proxy(statement, { get(target, property) {
      const value = (target as any)[property]
      if (property === 'all' || property === 'get') return (...args: any[]) => {
        const result = value.apply(target, args)
        returnedRows += property === 'all' ? result.length : Number(result != null)
        return result
      }
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }) as any
  const parse = JSON.parse
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parsed++; return parse(...args) }) as typeof JSON.parse
  const start = performance.now()
  try { const result = fn(); return { parsed, sqlCalls, returnedRows, ms: +(performance.now() - start).toFixed(2), result } }
  finally { JSON.parse = parse; connection.query = query as any }
}
for (const size of [100, 1000, 10000]) {
  const path = `${root}/bench-${size}.sqlite`
  rmSync(path, { force: true })
  const store = new BotRuntimeStore(path)
  const db = new Database(path)
  store.transaction(() => {
    for (let i = 0; i < size; i++) {
      store.saveCase({ id: `c${i}`, botId: 'b', title: `历史卷宗${i}`, object: '项目', goal: '目标', summary: '', createdAt: i, updatedAt: i })
      for (let j = 0; j < 3; j++) {
        const task = { id: `t${i}-${j}`, botId: 'b', caseId: `c${i}`, state: 'completed', goal: `工作${i}`, summary: '', createdAt: i * 3 + j, updatedAt: i * 3 + j } as RuntimeTask
        ;(store as any).put('tasks', task)
      }
      store.saveArtifact({ id: `a${i}`, botId: 'b', caseId: `c${i}`, taskId: `t${i}-0`, title: '历史成果', mime: 'text/plain', path: '/unused', size: 1, hash: '', revision: 1, createdAt: i })
    }
  })
  const bot = { botId: 'b', ownerPhoneId: 'owner', platform: 'codex' } as any
  const service = new BotRuntimeService({ store, rootDir: root, getBot: () => bot, sendReply: async () => {} } as any)
  // 原view中与历史有关的读取表达式；空记忆/运行记录/操作保持相同。
  const beforeView = () => {
    const tasks = store.tasks('b').slice(-30)
    return { settings: store.settings('b'), tasks, cases: store.cases('b').filter(c => tasks.some(t => t.caseId === c.id)),
      inputs: tasks.flatMap(t => store.inputs(t.id).slice(-30)), artifacts: store.artifacts('b').slice(-30),
      operations: store.operations().filter(o => o.botId === 'b' && o.state === 'unknown').slice(-30),
      recoveries: tasks.filter(t => store.runs('b').some(r => r.taskId === t.id && r.state === 'unknown')),
      failedInputs: store.failedInputs('b'), memory: { active: store.memories('b').filter(m => m.status === 'active').slice(-50), review: store.memories('b').filter(m => m.needsReview && m.status === 'active'), failedJobs: store.failedMemoryJobs('b'), log: store.memoryLog('b') },
      experiences: store.experiences('b').slice(-50), remoteOps: store.remoteOps('b', 30) }
  }
  const beforeSearch = () => selectCasesBefore(store.cases('b'), store.tasks('b'), store.artifacts('b'), '历史')
    .map(c => caseSummary(c, store.tasks('b'), store.artifacts('b')))
  const afterSearch = () => {
    const found = store.findCases('b', '历史'); const caseIds = found.map(c => c.id)
    const work = groupByCase(store.queryTasks('b', { caseIds })); const files = groupByCase(store.queryArtifacts('b', { caseIds }))
    return found.map(c => caseSummary(c, work(c), files(c)))
  }
  const connection = (store as any).db as Database
  const before = measure(beforeView, connection); const after = measure(() => service.view('b', 'owner'), connection)
  const oldSearch = measure(beforeSearch, connection); const newSearch = measure(afterSearch, connection)
  if (JSON.stringify(oldSearch.result) !== JSON.stringify(newSearch.result)) throw new Error('搜索结果不一致')
  if (JSON.stringify(before.result.tasks) !== JSON.stringify(after.result.tasks)) throw new Error('任务快照不一致')
  results.push({ cases: size, tasks: size * 3, artifacts: size,
    view: { beforeParsed: before.parsed, afterParsed: after.parsed, beforeMs: before.ms, afterMs: after.ms, beforeSql: before.sqlCalls, afterSql: after.sqlCalls, beforeRows: before.returnedRows, afterRows: after.returnedRows },
    search: { beforeParsed: oldSearch.parsed, afterParsed: newSearch.parsed, beforeMs: oldSearch.ms, afterMs: newSearch.ms, beforeSql: oldSearch.sqlCalls, afterSql: newSearch.sqlCalls, beforeRows: oldSearch.returnedRows, afterRows: newSearch.returnedRows },
    plans: {
      recent: db.query("EXPLAIN QUERY PLAN SELECT body FROM tasks WHERE bot_id='b' ORDER BY rowid DESC LIMIT 30").all(),
      active: db.query("EXPLAIN QUERY PLAN SELECT body FROM tasks WHERE bot_id='b' AND json_extract(body,'$.state')='running' ORDER BY rowid").all(),
      case: db.query("EXPLAIN QUERY PLAN SELECT body FROM artifacts WHERE bot_id='b' AND json_extract(body,'$.caseId')='c0' ORDER BY rowid").all(),
      inputs: db.query("EXPLAIN QUERY PLAN SELECT body FROM task_inputs WHERE json_extract(body,'$.taskId')='t0' ORDER BY rowid DESC LIMIT 30").all(),
    } })
  await service.close(); db.close(); store.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
}
writeFileSync(`${import.meta.dir}/../docs/plans/2026-11-26-history-reading-measurements.json`, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
