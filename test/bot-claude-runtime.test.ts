import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ClaudeRuntime } from '../src/cli/bot-runtime/claude'
import { CodexToolOutput } from '../src/cli/bot-runtime/codex'
import { BotRuntimeService } from '../src/cli/bot-runtime/service'
import { BotRuntimeStore } from '../src/cli/bot-runtime/store'
import type { RuntimeBot } from '../src/cli/bot-runtime/types'

class Queue<T> implements AsyncIterable<T> {
  values: T[] = []; waiters: Array<(v: IteratorResult<T>) => void> = []; ended = false
  push(v: T) { const waiter=this.waiters.shift(); if(waiter) waiter({value:v,done:false});else this.values.push(v) }
  end() { this.ended=true; for(const w of this.waiters.splice(0))w({value:undefined!,done:true}) }
  [Symbol.asyncIterator]() { return { next: (): Promise<IteratorResult<T>> => this.values.length ? Promise.resolve({value:this.values.shift()!,done:false}) : this.ended ? Promise.resolve({value:undefined!,done:true}) : new Promise(resolve=>this.waiters.push(resolve)) } }
}
const cleanups:Array<()=>Promise<void>>=[]
const cliHelp = '--print --input-format --output-format --replay-user-messages --include-partial-messages --tools --allowedTools --setting-sources --settings --strict-mcp-config --mcp-config --system-prompt --append-system-prompt --agents --disable-slash-commands --resume --session-id --no-session-persistence --permission-mode'
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup()})
async function until(p:()=>boolean) { for(let i=0;i<100&&!p();i++)await Bun.sleep(2);expect(p()).toBe(true) }
function fixture(handler: (call: { tool:string;arguments:Record<string,unknown> })=>Promise<unknown> = async()=>({ok:true}), accessMode?: 'full-access', emitInit = true) {
  const dir=mkdtempSync(join(tmpdir(),'ce-claude-test-'));const events=new Queue<SDKMessage>();const inputs:SDKUserMessage[]=[];let options!:Options;let closes=0;let interrupts=0
  const runtime=new ClaudeRuntime({cwd:dir,accessMode,onToolCall:handler,probe:async(args=['--version'])=> args[0]==='--version' ? '2.1.220 (Claude Code)' : cliHelp,query:({prompt,options:o})=>{
    options=o
    if(emitInit) events.push({type:'system',subtype:'init',session_id:o.resume??o.sessionId!,permissionMode:'default',tools:Object.keys((o.mcpServers!.ce_runtime as any).instance._registeredTools).map(name=>'mcp__ce_runtime__'+name)} as unknown as SDKMessage)
    void(async()=>{for await(const input of prompt){inputs.push(input);events.push({...input,session_id:o.resume??o.sessionId!} as SDKMessage)}})()
    return Object.assign(events[Symbol.asyncIterator](),{[Symbol.asyncIterator](){return this},interrupt:async()=>{interrupts++},close:()=>{closes++;events.end()}}) as unknown as Query
  }})
  cleanups.push(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true})})
  return {runtime,events,inputs,get options(){return options},get closes(){return closes},get interrupts(){return interrupts}}
}
const spec={name:'read_document',description:'Read a document',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}
function result(id:string,subtype='success'):SDKMessage {return {type:'result',subtype,session_id:id,is_error:subtype!=='success',result:'READY',errors:['model unavailable']} as unknown as SDKMessage}

test('全权限 CC 使用原生工具和默认系统提示，Shell 自动许可但结束后不能继续调用',async()=>{
 const f=fixture(undefined,'full-access');const thread=await f.runtime.startThread({instructions:'不要更改工作目录之外的文件',tools:[spec]});const turn=await f.runtime.startTurn(thread,'work')
 expect(f.options.tools).toEqual({type:'preset',preset:'claude_code'})
 expect(f.options.systemPrompt).toEqual({type:'preset',preset:'claude_code',append:'不要更改工作目录之外的文件'})
 expect(f.options.settingSources).toEqual(['user','project','local'])
 const context={signal:new AbortController().signal,toolUseID:'shell',requestId:'request'}
 expect(await f.options.canUseTool!('Bash',{command:'pwd'},context)).toMatchObject({behavior:'allow'})
 f.events.push({type:'system',subtype:'init',session_id:thread,tools:['Bash','Read','Edit','mcp__ce_runtime__read_document'],permissionMode:'default'} as unknown as SDKMessage)
 await until(()=>f.inputs.length===1);f.events.push(result(thread));expect((await turn.done).status).toBe('completed')
 expect(await f.options.canUseTool!('Bash',{command:'pwd'},context)).toMatchObject({behavior:'deny'})
})

