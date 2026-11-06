# 首轮后端功能缺口独立复核

2026-11-06。复核对象为 `master` 的 `3761bbd` 加 197 所述工作树。核对 GAP-01 至 GAP-06 的实现和原有运行约定。**结论为复核未通过。统一离线验收通过，新增的六个边界场景均复现问题。** [补齐计划](196-backend-capability-gap-plan.md) · [实现方自验](197-p5-capability-gaps-implementation-record.md)

## 验收结果

在 Windows x64、Node.js 24.22.2 和独立 backend 依赖上重跑 `npm run accept:offline`。21 个步骤均通过，包含 192 项正式测试、2 项交付回归、1 项进程冒烟、59 个既有 P2 至 P4 场景和 21 个新增专项场景。运行期间源码清单一致。GAP-06 日记分段、跨角色隔离、缺文件和搜索后读取均在已跑范围通过。

统一验收目录为 `backend/test-results/p5-2026-11-06T06-50-36-363Z-8e0db07d/`。补充复验使用 `backend/test-results/p5-gaps-independent-20261106/` 下的 `edge-review.ts` 与 `dispatch-review.ts`，结果分别为 `edge-review.json` 与 `dispatch-review.json`。脚本采用离线模型、本地 MCP 和隔离 SQLite，复核期间被验业务源码保持原样。

## 需要修复的项目

