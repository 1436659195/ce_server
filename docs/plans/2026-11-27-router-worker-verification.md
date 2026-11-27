# Router / Worker 五项改进验收记录

日期：2026-11-27。对应[确认需求](2026-11-27-router-worker-backlog.md)及[实施计划](2026-11-27-router-worker-implementation.md)。

## 实施结果

| 项目 | 已实现行为 | 主要验证 |
| --- | --- | --- |
| 摘要与验收返工 | Worker 逐文件提交内容、覆盖要求、检查及局限；宿主绑定真实附件 hash/revision；Router 默认审摘要，可抽查文本；revise 复用原工单/卷宗及执行会话，最多三轮；取消旧交付，仅通过验收的结果进入经验 | bot-worker-review、bot-worker-lifecycle、bot-router-outlet、bot-router-contract |
| 回复限制与格式 | 普通聊天整组 100 字纯文本；本轮 Worker 文字整组 500 字，可用 Markdown；附件交付整组 100 字纯文本；最多三泡；显式格式经加密历史和实时消息传递 | bot-reply-policy、bot-router-outlet、bot-runtime-rpc、ChatMessageText、groupAttachments |
| 按需执行指导 | start/append/ask_worker/answer/revise 可传 executionGuidance；用户原话独立保留；已消费的相关指导在恢复时仍提供，不全量复制 Router 记忆 | bot-worker-review、bot-worker-lifecycle、bot-router-contract |
| 历史查询 | 全部保存原文及附件名搜索；from/to/limit/author/order/cursor；按真实消息 ID 续读；限当前 Bot 与私聊；撤回、跨 Bot、内部 Worker 消息隔离；结果按 JSON 预算裁剪 | bot-chat-history、bot-worker-lifecycle、bot-reply-dispatch |
| 输入行停止 | 直接调用宿主控制，优先运行任务；包括排队、运行、等待、恢复、待验收；请求中反馈、失败重试、请求去重、版本刷新；宿主取消未提交旧派工及旧交付 | BotStopButton、BotWorkCard、GroupChatPanel.botRuntime、ChatAttachments、bot-router-outlet、bot-worker-lifecycle |

待验收沿用 task.state=completed，以 task.review.state=pending 区分 Worker 已提交与 Router 已核对；前端显示“核对中”。模式或权限切换同样会停止待验收任务。超过最近 30 条的待验收任务仍保留在控制视图。

内部返工通知使用真实来源消息 ID 去重。旧 Worker 成功 work_finish 后先退出，再恢复修正会话，避免返工抢占尚未退出的执行轮次。

## 最终验证

后端目录 `ce-server-repo`：

- `bun test`：727 passed，2 skipped，0 failed；73 个测试文件，3027 次断言。
- `bun run typecheck`：通过。
- `git diff --check`：通过。

前端目录 `ce-platform-social`：

- `npm test`：1994 passed，0 failed；208 个测试文件。
- `npm run build`：通过，包含 TypeScript、ESLint 和 Vite 构建。
- `npm run lint`：通过。
- 构建仍有大于 500 kB 的打包体积提示，不影响本次构建成功；未为本次增加新依赖。

独立审查已复核验收返工、停止竞态、结果来源限制和前后端格式传输。发现的待验收任务未随模式切换停止、内部通知去重键冲突、未通过验收的初稿进入经验库、停止目标优先级及部分视图兼容问题均已修复，并有相关回归覆盖。

## 运行边界

本次完成源码、组件/协议测试及模拟 Router/Worker 的宿主集成测试。随后按用户要求重新构建 APK：versionCode 139，`1.0-20261127-router-worker`，见 [APK 发布记录](../../releases/README.md)。构建、签名、对齐、ZIP 完整性及 80 个内置前端文件与 dist 比对通过，与 138 同签名、同权限。未替换运行中的服务、未安装 APK、未做真实模型与手机端完整联调，也未提交或推送 Git。

摘要的语义准确性和是否需要返工由 Router 判断；宿主校验来源、版本、附件绑定及次数，不能保证模型每次判断都正确。Router 直接抽查仅支持文本附件，复杂二进制交给 Worker 检查。

停止按钮控制已经存在的工单；尚未生成工单的 Router 纯推理不在本次控制范围。点击直接停止会取消当时未处理的输入批次，并保留可重试记录，防止旧批次又派活；点击后新到的明确请求仍可处理。已经修改的文件不会自动回滚。

日历、定时和事件唤醒本次暂缓。
