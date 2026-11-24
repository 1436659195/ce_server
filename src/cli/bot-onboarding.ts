import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface DigitalPersonSetup {
  version: 1
  creationId: string
  /** UI path relative to the connected CE file root, not a host absolute path. */
  directory: string
  identity: { gender: string; age: number; avatar: { kind: 'custom'; text: string; color: string } | { kind: 'upload'; data: string } }
  guidance: { role: string; responsibilities: string; scope: string; exclusions: string }
}
export interface DigitalPersonState extends DigitalPersonSetup {
  fingerprint: string
  status: 'initializing' | 'failed' | 'ready'
  error?: string
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label}需填写 1–${max} 个字符`)
  return value.trim()
}
export function validateDigitalPerson(value: unknown): DigitalPersonSetup {
  if (!value || typeof value !== 'object') throw new Error('缺少数字人入职配置')
  const p = value as DigitalPersonSetup
  if (p.version !== 1 || typeof p.creationId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(p.creationId)) throw new Error('数字人创建协议或请求编号无效')
  const directory = text(p.directory, '工作目录', 2000)
  if (/[\r\n\\]/.test(directory)) throw new Error('工作目录格式无效')
  if (!p.identity || !p.guidance) throw new Error('请填写身份与新人指导')
  const gender = text(p.identity.gender, '性别', 20)
  if (!Number.isInteger(p.identity.age) || p.identity.age < 0 || p.identity.age > 150) throw new Error('年龄需为 0–150 的整数')
  const avatar = p.identity.avatar
  let cleanAvatar: DigitalPersonSetup['identity']['avatar']
  if (avatar?.kind === 'custom') {
    if (typeof avatar.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(avatar.color)) throw new Error('头像颜色无效')
    cleanAvatar = { kind: 'custom', text: text(avatar.text, '头像文字', 4), color: avatar.color }
  } else if (avatar?.kind === 'upload') {
    if (typeof avatar.data !== 'string' || avatar.data.length > 100000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar.data)) throw new Error('头像需为不超过 70 KB 的 PNG/JPEG/WebP 图片')
    cleanAvatar = { kind: 'upload', data: avatar.data }
  } else throw new Error('请选择自定义头像或上传图片')
  return { version: 1, creationId: p.creationId, directory, identity: { gender, age: p.identity.age, avatar: cleanAvatar }, guidance: {
    role: text(p.guidance.role, '岗位', 200), responsibilities: text(p.guidance.responsibilities, '具体职责', 700),
    scope: text(p.guidance.scope, '负责范围', 700), exclusions: text(p.guidance.exclusions, '不负责范围', 700),
  } }
}
export function digitalPersonDirectory(rootDir: string | undefined, path: string): string {
  if (!rootDir) throw new Error('无法确认服务器文件根目录')
  const root = realpathSync(rootDir)
  const assertInside = (target: string) => {
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('工作目录超出服务器文件根目录')
  }
  const selected = resolve(root, path.replace(/^\/+/, '')); assertInside(selected)
  let real: string
  try { real = realpathSync(selected); if (!statSync(real).isDirectory()) throw new Error() }
  catch { throw new Error('工作目录不存在或不是文件夹，请重新选择') }
  assertInside(real)
  return real
}
export function digitalPersonProfile(name: string, setup: DigitalPersonSetup): string {
  return [`姓名：${name}`, `性别：${setup.identity.gender}；设定年龄：${setup.identity.age}`, `岗位：${setup.guidance.role}`,
    `具体职责：${setup.guidance.responsibilities}`, `负责范围：${setup.guidance.scope}`, `不负责范围：${setup.guidance.exclusions}`,
    '以上是 owner 的新人指导。判断工作可行性时须结合实际权限和工具；不得以角色设定虚构工具、账号或已完成的操作。'].join('\n')
}