test('CC starts with only explicit host tools and no inherited settings, MCP, hooks or skills',async()=>{
 const f=fixture();const thread=await f.runtime.startThread({instructions:'Only host tools',tools:[spec]});const turn=await f.runtime.startTurn(thread,'hello')
 await until(()=>f.inputs.length===1)
 const {tools,settingSources,strictMcpConfig,skills,permissionMode,systemPrompt,settings}=f.options
 expect({tools,settingSources,strictMcpConfig,skills,permissionMode,systemPrompt,settings}).toEqual({tools:[],settingSources:[],strictMcpConfig:true,skills:[],permissionMode:'default',systemPrompt:'Only host tools',settings:{disableAllHooks:true,autoMemoryEnabled:false,enabledPlugins:{}}})
 expect(f.options.allowedTools).toEqual([])
 expect(await f.options.canUseTool!('Bash',{command:'touch /tmp/escape'},{signal:new AbortController().signal,toolUseID:'x',requestId:'request'})).toMatchObject({behavior:'deny'})
 f.events.push(result(thread));expect((await turn.done).status).toBe('completed')
})

test('CC host tool has schema validation, real image blocks and refuses calls after turn ends',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return new CodexToolOutput([{type:'inputText',text:'图像'},{type:'inputImage',imageUrl:'data:image/png;base64,aGVsbG8='}])})
 const thread=await f.runtime.startThread({instructions:'Only host tools',tools:[spec]});const turn=await f.runtime.startTurn(thread,'read')
 const server=f.options.mcpServers!.ce_runtime
 if(server.type!=='sdk')throw new Error('SDK server required')
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.instance.connect(st);const client=new Client({name:'test',version:'1'});await client.connect(ct)
 const output=await client.callTool({name:'read_document',arguments:{path:'x'}})
 expect(output.content).toEqual([{type:'text',text:'图像'},{type:'image',mimeType:'image/png',data:'aGVsbG8='}]);expect(calls).toBe(1)
 const invalid=await client.callTool({name:'read_document',arguments:{path:34}});expect(invalid.isError).toBe(true);expect(calls).toBe(1)
 f.events.push(result(thread));await turn.done
 const stale=await client.callTool({name:'read_document',arguments:{path:'x'}});expect(stale.isError).toBe(true);expect(calls).toBe(1)
 await client.close()
})

test('CC supplementary input reaches live query immediately with now priority and validates turn identity',async()=>{
 const f=fixture();const thread=await f.runtime.startThread({instructions:'host',tools:[]});const turn=await f.runtime.startTurn(thread,'first','input-one')
 await until(()=>f.inputs.length===1)
 await f.runtime.steer(thread,turn.turnId,'add a button','input-two');await until(()=>f.inputs.length===2)
 expect(f.inputs[1]).toMatchObject({priority:'now',message:{content:[{type:'text',text:'add a button'}]}})
 await expect(f.runtime.steer(thread,'stale','unsafe')).rejects.toThrow(/轮次/)
 f.events.push(result(thread));expect((await turn.done).status).toBe('completed')
})

test('CC resumes exact session with controlled tools and propagates model errors and close',async()=>{
 const f=fixture();const id='a4c52143-34b7-45b8-9278-425f12345678'
 expect(await f.runtime.resumeThread(id,{instructions:'resumed',tools:[]})).toBe(id)
 const turn=await f.runtime.startTurn(id,'continue');expect(f.options.resume).toBe(id);expect(f.options.sessionId).toBeUndefined()
 f.events.push(result(id,'error_during_execution'));expect((await turn.done).status).toBe('failed')
 const next=await f.runtime.startTurn(id,'retry');const done=next.done.catch(e=>e)
 await f.runtime.close();expect(await done).toBeInstanceOf(Error);expect(f.closes).toBe(1)
})

