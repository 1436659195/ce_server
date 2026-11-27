# Router 与 Worker 五项改进 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** 五项源码实现与自动化验证已完成，详见 [验收记录](2026-11-27-router-worker-verification.md)。未部署。

**Goal:** 落实已确认的五项：结构化交付摘要与返工、按来源限制回复和格式、按需传递执行指导、细粒度历史查询、输入框直接停止。

**Architecture:** 保留 CE 本地账本及单活动 Worker。Router 对 Worker 结果可提交有版本与来源绑定的修正要求；结果元信息与实际成果快照关联。聊天格式由宿主根据结果来源决定并传到客户端。历史查询在账本筛选、限量、分页；停止直接走控制面并使旧派工失效。

**Tech Stack:** Bun / TypeScript / SQLite；React / Vitest；现有 CC 与 Codex 运行适配器。

---

在现有工作区实施，保留前端已有修改及未跟踪源码；不提交、发布或替换运行服务。日历与第六项异常交付扩展不在范围内。

## Task 1: 回复格式、摘要与受限返工

Files: 后端 `src/cli/bot-runtime/{types,router,store,service}.ts`；新增测试 `test/bot-worker-review.test.ts`、`test/bot-reply-policy.test.ts`。

1. 先写并运行失败测试：普通回复 100 字纯文本、Worker 文字 500 字允许 Markdown、附件 100 字纯文本；未携带 Worker 来源不能取得宽限制。
2. 实现统一回复策略及宿主绑定格式，保持一次最多三泡和整组限长；测试覆盖混合气泡、附件及多泡。
3. 先写并运行失败测试：结构化文件摘要与真实附件及版本绑定、Router 无新用户输入也可在原工单范围内要求修正或生成附件、旧结果作废、修正次数受限。
4. 实现返工记录、Worker 原会话续接、必要的文本成果按需读取；更新提示词与工单可见状态。保留原目标、验收及授权，禁止内部事件发起任意新目标。
5. 运行 `bun test test/bot-worker-review.test.ts test/bot-reply-policy.test.ts`，预期全通过，再回归现有 Router/Worker 生命周期测试。

## Task 2: Router 按需传递执行指导

Files: 后端 `router.ts`、`types.ts`、`store.ts`、`service.ts`；测试 `test/bot-router-contract.test.ts`、`test/bot-worker-review.test.ts`。

1. 添加失败测试：新工单和补充指令携带 Router 筛选后的执行指导，原始用户补充仍完整保留。
2. 为派工、补充与返工提供有长度限制的指导字段，持久化并传给 Worker；不全量复制记忆，也不改变宿主权限。
3. 更新 Router 指令，明确筛选相关规矩、经验和验收要求；运行上述测试至全通过。

## Task 3: 历史对话按条件查询

Files: 后端 `store.ts`、`router.ts`、`service.ts`；新增测试 `test/bot-chat-history.test.ts`。

1. 添加失败测试：超过最近 100 条的旧对话、时间区间、指定条数、关键词、分页、双方角色、撤回与跨 Bot 隔离、长消息关键词及续读。
2. 实现 SQLite 条件筛选及稳定分页；返回条数、下一页游标、截断标志；按宿主预算返回适量内容。
3. 更新工具参数、时间戳和时区说明，接入 Router 查询入口。
4. 运行 `bun test test/bot-chat-history.test.ts`，预期全通过。

## Task 4: 输入框停止按钮与 Markdown 展示

Files: 前端 `src/components/groups/GroupChatPanel.tsx`、新增停止按钮组件及测试、`src/core/contract/types.ts`、中继消息类型与消息映射；后端 `chat.ts` 和中继消息契约。

1. 添加失败测试：停止按钮直接调用控制接口，等待确认、版本变化刷新、错误可重试；后端停止使旧 Router 派工失效。
2. 在输入行提供按钮，复用运行快照及控制能力；按消息显式格式渲染 Markdown，普通及附件气泡保留纯文本。
3. 运行针对性 Vitest 与后端停止/发送契约测试。

## Task 5: 回归、审查与记录

1. 运行后端 `bun test`、`bun run typecheck`；前端 `npm run typecheck`、`npm run lint`、相关 Vitest 和 `npm run build`。识别并说明原有失败，修复本次引入的问题。
2. 按要求及差异进行独立代码审查，修复重要问题并重跑受影响验证。
3. 将待开发清单更新为已实施并链接验收记录；记录测试命令及结果，区分源码验证与尚未执行的真机/真实模型验收。
