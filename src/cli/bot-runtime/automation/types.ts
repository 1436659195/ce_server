import type { RuntimeMandate } from '../types'
import type { AutomationSchedule } from './schedule'
import type { MetricCondition, MetricState } from './conditions'

export interface AutomationSource {
  botId: string; groupId: string; ownerId: string; memberId: string
  inputIds: string[]; text: string; createdAt: number; mandate: RuntimeMandate
  caseId?: string; taskId?: string; parentJobId?: string; depth: number
}
export interface AutomationDefinition {
  name: string; payload: string; schedule: AutomationSchedule; condition?: MetricCondition
  expiresAt?: number; maxRuns?: number; timeoutMs: number; misfireMs: number
}
export interface AutomationJob extends AutomationDefinition {
  id: string; botId: string; groupId: string; revision: number
  status: 'enabled' | 'paused' | 'removed' | 'completed'
  source: AutomationSource; creationKey: string; creationHash: string
  createdAt: number; updatedAt: number; nextCheckAt?: number
  state?: MetricState; checks: number; successes: number; failures: number
  error?: string; failureNotified?: boolean; lastEventKey?: string
  checkToken?: string; checkUntil?: number
}
export type OccurrenceState = 'queued' | 'routing' | 'working' | 'delivery_pending' | 'completed' | 'cancelled' | 'failed' | 'skipped' | 'needs_attention'
export interface AutomationOccurrence {
  id: string; botId: string; jobId: string; jobRevision: number; key: string
  scheduledAt: number; message: string; state: OccurrenceState
  createdAt: number; updatedAt: number; attempts: number; retryAt?: number
  taskId?: string; pendingState?: MetricState; diagnostic?: boolean
  error?: string; finishedAt?: number
}
export interface RuntimeAutomationTrigger { job: AutomationJob; occurrence: AutomationOccurrence }
export const AUTOMATION_LIMITS = {
  jobsPerBot: 100, maxDepth: 3, followupHorizonMs: 7 * 86_400_000,
  checkTimeoutMs: 30_000, runTimeoutMs: 10 * 60_000, misfireMs: 60 * 60_000,
  maxAttempts: 3, checkConcurrency: 3,
} as const
export const ACTIVE_OCCURRENCE_STATES: OccurrenceState[] = ['queued', 'routing', 'working', 'delivery_pending']
