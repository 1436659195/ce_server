import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'

const clean: Array<() => void> = []
afterEach(() => clean.splice(0).forEach(f => f()))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ce-review-'))
  const store = new BotRuntimeStore(join(root, 'db.sqlite'))
  clean.push(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const m = store.receive({ botId:'b', groupId:'g', seq:1, senderId:'o', memberId:'m', text:'写报告，保留原文引用', createdAt:Date.now() })
  const task = store.acceptWork({ inputId:m.id, newCase:{ title:'报告', object:'材料', goal:'解读' }, goal:'写报告', acceptance:['保留引文'], mandate:{ ownerPhoneId:'o', policyRevision:1, directory:root, allowedOps:['read','create'], exclusions:[], mode:'execute' }, replies:[], executionGuidance:'报告保留原文引用' })
  store.updateTask(task.id, { state:'running' })
  store.saveArtifact({ id:'file', botId:'b', caseId:task.caseId, taskId:task.id, title:'报告', mime:'text/plain', path:join(root,'report.txt'), size:4, hash:'abc', revision:2, createdAt:Date.now() })
  return { store, task }
}
const summary = { artifactId:'file', summary:'材料分析报告', requirements:['保留原文引用'], checks:['核对引文'], limitations:[] }
test('文件摘要绑定实际快照，缺失或伪造来源不能交付', () => {
  const {store,task}=setup()
  expect(() => store.finishTask(task.id,1,'完成',['file'],undefined,[])).toThrow(/摘要/)
  expect(() => store.finishTask(task.id,1,'完成',['file'],undefined,[{...summary, artifactId:'other'}])).toThrow(/摘要/)
  store.finishTask(task.id,1,'完成',['file'],undefined,[summary])
  const source=store.pendingReplies('b').find(r=>r.author==='worker')!
  expect(source.artifactSummaries).toEqual([{...summary,hash:'abc',revision:2}])
  expect(store.task(task.id)?.review).toMatchObject({state:'pending',rounds:0})
})
test('验收不符可在同工单返工，旧结果取消，第二次完成后可验收发布', () => {
  const {store,task}=setup()
  store.finishTask(task.id,1,'完成',['file'],undefined,[summary])
  const source=store.pendingReplies('b').find(r=>r.author==='worker')!
  const addition=store.reviseWorkerResult('b',source.id,task.id,1,'缺了局限分析','保留引用，并补全局限', 'files')
  expect(store.task(task.id)).toMatchObject({state:'queued',revision:2,caseId:task.caseId,review:{state:'changes_requested',rounds:1},executionGuidance:'报告保留原文引用'})
  expect(store.replies('b').find(r=>r.id===source.id)?.state).toBe('cancelled')
  expect(addition).toMatchObject({kind:'correction',text:'缺了局限分析',executionGuidance:'保留引用，并补全局限'})
  expect(() => store.presentWorkerReply('b',source.id,['已完成'],'通过')).toThrow()
  store.consumeInput(addition.id,task.id); store.resolveInput(addition.id,task.id,'已补充')
  store.updateTask(task.id,{state:'running'})
  store.finishTask(task.id,2,'已补充',['file'],undefined,[summary])
  const revised=store.pendingReplies('b').find(r=>r.author==='worker')!
  store.presentWorkerReply('b',revised.id,['请看报告。'],'符合验收要求')
  expect(store.task(task.id)?.review).toMatchObject({state:'approved',rounds:1})
  expect(store.pendingReplies('b')).toMatchObject([{author:'router',artifactIds:['file'],format:'plain'}])
})
test('新任务及补充保留分开的执行约束与原话', () => {
  const {store,task}=setup()
  const m=store.receive({botId:'b',groupId:'g',seq:2,senderId:'o',memberId:'m',text:'再加结论',createdAt:Date.now()})
  const input=store.acceptInput({inputId:m.id,taskId:task.id,expectedRevision:1,kind:'append',replies:[],executionGuidance:'结论仍保留引文'})
  expect(input.text).toBe('再加结论')
  expect(input.executionGuidance).toBe('结论仍保留引文')
  expect(store.task(task.id)?.executionGuidance).toBe('报告保留原文引用')
})

test('三轮返工后停止自动重试，保留最终待验收结果与原授权', () => {
  const {store,task}=setup()
  for(let round=0;round<3;round++) {
    store.finishTask(task.id,round+1,'当前结果',['file'],undefined,[summary])
    const source=store.pendingReplies('b').find(r=>r.author==='worker')!
    const input=store.reviseWorkerResult('b',source.id,task.id,round+1,'补全原需求')
    store.consumeInput(input.id,task.id); store.resolveInput(input.id,task.id,'已处理')
    store.updateTask(task.id,{state:'running'})
  }
  store.finishTask(task.id,4,'仍存在局限',['file'],undefined,[summary])
  const last=store.pendingReplies('b').find(r=>r.author==='worker')!
  expect(()=>store.reviseWorkerResult('b',last.id,task.id,4,'继续返工')).toThrow(/三轮/)
  expect(store.task(task.id)).toMatchObject({state:'completed',revision:4,mandate:task.mandate,review:{state:'pending',rounds:3}})
  expect(store.pendingReplies('b').some(r=>r.id===last.id)).toBe(true)
})

test('待验收任务超过最近30条仍在控制视图中保留', () => {
  const {store,task}=setup()
  store.finishTask(task.id,1,'待验收',['file'],undefined,[summary])
  for(let seq=2;seq<=33;seq++) {
    const m=store.receive({botId:'b',groupId:'g',seq,senderId:'o',memberId:'m',text:'其他工作',createdAt:Date.now()})
    const other=store.acceptWork({inputId:m.id,caseId:task.caseId,goal:'其他工作',acceptance:[],mandate:task.mandate,replies:[]})
    store.updateTask(other.id,{state:'completed',review:{state:'approved',rounds:0}})
  }
  expect(store.viewTasks('b').some(t=>t.id===task.id)).toBe(true)
  expect(store.viewTasks('b')).toHaveLength(31)
})
