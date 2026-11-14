# P2-05 独立开发复核

日期：2026-11-04。

最新验收：见[184 第 7 节](184-p2-06-acceptance-report.md)。**R01～R09 均已关闭，R05／R09 修复通过独立复验；P2 在首轮单角色后端及本次真实配置范围内验收通过。** 类型检查、105 项回归、20 个离线及 4 项真实 DeepSeek 复验通过，已补齐实际事件形成、重启后新窗口检索与原始证据、回复和状态保存。下文保留历史轮次与失败证据。

首轮结论：**首轮未通过，R01～R08 待修复。** 类型检查通过；首轮并行回归 76／77，一项本地 MCP 连接关闭异常，单组复跑 2／2、顺序全量复跑 77／77 通过。补充的 10 个边界场景复现 8 类问题。180／181 的实现方自验与本记录分列，不用原测试通过代替边界验收。

本轮核对 173、174 已定的 P2-05 范围，检查 Agent／记忆工具、调度、输入中断、提交与 SSE。P3 的完整自主额度、P4 的强杀组合、P5 后的远程 MCP、桌面页面及真实供应商联调没有作为本轮新增缺陷；任务延续、调用前配置、记忆纠错和摘要原文入口原本就在 P2 联动范围。

## 1. 源码、环境与运行证据

| 项目 | 本轮证据 |
| --- | --- |
| 基线 | `codex/p1-role-storage`，Git `3fa50e6` + 当前 P2 未提交工作树；与 180 自验清单的 69 个文件逐一比较，无差异 |
| 环境 | Windows x64，P0 专用 Node.js 24.22.2，独立 backend 依赖 |
| 类型检查 | `tsc --noEmit` 退出码 0，`typecheck.log` |
| 首轮回归 | 76／77；`tests.log`，唯一失败为旧 P2-04 junction 用例的 MCP `Connection closed` |
| 失败单组复跑 | P2-04 MCP 2／2；`mcp-recheck.log` |
| 顺序全量复跑 | `--test-concurrency=1`，77／77；`tests-sequential.log` |
| 边界探针 | `backend/reviews/20261104-p2-05-review.ts`，10 个场景，全部复现契约缺口 |
| 报告目录 | `backend/test-results/p2-05-independent-20261104/`，Git 忽略 |
| 源码归属 | 本次目录 `source-manifest.json` 保存源码、测试、复核脚本及依赖清单 SHA-256 |

首轮 MCP 连接异常没有稳定复现，根因未确定，保留日志作为诊断项，不把它直接归因于 P2-05 业务逻辑。顺序复跑通过也不抹除首轮失败。

全部模型采用离线端口；MCP 使用真实本地 stdio 服务和临时文件。未调用真实模型、QQ、远程 MCP 或付费服务。TEMP／TMP 定向至本轮 `tmp/`，沿用递归删除守卫校验绝对目标。探针仅在样例工作空间写入标记文件；最后释放在途门控再关闭应用，不保留后台服务。

## 2. 问题与修复验收条件

### R01 [P1] 新消息等待旧工具结束，原任务随后被错误终止

位置：`backend/src/application/conversation-service.ts:378`、638；`agent-graph.ts:285`。

新消息把旧回复标为 superseded，但角色的 `running` 槽仍保留至旧 runExecution 完全退出；新调度因 `running.has(roleId)` 返回。正在执行的 MCP 不会因 AbortSignal 自动结束，故新消息仍被旧工具阻塞。旧工具结果落库后，旧执行又把原任务直接结束为 failed／`EXECUTION_SUPERSEDED`，没有保留继续原目标的任务链。

探针启动真实 `command_run`，确认工具已经发出再发送新消息。工具释放前经过 500ms，模型调用仍只有 1 次；旧工具结束后才开始新回复，原任务最终为 failed，原因 `EXECUTION_SUPERSEDED`。这违反 DL-82、DL-101 中“旧回复不自动续写、原任务和已发工具独立延续”的分工，也会把工具耗时转化为聊天等待。

验收：释放失效回复对角色决策槽的占用，已发调用独立保存真实结果；原任务不因新消息自动失败或关闭资源延续。用门控工具验证新回复能先开始，旧结果不覆盖新回复、状态，原任务可按既有目标继续，且没有重复派发。