test('CC accepts a new CLI version when required interfaces exist',async()=>{
 const runtime=new ClaudeRuntime({cwd:tmpdir(),onToolCall:async()=>{},probe:async(args=['--version'])=>args[0]==='--version'?'9.0.0 (Claude Code)':cliHelp,query:()=>{throw new Error('initialization must not call model')}})
 await runtime.initialize();await runtime.close()
})

test('CC rejects missing isolation capability before starting a query',async()=>{
 const runtime=new ClaudeRuntime({cwd:tmpdir(),onToolCall:async()=>{},probe:async(args=['--version'])=>args[0]==='--version'?'9.0.1 (Claude Code)':cliHelp.replace('--strict-mcp-config',''),query:()=>{throw new Error('must not spawn')}})
 await expect(runtime.initialize()).rejects.toThrow('strict-mcp-config');await runtime.close()
})

test('CC model authentication errors remain distinct from protocol failures and never expose credentials',async()=>{
 const f=fixture();const thread=await f.runtime.startThread({instructions:'host',tools:[]});const turn=await f.runtime.startTurn(thread,'hello')
 f.events.push({...result(thread,'error_during_execution'),errors:['401 authentication failed api_key=private-test-key']} as unknown as SDKMessage)
 const final=await turn.done
 expect(final.error?.message).toMatch(/登录|认证/)
 expect(final.error?.message).not.toMatch(/private-test-key|版本/)
})

test('onboarding checks both roles with actual model turns before enabling CC',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ce-onboard-probe-'));const store=new BotRuntimeStore(join(dir,'runtime.sqlite'))
 const bot:RuntimeBot={botId:'b',name:'Bot',ownerPhoneId:'owner',groupId:'dm',sourceCwd:dir,directory:dir,platform:'claude',commandSandbox:false,policyRevision:1,permissions:{version:1,directory:'.',read:'allow',create:'deny',edit:'deny',delete:'deny',execute:'deny',commanders:'owner',allowedPhoneIds:[]}}
 const checked:string[]=[];let failWorker=true;let proveTool=true
 const service=new BotRuntimeService({store,rootDir:dir,getBot:()=>bot,sendReply:async()=>{},checkAccess:async()=>{throw new Error('no tools')},openTools:()=>{throw new Error('no tools')},createClient:(role,clientOptions)=>({initialize:async()=>{},startThread:async options=>{expect(options.tools.map(t=>t.name)).toEqual(['ce_runtime_check']);return role},resumeThread:async id=>id,startTurn:async(id,text)=>{checked.push(role);if(proveTool)await clientOptions.onToolCall({tool:'ce_runtime_check',threadId:id,turnId:'probe',callId:'check',arguments:{nonce:JSON.parse(text).nonce}});return{threadId:id,turnId:'probe',done:Promise.resolve({id:'probe',status:role==='worker'&&failWorker?'failed':'completed'})}},steer:async()=>'',interrupt:async()=>{},close:async()=>{}})})
 cleanups.push(async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true})})
 await expect(service.initializeBot('b','owner','写报告')).rejects.toThrow(/Worker|worker/)
 expect(store.settings('b').mode).toBe('legacy');expect(checked).toEqual(['router','worker'])
 failWorker=false;proveTool=false;await expect(service.initializeBot('b','owner','写报告')).rejects.toThrow(/宿主工具/);expect(store.settings('b').mode).toBe('legacy');proveTool=true;const initialized=await service.initializeBot('b','owner','写报告')
 expect(initialized.settings).toMatchObject({mode:'router-worker',profile:'写报告'});expect(initialized.capabilities.activeInput).toBe(true)
 await expect(service.initializeBot('b','stranger','other')).rejects.toThrow(/owner/)
})

test('CC rejects inherited tools advertised by CLI initialization before any host work', async () => {
 const f=fixture();const thread=await f.runtime.startThread({instructions:'host',tools:[]});const turn=await f.runtime.startTurn(thread,'hello')
 f.events.push({type:'system',subtype:'init',session_id:thread,tools:['Bash']} as unknown as SDKMessage)
 await expect(turn.done).rejects.toThrow(/CC/);expect(f.closes).toBe(1)
})

