import { expect, test } from 'bun:test'
import { evaluateMetric, validateCondition, type MetricCondition, type MetricState } from '../src/cli/bot-runtime/automation/conditions'
import { createHostMetricCollector } from '../src/cli/bot-runtime/automation/collectors'

const condition:MetricCondition={kind:'metric',targetId:'host',metric:'cpu.utilization',above:90,sustainMs:90_000,recoverBelow:75,cooldownMs:300_000}
const sample=(value:number,at:number)=>({value,at})
test('sustained threshold uses sample timestamps and does not mutate prior state',()=>{
  let state:MetricState|undefined
  for(const t of [0,30_000,60_000]){const next=evaluateMetric(condition,state,sample(95,t),t);expect(next.fire).toBe(false);state=next.state}
  const snapshot=structuredClone(state)
  const fired=evaluateMetric(condition,state,sample(95,90_000),90_000)
  expect(fired.fire).toBe(true);expect(fired.message).toContain('95');expect(state).toEqual(snapshot)
  expect(evaluateMetric(condition,fired.state,sample(99,120_000),120_000).fire).toBe(false)
})
test('hysteresis requires recovery and cooldown before a fresh alert',()=>{
  const c={...condition,sustainMs:0}
  const first=evaluateMetric(c,undefined,sample(95,0),0)
  const between=evaluateMetric(c,first.state,sample(80,30_000),30_000)
  expect(evaluateMetric(c,between.state,sample(95,60_000),60_000).fire).toBe(false)
  const recovered=evaluateMetric(c,between.state,sample(70,60_000),60_000)
  expect(evaluateMetric(c,recovered.state,sample(95,90_000),90_000).fire).toBe(false)
  expect(evaluateMetric(c,recovered.state,sample(95,300_000),300_000).fire).toBe(true)
})
test('missing samples reset continuous duration',()=>{
  const first=evaluateMetric(condition,undefined,sample(95,0),0)
  const afterGap=evaluateMetric(condition,first.state,sample(95,120_000),120_000)
  expect(afterGap.fire).toBe(false)
})
test('below-threshold sample resets pending continuous duration',()=>{
  const first=evaluateMetric(condition,undefined,sample(95,0),0)
  const low=evaluateMetric(condition,first.state,sample(89,30_000),30_000)
  expect(evaluateMetric(condition,low.state,sample(95,90_000),90_000).fire).toBe(false)
})
test.each([NaN,Infinity,-1,101])('invalid metric sample is an error, never healthy zero: %s',value=>{
  expect(()=>evaluateMetric(condition,undefined,sample(value,0),0)).toThrow()
})
test('stale, future, and non-monotonic samples are refused',()=>{
  expect(()=>evaluateMetric(condition,undefined,sample(95,0),90_000)).toThrow()
  expect(()=>evaluateMetric(condition,undefined,sample(95,90_000),0)).toThrow()
  const first=evaluateMetric(condition,undefined,sample(95,30_000),30_000)
  expect(()=>evaluateMetric(condition,first.state,sample(95,0),30_000)).toThrow()
})
test('metric definition validates bounds and known names',()=>{
  expect(validateCondition(condition)).toEqual(condition)
  for(const patch of [{metric:'disk.io'},{above:101},{recoverBelow:95},{sustainMs:-1},{cooldownMs:Infinity},{targetId:''}])expect(()=>validateCondition({...condition,...patch})).toThrow()
})
test('CPU collection computes deltas with an asynchronous first sample window',async()=>{
  const times=[{idle:100,total:200},{idle:120,total:300}]
  const collect=createHostMetricCollector({cpuTimes:()=>times.shift()!,wait:async()=>{},now:()=>123_000})
  expect(await collect(condition)).toEqual({value:80,at:123_000})
})
test('disk metric reports filesystem used percentage',async()=>{
  const collect=createHostMetricCollector({disk:async()=>({blocks:100,bavail:10}),now:()=>1})
  expect(await collect({...condition,metric:'disk.usedPercent'})).toEqual({value:90,at:1})
})
test('GPU aggregation takes highest reported GPU; unavailable is explicit',async()=>{
  const collect=createHostMetricCollector({gpu:async()=> '15\n97\n',now:()=>1})
  expect(await collect({...condition,metric:'gpu.utilization'})).toEqual({value:97,at:1})
  const missing=createHostMetricCollector({gpu:async()=>{throw new Error('ENOENT')}})
  await expect(missing({...condition,metric:'gpu.utilization'})).rejects.toThrow(/GPU/)
  const malformed=createHostMetricCollector({gpu:async()=> '[Not Supported]'})
  await expect(malformed({...condition,metric:'gpu.utilization'})).rejects.toThrow(/GPU/)
})
test('unregistered remote target and pre-cancelled checks do not sample',async()=>{
  let calls=0
  const collect=createHostMetricCollector({gpu:async()=>{calls++;return '90'}})
  await expect(collect({...condition,targetId:'remote-unknown',metric:'gpu.utilization'})).rejects.toThrow(/target|目标/)
  const controller=new AbortController();controller.abort()
  await expect(collect({...condition,metric:'gpu.utilization'},controller.signal)).rejects.toThrow()
  expect(calls).toBe(0)
})

test('continuity follows a configured five-minute sample interval',()=>{
  const c={...condition,sustainMs:600_000}
  const first=evaluateMetric(c,undefined,sample(95,0),0,300_000)
  const second=evaluateMetric(c,first.state,sample(95,300_000),300_000,300_000)
  expect(evaluateMetric(c,second.state,sample(95,600_000),600_000,300_000).fire).toBe(true)
  const gap=evaluateMetric(c,first.state,sample(95,600_001),600_001,300_000)
  expect(gap.fire).toBe(false)
})

test('sample staleness uses the configured sample interval',()=>{
  expect(()=>evaluateMetric(condition,undefined,sample(95,0),300_000,300_000)).not.toThrow()
  expect(()=>evaluateMetric(condition,undefined,sample(95,0),600_001,300_000)).toThrow()
  expect(()=>evaluateMetric(condition,undefined,sample(95,0),0,NaN)).toThrow()
})

test('only the known persisted condition state fields survive evaluation',()=>{
  const previous={lastSampleAt:0,latched:false,sinceAt:0,extra:'not condition state'}
  const next=evaluateMetric(condition,previous,sample(95,30_000),30_000)
  expect(next.state).toEqual({lastSampleAt:30_000,latched:false,sinceAt:0})
})

test('oversized or non-serializable persisted trigger state is refused',()=>{
  const large={lastSampleAt:0,latched:false,extra:'x'.repeat(17*1024)}
  expect(()=>evaluateMetric(condition,large,sample(95,30_000),30_000)).toThrow(/16|state|状态/)
  const cyclic={lastSampleAt:0,latched:false} as MetricState & {extra?:unknown}
  cyclic.extra=cyclic
  expect(()=>evaluateMetric(condition,cyclic,sample(95,30_000),30_000)).toThrow(/state|状态/)
})

test('malformed persisted timestamps cannot extend a sustained threshold',()=>{
  expect(()=>evaluateMetric(condition,{lastSampleAt:0,latched:false,sinceAt:NaN},sample(95,30_000),30_000)).toThrow()
  expect(()=>evaluateMetric(condition,{lastSampleAt:0,latched:false,sinceAt:1000},sample(95,30_000),30_000)).toThrow()
})
