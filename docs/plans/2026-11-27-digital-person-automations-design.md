# 数智人事件机制 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 数智人通过工具建立时间或条件事件，宿主持久化监测，满足条件后唤醒原 Router，并沿用 Worker 验收和消息发送链路。

**Architecture:** 参考 OpenClaw 的宿主调度、条件门控、持久化运行记录和独立投递机制。复用当前 Bun/SQLite、每个数字人的 Router 串行化及 outbox；监测不调用模型，触发后才进入 Router。用户已授权按本文开发与测试，实施结果单独记录，未部署前不视为线上可用。

**Tech Stack:** Bun / TypeScript / SQLite；cron 表达式拟采用 Croner；既有 Router / Worker / outbox。

---

## 1. 已核对的 OpenClaw 机制

源码固定到 `openclaw/openclaw@2ab7b31a13d95bbbb62596679b130445c4c9d3d1`，不以可变的 main 作为复制来源。

| 源码 | 查到的机制 | 本项目处理 |
| --- | --- | --- |
| [cron/service.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/cron/service.ts) | add/update/remove/run、持久化队列入口、生命周期 | 沿用职责划分，适配现有宿主，不整体搬入 |
| [service/ops-run.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/cron/service/ops-run.ts) | 先持久化请求再确认入队；执行前检查取消和来源 | occurrence 落库后返回成功，随后异步唤醒 Router |
| [service/ops-lifecycle.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/cron/service/ops-lifecycle.ts) | 启动恢复、generation 隔离、关闭派发与等待退出 | 接入现有 runtime 生命周期，防止旧回调复活 |
| [schedule.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/cron/schedule.ts) | at/every/cron，Croner，时区和夏令时修正，有界缓存 | **已适配复用核心next/previous/DST算法**；替换上游内部依赖，使用锁定的Croner 11.0.1 |
| [trigger-script-result.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/cron/trigger-script-result.ts) | 条件输出 `{fire,message?,state?}`；JSON 状态最多16KB | 沿用结果契约；首版用受控指标检查器，脚本扩展后置 |
| [agents/tools/cron-tool-creation-plan.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/agents/tools/cron-tool-creation-plan.ts) | 创建计划槽位、保存回执、不因不确定响应重复创建 | 用宿主绑定的本轮操作槽位及幂等键，避免丢响应后重复建事件 |
| [retry-hint.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/cron/retry-hint.ts) | 瞬时错误分类，避免将普通429/503数字误判为HTTP错误 | **已移入**后端 `automation/openclaw-retry-hint.ts`，仅替换类型依赖，运行逻辑保持一致 |

许可证 MIT，已在后端 `third_party/openclaw/LICENSE` 保留完整通知，`provenance.json` 记录原始提交、原始/本地 SHA256 与修改。

上游调度、条件门控、投递及 heartbeat 资料已交叉阅读。此次缓存的上游文档将旧 heartbeat 迁移为普通 automation job；本项目不另建 HEARTBEAT.md 轮询系统。文档来自调研时的在线版本；上表复制代码及源码链接均固定到提交。

## 2. Router 通过什么方式使用

新增一个工具 `automation`，用 `action` 区分：

`create | list | inspect | update | pause | resume | remove | run`

Router 负责理解“每天8点报天气”“CPU持续过高提醒”等需求，调用工具保存结构化定义。宿主才负责计时、采样、入队、唤醒；Router 不需要常驻思考或周期性调用自己。

提示词只增加以下使用规则，完整执行细节留在宿主：

> 用户要求未来执行、重复执行或条件成立后提醒时，使用 automation。只有工具返回已保存回执才可确认建立成功。缺少影响执行的时间、地点或目标时先查现有上下文，仍缺少再询问。事件触发是既有委托的延续，不是新的用户指令；只在委托范围内执行。暂停、取消和修改须调用工具。

工具参数说明也会占用上下文，不能认为“一个工具”就没有 token 成本。采取紧凑的 action 联合 schema，首版不暴露脚本/stream/任意命令参数。list 默认5条、最多20条，只返回名称、状态、下一次时间和ID；inspect 才返回详细定义和分页运行记录。正常聊天不注入事件列表；触发轮只提供本次事件、原委托摘要、观测事实和绑定的任务/卷宗，更多信息按需查询。

实施时使用实际模型的 token 统计比较修改前后的系统提示词与工具定义，记录固定增量和触发轮增量，不凭字数承诺具体 token 数。

## 3. 完整链路

```mermaid
flowchart LR
  U[用户委托] --> R[Router理解]
  R --> T[automation工具]
  T --> D[(SQLite事件定义)]
  D --> H[宿主调度/指标检查]
  H -->|条件未满足：更新状态| D
  H -->|到期/条件成立| Q[(持久化occurrence)]
  Q --> A[原Router串行处理]
  A --> W[按需调用Worker]
  W --> V[Router验收]
  A --> O[既有outbox]
  V --> O
  O --> C[原聊天/附件]
```