test('CC initialization must advertise every required host tool', async () => {
 const f=fixture();const thread=await f.runtime.startThread({instructions:'host',tools:[spec]});const turn=await f.runtime.startTurn(thread,'hello')
 f.events.push({type:'system',subtype:'init',session_id:thread,tools:[],permissionMode:'default'} as unknown as SDKMessage)
 await expect(turn.done).rejects.toThrow(/工具/)
})

test('CC without initialization metadata cannot execute host tools or accept a completed result', async () => {
 let calls=0;const f=fixture(async()=>{calls++;return{}},undefined,false)
 const thread=await f.runtime.startThread({instructions:'host',tools:[spec]});const turn=await f.runtime.startTurn(thread,'hello')
 const server=f.options.mcpServers!.ce_runtime;if(server.type!=='sdk')throw new Error('SDK server required')
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.instance.connect(st);const client=new Client({name:'test',version:'1'});await client.connect(ct)
 const output=await client.callTool({name:spec.name,arguments:{path:'x'}})
 expect(output.isError).toBe(true);expect(calls).toBe(0)
 f.events.push(result(thread));await expect(turn.done).rejects.toThrow(/初始化/)
 await client.close()
})

test('CC authentication failure before system init reports login rather than incompatible metadata', async () => {
 const f=fixture(undefined,undefined,false);const thread=await f.runtime.startThread({instructions:'host',tools:[]});const turn=await f.runtime.startTurn(thread,'hello')
 f.events.push({...result(thread,'error_during_execution'),errors:['401 authentication failed secret=private-test-key']} as unknown as SDKMessage)
 await expect(turn.done).rejects.toThrow(/登录|认证/)
})

test('CC refuses unexpected effective permissions even when no extra tools are listed', async () => {
 const f=fixture();const thread=await f.runtime.startThread({instructions:'host',tools:[]});const turn=await f.runtime.startTurn(thread,'hello')
 f.events.push({type:'system',subtype:'init',session_id:thread,tools:[],permissionMode:'bypassPermissions'} as unknown as SDKMessage)
 await expect(turn.done).rejects.toThrow(/权限/)
})

test('CC does not finish on an earlier result while a new input is still awaiting SDK echo', async () => {
 const f=fixture();const thread=await f.runtime.startThread({instructions:'host',tools:[]});const turn=await f.runtime.startTurn(thread,'first')
 await until(()=>f.inputs.length===1)
 // Queue the earlier completion first; steer adds its pending input synchronously.
 f.events.push(result(thread));await f.runtime.steer(thread,turn.turnId,'second')
 let finished=false;void turn.done.then(()=>{finished=true})
 await until(()=>f.inputs.length===2);await Bun.sleep(5);expect(finished).toBe(false)
 f.events.push(result(thread));expect((await turn.done).status).toBe('completed')
})

test('closing during CLI detection prevents a late boot from starting a conversation', async () => {
 let resolve!: (version:string)=>void
 const runtime=new ClaudeRuntime({cwd:tmpdir(),onToolCall:async()=>{},probe:()=>new Promise(r=>{resolve=r}),query:()=>{throw new Error('must not boot')}})
 const initialization=runtime.initialize();await runtime.close();resolve('2.1.220 (Claude Code)')
 await expect(initialization).rejects.toThrow(/关闭/)
})

test('CC replay after immediate input reuses a pending write result once instead of executing twice', async () => {
 let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve});let calls=0
 const f=fixture(async()=>{calls++;await waiting;return {operationId:'op-one'}})
 const write={...spec,name:'project_run_command'}
 const thread=await f.runtime.startThread({instructions:'host',tools:[write]});const turn=await f.runtime.startTurn(thread,'write')
 const server=f.options.mcpServers!.ce_runtime;if(server.type!=='sdk')throw new Error('SDK server required')
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.instance.connect(st);const client=new Client({name:'test',version:'1'});await client.connect(ct)
 const first=client.callTool({name:write.name,arguments:{path:'x'}});await until(()=>calls===1)
 await f.runtime.steer(thread,turn.turnId,'also change button');release();const original=await first
 const replay=await client.callTool({name:write.name,arguments:{path:'x'}});expect(replay.content).toEqual(original.content);expect(calls).toBe(1)
 await client.callTool({name:write.name,arguments:{path:'x'}});expect(calls).toBe(2)
 f.events.push(result(thread));await turn.done;await client.close()
})
