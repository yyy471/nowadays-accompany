# P2-05 独立复核问题修复记录

日期：2026-11-04。

最新状态：**R01／R02 最后补正已通过 182 第 6 节复验，R05／R09 后续修复已通过[184 第 7 节](184-p2-06-acceptance-report.md)独立复验。** R01～R09 均关闭，P2 首轮后端及本次真实 DeepSeek 配置范围通过，105 项回归、20 个离线及 4 项真实复验通过；本文保留历史修复自验。未提交、未推送。

需求依据：[182](182-p2-05-independent-review.md) 第 2 节 R01～R08；[173 P2 开发文档](173-p2-memory-agent-development-guide.md)；[174 P2-01 契约](174-p2-01-memory-agent-contract.md)；持续决策记录中的 DL-71、DL-80～DL-82、DL-87、DL-102、DL-103。

## 1. 环境与证据

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6` + 当前未提交工作树 |
| 运行环境 | win32-x64，P0 专用 Node.js 24.22.2，独立 `backend/` 依赖 |
| 执行目录 | `backend/` |
| 运行编号 | `p2-05-review-fix-20261104` |
| 证据日志 | `backend/test-results/p2-05-review-fix-20261104/typecheck.log`、`tests-sequential.log`、`tests-parallel.log`、`probes.log`、`probe-report.json`（Git 忽略） |

实际运行：

```powershell
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test --test-concurrency=1 tests/*.test.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test tests/*.test.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-05-review.ts
```

| 检查 | 结果 |
| --- | --- |
| 类型检查 | 退出码 0 |
| 全量顺序回归 | 94／94 通过，0 失败、0 取消 |
| 全量并行回归 | 94／94 通过，0 失败、0 取消 |
| 182 边界探针 | 10／10 `contractPassed=true`，无 `probeError` |

测试总数由 77 项增至 94 项，新增 17 项 R01～R08 正式回归。全部模型为离线端口或注入模型；MCP 使用真实本地 stdio 服务与临时工作空间；未调用真实模型、QQ、远程 MCP 或付费服务。

复核探针脚本沿用 182 固定的 `backend/test-results/p2-05-independent-20261104/` 输出目录；本次修复运行的 `report.json` 已更新为该目录当前内容，另存副本于本次运行目录的 `probe-report.json`。独立复验应重新执行并保留自己的运行目录。

## 2. R01 新消息不等待旧工具，原任务不自动失败

修改：

- [conversation-service.ts:81](../backend/src/application/conversation-service.ts#L81) 增加 `detached` 集合。[:847](../backend/src/application/conversation-service.ts#L847) 的 `supersedeWindow` 在中断旧执行后立即释放角色决策槽，并把旧执行移入 `detached`；旧工具结果仍由原执行保存，新消息可马上开始新决策。
- [conversation-service.ts:461](../backend/src/application/conversation-service.ts#L461) 在原执行结束时从 `detached` 移除并重新调度；[:832](../backend/src/application/conversation-service.ts#L832) 的 `isIdle` 在仍有分离执行时保持非空闲，避免读侧把在途工具当作已结束。第二轮补充原任务的独立续行执行，见第 11.2 节。
- 删除旧执行失败时自动将任务结束为 `EXECUTION_SUPERSEDED` 的分支；只有非 `TASK_ENDED` 的真实失败才结束任务，新消息不再改变原任务状态或资源延续。

自验：

- [p2-05-mcp.test.ts:399](../backend/tests/p2-05-mcp.test.ts#L399) 启动真实 `command_run` 慢工具，工具未释放时发送新消息；断言新回复先完成、旧执行保留 `interrupted` 部分文字、原任务保持 `active` 且无结束原因、旧工具结果保存为 `success`、无重复派发。
- [p2-05-conversation.test.ts:124](../backend/tests/p2-05-conversation.test.ts#L124) 的原 supersede 用例按新行为更新：中断后立即出现 `superseded` 与 `running` 两条执行；回复顺序、旧执行 `decision_round=null`、事件与第二轮上下文保持原断言。

## 3. R02 每次派发读取最新模型／MCP／Skill 配置

修改：

- [model-binding-resolver.ts:40](../backend/src/application/model-binding-resolver.ts#L40) 增加 `refresh`：保留原 `resourceId` 以延续当前执行，重新解析同一资源的最新配置与同资源最新模型名。
- [conversation-service.ts:506](../backend/src/application/conversation-service.ts#L506) 的 `resolveModel` 在每一轮模型调用前刷新；[agent-graph.ts:170](../backend/src/application/agent-graph.ts#L170) 每轮使用当前句柄和配置记录 `model_calls`。已发出的模型流继续使用其开始时的配置。
- [agent-tools.ts:735](../backend/src/application/agent-tools.ts#L735) 的 MCP 工具每次调用重新读取资源配置、按最新 `env` 建立临时连接并在调用后关闭；目录探测阶段的临时连接也会关闭。资源关闭后，原执行已装配的工具仍可继续，下一任务不再获得已关闭资源。第二轮已改为按配置指纹复用连接池，并以任务链为生命周期，见第 11.3 节。
- [agent-tools.ts:139](../backend/src/application/agent-tools.ts#L139) 的 `skillLibraryFor` 在每次 `skill_read` 时按资源最新 `sourcePath` 重建库；[agent-tools.ts:702](../backend/src/application/agent-tools.ts#L702) 正文和引用文件都从最新目录读取。

自验：

- [p2-05-conversation.test.ts:199](../backend/tests/p2-05-conversation.test.ts#L199) 第一轮后更新模型 `baseUrl`，第二轮请求使用新地址，`model_calls` 仍指向同一 `resourceId`。
- [p2-05-mcp.test.ts:477](../backend/tests/p2-05-mcp.test.ts#L477) 两次真实命令分别得到更新前后的 `REVIEW_VALUE`。
- [p2-05-skill.test.ts:52](../backend/tests/p2-05-skill.test.ts#L52) 两次读取同一 Skill，分别命中旧、新 `sourcePath` 的正文。
- 原有 [p2-05-mcp.test.ts:111](../backend/tests/p2-05-mcp.test.ts#L111) 继续验证关闭 MCP 后原链可用、下一任务不再提供外部工具。

## 4. R03 显式不完整响应不按成功提交

修改：

- [domain/model.ts:100](../backend/src/domain/model.ts#L100) 集中定义显式不完整判定：`incomplete=true` 或 `stopReason` 为 `length`、`max_tokens`、`max_output_tokens`、`incomplete`、`response.incomplete`。
- [agent-graph.ts:239](../backend/src/application/agent-graph.ts#L239) 在确认终态后、返回工具调用或提交前抛出 `MODEL_REQUEST_FAILED`（`reason: INCOMPLETE_RESPONSE`）；已输出文字保留为中断消息，工具请求不派发。
- [memory-runtime.ts:390](../backend/src/application/memory-runtime.ts#L390) 的默认 `HttpMemoryModel` 拒绝不完整终态，返回 `MEMORY_MODEL_INCOMPLETE`；记忆服务按失败批次处理，证据保持未完成并进入退避。

自验：

- [p2-05-failure.test.ts:159](../backend/tests/p2-05-failure.test.ts#L159) 覆盖 `length`、`max_tokens`、`response.incomplete`：执行失败、`decision_round=null`、部分文字中断保留、下一消息可重新决策。
- [p2-05-failure.test.ts:199](../backend/tests/p2-05-failure.test.ts#L199) 验证不完整响应携带 `state_update` 请求时不执行工具、不改变状态。
- [p2-05-memory-chain.test.ts:385](../backend/tests/p2-05-memory-chain.test.ts#L385) 覆盖完成标记与 `max_tokens` 两种不完整记忆响应：批次失败、无事件、证据未被标记 `processed`。

## 5. R04 state_update 失败不提交补丁

修改：

- [agent-graph.ts:336](../backend/src/application/agent-graph.ts#L336) 先执行工具并检查结果，仅在 `status === "success"` 时合并待提交补丁；参数形状保持 `{patch:{...}}`，与工具读取一致。失败结果只进入下一轮工具消息，不改变状态。

自验：

- [p2-05-conversation.test.ts:255](../backend/tests/p2-05-conversation.test.ts#L255) 成功补丁仍只在完成事务提交，工具消息为 `success`。
- [p2-05-conversation.test.ts:302](../backend/tests/p2-05-conversation.test.ts#L302) 非法补丁返回 `INVALID_TOOL_ARGUMENTS`，角色状态与版本不变。

## 6. R05 默认记忆模型请求包含完整输出协议

修改：

- [memory-runtime.ts:397](../backend/src/application/memory-runtime.ts#L397) 的默认系统提示列出 `create_event`、`update_event`、`refine_event`、`defer` 的必需字段与约束，包含 `expectedVersion`、`evidenceIds`、`experienceDate`、候选限制和空操作示例。
- [memory-runtime.ts:351](../backend/src/application/memory-runtime.ts#L351) 的 `RefreshingMemoryModel` 让默认 HTTP 记忆模型在每次 `form()` 时刷新同一资源的最新配置，与 R02 的派发前读取原则一致。

自验：[p2-05-memory-chain.test.ts:311](../backend/tests/p2-05-memory-chain.test.ts#L311) 使用只依据请求协议生成结果的离线模型：断言请求包含上述操作与字段，并由默认 `HttpMemoryModel` 经 `MemoryService` 保存事件、把证据标记为 `processed`，覆盖请求协议到实际写入的链路。

## 7. R06 Agent 接入事件／摘要纠错与摘要来源追溯

修改：

- [agent-tools.ts:47](../backend/src/application/agent-tools.ts#L47) 的工具目录增加 `memory_correct_event`、`memory_correct_summary`、`memory_summary_evidence`。
- [agent-tools.ts:397](../backend/src/application/agent-tools.ts#L397) 与 [:465](../backend/src/application/agent-tools.ts#L465) 按契约解析版本纠错参数，调用既有 `correctEvent`／`correctSummary`；原始消息和证据不被改写。
- [agent-tools.ts:519](../backend/src/application/agent-tools.ts#L519) 按摘要来源范围读取原始消息与工具证据，支持 `windowId`、`fromSequence`、`toSequence`、`limit`，并登记摘要召回。
- [memory-store.ts:1059](../backend/src/storage/memory-store.ts#L1059) 的 `listSummaryEvidence` 按摘要来源窗口与序号／时间范围查询，拒绝跨窗口混入。

自验：[p2-05-agent.test.ts:128](../backend/tests/p2-05-agent.test.ts#L128) 在同一轮依次验证：摘要证据读取仅返回来源窗口原文；按当前版本纠错成功且版本递增；旧版本纠错返回 `MEMORY_VERSION_CONFLICT`；另一角色的事件返回 `MEMORY_EVENT_NOT_FOUND`；原始消息与摘要正文不变；摘要召回已登记。

## 8. R07 无新证据时的精炼维护批次与失败退避

修改：

- [memory-store.ts:749](../backend/src/storage/memory-store.ts#L749) 的 `latestMaintenanceBatch` 以 `input_from_sequence=0 AND input_to_sequence=0` 标识无证据维护批次（[:389](../backend/src/storage/memory-store.ts#L389) 的创建处约定该标记）。
- [memory-store.ts:378](../backend/src/storage/memory-store.ts#L378) 在无待处理证据但存在精炼候选时创建 0／0 维护批次并消费待处理触发；[memory-service.ts:174](../backend/src/application/memory-service.ts#L174) 对维护批次允许一次空证据模型调用，由模型决定是否精炼，操作数为 0 也按完成处理。
- [memory-service.ts:307](../backend/src/application/memory-service.ts#L307) 的 `runPending` 在维护批次后停止本轮回圈，避免同角色并发批次。
- [memory-runtime.ts:249](../backend/src/application/memory-runtime.ts#L249) 依据最近维护批次的失败状态、`attemptCount` 与默认重试间隔计算下次重试时间；[:213](../backend/src/application/memory-runtime.ts#L213) 的定时唤醒和 [:333](../backend/src/application/memory-runtime.ts#L333) 的到期判断都纳入该时间。只有仍有精炼候选时才排定重试，避免空转。

自验：

- [p2-05-memory-chain.test.ts:452](../backend/tests/p2-05-memory-chain.test.ts#L452) 无新证据时模型被调用一次，输入证据为空且含候选；模型选择不精炼时事件保持 `active`、无摘要，批次完成。
- [p2-05-memory-chain.test.ts:494](../backend/tests/p2-05-memory-chain.test.ts#L494) 模型失败后维护批次失败、候选保留；再次运行会重试并产生第二个失败批次。
- [p2-05-memory-chain.test.ts:549](../backend/tests/p2-05-memory-chain.test.ts#L549) 待处理证据与候选在同一模型输入中同时提供。

第二轮补充候选首次自动检查、1 小时复检和跨批累计失败次数，见第 11.4 节。

## 9. R08 任务结束后不再派发新调用

修改：

- [errors.ts:356](../backend/src/domain/errors.ts#L356) 增加 `TaskEndedError`（`TASK_ENDED`）。
- [agent-graph.ts:461](../backend/src/application/agent-graph.ts#L461) 的 `checkTask` 在模型轮次开始、工具轮次开始和每次工具调用前检查任务仍为 `active`；[:169](../backend/src/application/agent-graph.ts#L169)、[:302](../backend/src/application/agent-graph.ts#L302)、[:310](../backend/src/application/agent-graph.ts#L310) 分别接入。已发出的调用继续接收结果，晚到结果不重启任务。
- [conversation-service.ts](../backend/src/application/conversation-service.ts) 的执行失败路径对 `TASK_ENDED` 不再重复结束任务。

自验：[p2-05-mcp.test.ts:600](../backend/tests/p2-05-mcp.test.ts#L600) 在第一轮真实 `workspace_write` 成功后通过正式 `finishTask` 结束任务，再让模型请求第二次写入；断言第二次工具未执行、`round-2.txt` 不存在、执行失败原因为 `TASK_ENDED`、任务保持 `completed`、仅有一个工具调用。

第二轮把该检查落实到异步建连之后的实际派发边界，见第 11.5 节。

## 10. 首轮回归范围与限制

- 全量 94 项包含 P1 13 项、P2-02／P2-03 既有记忆用例、P2-04 模型／MCP／Skill／续轮用例以及 P2-05 的 36 项；原 77 项全部保留并通过。第二轮的 101 项回归及限制见第 11 节。
- 原 supersede 用例的预期从“中断后只有 superseded 一行”调整为“superseded 与 running 并存”，对应 R01 要求的立即释放决策槽；其余断言语义未放宽。
- 未验证真实模型供应商、远程 MCP、QQ／SnowLuma、桌面页面、P3 自主活动、P4 强杀组合与 P5 后远程资源；这些不在本轮 R01～R08 修复范围。
- 182 的失败结论在独立复验前继续有效；下一步由独立复核方重新执行 182 探针并检查本记录，通过后再推进 P2-06 全量验收。

## 11. 182 第 4 节遗留项的第二轮修复

日期：2026-11-04。本节记录 R01、R02、R07、R08 的第二轮实施方修复与自验，独立复验尚未执行。

### 11.1 环境与证据

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6` + 当前未提交工作树 |
| 运行环境 | win32-x64，P0 专用 Node.js 24.22.2，独立 `backend/` 依赖 |
| 执行目录 | `backend/` |
| 运行编号 | `p2-05-review-fix2-20261104` |
| 证据目录 | `backend/test-results/p2-05-review-fix2-20261104/`（Git 忽略） |
| 证据文件 | `typecheck.log`、`tests-sequential.log`、`tests-parallel.log`、`original-probes.log`、`report.json`、`extended-probes.log`、`extended-report.json` |

实际运行：

```powershell
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test --test-concurrency=1 tests/*.test.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test tests/*.test.ts
$env:NOWADAYS_REVIEW_OUTPUT="test-results/p2-05-review-fix2-20261104"
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-05-review.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-05-fix-recheck.ts
```

| 检查 | 结果 |
| --- | --- |
| 类型检查 | 退出码 0 |
| 全量顺序回归 | 101／101 通过，0 失败、0 取消 |
| 全量并行回归 | 101／101 通过，0 失败、0 取消 |
| 原 10 个探针 | 10／10 `contractPassed=true`，无 `probeError` |
| 5 个扩展场景 | 5／5 `contractPassed=true`，无 `probeError` |

测试总数由 94 项增至 101 项，本轮新增 7 项正式回归。`20261104-p2-05-fix-recheck.ts` 增加与首轮探针一致的 `NOWADAYS_REVIEW_OUTPUT` 可选输出目录，缺省仍为独立复核目录；本次使用覆盖值，未改写独立复核证据。全部模型为离线端口或注入模型；MCP 使用真实本地 stdio 服务与临时工作空间；未调用真实模型、QQ、远程 MCP 或付费服务。

### 11.2 R01 原任务的独立续行执行

修改：

- [conversation-service.ts:88](../backend/src/application/conversation-service.ts#L88) 增加待续行队列；[:421](../backend/src/application/conversation-service.ts#L421) 的 `schedule` 先处理未完成用户消息，再启动队列中的任务续行；[:428](../backend/src/application/conversation-service.ts#L428) 的 `startTaskContinuation` 为同一任务创建新执行并设置运行槽。
- [conversation-store.ts:229](../backend/src/storage/conversation-store.ts#L229) 的 `beginTaskContinuation` 校验角色状态版本、无运行中执行且任务仍为 `active`，插入 `trigger_type='tool_result'` 的执行并登记 `continues` 关系；不新建任务。
- [conversation-service.ts:731](../backend/src/application/conversation-service.ts#L731) 在续行执行的消息前附加任务档案；[:952](../backend/src/application/conversation-service.ts#L952) 的 `buildContinuationToolMessages` 从 [role-store.ts:1019](../backend/src/storage/role-store.ts#L1019) 的 `listTaskToolCalls` 重建该任务已发生工具调用及真实结果，再叠加最新近期消息。[agent-graph.ts:140](../backend/src/application/agent-graph.ts#L140) 的执行输入接受 `taskId`，续行沿用原任务身份。
- [conversation-service.ts:1024](../backend/src/application/conversation-service.ts#L1024) 的系统提示说明当前在继续原任务及目标，要求不重做已成功步骤、不续写被中断回复，按最新上下文继续。
- [conversation-service.ts:821](../backend/src/application/conversation-service.ts#L821) 在旧执行因新消息被替代且原任务仍为 `active` 时排队续行；[:504](../backend/src/application/conversation-service.ts#L504) 按 `taskId` 去重；[:1081](../backend/src/application/conversation-service.ts#L1081) 的 `isIdle` 把待续行视为非空闲。续行成功完成后由同一执行路径把原任务标记为 `completed`。

自验：

- [p2-05-mcp.test.ts:560](../backend/tests/p2-05-mcp.test.ts#L560) 新增两步任务用例：第一步真实工具被门控，期间发送新消息；工具释放后原任务继续，最终写出 `task-result.md`。断言仅一个任务且为 `completed`、三次执行依次为 `superseded`／`completed`／`completed`、两个工具调用均成功、任务关系为 `initiates`＋`continues`。
- [p2-05-mcp.test.ts:408](../backend/tests/p2-05-mcp.test.ts#L408) 更新首轮用例：新增“原任务继续完成”回复，断言续行决策发生、任务完成原因仍为“回复完成”、无重复任务。
- 扩展探针 `R01-original-task-progress-after-new-reply` 的 `contractPassed=true`：两步任务在新消息后继续保存成果，`continuationRequests=2`，任务为 `completed`。

限制：续行不按步骤签名做硬去重，而是把已发生调用与真实结果放入模型历史并在系统提示中约束；若模型仍重复请求同一步骤，当前实现不会在工具层拦截。该边界由本轮测试覆盖“已完成步骤不再调用”的常规路径，独立复核可继续压测。

### 11.3 R02 配置指纹与任务链级 MCP 复用

修改：

- [agent-tools.ts:750](../backend/src/application/agent-tools.ts#L750) 以 `command`、`args`、排序后的 `env` 生成配置指纹；[:761](../backend/src/application/agent-tools.ts#L761) 的 `McpConnectionPool` 在每次 `acquire` 时读取最新配置（[:771](../backend/src/application/agent-tools.ts#L771)）：指纹未变复用同一客户端与服务进程，变化时退休旧连接并为后续调用建立新连接。
- [agent-tools.ts:806](../backend/src/application/agent-tools.ts#L806) 以活跃调用计数延迟关闭；[:831](../backend/src/application/agent-tools.ts#L831) 的 `retire` 仅在无在途调用时关闭旧客户端，已发出的调用仍从旧配置收取结果。[agent-tools.ts:141](../backend/src/application/agent-tools.ts#L141) 在目录释放时关闭全部连接。
- [conversation-service.ts:92](../backend/src/application/conversation-service.ts#L92) 增加按任务登记的工具目录缓存。续行执行优先复用同一任务的目录与连接池（[:665](../backend/src/application/conversation-service.ts#L665)）；新任务结束时登记目录（[:722](../backend/src/application/conversation-service.ts#L722)），任务完成或失败后释放（[:821](../backend/src/application/conversation-service.ts#L821)）；服务关闭时释放全部残留目录（[:391](../backend/src/application/conversation-service.ts#L391)）。因此同一任务链跨续行执行保持同一 MCP 服务会话，下一任务重新装配。
- 目录复用不改变配置读取时机：模型、MCP 和 Skill 内容仍按派发读取最新配置；任务链内关闭资源时，已装配工具继续可用至链条结束，新任务不再获得该资源。

自验：

- [p2-05-mcp.test.ts:817](../backend/tests/p2-05-mcp.test.ts#L817) 同一执行连续两次调用真实有状态 stdio 服务，配置不变，结果为 `["1","2"]`。
- [p2-05-mcp.test.ts:921](../backend/tests/p2-05-mcp.test.ts#L921) 新增跨续行用例：首执行第一次调用得到 `1`，新消息替代后任务续行再次调用得到 `2`，证明续行复用同一服务会话；任务最终 `completed`。
- [p2-05-mcp.test.ts:1053](../backend/tests/p2-05-mcp.test.ts#L1053) 新增关闭后链内延续用例：读取后关闭 MCP 资源并触发新消息，原任务续行仍可使用已装配工具写出成果；任务完成后新消息的模型请求不再包含外部工具，证明链结束时释放。
- [p2-05-mcp.test.ts:111](../backend/tests/p2-05-mcp.test.ts#L111) 关闭资源后原执行第二次调用仍成功，下一任务不再提供外部工具。
- [p2-05-mcp.test.ts:618](../backend/tests/p2-05-mcp.test.ts#L618) 配置变化后的下一次派发使用新 `env`；旧、新值分别为 `old`／`new`，均收到真实工具结果。
- 扩展探针 `R02-mcp-session-survives-unchanged-config` 的 `contractPassed=true`，结果为 `["1","2"]`。

限制：目录和连接池只存在于 `ConversationService` 内存中，后端重启后新执行会重新建连，不保留服务进程会话；多个并行活动任务各自持有目录，服务关闭时统一释放。

### 11.4 R07 候选首次自动维护与跨批失败退避

修改：

- [memory-runtime.ts:282](../backend/src/application/memory-runtime.ts#L282) 的 `maintenanceCheckAt`：存在精炼候选且没有维护批次时返回当前时间，首次候选可立即自动检查；最近维护成功则在其完成后 `MAINTENANCE_RECHECK_MS`（[:39](../backend/src/application/memory-runtime.ts#L39)，1 小时）再检查；失败时交给重试路径。
- [memory-runtime.ts:257](../backend/src/application/memory-runtime.ts#L257) 的 `maintenanceRetryAt` 仅在仍有候选时按累计 `attemptCount` 索引既有退避表；[:365](../backend/src/application/memory-runtime.ts#L365) 的 `runOnce` 在无待处理触发时按重试或检查到期运行 `maintenanceOnly` 批次，[:214](../backend/src/application/memory-runtime.ts#L214) 的定时器同时纳入两者，避免紧密循环。
- [memory-store.ts:355](../backend/src/storage/memory-store.ts#L355) 接受 `maintenanceOnly`；[:466](../backend/src/storage/memory-store.ts#L466) 的 `startMaintenanceBatch` 创建 0／0 维护批次，不使用未达阈值的证据；[:498](../backend/src/storage/memory-store.ts#L498) 以 `consecutiveMaintenanceFailures`（[:518](../backend/src/storage/memory-store.ts#L518)）写入累计失败次数，计数会跨批保留直到维护成功。

自验：

- [p2-05-memory-chain.test.ts:550](../backend/tests/p2-05-memory-chain.test.ts#L550) 新候选在第 100 轮后自动触发一次维护：模型收到空证据与候选，选择不精炼后维护批次完成，候选保留且两条待处理证据未被消费。
- [p2-05-memory-chain.test.ts:494](../backend/tests/p2-05-memory-chain.test.ts#L494) 连续两次维护失败后，两个 0／0 批次的 `attemptCount` 分别为 1、2，证明退避计数跨批累计。
- [p2-05-memory-chain.test.ts:452](../backend/tests/p2-05-memory-chain.test.ts#L452) 与 [:608](../backend/tests/p2-05-memory-chain.test.ts#L608) 继续覆盖手动维护和“证据＋候选”合并输入。
- 扩展探针 `R07-automatic-candidate-maintenance` 与 `R07-consecutive-maintenance-failure-backoff` 均为 `contractPassed=true`。

限制：候选在一次成功维护后仍保留时，下一次自动检查在 1 小时后；模型持续选择不精炼时每小时最多一次，不做更密集轮询。

### 11.5 R08 异步建连后的实际派发边界复查

修改：

- [agent-graph.ts:309](../backend/src/application/agent-graph.ts#L309) 定义统一的 `checkDispatch`，同时校验执行仍在运行与任务仍为 `active`；状态工具、内部工具和外部分别在 [:340](../backend/src/application/agent-graph.ts#L340)、[:363](../backend/src/application/agent-graph.ts#L363)、[:511](../backend/src/application/agent-graph.ts#L511) 获得该回调。
- [agent-tools.ts:875](../backend/src/application/agent-tools.ts#L875) 在异步 `acquire`（可能包含建连）完成后、[:876](../backend/src/application/agent-tools.ts#L876) 的 `callTool` 之前调用 `checkDispatch`；任务结束或执行被替代时不会派发。
- [agent-tools.ts:893](../backend/src/application/agent-tools.ts#L893) 将 `TASK_ENDED`／`EXECUTION_SUPERSEDED` 原样抛回；[agent-graph.ts:516](../backend/src/application/agent-graph.ts#L516) 保存该工具调用的失败结果并中断执行，晚到结果不重发。

自验：

- [p2-05-mcp.test.ts:1122](../backend/tests/p2-05-mcp.test.ts#L1122) 建连期间通过正式 `finishTask` 结束任务：释放建连门控后 `late-result.txt` 不存在，工具结果为 `failed`／`TASK_ENDED`，执行失败，任务保持 `completed`。
- [p2-05-mcp.test.ts:1264](../backend/tests/p2-05-mcp.test.ts#L1264) 建连期间新消息替代：首次派发未执行并记为 `EXECUTION_SUPERSEDED` 失败，续行重试后成功；三次执行依次为 `superseded`／`completed`／`completed`，任务完成。
- [p2-05-mcp.test.ts:741](../backend/tests/p2-05-mcp.test.ts#L741) 继续覆盖模型轮次入口的任务结束检查。
- 扩展探针 `R08-task-end-during-mcp-connect` 的 `contractPassed=true`。

### 11.6 回归范围与限制

- 101 项回归包含 P1 13 项与 P2-01～P2-05 既有用例；94 项全部保留并通过，本轮新增 7 项正式回归：两步任务续行、同执行会话复用、续行会话复用、关闭后链内延续、建连期间任务结束、建连期间新消息替代、候选自动维护。
- 原 10 个探针与 5 个扩展场景均通过，没有 `probeError`；探针场景逻辑未改动，输出目录通过可选环境变量隔离。
- 未验证真实模型供应商、远程 MCP、QQ／SnowLuma、桌面页面、P3 自主活动、P4 强杀组合与 P5 后远程资源。
- 182 第 4 节的未通过结论在独立复验前继续有效；本节的实施方自验不替代独立复核。下一步由独立复核方重新执行原探针与扩展场景、检查本轮代码和证据，通过后再推进 P2-06 全量验收。本轮未提交、未推送。

## 12. 独立复验发现模型停用后的任务续行遗漏与补正自验

日期：2026-11-04。第二轮的 101 项测试和原 15 个探针已由 182 第 5 节独立重跑通过；补充模型开关场景复现遗留，失败报告独立保存。用户要求复核修改，本轮直接补正；本节仅为该补正的自验，不代替独立复验。

### 12.1 修改

- `backend/src/application/conversation-service.ts`：任务工具目录缓存增加 `modelBinding`，在任务创建时保存原绑定，续行按同一任务恢复该绑定，不重新选择新任务模型。`resolveModel` 每次仍调用 `bindings.refresh`，保留同一资源身份并读取最新配置。
- `schedule` 只在准备启动新用户消息执行时要求当前启用的模型；当前模型停用且有待处理新消息时，仍允许已排队的原任务续行。原任务完成／失败或显式结束时，绑定随任务目录释放，不提供给后续新任务。
- `backend/tests/p2-05-mcp.test.ts` 新增 2 项回归：分别关闭模型资源和角色模型绑定；原任务继续写出 `chain-result.md`，新 baseUrl 在两次后续调用生效，关闭后发送的新消息 `processed_by_execution_id` 仍为空，没有新建任务。
- `backend/reviews/20261104-p2-05-model-continuation.ts` 保存独立复现与补正对照结果；新任务被阻止的断言与成果文件、同一任务终态均纳入通过条件。

本次没有改变 DL-71／DL-102，没有增加开关、授权或配置项；模型缓存只跨原任务的续行保留，重启后的恢复属于后续验证范围。

### 12.2 运行与结果

基线仍为 `codex/p1-role-storage`、Git `3fa50e6`＋未提交工作树；win32-x64，P0 专用 Node.js 24.22.2、独立 backend 依赖。证据目录 `backend/test-results/p2-05-model-continuation-fix-20261104/`，当前版本 SHA-256 见 `source-manifest.json`。全部运行使用离线模型、本地 MCP、专用临时目录和既有删除守卫，无真实供应商调用。

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit` | 退出码 0 |
| 全量 `--test tests/*.test.ts` | 103／103，0 失败、0 取消；`tests.log` |
| 原探针 | 10／10，通过；`report.json` |
| 扩展探针 | 5／5，通过；`extended-report.json` |
| 新模型停用续行探针 | 1／1，通过；`model-continuation-report.json` |

补正前对应报告在 `backend/test-results/p2-05-final-review-20261104/`：调用 3 次、未保存成果、任务 `active`；补正后调用 5 次、已保存成果、任务 `completed`，新消息仍被开关阻止。最初定向运行中的两项新增测试因 SQL 字段名写错失败，修正测试后全量通过；其余 101 项未删减。

复现命令与旧两组探针相同，在 `backend/` 设置独立 `NOWADAYS_REVIEW_OUTPUT`、TEMP／TMP、`P1_REVIEW_TMP_ROOT`，用专用 Node 加载 `tsx` 与既有 `fs-guard.mjs`；新增脚本为 `reviews/20261104-p2-05-model-continuation.ts`。实际类型检查、全量测试和三组探针日志分别留存，不以实施方旧报告代替本轮结果。

下一步只需对本节新增补正作独立复验，再按 173 推进 P2-06 全量验收；R03～R08 已独立关闭。当前未提交、未推送，真实模型与 P3～P5 未验证。
