import { routerCall } from './helpers/router-decision'
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot, RuntimeReply } from '../src/cli/bot-runtime/types'
import type { CodexTurn } from '../src/cli/bot-runtime/codex'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function until(check: () => boolean) { for (let i=0; i<300 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true) }
function fixture(seed?: (path: string) => void, bubbleGapMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-router-outlet-'))
  seed?.(join(dir, 'runtime.sqlite'))
  const store = new BotRuntimeStore(join(dir,'runtime.sqlite'))
  const bot: RuntimeBot = { botId:'b', name:'小林', groupId:'dm', ownerPhoneId:'owner', platform:'codex', sourceCwd:dir, directory:dir, policyRevision:1, commandSandbox:false,
    permissions:{version:1,directory:'.',read:'allow',create:'allow',edit:'allow',delete:'deny',execute:'deny',commanders:'owner',allowedPhoneIds:[]} }
  store.saveSettings({...store.settings('b'),mode:'router-worker',revision:1,profile:'负责运维，跟用户自然聊天。'})
  const sent: RuntimeReply[]=[]
  const turns: Array<{context:any; call:(tool:string,args:Record<string,unknown>)=>Promise<any>; decide:(args:Record<string,unknown>)=>Promise<any>;finish:(status?:string)=>void}>=[]
  let offline=false
  const service = new BotRuntimeService({store,rootDir:dir,routerQuietMs:0,bubbleGapMs,getBot:()=>bot,
    sendReply:async r=>{if(offline) throw new Error('offline');sent.push(r)},checkAccess:async()=>{throw new Error('no work')},openTools:()=>{throw new Error('no work')},
    createClient:(role,options)=>{
      expect(role).toBe('router'); let finish:((v:CodexTurn)=>void)|undefined
      return {initialize:async()=>{},startThread:async()=> 'thread',resumeThread:async id=>id,
        startTurn:async(threadId,text)=>{
          const turnId=`turn-${turns.length}`;const done=new Promise<CodexTurn>(r=>{finish=r});const resolve=finish!
          turns.push({context:JSON.parse(text),call:(tool,args)=>options.onToolCall({threadId,turnId,callId:turnId,tool,arguments:args}),decide:args=>options.onToolCall({threadId,turnId,callId:turnId,tool:'router_decide',arguments:routerCall({action:'reply',feasibility:'can',...args})}),finish:(status='completed')=>resolve({id:turnId,status})})
          return{threadId,turnId,done}
        },steer:async()=>'',interrupt:async()=>{},close:async()=>{finish?.({id:'closed',status:'interrupted'})}}
    }})
  let seq=0
  const send=(text:string)=>service.receive('b',{groupId:'dm',seq:++seq,text,senderId:'owner',memberId:'om',createdAt:Date.now()})
  const origin=store.receive({botId:'b',groupId:'dm',seq:++seq,text:'示例引擎是什么，和示例控制台什么关系',senderId:'owner',memberId:'om',createdAt:Date.now()})
  const task=store.acceptWork({inputId:origin.id,newCase:{title:'产品关系',object:'示例引擎',goal:'理解产品'},goal:origin.text,acceptance:[],replies:[],mandate:{ownerPhoneId:'owner',policyRevision:1,directory:dir,allowedOps:['read'],exclusions:[],mode:'execute'}})
  store.updateTask(task.id,{state:'running'})
  const output=(text='示例引擎是语义引擎，示例控制台是管理平台。来源：内部资料§3.4。',extra:Partial<RuntimeReply>={})=>store.reply({botId:'b',groupId:'dm',author:'worker',purpose:'answer',text,policyRevision:1,inputId:origin.id,taskId:task.id,taskRevision:1,key:crypto.randomUUID(),...extra})
  cleanups.push(async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true})})
  return{store,bot,task,origin,service,sent,turns,send,output,setOffline:(v:boolean)=>{offline=v}}
}

