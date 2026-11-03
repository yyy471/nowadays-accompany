# P0 独立复核记录

日期：2026-11-03。复核者：本次 Codex 复核会话，与 P0 源码实现／自验分开进行。

最新结论：**修正后的独立复验通过（P0 小样范围）**。R01～R04 已关闭：类型检查、11 个用例共 37 项检查、原复核探针 5 个场景和新增真实强杀恢复 4 个场景均通过，未发现阻止 P0 通过的问题。P0-05 完成，P1 尚未开始。

首轮结论为未通过：当时原有 35 项通过，补充 5 个边界场景均未满足契约，归并为下列 4 类问题。以下保留首轮证据，修正后证据见本文末尾“修正后的独立复验”。

本轮不修改 `src/` 实现、依赖或已确认需求；新增复核探针和本文，同步文档状态。未提交或推送。

## 范围与运行证据

- 对照 DL-53、DL-64～DL-67、DL-69、DL-70、DL-85、DL-101 和[开发文档 165](165-backend-development-guide.md)，阅读 P0 图、业务存储、MCP 客户端／执行器／服务器及相关用例。
- 复核对象为 `codex/p0-runtime-spike` 的未提交工作树，不能以当前分支 HEAD 代表源码版本；源码 SHA-256 清单保存在 `prototypes/p0/test-results/review-20261103/source-manifest.json`。
- 使用 P0 自带 Node.js 24.22.2、独立 `node_modules`、真实 LangGraph／SQLite／stdio MCP 和离线模型，未调用付费模型或真实 QQ。
- 类型检查退出码 0；原有 P0-01、C01～C08 共 9 个用例、35 项检查全部通过。复核汇总副本为 `prototypes/p0/test-results/review-20261103/independent-suite-summary.json`。
- 初次受限运行在 C03 强杀进程处停住，终止该次运行后，在允许该进程操作的环境重跑全套通过；未将受限运行计入通过结果。
- 补充探针为 [20261103-review.ts](../prototypes/p0/reviews/20261103-review.ts)；原始结果为 `prototypes/p0/test-results/review-20261103/review-1793689920596.json`，包含上下文、业务快照、事件、实际文件效果次数及恢复错误。运行产物被 Git 忽略，探针与本摘要用于重新复现。

在 `prototypes/p0` 下使用 PowerShell 复现：

```powershell
& './.runtime/node-v24.22.2-win-x64/node.exe' node_modules/typescript/bin/tsc --noEmit
& './.runtime/node-v24.22.2-win-x64/node.exe' node_modules/tsx/dist/cli.mjs src/cases/run-all.ts
& './.runtime/node-v24.22.2-win-x64/node.exe' node_modules/tsx/dist/cli.mjs reviews/20261103-review.ts
```

探针每次创建新的 `data/review-<时间戳>-*` 目录，不清除原有用例。它是故障复现／采集脚本，退出码 0 表示采集结束；应检查 JSON 中各项 `contractPassed`，不能将退出码误当作契约通过。

## P0-R01［P1］被替代的旧决策仍能发起新工具调用

位置：[build.ts 的模型返回处理](../prototypes/p0/src/graph/build.ts:73)、[工具登记与执行](../prototypes/p0/src/graph/build.ts:119)。

复现：旧模型调用阻塞，保存新消息并将旧执行标为 `superseded`，新决策完成后再释放旧模型，让其返回一个尚未发起的 `append_note` 请求。

实际：旧执行仍登记并调用真实 MCP，文件写入 `superseded-side-effect`，`append_note` 效果次数为 1；直到正式提交时才因 `EXECUTION_NOT_RUNNING:superseded` 被拒绝。保护最终提交无法阻止已经发生的过期操作。

依据 DL-69、DL-101，原已发工具继续返回并保存，新决策决定任务后续；迟到的旧思考不能自行启动下一步。修正应在模型返回接纳、工具登记／派发边界检查执行有效性，保留已发调用的真实结果。复验需证明旧请求产生 0 次新副作用，同时原已发调用仍正确保存，不因切换重发。

## P0-R02［P1］业务保存领先检查点时，恢复无法继续

位置：[executeTool](../prototypes/p0/src/graph/build.ts:144)、[markToolCallRunning](../prototypes/p0/src/storage/business.ts:442)、[commitTurn](../prototypes/p0/src/storage/business.ts:571)。