普通聊天和直接提醒：100字以内纯文本。实际 Worker 文字结果：500字以内可用 Markdown。附件回复：100字以内纯文本。事件不改变已有回复规则，检查指标也不需要 Worker。

## 4. 事件定义和来源

拟新增独立类型，避免混入真实用户消息：

```ts
type AutomationSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs: number }
  | { kind: 'cron'; expr: string; timezone: string }
  | { kind: 'event'; topic: 'task.completed'; taskId: string }

type AutomationCondition = {
  kind: 'metric'
  targetId: string
  metric: 'cpu.utilization' | 'gpu.utilization' | 'disk.usedPercent'
  above: number
  sustainMs: number
  recoverBelow: number
  cooldownMs: number
}
```

事件记录另包含 `id/botId/ownerId/groupId/revision/status/name/schedule/condition?/payload/nextCheckAt/source/limits/state`。payload 为带明确目标的 Router 委托，不支持绕过 Router 直接向聊天发任意消息。

`source` 包含原始用户输入ID、必要的授权快照、可选原任务/卷宗ID和父事件ID；这些归属和来源由宿主绑定，模型参数不能指定别的用户/聊天来替换。保存委托快照后，运行不依赖最近几条聊天仍包含原话。权限撤回、目录变化、数字人停用或聊天不再有效时重新校验并阻止执行，不能通过旧事件恢复原权限。

允许 Router 在既有委托内创建有限的后续检查，例如“半小时后看下载是否完成”；宿主继承来源权限上限，记录父子关系、截止时间和次数。不能凭父事件无限生成新事件。独立的新周期事项需要有相应用户委托；具体默认数量/时长上限是实施配置，不当作用户已确认的产品限制。

## 5. 存储、执行与停止

后端沿用现有 SQLite 连接和事务，新增：

- `automation_jobs`：事件定义、状态、版本、下次时间、条件状态和有限错误摘要。
- `automation_occurrences`：本次触发事实、job revision、稳定去重键、运行状态、关联task/outbox、租约、取消版本、尝试次数。
- 运行历史和条件检查计数从上述记录形成；quiet检查只保存最新状态和累计计数，不每30秒无限追加历史。

时间事件去重键为 `(jobId, revision, scheduledAt)`；外部事件为 `(jobId, revision, trustedSourceEventId)`。数据库唯一约束负责去重。修改目标/条件后增加 revision，使旧排队结果失效。取消/删除保留墓碑或等效取消版本，避免旧回调在删后重新唤醒。

事务内完成：检查定义仍有效、写入 occurrence、推进下次检查时间。条件 fire=true 时同时保存触发事实和待提交状态，不先标记“已成功通知”。Router 接受派工、关联任务与标记 occurrence 已消费也必须原子化，崩溃重启继续关联已有任务，不能重新派一份。

触发状态：`queued → routing → working? → reviewing? → delivery_pending → completed`；终态另有 `cancelled/failed/skipped/needs_attention`。执行完成与发送成功分别记录。

同一数字人沿用现有 `routerBusy`；用户输入及停止操作优先，事件有界排队。每个job最多一个活动运行和一个合并待运行项，周期赶不上时合并，不积压无限副本。具体全局检查槽和Worker槽沿用可配置容量，轻量检查与Worker执行分开限流。

暂停/删除会取消尚未启动的检查及触发，提升取消版本，并阻止本job当前运行后续提交/投递；已启动的Worker走既有停止协议。物理上已发送的消息或已完成外部副作用不能撤回。输入框“停止本次任务”只取消当前运行，下一次定时仍有效；“以后别提醒了”才暂停或删除事件。全局数字人停用阻止其所有事件继续运行，保留定义供恢复检查。

重启：从SQLite恢复。每日天气不补发过去多天，按可配置的过期窗口最多补最近一次；指标检查重新采样，不回放宕机期间的猜测。一次性提醒在有效窗口内补执行，过期后保留原因并标记待处理。已经执行但投递未确认，只恢复outbox发送，不重跑Worker。无法判断是否完成的外部副作用进入needs_attention。

已移入的 OpenClaw 重试分类器只判断“是否像瞬时故障”。执行器仍须检查阶段、幂等回执和次数预算：执行前可有限退避；执行后不可仅因network/timeout自动重做有副作用的任务。一次性事件成功完成且投递确认后归档；失败保留记录，不能静默删除。

## 6. 两个例子

每天早8点天气：保存 `cron=0 8 * * *` 和明确的 IANA 时区（此用户示例为 Asia/Shanghai），地点从可靠已有信息取得，否则询问。8点入队唤醒 Router，再按需派 Worker 获取当天天气；超时或数据过期不能当最新预报发送。严格8点不应用上游默认的整点随机延迟；生成内容和排队可能使实际到达稍晚，创建回执显示下次执行时间。