test('Worker内部原文不能直发，必须经同一个Router生成对外回复',async()=>{
  const f=fixture();const source=f.output()
  expect(f.service.maySend(source)).toBe(false)
  await f.service.flush('b');expect(f.sent).toHaveLength(0)
  await until(()=>f.turns.length===1)
  expect(f.turns[0].context.workerMessage).toMatchObject({id:source.id,text:source.text})
  expect(f.turns[0].context.currentMessages).toEqual([])
  await f.turns[0].decide({workerReplyId:source.id,replies:['示例引擎负责理解用户的话，示例控制台是使用它的管理平台。']});f.turns[0].finish()
  await until(()=>f.sent.length===1)
  expect(f.sent[0]).toMatchObject({author:'router',sourceReplyId:source.id,taskId:f.task.id,purpose:'answer',inputId:f.origin.id})
  expect(f.sent[0].text).not.toContain('来源')
  expect(f.store.replies('b').find(r=>r.id===source.id)).toMatchObject({state:'routed',text:source.text})
})

test('文件引用由宿主绑定到前台输出，模型不能用空气泡吞掉文件',async()=>{
  const f=fixture();f.store.saveArtifact({id:'artifact-a',botId:'b',caseId:f.task.caseId,taskId:f.task.id,title:'报告',mime:'text/html',path:join(f.bot.directory,'report.html'),size:20,hash:'hash',revision:1,createdAt:Date.now()})
  const source=f.output('报告已完成，实际文件已导出。',{purpose:'result',artifactIds:['artifact-a']})
  await f.service.flush('b');await until(()=>f.turns.length===1)
  await expect(f.turns[0].decide({workerReplyId:source.id,replies:[]})).rejects.toThrow(/文件|附件/)
  await f.turns[0].decide({workerReplyId:source.id,replies:['报告好了。','文件在这里。']});f.turns[0].finish()
  await until(()=>f.sent.length===2)
  expect(f.sent.flatMap(r=>r.artifactIds??[])).toEqual(['artifact-a'])
  expect(f.sent.every(r=>r.author==='router'&&r.sourceReplyId===source.id)).toBe(true)
})

test('必要问题必须由前台提出并保留questionId，不能静默丢弃',async()=>{
  const f=fixture();f.store.updateTask(f.task.id,{state:'waiting_user',question:{id:'q1',text:'报告给谁看？',options:['技术','业务'],createdAt:Date.now()}})
  const source=f.output('报告面向技术人员还是业务人员？',{purpose:'question',questionId:'q1'})
  await f.service.flush('b');await until(()=>f.turns.length===1)
  await expect(f.turns[0].decide({workerReplyId:source.id,replies:[]})).rejects.toThrow(/必要问题/)
  await f.turns[0].decide({workerReplyId:source.id,replies:['这份报告是给技术同事还是业务同事看的？']});f.turns[0].finish()
  await until(()=>f.sent.length===1);expect(f.sent[0]).toMatchObject({author:'router',questionId:'q1',purpose:'question'})
})

test('整理Worker结果时有新消息，旧表达失效后带上用户原话重新判断',async()=>{
  const f=fixture();const source=f.output();await f.service.flush('b');await until(()=>f.turns.length===1)
  const message=f.send('只用一句话说它们的关系')
  expect(await f.turns[0].decide({workerReplyId:source.id,replies:['旧回复']})).toMatchObject({superseded:true});f.turns[0].finish()
  await until(()=>f.turns.length===2)
  expect(f.turns[1].context.currentMessages[0].id).toBe(message.id)
  expect(f.turns[1].context.workerMessage.id).toBe(source.id)
  await f.turns[1].decide({workerReplyId:source.id,workerReplyIndexes:[0],replies:['示例控制台是使用示例引擎语义引擎的管理平台。']});f.turns[1].finish()
  await until(()=>f.sent.length===1);expect(f.store.inbox(message.id)?.state).toBe('routed')
})

