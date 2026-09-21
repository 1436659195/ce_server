/**
 * Jupyter 工作目录(root_dir)的解析与比较 —— 「期望目录」体系。
 *
 * 用户可用 --workdir=<目录>(CLI,优先)或 ~/.ce/config.json 的 workdir 字段选择 Jupyter 启动
 * 目录;都不给 → 宿主机根(Linux/Mac '/',Windows 当前盘根 = parse(cwd).root)。
 *
 * root 是 agent cwd base + 上传边界(PROD-PATH-FIXES.md W1),任何目录比较都必须归一化,
 * 不能裸 ===:Windows 上 jupyter server list 报的 root 与自算路径在大小写/分隔符/尾斜杠上
 * 都可能不同(main.ts 曾因此复用失效、反复起多个 Jupyter)。
 */
import { statSync } from 'node:fs'
import { resolve, parse as parsePath, win32, posix } from 'node:path'

/** 归一化到平台绝对路径;win32 再 lowercase(大小写不敏感文件系统)。 */
function norm(p: string, platform: NodeJS.Platform): string {
  const r = platform === 'win32' ? win32.resolve(p) : posix.resolve(p)
  return platform === 'win32' ? r.toLowerCase() : r
}

/** 两个目录是否同一(resolve 归一化 + win32 大小写不敏感)。空串/null 一律不等。 */
export function sameDir(a: string | undefined, b: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!a || !b) return false
  return norm(a, platform) === norm(b, platform)
}

export type WorkdirResolution =
  | { dir: string; origin: 'cli' | 'config' } // 用户选了(cli 优先)且目录有效
  | { dir: string; origin: 'default' } // 都没选 → 宿主机根(parse(cwd).root)
  | { invalid: string; origin: 'cli' | 'config' } // 选了但目录不存在/不是文件夹(raw 原样带回)

/**
 * 解析期望工作目录。CLI 一律优先于 config(CLI 在场 = 用户此刻的明确意愿);
 * 相对路径相对 cwd resolve(与 uploads.ts 的归一化一致)。
 * 目录必须真实存在且是文件夹(防呆:上传边界/agent cwd 不能架在幻觉目录上)。
 * 无效时区分来源:origin='cli' 由调用方 exit(1)(用户在场,给可行动报错);
 * origin='config'(盘被拔/目录被删)由调用方大声警告后回退默认 —— daemon 是手机的命脉,
 * 不能因陈旧配置变砖。
 */
export function resolveWorkdir(
  cli: string | undefined,
  config: string | undefined,
  cwd: string = process.cwd(),
): WorkdirResolution {
  const source =
    cli !== undefined ? { v: cli.trim(), origin: 'cli' as const }
    : config && config.trim() !== '' ? { v: config.trim(), origin: 'config' as const }
    : null
  if (!source) return { dir: parsePath(cwd).root, origin: 'default' }
  if (source.v === '') return { invalid: cli ?? config ?? '', origin: source.origin } // --workdir= 敲了没给值
  const dir = resolve(cwd, source.v) // 绝对路径不受 cwd 影响;相对路径相对 cwd(测试可注入)
  let ok = false
  try {
    ok = statSync(dir).isDirectory()
  } catch {
    /* 不存在/不可访问 */
  }
  return ok ? { dir, origin: source.origin } : { invalid: source.v, origin: source.origin }
}
