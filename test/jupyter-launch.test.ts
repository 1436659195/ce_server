import { test, expect } from 'bun:test'
import { parseLaunchUrl } from '../src/cli/jupyter-launch'

test('parseLaunchUrl:标准 /lab 输出', () => {
  expect(parseLaunchUrl('  http://localhost:8888/lab?token=abc123  ')).toEqual({
    url: 'http://localhost:8888',
    token: 'abc123',
  })
})

test('parseLaunchUrl:带 [I] 前缀 + /tree 路径', () => {
  expect(parseLaunchUrl('[I ServerApp] http://localhost:8889/tree?token=xyz\n')).toEqual({
    url: 'http://localhost:8889',
    token: 'xyz',
  })
})

test('parseLaunchUrl:无 token → null', () => {
  expect(parseLaunchUrl('http://localhost:8888/lab')).toBeNull()
})

test('parseLaunchUrl:无 URL → null', () => {
  expect(parseLaunchUrl('starting jupyter...')).toBeNull()
})
