# 首轮后端功能缺口实施与自验记录

> **现行规范入口**：经 `198`／`199` 三轮复修闭环后的 `GAP-01`～`GAP-06` 现行规则，已整合并入 [存储、记忆与自主执行规范](../../specs/storage-memory-and-autonomy.md)；下文保留首轮实现方自验快照。

日期：2026-11-06。依据：[196 首轮后端功能缺口与补齐计划](196-backend-capability-gap-plan.md)、DL-09、DL-28、DL-49、DL-50、DL-53、DL-58、DL-68～DL-72、DL-87、DL-127。基线：`master` 的 `3761bbd` 加当前未提交工作树。

**结论：GAP-01～GAP-06 已实现并完成实现方自验。** 类型检查、严格复核脚本类型检查、192 项正式测试和 `npm run accept:offline` 的 21 个步骤全部通过，其中包含新增 24 项正式回归、21 个 P5 复核场景和既有 P2～P4 全部矩阵。仍需独立复核后才能收口；UI-PREP-01、管理与体验候选及 OPS 项未纳入本轮实现。未提交、未推送，无真实模型、真实 QQ 或付费调用。其后 198 第三轮复验确认 R02～R06 在离线范围通过，R01 续行提交前中断恢复缺口由[199 第 4 节](199-p5-gaps-review-fix-record.md)补修，本记录保留首轮自验事实。

## 1. 工作包与实现位置

