# 生产红线修复规格(2026-08-28 双仓审计交接,未执行——待排期)

用户定约:app 与 ce 服务代码**不得有任何服务器写死路径**。以下发现均经独立 agent 复核确认,修复规格按最小改动给出。**执行原则:一次 PR 收敛全部 5 处 `python` 字面量与 claude 探测,禁止只修其一。**

## C1. python 解释器硬编码 ×5(启动即炸:标准 Ubuntu/Debian/Fedora 只有 python3)
- 位置:main.ts:101/114、jupyter-detect.ts:71、jupyter-launch.ts:58(pExecFile/spawn 'python');对照 main.ts:142 ensurePythonOrExit 探的是 python3 —— 前置检查形同虚设。
- 机制实测:shell:true 下解释器缺失 = **退出码 127**(非 spawn ENOENT),jupyter-detect 空 catch 吞掉 → detectServers 恒 [];launch 分支则 daemon exit(1) 起不来。
- 修:抽 `resolvePythonBin()`(win32='python';否则经 `--version` 实测先探 python3 再退 python;支持 `--python=` / `CE_PYTHON` 覆盖),注入 realJupyterDeps / detectServers / launchJupyter 替换全部 5 处;ensurePythonOrExit 复用同一解析;jupyter-detect 两子命令都 127 时 console.warn「未找到 python 解释器」不再纯静默;launch 的 close 分支翻译「127 + not found 尾巴」为可行动报错。

## C2. claude 探测三重机器假设(main.ts:277-290)
- 现状:候选表 ['claude','/usr/local/bin/claude','/usr/bin/claude'] + 外包 GNU `timeout 6`(macOS 无 timeout、Windows 无 sh → 全候选 127 → 静默 return 未经校验的裸 'claude');systemd user service 的 PATH 探测不到 ~/.local/bin / nvm / wrapper。
- 修:删 timeout 包裹(pExecFile 已有 {timeout:8000});候选 = `command -v claude`(复用 main.ts:126 commandExists)+ /usr/local/bin、/usr/bin、/opt/homebrew/bin、$HOME/.local/bin、$HOME/.nvm/versions/node/*/bin;全失败 → claudeBin=null 走显式 nocc/提示(**不再裸回 'claude'**),并把探测用 PATH 记入 ~/.ce/ce.log 便于排障。

## W1. jupyter root 静默兜底 process.cwd()(main.ts:197)
- 危害:detectServers 空/显式 --jupyter 对不上 port 时,root=ce 启动目录 → 该 root 成为 **agent cwd base(main.ts:412→agent-runner.ts:135)**与上传边界(uploads.ts:51),且被写入 ~/.ce/jupyter.json 固化(main.ts:264/225 复用时 saved.root 优先)。root 错 → 对话树与上传树分叉。
- 修:pickRoot 区分命中/兜底并打 warn(带候选 root);显式 --jupyter 模式要求同给 --workdir 或对不上 port 就 exit(1);**兜底分支得出的 root 禁止持久化**到 jupyter.json。

## W2. butler.ts:18 BUTLER_CWD='/tmp/ce-butler-cwd'
- 固定绝对路径。修:改 os.tmpdir() + 随机子目录(mkdtemp),或挂到 ~/.ce/ 下按需创建。

## 验收
- 全部修完后在**只有 python3、无 /usr/bin/python** 的干净容器里:ce --daemon 可起、detectServers 能探到已有 Jupyter、工坊/CC 对话可用;
- macOS(无 GNU timeout)上 claude 探测不再静默假通过;
- build + 仓内测试全绿;并在仓内加一条同款「无机器路径字面量」红线上锁测试(src/ 扫 /root/、/AI-project、personal_xm 等)。
