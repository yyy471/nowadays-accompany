# P0 技术小样实施记录

日期：2026-11-03。

状态：**P0-01～P0-05 完成，R01～R04 及后续 L01／L03／L06 修正均通过独立复核（P0 小样范围）；其余条目按 168 第 7 节不修改实现或留待 P1／P4，P1 尚未编码。** 首轮证据见[167](167-p0-independent-review.md)，最新独立证据见[168 第 9 节](168-p0-followup-fix-list.md)；本文保留原自验与修正记录，不新增产品需求。

需求依据为[持续决策记录](161-digital-life-direction-decisions.md)第 DL-53、DL-64～DL-67、DL-70、DL-77、DL-78、DL-85、DL-101、DL-128 条，工作包见[开发文档 165](165-backend-development-guide.md)。运行说明见[prototypes/p0/README.md](../prototypes/p0/README.md)。

## 工作包及范围

- 编号：P0-01～P0-05。
- 实现状态：P0-01～P0-04 实现方自验完成；P0-05 首轮及后续问题修正后均通过独立复核，最新快照包含 168 的 L01／L03／L06 修改。
- 依据的 DL 决定：DL-53、DL-64、DL-65、DL-66、DL-67、DL-70、DL-77、DL-78、DL-85、DL-101、DL-128。
- 源码提交与运行环境：分支 `codex/p0-runtime-spike`；用户已要求本轮复核通过后做一次本地提交，源码版本以包含本记录的 Git 提交为准，提交前验证摘要见 168 第 9 节。运行环境为 Windows 10.0.26200 x64、Node.js 24.22.2（ABI 137）、npm 11.19.1；`prototypes/p0/package-lock.json` 为 lockfileVersion 3。

> 说明：本机 PATH 默认 Node 为 20.19.4；`better-sqlite3@12.10.0` 只提供 Node 22/24 的 Windows 预编译包，Node 20 安装会回退到本地 node-gyp 并因缺少 Visual Studio 失败。因此证据使用工作区内临时下载的 Node 24.22.2（`.runtime/`，不提交）。这不改变已确认架构，属于 DL-128 允许的依赖与运行时候选验证。

## 实现与运行

### 实际依赖及版本

| 依赖 | 版本 |
| --- | --- |
| Node.js | 24.22.2（ABI 137） |
| npm | 11.19.1 |
| @langchain/langgraph | 1.6.0 |
| @langchain/core | 1.3.4 |
| @langchain/langgraph-checkpoint-sqlite | 1.1.0 |
| @modelcontextprotocol/sdk | 1.32.2 |
| better-sqlite3 | 12.10.0 |
| zod | 4.6.7 |
| typescript | 5.9.3 |
| tsx | 4.23.15 |

### 安装、启动及验证命令

在 `prototypes/p0` 下：

```bash
npm install
npm run typecheck
npm run p0:all
```

本次实际使用的 Node 24 安装命令：

```bash
PATH="$PWD/.runtime/node-v24.22.2-win-x64:$PATH" \
  ./.runtime/node-v24.22.2-win-x64/node.exe \
  ./.runtime/node-v24.22.2-win-x64/node_modules/npm/bin/npm-cli.js install
```

实际运行整套用例：

```bash
./.runtime/node-v24.22.2-win-x64/node.exe \
  node_modules/tsx/dist/cli.mjs src/cases/run-all.ts
```