复现以事件回调抛出故障，精确停在业务保存已成功、节点尚未返回形成新检查点的窗口；关闭并重开两份数据库，以原 `thread_id` 执行 `invoke(null)`。这是节点故障注入，不宣称补做了该窗口的操作系统强杀测试。

| 故障位置 | 恢复时下一节点 | 实际结果 |
| --- | --- | --- |
| `tool_result_saved` 事件 | `execute_tool` | 业务结果已为 success；重进节点仍调用 pending→running，抛出 `TOOL_CALL_NOT_PENDING`，执行停在 running，后续回复无法完成 |
| `completed` 事件 | `commit_reply` | 正式回复和状态已原子提交；重进节点抛出 `EXECUTION_NOT_RUNNING:completed`，无法正常结束图 |

两条路径工具效果均为 1，**没有复现重复执行或重复提交**；问题是业务状态与图进度之间缺少可恢复的衔接。不能通过删除现有状态保护、重置 pending 或无条件重发解决。

依据 DL-64～DL-67、DL-85，应让重入节点读取并复用已保存的操作结果／提交结果，使图推进；running 且无确认结果时按未知结果规则处理。稳定关联同一逻辑步骤和调用，避免登记节点重入后生成无法对应的新操作。先用本探针复验，再补真实进程中断验证；不将此基础恢复问题仅留到 P4。

## P0-R03［P1］恢复到模型节点时沿用旧上下文

位置：[modelNode](../prototypes/p0/src/graph/build.ts:68)。

复现：利用 LangGraph 的 `interruptBefore: ["model"]` 在上下文已保存、模型尚未调用时暂停；将角色更新到版本 2（`tone=new-tone`、`mood=new-mood`），关闭并重开运行时，以原执行恢复。

实际：检查点下一节点为 `model`，恢复不会再经过 `load_context`；模型读取 `state.context` 中版本 1 的 `tone=calm`、`mood=neutral`，并据此提交回复。此处证明的是新判断使用过期资料，未声称本探针已造成最新角色状态回退。

依据 DL-67、DL-85，刷新不能只依赖图恰好经过某个加载节点。每次恢复后的新模型判断／后续调用需重新获取或校验当前业务上下文，保留已完成进度。复验应让该边界读到版本 2，同时保留原 C05 的通过结果。

## P0-R04［P1］调用已发出后断连被直接归为明确失败

位置：[executor.ts 错误分类](../prototypes/p0/src/mcp/executor.ts:73)、[图的未知结果分支](../prototypes/p0/src/graph/build.ts:166)。

复现：真实 MCP 执行 `append_note_then_hang`，观察到文件已写入后关闭 stdio 连接，模拟响应返回前失联；探针提供了核查回调。

实际：效果次数为 1，收到 `MCP error -32000: Connection closed`；执行器将其包装为 `ToolExecutionFailedError`，业务记录为 failed，核查回调调用次数为 0。仅超时被识别为 unknown，连接中断绕过核查。

依据 DL-53、DL-70 和 C06，已派发但失去响应的调用不能仅因连接关闭判定为明确失败。应区分明确工具错误、发出前失败及发出后结果未知；后者进入核查，无法核实则保留 unknown。复验同时覆盖可核查成功、不可核查 unknown 以及 C08 明确错误仍为 failed，且不重复副作用。

## 首轮处置与复验边界（历史记录）

| 项目 | 状态 |
| --- | --- |
| 原有自验结果独立重跑 | 通过，35/35 |
| 新增边界契约检查 | 未通过，5 个场景，4 类问题 |
| 实现修正及修正后复验 | 未进行 |
| P0 阶段结论 | 未通过，等待修正和复验 |
| P1 及后续阶段 | 尚未开始 |

166 中原有自验结论继续保留，但不能外推为全部恢复时序通过。其“连接中断后续补齐”和“业务保存与检查点之间崩溃窗口留 P4”不构成这些已确认基础契约的验收豁免。

C07 提交失败后部分文本持久化、真实模型、正式调度器、完整记忆、Skill、桌面打包等原有限制仍单列；首轮没有替这些能力作通过结论，也未新增产品决定。首轮安排为先修正并记录实现方自验，再进行独立复验；结果如下。

## 修正后的独立复验（2026-11-03）

本次独立检查实现方已提交到工作树的修正，未修改 `src/` 实现或依赖。新增[真实强杀探针](../prototypes/p0/reviews/20261103-crash-review.ts)，补齐首轮指出的真实进程故障证据；未提交、推送或启动 P1。

### 复验结果

