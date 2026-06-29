import { test, expect } from 'bun:test'
import { renderInstallScript } from '../src/relay/server'

test('renderInstallScript: __RELAY_URL__ 替换成 ws://<host>', () => {
  const out = renderInstallScript("relay='__RELAY_URL__'", 'ws://1.2.3.4:8606')
  expect(out).toBe("relay='ws://1.2.3.4:8606'")
  expect(out).not.toContain('__RELAY_URL__')
})

test('多个占位都替换', () => {
  const out = renderInstallScript('a=__RELAY_URL__ b=__RELAY_URL__', 'ws://h:1')
  expect(out).toBe('a=ws://h:1 b=ws://h:1')
})