test('内部Worker结果不能当新用户命令派工',async()=>{
  const f=fixture();const source=f.output();await f.service.flush('b');await until(()=>f.turns.length===1)
  await expect(f.turns[0].decide({action:'start',workerReplyId:source.id,replies:['再派一个'],delivery:'chat',goal:'重复工作',newCase:{title:'重复',object:'重复',goal:'重复'},allowedOps:['read']})).rejects.toThrow(/内部|用户/)
  expect(f.store.tasks('b')).toHaveLength(1);expect(f.sent).toHaveLength(0)
})

test('前台失败保留Worker原文，不退回直发；新用户输入可以触发重试',async()=>{
  const f=fixture();const source=f.output();await f.service.flush('b');await until(()=>f.turns.length===1)
  f.turns[0].finish('failed');await until(()=>!!f.store.settings('b').error)
  expect(f.sent).toHaveLength(0);expect(f.store.replies('b').find(r=>r.id===source.id)?.state).toBe('pending')
  f.send('刚才的结果呢');await until(()=>f.turns.length===2)
  await f.turns[1].decide({workerReplyId:source.id,workerReplyIndexes:[0],replies:['示例引擎是语义引擎，示例控制台是用它的管理平台。']});f.turns[1].finish()
  await until(()=>f.sent.length===1)
})

test('前台生成后的网络重试保持相同编号，不再调用模型',async()=>{
  const f=fixture();f.setOffline(true);const source=f.output();await f.service.flush('b');await until(()=>f.turns.length===1)
  await f.turns[0].decide({workerReplyId:source.id,replies:['查清楚了，示例控制台使用示例引擎提供语义理解。']});f.turns[0].finish()
  await until(()=>f.store.replies('b').some(r=>r.author==='router'&&!!r.attemptedAt))
  const pending=f.store.pendingReplies('b').find(r=>r.author==='router')!
  f.setOffline(false);await f.service.flush('b')
  expect(f.sent.map(r=>r.id)).toEqual([pending.id]);expect(f.turns).toHaveLength(1)
})

test('Worker结果到达时废弃尚未提交的旧前台表达，合并用户消息与结果',async()=>{
  const f=fixture();const input=f.send('结果出来了吗');await until(()=>f.turns.length===1)
  const source=f.output();await f.service.flush('b')
  expect(await f.turns[0].decide({replies:['旧的等待回复']})).toMatchObject({superseded:true});f.turns[0].finish()
  await until(()=>f.turns.length===2)
  expect(f.turns[1].context.currentMessages[0].id).toBe(input.id)
  await f.turns[1].decide({workerReplyId:source.id,workerReplyIndexes:[0],replies:['结果有了，示例控制台使用示例引擎。']});f.turns[1].finish()
  await until(()=>f.sent.length===1);expect(f.sent[0].text).not.toContain('等待')
})

test('用户回答必要问题后，整理中的旧问题失效并按新消息重新判断',async()=>{
  const f=fixture();f.store.updateTask(f.task.id,{state:'waiting_user',question:{id:'q1',text:'给谁看',options:[],createdAt:Date.now()}})
  const source=f.output('给谁看？',{purpose:'question',questionId:'q1'})
  await f.service.flush('b');await until(()=>f.turns.length===1)
  const answer=f.store.receive({botId:'b',groupId:'dm',seq:50,senderId:'owner',memberId:'om',text:'给技术同事',createdAt:Date.now()})
  f.store.acceptInput({inputId:answer.id,taskId:f.task.id,expectedRevision:1,kind:'answer',replies:[]})
  expect(await f.turns[0].decide({workerReplyId:source.id,replies:['给谁看？']})).toMatchObject({superseded:true});f.turns[0].finish()
  await until(()=>f.store.replies('b').find(r=>r.id===source.id)?.state==='cancelled')
  expect(f.sent).toEqual([])
})

