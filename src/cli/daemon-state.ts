/**
 * daemon 状态文件(~/.ce/daemon.json)的读取与「卡死在启动态」判定 —— 控制台防呆用。
 *
 * daemon 侧(main.ts)的写法:进程启动即写 {pid, port:null, starting:true, startAt};
 * Jupyter 就绪、控制端点起好后重写 port + starting:false;退出删除(uncaughtException /
 * exit handler)。控制台(console.ts)据此判「没跑 → spawn」「启动中 → 耐心等」「就绪 → 进菜单」。
 *
 * 卡死兜底(2026-11 Kylin V10 真机事故):daemon 卡在无人能答的 pip 安装询问上 22 天,
 * daemon.json 恒 starting:true + port:null —— 光看「进程活着」永远等不到就绪,必须有时间
 * 兜底:starting 超过 STALE_STARTING_MS 即判卡死,由控制台杀掉重启,不再无限打点。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DAEMON_JSON_PATH = join(homedir(), '.ce', 'daemon.json')

export interface DaemonInfo { port?: number; pid: number; version?: string; starting?: boolean; startAt?: number }

/** starting 态的最长容忍:正常首次准备(pip 装 jupyterlab)约 1-2 分钟,10 分钟 = 5 倍裕量;
 *  真卡死不会自愈,只能由外部(控制台)杀掉重启。 */
export const STALE_STARTING_MS = 10 * 60 * 1000

/** 读 daemon 状态 + pid 验活(kill -0);文件缺失/解析不了/pid 已死 → null(残留文件不算「在」)。
 *  startAt 缺失(手改/古老版本)回退文件 mtime —— 同样能表达「这个 starting 挂了多久」。 */
export function readDaemonInfo(): DaemonInfo | null {
  let d: DaemonInfo
  try {
    d = JSON.parse(readFileSync(DAEMON_JSON_PATH, 'utf8')) as DaemonInfo
  } catch { return null }
  if (!d.pid) return null
  try { process.kill(d.pid, 0) } catch { return null }
  if (d.startAt === undefined) {
    try { d.startAt = Math.round(statSync(DAEMON_JSON_PATH).mtimeMs) } catch { /* 判不了就缺着,staleStarting 保守放行 */ }
  }
  return d
}

/** 是否卡死在启动态:starting、port 未定、pid 活着,但 startAt 已是 STALE_STARTING_MS 前的旧闻。
 *  startAt 拿不到(无字段且 mtime 不可读)→ 保守返回 false(宁可多等,不误杀正常慢启动)。
 *  now 可注入(单测钉住「超时/未超时」两分支,不睡真时钟)。 */
export function staleStarting(d: DaemonInfo | null, now: number = Date.now()): boolean {
  if (!d?.starting || d.port) return false // 已就绪(starting:false 或 port 已定)谈不上卡死
  if (typeof d.startAt !== 'number' || !(d.startAt > 0)) return false
  return now - d.startAt > STALE_STARTING_MS
}