### 实现结构

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 业务存储 | `src/storage/business.ts` | SQLite 表：role、message、execution、task、tool_call、tool_result、decision、late_output；正式回复、状态和完成标记同一事务提交 |
| LangGraph | `src/graph/build.ts`、`src/graph/state.ts` | `load_context → model →（工具登记/执行）→ pause_gate → load_context → commit_reply`；执行编号即 `thread_id` |
| 离线模型 | `src/model/scripts.ts`、`src/model/barrier.ts` | 确定性脚本，按 `turn` 返回工具请求或最终文本；C04 用屏障控制迟到输出 |
| MCP 样例 | `src/mcp/server.ts`、`src/mcp/client.ts`、`src/mcp/executor.ts` | 真实 stdio 连接；确定性文件写入、读取、效果计数；超时和未知结果处理 |
| 用例控制器 | `src/cases/*.ts`、`src/cases/runner.ts` | 逐用例运行；C03 用子进程强杀/重启验证跨进程恢复 |
| 汇总 | `src/cases/run-all.ts`、`src/cases/report.ts` | 依次运行 P0-01 与 C01～C10；生成 `runId` 并校验各报告归属，写 `data/p0-summary.json` |

### 保存与恢复顺序

- 输入消息先写入业务库，再创建执行并调用图。
- 工具调用先写 `tool_calls`（pending），再标记 running，真实 MCP 返回后先写 `tool_results`，再更新调用状态，最后回到图。
- 正式回复、角色局部状态和完成标记在 `commitTurn` 的同一事务中提交；提交成功后才发出 `completed` 事件。
- 检查点保存在独立的 `execution.sqlite`；业务库保存正式记录。恢复时图节点重新读取业务库，而不是把旧检查点状态整份回写。
- 工具结果未知时先核查；核查成功补 success，无法确认保留 unknown，不重发。
- 新消息切换时旧执行标记 `superseded`；已输出部分保存为 `interrupted` 消息，迟到文本写入 `late_outputs`，旧提交被拒绝。

## 实现方自验

### 结论

`run-all` 在 2026-11-03 运行，退出码 0，`data/p0-summary.json` 中 `ok: true`；11 个用例、38 个检查项、0 个失败。完整报告位于各用例 `data/<case>/report.json`，报告内的 `runId` 与本次汇总一致。其中 C09／C10 为复核后新增的恢复边界回归用例；P0-01 增加 MCP 结果适配检查。

| 用例 | 检查项 | 关键实际结果 |
| --- | --- | --- |
| P0-01 | 4/4 | 业务 SQLite 事务回滚与重开、LangGraph 检查点重开、stdio MCP 调用/重连均通过；MCP 结果适配覆盖 JSON 文本、普通文本、structuredContent、其他内容、空内容及 isError；依赖版本见上表 |
| P0-C01 | 3/3 | MCP 文件实际写入 `P0-C01`；工具调用 1 次；回复“工具状态=success。”；执行 completed、状态版本 2、task completed、工具结果保存时间不晚于执行完成 |
| P0-C02 | 3/3 | 暂停时执行 paused、工具结果已保存；恢复后执行编号不变、工具效果仍为 1、回复“同次恢复后工具状态=success。” |
| P0-C03 | 3/3 | 暂停子进程报告 checkpoint 6 条后被强杀；新进程恢复后 checkpoint 10 条、执行编号不变、工具效果仍为 1、回复“重启恢复后工具状态=success。” |
| P0-C04 | 7/7 | 旧回复输出“旧回复第一段。”后阻塞；新消息完成“新回复：已收到新消息。”；旧执行 superseded，部分消息 interrupted；迟到“旧回复第二段。”只进入 late_outputs，未写入消息；状态 `lastReply=new`；旧工具效果仍为 1 |
| P0-C05 | 6/6 | turn 0 决策快照读到 tone=calm、mood=neutral、stateVersion=1；暂停期间改为 tone=calm-v2、mood=calm、energy=40；turn 1 决策快照读到新值；最终角色版本 3，`state_version_loaded=2`、`state_version_committed=3`，mood 仍为 calm，旧快照未回退 |
| P0-C06 | 3/3 + 3/3 | 效果已发生但响应超时；verify 分支通过 readback 补 success（reconciled=true），unverifiable 分支保留 unknown（RECONCILE_UNAVAILABLE）；两分支工具效果均只有 1 次 |
| P0-C07 | 3/3 | 提交注入 `INJECTED_COMMIT_FAILURE`；事务回滚后执行仍 running（由控制器标记 failed）、无 assistant 消息、状态版本仍 1、task 仍 active；工具调用和结果保留为 success |
| P0-C08（补充） | 1/1 | 越界路径触发 `PATH_OUTSIDE_WORKSPACE`，工具调用和结果均记录为 failed，区别于 C06 的 unknown；最终回复仍按实际失败状态提交 |
| P0-C09（复核补充） | 1/1 | 工具调用已登记并处于 running、但没有已保存结果时，恢复不重发；按 unknown 记录并完成回复，工具效果为 0 |
| P0-C10（复核补充） | 1/1 | 工具已登记但检查点未落时重入，按 step_key 复用同一 tool_call_id；工具仍只执行一次，最终回复 success |

