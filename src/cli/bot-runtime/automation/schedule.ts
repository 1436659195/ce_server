/**
 * Adapted from OpenClaw src/cron/schedule.ts at
 * 2ab7b31a13d95bbbb62596679b130445c4c9d3d1.
 * Copyright (c) 2026 OpenClaw Foundation, MIT; see third_party/openclaw/LICENSE.
 * Changes: CE schedule types/timezone field; local strict timestamp, bounded-map,
 * numeric and Intl wall-time helpers; omit unsupported stream/on-exit kinds;
 * add CE creation-time validation. Core next/previous/DST algorithms retained.
 */
import { Cron, CronDate } from 'croner'

export type AutomationSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs: number }
  | { kind: 'cron'; expr: string; timezone: string }
  | { kind: 'event'; topic: 'task.completed'; taskId: string }

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000
function asDateTimestampMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP_MS
    ? value : undefined
}
function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  if (typeof value === 'string') {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return undefined
    value = Number(value)
  }
  return asDateTimestampMs(value)
}
function pruneMapToMaxSize<K,V>(map: Map<K,V>, size: number): void {
  while (map.size > size) map.delete(map.keys().next().value!)
}
/** Reject JS Date's silent calendar rollover and missing-zone interpretation. */
function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim()
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 && asDateTimestampMs(value) !== undefined ? value : null
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(raw)
  if (!match) return null
  const [,y,m,d,h,minute,second='0',,zone]=match
  const year=Number(y),month=Number(m),day=Number(d)
  const days = new Date(Date.UTC(year,month,0)).getUTCDate()
  if (month<1 || month>12 || day<1 || day>days || Number(h)>23 || Number(minute)>59 || Number(second)>59) return null
  if (zone.toUpperCase()!=='Z' && (Number(zone.slice(1,3))>23 || Number(zone.slice(4))>59)) return null
  const parsed=Date.parse(raw)
  return asDateTimestampMs(parsed) === undefined ? null : parsed
}
/** Find the earliest real instant for a wall clock, including non-hour DST folds. */
function parseOffsetlessIsoDateTimeInTimeZone(wall: string, timezone: string): {ok:true;iso:string}|{ok:false} {
  const wallMs=Date.parse(`${wall}Z`)
  if (!Number.isFinite(wallMs)) return {ok:false}
  const offsets=new Set<number>()
  // Sample both sides of any timezone transition near this wall clock.
  for(let delta=-36;delta<=36;delta+=6) {
    const instant=wallMs+delta*3_600_000
    offsets.add(resolveCronWallTimeMs(instant,timezone)-instant)
  }
  const candidates=[...offsets].map(offset=>wallMs-offset)
    .filter(instant=>resolveCronWallTimeMs(instant,timezone)===wallMs)
  return candidates.length ? {ok:true,iso:new Date(Math.min(...candidates)).toISOString()} : {ok:false}
}

export function validateSchedule(input: unknown, nowMs: number = Date.now()): AutomationSchedule {
  if (!input || typeof input!=='object' || Array.isArray(input) || asDateTimestampMs(nowMs)===undefined) throw new Error('事件时间定义无效')
  const s=input as Record<string,unknown>
  if(s.kind==='at') {
    if(typeof s.at!=='string') throw new Error('at需要带时区ISO时间或毫秒字符串')
    const at=parseAbsoluteTimeMs(s.at)
    if(at===null || at<nowMs-60_000 || at-nowMs>10*365.25*86_400_000) throw new Error('一次性事件时间无效、已过期或超过十年')
    return {kind:'at',at:new Date(at).toISOString()}
  }
  if(s.kind==='every') {
    if(typeof s.everyMs!=='number' || !Number.isSafeInteger(s.everyMs) || s.everyMs<30_000 || s.everyMs>MAX_TIMESTAMP_MS) throw new Error('周期至少30秒且必须为有效毫秒整数')
    const anchor=s.anchorMs===undefined ? nowMs : s.anchorMs
    if(typeof anchor!=='number' || !Number.isSafeInteger(anchor) || anchor<0 || asDateTimestampMs(anchor)===undefined || asDateTimestampMs(anchor+s.everyMs)===undefined) throw new Error('周期anchorMs无效')
    return {kind:'every',everyMs:s.everyMs,anchorMs:anchor}
  }
  if(s.kind==='cron') {
    if(typeof s.expr!=='string' || s.expr.length>200 || ![5,6].includes(s.expr.trim().split(/\s+/).length)) throw new Error('cron需要5或6字段表达式')
    if(typeof s.timezone!=='string' || !s.timezone.trim() || s.timezone.length>100) throw new Error('cron需要明确IANA时区')
    try {
      new Intl.DateTimeFormat('en-US',{timeZone:s.timezone}).format(0)
      const expr=s.expr.trim(),timezone=s.timezone.trim()
      resolveCachedCron(expr,timezone)
      const schedule:AutomationSchedule={kind:'cron',expr,timezone}
      if(computeNextRunAtMs(schedule,nowMs)===undefined)throw new Error('cron没有未来执行时间')
      return schedule
    } catch {throw new Error('cron表达式或时区无效')}
  }
  if(s.kind==='event' && s.topic==='task.completed' && typeof s.taskId==='string' && s.taskId.trim() && s.taskId.length<=150) return {kind:'event',topic:'task.completed',taskId:s.taskId.trim()}
  throw new Error('未知事件时间类型')
}

