# 工作目录确认与原工单接续

版本：`v0.1.0-directory-approval`；配套卡片：APK 135，`1.0-20261126-directory-approval`。源码分支：`feat/bot-runtime`。

此前“停止任务 → 修改工作目录 → 继续”会因工单仍绑定旧策略版本而被拒绝。本次让主人明确确认后的同一工单在新目录继续：保留卷宗、工单、业务目标、完成标准、进度和历史成果，刷新目录授权，首次执行新建 Session。修改目录本身不自动派工。

## 两种确认方式

1. **手动修改后继续**：先停止任务，在数字人资料中保存新工作目录，再说“工作目录已经改了，继续吧”或点击继续任务。宿主核验当前 owner、旧执行退出、目录和全权限执行模式后，更新原工单。
2. **Bot 提出具体路径**：确需修改当前目录外文件时，Worker 使用阻塞式 `work_ask_user`，填写目标绝对路径 `directory` 和用途。宿主校验目录存在且位于设备文件根内，保存 `question.directoryChange`。主人可针对该申请回复“同意，继续”，也可在 APK 卡片点击“确认目录并继续”。

卡片显示原目录、目标目录和后续任务也使用新目录的说明。口头同意由前台选择 `approve_directory`；按钮直接提交同一控制动作。两者都绑定已保存的工单、需求版本、问题 ID、owner 与策略版本，控制请求不接受客户端自带目标路径。否定、讨论或指代不明确不能作为批准。

## 执行顺序与边界

确认后先停妥旧 Worker，再核验 owner、全部未决操作、策略版本及目标真实路径；保存新目录与策略后继续原工单。确认等待期间主人叫停或发来新的聊天消息，会撤销在途确认，新消息保留给前台处理；同一确认消息重传不会取消本次批准。重复请求去重，断线后重试同一请求不会重复派工。

以下情况仍阻止恢复或切换：其他活动任务、未知操作或执行结果、owner 改变、全权限执行模式降级、旧问题或策略版本、实际路径被替换。仅改变权限版本而目录未变，不会自动刷新旧授权。目标不能超出设备文件根，不能借符号链接越界。全权限仍遵守项目范围与业务授权。

新 Session 接收整批确认原话和附件，以及原工单已有补充限制。例如先说“只能修改 service.ts，不许改 store.ts”，再说“同意，继续”，前一句不能丢失。历史补充即使已经处理，也不能因此丢掉仍有效的约束。新目录授权只替代宿主产生的旧目录限制；业务目标、排除项和其他未回答问题保持有效。Worker 先核对文件现状，接续已有进度，不重复已完成操作。

身份、聊天、卷宗和成果不搬迁、不重建；项目文件不自动移动。后续任务使用新工作目录。原创建档案继续用于恢复数字人身份，不会把当前目录还原成初始目录。

## 前后端协议

- `work_ask_user.directory`：可选绝对目录；填写时必须是阻塞问题，确认前不修改范围外文件。
- `question.directoryChange`：`fromDirectory`、`toDirectory`、`policyRevision`，由宿主保存。
- `capabilities.directoryApproval`：CE 声明支持路径确认。
- `approve_directory`：提交 `taskId`、`expectedRevision`、`questionId`、`requestId`；具体路径从当前问题读取。
- 原任务的目录接续记录保存授权来源与目录变化；首次执行显示“新开 session”，之后正常停止/继续可恢复新 Session。

旧 CE 未声明能力时，APP 保留普通问答入口，不显示虚假的目录批准。卡片在收起任务详情时也能看到；离线、提交中或有未核对执行时禁用确认。已有设置中的工作目录入口继续可用。

## 验证

真实 Codex 已完成两条端到端场景：手动停止、换目录、明确继续；以及连续两条气泡先提出修改限制、再说“同意，继续”。后者由 Router 提交 `approve_directory`；确认前后端测试文件未改，确认后原工单、卷宗与补充限制保持，Worker 新建不同 Session，实际修改并读回相邻后端测试文件，最后交付结果。回复仅本地收集，不发送真实社交消息。证据目录分别为 `ce-directory-live-codex-mMk7VX` 与 `ce-directory-live-codex-kX27NX`。

后端完整测试：**650 pass / 2 skip / 0 fail**，2608 个断言、64 个文件，类型检查通过。独立复核 74 项及 4 个独立复现通过，无阻塞项。前端相关 29 项测试、类型检查、相关 ESLint 和生产构建通过。

APK 135 已构建：`releases/agent-net-2026-11-26-directory-approval.apk`，6,839,018 字节（约 6.84 MB）；包名、签名和权限与 APK 134 一致。**尚未在用户实际手机安装或点击确认卡片**；卡片验证范围为前端单元／provider 测试，不能等同真机端到端验收。

本机 CE 已升级并重启为 `v0.1.0-directory-approval`，PID 4151911；中继连接正常，身份保留及运行程序哈希均核对通过。备份位于 `/root/.ce/deployments/directory-approval-final-20261126T094015Z`。本次只构建 Linux x64 CE，不生成上传压缩包，也未更新公网下载或其他服务器。

复现目录场景：

```sh
bun test test/bot-worker-lifecycle.test.ts test/bot-onboarding.test.ts
bun run typecheck
bun run scripts/bot-directory-approval-integration.ts --live --codex
bun run scripts/bot-directory-approval-integration.ts --live --codex --manual
```

`--live` 使用本机已配置的模型账号，仅操作临时测试项目。
