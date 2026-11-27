import { expect, test } from 'bun:test'
import { computeNextRunAtMs, computePreviousRunAtMs, validateSchedule } from '../src/cli/bot-runtime/automation/schedule'

const ms = (s: string) => Date.parse(s)
const now = ms('2026-11-27T00:00:00Z')

test('daily Shanghai weather runs at exactly 8am on next local day', () => {
  const s = validateSchedule({kind:'cron',expr:'0 8 * * *',timezone:'Asia/Shanghai'},now)
  expect(computeNextRunAtMs(s,now)).toBe(ms('2026-11-28T00:00:00Z'))
  expect(computePreviousRunAtMs(s,now+1)).toBe(now)
})
test('at accepts explicit offset and normalizes to an absolute ISO timestamp', () => {
  const s=validateSchedule({kind:'at',at:'2026-11-28T08:00:00+08:00'},now)
  expect(s).toEqual({kind:'at',at:'2026-11-28T00:00:00.000Z'})
  expect(computeNextRunAtMs(s,now)).toBe(ms('2026-11-28T00:00:00Z'))
  expect(computeNextRunAtMs(s,ms('2026-11-28T00:00:00Z'))).toBeUndefined()
})
test.each(['2026-02-30T08:00:00Z','2026-11-28T08:00:00','2026-11-28','2026-11-28T08:00:00+25:00','Infinity','12x'])(
  'invalid or timezone-ambiguous one-shot time is refused: %s',at=>expect(()=>validateSchedule({kind:'at',at},now)).toThrow(),
)
test('one-shot dates enforce grace and far-future bounds',()=>{
  expect(()=>validateSchedule({kind:'at',at:new Date(now-61_000).toISOString()},now)).toThrow()
  expect(validateSchedule({kind:'at',at:new Date(now-30_000).toISOString()},now).kind).toBe('at')
  expect(()=>validateSchedule({kind:'at',at:'2040-01-01T00:00:00Z'},now)).toThrow()
})
test('every retains its anchor instead of drifting after late checks',()=>{
  const s=validateSchedule({kind:'every',everyMs:30_000,anchorMs:now},now)
  expect(computeNextRunAtMs(s,now+95_000)).toBe(now+120_000)
  expect(computeNextRunAtMs(s,now-1)).toBe(now)
  expect(()=>validateSchedule({kind:'every',everyMs:1000,anchorMs:now},now)).toThrow()
  expect(()=>validateSchedule({kind:'every',everyMs:30_000,anchorMs:NaN},now)).toThrow()
})
test('task completion is event-driven and has no time deadline',()=>{
  const s=validateSchedule({kind:'event',topic:'task.completed',taskId:'task_1'},now)
  expect(computeNextRunAtMs(s,now)).toBeUndefined()
  expect(()=>validateSchedule({kind:'event',topic:'fake',taskId:'task_1'},now)).toThrow()
})
test('cron expression and explicit IANA timezone are validated',()=>{
  for(const s of [{kind:'cron',expr:'broken',timezone:'Asia/Shanghai'},{kind:'cron',expr:'0 8 * * *',timezone:'Mars/Base'},{kind:'cron',expr:'0 8 * * *'}])expect(()=>validateSchedule(s,now)).toThrow()
  expect(validateSchedule({kind:'cron',expr:'0 0 8 * * *',timezone:'UTC'},now).kind).toBe('cron')
})
test('spring missing wall time skips that day instead of inventing a notification',()=>{
  const s=validateSchedule({kind:'cron',expr:'30 2 * * *',timezone:'America/New_York'},now)
  expect(computeNextRunAtMs(s,ms('2026-03-08T05:00:00Z'))).toBe(ms('2026-03-09T06:30:00Z'))
})
test('autumn repeated wall time fires only at the first occurrence',()=>{
  const s=validateSchedule({kind:'cron',expr:'30 1 * * *',timezone:'America/New_York'},now)
  expect(computeNextRunAtMs(s,ms('2026-11-01T04:00:00Z'))).toBe(ms('2026-11-01T05:30:00Z'))
  expect(computeNextRunAtMs(s,ms('2026-11-01T05:30:00Z'))).toBe(ms('2026-11-02T06:30:00Z'))
  expect(computePreviousRunAtMs(s,ms('2026-11-01T06:45:00Z'))).toBe(ms('2026-11-01T05:30:00Z'))
})
test('non-hour DST overlap is not duplicated',()=>{
  const s=validateSchedule({kind:'cron',expr:'45 1 * * *',timezone:'Australia/Lord_Howe'},now)
  expect(computeNextRunAtMs(s,ms('2026-04-04T14:00:00Z'))).toBe(ms('2026-04-04T14:45:00Z'))
  expect(computeNextRunAtMs(s,ms('2026-04-04T14:45:00Z'))).toBe(ms('2026-04-05T15:15:00Z'))
})
test('invalid computation reference cannot create a timer',()=>{
  expect(computeNextRunAtMs({kind:'every',everyMs:30_000,anchorMs:now},NaN)).toBeUndefined()
})

test('a syntactically valid cron with no future occurrence is rejected at creation',()=>{
  expect(()=>validateSchedule({kind:'cron',expr:'0 8 31 2 *',timezone:'UTC'},now)).toThrow()
})

test('epoch-based fake clocks work without falling back to the real current date',()=>{
  expect(validateSchedule({kind:'at',at:'1970-01-01T00:00:30Z'},0)).toEqual({kind:'at',at:'1970-01-01T00:00:30.000Z'})
  expect(computeNextRunAtMs(validateSchedule({kind:'every',everyMs:30_000},0),0)).toBe(30_000)
})
