import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hub } from '../src/relay/hub'
import { createRelayServer } from '../src/relay/server'
import type { GroupEnvelope, GroupResult } from '../src/shared/group'

test('HTTP 外部员工撤销即时结束 inbox，凭据不可再 sync/post/pair，其他员工不受影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ce-guest-revoke-'))
  const hub = new Hub(join(dir, 'state.json'), 100, null, join(dir, 'groups.json'))
  const relay = createRelayServer(hub)
  const abort = new AbortController()
  try {
    await new Promise<void>(resolve => relay.server.listen(0, '127.0.0.1', resolve))
    const port = (relay.server.address() as { port: number }).port
    const replies: GroupEnvelope[] = []
    const phone = { send: (wire: string) => {
      const frame = JSON.parse(wire)
      if (frame.type === 9) replies.push(JSON.parse(Buffer.from(frame.payload, 'base64').toString('utf8')))
    } }
    const { sid, token } = hub.register('test-machine', { send: () => {} })
    expect(hub.joinPhone(sid, token, phone, 'owner')).toBe(true)
    const request = (env: GroupEnvelope): GroupResult => {
      hub.groups!.handle(phone, JSON.stringify(env))
      return replies.at(-1)!.payload as GroupResult
    }
    const created = request({ op: 'group-create', reqId: 'create', payload: { meta: { name: '撤销测试' }, ownerName: '主人' } })
    const groupId = (created.data as { groupId: string }).groupId
    const issue = () => (request({ op: 'group-agent-code-set', groupId, reqId: 'issue', payload: { groupId } }).data as { code: string }).code
    const code = issue(), otherCode = issue()
    const api = async (kind: string, body: unknown) => (await fetch(`http://127.0.0.1:${port}/guest/api/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal })).json() as Promise<{ ok: boolean; memberId?: string }>
    const paired = await api('pair', { code, name: '外部员工', platform: 'claude' })
    const other = await api('pair', { code: otherCode, name: '其他员工', platform: 'codex' })
    expect(paired.ok).toBe(true); expect(other.ok).toBe(true)
    let arrived!: () => void
    const arrivedPromise = new Promise<void>(resolve => { arrived = resolve })
    const originalResolve = hub.groups!.resolveAgentSeat.bind(hub.groups)
    hub.groups!.resolveAgentSeat = (credential, memberId) => {
      const result = originalResolve(credential, memberId)
      if (credential === code) arrived()
      return result
    }
    const pending = api('inbox', { code, memberId: paired.memberId, afterSeq: 0, waitSec: 25 })
    await arrivedPromise
    expect(request({ op: 'group-agent-code-revoke', groupId, reqId: 'revoke', payload: { groupId, code } })).toMatchObject({ ok: true, data: { revoked: true } })
    const inbox = await Promise.race([pending, Bun.sleep(1000).then(() => { throw new Error('inbox 未在撤销时结束') })])
    expect(inbox).toMatchObject({ ok: false, error: { code: 'not_member' } })
    for (const kind of ['sync', 'post', 'pair']) expect(await api(kind, { code, memberId: paired.memberId, name: '外部员工', ct: 'NO' })).toMatchObject({ ok: false, error: { code: 'code_invalid' } })
    expect(await api('sync', { code: otherCode, memberId: other.memberId })).toMatchObject({ ok: true })
    // 真实 Hub 持久化层不能吞错，导致前端误以为撤销已保存。
    const diskCode = issue()
    const groupFile = join(dir, 'groups.json')
    rmSync(groupFile); mkdirSync(groupFile)
    expect(request({ op: 'group-agent-code-revoke', groupId, reqId: 'disk-fail', payload: { groupId, code: diskCode } })).toMatchObject({ ok: false, error: { code: 'storage_error' } })
    rmSync(groupFile, { recursive: true })
    expect(request({ op: 'group-agent-code-revoke', groupId, reqId: 'disk-retry', payload: { groupId, code: diskCode } })).toMatchObject({ ok: true })
    expect(new Hub(join(dir, 'state.json'), 100, null, groupFile).groups!.resolveAgentSeat(diskCode).ok).toBe(false)
  } finally {
    abort.abort()
    await relay.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