### R02 [P1] 模型与 MCP 仅在执行开始时装配，后续调用使用旧配置

位置：`backend/src/application/conversation-service.ts:500`；`agent-tools.ts:105`；`agent-graph.ts:175`。

执行开始只解析一次 binding、创建一次模型和 MCP 客户端，之后各轮复用。模型的新调用不会重新读取同一资源配置，MCP 新调用也复用旧进程环境。Skill 正文会重新读取文件，但 Skill 资源 sourcePath 及工具目录仍固定于本轮开始；本轮实测覆盖模型和 MCP。

两个探针分别在第一轮调用完成后更新配置：模型 baseUrl 从旧地址改成新地址，第二次仍拿到旧 binding；MCP env `REVIEW_VALUE` 从 old 改成 new，两次真实命令 stdout 都是 old。DL-102 要求已发调用按原配置完成、下一次调用或读取使用最新配置，不能等到新 execution 才生效。

验收：每次派发前解析当前同一资源的最新配置；已发调用保持原配置。配置更新与资源关闭分开处理，关闭后的原链仍按 DL-71 延续，不借修复加入审批或取消重发。覆盖模型、MCP、Skill sourcePath 更新及关闭后延续链的新配置。

### R03 [P1] Agent 与记忆整理忽略 completed.incomplete

位置：`backend/src/application/agent-graph.ts:206`；`memory-runtime.ts:314`。

适配器已经提供显式不完整标记，两个消费方却只检查收到 completed，丢弃 incomplete／stopReason。对话探针返回 `stopReason='length', incomplete=true`，半句话被保存为 completed、执行获得 decision_round=1。记忆探针返回同样终态及语法完整的 `{"operations":[]}`，HttpMemoryModel 正常接受；若落入真实批次，会让未完整处理的输入进入成功提交路径。

验收：把显式不完整与正常结束区分，不按成功决策提交角色状态、完成消息或标记记忆处理完成。保留已输出文字和未处理证据；已有正常终态继续通过。覆盖 length、max_tokens、response.incomplete 及带工具请求的不完整响应，防止派发未确认的后续动作。

### R04 [P2] state_update 返回失败，却仍将补丁提交到状态

位置：`backend/src/application/agent-graph.ts:319`；`agent-tools.ts:397`。

图先从 `{patch: {...}}` 中取出 patch，再调用 `tool.execute(patch, ...)`；实际工具仍读取 `args.patch`，因此参数形状不一致。图在检查工具结果前已经合并 statePatch。

探针传入 `{patch:{mood:'开心'}}`，第二轮模型看到 `INVALID_TOOL_ARGUMENTS`／failed，但执行正式提交后状态中的 mood 已改为开心、版本递增。角色得到的反馈与实际保存相反，可能重试或作出错误回应。原状态用例只检查最后的数据库，没有核对工具反馈。

验收：统一参数形状，仅在工具接受成功后累积待提交补丁；失败不改变待提交状态。同时核对工具结果、下一轮上下文和最终状态；保持回复、状态及完成标记的原子提交。

### R05 [P1] 默认记忆模型请求没有提供需要输出的工程协议

位置：`backend/src/application/memory-runtime.ts:305`、326。

HttpMemoryModel 只发通用中文提示“按契约输出”，用户输入只包含证据和候选；没有发送输出 schema、操作格式或示例，也没有结构化输出／工具 schema。实际模型无法从请求获知 create_event／update_event／refine_event、expectedVersion、evidenceIds、experienceDate 等严格字段。后端却用严格 zod schema 保存，离线 ScriptedMemoryModel 预先知道协议掩盖了接线缺口。

探针直接捕获默认 HttpMemoryModel 的 ModelRequest，确认上述操作及字段均缺失。本项证据证明请求缺少格式约定，不声称已经测过真实模型，也不预测真实模型一定返回哪一种错误。

验收：通过统一端口把实际输出协议、操作与候选限制、必要示例交给整理模型；空操作仍合法。使用检查请求结构的离线模型或本地 HTTP 服务，让模型只能依据收到的协议生成结果，验证默认 HttpMemoryModel 到实际事件保存的链路，避免仅注入已经写好 operations 的整理模型。

### R06 [P2] Agent 未接入纠错和按摘要范围追溯原文的工具

位置：`backend/src/application/agent-tools.ts:39`、254、284。