test('合并处理新指令时，若会吞掉附件必须回滚工单与原输入',async()=>{
  const f=fixture();const source=f.output('附件报告已生成',{purpose:'result',artifactIds:['file-1']})
  const input=f.send('再调查另一个问题');await until(()=>f.turns.length===1)
  await expect(f.turns[0].decide({workerReplyId:source.id,workerReplyIndexes:[],action:'start',delivery:'chat',newCase:{title:'新问题',object:'对象B',goal:'调查'},goal:'调查新问题',allowedOps:['read'],replies:[]})).rejects.toThrow(/附件|文件/)
  expect(f.store.tasks('b')).toHaveLength(1);expect(f.store.inbox(input.id)?.state).toBe('pending')
  expect(f.store.replies('b').find(r=>r.id===source.id)?.state).toBe('pending')
})

test('新话不能取消尚未送出的必要问题与文件气泡',async()=>{
  const f=fixture();f.setOffline(true)
  const source=f.output('报告准备好了',{purpose:'result',artifactIds:['file-1']})
  // 让新输入先暂停发送，再由Router判断旧气泡；无需模拟网络请求。
  f.store.presentWorkerReply('b',source.id,['文件在这。'],'')
  const delivery=f.store.pendingReplies('b')[0]
  f.send('哈哈');await until(()=>f.turns.length===1)
  await expect(f.turns[0].decide({replies:[],cancelReplyIds:[delivery.id]})).rejects.toThrow(/取消/)
  expect(f.store.pendingReplies('b').some(r=>r.id===delivery.id)).toBe(true)
})

test('内部长结果保留证据，前台仍必须把完整回复控制在100字内',async()=>{
  const f=fixture();const source=f.output('事实及证据。'.repeat(50))
  await f.service.flush('b');await until(()=>f.turns.length===1)
  expect(f.turns[0].context.workerMessage.text).toBe(source.text)
  await expect(f.turns[0].decide({workerReplyId:source.id,replies:['字'.repeat(101)]})).rejects.toThrow(/100/)
  expect(()=>f.output('字'.repeat(4001))).toThrow(/4000/)
  await f.turns[0].decide({workerReplyId:source.id,replies:['已经核对，结论成立。']});f.turns[0].finish()
  await until(()=>f.sent.length===1)
})


test('升级仅续传旧版本已开始发送的消息，保留原ID和内容且新Worker无直发权',async()=>{
  const legacy = {id:'legacy-in-flight',key:'legacy',botId:'b',groupId:'dm',author:'worker',purpose:'answer',text:'升级前已经开始发送的结果',state:'pending',policyRevision:1,createdAt:1,attemptedAt:2}
  const f=fixture(path=>{
    const db=new Database(path,{create:true});db.exec('CREATE TABLE outbox (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, body TEXT NOT NULL); PRAGMA user_version=1;')
    db.query('INSERT INTO outbox VALUES (?,?,?)').run(legacy.id,'b',JSON.stringify(legacy));db.close()
  })
  await f.service.flush('b');await until(()=>f.sent.length===1)
  expect(f.sent[0]).toMatchObject(legacy);expect(f.turns).toHaveLength(0)
  expect(f.service.maySend(f.output())).toBe(false)
})

test('前台只在有依据时省略重复结果，并持久保存省略理由',async()=>{
  const f=fixture();const source=f.output('重复的已知结果')
  await f.service.flush('b');await until(()=>f.turns.length===1)
  await expect(f.turns[0].decide({workerReplyId:source.id,replies:[]})).rejects.toThrow(/依据/)
  await f.turns[0].decide({workerReplyId:source.id,replies:[],basis:'该事实刚刚已经告知用户，没有新增信息'});f.turns[0].finish()
  await until(()=>f.store.replies('b').find(r=>r.id===source.id)?.state==='routed')
  expect(f.store.replies('b').find(r=>r.id===source.id)).toHaveProperty('routingBasis','该事实刚刚已经告知用户，没有新增信息')
  expect(f.sent).toEqual([])
})


