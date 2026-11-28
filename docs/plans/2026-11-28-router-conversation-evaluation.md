# Router 自然交流改进验收记录

日期：2026-11-28。对应[实施方案](2026-11-28-router-conversation-quality.md)。本记录覆盖代码开发与回放验收；本机部署状态以 `/root/.ce/latest-local-deployment.json` 为准。

## 实际修改

- `src/cli/bot-runtime/router.ts`：整合交流约定，区分提问、补充、纠正、闲聊与收尾；明确可以直接解释已核实的事实；延续同一成果的交付要求；通过两个信息取舍示例区分无关未知项与实质限制。
- `src/cli/bot-runtime/router.ts`、`service.ts`：任务上下文与 `task_inspect` 披露已持久保存的 `delivery`。旧任务缺省保持未知。
- 新增 24 组虚构对话、独立回放脚本及其回归测试。脚本默认仅验证样本；显式 `--live` 才调用模型。

生产改动沿用原有模型配置、记忆、权限、工具参数和气泡约束。没有增加模型调用层，也没有实现主动联系事件。

## 回归与真实链路

改前：类型检查通过；相关 9 个文件共 120 项测试通过。

改后：类型检查通过；相关 10 个文件共 133 项测试通过，包含 13 项新增测试。两处交付字段测试均先在旧实现下复现缺失，再在修复后通过。

新增评估测试验证真实账本不会吞掉附件或必要问题、不会接纳伪造记忆/取消引用、空回复仍会实际追加需求，以及聊天查询包含 Bot 历史。独立代码审查通过。

真实 `BotRuntimeService` 表达链路：Codex 与 Claude 均通过产品关系场景。最初 Claude 在旧提示词、新提示词第一稿下都会追加无关沿革说明；补充取舍示例后，最终两平台均通过。所有探索日志保留，没有将失败的试验当成通过。

## 固定对话对照的方法

使用六类各 4 组、合计 24 组样本，其中 8 组为留出集。每组每版运行 3 次，正式基线和最终版本各 72 次。固定 Codex 模型 `gpt-6.1-sol`、推理强度 `low`、样本及输入时间。

正式对照将相同的新任务上下文分别交给旧、新提示词，衡量提示词效果；`delivery` 披露的修复由独立回归验证，不能把本对照称为整套旧系统与新系统的完整比较。

回放复用生产 Router 工具绑定、真实 SQLite 账本的接单、补充、返工、成果表达与历史查询。写入仅发生在临时虚构账本，发送不连接真实用户；停止动作只模拟账本状态，真实进程停止、权限、过期结果与发送语义由现有 runtime 回归覆盖。

第一轮探索回放的工具约束不完整，审查后已弃作正式依据。修正后重跑旧提示词基线。中间提示词版本的输出单独保存，最终统计只对应最终源码的提示词哈希。

## 正式对照结果

两版各 72 次均完成，动作与真实账本提交检查为 0 失败。两版逐条输入哈希完全一致，提示词哈希不同。

| 版本 | 回放次数 | 动作/提交检查失败 | 回复字符数中位数 | 空气泡组数 |
| --- | --- | --- | --- | --- |
| 旧提示词 | 72 | 0 | 29.5 | 12 |
| 最终提示词 | 72 | 0 | 27 | 13 |

字符数与空气泡数只作诊断，不代表更自然。未对自然度作自动通过判定。

- 模型：`gpt-6.1-sol`，effort：`low`，CLI：`codex-cli 0.172.0`。
- 样本 SHA-256：`eacaa91b704eeebb204a06b4dc93e7efca593f337627714363186022ae4e70d6`。
- 旧提示词 SHA-256：`1674086a1435fafcdd983ec2d365ebcb1dc555be5525da97c64993999d57888b`。
- 最终提示词 SHA-256：`0e1e730bf153e532dc4075c36610f770da211223c4bf9723526cec83a0e2f4e9`。
- 原始回放：[旧提示词](/tmp/ce-router-conversation-baseline-20261128/baseline.json)、[最终提示词](/tmp/ce-router-conversation-baseline-20261128/final.json)。
- [匿名成对评阅表](2026-11-28-router-conversation-blind-review.md)包含全部 24 组、每组各 3 次结果，不挑选最好的一次。A/B 对应关系单独保存在本机回放目录，表内没有版本标记。

## 评分与发布范围

程序可以判断决策格式、关联对象、交付形式和真实账本提交是否合法，不能自动证明每句内容属实或自然。逐次结果保留事实清单、评阅说明及四项待评分字段：自然度、答到点上、约定延续、冗余程度。

人工盲评尚未完成，因此不宣称达到方案中“70% 样本组更好”的发布门槛。开发与程序验证不等于主观体验验收；开发验收阶段没有重启、替换或部署用户正在使用的 Bot；后续部署按用户的明确指令独立执行。

## 复现

```bash
bun run typecheck
bun test test/bot-router.test.ts test/bot-router-contract.test.ts test/bot-reply-policy.test.ts test/bot-case-continuity.test.ts test/bot-router-outlet.test.ts test/bot-reply-dispatch.test.ts test/bot-chat-rhythm.test.ts test/bot-memory.test.ts test/bot-automation-router.test.ts test/bot-conversation-eval.test.ts
bun run scripts/bot-router-conversation-eval.ts
bun run scripts/bot-router-conversation-eval.ts --live --platform=codex --model=gpt-6.1-sol --runs=3 --output=/tmp/ce-router-conversation-evaluation.json
bun run scripts/bot-router-presentation-integration.ts --live
```

原始对照、旧提示词、原始工作区快照及回归日志位于本机 `/tmp/ce-router-conversation-baseline-20261128/`。其中 `before.json` 是已弃用的探索记录，`candidate.json` 是中间提示词版本；正式统计使用 `baseline.json` 与 `final.json`。复用旧指令可传 `--instructions-file=<旧提示词文本路径>`；用 `--split=tune` 调整时不使用留出集。

运行服务首次采用新指令时需创建新的 Router 会话。回滚只撤销本次提示词与两处字段披露，原有记忆及其他未提交修改不包含在本次回滚范围内。