当前角色实际看到 memory_search、memory_event、memory_evidence、memory_summary、diary_write、state_update 等工具，没有事件／摘要纠错入口。后端已有 correctEvent／correctSummary，但只供 API，角色不能自行执行已确认的纠错流程。

摘要详情只返回窗口／消息序号／时间范围，不包含逐条 evidenceId；memory_evidence 仅支持 evidenceId，没有按摘要来源范围搜索或读取原始记录的入口。精炼事件又已退出独立检索，角色不能按 173 第 4.2 节要求从摘要继续追溯。

探针捕获真实 Agent 请求中的工具名称与 schema，确认没有版本纠错或来源范围读取能力。这是 Agent 接线缺失，不能把页面/API 手工操作计为角色已有能力。

验收：角色可按目标版本纠错事件／摘要，原文不改；可根据摘要来源范围读取或搜索原始消息／工具证据。覆盖跨窗口、角色隔离、无结果／失败、版本冲突、召回登记及原始记录不变；沿用开关和无额外审批规则。

### R07 [P2] 没有待整理新证据时，已有精炼候选无法进入模型

位置：`backend/src/application/memory-runtime.ts:197`、287；`memory-service.ts:135`。

运行时只为消息空闲和失败证据安排定时器；runPending 最终仍从待处理证据 startBatch。仅有已经满足 100 轮条件的旧事件时，没有候选维护批次。

探针建立已处理旧事件并推进到第 100 轮，listRefineCandidates 返回一条候选；主动调用 runMemoryPending 后模型调用为 0。176 曾明确把独立精炼调度留给 P2-05，当前仍未接通，因此生命周期精炼依赖之后恰好还有消息达到整理条件。

验收：为候选维护提供不依赖新证据的调度与批次入口，保留同角色后台单批、失败退避、模型自行决定是否精炼；不要以固定删除代替模型判断。验证空证据有候选、模型暂不精炼、失败重试及与聊天/新证据批次并存。

### R08 [P1] 任务结束后同一执行仍能发起新外部工具

位置：`backend/src/application/conversation-service.ts:186`、480；`agent-graph.ts:371`。

finishTask 修改任务状态并结束资源延续，但 checkRunning 只检查回复执行是否 running；toolsNode 仍用同一 taskId 登记和派发。任务的终态未成为调用前检查条件。

探针先完成一次真实 workspace_write，然后在第二轮派发前通过正式 finishTask 接口结束任务；第二次 workspace_write 仍执行，生成 round-2.txt。不是在途调用的晚到结果，而是任务已经 completed 后新发的文件写入，违反 DL-103。

验收：任务结束后不再发起该任务的新模型／工具调用，已发调用继续接收真实结果，晚到结果不重启任务。保留业务工具身份和结果去重，覆盖用户结束任务与第二次派发交错的场景。

## 3. 探针结果与复现

| 场景编号 | 覆盖问题 | 观测 |
| --- | --- | --- |
| R04-state-update-result | R04 | 工具报 failed，状态仍变更 |
| R03-chat-explicit-incomplete | R03 | 不完整回复被正式完成并计轮 |
| R02-model-config-refresh | R02 | 第二次模型调用仍使用旧配置 |
| R06-agent-memory-capabilities | R06 | 纠错和范围追溯未接到 Agent |
| R03-memory-explicit-incomplete | R03 | 不完整整理响应未拒绝 |
| R05-memory-output-contract | R05 | 请求缺少严格输出协议 |
| R07-refinement-without-pending-evidence | R07 | 有候选，整理模型调用 0 次 |
| R01-new-message-during-inflight-tool | R01 | 旧工具释放前没有新回复；原任务被终止 |
| R02-mcp-config-refresh | R02 | 配置更新后仍使用旧环境 |
| R08-ended-task-dispatch | R08 | 任务结束后仍产生新文件写入 |

在 `backend/` 使用专用 Node 运行，按上一节设置 TEMP／TMP／删除守卫：

```powershell
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test --test-concurrency=1 tests/*.test.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-05-review.ts
```

探针报告 `report.json` 的 `contractPassed=false` 表示复现缺口，脚本返回 1；`probeError` 才代表探针本身异常。最终报告没有 probeError。脚本有存活计时器及 60 秒超时保护，用于独立执行 LangGraph 的异步场景；不改变应用运行配置。

