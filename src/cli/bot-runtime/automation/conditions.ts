/** Host-only condition gates use OpenClaw's fire/message/state contract.
 * No model is invoked for a quiet sample. JSON state is bounded to 16KiB.
 */
export interface MetricCondition {
  kind: 'metric'
  targetId: string
  metric: 'cpu.utilization' | 'gpu.utilization' | 'disk.usedPercent'
  above: number
  sustainMs: number
  recoverBelow: number
  cooldownMs: number
}
export interface MetricState {
  sinceAt?: number
  lastSampleAt: number
  latched: boolean
  lastFiredAt?: number
}
export interface MetricSample { value: number; at: number }
const MIN_MAX_GAP_MS=60_000
const MAX_STATE_BYTES=16*1024

export function validateCondition(input:unknown):MetricCondition {
  if(!input || typeof input!=='object' || Array.isArray(input))throw new Error('指标条件无效')
  const c=input as Record<string,unknown>
  if(c.kind!=='metric' || typeof c.targetId!=='string' || !c.targetId.trim() || c.targetId.length>150 || !['cpu.utilization','gpu.utilization','disk.usedPercent'].includes(String(c.metric)))throw new Error('指标或目标无效')
  const number=(key:string,max:number) => {
    const v=c[key]
    if(typeof v!=='number' || !Number.isFinite(v) || v<0 || v>max)throw new Error(`指标条件${key}无效`)
    return v
  }
  const above=number('above',100),recoverBelow=number('recoverBelow',100)
  if(recoverBelow>=above)throw new Error('恢复阈值必须低于触发阈值')
  return {kind:'metric',targetId:c.targetId.trim(),metric:c.metric as MetricCondition['metric'],above,recoverBelow,sustainMs:number('sustainMs',30*86_400_000),cooldownMs:number('cooldownMs',30*86_400_000)}
}

function validateState(state:MetricState):void {
  let json:string|undefined
  try {json=JSON.stringify(state)} catch {throw new Error('指标状态state无法序列化')}
  if(json===undefined || Buffer.byteLength(json,'utf8')>MAX_STATE_BYTES)throw new Error('指标状态state超过16KB或无法序列化')
  const timestamp=(value:unknown)=>typeof value==='number' && Number.isSafeInteger(value) && Math.abs(value)<=8_640_000_000_000_000
  if(!timestamp(state.lastSampleAt) || typeof state.latched!=='boolean' || state.sinceAt!==undefined && (!timestamp(state.sinceAt) || state.sinceAt>state.lastSampleAt) || state.lastFiredAt!==undefined && (!timestamp(state.lastFiredAt) || state.lastFiredAt>state.lastSampleAt))throw new Error('指标状态state字段无效')
}

export function evaluateMetric(condition:MetricCondition,previous:MetricState|undefined,sample:MetricSample,nowMs:number,expectedIntervalMs:number=30_000):{fire:boolean;message?:string;state:MetricState} {
  if(!Number.isSafeInteger(expectedIntervalMs) || expectedIntervalMs<=0)throw new Error('指标采样周期无效')
  const maxGapMs=Math.max(MIN_MAX_GAP_MS,Math.min(Number.MAX_SAFE_INTEGER,expectedIntervalMs*2))
  if(previous!==undefined)validateState(previous)
  if(!Number.isFinite(nowMs) || !Number.isFinite(sample.value) || sample.value<0 || sample.value>100 || !Number.isSafeInteger(sample.at) || sample.at>nowMs || nowMs-sample.at>maxGapMs || previous && sample.at<=previous.lastSampleAt)throw new Error('指标样本无效、过期或时间顺序错误')
  const state:MetricState={lastSampleAt:sample.at,latched:previous?.latched??false,
    ...(previous?.sinceAt===undefined?{}:{sinceAt:previous.sinceAt}),
    ...(previous?.lastFiredAt===undefined?{}:{lastFiredAt:previous.lastFiredAt})}
  if(!previous || sample.at-previous.lastSampleAt>maxGapMs)state.sinceAt=undefined
  if(sample.value<=condition.recoverBelow)state.latched=false
  if(sample.value<=condition.above) {
    state.sinceAt=undefined
    return {fire:false,state}
  }
  state.sinceAt??=sample.at
  if(state.latched || sample.at-state.sinceAt<condition.sustainMs || state.lastFiredAt!==undefined && sample.at-state.lastFiredAt<condition.cooldownMs)return {fire:false,state}
  state.latched=true;state.lastFiredAt=sample.at
  const message=`目标${condition.targetId}的${condition.metric}为${sample.value.toFixed(1)}%，持续超过${condition.above}%阈值${condition.sustainMs/1000}秒；采样时间${new Date(sample.at).toISOString()}。`
  return {fire:true,message,state}
}
