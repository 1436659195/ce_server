import { cpus } from 'node:os'
import { statfs } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import type { MetricCondition, MetricSample } from './conditions'

interface CollectorDependencies {
  cpuTimes(): {idle:number;total:number}
  wait(ms:number,signal?:AbortSignal):Promise<void>
  disk():Promise<{blocks:number;bavail:number}>
  gpu(signal?:AbortSignal):Promise<string>
  now():number
}
const defaults:CollectorDependencies={
  cpuTimes:()=>cpus().reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0}),
  wait:async(ms,signal)=>{await pause(ms,undefined,{signal})},
  disk:()=>statfs(process.cwd()),
  gpu:signal=>new Promise((resolve,reject)=>{
    execFile('nvidia-smi',['--query-gpu=utilization.gpu','--format=csv,noheader,nounits'],{timeout:5000,maxBuffer:8192,signal},(error,stdout)=>error?reject(error):resolve(stdout))
  }),
  now:Date.now,
}

/** Only a registered local host is supported. Remote collectors require an adapter. */
export function createHostMetricCollector(overrides:Partial<CollectorDependencies>={}) {
  const deps={...defaults,...overrides}
  return async(condition:MetricCondition,signal?:AbortSignal):Promise<MetricSample>=>{
    signal?.throwIfAborted()
    if(condition.targetId!=='host')throw new Error('监测目标targetId未注册；内置采集器仅支持host')
    let value:number
    if(condition.metric==='cpu.utilization') {
      const before=deps.cpuTimes()
      await deps.wait(100,signal)
      signal?.throwIfAborted()
      const after=deps.cpuTimes(),total=after.total-before.total,idle=after.idle-before.idle
      if(!Number.isFinite(total) || total<=0 || !Number.isFinite(idle) || idle<0 || idle>total)throw new Error('CPU采样窗口无有效计数')
      value=(1-idle/total)*100
    } else if(condition.metric==='disk.usedPercent') {
      const disk=await deps.disk()
      if(!Number.isFinite(disk.blocks) || disk.blocks<=0 || !Number.isFinite(disk.bavail) || disk.bavail<0 || disk.bavail>disk.blocks)throw new Error('磁盘容量采集失败')
      value=(1-disk.bavail/disk.blocks)*100
    } else if(condition.metric==='gpu.utilization') {
      try {
        const output=await deps.gpu(signal)
        const rows=output.trim().split(/\r?\n/)
        if(!rows.length || rows.some(v=>!/^\d+(?:\.\d+)?$/.test(v.trim())))throw new Error('invalid GPU output')
        value=Math.max(...rows.map(Number))
        if(!Number.isFinite(value) || value<0 || value>100)throw new Error('invalid GPU value')
      } catch(error) {
        signal?.throwIfAborted()
        throw new Error(`GPU采集不可用：${error instanceof Error?error.message:String(error)}`)
      }
    } else throw new Error('不支持的指标')
    signal?.throwIfAborted()
    return {value,at:deps.now()}
  }
}
export const collectHostMetric=createHostMetricCollector()