本轮新增复核脚本和文档，未修改业务源码、未提交或推送。P2-04 在 178 的通过结论保留，新增缺陷属于 P2-05 消费接口与联动。修复后分别留下实现方自验和独立复验证据，再推进完整 P2 验收；181 继续保留为原实现方离线自验映射，不能用其“离线通过”覆盖本记录。

## 4. 183 修复后的独立复验

2026-11-04，用户要求“请复核修改”。本次检查 183 的修复版本，独立重跑类型检查、全量 94 项回归及原 10 个探针，全部通过；再按首轮验收条件补充任务继续执行、MCP 会话连续性、自动精炼及任务结束的异步派发边界。

| 检查 | 本次结果与证据 |
| --- | --- |
| 类型检查 | 退出码 0，`typecheck.log` |
| 全量回归 | 94／94，0 失败、0 取消；`tests.log` |
| 原探针 | 10／10，通过；`original-probes.log`、`report.json` |
| 扩展探针 | 5 个场景，均复现遗留；`extended-probes.log`、`extended-report.json`，没有 probeError |
| 证据目录 | `backend/test-results/p2-05-recheck-20261104/`；源码归属为其中 `source-manifest.json` |
| 复验脚本 | `backend/reviews/20261104-p2-05-fix-recheck.ts` |

原探针新增可选 `NOWADAYS_REVIEW_OUTPUT`，本次设为新目录，避免再覆盖首轮报告；缺省行为保持原路径。183 曾写入首轮目录的同名报告仍以 183 的证据归属解释，不把实施方结果误记成首轮独立通过。

### 4.1 R01：新回复不阻塞已修正，但原任务变成无人推进的 active 记录

位置：`conversation-service.ts:485`、619、646、847。

`detached` 释放旧回复决策槽后，新消息可以先回复，原任务也不再被自动改为 failed，这部分通过。但旧执行仍处于 superseded、signal 已 abort，旧工具返回后会被 checkRunning 拒绝继续；finally 关闭图和存储，删除 detached，没有保留可继续原目标的运行入口。之后调度只找未处理用户消息，不查 active 任务，也没有接收原任务档案和已有结果的继续执行入口。

扩展探针要求“读取后保存成果”的两步任务；第一步真实工具被门控时发送新消息，并明确要求回应后继续原任务。旧工具释放、waitForIdle 返回后，模型总调用仍为 2（原决策和新回复），原任务继续决策 0 次，成果文件不存在，任务却保持 active。此结果只能证明档案未结束，不能证明 DL-101 的原任务独立延续。

待修复：让原任务拥有独立于旧回复的继续执行路径，携带相同 taskId、进度和实际结果，读取最新上下文后串行决策；不重做已发步骤、不续写旧回复、不新建重复任务。增加两步以上任务在新消息后继续完成的用例，不能仅断言 active 状态即收口。

### 4.2 R02：最新配置已读取，但每次 MCP 调用重启服务，导致会话状态丢失

位置：`agent-tools.ts:771`、775、806。

模型、MCP 环境和 Skill sourcePath 的更新用例通过。但 MCP 从“每执行一个客户端”改成每次调用都 connect／close，包括配置完全不变的调用。依赖同一连接或服务进程状态的工具无法继续原会话。

扩展探针使用真实 stdio 服务，工具 advance 对同一个进程内计数器递增。一个 execution 连续调用两次、期间完全不改配置，结果为 `["1","1"]`，而持续同会话应为 `["1","2"]`。这也会破坏服务保存的连接句柄或已打开对象，不能通过文件类无状态样例代表所有 MCP 工具。

待修复：配置未变时沿用原任务链客户端／服务；配置变更时按既定规则为后续调用切换，旧在途调用仍能收取结果，在无任务使用时释放。覆盖会话状态连续、变更后生效、关闭后的原链延续和链结束释放；不增加额外审批。

### 4.3 R07：手动维护入口已通，自动触发与连续失败退避仍未完成

位置：`memory-runtime.ts:197`、249、333；`memory-store.ts:388`、677。

空证据维护批次确实能够通过手动 runMemoryPending 调用模型，原探针因此通过。但自动路径仍只依据消息阈值／任务结束／已失败维护批次进行触发；首次出现候选时 `latestMaintenanceBatch` 为空，maintenanceRetryAt 返回空，没有对应触发或计时器。

