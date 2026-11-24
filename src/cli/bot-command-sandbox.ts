/** 项目命令必须通过 OS 文件系统和网络限制；不支持时拒绝，绝不退回裸 shell。 */
import { spawn } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 由 Python 设置 Landlock 后 exec，避免目标脚本有机会在限制生效前运行。
// ABI1 的 Landlock 不能限制网络，故另用 seccomp 拒绝 socket/connect/bind。
const RUNNER = String.raw`
import ctypes, ctypes.util, errno, json, os, sys
from pathlib import Path
cfg=json.loads(sys.argv[1])
libc=ctypes.CDLL(None,use_errno=True)
def require(result, name):
    if result < 0: raise OSError(ctypes.get_errno(), name)
    return result
abi=require(libc.syscall(444,0,0,1),'Landlock unavailable')
class Ruleset(ctypes.Structure): _fields_=[('handled_access_fs',ctypes.c_uint64)]
class Beneath(ctypes.Structure):
    _pack_=1
    _fields_=[('allowed_access',ctypes.c_uint64),('parent_fd',ctypes.c_int)]
handled=(1<<13)-1
if abi>=2: handled|=1<<13
if abi>=3: handled|=1<<14
rules=Ruleset(handled)
fd=require(libc.syscall(444,ctypes.byref(rules),ctypes.sizeof(rules),0),'create Landlock')
read=(1<<0)|(1<<2)|(1<<3)
def allow(path, rights):
    if not os.path.exists(path): return
    p=os.open(path,os.O_PATH|os.O_CLOEXEC)
    try:
        if not os.path.isdir(path): rights&=(1<<0)|(1<<1)|(1<<2)|(1<<14)
        rule=Beneath(rights,p)
        require(libc.syscall(445,fd,1,ctypes.byref(rule),0),'add Landlock rule')
    finally: os.close(p)
for p in ['/usr','/bin','/sbin','/lib','/lib64','/etc/passwd','/etc/group','/etc/nsswitch.conf','/etc/ld.so.cache','/etc/ld.so.conf','/etc/localtime','/etc/alternatives','/etc/ssl/openssl.cnf','/etc/ssl/certs','/proc/cpuinfo','/proc/meminfo','/sys/devices/system/cpu']:
    allow(p,read)
for p in ['/dev/null','/dev/urandom','/dev/random']:
    allow(p,(1<<1)|(1<<2))
allow(cfg['directory'],handled)
allow(cfg['scratch'],handled)
require(libc.prctl(38,1,0,0,0),'no_new_privs')
require(libc.syscall(446,fd,0),'restrict Landlock')
os.close(fd)
seccomp=ctypes.CDLL(ctypes.util.find_library('seccomp') or 'libseccomp.so.2',use_errno=True)
seccomp.seccomp_init.argtypes=[ctypes.c_uint32]
seccomp.seccomp_init.restype=ctypes.c_void_p
seccomp.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p]
seccomp.seccomp_rule_add.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint]
class ArgCompare(ctypes.Structure): _fields_=[('arg',ctypes.c_uint),('op',ctypes.c_uint),('datum_a',ctypes.c_uint64),('datum_b',ctypes.c_uint64)]
seccomp.seccomp_rule_add_array.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint,ctypes.POINTER(ArgCompare)]
seccomp.seccomp_load.argtypes=[ctypes.c_void_p]
seccomp.seccomp_release.argtypes=[ctypes.c_void_p]
ctx=seccomp.seccomp_init(0x7fff0000)
if not ctx: raise RuntimeError('seccomp unavailable')
try:
    # socketpair 仅进程内 IPC；拒绝所有外部 socket，包含 TCP/UDP/UNIX 及 raw。
    for name in ['socket','connect','bind','ptrace','process_vm_readv','process_vm_writev','mount','umount2','unshare','setns','bpf','keyctl','io_uring_setup','io_uring_enter','io_uring_register','kill','tkill','tgkill','pidfd_open','pidfd_getfd','pidfd_send_signal','rt_sigqueueinfo','rt_tgsigqueueinfo','setsid','setpgid','chmod','fchmod','fchmodat','fchmodat2','chown','fchown','fchownat','lchown','truncate','ftruncate','setxattr','lsetxattr','fsetxattr','removexattr','lremovexattr','fremovexattr','utime','utimes','futimesat','utimensat','link','linkat','openat2','reboot','swapon','swapoff','acct','quotactl','sethostname','setdomainname','settimeofday','clock_settime','adjtimex','clock_adjtime','kexec_load','kexec_file_load','init_module','finit_module','delete_module','perf_event_open','fanotify_init','userfaultfd']:
        number=seccomp.seccomp_syscall_resolve_name(name.encode())
        if number>=0 and seccomp.seccomp_rule_add(ctx,0x50000|errno.EPERM,number,0)<0:
            raise RuntimeError('seccomp rule failed')
    # ABI1 不控制 O_RDONLY|O_TRUNC。写打开由 Landlock 约束；只读打开的截断需另外拦截。
    for name,arg in [('open',1),('openat',2)]:
        number=seccomp.seccomp_syscall_resolve_name(name.encode())
        compare=ArgCompare(arg,7,os.O_ACCMODE|os.O_TRUNC,os.O_TRUNC)
        if number>=0 and seccomp.seccomp_rule_add_array(ctx,0x50000|errno.EPERM,number,1,ctypes.byref(compare))<0:
            raise RuntimeError('seccomp open flags failed')
    number=seccomp.seccomp_syscall_resolve_name(b'ioctl')
    compare=ArgCompare(1,1,0x5421,0) # FIONBIO：Node 为自己的 stdio 设置非阻塞。
    if number>=0 and seccomp.seccomp_rule_add_array(ctx,0x50000|errno.EPERM,number,1,ctypes.byref(compare))<0:
        raise RuntimeError('seccomp ioctl filter failed')
    # 不允许通过同 UID 的其他进程更改资源限制；当前命令自身 pid=0 可正常查询。
    number=seccomp.seccomp_syscall_resolve_name(b'prlimit64')
    compare=ArgCompare(0,1,0,0)
    if number>=0 and seccomp.seccomp_rule_add_array(ctx,0x50000|errno.EPERM,number,1,ctypes.byref(compare))<0:
        raise RuntimeError('seccomp process filter failed')
    if seccomp.seccomp_load(ctx)<0: raise RuntimeError('seccomp load failed')
finally: seccomp.seccomp_release(ctx)
if os.geteuid()==0:
    # no_new_privs 本身不移除已持有的 root capabilities。
    require(libc.prctl(28,3,0,0,0),'disable root capability regain')
    class CapHeader(ctypes.Structure): _fields_=[('version',ctypes.c_uint32),('pid',ctypes.c_int)]
    class CapData(ctypes.Structure): _fields_=[('effective',ctypes.c_uint32),('permitted',ctypes.c_uint32),('inheritable',ctypes.c_uint32)]
    header=CapHeader(0x20080522,0)
    caps=(CapData*2)()
    require(libc.capset(ctypes.byref(header),ctypes.byref(caps)),'drop capabilities')
os.chdir(cfg['directory'])
if cfg.get('probe'):
    try: os.open('/etc/shadow',os.O_RDONLY)
    except PermissionError: pass
    else: raise RuntimeError('Landlock probe failed')
    import socket
    try: socket.socket()
    except PermissionError: pass
    else: raise RuntimeError('seccomp probe failed')
    print('CE_BOT_SANDBOX_OK')
else:
    os.execve('/bin/sh',['sh','-c',cfg['command']],dict(os.environ))
`

