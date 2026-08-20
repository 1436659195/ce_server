import { test, expect } from 'bun:test'
import { parseServerList, toLoopback } from '../src/cli/jupyter-detect'

// 解析 `jupyter server list` 文本 → {url, token, root}[]。所有 token 均为假数据。
test('parseServerList:表驱动(空/单/多/特殊字符)', () => {
  const cases = [
    { name: '无服务器(只有表头)', input: 'Currently running servers:\n', want: [] },
    { name: '无服务器(旧版文案)', input: 'There are no running servers.\n', want: [] },
    {
      name: '单个 http',
      input: 'Currently running servers:\nhttp://localhost:8888/?token=abc123 :: /home/user\n',
      want: [{ url: 'http://localhost:8888', token: 'abc123', root: '/home/user' }],
    },
    {
      name: '多个 + https',
      input:
        'Currently running servers:\nhttp://localhost:8888/?token=aaa :: /a\nhttps://10.0.0.1:9999/?token=bbb :: /data\n',
      want: [
        { url: 'http://localhost:8888', token: 'aaa', root: '/a' },
        { url: 'https://10.0.0.1:9999', token: 'bbb', root: '/data' },
      ],
    },
    {
      name: 'token 含 URL 安全特殊字符',
      input: 'Currently running servers:\nhttp://h:8888/?token=xY_9.~- :: /r\n',
      want: [{ url: 'http://h:8888', token: 'xY_9.~-', root: '/r' }],
    },
  ]

  for (const c of cases) {
    expect(parseServerList(c.input)).toEqual(c.want)
  }
})

// ── toLoopback:localhost → 127.0.0.1(Mac 上 Bun 解析 localhost→::1 而 Jupyter 终端路由 ──
//    在 v4/v6 双栈间有瞬时差异;统一 127.0.0.1 消灭歧义) ─────────────────────────────────

test('toLoopback:localhost 替换为 127.0.0.1', () => {
  expect(toLoopback('http://localhost:53358')).toBe('http://127.0.0.1:53358')
})

test('toLoopback:已是 127.0.0.1 不变', () => {
  expect(toLoopback('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888')
})

test('toLoopback:其他 hostname 不动(用户显式指定的外部 jupyter)', () => {
  expect(toLoopback('http://192.168.1.5:8888')).toBe('http://192.168.1.5:8888')
  expect(toLoopback('http://myjupyter.example.com:8888')).toBe('http://myjupyter.example.com:8888')
})

test('toLoopback:端口后带边界字符不误伤(只替换 host 段)', () => {
  expect(toLoopback('http://localhost:8888/lab')).toBe('http://127.0.0.1:8888/lab')
  expect(toLoopback('http://localhostx:8888')).toBe('http://localhostx:8888') // localhost 后是 x 非边界,不改
})
