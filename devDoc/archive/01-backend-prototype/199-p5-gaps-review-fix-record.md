# 首轮后端功能缺口复核修复记录

日期：2026-11-06。依据：[198 独立复核](198-p5-capability-gaps-independent-review.md)的 R01～R06。基线为 `master` 的 `3761bbd` 加 197 所述工作树。[补齐计划](196-backend-capability-gap-plan.md) · [实现方自验](197-p5-capability-gaps-implementation-record.md)

**结论：R01～R06 已修复并完成实现方自验；198 第二轮指出的 R01 最新决定恢复缺口、第三轮指出的续行提交前中断缺口均已修复。** 类型检查、严格复核脚本类型检查、201 项正式测试和 `npm run accept:offline` 的 21 个步骤全部通过；198 的六个原始边界场景、两轮决策场景和强杀场景复跑均得到预期事实。修复仍未提交、未推送，无真实模型、真实 QQ 或付费调用，待独立复核确认后才能关闭 R01～R06。

## 1. 修复内容

| 编号 | 修复 | 复验事实 |
| --- | --- | --- |
| R01 任务决定与回复提交不一致 | 业务库 schema 升至 v6，`executions` 新增 `task_decision_json`。[commitConversation](../../../backend/src/storage/conversation-store.ts#L665) 在同一事务内保存暂停／完成／失败决定；[applyCommittedTaskDecision](../../../backend/src/application/conversation-service.ts#L1888) 提交后按决定落实，[启动收尾](../../../backend/src/application/conversation-service.ts#L600) 按任务选择最新已提交决定而不是无条件按「回复完成」结束 | 回复提交后向 `pauseTask` 注入写入错误：重启前执行 `completed`、任务 `active`；重启后任务 `paused`，结束原因保持「等下一次继续」，资源延续仍开放。带原 `taskId` 的唤醒接回同一任务链，用户来源任务不扣自主点数；先暂停再续行并提交失败终态时，重启落实最新失败决定 |
| R02 在途调用被提前补录 | [saveToolResult](../../../backend/src/storage/role-store.ts#L1385) 新增 `requireReconciledFromUnknown`，在事务内要求原调用仍为 `unknown`；`tool_reconcile` 固定传入。待派发、在途及已确认调用不能提前定案；同一结论重复提交仍幂等 | 对 `running` 调用补录返回 `TOOL_CALL_STATUS_CONFLICT`，原调用保持 `running` 且无结果；随后保存真实失败结果成功。对 `pending` 调用同样被拒 |
| R03 插话强杀已派发脚本 | [runSkillScriptProcess](../../../backend/src/application/agent-tools.ts#L1004) 不再监听执行中断信号，只由脚本自身超时终止；插话仅替代回复，脚本按实际退出结算到原调用 | 脚本写出首个文件后发送新消息：脚本继续执行到第二个文件写出，调用为 `success`。超时场景记为 `failed / SKILL_SCRIPT_TIMEOUT`，不伪造 `EXECUTION_SUPERSEDED` |
| R04 慢握手转后台无法派发 | [AgentGraphRunner](../../../backend/src/application/agent-graph.ts#L59) 增加派发检查回调与转后台通知；[checkDispatch](../../../backend/src/application/conversation-service.ts#L1379) 在工具转后台后改用新的存储句柄核对任务，任务已结束时保持未派发 | 100ms 前台窗口下，第二次 MCP 建连越过窗口并转后台；释放握手后实际派发一次、结果 `success`、`tool_backgrounded` 仅 1 次。握手期间结束任务时不产生派发，调用记录 `failed / TASK_ENDED` |
| R05 用户任务续行误扣自主点数 | [runExecution](../../../backend/src/application/conversation-service.ts#L1295) 按原任务 `origin` 决定计量归属：`user` 任务使用 `user_chat` 且不创建自主计量器，`autonomous` 任务继续受额度控制 | 带 `taskId` 的唤醒恢复 `origin=user` 暂停任务，自主点数保持 1（已用 1／上限 1）不增加，计量为 `user_chat / counted=0`，任务正常完成 |
| R06 完整整理请求超过容量 | [MemoryService](../../../backend/src/application/memory-service.ts#L112) 按序列化后的请求骨架、证据元数据和输出协议核算预算，发送前再校验完整请求；[memory-store](../../../backend/src/storage/memory-store.ts#L537) 按 JSON 转义后的条目长度选择片段，并把重试时遗留的超长片段继续拆小 | 声明容量 3,000、输出预留 500、固定开销 1,000 时，4,000 个反斜杠与 4,000 个引号均分批完成；每次 `JSON.stringify(input)` 加开销与预留不超过 3,000，证据进度为已处理。旧版按原始字符切出的 4,000 字符片段在重试时被拆分后完成 |

兼容处理：

- 未声明容量时保留原有 `budgetChars` 字符预算路径，`getNextSegments` 的序列化核算只在声明容量时启用，既有长证据分段行为不变。
- 业务库从 v5 迁移到 v6 只新增可空列；v1 数据库经既有链路迁移到 v6 的用例通过。
- 补录的结果保存不再是唯一写入路径：普通工具结算仍可把 `running` 调用保存为真实结果，恢复路径仍按 `unknown` 记录中断调用。

## 2. 复验证据

运行目录：`backend/test-results/p5-2026-11-06T08-11-01-358Z-ddefd742/`（Git 忽略）。使用项目独立 Node.js 24.22.2、`backend/node_modules`、离线模型与本地 stdio MCP，TEMP／TMP 独立。

| 检查 | 结果 |
| --- | --- |
| 工程类型检查 | 退出码 0 |
| 复核脚本严格类型检查 | 退出码 0 |
| 交付入口回归 | 2／2 |
| 正式后端测试 | 200／200，失败／取消／跳过均为 0；新增 8 项 R01～R06 回归 |
| 进程冒烟 | 1／1 |
| P2 矩阵 | 10＋5＋1＋4 全通过 |
| P3 矩阵 | 7＋2＋2 全通过 |
| P4 矩阵 | 8＋6＋14 全通过 |
| P5 矩阵（正式测试） | 慢工具 7、任务决策 6、补录 4、容量 4、Skill 5、日记 3，全部通过；对应复核脚本的 21 个场景仍全部通过 |
| 统一离线验收 | 21 个步骤全部通过，`summary.passed=true`，源码哈希一致 |

198 的补充边界脚本在 `backend/test-results/p5-gaps-fix-20261106/` 复跑，业务源码保持原样。R02 的场景副本改为记录「补录后仍无结果、晚到真实结果可保存」的新事实；198 原始脚本按旧结果读取会在 `getToolResult` 处失败，这本身也是修复后的预期差异。

| 场景 | 修复后结果 |
| --- | --- |
| `pauseRecovery` | `faults=1`、执行 `completed`、重启后任务 `paused / 等下一次继续` |
| `userWakeBudget` | `taskOrigin=user`、自主点数 0、计量 `user_chat / counted=0`、任务完成 |
| `serializedCapacity` | 每次请求含开销与预留不超过 3,000，状态 `completed`，证据已处理 |
| `reconcileRunning` | 补录未写入结果，原调用保持 `running`；晚到真实结果保存为 `failed` |
| `delayedHandshake` | 派发 1 次、结果 `success`、`backgroundEvents=1` |
| `skillInterruption` | 脚本实际执行完成，调用 `success`，首个副作用与最终文件均存在 |
| `latestDecision` | 第一轮暂停、第二轮失败终态提交后写入故障：重启前任务 `active`；重启后任务 `failed / 第二轮确认无法完成`，再次重启结果一致 |

新增正式回归：

- [p5-task-decisions](../../../backend/tests/p5-task-decisions.test.ts)：暂停写入故障后重启按原决定恢复、保留资源、原任务唤醒与用户任务不扣点；同一任务暂停续行后按最新未落实决定恢复失败终态，再次重启保持一致。
- [p5-reconcile](../../../backend/tests/p5-reconcile.test.ts)：待派发与在途调用不能被提前补录，晚到真实结果仍可保存。
- [p5-skill-run](../../../backend/tests/p5-skill-run.test.ts)：插话后脚本继续并归原调用；真实超时记录为 `SKILL_SCRIPT_TIMEOUT`。
- [p5-background-tools](../../../backend/tests/p5-background-tools.test.ts)：慢握手转后台后派发一次；任务已结束保持未派发。
- [p5-memory-capacity](../../../backend/tests/p5-memory-capacity.test.ts)：反斜杠、引号和历史超长分段的序列化容量核算。

## 3. 第二轮复核补充：R01 最新决定

198 第二轮复验（第 26～49 行）发现：同一任务先暂停、再用原任务编号续行并提交 `task_finish(failed)`，若该轮 `finishTask` 写入失败，重启时恢复查询按最早执行排序并只处理同任务第一条记录，旧暂停决定重新满足条件并遮蔽第二轮失败终态。

修复：[reconcileCommittedGaps](../../../backend/src/application/conversation-service.ts#L600) 改为按任务收集全部已完成执行的决定，选择创建顺序中最后一条应用；旧暂停在任务续行后不再覆盖新决定。资源收尾、额度唤醒取消与经历整理仍按最终决定执行。

复验：复核脚本 `latest-decision.ts` 复跑，重启前任务 `active`，重启后为 `failed / 第二轮确认无法完成`。新增正式回归再次重启确认结果一致；终态恢复后资源延续已释放，执行任务关系保持 `initiates` + `continues` 且始终指向同一任务编号。

## 4. 第三轮复核补充：续行提交前中断

198 第三次复验（第 51～65 行）发现：自主任务第一轮已落实暂停，用原任务编号定时唤醒后，第二轮在提交回复或任务决定前被 `SIGKILL`。重启先把该执行记为 `failed`，随后恢复收尾仍从已完成执行中选中第一轮已落实的暂停，把任务重新置为 `paused / 第一轮暂缓`；排队的续行因任务已暂停无法开始，恢复模型调用为 0。

修复：[listCommittedExecutionGaps](../../../backend/src/storage/conversation-store.ts#L1508) 在原有「同任务无运行／暂停执行」条件外，增加「同任务不存在更晚的 `initiates`／`continues` 执行」条件。已落实的历史决定即使在后续执行中断时也不会重新成为恢复候选；提交后状态写入失败的场景仍由最新一条已完成执行的决定恢复。按任务选择最后一条未落实决定的逻辑保持不变。

复验：

- 复核脚本 `interrupted-continuation.ts` 复制到 `backend/test-results/p5-gaps-fix-20261106/` 复跑（原脚本目录保留原结果）。强杀前任务 `active`、两次执行为 `completed` + `running`；重启瞬间任务保持 `active`、中断执行记为 `failed` 并接手一次新的续行；完成后任务 `completed / 回复完成`，`recoveredModelCalls=1`。
- `latest-decision.ts` 复跑仍得到 `failed / 第二轮确认无法完成`；`edge-review.ts` 与 `dispatch-review.ts` 的 R02～R06 结果与上轮一致。
- 新增正式回归 [p5-task-decisions](../../../backend/tests/p5-task-decisions.test.ts)：第一轮暂停落实后，用 `beginDueWake` 建立「任务已回到 active、续行执行 running 且无检查点」的强杀前状态；重启不重放旧暂停，按原任务继续一次模型调用并完成，执行状态为 `completed / failed / completed`、全部指向同一任务编号；再次重启保持完成态且不新增模型调用。

本轮运行目录：`backend/test-results/p5-2026-11-06T08-25-39-625Z-318fd43d/`。类型检查与严格复核脚本类型检查通过，正式测试 201／201（新增第三轮 R01 回归 1 项），交付回归 2／2，进程冒烟 1／1，P2～P5 场景矩阵与统一离线验收 21 个步骤全部通过；`sourceUnchanged=true`，`realServiceCalls=0`。R01 第三轮补修仍待独立复核，R02～R06 保持离线通过结论。

## 5. 未覆盖与边界

- 本记录是实现方自验，不替代独立复核；R01～R06 仍需复核方按 198 的条件确认。
- GAP-01、GAP-02、GAP-03、GAP-04、GAP-05 仍保持待复验状态；GAP-06 在 198 已通过的日记读取范围不受本次修改影响。
- 只覆盖离线模型、本地 stdio MCP 与本地子进程；真实模型、远程 Streamable HTTP MCP、真实 Skill 依赖、浏览器与桌面交付未验证。
- 服务进程被强制终止时，已派发脚本或 MCP 调用仍可能无法确认结果；这类事实按既有启动恢复记 `unknown`，需核查后补录。
- UI-PREP-01、管理与体验候选及 OPS 项未实施；未提交、未推送。
