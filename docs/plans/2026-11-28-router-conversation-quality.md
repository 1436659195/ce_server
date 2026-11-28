# Router 自然交流改进 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Bot 接得住上下文、记得用户已经交代的要求、按事情的重要程度说话，减少重复受理和无关解释。

**Architecture:** 在现有 Router 内调整对外交流指令，补齐已有任务信息的披露，并用固定对话样本比较改前改后的行为。复用现有记忆、卷宗、Worker 和发送队列；第一版不增加人格 Agent、额外润色模型或新的偏好数据库。

**Tech Stack:** TypeScript、Bun、现有 Router 系统提示词与上下文、现有 Codex/Claude 适配器、独立测试 SQLite。

---

状态：代码已实现；验证范围、对照结果与待评阅项见 [验收记录](2026-11-28-router-conversation-evaluation.md)。日期：2026-11-28。本记录描述开发验收；本机部署状态以 `/root/.ce/latest-local-deployment.json` 为准。

## 1. 这次具体解决什么

期望用户的感受是：“它知道我正在说什么，也记得我前面交代过什么。”自然感主要来自理解与延续，不用靠每条加表情或主动找话。

| 实际观察 | 期望行为 | 对应改动 |
| --- | --- | --- |
| 反复“我先核对”“我会整理” | 新工作需要等待时接一句；连续补充不逐条重报计划 | 明确什么时候受理、什么时候直接回答或安静执行 |
| 解释二进制特征串、哈希等过程后，用户追问“啥意思” | 先回答运行版本是否一致；被追问时再讲判断依据 | 分开内部验收材料与对外结论 |
| 多次要求 TXT，后续修订仍出现长篇正文 | 同一成果的修订继续交 TXT，并传递具体格式要求 | 披露任务 delivery，沿用相关 acceptance/executionGuidance |
| 用户要求幽默后，许多回复只是追加 🔍、🔧 | 看语境接话；排障失败、焦急时用清楚平实的语气 | 用情境规则替代装饰性口吻 |
| “你接着说，worker1 怎么了？”比较自然 | 保留这种对未说完的话的直接回应 | 明确闲聊、补充、纠正不必转成工作汇报 |

此前抽样的三个真实 Bot 共 166 条已发送 Router 回复，其中 60 条标记为受理。受理本身有价值，不能单凭比例判定质量；评估重点是重复受理是否提供新信息。聊天跨越多个部署版本，不能把全部现象归因于当前源码的一版提示词。

另外两点要分清：用户明确要求成功后回复“已解决”，就应尊重；文件发送失败或排队延迟属于交付链路问题，本方案不声称改话术就能修复。Walle 的工作范围由用户明确限制，也不因追求自然感擅自扩大。

## 2. 第一版的修改范围

### 2.1 调整提示词的重点和结构

当前 [router.ts](../../src/cli/bot-runtime/router.ts:17) 已经要求自然表达、没有固定模板，因此不能只在末尾再加一句“像真人”。

将开头散落的交流规则合并为一个短的交流约定，随后保留任务、权限、验收、记忆、发送约束。同步清理重复或冲突的交流表述，工具参数等细节继续由工具定义说明。不要整体推翻已有权限和卷宗规则。

以下为交流约定的候选正文；它规定判断原则，示例不作为必须照抄的回复模板：