const CRON_EVAL_CACHE_MAX = 512;
const DAY_MS = 86_400_000;
const cronEvalCache = new Map<string, Cron>();
const cronTimezoneFormatters = new WeakMap<Cron, Intl.DateTimeFormat>();

function resolveCachedCron(expr: string, timezone: string): Cron {
  const key = `${timezone}\u0000${expr}`;
  const cached = cronEvalCache.get(key);
  if (cached) {
    // Move to the end of Map iteration order so the bounded cache behaves as LRU.
    cronEvalCache.delete(key);
    cronEvalCache.set(key, cached);
    return cached;
  }
  // Expression parsing is expensive, so retain the most recently promoted entries.
  pruneMapToMaxSize(cronEvalCache, CRON_EVAL_CACHE_MAX - 1);
  const next = new Cron(expr, { timezone, catch: false });
  cronEvalCache.set(key, next);
  return next;
}

function resolveCronFromSchedule(schedule: { timezone?: string; expr?: unknown }) {
  if (typeof schedule.expr !== "string") {
    throw new Error("invalid cron schedule: expr is required");
  }
  const expr = schedule.expr.trim();
  if (!expr) {
    return undefined;
  }
  const timezone = schedule.timezone ?? "UTC";
  return { cron: resolveCachedCron(expr, timezone), timezone };
}

function hasNearbyCronTimezoneTransition(
  cron: Cron,
  timezone: string,
  nowMs: number,
  candidateMs: number,
): boolean {
  let formatter = cronTimezoneFormatters.get(cron);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    cronTimezoneFormatters.set(cron, formatter);
  }
  const resolvedFormatter = formatter;
  const readOffset = (instantMs: number) =>
    resolvedFormatter
      .formatToParts(new Date(instantMs))
      .find((part) => part.type === "timeZoneName")?.value;
  const currentOffset = readOffset(nowMs);
  const candidateOffset = readOffset(candidateMs);
  return (
    currentOffset !== candidateOffset ||
    currentOffset !== readOffset(nowMs - DAY_MS) ||
    candidateOffset !== readOffset(candidateMs - DAY_MS)
  );
}

function resolveCronWallTimeMs(instantMs: number, timezone: string): number {
  const local = new CronDate(new Date(instantMs), timezone);
  return Date.UTC(
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.ms,
  );
}

function resolveFirstCronOccurrenceMs(instantMs: number, timezone: string): number | undefined {
  const wallTime = new Date(resolveCronWallTimeMs(instantMs, timezone)).toISOString().slice(0, -1);
  const resolved = parseOffsetlessIsoDateTimeInTimeZone(wallTime, timezone);
  return resolved.ok ? Date.parse(resolved.iso) : undefined;
}

function matchesCronOccurrence(cron: Cron, instant: Date): boolean {
  const matchesOccurrence = cron.match.bind(cron);
  return matchesOccurrence(instant);
}

function findCronTimezoneTransitionMs(
  firstMs: number,
  lastMs: number,
  timezone: string,
): number | undefined {
  let beforeSeconds = Math.floor(Math.min(firstMs, lastMs) / 1_000);
  let afterSeconds = Math.floor(Math.max(firstMs, lastMs) / 1_000);
  const previousOffsetMs =
    resolveCronWallTimeMs(beforeSeconds * 1_000, timezone) - beforeSeconds * 1_000;
  const nextOffsetMs = resolveCronWallTimeMs(afterSeconds * 1_000, timezone) - afterSeconds * 1_000;
  if (previousOffsetMs === nextOffsetMs) {
    return undefined;
  }
  while (afterSeconds - beforeSeconds > 1) {
    const middleSeconds = Math.floor((beforeSeconds + afterSeconds) / 2);
    const middleOffsetMs =
      resolveCronWallTimeMs(middleSeconds * 1_000, timezone) - middleSeconds * 1_000;
    if (middleOffsetMs === previousOffsetMs) {
      beforeSeconds = middleSeconds;
    } else {
      afterSeconds = middleSeconds;
    }
  }
  return afterSeconds * 1_000;
}

