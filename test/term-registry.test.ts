import { test, expect } from 'bun:test'
import { TermRegistry, gateAttach } from '../src/cli/term-registry'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// TermRegistry:终端实例指纹 + 归属,持久化。治两件事:
//  ① Jupyter 数字终端名被复用(杀 5 建 5 还是 "5")→ 手机改名错粘到无关新终端;
//  ② 多端抢终端 → 归属态只有属主能用,杀 app 归属仍在,软移除(释放)才回游离。
// gateAttach:接管门禁纯函数(归属拒绝 / 指纹不符判死 / 不在册待刷新)。

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ce-termreg-')), 'terminal-registry.json')
}

test('observe:新名字分配稳定指纹;重复观察不变', () => {
  const r = new TermRegistry(tmpFile())
  r.observe(['5', '6'])
  const f5 = r.fingerOf('5')
  expect(f5).toBeTruthy()
  r.observe(['5', '6'])
  expect(r.fingerOf('5')).toBe(f5) // 稳定:同一实例不换指纹
})

test('observe:live 缺席 = 死亡,进返回名单;同名复建 = 新指纹 + 归属解除(编号复用核心场景)', () => {
  const r = new TermRegistry(tmpFile())
  r.observe(['5'])
  const oldFinger = r.fingerOf('5')!
  r.setOwner('5', { id: 'phone-A', name: '我的手机' })
  expect(r.ownerOf('5')?.id).toBe('phone-A')

  const died = r.observe([]) // 终端 5 死了(Jupyter 列表不再含它)
  expect(died).toEqual(['5'])
  expect(r.fingerOf('5')).toBeUndefined()

  r.observe(['5']) // 同名新终端出现(编号复用)
  expect(r.fingerOf('5')).toBeTruthy()
  expect(r.fingerOf('5')).not.toBe(oldFinger) // 新实例新指纹 → 手机的旧持久名不会错粘
  expect(r.ownerOf('5')).toBeUndefined() // 归属随死亡解除 → 游离态
})

test('归属:setOwner / releaseOwner(指纹保留)/ releaseAllOf / remove', () => {
  const r = new TermRegistry(tmpFile())
  r.observe(['1', '2', '3'])
  r.setOwner('1', { id: 'phone-A', name: 'A' })
  r.setOwner('2', { id: 'phone-A', name: 'A' })
  r.setOwner('3', { id: 'phone-B', name: 'B' })

  r.releaseOwner('1') // 软移除:归属 → 游离,finger 保留(凭它找回改名)
  expect(r.ownerOf('1')).toBeUndefined()
  expect(r.fingerOf('1')).toBeTruthy()

  expect(r.releaseAllOf('phone-A').sort()).toEqual(['2']) // 解绑 A:只剩 '2' 归属它('1' 已释放)
  expect(r.ownerOf('2')).toBeUndefined()
  expect(r.ownerOf('3')?.id).toBe('phone-B') // 别人的不动

  r.remove('3') // 硬删:整条出册
  expect(r.fingerOf('3')).toBeUndefined()
})

test('持久化 roundtrip:新实例(模拟 daemon 重启)读回指纹与归属;损坏 owner 形状丢弃保指纹', () => {
  const path = tmpFile()
  const r1 = new TermRegistry(path)
  r1.observe(['5'])
  const f5 = r1.fingerOf('5')!
  r1.setOwner('5', { id: 'phone-A', name: '我的手机' })

  const r2 = new TermRegistry(path)
  expect(r2.fingerOf('5')).toBe(f5)
  expect(r2.ownerOf('5')).toEqual({ id: 'phone-A', name: '我的手机' })

  // 归属名形状不对 → 保 finger 丢 owner(指纹是身份底线,归属可重建)
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  writeFileSync(path, JSON.stringify({ '9': { finger: 'f9', owner: { id: 123 } } }))
  const r3 = new TermRegistry(path)
  expect(r3.fingerOf('9')).toBe('f9')
  expect(r3.ownerOf('9')).toBeUndefined()
})

test('namesOwnedBy:列出某属主名下的终端(撤销远程授权时关它的终端用)', () => {
  const r = new TermRegistry(tmpFile())
  r.observe(['1', '2', '3'])
  r.setOwner('1', { id: 'grant-a', name: '运维' })
  r.setOwner('3', { id: 'grant-a', name: '运维' })
  r.setOwner('2', { id: 'phone-1', name: '手机' })
  expect(r.namesOwnedBy('grant-a').sort()).toEqual(['1', '3'])
  expect(r.namesOwnedBy('nobody')).toEqual([])
})

test('gateAttach:别人的归属拒;指纹不符判死;不在册 unknown;游离/自己/无指纹放行', () => {
  const ownerA = { id: 'phone-A', name: 'A' }
  // 别人的归属 → denied(附属主显示名,手机提示「X 正在使用」)
  expect(gateAttach({ owner: ownerA, finger: 'f1', phoneId: 'phone-B' })).toEqual({
    verdict: 'denied',
    occupiedBy: 'A',
  })
  // 指纹不符 → gone(编号被复用:接的是同名不同实例)
  expect(gateAttach({ owner: ownerA, finger: 'f1', presentedFinger: 'f-old', phoneId: 'phone-A' })).toEqual({
    verdict: 'gone',
  })
  // 不在册 → unknown(调用方刷新 observe 后重判;仍不在 = 真死)
  expect(gateAttach({ finger: undefined, phoneId: 'phone-A' })).toEqual({ verdict: 'unknown' })
  // 游离 + 无指纹(旧手机)→ ok
  expect(gateAttach({ finger: 'f1', phoneId: 'phone-B' })).toEqual({ verdict: 'ok' })
  // 自己的 + 指纹匹配 → ok
  expect(gateAttach({ owner: ownerA, finger: 'f1', presentedFinger: 'f1', phoneId: 'phone-A' })).toEqual({
    verdict: 'ok',
  })
})

test('gateAttach:数字人占用的终端,人可以旁观(裁决 view,不改归属);指纹不符仍判死', () => {
  const ownerAgent = { id: 'grant-abc123', name: '运维@机器A' }
  // 人打开数字人的终端 → view:输出同时发给他,归属不变
  expect(gateAttach({ owner: ownerAgent, finger: 'f1', phoneId: 'phone-B', agentOwned: true })).toEqual({ verdict: 'view' })
  // 数字人对端自己 → ok
  expect(gateAttach({ owner: ownerAgent, finger: 'f1', phoneId: 'grant-abc123', agentOwned: true })).toEqual({ verdict: 'ok' })
  // 不带标记(调用方没算出来)= 原行为:拒绝
  expect(gateAttach({ owner: ownerAgent, finger: 'f1', phoneId: 'phone-B' })).toEqual({ verdict: 'denied', occupiedBy: '运维@机器A' })
  // 别的手机占用的终端不因标记而可旁观
  expect(gateAttach({ owner: { id: 'phone-A', name: 'A' }, finger: 'f1', phoneId: 'phone-B', agentOwned: false })).toEqual({ verdict: 'denied', occupiedBy: 'A' })
  // 旁观也要对得上实例:指纹不符 → gone
  expect(gateAttach({ owner: ownerAgent, finger: 'f1', presentedFinger: 'f-old', phoneId: 'phone-B', agentOwned: true })).toEqual({ verdict: 'gone' })
})
