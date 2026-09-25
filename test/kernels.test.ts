/**
 * kernels 单测 —— 协议纯函数(buildExecuteRequest / normalizeKernelMsg 归一分档)。
 * KernelManager 的 WS/REST 半边是本机真 Jupyter 冒烟(见文末 live 冒烟,默认跳过:
 * CE_KERNEL_LIVE=1 时跑)。
 */
import { describe, expect, test } from 'bun:test'
import { buildExecuteRequest, normalizeKernelMsg } from '../src/cli/kernels'

describe('buildExecuteRequest', () => {
  test('消息形状:header.msg_type/msg_id + content.code + channel', () => {
    const m = buildExecuteRequest('mid-1', 'print(1)')
    expect(m.header.msg_type).toBe('execute_request')
    expect(m.header.msg_id).toBe('mid-1')
    expect(m.content.code).toBe('print(1)')
    expect(m.content.silent).toBe(false)
    expect(m.channel).toBe('shell')
  })
})

describe('normalizeKernelMsg 分档', () => {
  const wrap = (msg_type: string, content: unknown): unknown => ({
    header: { msg_type },
    parent_header: { msg_id: 'p1' },
    content,
  })

  test('stream → 文本', () => {
    expect(normalizeKernelMsg(wrap('stream', { name: 'stdout', text: 'hi\n' }))).toEqual({
      kind: 'stream',
      text: 'hi\n',
    })
  })

  test('error → 栈', () => {
    expect(normalizeKernelMsg(wrap('error', { ename: 'VE', evalue: 'bad', traceback: ['a', 'b'] }))).toEqual({
      kind: 'error',
      ename: 'VE',
      evalue: 'bad',
      traceback: 'a\nb',
    })
  })

  test('display_data/execute_result:图片 png 优先 > jpeg > text/plain;富媒体 null', () => {
    expect(normalizeKernelMsg(wrap('display_data', { data: { 'image/png': 'b64' } }))).toEqual({
      kind: 'image',
      mime: 'image/png',
      base64: 'b64',
    })
    expect(
      normalizeKernelMsg(wrap('execute_result', { data: { 'image/jpeg': 'j', 'text/plain': 'x' } })),
    ).toEqual({ kind: 'image', mime: 'image/jpeg', base64: 'j' })
    expect(normalizeKernelMsg(wrap('execute_result', { data: { 'text/plain': '42' } }))).toEqual({
      kind: 'text',
      text: '42',
    })
    expect(normalizeKernelMsg(wrap('display_data', { data: { 'text/html': '<b/>' } }))).toBeNull()
  })

  test('status:busy/idle/dead 过;starting 等前置 null', () => {
    expect(normalizeKernelMsg(wrap('status', { execution_state: 'busy' }))).toEqual({ kind: 'status', phase: 'busy' })
    expect(normalizeKernelMsg(wrap('status', { execution_state: 'starting' }))).toBeNull()
  })

  test('execute_reply:ok / error 摘要', () => {
    expect(normalizeKernelMsg(wrap('execute_reply', { status: 'ok' }))).toEqual({ kind: 'reply', ok: true })
    const r = normalizeKernelMsg(wrap('execute_reply', { status: 'error', ename: 'VE', evalue: 'bad' })) as {
      kind: string
      error?: string
    }
    expect(r.kind).toBe('reply')
    expect(r.error).toContain('VE')
  })

  test('无关消息类型 → null(不炸)', () => {
    expect(normalizeKernelMsg(wrap('kernel_info_reply', {}))).toBeNull()
    expect(normalizeKernelMsg(null)).toBeNull()
  })
})

// ─── live 冒烟(默认跳过;CE_KERNEL_LIVE=1 bun test test/kernels.test.ts)────
describe.skipIf(!process.env.CE_KERNEL_LIVE)('KernelManager live 冒烟(本机真 Jupyter)', () => {
  const NB_PATH = 'Qlib/test.ipynb' // 真实存在的 notebook(会话绑定要求路径在盘)
  const mk = async (events: unknown[]) => {
    const { KernelManager } = await import('../src/cli/kernels')
    return new KernelManager({
      baseUrl: process.env.CE_JUPYTER_URL ?? 'http://localhost:8888',
      token: process.env.CE_JUPYTER_TOKEN ?? '66668888!?',
      push: (e) => events.push(e),
    })
  }
  test('start → execute → 输出流 → shutdown 全链', async () => {
    const events: unknown[] = []
    const km = await mk(events)
    const { kernelId } = await km.start()
    expect(kernelId).toBeTruthy()
    const msgId = await km.execute(kernelId, 'print("ce-kernel-smoke")\n1+1')
    expect(msgId).toBeTruthy()
    await new Promise((r) => setTimeout(r, 2500))
    await km.shutdown(kernelId)
    const text = JSON.stringify(events)
    expect(text).toContain('ce-kernel-smoke')
    expect(text).toContain('kernelReply')
    expect(text).toContain('"phase":"idle"')
  })
  test('跨端接管:同 notebookPath 二次 start 接同一内核,变量状态继承', async () => {
    const ev1: unknown[] = []
    const km = await mk(ev1)
    const first = await km.start({ notebookPath: NB_PATH })
    expect(first.attached).toBe(false)
    await km.execute(first.kernelId, 'smoke_var = 12345')
    await new Promise((r) => setTimeout(r, 1500))
    // "另一端"(新 manager 实例 = 模拟手机重开/他端)带同路径 start → 接管
    const ev2: unknown[] = []
    const km2 = await mk(ev2)
    const second = await km2.start({ notebookPath: NB_PATH })
    expect(second.attached).toBe(true)
    expect(second.kernelId).toBe(first.kernelId)
    const msgId = await km2.execute(second.kernelId, 'print("inherit", smoke_var)')
    expect(msgId).toBeTruthy()
    await new Promise((r) => setTimeout(r, 2000))
    await km2.shutdown(second.kernelId)
    expect(JSON.stringify(ev2)).toContain('inherit 12345') // 变量从首端继承
  })
})
