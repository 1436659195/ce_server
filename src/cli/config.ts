import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const DIR = join(homedir(), '.ce')
const PATH = join(DIR, 'config.json')

export interface CeConfig {
  /** 默认中继地址(ws://host:port);install.ps1 写入,ce 启动读它(回退 --relay 参数) */
  relay?: string
  /** Jupyter root_dir(手机文件栏浏览根),形如 `D:\`;install.ps1 选盘写入,ce 启动读它。
   *  install.sh(Linux/Mac)不写 → 恒走 cwd 盘根('/')。换盘:重跑安装命令重选。 */
  root?: string
  /** Jupyter 工作目录(root_dir)覆盖;CLI --workdir 传入时写入(绝对路径),优先级高于 root。
   *  开机自启(注册表 Run / systemd)不携带任何 CLI 参数 → 不落盘则重启即丢;删除本字段 = 恢复默认。 */
  workdir?: string
}

/** 读 config;不存在/损坏 → 空对象(不抛)。path 可注入便于测试。 */
export function loadConfig(path: string = PATH): CeConfig {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as CeConfig
  } catch {
    /* 损坏→空 */
  }
  return {}
}

/** 写 relay(合并已有字段,创建父目录);失败静默(仅本次内存有效)。path 可注入便于测试。 */
export function saveRelay(relay: string, path: string = PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const cur = existsSync(path) ? loadConfig(path) : {}
    writeFileSync(path, JSON.stringify({ ...cur, relay }))
  } catch {
    /* 写失败→忽略 */
  }
}

/** 写 workdir(合并已有字段,创建父目录)。返回是否成功 —— 该值要跨重启生效,静默丢 =
 *  重启后工作区悄悄变回根目录,必须让调用方告警。path 可注入便于测试。 */
export function saveWorkdir(workdir: string, path: string = PATH): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const cur = existsSync(path) ? loadConfig(path) : {}
    writeFileSync(path, JSON.stringify({ ...cur, workdir }))
    return true
  } catch {
    return false
  }
}