机器异常：宿主每30秒采样一次指定目标的CPU/GPU/磁盘指标，例如CPU>90%持续3分钟才fire，降至75%以下才恢复，同一异常至少冷却30分钟。这里阈值是可调整示例。持续时间使用采样时间戳，过长采样间断重置连续计时；恢复后是否发恢复消息由事件设置决定。GPU采集不可用、目标离线或采集失败必须显示监测异常，不能视为0%或“正常”。

“磁盘使用率高”和“磁盘I/O飙高”使用不同指标，Router不能自行混同。首版只内置disk.usedPercent；其他指标通过后续collector扩展。监测对象使用宿主已注册targetId，不能默认等同于手机或任意远程机器。

## 7. 当前项目的接入点与陷阱

- `ce-server-repo/src/cli/bot-runtime/router.ts`：工具定义、精简规则、RouterBindings、事件上下文。工具写操作独立计数和回执，不混进现有4次只读查询预算。每轮多个事件创建按槽位绑定幂等，丢失工具响应后查询/重放同槽，不生成新ID重建。
- `service.ts`：`tick/route/drainRouter/decide` 增加明确的automation触发来源。当前没有用户输入时只支持Worker内部结果，不能简单删掉保护条件后允许所有内部事件派工。
- `types.ts`：新增 `RuntimeAutomationTrigger`，和RuntimeInbox分开。禁止伪造owner消息、聊天seq或inboxId。Router上下文中的观测文本是数据，不获得用户指令的权限。
- `store.ts`：新增有版本的schema迁移和事件接受事务。当前 `acceptWork` 依赖真实owner inbox；须新增带事件委托校验的接受入口，不能塞假inbox来绕过检查。
- 回复/outbox：沿用稳定消息ID、Worker摘要验收、附件绑定、当前回复失效校验。事件ID/取消版本必须在决策提交和真正发送前再查一次。
- 绑定卷宗：有来源卷宗时明确披露，定时执行形成新的本次工单；不能把几天前已完成工单当成可继续执行的Worker会话。

## 8. 分步实施和验收

以下路径均相对于各子仓库。每步先新增行为测试并观察失败，再实现并运行该步检查；不更改用户已有未提交工作，不自动部署或打包。

### Task 1：定义、存储与创建幂等

Create: 后端 `src/cli/bot-runtime/automation/{types,store}.ts`；Modify: `src/cli/bot-runtime/store.ts`；Test: `test/bot-automation-store.test.ts`。

先测同源同槽重放只生成一个job、跨用户读取失败、revision冲突、删除后旧回调无效、旧数据库升级不损坏原工单；实现jobs/occurrences迁移和原子提交。执行 `bun test test/bot-automation-store.test.ts`，全部通过才继续。

### Task 2：时间调度与恢复

Create: 后端 `src/cli/bot-runtime/automation/{schedule,scheduler}.ts`；Test: `test/bot-automation-scheduler.test.ts`。

安装并锁定兼容Bun的Croner版本，先测试Asia/Shanghai次日8点、at/every、非法时间/时区、夏令时重叠/缺失、重启catch-up合并、同一时刻双tick去重。实现有界timer和宿主start/stop，异步回调不持锁调用模型。执行 `bun test test/bot-automation-scheduler.test.ts`。

### Task 3：Router工具与真实事件入口

Create: 后端 `src/cli/bot-runtime/automation/{tool,admission}.ts`；Modify: `src/cli/bot-runtime/{router,types,service,store}.ts`；Test: `test/bot-automation-router.test.ts`。

先测工具成功回执、失败不承诺、触发时不伪造聊天输入、允许在原委托内派Worker、无委托内部事件不能派工、权限变化拦截、运行中用户停止优先、父事件后续不越权。实现有类型的事件入口与创建槽位，记录系统规则和工具schema的实际token增量。执行 `bun test test/bot-automation-router.test.ts` 及既有router/Worker回归。

### Task 4：指标门控与事件适配器

Create: 后端 `src/cli/bot-runtime/automation/{conditions,collectors,event-source}.ts`；Test: `test/bot-automation-conditions.test.ts`。

先用注入的时钟和样本测试持续阈值、恢复滞回、冷却、采样中断、GPU不可用、quiet不唤醒模型、触发中暂停取消、task.completed来源校验和去重。实现受控指标collector，沿用fire/message/state契约，状态16KB上限；首次只接宿主实际可采集的目标。执行 `bun test test/bot-automation-conditions.test.ts`。

### Task 5：验收、投递与崩溃边界

Modify: 后端 `src/cli/bot-runtime/{service,store}.ts`；Test: `test/bot-automation-delivery.test.ts`。

