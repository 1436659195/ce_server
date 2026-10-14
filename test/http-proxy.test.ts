/**
 * httpProxy 处理器单测(fetch 全程注入,零网络依赖)。
 * 契约重点:ok:false 只留传输/配置层错误;HTTP 4xx/5xx 以 ok:true+status 原样传回(spec.md §5.2)。
 */
import { describe, test, expect } from 'bun:test'
import { handleHttpProxy, joinUpstreamPath, type HttpProxyRequest } from '../src/cli/http-proxy'

/** 造一条请求。 */
const req = (over: Partial<HttpProxyRequest> = {}): HttpProxyRequest => ({ op: 'httpProxy', ...over })

/** 造 fake Response(headers 帮手)。 */
const res = (status: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Response =>
  new Response(new TextEncoder().encode(body), { status, headers })

describe('joinUpstreamPath', () => {
  test('剥上游尾斜杠后拼接', () => {
    expect(joinUpstreamPath('http://127.0.0.1:8000/', '/api/x')).toBe('http://127.0.0.1:8000/api/x')
    expect(joinUpstreamPath('http://127.0.0.1:8000///', '/api/x?y=1')).toBe('http://127.0.0.1:8000/api/x?y=1')
  })
  test('path 非 / 开头 / 协议相对 / 含反斜杠 → 抛', () => {
    expect(() => joinUpstreamPath('http://a', 'api/x')).toThrow()
    expect(() => joinUpstreamPath('http://a', '//evil.com/x')).toThrow()
    expect(() => joinUpstreamPath('http://a', '/api/\\x')).toThrow()
  })
})

describe('handleHttpProxy', () => {
  test('未配上游 → ok:false 明确指路', async () => {
    const r = await handleHttpProxy(req(), undefined)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('apiUpstreams')
    expect(r.error).toContain('config.json')
  })

  test('GET:URL 拼接 + headers 透传 + status/bodyBase64 回传', async () => {
    let gotUrl = ''
    let gotInit: RequestInit | undefined
    const r = await handleHttpProxy(
      req({ method: 'GET', path: '/api/campaigns?status=open', headers: { 'X-Test': '1' } }),
      ['http://127.0.0.1:8000'],
      async (input, init) => {
        gotUrl = String(input)
        gotInit = init
        return res(200, '{"ok":true}')
      }
    )
    expect(gotUrl).toBe('http://127.0.0.1:8000/api/campaigns?status=open')
    expect((gotInit!.headers as Record<string, string>)['X-Test']).toBe('1')
    expect(gotInit!.method).toBe('GET')
    expect(r.ok).toBe(true)
    const data = r.data as { status: number; bodyBase64: string; headers: Record<string, string> }
    expect(data.status).toBe(200)
    expect(Buffer.from(data.bodyBase64, 'base64').toString()).toBe('{"ok":true}')
    expect(data.headers['content-type']).toBe('application/json')
  })

  test('POST:bodyBase64 解成字节原样到 fetch(含中文)', async () => {
    const payload = JSON.stringify({ title: '豆腐鱼团', qty: 2 })
    let gotBody: Uint8Array | undefined
    const r = await handleHttpProxy(
      req({ method: 'POST', path: '/api/campaigns', bodyBase64: Buffer.from(payload).toString('base64') }),
      ['http://127.0.0.1:8000'],
      async (_input, init) => {
        gotBody = init.body as Uint8Array
        return res(201, '{"id":1}')
      }
    )
    expect(new TextDecoder().decode(gotBody!)).toBe(payload)
    expect(r.ok).toBe(true)
    expect((r.data as { status: number }).status).toBe(201)
  })

  test('HTTP 4xx/5xx 仍 ok:true + status 原样(业务错误归 APP)', async () => {
    for (const status of [404, 409, 422, 503]) {
      const r = await handleHttpProxy(req({ path: '/x' }), ['http://a'], async () =>
        res(status, '{"detail":"原因"}')
      )
      expect(r.ok).toBe(true)
      expect((r.data as { status: number }).status).toBe(status)
    }
  })

  test('响应头丢 content-encoding/content-length/transfer-encoding/connection', async () => {
    const r = await handleHttpProxy(req(), ['http://a'], async () =>
      res(200, 'hi', {
        'content-encoding': 'gzip',
        'content-length': '999',
        'transfer-encoding': 'chunked',
        connection: 'keep-alive',
        'x-keep': 'yes',
      })
    )
    const h = (r.data as { headers: Record<string, string> }).headers
    expect(h['content-encoding']).toBeUndefined()
    expect(h['content-length']).toBeUndefined()
    expect(h['transfer-encoding']).toBeUndefined()
    expect(h['connection']).toBeUndefined()
    expect(h['x-keep']).toBe('yes')
  })

  test('method 非法 → ok:false', async () => {
    const r = await handleHttpProxy(req({ method: 'TRACE' }), ['http://a'], async () => res(200, ''))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('method')
  })

  test('path 非法 → ok:false(不触 fetch)', async () => {
    let called = false
    const r = await handleHttpProxy(req({ path: '//evil' }), ['http://a'], async () => {
      called = true
      return res(200, '')
    })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })

  test('上游抛错(拒绝连接/超时)→ ok:false 带原因', async () => {
    const r = await handleHttpProxy(req(), ['http://a'], async () => {
      throw new Error('Unable to connect')
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Unable to connect')
  })

  test('响应 body 超 8MB → ok:false', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1)
    const r = await handleHttpProxy(req(), ['http://a'], async () => new Response(big, { status: 200 }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('8MB')
  })

  test('请求 body 超 8MB → ok:false(不触 fetch)', async () => {
    let called = false
    const big = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')
    const r = await handleHttpProxy(req({ method: 'POST', bodyBase64: big }), ['http://a'], async () => {
      called = true
      return res(200, '')
    })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
})
