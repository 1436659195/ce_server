import { test, expect } from 'bun:test'
import { resolvePythonBin } from '../src/cli/python'

/**
 * resolvePythonBin 契约(PROD-PATH-FIXES C1):
 * 显式覆盖(--python= / CE_PYTHON)优先且不实测(信用户);结果进程内缓存。
 * 不实测候选探测分支(要真 subprocess,且本机必有 python3 → 无法便携断言 null/名字),
 * 由「干净容器只有 python3」验收项覆盖。
 */
test('CE_PYTHON 覆盖优先:原样返回,不做 --version 实测', async () => {
  process.env.CE_PYTHON = '/opt/some-python'
  expect(await resolvePythonBin()).toBe('/opt/some-python')
})

test('覆盖结果被缓存:同进程内二次调用不受环境变量改动影响', async () => {
  process.env.CE_PYTHON = '/opt/another-python' // 上一测试已缓存;改环境变量不应改变结果
  expect(await resolvePythonBin()).toBe('/opt/some-python')
})