扩展探针把旧事件推进至第 99 轮，再通过正式对话完成第 100 轮。此时已有一个精炼候选、只有两条新消息证据，不满足 30／50 条阈值；后台模型调用为 0、无维护批次、无触发。候选仍需未来消息凑阈值或用户手动触发，未达到原 R07 的独立自动维护要求。

此外，每次维护重试新建批次时 attempt_count 从 0 开始，失败后都为 1。连续两次失败的实测批次均为 attemptCount=1，而 maintenanceRetryAt 直接用该值索引退避表，所以失败次数不会跨批累积，自动重试始终停在第一档，不能递增到 2 分钟／10 分钟／1 小时。

待修复：首次候选可自动调度；模型选择暂不精炼时有适当后续检查而不紧密循环；连续失败跨批保留尝试进度，按既有退避增长，成功后正确结束失败观察。验证首次自动维护、暂不精炼、失败递增及与未达消息阈值的证据并存，不能靠手动调用替代。

### 4.4 R08：图节点入口检查通过，但异步 MCP 建连后缺少派发前复查

位置：`agent-graph.ts:309`；`agent-tools.ts:771`～775。

183 在模型轮及工具循环入口加入 checkTask，原“模型返回前结束任务”的场景通过。然而 mcpTool 在入口检查后还要 await connect，期间任务可以被正式 finishTask 结束；连接完成后直接 callTool，没有再次检查任务终态和执行有效性。

扩展探针在目录发现阶段使用正常连接，实际工具调用的新连接则等待门控。在连接尚未完成、callTool 尚未发出时结束任务，再释放建连门控；服务仍收到新工具调用并写入 late-result.txt，任务已是 completed。这是结束后新派发，不能按已发调用的晚到结果处理。

待修复：所有异步准备结束后，在实际派发边界重新核对任务与回复／决策有效性；已发调用继续保留结果，不取消重发。覆盖任务结束、新消息替代与连接／重连等待交错，保持业务调用身份及真实未派发状态一致。

### 4.5 关闭项与后续

R03 显式不完整消费、R04 状态补丁反馈、R05 默认整理请求协议、R06 纠错及摘要原文入口均通过本次代码核对、原探针和新增正式回归，关闭。R01、R02、R07、R08 保持未通过；基础场景通过只作部分修复证据。

本次只新增复验脚本、输出目录选项和记录，未修改业务源码、未本地提交或推送；仍使用离线模型、本地 MCP 和专用临时目录，无真实服务费用。下一步先补齐以上四项并分别记录实现方自验与独立复验，再推进完整 P2 验收。

## 5. 第二轮修复的独立复验与现场补正

2026-11-04，用户要求“开始复核修改”。先核对 183 第 11 节代码，重跑类型检查、101 项全量回归、原 10 个探针与 5 个扩展场景，均通过。其后补测 DL-71 中的模型开关边界，复现 R01／R02 的剩余情况；本节明确分列修改前的独立复验和修改后的自验。

### 5.1 第二轮修复的独立结果

| 检查 | 结果 |
| --- | --- |
| 类型检查 | `tsc --noEmit` 退出码 0 |
| 全量测试 | 101／101，0 失败、0 取消；`tests.log` |
| 原探针 | 10／10 `contractPassed=true`，无 `probeError`；`report.json` |
| 扩展探针 | 5／5 `contractPassed=true`，无 `probeError`；`extended-report.json` |
| 证据目录 | `backend/test-results/p2-05-final-review-20261104/`（Git 忽略） |

R01 的同一任务两步续行能够在新回复之后完成并保存成果；R02 在配置不变时返回 `["1","2"]`，跨续行保留 MCP 会话，配置变化与关闭 MCP 后原链续行用例通过。R07 的第 100 轮候选自动进入维护，未达阈值的消息仍待整理，连续失败计数为 1、2；R08 在异步建连后检查任务与执行有效性，不再派发已失效调用。结合代码核对与正式回归，**R07、R08 通过关闭，R03～R06 维持关闭**。

### 5.2 R01／R02：关闭模型后原任务续行仍被新任务门槛拦截

修改前位置：`conversation-service.ts:400` 的全局 `hasChatBinding` 检查、`:637` 的 `resolveChat`，以及只保存工具目录的任务缓存。