test('混合气泡分别绑定用户请求和Worker问题，问题解决后不丢无关回答',async()=>{
  const f=fixture(undefined,80)
  f.store.updateTask(f.task.id,{state:'waiting_user',question:{id:'q1',text:'报告给谁看',options:[],createdAt:Date.now()}})
  const source=f.output('报告给技术还是业务同事看？',{purpose:'question',questionId:'q1'})
  const name=f.send('顺便问下，你叫什么名字？');await until(()=>f.turns.length===1)
  await f.turns[0].decide({workerReplyId:source.id,workerReplyIndexes:[0],replies:['报告是给技术还是业务同事看的？','我叫小林。']});f.turns[0].finish()
  await until(()=>f.sent.length===1)
  const answer=f.store.receive({botId:'b',groupId:'dm',seq:99,text:'给业务同事',senderId:'owner',memberId:'om',createdAt:Date.now()})
  f.store.acceptInput({inputId:answer.id,taskId:f.task.id,expectedRevision:1,kind:'answer',replies:[]})
  await f.service.flush('b');await until(()=>f.sent.length===2)
  expect(f.sent[1]).toMatchObject({text:'我叫小林。',inputId:name.id,purpose:'chat'})
  expect(f.sent[1].questionId).toBeUndefined();expect(f.sent[1].sourceReplyId).toBeUndefined()
})


test('宿主绑定已见版本而非提交时最新版本，重新查询后才可接受更新',async()=>{
  const f=fixture();const current=f.send('现在进展如何');await until(()=>f.turns.length===1)
  const other=f.store.receive({botId:'b',groupId:'dm',seq:99,text:'另一入口补充要求',senderId:'owner',memberId:'om',createdAt:Date.now()})
  f.store.acceptInput({inputId:other.id,taskId:f.task.id,expectedRevision:1,kind:'append',replies:[]})
  await expect(f.turns[0].decide({action:'ask_worker',taskId:f.task.id,replies:[]})).rejects.toThrow(/版本/)
  expect(f.store.inbox(current.id)?.state).toBe('pending');expect(f.store.inputs(f.task.id)).toHaveLength(1)
  expect(await f.turns[0].call('task_inspect',{taskId:f.task.id})).toHaveProperty('revision',2)
  await f.turns[0].decide({action:'ask_worker',taskId:f.task.id,replies:[]});f.turns[0].finish()
  expect(f.store.inputs(f.task.id).find(i=>i.inboxId===current.id)).toMatchObject({kind:'ask_worker',revision:3})
})

test('Worker结果单独到来：这一轮只压短，查询工具被拒，读取预算为0',async()=>{
  const f=fixture();const source=f.output();await f.service.flush('b');await until(()=>f.turns.length===1)
  expect(f.turns[0].context.toolsLocked).toBe(true)
  await expect(f.turns[0].call('chat_recent',{})).rejects.toThrow(/不提供查询/)
  await f.turns[0].decide({workerReplyId:source.id,replies:['示例引擎是语义引擎，示例控制台是管理平台。']});f.turns[0].finish()
  await until(()=>f.sent.length===1);expect(f.sent[0].text).not.toContain('来源')
})

test('Worker开工后主人说过话：结果那一轮保留查询工具',async()=>{
  const f=fixture()
  f.store.saveRun({id:'run-1',botId:'b',taskId:f.task.id,state:'exited',createdAt:Date.now(),updatedAt:Date.now()})
  f.store.updateTask(f.task.id,{latestRunId:'run-1'})
  await Bun.sleep(10)
  f.send('在吗');await until(()=>f.turns.length===1)
  await f.turns[0].decide({replies:['在。']});f.turns[0].finish()
  await until(()=>f.sent.length===1)
  const source=f.output('结果如下',{runId:'run-1'});await f.service.flush('b');await until(()=>f.turns.length===2)
  expect(f.turns[1].context.toolsLocked).toBeUndefined()
  expect(await f.turns[1].call('chat_recent',{})).toBeInstanceOf(Array)
  await f.turns[1].decide({workerReplyId:source.id,replies:['示例引擎是语义引擎，示例控制台是管理平台。']});f.turns[1].finish()
  await until(()=>f.sent.length===2)
})

