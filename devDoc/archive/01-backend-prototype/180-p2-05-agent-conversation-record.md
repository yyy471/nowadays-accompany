# P2-05 Agent 对话联动实施记录

日期：2026-11-04。

状态：**最终 P2-06 验收通过，见[184 第 7 节](184-p2-06-acceptance-report.md)。** R01～R09 已关闭，105 项回归、20 个离线及 4 项真实复验通过；本记录保留 P2-05 原 77 项实现方自验，不将历史自验扩大为后续阶段已验证。未提交、未推送。

需求依据：[持续决策记录 161](../../161-digital-life-direction-decisions.md) DL-71、DL-80～DL-88、DL-116；阶段范围见[执行清单 164](164-backend-prototype-execution-checklist.md)与 [P2 开发文档 173](173-p2-memory-agent-development-guide.md) 第 6、7 节；工程契约见 [P2-01 契约 174](174-p2-01-memory-agent-contract.md) 第 8、9、10、11、13 节。

## 1. 运行环境与源码基线

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a` + 本轮未提交工作树 |
| 运行环境 | win32-x64，Node.js 24.22.2，npm 11.19.1 |
| 新增依赖 | `@langchain/langgraph` 固定 `1.6.0`、`@langchain/core` 固定 `1.3.4`、`@langchain/langgraph-checkpoint-sqlite` 固定 `1.1.0`（与 P0 已验证版本一致） |
| 其他依赖 | 沿用 better-sqlite3 12.10.0、zod 4.6.7、TypeScript 5.9.3、tsx 4.23.15、MCP SDK 1.32.2 |
| 执行目录 | `backend/` |
| 证据目录 | `backend/test-results/p2-05-self-20261104/`（Git 忽略） |
| 类型检查 | `npm run typecheck` 退出码 0 |
| 测试 | `npm test` 共 77 项通过、0 失败，用时约 5.12 秒；其中 P2-05 新增 19 项 |

证据文件：

- `typecheck.log`：TypeScript `--noEmit` 全部输出。
- `tests.log`：`node --import tsx --test tests/*.test.ts` 完整输出。
- `source-manifest.json`：`backend/src`、`backend/tests`、`package.json`、`package-lock.json`、`tsconfig.json` 共 69 个文件的 SHA-256。
- `git-head.txt`、`git-status.txt`：本轮自验时的提交与工作树状态。

全部模型调用使用脚本化离线模型端口；MCP 用例启动真实本地 stdio 服务并使用临时工作空间；未访问远程服务、真实 QQ 或付费模型。类型检查与测试均从 `backend/` 执行。

## 2. 实际实现

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 对话领域类型 | `src/domain/conversation.ts` | 待处理窗口、认领消息、执行详情、输入状态、召回／Skill 概况、工具来源与结果、Agent 图状态 |
| 执行持久化 | `src/storage/conversation-store.ts` | 窗口排队、认领、开始执行、生成中助手消息、增量事件、正式提交、中断／替代、模型调用、工具计量、SSE 查询、启动恢复 |
| 输入状态 | `src/application/input-state.ts` | 内存 `{roleId, windowId, clientId, expiresAt}`；默认 1000ms；最早到期定时器；客户端／窗口／角色清理 |
| LangGraph 执行 | `src/application/agent-graph.ts` | `StateGraph` 模型→工具→模型循环；每轮登记 `model_calls`；文本增量落库并推送；检查点线程为 executionId；内部工具与外部 MCP 分流 |
| Agent 工具目录 | `src/application/agent-tools.ts` | 记忆检索／事件／证据／摘要、`diary_write`、`state_update`、Skill 简介与 `skill_read`、本地 MCP 工具；每个 execution 独立加载并关闭 |
| 对话服务 | `src/application/conversation-service.ts` | 消息提交、同角色串行调度、输入等待、新消息替代、自动召回、系统提示、执行生命周期、任务结束、SSE、启动恢复、关闭清理 |
| 记忆运行时 | `src/application/memory-runtime.ts` | 按角色队列合并证据／任务／手动触发；证据与空闲／重试定时唤醒；启动恢复运行中批次；模型失败不阻塞聊天 |
| 应用装配 | `src/bootstrap/app.ts` | LangGraph／记忆运行时／对话服务装配；可选注入时钟、时区、输入间隔、召回上限、工具回合上限、模型工厂与空闲间隔；启动顺序恢复记忆批次、执行与输入状态；关闭顺序先停会话与流再关数据库 |
| HTTP | `src/http/routes.ts`、`schemas.ts`、`router.ts` | 消息提交接入对话服务；输入状态 POST／DELETE；SSE `GET .../events`；执行详情；任务列表／详情／结束；流式响应允许处理器不写 JSON |
| CLI | `src/cli/client.ts`、`commands.ts` | SSE `data` 行读取；`input set/clear`、`events`、`execution get`、`task list/get/finish` |
| 执行记录字段 | `src/storage/role-store.ts` | 执行记录暴露 `decisionRound`；任务创建支持 `origin` 与 `initiatorExecutionId`，对话产生的任务归属当前执行 |
| 记忆批次恢复与唤醒 | `src/storage/memory-store.ts`、`src/application/memory-service.ts` | 运行中批次按 `PROCESS_INTERRUPTED` 失败并保留已提交分段；失败证据可查询最早重试时间与到期状态；空闲阈值可注入以验证定时器 |
| 用例 | `tests/p2-05-*.test.ts`、`tests/p2-05-fixture.ts` | 19 项 P2-05 用例，见第 4 节 |

## 3. 关键语义

- **调度与认领**：同一角色只运行一个有效决策。`listPendingWindows` 按窗口最早未处理消息排序；执行创建时认领该窗口全部未处理用户消息。决策完成后以同一事务标记已处理并登记证据；其他窗口排队，不并行启动。
- **输入状态**：默认停止编辑 1000ms 退出；状态只在内存。`typing=true` 时窗口不启动决策；到期、显式 `typing=false`、SSE 客户端断开、后端关闭或重启都会清理。单纯打字不打断当前回复；未发送草稿不入模。
- **新消息与部分文字**：同窗口实际新消息立即把运行中执行标为 `superseded`，按已产生增量保存 `interrupted` 助手消息并释放用户消息认领；旧执行不再写入新回复或状态。首次非空文本增量在同一事务内创建 `generating` 助手消息，后续增量只写持久流事件；正式提交更新该消息为 `completed`，中断、替代或失败更新为 `interrupted`。没有文本的执行不创建助手消息。
- **正式提交**：回复正文、角色状态浅合并与版本递增、执行 `completed`／`state_version_committed`／`decision_round`、用户消息已处理、用户与助手证据、`message_completed` 事件在同一个 SQLite 事务内完成。重复提交返回既有回复、状态版本与轮次，不写第二份消息。
- **模型失败**：执行按 `failed` 处理，已产生文字保留，`model_calls` 记 `failed` 并写 `execution_failed`；该窗口暂停自动重试，避免同一失败模型形成紧密重试循环。用户实际发送新消息会解除暂停，并把仍待处理的旧消息与新消息一起交给下一轮。
- **模型／工具循环**：单次决策最多 8 个模型／工具回合（可注入）。记忆、Skill、`state_update` 为内部工具，不创建 P1 `tool_calls` 行；外部 MCP 工具按 `executionId:round:callIndex` 登记、保存原始响应与适配结果、写工具计量（`counted=0`）与工具事件。首个外部工具调用惰性创建任务，任务 `origin='user'`、`initiator_execution_id` 指向当前执行，执行完成时结束任务并结束未结束的资源延续。供应商 wire call ID 与业务 `tool_call_id` 的映射保存在对应 `model_calls.raw_response_json.wireCallIds`，模型原始事件不被改写。
- **自动召回与深查**：执行开始时结合本轮消息与近期对话构造查询，经统一检索自动召回事件、日常摘要与日记概况，写入召回记录；系统提示列出概况 id 与检索规则。Agent 可继续调用 `memory_search`、`memory_event`、`memory_evidence`、`memory_summary` 深查，工具读取成功但无结果与查询失败在提示中区分。同一执行同一事件只计一次召回。
- **记忆运行时**：证据、任务结束和手动触发按角色队列合并；同角色单批。运行中批次在启动时标记 `PROCESS_INTERRUPTED`，`processing` 证据回到失败并立即可重试，已提交分段保留。队列空闲后按最早“失败重试时间”或“30 条以上消息的最后发生时间 + 空闲间隔”设置唤醒定时器；默认空闲间隔 60 秒，测试可注入更短值。模型失败保留证据供后续重试，不阻塞聊天。
- **SSE**：事件持久化在 `execution_stream_events`；`id` 为 `stream_event_id`，事件名固定 `execution`，`data` 含事件编号、类型、执行、窗口与时间及类型字段。无游标只推新事件；显式游标先补读；非法游标返回 400 `SSE_CURSOR_INVALID`；每 15 秒注释心跳。断线清理该客户端输入状态并继续执行；重连只读持久事件，不重新调用模型或工具。
- **启动恢复**：进程启动先恢复运行中记忆批次，再把遗留 `running` 执行标为失败、按增量事件重建部分文字、释放用户消息认领、失败遗留模型调用，并清空输入状态（内存天然为空）。待处理用户消息不自动重发，等待下一条真实消息或显式触发；完整退出／重启组合验收仍归 P4。

## 4. 自验用例

P2-05 新增 19 项，全部包含在全量 77 项中：

| 用例 | 核对结果 |
| --- | --- |
| 用户消息完成 LangGraph 决策并提交 | 回复、状态版本、决策轮次、用户与助手证据、检查点、模型调用与计量、流事件均落库；系统提示含角色设定与用户内容 |
| HTTP／CLI 输入、执行与任务 | 消息提交返回 201／`decisionScheduled`；执行详情含状态与轮次；输入状态设置／清除；缺少 clientId 返回 `INPUT_STATE_INVALID`；任务列表／详情／结束；`cli task get`、`cli execution get`、`cli events` 输出一致 |
| 输入等待与多消息合并 | 输入状态为 true 时不启动；退出后两条待处理消息共用一次模型回合 |
| 重复提交 | 同 submissionId 不打断、不新增执行 |
| 新消息替代与部分文字 | 旧执行 `superseded`，部分文字以 `interrupted` 保留在原顺序，新执行只使用新回复；第二次模型请求包含中断说明 |
| 状态补丁 | `state_update` 补丁只在完成事务合并，版本递增到 2 |
| 输入到期自动开始 | 注入 40ms 输入间隔，到期后自动执行并保存回复 |
| 跨窗口串行 | 两个窗口按最早消息顺序执行，执行记录窗口与状态正确 |
| 自动召回与深查 | 从真实事件自动召回，`memory_event`＋`memory_evidence` 读取原始依据；内部工具不写 `tool_calls`，每次执行只计一次召回 |
| 工具回合上限 | 注入 2 回合，持续请求工具的模型在执行 `failed`、错误码 `TOOL_ROUND_LIMIT`、状态未提交 |
| 模型失败与重试 | 部分文字保留、执行与模型调用失败；不自动重试；新消息解除暂停并携带旧消息成功重试 |
| 本地 MCP 工具循环 | 真实 stdio 服务返回文件内容；`tool_calls`／`tool_results`、任务完成、执行任务关联、工具计量、wire→业务 ID 映射与 3 条证据正确 |
| MCP 开关中途关闭 | 运行中执行继续完成两次真实工具调用；资源停用后下一次执行不再提供该工具且不新增 `tool_calls`，任务链延续与“关闭阻止新任务”同时成立 |
| 形成记忆后下一轮召回 | 由真实对话证据形成事件（非预置），下一轮自动召回该事件并用 `memory_event`＋`memory_evidence` 读取原始消息后回复 |
| 30 条＋空闲定时触发 | 注入 80ms 空闲间隔，30 条待处理消息在下一次对话证据登记后由定时器自动整理，无需手动触发 |
| 重启恢复执行 | 遗留 `running` 执行转 `failed`，`generating` 消息按增量重建为 `interrupted`，用户消息释放，遗留模型调用失败；新消息可继续 |
| 重启恢复记忆批次 | 遗留运行中批次转 `failed`／`PROCESS_INTERRUPTED`，证据回到失败且分段保留；重启后定时器自动重试并形成事件 |
| Skill 按需读取 | 启用 Skill 的简介进入系统提示；`skill_read` 读取正文与参考文件；内部工具不写 `tool_calls` |
| SSE 补读与新事件 | 游标补读顺序正确；非法游标 400；断开清理该客户端输入状态；无游标只推新事件；重连不增加模型调用 |

## 5. 契约核对与实现选择

本工作包按 174 补齐或显式了以下契约细节，未改变用户已确认行为：

- 执行详情返回 `decisionRound`，与 174 第 10 节“查询执行、轮次、最新事件”一致；数据库列沿用 P2-01 已固定的 `executions.decision_round`。
- 输入状态请求缺少 `clientId` 由服务层返回 `INPUT_STATE_INVALID`；结构完全不符合 `typing` 布尔约束仍由通用请求校验返回 `INVALID_REQUEST`。
- 对话产生的任务写入 `tasks.origin='user'` 与 `initiator_execution_id`，与 174 第 5 节调用归属一致。
- 首次文本增量创建 `generating` 助手消息、提交时更新为 `completed`，与 174 第 8.4 节一致；中断／替代时按增量重建并更新为 `interrupted`。
- 模型失败后暂停该窗口的自动重试是防止同一失败模型紧密循环的工程保护；发送新消息即可恢复。该选择未写入用户需求，记录在此供复核。
- 记忆空闲与失败重试由运行时定时器驱动，空闲间隔可注入仅用于可控测试；生产默认 60 秒。

## 6. 已知限制与未覆盖

- 未调用真实模型服务；OpenAI Chat Completions、Responses、Anthropic Messages 的实际兼容性仍须在 P2-06 按 DL-116 用用户配置验证。本记录不以离线模型通过代替真实服务。
- 完整退出、强杀、重启并发组合仍归 P4。本工作包只验证了启动时执行与记忆批次的清理和部分文字重建；待处理消息不会在启动时自动重发。
- 自主安排、定时唤醒、日记定时书写、完整额度周期与前后台计量周期归 P3；本工作包只登记模型／工具计量并固定任务来源。
- 远程 MCP 归 P5；本工作包只验证本地 stdio MCP。
- 未实现前端；SSE 与 CLI 只验证后端事件、游标和输出格式。
- 仅验证 win32-x64、Node.js 24 与临时目录；未验证其他平台、多进程并发写或真实用户工作空间。
- 工具调用在单轮内顺序执行，未并行派发；这是当前工程选择，不是新增产品限制。
- 本记录的自验与限制保留为当时的实现方证据；后续独立复核见[182](182-p2-05-independent-review.md)，本轮未通过。[181 P2-06 全量验收自验矩阵](181-p2-06-self-acceptance-matrix.md)保留原测试映射，不能替代边界问题的修复验收。

## 7. 复现命令

```text
cd backend
npm run typecheck
npm test
```

单组用例可使用：

```text
node --import tsx --test tests/p2-05-agent.test.ts tests/p2-05-conversation.test.ts tests/p2-05-failure.test.ts tests/p2-05-mcp.test.ts tests/p2-05-stream.test.ts tests/p2-05-skill.test.ts tests/p2-05-memory-chain.test.ts tests/p2-05-api-cli.test.ts tests/p2-05-recovery.test.ts
```

证据目录 `backend/test-results/p2-05-self-20261104/` 已按 runId 隔离；测试使用本地临时目录与脚本化模型，MCP 用例启动真实本地 stdio 服务，结束后清理临时目录。