复现脚本：`backend/reviews/20261104-p2-05-model-continuation.ts`。原任务先真实读取文件，在下一次模型返回前发送新消息；新消息已完成回复后关闭对话模型，再释放原执行。实测模型调用停在 3 次，成果文件不存在，原任务保持 `active`，只有 `superseded`／`completed` 两次用户消息执行，没有 `tool_result` 续行。报告为前述证据目录中的 `model-continuation-report.json`，`contractPassed=false`。

原因：续行依赖当前启用的 chat binding；即使只取消调度门槛，续行开始时再次 `resolveChat` 仍会拒绝已关闭的原模型，且绑定切换后可能错误换用新任务的模型。DL-71 允许既有任务链保留资源直至结束，模型也在该规则范围内，因此这不是新的需求。

### 5.3 本轮补正与自验（不记为独立复验）

按用户“复核修改”的授权，本轮直接修正该遗漏，详见[183 第 12 节](183-p2-05-review-fix-record.md)：任务缓存同时保留原模型绑定，续行沿用该资源；新任务的模型开关检查放到新消息调度路径，停用模型不再拦住原任务续行。每次调用仍通过 `refresh` 读取该资源最新配置，任务链结束后一并释放缓存。

新增两项正式回归，分别停用模型资源和角色模型绑定；均在原任务释放前加入一条新消息，验证原任务继续保存成果、调用使用更新后的 baseUrl、仅一个任务、关闭后新消息未被处理。另原样重跑补充探针，调用数为 5、文件已保存、原任务 `completed`，三次执行为 `superseded`／`completed`／`completed(tool_result)`，链结束后新任务被开关阻止。

| 修改后自验 | 结果 |
| --- | --- |
| 类型检查 | 退出码 0；`typecheck.log` |
| 全量回归 | 103／103，0 失败、0 取消；`tests.log` |
| 原＋扩展探针 | 10＋5 全部通过，无 `probeError` |
| 模型续行探针 | 1／1 `contractPassed=true`；`model-continuation-report.json` |
| 证据目录 | `backend/test-results/p2-05-model-continuation-fix-20261104/`，含当前源码／测试／探针与依赖的 `source-manifest.json` |

修改前、后分别保存证据，没有覆盖失败报告。全部运行使用 P0 专用 Node 24.22.2、独立 backend 依赖、离线模型、本地 stdio MCP 和专用 TEMP／TMP／删除守卫，没有真实服务调用。本轮定向自验曾因新增测试误写 SQL 字段名失败，修正为实际 `processed_by_execution_id` 后全量通过，不将该探针错误算作产品缺陷。

**当前结论：已知缺口均已修正并通过当前自验；R01、R02 本轮新增补正尚待独立复验，故不宣布 P2-05 收口。** 复验无需重做已关闭项的设计讨论，应核对任务绑定保留、配置刷新、停用后新消息仍待处理及任务结束释放，再进入 P2-06 全量验收。真实模型、P3 自主活动、P4 强杀组合、P5 远程 MCP 与桌面页面仍未验证。本轮未提交、未推送。

## 6. P2-06 验收中的最后补正复验

2026-11-04，用户要求“开始做验收工作”。本次未修改业务源码，重跑类型检查、103 项回归和原 16 个探针全部通过；核对 183 第 12 节的模型缓存、调度和清理，并新增改绑场景验证 A 原任务与 B 新消息分别使用所属模型。关闭资源／绑定后的既有任务继续、配置更新、新消息隔离及链结束释放均通过，**R01／R02 通过关闭**。

完整 P2-06 矩阵、4 个新增离线组合场景、用户提供配置的真实 DeepSeek Anthropic 联调、证据目录和复现脚本见[184](184-p2-06-acceptance-report.md)。真实对话和 Skill→MCP 写入通过，真实记忆形成因提示词的复数标签键与固定单数标签契约不一致整批失败，**R05 重新打开**；连接测试因 16-token 输出限额误报，新增 **R09**。两个缺口已用实际响应及严格格式校验／额度对照定位，本轮没有修复源码，不能宣布 P2-05 或完整 P2 通过。

R03、R04、R06、R07、R08 保持关闭。下一步修复 184 第 5 节的两项阻断，定向复验并补齐真实事件形成与召回；已关闭项不重新讨论设计。未提交、未推送。
