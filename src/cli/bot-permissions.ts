import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const BOT_OPERATIONS = ['read', 'create', 'edit', 'delete', 'execute'] as const
export type BotOperation = typeof BOT_OPERATIONS[number]
export type BotPermissionMode = 'deny' | 'ask' | 'allow'
export interface BotPermissions {
  version: 1
  /** 来源项目内的相对子目录，不是宿主机任意路径。 */
  directory: string
  read: BotPermissionMode
  create: BotPermissionMode
  edit: BotPermissionMode
  delete: BotPermissionMode
  execute: BotPermissionMode
  commanders: 'owner' | 'members' | 'selected'
  allowedPhoneIds: string[]
}
export interface BotApproval {
  id: string
  operation: BotOperation
  summary: string
  groupId: string
  requesterName: string
  createdAt: number
  expiresAt: number
}
export interface BotPolicyInfo {
  workerAccessMode?: 'full-access'
  /** 独立数字人的当前工作目录；path 相对 CE 文件根，cwd 为机器确认路径。 */
  workDirectory?: { path: string; cwd: string }
  permissions: BotPermissions
  ownerPhoneId?: string
  revision: number
  canManage: boolean
  approvals: BotApproval[]
  people: Array<{ phoneId: string; name: string }>
  commandSandbox: boolean
}
export interface BotToolContext {
  name: string
  groupId: string
  memberId: string
  requesterName: string
}
export interface StoredBotPolicy {
  permissions: BotPermissions
  ownerPhoneId: string
  revision: number
}

export function botPermissionPreset(preset: 'readonly' | 'developer'): BotPermissions {
  return {
    version: 1, directory: '.', read: 'allow',
    create: preset === 'developer' ? 'allow' : 'deny',
    edit: preset === 'developer' ? 'allow' : 'deny',
    delete: preset === 'developer' ? 'ask' : 'deny',
    execute: preset === 'developer' ? 'ask' : 'deny',
    commanders: 'owner', allowedPhoneIds: [],
  }
}

export function validateBotPermissions(input: unknown): BotPermissions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('BOT 权限格式无效')
  const p = input as Record<string, unknown>
  if (p.version !== 1) throw new Error('BOT 权限版本不匹配，请更新 APP / CE')
  if (typeof p.directory !== 'string' || !p.directory.trim() || p.directory.length > 1024 || /[\r\n\0]/.test(p.directory)) throw new Error('请填写有效的项目子目录')
  const directory = p.directory.trim().replace(/\\/g, '/')
  if (isAbsolute(directory) || /^[a-z]:/i.test(directory) || directory.split('/').includes('..')) throw new Error('工作范围必须是来源项目内的相对子目录')
  for (const operation of BOT_OPERATIONS) {
    if (!['deny', 'ask', 'allow'].includes(p[operation] as string)) throw new Error(`${operation} 权限必须为禁止、每次确认或允许`)
  }
  if (!['owner', 'members', 'selected'].includes(p.commanders as string)) throw new Error('请选择有效的指挥者范围')
  if (!Array.isArray(p.allowedPhoneIds) || p.allowedPhoneIds.length > 64 || p.allowedPhoneIds.some(id => typeof id !== 'string' || !id || id.length > 256 || /[\r\n\0]/.test(id))) throw new Error('指定成员身份格式无效')
  const normalized = {
    version: 1 as const, directory,
    read: p.read as BotPermissionMode, create: p.create as BotPermissionMode, edit: p.edit as BotPermissionMode,
    delete: p.delete as BotPermissionMode, execute: p.execute as BotPermissionMode,
    commanders: p.commanders as BotPermissions['commanders'], allowedPhoneIds: [...new Set(p.allowedPhoneIds as string[])],
  }
  if (normalized.execute !== 'deny' && BOT_OPERATIONS.some(op => op !== 'execute' && normalized[op] === 'deny')) throw new Error('执行命令可能改变文件，启用前需同时授予读取、创建、修改和删除权限')
  return normalized
}

export function resolveBotDirectory(sourceCwd: string, permissions: BotPermissions): string {
  const p = validateBotPermissions(permissions)
  const source = realpathSync(sourceCwd)
  const directory = realpathSync(resolve(source, p.directory))
  const rel = relative(source, directory)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('工作范围超出来源项目目录')
  if (!statSync(directory).isDirectory()) throw new Error('工作范围必须是文件夹')
  return directory
}

/** 命令具备文件变更能力，必须遵守所有文件操作中更严格的限制。 */
export function operationMode(permissions: BotPermissions, operation: BotOperation): BotPermissionMode {
  if (operation !== 'execute') return permissions[operation]
  const modes = BOT_OPERATIONS.map(op => permissions[op])
  return modes.includes('deny') ? 'deny' : modes.includes('ask') ? 'ask' : 'allow'
}
