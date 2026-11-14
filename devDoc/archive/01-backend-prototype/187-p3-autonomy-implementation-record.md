# P3 自主安排、唤醒与额度实施记录

日期：2026-11-04。

状态：首轮实现与自验保留，修复及补正自验见[189](189-p3-independent-review-fix-record.md)。最终[188 第 7 节](188-p3-independent-review.md)独立复验通过，P3-R01～R06 均关闭；142 项回归及全部 11 个边界场景通过，P3 离线复核无已知阻断。尚未提交、未推送，不扩大为真实 P3 或正式交付完成。

## 1. 范围

按[186 P3 开发文档](186-p3-autonomy-development-guide.md)完成 P3-01～P3-06 的首轮实现：

- 业务库 v3：`autonomy_budget`、`autonomy_wakes`、`autonomy_activities` 及索引；
- 自主额度：默认 200、有限／无限制、本地日期重置、模型与工具扣点、耗尽暂停与次日恢复；
- 到时唤醒：持久安排、单一计时器、到期领取、自主任务／执行／活动与自主活动窗口；
- 工具：`autonomy_schedule`、`autonomy_share` 与自主系统提示；
- CLI／API：自主状态、额度、安排与活动；
- 离线自验：119 项回归和 14 项 P3 专项全部通过。

## 2. 存储与迁移

新增 [autonomy-store.ts](../../../backend/src/storage/autonomy-store.ts)：

- `getBudget`／`setBudget`／`consumePoint`：读取与扣点前按应用时区检查本地日期，跨日仅重置为当前日一份；
- `createWake`／`listWakes`／`nextPendingWake`／`listDueWakes`／`claimWake`／`completeWake`／`cancelWake`；
- `createActivity`／`updateActivity`／`listActivities`／`getLatestActivityByTask`；
- `beginDueWake`：在事务内检查角色无运行执行，领取最早到期安排，创建或恢复任务、`trigger_type='autonomous'` 执行和活动，并关联自主活动窗口；
- `findPendingBudgetResume`：避免同一暂停任务重复创建恢复安排。

业务库 v3 见 [schema.ts](../../../backend/src/storage/schema.ts)。除新增三表外，`execution_stream_events` 的事件类型检查增加 `execution_paused`；迁移时重建该表并保留历史事件，旧 v2 数据可升级到 v3。`ensureSchema` 按连续版本逐级执行迁移。

`beginDueWake` 的 `task_id` 只对 `budget_resume` 生效；`scheduled` 安排始终创建新的自主任务，避免把后续安排错误挂到已完成或无关任务上。

## 3. 额度与暂停恢复

以下保留首轮实现行为；内部工具一概免扣存在[188 P3-R01](188-p3-independent-review.md)所述缺口，尤其自主日记应按 DL-109 扣点，不能将这段实施记录解释为新增用户决定。

- 有限额度下，自主执行每发起一次模型调用或一次 MCP／Skill 工具调用扣 1 点；无限制时记录调用但 `counted=0`。
- 记忆检索、状态补丁和自主工具本身不扣自主额度，符合“按需记忆检索不扣”的既有边界。
- 用户消息、用户任务与后台记忆维护不使用自主额度。
- 模型调用在 `AgentGraphRunner.modelNode` 发起前扣点；MCP 工具在 `beginToolCall` 留下 pending 记录后、实际执行前扣点。额度耗尽时：
  - 不再发起新的自主模型或工具调用；
  - 执行置为 `paused` 并写 `execution_paused` 事件；
  - 任务与活动保持暂停；
  - 最后模型返回但尚未执行的 MCP 工具请求保留为 `pending`；
  - 为同一任务创建次日本地零点的 `budget_resume` 安排，已存在则复用。
- 次日唤醒后任务恢复 `active`，新执行与原任务 `continues`；系统提示要求先结合最新情况与已有结果重新评估，不自动重放旧操作。
- 无限制不触发暂停，只记录 `counted=0` 的调用。

相关实现：[autonomy-service.ts](../../../backend/src/application/autonomy-service.ts)、[agent-graph.ts](../../../backend/src/application/agent-graph.ts)、[conversation-service.ts](../../../backend/src/application/conversation-service.ts)。

## 4. 调度、唤醒与串行