```text
你是与用户长期合作的数字员工，以同一个 Bot 的身份，用“我”自然接话。

1. 先理解这句话在当前对话里起什么作用：提问、交代工作、补充要求、纠正、闲聊，还是结束话题。接住当前意思，不把每句话都变成一次工作汇报。
2. 已有事实足够回答时，先直接回答。需要新调查时再承接工作；不能把准备做的事说成做完的事实。新工作需要等待时可以简短接一句，连续补充不重复宣布计划；没有新信息的确认可不回复，但必须实际处理请求。
3. 用户说“啥意思”“说简单点”，用日常话解释上一结论；不要自动新增调查、扩写技术过程或反复说明你将如何解释。用户在纠正你时，更新理解并继续。
4. 结合当前整批消息、近期双方原话、有效记忆和相关任务理解要求。同一成果的后续修订，继续遵循已经明确的格式、范围与交付方式；用户本轮明确改变时按新要求处理。不要把一项工作的局部要求套到所有话题上。
5. 接到内部工作结果后，用当前问题组织回答。先讲用户关心的结果，再补充影响结论、使用或下一步决定的条件。无关的检查过程留在内部；失败、未交付和实质性限制必须讲清楚。
6. 简单问题短答，用户要求原因时解释原因，要求报告时交付报告。字数是上限，不是目标，不要为了显得认真把气泡写满。
7. 口吻跟随用户和场景。可以轻松，可以有自己的判断；表情和玩笑只在自然、合适时使用，不每条添加。用户焦急或事情出错时先回应问题。
8. 用户的话明显没说完时，简短接住或等对方继续；需要澄清时只问当前最关键的缺口。已经问过且没有新情况，不换句话继续催问。
9. 不把对话习惯当成每轮必须播报的内容。遵循约定即可；只有真正完成记忆保存后，才可以说已经记住。是否写入、作用范围和冲突处理按现有记忆规则执行。
10. 用户只是收尾、确认，且没有新问题或必要事项时，可以不回。不要默认在每个回答后追加“还需要我做什么”或引出新话题。
```

原有事实、权限和格式规则继续生效。“两边版本已经同步一致”只能用于已经核实对应运行程序的一次结果，不能变成所有任务通用的成功话术。

### 2.2 把已有要求送到需要它的地方

目前 `RuntimeTask.delivery` 已持久保存，但 `routerContext().tasks` 和 `task_inspect` 的任务摘要没有直接披露该字段。增加它，使 Router 在接单、追问、验收时能够看见已有文件交付要求：

```ts
// router.ts 的 tasks 投影，以及 service.ts 的 task_inspect 返回任务信息：
delivery: task.delivery,
```

其中 `routerContext` 的回调变量当前为 `t`，对应使用 `delivery: t.delivery`。旧任务缺省保持未知，不能推断为 `chat`。

`files` 只表示文件，不能替代“TXT、简明步骤、分支说明”等具体要求。具体格式继续放入现有 `goal/acceptance/executionGuidance`：

1. 同一成果的补充或修订，先找原任务、验收要求和相关用户原话。
2. 延续该成果时，把仍适用的文件类型、内容范围写进后续任务的目标/验收要求；执行约束放入 `executionGuidance`。
3. 缺少原约定时按需调用现有聊天、任务或记忆查询；不额外启动一个模型总结整段历史。
4. 当前用户明确改变要求时遵循新要求；不要把“这次解释短一些”擅自升级为永久偏好。

日常口吻留给 Router；交付格式和报告内容传给 Worker。已有交流字数限制不向 Worker 的报告正文传播。

### 2.3 复用记忆，避免再维护一份用户设定

“以后回复简短些”“以后幽默一点”继续通过现有记忆机制保存和检索。使用已有来源、范围、覆盖关系与时效；本轮明确要求优先，不新建 `personality` 表或全局风格开关。

本次不预先改变模型或推理强度。先固定模型、配置和输入做对照，判断指令与上下文改动是否有效；仍存在明确问题时再单独比较模型配置。

## 3. 对照示例

以下“建议表达”需要对应事实已经成立，不是预置句库。

| 场景 | 建议表达或行为 |
| --- | --- |
| 用户问进程版本是否一致；已核实一致，用户指定过成功话术 | “两边版本已经同步一致。” |
| 用户问“进程哈希一致不就是一致的吗”；确实比较了两边正在运行的程序 | “对，两边运行程序的哈希一致，就说明这两份程序一致。前面那段解释可以省掉。” |
| 更新原排障说明；用户此前要求交 TXT，附件已经备好 | “更新后的排查步骤放在 TXT 里了。”并实际附文件 |
| TXT 尚未送达 | “TXT 已生成，但发送失败，还没送到你这里。”不能宣称交付完成 |
| 用户补充“把日志时间也加进去”；任务正在执行且补充已经接收 | 将要求追加到原任务；无需再发一段调查计划，必要时简短确认 |
| 用户“不是，我说错了” | “你说，哪里要改？”不立即新建调查任务 |
| 用户“谢谢，先这样”，没有其他待答事项 | 空 replies，结束本轮 |
| 用户“这下没有遗漏了吧”；仅完成限定范围的复核 | “这次对照清单的复核已做完，发现的遗漏都补了。线上效果还没验证。”后一句仅在影响本次判断时保留 |

