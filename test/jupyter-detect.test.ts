import { test, expect } from 'bun:test'
import { parseServerList, toLoopback, probePythonBin } from '../src/cli/jupyter-detect'

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

// ── probePythonBin(生产红线 C1:不写死 'python' —— 标准发行版只有 python3;非 win32 候选 ──
//    python3→python,win32 只有 python;两层实测:层1 jupyterlab 可跑 > 层2 pip 可跑;
//    覆盖 --python= > CE_PYTHON > 实测)─────────────────────────────────────────────────

test('probePythonBin:python3 能跑 jupyterlab 即选(标准发行版)', async () => {
  expect(await probePythonBin(async (_c, a) => a[1] === 'jupyterlab' && a[0] === '-m' ? true : false)).toBe('python3')
})

test('probePythonBin:python3 只有 pip(未装 jupyter)→ 层2 命中 python3', async () => {
  expect(await probePythonBin(async (_c, a) => a[1] === 'pip')).toBe('python3')
})

test('probePythonBin:python3 空壳(pip 坏)、python 有 jupyterlab → 选 python(生产机实测案例)', async () => {
  // 生产机:python→3.10 全套 jupyter;python3→3.12 系统 pip 缺 distutils 直接炸
  expect(
    await probePythonBin(async (c, a) => (c === 'python' ? a[1] === 'jupyterlab' : false)),
  ).toBe('python')
})

test('probePythonBin:全失败 → null(不静默猜)', async () => {
  expect(await probePythonBin(async () => false)).toBe(null)
})

test('probePythonBin:--python= 参数最优先(不做实测)', async () => {
  process.argv.push('--python=/opt/my/py')
  try {
    expect(await probePythonBin(async () => { throw new Error('不应实测') })).toBe('/opt/my/py')
  } finally {
    process.argv.pop()
  }
})

test('probePythonBin:CE_PYTHON 环境变量次优先', async () => {
  process.env.CE_PYTHON = '/usr/alt/python3'
  try {
    expect(await probePythonBin(async () => { throw new Error('不应实测') })).toBe('/usr/alt/python3')
  } finally {
    delete process.env.CE_PYTHON
  }
})

test('probePythonBin:--python= 盖过 CE_PYTHON', async () => {
  process.env.CE_PYTHON = '/env/py'
  process.argv.push('--python=/arg/py')
  try {
    expect(await probePythonBin(async () => false)).toBe('/arg/py')
  } finally {
    process.argv.pop()
    delete process.env.CE_PYTHON
  }
})
