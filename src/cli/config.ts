import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const DIR = join(homedir(), '.ce')
const PATH = join(DIR, 'config.json')

export interface CeConfig {
  /** 默认中继地址(ws://host:port);install.ps1 写入,ce 启动读它(回退 --relay 参数) */
  relay?: string
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
