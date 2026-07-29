import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const DIR = join(homedir(), '.ce')
const PATH = join(DIR, 'config.json')

/**
 * 官方中继地址(默认)。ce 首跑交互选「官方」、或无交互终端(headless/systemd 自启)时用它。
 * ★ TODO(release):发布前填真实官方中继地址(ws://host:port)。
 * 下载与中继已解耦 —— ce 二进制从 GitHub 下,中继地址由用户运行时选(官方/自建/第三方),
 * 官方中继只是众多中继里的默认那个,不再是下载渠道。
 */
export const OFFICIAL_RELAY = 'ws://OFFICIAL_RELAY_PLACEHOLDER:8606'

export interface CeConfig {
  /** 选中继地址(ws://host:port);ce 首跑交互选后写入(saveRelay),启动读它(回退 --relay 参数) */
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

/**
 * 中继地址解析(纯函数,可单测):优先级 `--relay` flag > config.json > 交互选择 > 官方默认。
 * IO(读参数/读文件/readline 弹问)在 main.ts;这里只管决策,便于单测覆盖优先级。
 * - flag:命令行 `--relay=` 显式指定(最高优先级,一次性,不持久化)。
 * - configRelay:`loadConfig().relay`,ce 首跑交互选后持久化的选择。
 * - choice:本次首跑交互选的结果(main.ts 仅在 flag 与 config 都空时才弹问、才传值)。
 * - 都没有 → 官方默认(让默认始终跟 `OFFICIAL_RELAY` 常量,不固化进 config)。
 */
export function resolveRelaySources(opts: {
  flag?: string
  configRelay?: string
  choice?: string
}): string {
  if (opts.flag) return opts.flag
  if (opts.configRelay) return opts.configRelay
  if (opts.choice) return opts.choice
  return OFFICIAL_RELAY
}
