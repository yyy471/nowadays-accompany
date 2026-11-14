# P4 恢复缺口修复与自验记录

日期：2026-11-04。依据：[190 P4 首轮验收](190-p4-recovery-acceptance-report.md)第 4 节、第 9 节；DL-30、DL-53、DL-65～DL-67、DL-70～DL-73、DL-105～DL-108、DL-113。

最新状态（2026-11-05）：第 10 节保留最后补修自验，第 11 节保留用户接受当前证据的 P4 收口；后续[195 P5 整体独立复核](195-p5-independent-review.md)已复验内部意图、跨日及计量故障和二次启动，全部通过。P5 首轮本机源码原型范围收口，原自验性质不变，未提交、未推送。

## 1. P4-R01：运行中自主任务重启后重新进入调度

原问题：重启只把运行中执行记为 `failed / PROCESS_INTERRUPTED`，没有协调原任务、活动和已领取安排；原任务保持 `active`，但没有待领取唤醒或任务延续进入调度，显式触发调度也无法继续。

修复：

- [ConversationStore.recoverInterruptedExecutions](../../../backend/src/storage/conversation-store.ts#L1058)在把执行标记为中断失败时，同时返回该执行关联任务的身份、状态和来源，供启动恢复使用。
- [ConversationService.recoverOnStartup](../../../backend/src/application/conversation-service.ts#L383)为**任务仍为 `active` 且来源为 `autonomous`** 的中断执行恢复任务延续；已结束任务不复活，也不新建替代任务。被新消息替代的执行按第 6 节处理：只有原任务仍有工具进展时才继续，仅被替代的回复本身不续写。
- 延续通过既有 `startTaskContinuation` 进入 `pendingContinuations` 和现有调度入口，沿用原 `taskId`、任务窗口和检查点记录；启动时若成功排队则主动触发一次调度，未成功时仍保留待调度记录。
- 延续执行重新读取最新角色设定、状态、当前资源授权和额度；已有工具结果由既有 `buildContinuationToolMessages` 作为工具消息提供给模型，不重复派发已保存的成功调用。
- 活动与已领取唤醒沿用原记录，由延续执行正式完成或失败，不把 `claimed` 简单改回 `pending`。

自验覆盖：原任务与延续执行任务身份一致；原执行保留 `failed / PROCESS_INTERRUPTED`；工具调用行数不增加；成功结果仍可读取；模型请求包含最新设定与状态；最终活动、唤醒为 `completed`，额度只计一次延续模型调用；已结束任务重启后不产生模型调用或替代执行。

## 2. P4-R02：未返回工具调用归入 unknown

原问题：进程终止后，已经进入调用流程但未返回协议结果的工具调用仍为 `running`，没有 `tool_results` 记录；账面状态与实际进程不一致，也可能诱导后续盲目重试。

修复：

- 新增 [RoleStore.recoverInterruptedToolCalls](../../../backend/src/storage/role-store.ts#L1162)，处理进程退出后尚无结果的 `pending`／`running` 调用；第 6 节已把入口扩展为启动时扫描全部符合条件的历史调用，不再只依赖本次中断执行列表。
- `pending`（尚未派发）记录为 `failed`，诊断码 `PROCESS_INTERRUPTED`，结果正文明确「进程中断时该调用尚未派发」。
- `running`（已进入调用流程但无明确结果）记录为 `unknown`，同样保存 `PROCESS_INTERRUPTED` 事实，不伪造成功或失败；保留原 `toolCallId`、任务和执行关联。
- 结果通过既有 `saveToolResult` 保存，继续沿用原始结果、结果修订与 `previous_status`／`reconciled_at` 机制；单个调用恢复异常不阻塞其他调用。
- 恢复后的任务延续会把 `unknown`／`failed` 工具消息交给角色，由角色自行核查；不可核实时保持 `unknown`，本轮没有自动重发或重复扣点。

自验覆盖：在途调用保持原身份变为 `unknown`，未派发调用变为 `failed`，两者结果行均保留 `PROCESS_INTERRUPTED`；重启后未知结果仍只保存一次、不新增工具调用；续行模型请求能看到 `unknown` 事实；随后以明确结果修订同一调用时写入 `previousStatus=unknown` 和 `reconciledAt`。

## 3. 改动位置

| 文件 | 内容 |
| --- | --- |
| [backend/src/application/conversation-service.ts](../../../backend/src/application/conversation-service.ts#L383) | 启动恢复协调中断执行、未返回工具调用、自主任务及 superseded 任务延续调度 |
| [backend/src/storage/conversation-store.ts](../../../backend/src/storage/conversation-store.ts#L103) | 中断执行返回关联任务摘要；第 6 节增加活跃 superseded 任务的延续查询 |
| [backend/src/storage/role-store.ts](../../../backend/src/storage/role-store.ts#L1162) | 未派发／在途工具调用的恢复结果；结果保存支持注入恢复时刻 |
| [backend/tests/p4-recovery.test.ts](../../../backend/tests/p4-recovery.test.ts#L273) | 8 项 P4 恢复正式回归（含 superseded、ended、预算暂停保护） |

## 4. 自验证据

本节是第 1～5 节的首轮自验证据；190 第 7 节补齐后的最终自验见 6.3。

运行目录：`backend/test-results/p4-fix-final2-20261104-201639/`（Git 忽略）。使用项目独立 Node.js 24.22.2、`backend/node_modules`、离线模型和本地 SQLite／stdio MCP，TEMP／TMP 独立。

| 检查 | 结果 |
| --- | --- |
| 类型检查 | 退出码 0；`typecheck.log` |
| 全量回归 | 145／145，0 失败、0 取消；含新增 3 项 P4 回归；`tests.log` |
| P4 验收脚本 | 8／8 通过，0 执行异常；`p4/p4-report.json`、`p4-acceptance.log` |
| A03 观察 | 原任务与延续同一 `taskId`；原执行 `failed / PROCESS_INTERRUPTED`，延续执行 `completed / tool_result`；成功工具结果保留；效果文件只有一次内容；恢复模型调用 1 次 |
| A04 观察 | 原调用保持同一 `toolCallId` 为 `unknown`，结果诊断 `PROCESS_INTERRUPTED`；效果文件存在一次 `effect`；恢复模型调用 1 次；任务 `completed` |
| P3 原 7 场景 | 7／7 通过；`p3-20261104-p3-review/p3-review-report.json` |
| P3 第 5 节扩展 | 2／2 通过；`p3-20261104-p3-fix-recheck/p3-extended-report.json` |
| P3 预留边界 | 2／2 通过；`p3-20261104-p3-reservation-boundary-review/reservation-boundary-report.json` |
| 业务副作用 | 仅测试隔离目录；本轮没有真实 QQ、真实模型、用户数据或付费调用 |

190 的 A01、A02、A05～A08 在本轮复跑中仍通过；此前 P2 的 184 第 7 节和 P3 的 188 第 7 节通过范围保持，但不代表 P4 强杀组合已全部覆盖。

## 5. 未覆盖与复验边界

- **本记录是实现方自验，不是独立复核；P4 仍未通过，不能进入 P5 收口。** 需要独立复验 A03／A04 的任务身份、原执行进度、成功结果复用、效果次数和未知结果保留。
- 派发前、最终提交附近的额外强杀位置，完整跨进程并发、数据库异常组合、真实模型恢复、远程 MCP 与桌面交付仍未验证。
- 无法核实的未知结果会继续保持 `unknown`；本轮不提供通用核查工具，也不自动重发。真实效果是否发生仍需角色通过可用资料判断。
- 第 6 节已把恢复范围扩展到有工具进展的 superseded 任务；仅被替代回复且没有工具进展的任务仍不继续，暂停等待额度恢复的任务按原有路径处理。
- 未提交、未推送。独立复验通过前不更新 P4 通过结论。

## 6. 190 第 7 节 superseded 组合修复（2026-11-04）

[190 第 7 节](190-p4-recovery-acceptance-report.md)在原 A03／A04 通过后新增四项组合，其中 `autonomous-superseded`、`user-superseded` 失败：新消息已替代旧回复并完成新回复后强杀，原任务仍为 `active`、旧执行为 `superseded`、工具调用仍为 `running`；重启没有恢复原任务，也没有把在途调用归入 `unknown`。本节补齐这两处。

### 6.1 P4-R01 遗留：被替代执行的原任务恢复

- 新增 [ConversationStore.listSupersededTaskContinuations](../../../backend/src/storage/conversation-store.ts#L1112)：找出仍为 `active` 且有 `superseded` 执行的任务；自主任务按原任务链继续，用户任务只在已有工具进展时继续，避免重放纯文本旧回复。
- [ConversationService.recoverOnStartup](../../../backend/src/application/conversation-service.ts#L383)把这些任务与中断的自主任务一起排入原有 `pendingContinuations`，沿用原 `taskId` 和任务窗口，不新建替代任务。
- 没有工具进展、只有被替代回复的 `A08` 用例不进入延续；明确结束的 `ended` 任务不复活。新消息仍由现有调度优先处理，预算／资源延续规则不变。
- 继续的是原任务，不是旧回复：用户任务只在存在未处理工具事实时继续并形成自己的新回复；自主任务仍在原自主窗口完成，不把中断的旧答案补写为已提交内容。

### 6.2 P4-R02 遗留：未返回调用独立归 unknown

- [RoleStore.recoverInterruptedToolCalls](../../../backend/src/storage/role-store.ts#L1162)改为在启动时扫描该角色所有尚无结果、所属执行已不是 `running` 且不是预算暂停的 `pending`／`running` 调用，不再依赖本次中断执行列表，因此 `superseded` 旧执行和已结束任务上的在途调用也会处理；预算暂停任务等待恢复时的未派发调用保持原状。
- `pending` 仍记为 `failed`，`running` 记为 `unknown` 并保存 `PROCESS_INTERRUPTED`；保留原调用身份和既有结果修订记录。已结束任务只保存未知事实，不派生延续；未结束任务在后续模型评估中收到该事实。

### 6.3 定向自验

运行目录：`backend/test-results/p4-section7-fix-final3-20261104-204246/`（Git 忽略），使用同一独立 Node 24.22.2、离线模型和本地 stdio MCP。

| 检查 | 结果 |
| --- | --- |
| 类型检查 | 退出码 0；`typecheck.log` |
| 全量回归 | 150／150，0 失败、0 取消；含 8 项 P4 恢复回归；`tests.log` |
| 原 P4 八项 | 8／8；A08 仍为 0 次恢复模型调用，未续写旧回复；`p4/p4-report.json` |
| 190 第 7 节四项 | 4／4：`autonomous-superseded`、`user-superseded`、`ended`、`check-unknown`；`extended/p4-recovery-recheck-report.json` |
| superseded 观察 | 两例原 `taskId` 均完成；在途调用同一身份变为 `unknown / PROCESS_INTERRUPTED`；效果文件仅一次；恢复模型调用大于 0 |
| ended 观察 | 调用为 `unknown`、效果一次，原任务仍 `completed`，恢复模型调用 0 |
| check-unknown 观察 | 两次模型调用，核查工具成功一次，原效果一次，原 unknown 事实保留 |
| 预算暂停保护 | 重启后预算暂停任务的未派发调用仍为 `pending`，不写 `unknown`／`failed`，任务保持 `paused` |
| P3 回归 | 原 7 项、扩展 2 项、预留边界 2 项全部通过；`p3-*/*.json` |
| 业务副作用 | 仅隔离测试目录；没有真实 QQ、真实模型、用户数据或付费调用 |

本记录仍是实现方自验；190 第 7 节的独立结论保留为历史，P4 是否收口由新的独立复验决定。派发前／提交附近强杀、完整跨进程并发、数据库异常、真实模型恢复、远程 MCP 和桌面交付仍未验证。未提交、未推送。

## 7. 复核中补修用户直接重启及原链资源延续

日期：2026-11-04。用户要求“复核修改”，复核方在确认第 6 节四个原场景通过后，补验并直接修正两项用户链问题；本节记录这些直接修改的自验，独立发现和前后证据见 [190 第 8 节](190-p4-recovery-acceptance-report.md)。

- R01 遗留：普通用户任务没有被新消息替代就退出时，工具归档虽正确，回复没有接回原任务。本轮在领取待回复消息前找回其中断的有效任务，在同一事务内关联原 taskId 为 continues，再传入原工具事实；启动自动调度，正式提交原输入一次。
- 新增 R03：用户原任务未持久保存资源延续，关闭资源并重启后失去原模型／MCP。本轮在创建用户任务时保存原链资源，用户与自主任务统一读取既有延续仓储；原链完成释放，新任务仍受开关限制。
- 新增 `tests/p4-user-recovery.test.ts` 两项正式回归：用户输入及任务只处理一次、原任务已结束时只保存 unknown 而不复活。复核脚本增加真实强杀的 `user-running` 和 `user-superseded-disabled`；后者实际核查一次并验证新任务不可使用关闭资源。

自验目录：`backend/test-results/p4-review-fix-20261104-204505/`。补修前原 150 项及四个组合通过，新增两组合失败；补修后工程及复核脚本类型检查、152 项正式测试、8 个 P4、6 个强杀组合及 11 个 P3 场景全部通过，无样例异常。快照及汇总见该目录 `verification-summary.json`，具体报告索引见 190 第 8.3 节。

业务改动限于 conversation-service、conversation-store，无依赖或 schema 迁移修改，不增加授权、开关或模型调用类型；仅测试隔离数据，真实服务及付费调用 0。原 taskId 保持及新判断恢复不冒充原执行检查点恢复。R01／R03 补修自验通过，仍需后续独立复验；P4 未完整收口，未提交、未推送。

## 8. 190 第 9 节 R04～R06 修复与自验（2026-11-05）

日期：2026-11-05。依据：[190 第 9 节](190-p4-recovery-acceptance-report.md)及 9.4～9.6；DL-65～DL-67、DL-71、DL-72、DL-105～DL-108、DL-113。三项均为实现方自验，**不是独立复核；P4 仍未收口，不进入 P5**。

### 8.1 P4-R04：原执行检查点恢复

- [ConversationService.resumableTask](../../../backend/src/application/conversation-service.ts#L520)只在以下条件同时成立时恢复原执行：执行仍为 `running`；原 `stateVersionLoaded` 等于当前角色状态版本；关联任务仍为 `active`；同窗口没有新待处理用户消息；该 thread 的最新检查点已越过首轮模型（`metadata.step >= 1`）。`superseded`、`paused`、已结束任务以及仅有输入／未完成首轮模型的检查点继续走既有失败或任务延续路径，不复活旧回复。
- [执行恢复入口](../../../backend/src/application/conversation-service.ts#L619)沿用原 `executionId`／thread_id：先把该执行仍为 `running` 的模型调用标记中断，再用原检查点重新进入图，不新建执行。已保存的成功工具结果由 `beginToolCall` 的 `stepKey` 去重和既有结果读取复用，不重复派发效果；调用未派发／在途的结果按第 2 节规则先结算。
- [AgentGraphRunner.run](../../../backend/src/application/agent-graph.ts#L150)新增 `resume`：为 true 时以 `graph.invoke(null, thread_id)` 从检查点继续。已形成最终结果但尚未提交的检查点在恢复时不再调用模型，直接提交检查点中的文字和 `statePatch`；仍有待执行工具回合的检查点只执行缺失步骤。
- 恢复后的新模型回合重新读取当前设定、状态、资源授权、额度与自动召回；若角色状态版本已变化或出现新消息，检查点材料失效，不盲目提交旧结果，按既有规则失败并由任务延续重新判断。
- 恢复模式且无服务端续传材料时，工具节点把模型调用编号改写为业务 `toolCallId`，使后续请求与业务记录一致；存在提供方 `continuation` 时保留原始编号，避免破坏签名／续传块。该归一只作用于恢复执行，普通在线执行继续使用模型原始调用编号。

### 8.2 P4-R05：已提交答复后的任务、活动、唤醒与资源收尾

- 新增 [ConversationStore.listCommittedExecutionGaps](../../../backend/src/storage/conversation-store.ts#L1287)：只返回已 `completed`、已有提交状态版本、也已有完成答复，且通过 `initiates`／`continues` 关联到仍为 `active` 任务、同任务没有其他 `running`／`paused` 执行的间隙；仅被引用的任务不会被结束。
- [启动收尾协调](../../../backend/src/application/conversation-service.ts#L581)按间隙幂等结束原任务（`回复完成`）、取消待执行的额度恢复，再清理资源延续。资源清理只处理任务结束时间晚于授权时间的延续，避免把任务结束后手工新增的延续误删。
- 新增 [AutonomyStore.reconcileTerminalActivities](../../../backend/src/storage/autonomy-store.ts#L470)：把已 `completed`／`failed` 执行上仍为 `running` 的活动收敛为对应终态，完成其仍为 `claimed` 的唤醒；预算暂停执行保持原状。重复启动不重复生成答复、不重复扣点，任务、活动、唤醒和资源最终一致。

### 8.3 P4-R06：未派发工具预留的持久结算

- 业务库升级到 v4，新增 [autonomy_tool_reservations](../../../backend/src/storage/schema.ts#L911)：以 `tool_call_id` 为主键保存 `local_date`、`counted` 和 `reserved／committed／released` 状态；旧库按既有逐级迁移路径升级，未增加用户配置或审批。
- [AutonomyStore.reserveToolPoint](../../../backend/src/storage/autonomy-store.ts#L212)在工具登记后持久预留；[commitToolReservation](../../../backend/src/storage/autonomy-store.ts#L275)在工具实际派发前使用原日期／模式结算；[releaseToolReservation](../../../backend/src/storage/autonomy-store.ts#L336)在已知未派发时退还。运行中的取消闭包与原调用关联，不再只依赖进程内状态。
- [启动结算](../../../backend/src/storage/autonomy-store.ts#L367)：预算暂停执行保持不动；仍为 `reserved` 且没有成功／未知结果的调用按未确认派发退还；已有成功／未知结果但预留未提交的调用按已派发处理。已提交但缺少计量账本的调用补记 `call_metering`，不重复插入。
- 保持原有口径：同日实际派发不重复扣点；跨日派发在新日期消耗新点；旧日退还不能变成新日额外余额；无限制模式预留不计点；取消只影响该调用自己的预留。

### 8.4 正式回归与验证证据

新增 [p4-checkpoint-recovery.test.ts](../../../backend/tests/p4-checkpoint-recovery.test.ts) 五项正式回归：已完成检查点重启后零模型调用提交原文与状态；状态版本变化时不提交旧检查点并按最新状态重新判断；已提交答复的收尾间隙重启后收敛且重复重启幂等；未派发预留重启后退还且余额等于计量账本；跨日释放不把旧日预留退成新日余额。`p2-02` 迁移测试同步校验 v4 预留表；业务库版本断言更新为 4。

运行目录：`backend/test-results/p4-remaining-final2-20261105/`、`p4-recheck-final2-20261105/`、`p4-original-final-20261105/`、`p3-review-final-20261105/`、`p3-fix-final-20261105/`、`p3-reservation-final-20261105/`（Git 忽略）。使用项目独立 Node.js 24.22.2、后端锁定依赖、离线模型和本地 stdio MCP，TEMP／TMP 独立。

| 检查 | 结果 |
| --- | --- |
| 类型检查 | 工程严格检查退出码 0 |
| 全量回归 | 157／157，失败／取消／跳过均为 0 |
| 原 P4 八项 | 8／8；A01～A08 全部通过 |
| 190 第 7 节六项强杀 | 6／6，含 `check-unknown`、`user-running`、关闭资源隔离 |
| 190 第 9 节剩余八项 | 8／8；R04～R06 四项由失败转为通过 |
| P3 场景 | 原 7 项、扩展 2 项、预留边界 2 项全部通过 |
| `result-before-checkpoint` | 原执行同 ID 完成；执行数 1；效果一次；工具调用数 1；恢复模型调用 1 次 |
| `checkpoint-before-commit` | 原执行同 ID 完成；恢复模型调用 0；答复为「原检查点中的最终回复」；状态 `mood=检查点内的状态` |
| `commit-before-task-finish` | 恢复模型调用 0；任务／活动／唤醒 `completed`，资源延续全部结束；重复重启无新调用 |
| `before-dispatch` | 效果为空；调用 `failed / PROCESS_INTERRUPTED`；使用 2 点、计量账本 2 点，预留已释放 |
| 业务副作用 | 仅隔离测试目录；无真实 QQ、真实模型、用户数据或付费调用 |

`before-dispatch` 的最新图检查点仍停在首轮模型之前（`step=0`），因此按 8.1 条件走既有任务延续而不是原执行恢复；该用例的 R06 契约（未派发退还、效果为空、余额与账本一致）已通过。`result-before-checkpoint` 与 `checkpoint-before-commit` 才具备可继续的已完成检查点，已按原 `executionId` 恢复。

### 8.5 未覆盖与复验边界

- 本节为实现方自验；需要独立复验原执行 ID、检查点原文／状态、效果次数、余额账本、收尾幂等和既有 P3／P4 场景。
- 完整多进程并发、更多数据库损坏组合、真实模型／远程 MCP、桌面交付仍未验证；本轮没有真实模型或付费调用。
- 未提交、未推送；P4 通过结论仍由独立复验决定。

## 9. 复核中补齐内部步骤、跨日计量和中断原文保留

日期：2026-11-05。用户要求“复核修复”。原第 8 节八项验收独立复跑通过，R05 在已验范围关闭；R04／R06 的扩展边界由本轮直接修正，本节记录其自验，不能代替后续独立复验。发现及前后证据详见 [190 第 10 节](190-p4-recovery-acceptance-report.md)。

1. 内部工具原先没有持久的步骤结果：同一回合先写日记后调用 MCP，MCP 结果入库、图未保存时退出，恢复会重复写日记并多扣点。本轮在既有业务事件中保存稳定步骤凭据；成功结果直接复用，已进入执行但结果未确认时保持 unknown、不重做。完成凭据与计量同事务保存，不新增恢复体系或 schema。
2. 原启动计量补记使用重启时间，跨日会把前一天工具计入次日；正常工具晚到也存在同类日期归属问题。本轮外部工具结果记账及重启补记均使用持久派发时间，不补发旧日点数，不重复插入计量。
3. 原执行从工具后检查点恢复时，未完成模型流的片段可能被新答复覆盖。本轮将模型中断标记、片段消息、原始证据和中断事件一并保存，原 executionId 保持；新输出单独成段，后续只累计本段文本。

新增 `tests/p4-internal-recovery.test.ts` 六项正式回归，分别验证内部结果复用、未知内部步骤不重做、效果发生后抛错仍保留未知、正常晚到与启动补记的派发日期、中断文本分段保留；扩展异常验收脚本至 11 项。用户任务启动采样从固定等待改为等待实际模型开始，排除并行工具发现导致的假阴性，不改变业务调度。

自验目录：`backend/test-results/p4-r04-r06-review-20261105-102057/`。工程及复核脚本严格类型检查通过；正式测试 163／163、原 P4 8／8、消息／资源组合 6／6、扩展异常 11／11、P3 三组 7＋2＋2 全部通过，无样例异常。最终日记一次、余额及账本各四点；跨日工具仍记原派发日，次日实际及账本均一点；旧片段 interrupted 与新答复 completed 同时保留。报告索引和前后失败样例见 190 第 10.3 节，汇总为该目录 `verification-summary.json`。

业务变更限 `agent-graph.ts`、`conversation-store.ts`、`autonomy-store.ts`，未改依赖／schema，不新增权限或用户配置。本节为本轮直接补修的自验，R04／R06 待独立复验；不宣告 P4 正式收口或扩大真实服务范围。未提交、未推送，无真实模型或付费调用。

## 10. 内部开始凭据的启动结算补修与自验

日期：2026-11-05。依据 [190 第 11 节](190-p4-recovery-acceptance-report.md)的两项独立发现及用户“复核修改”要求。补修前重跑 13 项异常场景，原两项仍失败；本轮直接修复并自验，不将本节称为独立通过。

1. 在 ConversationStore 增加独立于节点重入的启动协调：以执行和内部步骤键读取最新凭据，started-only 转为 unknown，完成凭据及缺失账本同事务保存。已有计量直接返回，不消耗新点数；失败回滚后保留开始凭据，下次启动可重试。
2. 内部凭据补存 purpose／taskId，同时兼容旧凭据，从原执行所属任务推导归属；使用原 counted 和派发时间，保持用户豁免、无限制 counted=0、跨日归属及预算暂停保护。终态任务仅补档，不改状态、不启动模型或工具。
3. ConversationService 在恢复任务前执行协调，原任务延续上下文同时呈现内部结果及 unknown 事实，携带原执行／状态及步骤身份；不依赖能否恢复原检查点，不伪造提供方调用参数。旧日记只核查已有记录，不自动重写。

业务源码改动限 `conversation-service.ts`、`conversation-store.ts`，没有 schema、依赖、权限或用户配置变更。新增 `tests/p4-internal-startup.test.ts` 五项正式回归；扩展 `reviews/20261105-p4-remaining-acceptance.ts` 至 14 项，并核验模型实际收到 unknown 事实、三种内部中断用例二次启动零调用且记录不变。

自验目录：`backend/test-results/p4-internal-startup-fix-20261105-111543/`。工程与脚本严格类型检查、168 项正式测试、8 个原 P4、6 个恢复组合、14 个异常场景、P3 的 7＋2＋2 均通过。证据索引、具体修复后状态见 [190 第 12 节](190-p4-recovery-acceptance-report.md)；前后源码哈希及范围保存在 `source-before.json`、`source-after.json`，汇总为 `verification-summary.json`。

日记一次；同日已用及账本均三点，跨日次日均一点；终态故障例补账后仍 failed、无新模型、已用及账本均两点。重复启动无重复内部凭据、账本、日记或模型调用。R04／R06 补修自验通过但待后续独立复验，R01～R03／R05 已关闭范围保留；P4 不收口、不进入 P5。无真实服务或付费调用，未提交、未推送。

## 11. 用户接受当前证据并确认阶段收口

2026-11-05，用户明确“可以收口了”。P4 及 R04／R06 按用户确认收口，进入 P5 原型整体复核与交付整理；详见 [190 第 13 节](190-p4-recovery-acceptance-report.md)。本次只更新阶段状态，没有新增独立复验；第 10 节最终补修仍为自验证据，P5 整体复核分别保留证据来源与未验证范围。未提交、未推送。
