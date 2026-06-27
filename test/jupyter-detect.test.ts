import { test, expect } from 'bun:test'
import { parseServerList } from '../src/cli/jupyter-detect'

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