test('任务停止后待整理的结果被取消，不再进入前台',async()=>{
  const f=fixture();const source=f.output();await f.service.flush('b');await until(()=>f.turns.length===1)
  await f.service.control('b','owner',{action:'stop',taskId:f.task.id,expectedRevision:1,requestId:'stop-before-present'})
  expect(await f.turns[0].decide({workerReplyId:source.id,replies:['旧结果']})).toMatchObject({superseded:true});f.turns[0].finish()
  await until(()=>f.store.replies('b').find(r=>r.id===source.id)?.state==='cancelled')
  await Bun.sleep(30);expect(f.turns).toHaveLength(1);expect(f.sent).toHaveLength(0)
})

test('决策提交后的收尾超时不算失败：不写错误，回复照发，不重跑',async()=>{
  const f=fixture();const input=f.send('在吗');await until(()=>f.turns.length===1)
  await f.turns[0].decide({replies:['在。']});f.turns[0].finish('failed')
  await until(()=>f.sent.length===1)
  await Bun.sleep(30)
  expect(f.store.settings('b').error).toBeUndefined()
  expect(f.store.inbox(input.id)?.state).toBe('routed')
  expect(f.turns).toHaveLength(1)
})

test('同一任务的必要问题已替换时，不把用户答案自动套用到最新问题',async()=>{
  const f=fixture();f.store.updateTask(f.task.id,{state:'waiting_user',question:{id:'q-old',text:'给谁看',options:[],createdAt:Date.now()}})
  const input=f.send('给技术同事');await until(()=>f.turns.length===1)
  f.store.updateTask(f.task.id,{question:{id:'q-new',text:'需要删除旧报告吗',options:[],createdAt:Date.now()}})
  await expect(f.turns[0].decide({action:'answer',taskId:f.task.id,replies:[]})).rejects.toThrow(/问题/)
  expect(f.store.inbox(input.id)?.state).toBe('pending');expect(f.store.inputs(f.task.id)).toEqual([])
})

test('隐藏工单只有成功披露后可提交，超预算查询不会登记为已读',async()=>{
  const f=fixture()
  for(let i=0;i<6;i++){
    const input=f.store.receive({botId:'b',groupId:'dm',seq:100+i,text:`其他事项${i}`,senderId:'owner',memberId:'om',createdAt:Date.now()})
    const t=f.store.acceptWork({inputId:input.id,newCase:{title:`其他事项${i}`,object:`对象${i}`,goal:'查看'},goal:'查看',acceptance:[],replies:[],mandate:f.task.mandate})
    f.store.updateTask(t.id,{state:'completed'})
  }
  f.send('查一下之前的工作');await until(()=>f.turns.length===1)
  expect(f.turns[0].context.tasks.some((t:{id:string})=>t.id===f.task.id)).toBe(false)
  await expect(f.turns[0].decide({action:'ask_worker',taskId:f.task.id,replies:[]})).rejects.toThrow(/披露|核对/)
  f.store.updateTask(f.task.id,{question:{id:'oversize',text:'说明'.repeat(3000),options:[],createdAt:Date.now()}})
  await expect(f.turns[0].call('task_inspect',{taskId:f.task.id})).rejects.toThrow(/预算/)
  await expect(f.turns[0].decide({action:'ask_worker',taskId:f.task.id,replies:[]})).rejects.toThrow(/披露|核对/)
  f.store.updateTask(f.task.id,{question:undefined})
  await f.turns[0].call('task_inspect',{taskId:f.task.id})
  await f.turns[0].decide({action:'ask_worker',taskId:f.task.id,replies:[]});f.turns[0].finish()
  expect(f.store.inputs(f.task.id)).toHaveLength(1)
})