- `ConversationService` 在既有调度器中增加到期自主安排，优先级为：未处理用户消息 → 任务续行 → 到期自主安排。
- 每个角色最多维护一个计时器，按最早待唤醒时间设置；安排新增或取消后重算，进程启动时恢复计时；没有待安排时不调用模型、不轮询。
- 自主执行使用每角色惰性创建的 `kind='custom'`、`source='nowadays-autonomy'` 窗口；最终文字提交为该窗口 assistant 消息。只有 `autonomy_share` 向主窗口追加主动消息。
- 用户消息可替代正在运行的自主执行（即使消息来自主窗口）；原自主任务按既有续行机制在用户回复完成后继续。
- 自主执行被替代或额度暂停时不重复执行已成功工具；工具调用记录与真实结果照常保存。

## 5. 工具与提示

- `autonomy_schedule`：所有对话可用；只接受未来时间，保存来源执行，返回 `wakeId` 与 `scheduledAt`。
- `autonomy_share`：只向自主执行提供；向主窗口写一条 assistant 消息并登记证据，返回 `messageId` 与 `windowId`，不结束活动。
- 自主系统提示说明：这是角色自己的安排而非用户新消息；可以使用已启用工具实际做事；可主动分享、继续安排或等待；不得虚构用户发言、离线经历或未发生的工具结果。
- `autonomy_share` 写入的消息通过 `appendProactiveMessage` 保存，并回填活动 `shared_message_id`。

## 6. CLI 与 HTTP

工程路由：

- `GET /v1/roles/:roleId/autonomy`
- `GET|PUT /v1/roles/:roleId/autonomy/budget`
- `GET|POST /v1/roles/:roleId/autonomy/wakes`
- `DELETE /v1/roles/:roleId/autonomy/wakes/:wakeId`
- `GET /v1/roles/:roleId/autonomy/activities`

CLI：

- `autonomy status --role <id>`
- `autonomy budget get|set --role <id> [--limit N] [--unlimited true|false]`
- `autonomy wake list|add|cancel`
- `autonomy activity list`

`PUT budget` 的 `dailyLimit` 可省略，省略时沿用当前值。其他角色不可读写同一安排、活动或额度；跨角色取消返回 `AUTONOMY_WAKE_NOT_FOUND`。

## 7. 自验证据

证据目录：[backend/test-results/p3-self-verification-20261104](../../../backend/test-results/p3-self-verification-20261104)。

- 类型检查：`tsc --noEmit` 退出码 0；
- 全量测试：119 项通过、0 失败；
- P3 专项：14 项通过、0 失败；
- 运行环境：Node v24.22.2。

P3 专项覆盖：

1. 额度默认 200、有限扣点、耗尽判定、跨本地日期重置与无限制；
2. 安排持久化、到期领取、任务来源 `/` 关系、活动完成与暂停任务续行；
3. 已领取或已完成安排不可取消；
4. 自主唤醒读取工作空间文件、写出 Markdown、活动完成、自主窗口与主窗口主动分享、消息证据与调用计量；
5. 额度耗尽时暂停执行／任务／活动，保留 pending 工具请求并创建次日恢复安排；
6. 次日恢复执行与原任务 `continues`，额度按新日期重置；
7. 无限制时调用记录 `counted=0` 且不暂停；
8. 自主执行中的 Skill 工具调用扣点并写入 `call_metering`；
9. 自主活动消息进入记忆证据与批次处理流程；
10. 关闭 Skill 后新的自主任务链不再提供该工具；
11. 用户对话可创建后续安排且不消耗自主点数，普通对话不提供主动分享工具；
12. 短时到期安排由计时器自动启动；
13. 用户消息优先替代自主执行，原自主任务随后继续并完成原安排；
14. HTTP 与 CLI 的额度、安排、取消、活动和状态读写。

全量测试包含独立 backend 中 P1／P2 既有 105 项回归，未出现失败；P0 小样测试位于独立目录，不在此计数内。

## 8. 已知限制

- 本轮只使用离线模型与本地 MCP，不包含真实付费模型、远程 MCP、浏览器或网页阅读。
- 进程被强杀时，已领取但未完成的安排与活动恢复属于 P4；P3 只保证待唤醒安排持久化和启动时计时器恢复。
- 单进程内同一角色的决策仍串行；多进程并发不在首轮范围。
- 本文与证据为历史实现方自验；独立复核见[188](188-p3-independent-review.md)，P3-R01～P3-R06 的修复自验见[189](189-p3-independent-review-fix-record.md)，尚待独立复验，P3 未通过；未提交、未推送。