interface CommandOptions { directory: string; command: string; signal?: AbortSignal; timeoutMs?: number }
let availability: Promise<boolean> | undefined
export function commandSandboxAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return Promise.resolve(false)
  return availability ??= sandboxProcess({ directory: tmpdir(), command: '', probe: true }).then(text => text.includes('CE_BOT_SANDBOX_OK'), () => false)
}

export async function runProjectCommand(options: CommandOptions): Promise<string> {
  if (!await commandSandboxAvailable()) throw new Error('当前机器不支持受控命令沙箱，命令未执行')
  if (!options.command.trim() || options.command.length > 16000) throw new Error('命令为空或过长')
  rejectHardlinks(realpathSync(options.directory))
  return sandboxProcess(options)
}

function rejectHardlinks(directory: string): void {
  const pending = [directory]
  let visited = 0
  while (pending.length) {
    for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
      // 不跟随符号链接；Landlock 对目录外的真实目标仍然拒绝访问。
      const path = join(entry.parentPath, entry.name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) continue
      if (++visited > 500000) throw new Error('项目文件过多，无法安全检查命令范围，请缩小 BOT 工作目录')
      if (info.isFile() && info.nlink > 1) throw new Error('工作范围包含硬链接，命令未执行；请移除硬链接或缩小工作目录')
      if (info.isDirectory()) pending.push(path)
    }
  }
}

async function sandboxProcess(options: CommandOptions & { probe?: boolean }): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'ce-bot-command-'))
  try {
    return await new Promise<string>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error('BOT 命令已取消')); return }
      const child = spawn(process.env.CE_BOT_PYTHON ?? '/usr/bin/python3', ['-I', '-c', RUNNER, JSON.stringify({ directory: realpathSync(options.directory), scratch, command: options.command, probe: options.probe })], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: scratch, NO_COLOR: '1', PYTHONNOUSERSITE: '1', npm_config_cache: join(scratch, 'npm-cache'), npm_config_userconfig: join(scratch, 'npmrc'), npm_config_globalconfig: join(scratch, 'global-npmrc') },
      })
      let output = ''; let settled = false; let terminationError: Error | undefined
      const stop = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 已退出 */ } }
      const finish = (error?: Error, text?: string) => {
        if (settled) return
        settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel)
        // 不允许 shell 留下逃离本回合的后台写文件进程。
        stop()
        error ? reject(error) : resolve(text!)
      }
      // 发出 kill 不等于进程已经退出；必须等 close 才允许调度下一个写入者。
      const requestStop = (error: Error) => { terminationError ??= error; stop() }
      const cancel = () => requestStop(new Error('BOT 命令已取消'))
      const timer = setTimeout(() => requestStop(new Error('项目命令执行超时，进程已终止')), options.timeoutMs ?? 60000)
      options.signal?.addEventListener('abort', cancel, { once: true })
      const collect = (chunk: Buffer) => {
        output += chunk.toString()
        if (output.length > 200000) requestStop(new Error('项目命令输出过大，进程已终止'))
      }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      child.on('error', error => finish(new Error(`命令沙箱启动失败：${error.message}`)))
      child.on('exit', () => stop()) // 同组后台子进程可能仍持有 stdout，先清理才会收到 close。
      child.on('close', code => {
        finish(terminationError, `退出码：${code ?? 'terminated'}\n${output}`)
      })
    })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
