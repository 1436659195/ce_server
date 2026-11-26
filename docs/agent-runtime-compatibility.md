# 数字人运行条件与 Agent 兼容性

版本：`v0.1.0-agent-compatibility`，2026-11-26。源码分支：`feat/bot-runtime`。

## 运行条件与配置

CE 正常运行并连接中继，手机已配对。被控机须安装所选的 Codex 或 Claude Code CLI，在运行 CE 的同一系统用户下完成登录或 API 配置，并能访问模型服务；不要求同时安装两个平台。工作目录必须存在且位于设备文件根内。Python/Jupyter 等宿主依赖沿用 CE 安装流程。

数字人创建时选 CC，前台、Worker、记忆整理均使用 Claude Agent SDK 调用本机 Claude Code；选 Codex 则使用本机 Codex app-server。各角色使用独立会话，目前共用同一模型设置，留空由运行时选择默认模型。

通用前台、Worker 和记忆系统指令编入 CE；姓名、岗位、新人指导、当前目录、权限和账本保存在被控机 `~/.ce/`。构建产物不含个人配置、身份或登录凭据。前台使用受控宿主工具，全权限 Worker 使用所选目录中的原生工具。

## 能力检查

- 取消 `Codex == 0.170.0`、`Claude Code == 2.1.220` 的硬锁，不改为最低版本或版本白名单。
- Codex 读取本机 app-server 帮助与实验 JSON Schema，检查创建/恢复、追加/停止、动态工具与权限字段，并用实际请求形状验证字段类型、嵌套结构和必填参数。启动后执行真实握手，并核对返回的沙箱与审批配置。
- CC 检查 SDK 所需 CLI 参数。实际会话必须收到并验证 `system/init`，核对会话、工具与权限模式；验证前禁止工具执行和成功结果，缺失初始化信息有 30 秒上限。
- 创建数字人时，前台和 Worker 各进行一次带随机 nonce 的无项目副作用宿主工具调用；只回复 READY 不算初始化通过。
- 仅缓存成功的静态能力检查，进程内最多 64 项，按可执行文件路径/元数据、CLI 版本、CE 适配器版本和权限模式区分。升级、替换可执行文件或切换权限模式会重新检查；失败不缓存。登录、网络、会话和实际权限检查不使用这个缓存。
- 登录、额度、网络、接口不兼容分别报告，原始 SDK/RPC 错误中的凭据不直接进入聊天。
- Session 恢复失败保留原卷宗及 Session 记录，不静默创建新 Session 并重跑任务。活动输入和停止仍按真实轮次校验。

静态检查不能证明未来版本的全部运行语义。已支持能力的新版本允许启动；缺失必要能力时明确阻止相关运行，并提示更新适配器或使用兼容 CLI，不自动降级系统安装。

## 本次验证

- 完整后端测试：**638 pass / 2 skip / 0 fail**，2509 个断言，64 个文件；TypeScript 检查通过。
- 独立复核：协议形状、初始化门禁、错误分类问题已修复；针对性 50 项复核通过。
- 真实 Codex **0.172.0**：工具调用、活动输入、原 Session 恢复、停止通过；前台原生写文件尝试被执行环境拒绝，未生成 canary 文件。
- 真实 CC **2.1.220**：工具调用、活动输入、保留原始 nonce 的会话恢复、停止通过。
- Linux x64/arm64、macOS x64/arm64、Windows x64 五种编译目标构建成功；真实模型测试运行于 Linux x64，其他系统未进行真机运行验证。
- 本次未更新在线 CE 或公网下载目录；按用户要求交付源码，由部署方拉取构建。

复现：

```sh
bun test
bun run typecheck
bun run scripts/agent-compatibility-integration.ts --live --codex
bun run scripts/agent-compatibility-integration.ts --live
bun run scripts/bot-runtime-spike.ts --live
bash scripts/build-binaries.sh
```

`--live` 会使用本机已配置的模型账号，测试仅使用临时上下文与验证工具，不发送社交消息。源码还包含本次之前已验收的卷宗接续、标题演进、Session 来源标识和工作目录修改；未带入开发区未完成的 remote-shell 改动。
