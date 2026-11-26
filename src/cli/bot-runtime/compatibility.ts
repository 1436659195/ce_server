import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod/v4'

/** Change this when the adapter contract changes. Only successful static probes are cached. */
const ADAPTER_REVISION = 'ce-agent-compat-1'
const compatible = new Set<string>()
class RuntimeDiagnosticError extends Error {}
export class RuntimeCompatibilityError extends RuntimeDiagnosticError {}

export function cliVersion(output: string, platform: 'codex' | 'claude'): string {
  const version = platform === 'codex'
    ? /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/.exec(output.trim())?.[1]
    : /^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s+\(Claude Code\)\s*$/.exec(output.trim())?.[1]
  if (!version) throw new RuntimeCompatibilityError(`无法识别 ${platform === 'codex' ? 'Codex' : 'Claude Code'} CLI，请检查可执行文件；未按版本号拒绝`)
  return version
}

export function compatibilityKey(platform: string, executable: string, version: string, mode: string): string {
  const path = realpathSync(Bun.which(executable) ?? resolve(executable))
  const file = statSync(path)
  return JSON.stringify([ADAPTER_REVISION, platform, path, file.size, file.mtimeMs, file.ctimeMs, version, mode])
}
export function wasCompatible(key: string): boolean { return compatible.has(key) }
export function rememberCompatible(key: string): void {
  if (compatible.size >= 64) compatible.delete(compatible.values().next().value!)
  compatible.add(key)
}

export function requireCliOptions(help: string, options: string[], label: string): void {
  const missing = options.filter(option => !new RegExp(`(^|[\\s,])${option}(?=[\\s,=<]|$)`, 'm').test(help))
  if (missing.length) throw new RuntimeCompatibilityError(`${label} 缺少必要 CLI 能力：${missing.join('、')}；请安装支持这些接口的 CLI 或更新 CE 适配器`)
}

type Schema = Record<string, any>
function accepts(schema: Schema, value: unknown, root: Schema, depth = 0): boolean {
  if (!schema || depth > 20) return false
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/definitions/')) return false
    return accepts(root.definitions?.[schema.$ref.slice('#/definitions/'.length)], value, root, depth + 1)
  }
  if (schema.enum) return schema.enum.includes(value)
  if ('const' in schema) return schema.const === value
  if (schema.anyOf || schema.oneOf) return (schema.anyOf ?? schema.oneOf).some((s: Schema) => accepts(s, value, root, depth + 1))
  if (schema.allOf) return schema.allOf.every((s: Schema) => accepts(s, value, root, depth + 1))
  const type = Array.isArray(value) ? 'array' : typeof value
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  return types.includes(type) && (!Array.isArray(value) || (schema.minItems ?? 0) <= value.length)
}