### 自验中发现并修正的问题

1. **Node 20 无法安装候选 SQLite 驱动**：`better-sqlite3@12.10.0` 没有 Node 20 ABI 115 的 Windows 预编译包，安装回退到 node-gyp 并失败。改用 Node 24.22.2 后安装与加载成功；记录为运行时要求，不改变架构。
2. **C03 强杀后立即打开 SQLite 出现短暂 `SQLITE_IOERR_TRUNCATE`**：强杀进程后的文件句柄释放时序导致。处理为暂停子进程自己统计检查点数后上报，恢复进程退出后再由父进程核对；业务库/检查点库打开带有限次重试。重试只处理文件句柄释放，不改变业务语义。
3. **C04 兜底计时器拖住进程退出**：15 秒 `Promise.race` 兜底计时器未清理，导致用例耗时约 16 秒。对计时器调用 `unref()` 后，C04 单独运行约 1.1 秒，整套约 18 秒。

### 首轮独立复核问题修正与实现方复验（2026-11-03）

首轮独立复核见[文档 167](167-p0-independent-review.md)，结论为未通过，归并 4 类 P1 问题。本次修正如下，均未新增产品决定：

| 问题 | 修正 | 实现方复验 |
| --- | --- | --- |
| R01 被替代的旧决策仍能发起新工具调用 | 模型返回工具请求后、工具登记前、实际派发前都检查执行状态；过期执行不登记、不派发；已经发出的调用仍按原调用保存结果 | 复核探针 `superseded-tool`：工具效果为空、旧执行以 `EXECUTION_NOT_RUNNING:superseded` 结束；C04 原已发工具效果仍为 1 |
| R02 业务保存领先检查点，恢复无法继续 | 工具结果已保存则节点重入直接复用；工具登记增加稳定 `step_key` 唯一约束，重入返回同一调用；running 且无结果按 unknown 核查；completed 重入复用已提交回复 | 复核探针 `tool_result_saved`／`completed`：恢复无错误、工具效果各 1、只有一条调用/结果/正式回复；C09/C10 通过 |
| R03 恢复到模型节点沿用旧上下文 | 模型节点每次决策前从业务库重新读取角色设定、状态、消息和工具结果，不再依赖 `state.context` 快照 | 复核探针 `latest-context`：恢复后的模型读到 stateVersion 2 的新设定/状态；C05 原结果仍通过 |
| R04 已发出调用断连被归为明确失败 | `McpToolError`（工具返回 `isError`）仍是 failed；连接建立前失败是 failed；请求交给连接后的超时、断连和其他异常归 unknown 并进入核查 | 复核探针 `connection-loss`：核查调用 1 次、结果 unknown、工具效果 1；C06 两种核查分支和 C08 明确失败仍通过 |

复核探针 `reviews/20261103-review.ts` 最新报告为 `test-results/review-20261103/review-1793693349293.json`，5 个场景 `contractPassed` 全为 true。原有 P0-01、C01～C08 共 35 项检查、C09／C10 2 项及 P0-01 结果适配 1 项，共 38 项，全部通过。