## 4. 验收标准

### 固定对话集

准备 24 组由真实问题模式改写的匿名样本，每类 4 组：

1. 直接提问、追问解释、纠正和闲聊。
2. 新工作与连续补充，检查重复受理及动作是否真正提交。
3. 跨数轮延续 TXT 等交付要求，同时包含“这次改成口头说”的反例。
4. 内部结果包含无关检查细节，检查能否围绕用户问题表达。
5. 失败、附件缺失、尚未验证等实质条件，检查是否如实保留。
6. 偏好的作用范围、临时例外、必要澄清与结束对话。

每组包含完整的本轮用户消息、双方历史、有效记忆、任务状态及可用内部结果；预先写明应该完成的动作和不能丢失的事实。固定 8 组作为留出集，不用它们反复调提示词。

### 两类验证

- **确定性回归：** 任务交付字段披露、空回复不丢任务、文件要求延续、实际附件绑定、停止/恢复、权限和旧结果失效。验证输入输出及任务事实，避免测试“提示词包含某句话”。
- **真实模型对照：** 同一模型与配置，对修改前后分别跑全部固定样本，每组至少 3 次。评估自然度、是否答到点上、约定延续、冗余信息四项，每项 1～5 分；可由人工匿名成对比较，不以表情数量、单纯缩短字数或禁词命中率代替质量。

第一版通过条件：确定性回归全部通过；固定样本中无虚报成功、丢失任务、漏交必要附件或越权；人工对照中至少 70% 的样本组认为新版更好，且约定延续不退步。记录所有运行，不挑选最好的一次；这些是发布门槛，不是当前已经取得的结果。

受理率、平均字数、澄清次数只作诊断数据，不设“必须下降到多少”的硬目标。

## 5. 实施步骤

### Task 1：固化对照样本与改前基线

**Files:**
- Create: `test/fixtures/router-conversation-cases.json`
- Create: `scripts/bot-router-conversation-eval.ts`
- Reference: `scripts/bot-router-presentation-integration.ts`
- Reference: `src/cli/bot-runtime/router.ts`

1. 将上述 24 组场景改写为虚构项目和人物；不复制真实日志、账号和内网信息进版本库。
2. 每组保存输入上下文、允许的动作、必须保留的事实、约定的交付形式以及四项评分说明。
3. 评估脚本默认只检查样本完整性，传 `--live` 才调用模型。可用 `--platform=codex|claude`、`--runs=3`、`--instructions-file=<path>` 和 `--output=<path>`。
4. 复用现有适配器、`routerContext` 与 `bindRouterDecision`。工具读取由样本回放，动作写入仅记录在临时测试账本；发送仅捕获到本地数组，不连接真实用户，也不允许执行项目命令。
5. 修改前把完整 `ROUTER_INSTRUCTIONS` 保存到临时目录，连同模型配置、源码提交及工作区差异摘要保存，作为基线。运行基线后再改提示词，不能用记忆中的老回复代替受控比较。

实施后运行：

```bash
bun run scripts/bot-router-conversation-eval.ts
bun run scripts/bot-router-conversation-eval.ts --live --platform=codex --runs=3 --output=/tmp/ce-router-conversation-before.json
```

预期：前者完成 24 组输入校验；后者记录 72 次模型输出、动作校验结果及评分待填项。平台应选择实际使用的平台，改前改后保持一致。

### Task 2：替换交流约定，保留已有动作约束

**Files:**
- Modify: `src/cli/bot-runtime/router.ts` 的 `ROUTER_INSTRUCTIONS`

1. 用第 2.1 节的候选正文整合现有交流约定，删除重复表述，按真实模型对照修订。
2. 保留工具提交、能力判断、授权、卷宗续接、验收、记忆、用户整批输入与 superseded 处理要求。
3. 保留现有 100/500 字、最多三泡、附件和来源绑定策略；本轮不放宽长度来掩盖表达问题。
4. 不增加独立人格层模型，不在发送前做不可追溯的二次改写，不用固定回复替换模型判断。

运行：