| 问题 | 独立复验结果 | 状态 |
| --- | --- | --- |
| R01 过期决策派发新工具 | `superseded-tool` 不产生调用或文件效果；旧执行返回 `EXECUTION_NOT_RUNNING:superseded`。原 C04 的已发工具仍保存成功，效果 1 次 | 已关闭 |
| R02 业务与检查点保存间隙 | 原工具结果／正式提交重入探针无错误；C09 的 running 无结果记录保留 unknown，C10 登记重入复用原调用。额外 4 个真实强杀场景均完成恢复，见下表 | 已关闭 |
| R03 模型节点恢复使用旧资料 | `latest-context` 恢复时模型读到版本 2、`tone=new-tone`、`mood=new-mood`；原 C05 仍通过 | 已关闭 |
| R04 断连误判明确失败 | `connection-loss` 的已发生效果为 1 次、核查调用为 1 次、结果为 unknown；原 C06 可核查分支仍补 success，不可核查分支仍为 unknown，C08 明确工具错误仍为 failed | 已关闭 |

类型检查退出码 0；`p0:all` 11 个用例、37 项检查全部通过；原复核探针 5/5 `contractPassed: true`。这些为本次重新执行结果，与 166 中实现方复验分别记录。

### 真实进程强杀补验

探针在业务节点内用同步屏障阻止其返回；父进程收到持久化状态后，以 `taskkill /PID <测试子进程 PID> /T /F` 强杀自身创建的测试进程树。之后启动新进程，以原数据库及执行编号 `invoke(null)` 恢复。没有借用手动异常模拟强杀结果，也没有重置业务状态。

| 强杀边界 | 新进程恢复的实际结果 |
| --- | --- |
| 工具登记已保存，节点尚未返回 | 复用原 toolCallId，只产生 1 条调用、1 条结果；工具效果 1 次，最终成功 |
| 工具 success 结果已保存，节点尚未返回 | 发出 `tool_result_reused`，不重发工具，最终成功 |
| 正式回复／状态已提交，节点尚未返回 | 复用已提交结果，图正常结束；正式回复仍仅 1 条，角色版本仍为 2 |
| MCP 已产生效果，结果尚未写入业务库 | 保留原调用并保存 unknown，效果仍为 1 次，不重发；本场景未提供核查器，不冒称核查成功 |

4 个场景均只有 1 次实际工具效果、1 条调用、1 条结果、1 条正式回复，角色状态版本为 2，恢复后图无下一节点。本表只覆盖明确列出的 Windows 本地小样时序，未扩展为全部平台或正式调度器验证。

### 证据与复现

- 运行环境：Windows 本机，Node.js 24.22.2，其余依赖沿用 166 的锁定版本。
- 源码为未提交工作树；本次 SHA-256 清单：`prototypes/p0/test-results/re-review-20261103/source-manifest.json`。
- 本次原有用例汇总：`prototypes/p0/test-results/re-review-20261103/independent-suite-summary.json`。
- 原复核探针本次报告：`prototypes/p0/test-results/review-20261103/review-1793691253563.json`。
- 真实强杀本次报告：`prototypes/p0/test-results/re-review-20261103/crash-review-1793691328588.json`，含强杀前业务快照、恢复前后记录、事件与效果次数。

按前文命令完成类型检查、用例和原探针后，在 `prototypes/p0` 下补跑：

```powershell
& './.runtime/node-v24.22.2-win-x64/node.exe' node_modules/tsx/dist/cli.mjs reviews/20261103-crash-review.ts
```

真实强杀探针以断言检查结果，失败时退出非零；每次创建独立数据目录，不覆盖历史证据。执行环境需允许强杀自身测试子进程树。

最终结论：**P0 小样通过修正后的独立复验**。可据此进入 P1 的数据和 API 契约准备；本次未开始 P1。166 所列 C07 部分文本持久化、正式调度器、真实模型、记忆、Skill、桌面打包等后续范围继续保留，不能据此宣称整个后端已完成。P4 仍需验证正式实现的组合恢复，但上表 4 个小样窗口已获得独立强杀证据。

本次复验之外的一次独立重跑另登记 9 项意见，原始内容及合理性核对分别见[文档 168](168-p0-followup-fix-list.md)第 2～6 节、第 7 节；不能将原始意见全部视为已复现缺陷。正式任务、前／后台记录及工具结果映射需在相关契约或模块落地前定清，不意味着所有 P1 工作均被阻止；不复开本文 R01～R04 的已关闭结论。