function resolveCronRunAtTransitionMs(
  cron: Cron,
  transitionMs: number,
  timezone: string,
): number | undefined {
  let transition = new Date(transitionMs);
  // Croner's finite year horizon bounds this search; historical timezone
  // policies can make many consecutive annual occurrences nonexistent.
  for (;;) {
    const candidate = matchesCronOccurrence(cron, transition)
      ? transition
      : cron.nextRun(transition);
    if (!candidate) {
      return undefined;
    }
    if (matchesCronOccurrence(cron, candidate)) {
      return resolveFirstCronOccurrenceMs(candidate.getTime(), timezone);
    }
    const candidateMs = candidate.getTime();
    const nextTransitionMs = findCronTimezoneTransitionMs(
      candidateMs - DAY_MS,
      candidateMs,
      timezone,
    );
    if (nextTransitionMs === undefined || nextTransitionMs <= transition.getTime()) {
      return undefined;
    }
    transition = new Date(nextTransitionMs);
  }
}

function resolveNextCronOccurrenceMs(
  cron: Cron,
  nowMs: number,
  nextMs: number,
  timezone: string,
): number | undefined {
  if (!matchesCronOccurrence(cron, new Date(nextMs))) {
    // Croner invents an instant for a nonexistent local time; bracket the gap,
    // not the request, so annual schedules crossing several transitions work.
    const transitionMs = findCronTimezoneTransitionMs(nextMs - DAY_MS, nextMs, timezone);
    return transitionMs === undefined
      ? undefined
      : resolveCronRunAtTransitionMs(cron, transitionMs, timezone);
  }

  const firstOccurrenceMs = resolveFirstCronOccurrenceMs(nextMs, timezone);
  if (firstOccurrenceMs === undefined || firstOccurrenceMs > nowMs) {
    return firstOccurrenceMs;
  }

  const firstCurrentOccurrenceMs = resolveFirstCronOccurrenceMs(nowMs, timezone);
  const inRepeatedInterval =
    firstCurrentOccurrenceMs !== undefined && firstCurrentOccurrenceMs < nowMs;
  const transitionStartMs = inRepeatedInterval ? firstCurrentOccurrenceMs : nowMs;
  const transitionEndMs = inRepeatedInterval ? nowMs : nextMs;
  const overlapMs = inRepeatedInterval
    ? nowMs - firstCurrentOccurrenceMs
    : nextMs - firstOccurrenceMs;
  const transitionMs = findCronTimezoneTransitionMs(transitionStartMs, transitionEndMs, timezone);
  if (transitionMs === undefined) {
    return undefined;
  }

  // Croner folds only a fixed hour. Use the actual offset change so 30-minute
  // and two-hour repeated clocks run once, at their first occurrence.
  return resolveCronRunAtTransitionMs(cron, transitionMs + overlapMs, timezone);
}

function resolveValidatedNextCronOccurrenceMs(
  cron: Cron,
  nowMs: number,
  candidateMs: number,
  timezone: string,
): number | undefined {
  if (candidateMs > nowMs && !hasNearbyCronTimezoneTransition(cron, timezone, nowMs, candidateMs)) {
    return candidateMs;
  }
  const normalizedMs = resolveNextCronOccurrenceMs(cron, nowMs, candidateMs, timezone);
  return normalizedMs !== undefined && normalizedMs > nowMs ? normalizedMs : undefined;
}