### 复验遗留项修正（文档 168）

[文档 168](168-p0-followup-fix-list.md) 第 7 节判断 L01、L03、L06 需要修正，L02、L04、L05、L07、L08、L09 不修改实现或留待 P1／P4。本次修改及复验如下：

| 编号 | 修正 | 实现方复验 |
| --- | --- | --- |
| L01 报告归属未校验 | `run-all.ts` 每次运行生成 `runId` 并传入子进程；P0-01 与所有用例报告写入 `runId`；汇总校验退出码、报告存在、可解析及归属匹配；运行前清理目标报告，清理失败或归属不符直接判失败 | `reviews/20261103-l01-report.ts` 6/6，报告 `test-results/l01-report-ownership/report-1793693265344.json`；`p0:all` 全部报告归属匹配 |
| L03 `state_version_seen` 语义复用 | `executions` 拆为 `state_version_loaded`（最近上下文加载版本）和 `state_version_committed`（正式提交版本）；completed 重入返回 committed | C05 断言 `state_version_loaded=2`、`state_version_committed=3`，6/6 |
| L06 结果适配与错误分类混杂 | 新增 `adaptMcpToolResult`：`isError=true` 仍为 failed；JSON 文本解析后保存；普通文本、`structuredContent`、其他原始内容按成功应答保存；不再把“无 JSON 文本”当作工具失败 | P0-01 4/4，结果适配检查覆盖 6 种输入 |

L02、L04、L05、L07、L08、L09 的处理见[文档 168 第 8.2 节](168-p0-followup-fix-list.md)，本轮不修改实现。

#### MCP 结果与错误分类

| 情形 | 诊断 | 业务状态 | 是否进入核查 |
| --- | --- | --- | --- |
| 工具返回 `isError: true` | `MCP_TOOL_ERROR` | failed | 否 |
| 连接建立前失败 | `TOOL_CONNECT_FAILED` | failed | 否 |
| 请求交给连接后超时 | `TOOL_RESPONSE_TIMEOUT` | unknown | 是 |
| 请求交给连接后断连或其他传输异常 | `TOOL_RESPONSE_LOST` | unknown | 是 |
| 已应答且 `isError=false`，文本为 JSON | 无错误，解析后保存 | success | 否 |
| 已应答且 `isError=false`，文本非 JSON、仅 structuredContent 或其他内容 | 无错误，保存文本、结构化或原始响应 | success | 否 |

这些诊断不新增业务状态，仍沿用待执行、执行中、成功、明确失败、结果未知五态；核查无法确认时保持 unknown，不自动重做。

### 已知限制及未覆盖事项

