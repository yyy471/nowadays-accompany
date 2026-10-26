# 87 EXT-D Agent 组合与工具循环执行记录

范围：`devDoc/79-agent-extension-execution-plan.md` 第 9 节的 EXT-D 包，验收项取自
`devDoc/80-agent-extension-acceptance.md` 的 A/T/M/L 行。本轮交付 D-A、D-B、D-C；D-D（插件钩子接入）
与 D-E（端到端复验）尚未实施。所有结论只来自类型检查与 Vitest 自动化，没有真实 QQ 消息、没有付费模型调用。

## 1. 交付状态

| 子项 | 内容 | 状态 |
| --- | --- | --- |
| D-A | 删除 `ReplyMode`/`replyModeFor`/插件宿主互斥与 `src/host/worker.ts`，内置 Agent 成为唯一回复者；页面与配置去掉回复模式 | 已完成 |
| D-B | 契约补 `assistant.tool_calls` 与 `tool_call_id` 配对；OpenAI 适配器序列化并在发送前拒绝协议非法的 tool 消息 | 已完成 |
| D-C | 工具循环、预算、统一执行器接入、内置媒体工具改走执行器、每账号插件 Worker 归属 | 已完成 |
| D-D | `beforeContext` 带来源注入实际上下文、`afterTurn` 收到真实发送结果、钩子预算 | 未开始 |
| D-E | A01～A06 / T04/T05/T07/T09 / L07 的端到端复验与放行结论 | 未开始 |

## 2. 代码地图（行号在当前工作树核对）