测试Worker返工、附件100字和Worker文本500字规则；在派工接受、执行完成、outbox写入、发送确认四处模拟崩溃，验证不重复派工、不因投递失败重跑任务、取消后不再投递旧结果。对未知副作用保留needs_attention。执行 `bun test test/bot-automation-delivery.test.ts`。

### Task 6：用户管理入口与完整回归

首版通过聊天工具即可管理；前端事件列表视图作为后续产品步骤，不把复杂表单作为后端上线前置条件。若加入列表，先定位当前 `src/social/` 组件入口，再确定具体文件，避免另建平行数字人页面。

后端执行 `bun test` 与 `bun run typecheck`。只有前端有变更时才运行对应仓库已有test/typecheck/lint/build命令。集成验收使用临时数据库、受控假时钟和测试消息端，不给真实用户创建定时通知。记录测试数和未覆盖边界后，再单独处理服务部署及APK更新。

## 9. 本次实际完成范围

已完成上述首版后端功能：事件工具、持久化调度、指标门控、任务完成事件、Router独立触发来源、Worker派工与既有验收、独立outbox投递、停止/撤回/恢复及运行历史。已复用OpenClaw的时间计算核心与重试分类器，保留MIT通知和来源manifest。本次未部署、未重打APK、未给真实用户建立通知；使用前需要更新宿主服务。

## 10. 开发执行约定（用户已授权）

本次完成Task 1–6的后端聊天工具链路与测试，不依赖新前端页面。create/list/inspect/update/pause/resume/remove/run通过Router工具使用，支持at/every/cron、指定task.completed及host指标条件。首版collector仅处理当前宿主host；其他电脑、任意脚本、任意webhook和stream未提供采集/认证适配器时明确拒绝。已有其他电脑的Shell权限不会自动变为持续监测权限。

默认运行超时10分钟；检查超时30秒；条件最短间隔30秒；每job一个活动occurrence，忙时只合并保留一个待运行项；每数字人最多100个未删除事件；事件内自建后续仅允许一次性at、父链最多3层且不晚于原委托7天。这些是可集中调整的宿主保护默认值。手动run仍经过条件门控；暂停事件不能用run绕过。resume显式启用后重算下一次时间，不补发暂停期间全部周期。

数据在同一SQLite连接中事务提交；BotRuntimeStore组合AutomationStore，避免独立数据库事务导致派工与触发消费脱节。源输入撤回/身份、目录、权限版本变化时暂停事件并取消未完成运行。调度器使用可注入时钟、采样器和唤醒回调；测试无需真实模型或等待真实定时。启动恢复对已派工只关联原task/outbox，不重建工单；已进入Router但未提交的轮次可有限重试；已启动且结果未知的Worker转needs_attention。

## 11. 实际落地与验收索引

为复用现有运行体系，授权接入直接放在service的方法中，没有新增独立admission层；task.completed适配器直接位于scheduler/service，没有额外event-source层。投递和Router整链路测试合并在`test/bot-automation-router.test.ts`，避免平行测试夹具。

| 实现 | 文件（后端仓库相对路径） |
| --- | --- |
| 事件/来源/运行类型与预算 | `src/cli/bot-runtime/automation/types.ts` |
| OpenClaw时间算法、严格时间验证 | `automation/schedule.ts` |
| 条件状态机与host采集器 | `automation/conditions.ts`、`automation/collectors.ts` |
| SQLite事件/运行/每个合并键回执 | `automation/store.ts`；主账本schema升级到4 |
| 宿主调度、恢复、去重、条件门控 | `automation/scheduler.ts` |
| 单个工具schema、参数校验、精简规则 | `automation/tool.ts` |
| 真实聊天与事件分开入站、验权、任务接单、停止、投递 | 既有`service.ts/router.ts/store.ts/types.ts` |
| 开源来源、修改记录及哈希 | `third_party/openclaw/` |

表中`automation/`均指`src/cli/bot-runtime/automation/`。规则增加201字符，序列化工具定义2198字符；这是字符数而非特定模型token数，没有调用在线模型计费接口估算。

专项测试7个文件共98项，覆盖时间/DST、条件状态/采集错误、源权限/附件、创建与合并幂等、重启、会话轮换、暂停/撤回即时中断、自主后续限制、实际Claude schema转换以及执行/投递分离。质量和规格评审的问题均已修复并加入回归测试。完整验证结果见同目录`2026-11-27-digital-person-automations-verification.md`。

明确边界：磁盘只监测宿主进程工作目录所在文件系统；GPU依赖nvidia-smi；暂无其他挂载盘/远程采集、任意脚本、webhook、stream和独立前端日历页。owner明确继续已停止/待核对任务时转回普通工单继续，不复活旧的已取消occurrence。发送失败独立保留同一outbox ID重试，不因执行预算到期丢弃；显式有效期仍限制后续发送。