/** Computes the next scheduled run timestamp after now for at/every/cron schedules. */
export function computeNextRunAtMs(schedule: AutomationSchedule, nowMs: number): number | undefined {
  if (asDateTimestampMs(nowMs) === undefined) {
    return undefined;
  }
  if (schedule.kind === "at") {
    const atMs = parseAbsoluteTimeMs(schedule.at);
    if (atMs === null) {
      return undefined;
    }
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === "every") {
    const everyMsRaw = coerceFiniteScheduleNumber(schedule.everyMs);
    if (everyMsRaw === undefined) {
      return undefined;
    }
    const everyMs = Math.floor(everyMsRaw);
    if (everyMs < 1) {
      return undefined;
    }
    const anchorRaw = coerceFiniteScheduleNumber(schedule.anchorMs);
    if (schedule.anchorMs !== undefined && (anchorRaw === undefined || anchorRaw < 0)) {
      return undefined;
    }
    const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs));
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.floor(elapsed / everyMs) + 1;
    return asDateTimestampMs(anchor + steps * everyMs);
  }

  if (schedule.kind === "event") {
    // Event-driven trigger: never time-due. The gateway watcher calls
    // enqueueRun when the watched command exits or a stream batch closes.
    return undefined;
  }

  const resolvedCron = resolveCronFromSchedule(schedule);
  if (!resolvedCron) {
    return undefined;
  }
  const { cron, timezone } = resolvedCron;
  const nextMs = cron.nextRun(new Date(nowMs))?.getTime();
  if (nextMs === undefined) {
    return undefined;
  }

  const normalizedNextMs = resolveValidatedNextCronOccurrenceMs(cron, nowMs, nextMs, timezone);
  if (normalizedNextMs !== undefined) {
    return normalizedNextMs;
  }
  if (nextMs > nowMs) {
    return undefined;
  }

  // Workaround for croner year-rollback bug: some timezone/date combinations
  // (e.g. Asia/Shanghai) cause nextRun to return a timestamp in a past year.
  // Retry from a later reference point when the returned time is not in the
  // future.
  const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
  const retryMs = cron.nextRun(new Date(nextSecondMs))?.getTime();
  if (retryMs !== undefined) {
    const normalizedRetryMs = resolveValidatedNextCronOccurrenceMs(cron, nowMs, retryMs, timezone);
    if (normalizedRetryMs !== undefined) {
      return normalizedRetryMs;
    }
  }
  // Still in the past — try from start of tomorrow (UTC) as a broader reset.
  const tomorrowMs = new Date(nowMs).setUTCHours(24, 0, 0, 0);
  const retry2Ms = cron.nextRun(new Date(tomorrowMs))?.getTime();
  return retry2Ms !== undefined
    ? resolveValidatedNextCronOccurrenceMs(cron, nowMs, retry2Ms, timezone)
    : undefined;
}

/** Computes the previous cron-expression run timestamp before now. */
export function computePreviousRunAtMs(schedule: AutomationSchedule, nowMs: number): number | undefined {
  if (schedule.kind !== "cron" || asDateTimestampMs(nowMs) === undefined) {
    return undefined;
  }
  const resolvedCron = resolveCronFromSchedule(schedule);
  if (!resolvedCron) {
    return undefined;
  }
  const { cron, timezone } = resolvedCron;
  let previousMs = cron.previousRuns(1, new Date(nowMs))[0]?.getTime();
  if (
    previousMs !== undefined &&
    previousMs < nowMs &&
    !hasNearbyCronTimezoneTransition(cron, timezone, nowMs, previousMs)
  ) {
    return previousMs;
  }

  const firstCurrentOccurrenceMs = resolveFirstCronOccurrenceMs(nowMs, timezone);
  if (firstCurrentOccurrenceMs !== undefined && firstCurrentOccurrenceMs < nowMs) {
    const transitionMs = findCronTimezoneTransitionMs(firstCurrentOccurrenceMs, nowMs, timezone);
    if (transitionMs !== undefined) {
      const overlapEndMs = transitionMs + nowMs - firstCurrentOccurrenceMs;
      const candidateMs = cron.previousRuns(1, new Date(overlapEndMs))[0]?.getTime();
      if (candidateMs !== undefined) {
        previousMs = candidateMs;
      }
    }
  }
  if (previousMs === undefined) {
    return undefined;
  }

  // Croner's wall-clock decrement can cross spring gaps; its year horizon
  // bounds transition walking without dropping valid historical occurrences.
  while (
    !matchesCronOccurrence(cron, new Date(previousMs)) ||
    (resolveFirstCronOccurrenceMs(previousMs, timezone) ?? previousMs) >= nowMs
  ) {
    const transitionMs = findCronTimezoneTransitionMs(previousMs - DAY_MS, previousMs, timezone);
    if (transitionMs === undefined) {
      return undefined;
    }
    const beforeTransition = new Date(transitionMs - 1_000);
    const candidate = matchesCronOccurrence(cron, beforeTransition)
      ? beforeTransition
      : cron.previousRuns(1, beforeTransition)[0];
    const candidateMs = candidate?.getTime();
    if (candidateMs === undefined || candidateMs >= previousMs) {
      return undefined;
    }
    previousMs = candidateMs;
  }

  const normalizedPreviousMs = resolveFirstCronOccurrenceMs(previousMs, timezone);
  return normalizedPreviousMs !== undefined && normalizedPreviousMs < nowMs
    ? normalizedPreviousMs
    : undefined;
}