/** Inspect the installed binary's own protocol, not a version allowlist. */
export function checkCodexProtocol(read: (name: string) => Schema, fullAccess: boolean, version: string): void {
  const fail = (detail: string): never => { throw new RuntimeCompatibilityError(`Codex ${version} 协议能力不满足：${detail}；请更新 CE 适配器或使用支持该能力的 CLI`) }
  const get = (name: string): Schema => {
    try { const schema = read(name); if (schema && typeof schema === 'object') return schema } catch { /* Only report a schema name, never raw CLI output. */ }
    return fail(name)
  }
  for (const [file, methods] of [
    ['ClientRequest.json', ['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt']],
    ['ServerRequest.json', ['item/tool/call']],
    ['ServerNotification.json', ['turn/started', 'turn/completed', 'item/started', 'item/completed']],
  ] as const) {
    const schema = get(file)
    for (const method of methods) if (!schema.oneOf?.some((entry: Schema) => accepts(entry.properties?.method, method, schema))) fail(method)
  }
  const fields: Record<string, string[]> = {
    'v2/ThreadStartParams.json': ['cwd', 'sandbox', 'approvalPolicy', 'developerInstructions', 'config', 'model', 'ephemeral', 'dynamicTools'],
    'v2/ThreadResumeParams.json': ['threadId', 'cwd', 'sandbox', 'approvalPolicy', 'developerInstructions', 'config', 'model'],
    'v2/TurnStartParams.json': ['threadId', 'input', 'clientUserMessageId', 'effort'],
    'v2/TurnSteerParams.json': ['threadId', 'expectedTurnId', 'input', 'clientUserMessageId'],
    'v2/TurnInterruptParams.json': ['threadId', 'turnId'],
    'DynamicToolCallParams.json': ['threadId', 'turnId', 'callId', 'tool', 'arguments'],
    'DynamicToolCallResponse.json': ['contentItems', 'success'],
    'v2/ThreadStartResponse.json': ['thread', 'sandbox', 'approvalPolicy'],
    'v2/ThreadResumeResponse.json': ['thread', 'sandbox', 'approvalPolicy'],
    'v2/TurnStartResponse.json': ['turn'],
    'v2/TurnSteerResponse.json': ['turnId'],
  }
  if (!fullAccess) {
    fields['v2/ThreadStartParams.json'].push('baseInstructions', 'environments', 'runtimeWorkspaceRoots', 'selectedCapabilityRoots')
    fields['v2/ThreadResumeParams.json'].push('baseInstructions', 'runtimeWorkspaceRoots')
    fields['v2/TurnStartParams.json'].push('environments', 'runtimeWorkspaceRoots')
  }
  for (const [file, names] of Object.entries(fields)) {
    const schema = get(file)
    for (const name of names) if (!schema.properties?.[name]) fail(`${file}: ${name}`)
    // New mandatory request parameters cannot silently be omitted by this adapter.
    if (file.startsWith('v2/') && file.endsWith('Params.json')) {
      for (const name of schema.required ?? []) if (!names.includes(name)) fail(`${file}: 新增必填参数 ${name}`)
    }
  }
  for (const file of ['v2/ThreadStartParams.json', 'v2/ThreadResumeParams.json']) {
    const schema = get(file)
    if (!accepts(schema.properties.sandbox, fullAccess ? 'danger-full-access' : 'read-only', schema)) fail(`${file}: sandbox`)
    if (!accepts(schema.properties.approvalPolicy, 'never', schema)) fail(`${file}: approvalPolicy`)
  }
  if (!fullAccess) for (const file of ['v2/ThreadStartParams.json', 'v2/TurnStartParams.json']) {
    const schema = get(file)
    for (const field of ['environments', 'runtimeWorkspaceRoots']) if (!accepts(schema.properties[field], [], schema)) fail(`${file}: ${field} 不能禁用执行环境`)
  }
  // Validate representative requests with the installed CLI's schema. Presence
  // alone misses changed field types and new mandatory nested tool parameters.
  const thread = { cwd: '/ce-compat-check', sandbox: fullAccess ? 'danger-full-access' : 'read-only', approvalPolicy: 'never', developerInstructions: 'host', config: {},
    ...(!fullAccess ? { baseInstructions: 'host', environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [] } : {}) }
  const input = [{ type: 'text', text: 'check', text_elements: [] }]
  const samples: Record<string, unknown> = {
    'v2/ThreadStartParams.json': { ...thread, ephemeral: true, dynamicTools: [{ type: 'function', name: 'ce_runtime_check', description: 'check', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } }] },
    'v2/ThreadResumeParams.json': { ...thread, threadId: 'thread-check' },
    'v2/TurnStartParams.json': { threadId: 'thread-check', input, clientUserMessageId: 'input-check', effort: 'low', ...(!fullAccess ? { environments: [], runtimeWorkspaceRoots: [] } : {}) },
    'v2/TurnSteerParams.json': { threadId: 'thread-check', expectedTurnId: 'turn-check', input, clientUserMessageId: 'input-check' },
    'v2/TurnInterruptParams.json': { threadId: 'thread-check', turnId: 'turn-check' },
    'DynamicToolCallParams.json': { threadId: 'thread-check', turnId: 'turn-check', callId: 'call-check', tool: 'ce_runtime_check', arguments: { nonce: 'check' } },
    'DynamicToolCallResponse.json': { success: true, contentItems: [{ type: 'inputText', text: 'check' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,aGVsbG8=' }] },
  }
  for (const [file, sample] of Object.entries(samples)) {
    let result
    try { result = z.fromJSONSchema(get(file)).safeParse(sample) }
    catch { fail(`${file}: 无法核验请求结构`) }
    if (!result!.success) fail(`${file}: ${result!.error.issues.map(issue => issue.path.join('.') || '请求结构').slice(0, 3).join('、')}`)
  }
}

/** Classify common failures without copying account data or raw SDK diagnostics into chat. */
export function runtimeFailure(platform: string, error: unknown, fallback?: string): Error {
  if (error instanceof RuntimeDiagnosticError) return error
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/401|unauthori[sz]ed|authentication|not logged|login required|invalid.api.key|oauth/i.test(message)) return new RuntimeDiagnosticError(`${platform} 登录或认证失效，请在运行 CE 的系统用户下重新登录或核对 API 配置`)
  if (/429|quota|rate.limit|insufficient.*credit|billing/i.test(message)) return new RuntimeDiagnosticError(`${platform} 模型额度不足或请求受限，请核对账号额度后重试`)
  if (/ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|timed? ?out|TLS|connection.*(fail|closed)/i.test(message)) return new RuntimeDiagnosticError(`${platform} 模型连接失败或超时，请检查网络后重试`)
  if (/unknown (option|argument)|unrecognized (option|argument)|unsupported.*(parameter|method)|method not found/i.test(message)) return new RuntimeCompatibilityError(`${platform} 运行接口不兼容，请更新 CE 适配器；不是登录或网络问题`)
  return new RuntimeDiagnosticError(fallback ?? `${platform} 模型请求失败，请检查模型配置与工作设备上的运行日志`)
}