- 没有 HTTP/API/SSE；CLI/API 契约和 P1 角色管理未开始。
- 没有完整记忆、Agent 生产回复、Skill、预算、正式调度器、多角色和远程 MCP；这些属于 P1～P5。
- 离线模型是脚本化的 `ChatModelPort`，不代表真实模型服务的流式、工具调用格式或兼容性；真实模型联调按 DL-116 留到 P2。
- `better-sqlite3` 是原生依赖；Electron ABI、打包、跨平台预编译和 Windows 之外的恢复行为未验证。
- C06 的核查器是样例专用；真实工具是否可核查取决于工具自身，不能把样例结果外推为所有工具都能补成功。
- C08／C09／C10 是补充用例，不改变 165 第 5 节 C01～C07 的必需范围；C09／C10 以节点故障注入覆盖重入边界，不等同于真实操作系统强杀该窗口。
- MCP 的 `isError` 工具结果和连接建立前失败归 failed；请求交给连接后的超时、连接中断及其他异常归 unknown 并进入核查。已应答但结果不是 JSON 文本时保存可用文本、structuredContent 或原始内容，不归为工具失败；其他 JSON-RPC 协议错误目前保守归 unknown，正式实现需按 DL-70 继续细化。
- 报告带 `runId`，汇总校验归属；报告缺失、不可解析、归属不符或清理失败时该用例判失败。并发运行仍会互相清理固定用例目录，临时约定同一时刻只运行一个 `run-all`。
- P0 的 `step_key` 按每轮单一工具请求设计；任务与执行仍为 1:1，且没有前台／后台模式字段。多调用步骤身份、任务一对多及前后台承载按 P1 数据契约定清，不能把 P0 通过外推为这些规则已成立。
- `paused` 被新消息取代且不 resume 的基础场景已由 168 的针对性探针覆盖，未进入 `p0:all`；正式调度、检查点保留策略及派发接纳边界留 P4 组合验收。当前状态检查、pending→running 与进入执行器之间没有 await，连接建立阶段可让出；已发出调用仍保存真实结果，旧提交被拒绝。
- 执行状态（paused/running/superseded/failed）由小样控制器维护，不是正式调度器；C09／C10 只覆盖节点重入。独立复验另补了工具登记、结果保存、正式提交及效果已发生但未存结果 4 个真实强杀窗口，均通过，见 167；P4 仍需验证正式实现的组合恢复。
- C07 只验证正式提交的事务原子性和不误报完成；提交失败时已流出的文本没有落为 interrupted 消息，完整的 DL-78 部分输出持久化由 C04 路径覆盖，正式实现仍需在后续阶段统一。
- 小样表结构是最小记录，不是 P1 最终数据模型；没有迁移、备份和保留策略。
- 运行证据先于本次本地提交形成，包含本记录的提交提供源码版本；历史轮次的未提交摘要及自验／独立复核身份分别保留，不将摘要误作提交哈希。

## 独立复核

- 复核者、范围及复现结果：2026-11-03 本次 Codex 复核会话，对实际代码独立检查，类型检查及原有 35 项检查重跑通过；新增 5 个边界场景未满足契约，归并 4 类 P1 问题，证据见[文档 167](167-p0-independent-review.md)。
- 问题、修正及复验：R01～R04 已按上节修正；实现方复验为 `npm run typecheck` 通过、`npm run p0:all` 11 个用例 37 项检查全通过、复核探针 5/5 contractPassed。以上是修正后的实现方复验，不能替代独立复验。
- 修正后独立复验：2026-11-03 重新执行类型检查、全套 37 项检查及原探针 5 个场景全部通过；新增真实强杀探针 4 个场景全部通过。独立证据、源码摘要和复现命令见 167，与上节实现方复验分别保留。
- 同轮次之外的另一次独立重跑再次确认类型检查、37 项检查、原探针 5 个场景与强杀探针 4 个场景通过；该次重跑另登记了 9 项意见，其合理性已在[文档 168 第 7 节](168-p0-followup-fix-list.md)核对，不能将原始意见全部视为已复现缺陷。任务持续目标、前／后台记录及工具结果映射应在相关正式契约中落实，不复开 R01～R04 的已关闭结论。
- 168 遗留项修正：L01、L03、L06 修改后，实现方复验为类型检查通过、`p0:all` 11 个用例 38 项检查全通过、原探针 5/5 contractPassed、L01 探针 6/6；记录该轮时独立复核尚未进行。
- 168 修正后的独立复核：本次重新执行类型检查、38 项检查、原探针 5 个场景、真实强杀 4 个场景、L01 探针 6 项和新增清理失败／版本保持 2 项，全部通过。执行者、时间、命令、确切报告及源码摘要见[168 第 9 节](168-p0-followup-fix-list.md)。本轮未修改实现；P1 开发准备见[169](169-p1-role-storage-development-guide.md)，尚未编码。
- 后续新增复验轮次按执行者／命令／报告文件名／时间标注，不重写历史轮次结论（文档 168 L09）。
- 最终结论：**修正后的独立复验通过（P0 小样范围）**。P0-01～P0-05 完成；P1 及后续阶段尚未开始，原有限制继续保留，复验遗留见 168。