| 缺口 | 实现 | 验收 |
| --- | --- | --- |
| GAP-01 慢工具自动转后台 | [executeExternalTracked](../../../backend/src/application/agent-graph.ts#L736) 在前台窗口内等待工具；越窗后写入 `background` 模式事件、`tool_backgrounded` 流事件，原执行按 `superseded` 结束但保留已领取消息与任务目录；后台结果由 [handleBackgroundToolSettled](../../../backend/src/application/conversation-service.ts#L1753) 保存并接回原任务 | 快返保持前台、慢返转后台、窗口两侧边界、同窗口插话、任务结束／资源关闭后的晚到结果；同一次调用只派发、只保存、只计量一次 |
| GAP-02 角色决定任务暂停、继续和结束 | 新增 `task_progress`、`task_pause`、`task_finish` 三个任务工具；`task_finish`／`task_pause` 由调用参数推导任务动作，提交回复后落实。暂停保留原任务编号、进度笔记与资源延续；携带任务编号的唤醒接回原链 | 两段阅读、暂停后重启接续、另起目标建新链、无任务决策时按「回复完成」结束 |
| GAP-03 核查未知结果后补录原调用 | 新增 `tool_reconcile` 工具：按原 `toolCallId` 保存明确结果、核查说明、证据关联与时间，保留先前 `unknown` 记录；结果不足时保持未知 | 写入后断线、重启核查并补录；重复补录幂等；冲突状态被拒绝；已结束任务仍可补录；证据不足保持未知 |
| GAP-04 记忆整理按模型容量分批 | [MemoryService](../../../backend/src/application/memory-service.ts#L68) 按声明的 `maxInputChars`／`maxOutputChars` 计算单批预算并扣除固定开销；[memoryCapacityOf](../../../backend/src/application/memory-runtime.ts#L399) 从当前记忆模型绑定读取容量，未声明时使用保守默认；批次保存上下文预算与输出预留 | 两种容量的离线模型得到不同批数；长证据跨批按顺序处理，成功后推进进度；容量不足返回 `MEMORY_CAPACITY_EXCEEDED` |
| GAP-05 Skill 随包脚本定位执行 | [SkillLibrary.resolveScript](../../../backend/src/skills/skill-library.ts#L104) 只允许 Skill 目录内已存在的 `.js`／`.mjs`；`skill_run` 以 Skill 目录为工作目录运行，提供 `NOWADAYS_WORKSPACE`，记录输出、退出码、超时与截断 | 脚本读取随包资源并写入工作空间；失败状态与退出码进入调用记录；读取正文不产生执行，未启用 Skill 不提供运行入口 |
| GAP-06 按日记编号读取正文 | [getDiarySegment](../../../backend/src/application/memory-query-service.ts#L348) 按码点分段读取 Markdown 原文，返回 `fromChar`／`toChar`／`hasMore` 与关联事件编号，并刷新正文快照；`memory_diary` 工具暴露同一能力 | 搜索命中后读到长日记尾部；角色隔离与缺失文件报错；分段边界与连续读取 |

业务库 schema 升至 v5：新增 `task_notes`，扩展 `execution_stream_events` 的事件类型（含 `tool_backgrounded`），新增 `tool_results.reconciled_by_call_id`。迁移保留旧数据，见 [schema.ts](../../../backend/src/storage/schema.ts#L927)。

## 2. 关键机制

### 2.1 慢工具与决策位置

- 前台窗口原型默认 2 秒，可由 `toolForegroundWaitMs` 覆盖。取值对齐 196 中「2.2 秒观察窗口内其他窗口应先得到回复」的目标；时长仍待真实工具联调校准。窗口从工具派发开始计算，包含 MCP 握手。
- 越窗时只切换模式并结束当前图执行，不结束任务、不拉黑窗口；原用户消息保持领取状态，由结果结算后的任务续行接手。
- 后台结果仍按原 `toolCallId` 保存；任务仍活跃时排队续行，续行上下文重放已保存的工具结果。任务已结束或资源已关闭时只落库，不复活任务。

### 2.2 任务决策与续行

- 任务简报包含任务编号、目标、状态、来源、最近调用和进度笔记；角色据此决定继续、暂停或结束。
- `task_pause` 保留任务与资源延续，`task_finish` 按声明状态结束并触发经历整理；两者同时保存可选笔记。
- 普通回复没有任务决策时仍按 `completed / 回复完成` 结束，保持首轮行为。
- 携带任务编号的自主唤醒通过既有续行路径重放工具结果与内部操作事实，不新建替代任务。

### 2.3 未知结果补录

- `tool_reconcile` 只写原调用的结果事实，不重新派发工具、不新增计量。
- `verifiedByToolCallId` 接受模型侧 wire id：由 [resolveToolCallReference](../../../backend/src/storage/role-store.ts#L1154) 在同一执行保存的调用映射中解析为业务编号；无法解析时明确返回 `VERIFIED_BY_CALL_NOT_FOUND`，不写无效关联。
- 已按不同状态保存的结果保持 `TOOL_RESULT_CONFLICT`；重复相同状态返回 `duplicate=true`。

### 2.4 记忆容量

- 容量声明来自模型资源 `config.maxInputChars`／`maxOutputChars`，缺省时仍使用既有固定预算。
- 单批预算扣除输出预留与请求固定开销；输出预留随批次落库，便于核对。
- 证据按原顺序跨批处理，批次成功后才推进待处理进度，原文不删除。

### 2.5 Skill 脚本

- 只运行已启用 Skill 内的 `.js`／`.mjs`；路径经安全子路径校验，符号链接越界拒绝。
- 通过 Node 子进程执行，使用数组参数、`shell: false`，带超时与输出上限；执行结果与失败状态进入原任务调用记录。
- 内容审查、依赖安装和运行环境仍由用户负责，运行时不增加额外审批。

### 2.6 日记分段

- 分段按 Unicode 码点计数，避免代理对截断；正文以工作空间 Markdown 为准，读取时刷新快照。
- 返回关联事件编号，供角色继续检索证据。

## 3. 接管期间修复的问题

| 问题 | 修复 |
| --- | --- |
| 后台结果续行报 `The database connection is not open` | 结算回调仍在原图执行的异步上下文中，LangChain 隐式配置带入了已关闭的旧 saver。续行调度改用干净异步上下文后再延迟执行，见 [handleBackgroundToolSettled](../../../backend/src/application/conversation-service.ts#L1753) |
| 执行已停止后前台计时器仍触发转后台 | 新消息替代执行时，等待窗口计时器仍会把在途调用转后台并提前排队任务续行，导致续行在结果保存前启动。改为执行已停止时不再按超时转后台，等工具实际结算后由原执行收尾；同时把前台窗口原型默认值从 120 秒调为 2 秒，并加入默认值回归 |
| 工具结果保存失败时进程出现未处理拒绝 | 后台等待路径的前台结算错误改为传回图执行，由既有失败路径记录并恢复，不再脱离 `Promise.race`；P4 `result-db-failure` 由崩溃恢复为契约通过 |
| 核查工具无法接受模型看到的 wire id | 新增同执行调用引用解析，证据关联保存业务编号；无法解析时明确失败 |
| schema 升 v5 后两处测试仍断言 v4 | 更新 P1-02、P2-02 断言；P2-04 旧复核脚本改用当前 `refineEvent({ events })` 契约 |
| 新复核探针自身不稳定 | 修正模型回合收尾、MCP 参数传递、唤醒时间余量、冲突错误码、删除守卫与严格类型；实现未因此放宽断言 |

## 4. 自验证据

运行目录：`backend/test-results/p5-2026-11-06T03-41-12-022Z-0ded4a9b/`（Git 忽略）。使用项目独立 Node.js 24.22.2、`backend/node_modules`、离线模型与本地 stdio MCP，TEMP／TMP 独立。

| 检查 | 结果 |
| --- | --- |
| 工程类型检查 | 退出码 0 |
| 复核脚本严格类型检查 | 退出码 0（含 `--strict`、`--exactOptionalPropertyTypes`、`--noUncheckedIndexedAccess`） |
| 交付入口回归 | 2／2 |
| 正式后端测试 | 192／192，失败／取消／跳过均为 0；含新增 24 项 GAP 回归 |
| 进程冒烟 | 1／1 |
| P2 矩阵 | 10＋5＋1＋4 全通过 |
| P3 矩阵 | 7＋2＋2 全通过 |
| P4 矩阵 | 8＋6＋14 全通过 |
| P5 新矩阵 | 慢工具 5、任务决策 4、补录 3、容量 3、Skill 3、日记 3，全部通过 |
| 统一离线验收 | 21 个步骤全部通过，`summary.passed=true`，源码哈希一致 |
| 业务副作用 | 仅测试隔离目录；没有真实 QQ、真实模型、用户数据或付费调用 |

另在 `backend/test-results/p5-gaps-20261106-takeover/` 保留接管过程中逐组复跑日志；最终证据以上述统一验收目录为准。

## 5. 未覆盖与边界

- 本记录是实现方自验，不是独立复核；GAP-01～GAP-06 尚不能宣告正式收口。
- 只覆盖离线模型与本地 MCP／本地子进程；真实模型、远程 Streamable HTTP MCP、真实 Skill 依赖、桌面通知与安装包未验证。
- 前台窗口包含连接建立时间，慢握手可能先转后台；2 秒原型默认值仍待真实工具联调校准。
- 任务被用户提前结束时不复活、不续行；原用户消息保持原执行领取状态，不会被重新回答。需要「取消未处理消息」的入口仍属 196 候选。
- UI-PREP-01 角色清单、管理／体验候选、OPS-01～OPS-04 未在本轮实现，仍按 196 逐项确认。
- 未提交、未推送；下一阶段先做独立复核，再按 DL-115 推进远程 MCP。
