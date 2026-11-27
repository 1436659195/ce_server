import { expect, test } from 'bun:test'
import { resolveCronExecutionRetryHint } from '../src/cli/bot-runtime/automation/openclaw-retry-hint'

test.each(['HTTP 429', '503 Service Unavailable', 'fetch failed: ECONNRESET', 'request timed out', 'overloaded_error'])(
  'recognizes transient provider failure: %s', error => {
    expect(resolveCronExecutionRetryHint({ error }).retryable).toBe(true)
  },
)

test.each(['context limit 512 exceeded', 'exited with 503 lines', 'pid 429 killed', '/tmp/provider-540.sock', 'permission denied'])(
  'does not retry incidental numbers or permanent failure: %s', error => {
    expect(resolveCronExecutionRetryHint({ error }).retryable).toBe(false)
  },
)

test('structured permanent classification overrides transient words', () => {
  expect(resolveCronExecutionRetryHint({ error: 'network timeout', classifiedReason: 'auth' })).toEqual({ retryable: false })
})

test('only configured transient categories are eligible', () => {
  expect(resolveCronExecutionRetryHint({ error: 'HTTP 429', retryOn: ['network'] })).toEqual({ retryable: false })
  expect(resolveCronExecutionRetryHint({ error: 'ignored', classifiedReason: 'network', retryOn: ['network'] })).toEqual({ retryable: true, category: 'network' })
})

test('session claim retry is allowed only before execution has started', () => {
  const error = 'Session "scheduled-weather" changed while starting work. Retry.'
  expect(resolveCronExecutionRetryHint({ error, executionStarted: false }).retryable).toBe(true)
  expect(resolveCronExecutionRetryHint({ error, executionStarted: true }).retryable).toBe(false)
})

test('missing failure does not schedule a retry', () => {
  expect(resolveCronExecutionRetryHint({ error: undefined })).toEqual({ retryable: false })
})