| 编号 | 复现结果 | 补齐与复验条件 |
| --- | --- | --- |
| R01 · P1 · 任务暂停恢复 | 在回复提交后向 `pauseTask` 注入一次写入错误。重启前执行为 `completed`、任务为 `active`，重启后任务被按「回复完成」结束，原暂停决定丢失。显式完成或失败决定同样经过这个收尾边界。[提交与暂停](../backend/src/application/conversation-service.ts#L1540) · [启动收尾](../backend/src/application/conversation-service.ts#L598) | 让任务决定与回复提交在恢复时保持一致。故障后重启按原决定落实暂停或指定终态，暂停保留资源续行，并验证唤醒与原任务身份。 |
| R02 · P1 · 在途结果被提前改写 | 对仍为 `running` 且尚无结果的调用，角色只提供一段 `observation` 就能用 `tool_reconcile` 写成 `success`。此时 `previousStatus=null`，随后保存实际失败返回 `TOOL_RESULT_CONFLICT`。[补录工具](../backend/src/application/agent-tools.ts#L1393) · [结果保存](../backend/src/storage/role-store.ts#L1383) | 补录入口以原调用的未知状态为前提，在保存事务内核对。验证待派发、在途及已确认状态的调用不能被提前定案，未知结果的核查与晚到真实结果仍可正确保存。 |
| R03 · P1 · 插话中断已派发脚本 | Skill 脚本写出第一个文件后，发送同窗口新消息。脚本子进程被强杀，后续文件没有写出，调用却登记为 `failed / EXECUTION_SUPERSEDED`，实际副作用已经发生。[脚本中断](../backend/src/application/agent-tools.ts#L1050) | 将回复替代与已派发脚本生命周期分开。插话后让原脚本继续，结果仍归原调用。验证脚本的实际退出、超时及无法确认结果的场景各自记录真实状态。 |
| R04 · P2 · 慢握手转后台后无法派发 | 工具目录发现正常，实际调用的第二次 MCP 建连越过前台窗口。释放握手后，派发检查引用已经关闭的数据库连接，保存 `MCP_TOOL_OUTCOME_UNKNOWN` 和 `The database connection is not open`。服务端从未收到工具调用。[派发检查](../backend/src/application/agent-graph.ts#L611) · [转后台路径](../backend/src/application/agent-graph.ts#L909) | 覆盖握手期间和已派发后的后台切换。仍可派发的任务使用有效存储上下文，已经结束的任务保持未派发事实。验证慢握手后实际调用一次并保存结果。 |
| R05 · P2 · 用户任务定时续行误扣点 | 用带 `taskId` 的唤醒恢复暂停的 `origin=user` 任务。任务顺利完成，但模型计量是 `autonomous / counted=1`，自主点数增加 1。[到期执行](../backend/src/application/conversation-service.ts#L997) · [计量归属](../backend/src/application/conversation-service.ts#L1277) | 按 DL-110 用原任务来源确定续行计量。测试用户任务在自主余额为零时仍可按原来源继续，自主任务继续受额度控制。 |
| R06 · P2 · 完整整理请求超过容量 | 在声明容量 3,000 字符、固定开销 1,000 和输出预留 500 的场景，证据由反斜杠组成。按实际 JSON 长度计算，前三批连同开销和预留各为 4,703，仍送入模型并被标为完成。[批次组装](../backend/src/application/memory-service.ts#L277) · [片段选取](../backend/src/storage/memory-store.ts#L565) | 用序列化后的完整请求验证容量，计入转义与证据元数据。覆盖普通文本、反斜杠、引号以及重试时的旧分段，成功处理后再推进证据进度。 |

## 复验顺序

先处理 R01、R02 和 R03，分别复验恢复后的任务事实、未知调用补录和插话后的真实副作用。随后补 R04 至 R06，并将六项边界用例和现有离线验收一起复跑。GAP-01 至 GAP-05 保持待复验状态，GAP-06 保留本轮通过范围。

## 199 修复后的独立复验

2026-11-06。以 `master` 的 `3761bbd` 加 [199 修复工作树](199-p5-gaps-review-fix-record.md) 为复核对象。**R02～R06 在本轮离线范围通过，R01 仍有一项 P1 恢复缺口，整体复核未通过。** GAP-02 保持开放，GAP-06 保留通过范围。

重新运行 `npm run accept:offline`，21 步全部通过。覆盖 199 项正式测试、2 项交付回归、1 项进程冒烟、59 个既有业务场景及 21 个新增专项场景。运行前后源码清单一致，真实服务调用为 0。完整结果见 `backend/test-results/p5-2026-11-06T07-58-13-424Z-2882ceb0/summary.json`。

| 项目 | 定向复验结果 |
| --- | --- |
| R01 | 单次暂停写入失败后，重启正确恢复暂停状态及原因。同一任务两轮决策的恢复仍有缺口，见下文。 |
| R02 | 在途调用无法补录为成功，真实失败晚到后可以正常保存。 |
| R03 | 已启动的脚本在用户插话后继续执行，两个文件均写出，原调用保存为成功。实际超时路径也通过回归。 |
| R04 | 慢握手越过前台窗口后，MCP 工具实际派发并保存成功。 |
| R05 | 用户来源的暂停任务在自主余额为零时仍可定时续行，计量为 `user_chat / counted=0`。 |
| R06 | 3,000 字符容量下，带大量反斜杠的证据成功处理。实测 13 次模型请求计入固定开销及输出预留后，最大为 2,999 字符。 |

### R01 · P1 · 旧暂停决定覆盖续行后已提交的终态

第一轮对同一任务提交并应用 `task_pause`，原因是「第一轮暂缓」。随后用原任务 ID 唤醒，第二轮回复与 `task_finish(status=failed)` 均已提交。向该轮的 `finishTask` 注入一次写入失败。重启前任务为 `active`，两条执行记录均为 `completed`，各自保存了任务决定。重启后任务变成 `paused`，原因恢复为「第一轮暂缓」。预期应落实第二轮的 `failed` 及失败原因。

恢复查询按最早执行排序，收尾逻辑只处理同一任务的第一条记录。旧暂停已经执行过，但任务续行变回 `active` 后，这条旧记录重新满足恢复条件并遮蔽了第二轮决定。[恢复查询](../backend/src/storage/conversation-store.ts#L1508) · [按任务去重](../backend/src/application/conversation-service.ts#L607)

复验需要覆盖同一任务先暂停再续行、回复已提交而状态写入失败的场景。恢复后应应用本轮有效且尚未落实的决定，保持原任务身份与资源收尾语义，并在再次重启时保持结果一致。

定向脚本和 JSON 结果位于 `backend/test-results/p5-gaps-recheck-20261106/`。上轮场景重跑结果见 `edge-review.json`、`dispatch-review.json`，新增两轮决策复现见 `latest-decision.ts`、`latest-decision.json`。独立复验期间业务代码保持原样。

## R01 第二次补修的独立复验

2026-11-06。独立重跑 `npm run accept:offline`，21 步全部通过，含 200 项正式测试、2 项交付回归、1 项进程冒烟、59 个既有业务场景及 21 个补齐专项。源码清单一致，真实服务调用为 0。运行结果见 `backend/test-results/p5-2026-11-06T08-14-51-361Z-38ac9cd4/summary.json`。

上轮「第二轮失败决定已提交、任务状态写入失败」场景通过。独立重跑得到 `failed / 第二轮确认无法完成`，正式回归也通过了再次重启和原任务身份检查。**R01 仍有 P1 缺口，整体复核未通过。** R02～R06 保留离线通过结论。

### R01 · P1 · 续行提交前强杀，旧暂停阻断原任务恢复

先让自主任务提交并落实第一轮暂停，再用同一任务 ID 定时唤醒。等第二轮离线模型进入调用、尚未输出回复或决定时，对测试子进程发送 `SIGKILL`。强杀前任务为 `active`，两次执行分别为 `completed` 和 `running`。重启将第二次执行记为 `failed`，但同时把任务改回 `paused / 第一轮暂缓`，恢复模型调用为 0。

启动先将不可从检查点续跑的执行标为中断，随后查询只在已完成执行里查找任务决定。此时仍能选中第一轮已经落实的暂停，排队的中断续行随后因任务已暂停而无法开始。[启动恢复顺序](../backend/src/application/conversation-service.ts#L466) · [收尾候选](../backend/src/storage/conversation-store.ts#L1508) · [原任务续行](../backend/src/storage/conversation-store.ts#L325)

修复后的复验需同时覆盖提交前强杀和提交后状态写入失败。前者应保留中断执行事实，并按原任务的恢复规则继续；后者应落实当前已提交决定。两者都需要排除已经落实的历史决定，保持原任务 ID 及重启幂等性。

复现脚本与结果位于 `backend/test-results/p5-gaps-recheck-round3-20261106/`，分别为 `interrupted-continuation.ts`、`interrupted-continuation.json` 及 `latest-decision.json`。本轮业务代码保持原样。

## R01 第三次补修的独立复验

2026-11-06。**复核通过。R01～R06 在本机离线范围关闭，GAP-01～GAP-06 在首轮后端补齐范围通过。**

相较上轮，后端验收清单只有恢复查询及任务决策测试两处变更。查询现在排除同任务已出现更晚主执行的历史记录，即使后续执行启动后中断并标为 `failed`，也会排除已落实的旧暂停。定时唤醒恢复任务状态和建立后续执行关联在同一事务内完成。

| 定向复验 | 结果 |
| --- | --- |
| 续行提交前强杀 | 原任务在启动恢复时仍为 `active`，中断执行保留为 `failed`。恢复模型调用 1 次，执行关联仍指向同一任务，原任务最终为 `completed / 回复完成`。 |
| 续行提交后状态写入失败 | 注入一次写入故障后重启，正确落实第二轮 `failed / 第二轮确认无法完成`。 |
| 再次重启 | 两条正式回归均通过，保留原任务终态和任务编号，已完成任务没有新增模型调用。 |

独立重跑 `npm run accept:offline` 的 21 步全部通过，含 201 项正式测试、2 项交付回归、1 项进程冒烟、59 个既有业务场景和 21 个补齐专项。124 个验收清单文件的哈希一致，真实服务调用为 0。统一运行结果见 `backend/test-results/p5-2026-11-06T08-30-52-760Z-bc078e2d/summary.json`，定向复跑证据见 `backend/test-results/p5-gaps-recheck-round4-20261106/`。本轮复核覆盖离线模型、本地 SQLite、stdio MCP 与本地子进程。后续排期见 DL-115，桌面前端完成后再实施远程 Streamable HTTP MCP。