```bash
bun test test/bot-router.test.ts test/bot-router-contract.test.ts test/bot-reply-policy.test.ts
```

预期：原有决策协议与表达格式约束通过。自然度由后续模型对照判断，单元测试通过不等于口吻达标。

### Task 3：补齐任务交付要求的上下文

**Files:**
- Modify: `src/cli/bot-runtime/router.ts` 的 `routerContext().tasks`
- Modify: `src/cli/bot-runtime/service.ts` 的 `task_inspect` 返回值
- Modify: `test/bot-case-continuity.test.ts`
- Modify: `test/bot-router-outlet.test.ts`

1. 先补以下用例到已有 `test/bot-case-continuity.test.ts`；使用该文件现有的 `fixture` 和 `bot`：

```ts
test('Router 可见原任务的文件交付方式及具体格式要求', () => {
  const { store, receive } = fixture()
  const task = store.acceptWork({ inputId: receive('整理为 TXT').id,
    newCase: { title: '排障指南', object: '示例服务', goal: '整理排障步骤' }, goal: '整理为 TXT',
    mandate, delivery: 'files', acceptance: ['交付 TXT 文件'], replies: [] })
  const context = JSON.parse(routerContext({
    bot, profile: '', messages: [], cases: store.cases('b'),
    tasks: store.tasks('b'), relatedTaskIds: [task.id], experienceSummaries: [],
  }))
  expect(context.tasks.find((t: { id: string }) => t.id === task.id))
    .toMatchObject({ delivery: 'files', acceptance: ['交付 TXT 文件'] })
})
```

2. 运行该测试，确认因未披露 `delivery` 失败，再在两个投影处加上字段。
3. 用已有 Router outlet 工具调用夹具检查 `task_inspect` 同样返回该字段；旧任务缺省不被伪造为口头交付。
4. 在对照样本中检查同一成果修订时 `delivery=files` 且保留 TXT 验收要求；新话题、明确修改要求时不错误继承。

运行：

```bash
bun test test/bot-case-continuity.test.ts test/bot-router-outlet.test.ts test/bot-reply-dispatch.test.ts
```

预期：字段披露与现有真实附件、发送时序测试通过。不能用“提示词写了要记得”代替任务和附件行为的验证。

### Task 4：对照验收与小范围验证

**Files:**
- Create: `docs/plans/2026-11-28-router-conversation-evaluation.md`，实际执行后填写

1. 保持同一模型与配置运行新版 72 次，盲评并记录逐组结果及未通过案例。若两种平台都用于生产，分别验证各自结果。
2. 运行当前检查，记录仓库既有失败和本改动新增失败，不能把已有未提交工作一并算成本次修改。

```bash
bun run typecheck
bun test test/bot-router.test.ts test/bot-router-contract.test.ts test/bot-reply-policy.test.ts test/bot-case-continuity.test.ts test/bot-router-outlet.test.ts test/bot-reply-dispatch.test.ts test/bot-chat-rhythm.test.ts test/bot-memory.test.ts test/bot-automation-router.test.ts
bun run scripts/bot-router-conversation-eval.ts --live --platform=codex --runs=3 --output=/tmp/ce-router-conversation-after.json
bun run scripts/bot-router-presentation-integration.ts --live --platform=codex
```

3. 在验收文档里保存样本得分、失败类型、模型配置、提示词版本、命令结果和回滚差异。现有 presentation 脚本只覆盖有限场景，不能代替新对话集。
4. 达到门槛后先用一个测试 Bot 做小范围体验，再决定部署。首次生效要确认建立了使用新指令的 Router 会话，不能把已有旧会话的回复当作新版结果。
5. 回滚只撤销本次提示词及字段披露的修改，不撤销用户当前未提交的记忆、Worker 或其他改动。计划阶段不重启、不部署。

## 6. 与主动联系方案的关系

本方案负责“开口后怎么说”；[主动联系方案](2026-11-28-bot-proactive-contact.md)负责“有没有必要、何时开口”。两者可以独立实施。

建议先把本方案的基础表达和约定延续做好，再实现主动联系。主动开口也使用同一交流约定，但仍要遵守独立的计划、到期复核与不打扰状态，不能因这次改善话术就自行创建主动事件。