| 位置 | 责任 |
| --- | --- |
| [src/agent/engine.ts:51](../src/agent/engine.ts#L51) | `AGENT_TOOL_BUDGET`：4 次模型调用 / 3 个工具回合 / 4 次工具调用 |
| [src/agent/engine.ts:57](../src/agent/engine.ts#L57) | `AgentToolRunner` 端口：`view` + `executeBatch`，由 Core 注入 |
| [src/agent/engine.ts:127](../src/agent/engine.ts#L127) | 内置生图/语音声明改为 `effect: 'action'` 并补 `maxLength` |
| [src/agent/engine.ts:482](../src/agent/engine.ts#L482) | `#chatTurn` 预算循环：目录读取、协议消息追加、单条最终回复 |
| [src/agent/engine.ts:610](../src/agent/engine.ts#L610) | `#builtinToolHandlers`：按 turn 注入内置媒体 handler（需要当前消息的交付与取消边界） |
| [src/agent/engine.ts:1047](../src/agent/engine.ts#L1047) | `protocolToolCall`：缺 ID 的调用先确定 `turnId:r{round}:c{index}` 再进协议 |
| [src/agent/engine.ts:1058](../src/agent/engine.ts#L1058) | `toolResultText`：状态/错误码/媒体/数据/截断的有限渲染，不泄漏栈与密钥 |
| [src/extensions/execution/executor.ts:79](../src/extensions/execution/executor.ts#L79) | `ToolViewProvider` 允许返回 Promise，动作前复核可实时读策略 |
| [src/extensions/execution/executor.ts:89](../src/extensions/execution/executor.ts#L89) | 可注入共享 `limiter`；`close()` 只关闭自己创建的额度（:448） |
| [src/extensions/execution/executor.ts:118](../src/extensions/execution/executor.ts#L118) | `ToolBatchContext.extraHandlers`，解析顺序见 :575 |
| [src/application/extensions/extension-tool-service.ts:39](../src/application/extensions/extension-tool-service.ts#L39) | 每账号一个执行器 + 一份共享并发额度；`view` 见 :62，批入口见 :73 |
| [src/application/extensions/plugin-runtime-service.ts:23](../src/application/extensions/plugin-runtime-service.ts#L23) | 每账号插件 Worker 归属、按账号串行同步、关闭后拒绝重建（:35、:79） |
| [src/application/extensions/extension-policy-service.ts:60](../src/application/extensions/extension-policy-service.ts#L60) | `readyPlugins`/`readyTools` 改为按账号回调（:89 传入 accountId） |
| [src/host/contract.ts:43](../src/host/contract.ts#L43) | 消息上下文携带 `roleBinding.contextEpoch`，实例在 [src/instances/instance.ts:694](../src/instances/instance.ts#L694) 透传 |
| [src/core/core.ts:1154](../src/core/core.ts#L1154) | 账号最后一个租约释放时关闭该账号插件 Worker |
| [src/storage/atomic-write.ts:54](../src/storage/atomic-write.ts#L54) | Windows 共享冲突下的有界复名重试（只对 `EPERM/EACCES/EBUSY`，4 次上限） |
| [src/core/core.ts:1179](../src/core/core.ts#L1179) | 宿主代际创建前同步该账号插件 Worker；:1199 注入 `tools`；:361 关闭顺序 |
| [src/bootstrap/assemble-runtime.ts:336](../src/bootstrap/assemble-runtime.ts#L336) | 构造 `pluginRuntimes` → `extensionPolicy` → `extensionTools` 并接线能力复核回调 |
| [src/providers/adapters/fake.ts:236](../src/providers/adapters/fake.ts#L236) | `continuingRound`：脚本化 `toolCall` 只在一轮的首个请求触发，循环可终止 |

## 3. 运行时语义

- 单一宿主：`replyMode` 已从策略、路由、状态与页面删除；配置或档案变化统一重建宿主并递增 `hostEpoch`，
  旧宿主晚到的发送与状态写入仍按代际拒绝。
- 循环形状：每次迭代先复核 `isRoleBindingCurrent()`，再决定本轮是否附带工具清单。最后一次模型请求
  （第 4 次）不再提供工具；模型在没有工具的清单项里返回调用会被忽略，只取文本。
- 预算：`usedToolCalls` 按模型返回的调用条数累加，不看执行结果——预检整批拒绝同样吃掉预算；
  批上限继续由执行器的 `remainingCalls` 与 `maxCallsPerBatch` 约束。
- 协议消息：assistant 的 `tool_calls` 与其后配对的 `tool` 消息只追加进本轮的临时 `messages` 数组；
  持久历史仍只有入站消息与实际发出的回复，工具协议不会进入下一轮对话。
- 一次回复：中间 assistant 文本不发送；一轮只产出一个 `OutboundMessage`。无最终文本时按顺序回落到
  `suffixNote` → 最近一次 `submitted` 的安全提示 → 首次有限拒绝理由 → 静默。`markExtractable` 只在零工具回合、
  无媒体观察、无后缀说明的纯文本轮触发。
- 目录读取只在当前对话模型能吃工具时发生；账号档案不可解析时降级为“本轮没有工具”，文字对话继续正常回答。
- 可执行清单：来自 `resolveEffectiveExtensions`（含 `handlerReady`，即该账号 Worker 的握手结果），
  与页面展示同一解析；执行器在预检、排队后、副作用前与 handler 提交点各复核一次，撤权或换版时
  未开始的动作副作用为 0。
- 内置媒体：`generate_image`/`generate_speech` 不再是引擎硬编码分支，而是按 turn 注入的执行器 handler，
  复用原 `MediaJob` 提交、`actionId`、交付 guard 与通道边界；返回 `submitted` + jobId，动作 ID 在调用账本
  与任务服务两层去重。显式 `/draw` 命令路径未改动。
- 目录不可读时只失去工具：档案解析失败按“无工具”继续文字对话并记录告警，不让整轮失败。

## 4. 验收映射

| ID | 结果 | 证据 |
| --- | --- | --- |
| T03 | 通过 | 同响应两条调用按原顺序进入 assistant 消息并各有配对结果（`agent-tool-loop` 第 1 项） |
| T04 | 通过 | 续答请求含真实 `tool_calls` 与配对 `tool_call_id`，工具数据被后续回合读到 |
| T05 | 通过 | 中间文本不提前发、只有一条最终回复；结果作为 tool 来源数据回灌 |
| T07 | 通过 | 4 次模型调用上限、3 个工具回合、最后一次不给工具清单、整批 4 条调用后收口；未知工具拒绝仍计入预算；缺 callId 时 ID 确定 |
| T09 | 通过 | 模型不支持工具时请求不带 `tools`，工具执行为 0，正常文本回复 |
| M01 | 通过 | 账本记录 `submitted` 且带 jobId，回复文本不声称已发送；交付仍由任务通道完成 |
| M02 | 通过 | 后续回合重复同一动作 ID 时只有一次真实生成；服务方跨会话复用同名 callId 时不再互相压掉（两个会话各 1 个任务、共 2 次生成）；MediaJob 回调重复的既有测试继续通过 |
| A03 | 部分 | 一轮仍只有一条最终回复，工具拒绝也有有限说明；`beforeContext`/`afterTurn` 的真实结果通知属 D-D |
| A01 | 部分 | 已安装插件的账号仍由 Agent 编排、角色/世界书/记忆继续进入请求；钩子补充数据未接入（D-D） |
| A02 | 通过（回归） | 无角色绑定/暂停/解绑路径的既有断言全部继续通过，工具不再提供绕过入口 |
| A05 | 通过（回归） | 插件无发送端口、不能改回复归属；回复模式相关测试已删除而非改写放行 |
| T01/T02/T08 | 未新增 | EXT-B 既有证据继续通过；本轮没有改动这些门槛，只把 Agent 接到执行器上 |
| L07 | 部分 | 关闭顺序为执行器有界排空后再停 Worker；插件 Worker 不响应 abort 的终止已由 EXT-C 测试覆盖，端到端退出复验留给 D-E |
| W/C/P/S/U | 不涉及 | 属 EXT-C/E/F/G 范围 |

## 5. 独立复核与修复

独立复核由只读子代理完成，逐条按当前代码核对后处理。复核同时确认了这些点没有问题：预算上下界与
“拒绝也计入”；撤权/换版在预检、排队后、账本写入后、副作用前四次复核下无法触达副作用；异步 `view` 的
每个调用点都有捕获且兼容同步 fake；共享额度租约在 `finally` 释放、注入额度不被单个账号执行器关闭；
工具协议消息只存在于临时消息数组、不进入历史；一轮只发一条 `OutboundMessage`；`markExtractable` 只在纯文本轮。

| 编号 | 级别 | 发现 | 处理 |
| --- | --- | --- | --- |
| D4-1 | P1 | 目录改为实读档案后，档案不可解析会让整轮文字回复一起失败（`#chatTurn` 未包裹 `view`） | try/catch 降级为“本轮无工具”；`supportsTools` 为假时根本不读目录；新增用例断言仍能回复 |
| D4-2 | P1 | `PluginRuntimeService.close()` 不进账号链，在途 `sync` 可在 close 返回后注册 Worker，留下孤儿线程 | 关闭改为经该账号链排队（[plugin-runtime-service.ts:75](../src/application/extensions/plugin-runtime-service.ts#L75)），配合关闭标记双检查 |
| D4-3 | P1 | 实例释放账号后其插件 Worker 常驻到进程退出 | `releaseAccount` 在该账号最后一个租约释放时关闭运行时（[core.ts:1154](../src/core/core.ts#L1154)）；下次上线按新代际重新同步 |
| D4-4 | P2 | 模型吃完预算却没写收尾、且无 `submitted` 时静默吞掉这条消息，与 A03“一次最终文本回复”不符 | 记录有限的拒绝理由作兜底（[engine.ts:534](../src/agent/engine.ts#L534)、:600、:606），新增用例 |
| D4-5 | P2 | 动作 ID 直接用服务方 callId（常见 `call_1`），跨会话同名会互相压掉，并把别的会话的 jobId 回灌给用户 | `actionKey` 加 `kind/peer` 作用域；新增两个会话同 callId 的用例，断言 2 个任务、2 次真实生成 |
| D4-6 | P2 | `ExtensionToolService` 的 `view` 与关闭短路都不校验账号/会话配对 | 两个入口都先抛 `IsolationError`，不再出现“用错账号也能拿到目录” |
| D4-7 | P3 | 为不存在的需求把 `ToolBatchContext.signal` 改成可选，留下无人走的条件分支 | 回退为必填并删除分支 |
| D4-8 | P3 | `PluginToolRuntimePort.readyTools()` 无调用方；引擎预算与执行器批上限是两个独立数字 | 端口只保留 `handlers()`；新增用例锁定 `maxToolCalls === maxCallsPerBatch` |
| D4-9 | P2 | 全量 3 次里 2 次在 `memory-runtime` G04 复名 `role-bindings.json` 时 `EPERM`：工具门复核提高了同文件读取频率，把既有 Windows 共享冲突放大 | 原子写只对共享冲突类错误做 4 次有界退避重试（[atomic-write.ts:54](../src/storage/atomic-write.ts#L54)），其他错误原样抛出；新增“重试后落盘”“有界放弃并清理临时文件”用例，既有队列恢复用例改用非共享冲突错误码 |


## 6. 边界与已知未做

1. 插件钩子还没有接入：`beforeContext` 的补充数据不进实际上下文，`afterTurn` 收不到真实发送结果，
   钩子预算（500ms/2s）未实施；这是 D-D 的内容。`PluginRuntimeService` 只提供 Worker 归属，钩子调用点尚未接。
2. `providers/router.availableTools` 仍硬编码 `handlerReady: true`，只服务 Skill 解析与内置媒体的交付复核；
   页面展示与执行共用同一份有效状态解析需要在 EXT-F/G 收口。
3. 每次动作前复核都会重读账号档案（无插件时 1 次文件操作/门，有插件时随插件数线性增长）。这是选择
   “实时撤权可见”而非“事件缓存可信”的直接代价，目前未做缓存，也未观察到测试时延回归。
4. `submitted` 之后模型续答若自称“图片已发送”，本轮不做文案检测：M01/L07 约束的是宿主自己发出的消息与
   交付通道，模型文案不在承诺范围内。
5. 工具循环只覆盖 `#chatTurn`；视频续答、识图观察与 `/draw` 命令保持原路径，避免在同一步里重写媒体框架。
6. `ExtensionToolService` 的执行器与调用账本按账号常驻，进程内不回收（与既有消息存储句柄同语义）；
   插件 Worker 已改为在该账号最后一个实例租约释放时关闭。
7. `ToolExecutor.drain()` 与 `active` 目前只有测试与 EXT-B 既有证据在用，生产关闭走 `close()` 的有界排空；
   `ToolBatchContext.runtimeGeneration` 尚未由引擎填写，等 D-D 接入插件代际后一起收口。
8. 复核门为拿到实时授权，每次都会重读账号档案；本轮没有引入缓存，也没有为此增加配置开关。

## 7. 验证证据

命令均在 `D:\app\nowadays\accompany` 执行，输出保存在 Git 忽略的 `test-results/`。

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 通过（无输出），`test-results/tc5.txt` |
| `npx vitest run test/agent-tool-loop.test.ts test/atomic-write.test.ts` | 2 文件 20 项通过（工具循环 13 项、原子写 7 项），`test-results/ext-d-c-run7.txt` |
| `npx vitest run test/agent-tool-loop.test.ts test/tool-executor.test.ts test/extension-runtime.test.ts test/extension-policy.test.ts test/memory-tools.test.ts test/phase1-agent.test.ts test/phase1-adapters.test.ts` | 7 文件 118 项通过，`test-results/ext-d-c-targeted.txt` |
| `npx vitest run`（D-C 改造后，复核修复前） | 1006/1007 项通过、1 跳过；失败为 `memory-runtime` G04 的 `EPERM` 复名 |
| `npx vitest run test/memory-runtime.test.ts`（隔离复跑） | 18 项通过 |
| `npx vitest run`（复核与原子写修复后，连续三次） | 107 文件全通过，各 1011 项通过、1 项既有跳过，`test-results/ext-d-c-full4.txt`、`ext-d-c-recheck1.txt`、`ext-d-c-recheck2.txt` |

`EPERM` 的成因与处置见 D4-9：Windows 上并发读者持有目标文件句柄时复名会失败，工具门复核提高了读取频率
从而放大了这个既有缺陷；修复放在原子写层，只重试共享冲突类错误码，其余错误保持原样抛出。修复前三次全量
出现两次，修复后连续三次全量无失败。

未提交、未打包、未替换发布 EXE；`devDoc/` 与 `README.md` 的文档更新留在工作树等待复核。
