# P0 复验遗留修复清单

日期：2026-11-03。

状态：**L01、L03、L06 已通过修正后的独立复核；本轮未发现阻塞问题。L02、L04、L05、L07、L08、L09 按第 7 节不修改实现或留待 P1／P4。** 第 2～6 节保留原始意见，第 7 节为合理性核对，第 8 节为实现方复验，第 9 节为本次独立证据。本清单不复开 167 中 R01～R04 的“已关闭”结论，也不新增产品需求；下一阶段开发准备见[文档 169](169-p1-role-storage-development-guide.md)。

依据为[持续决策记录](161-digital-life-direction-decisions.md)第 DL-69、DL-70、DL-72、DL-77、DL-78、DL-101 条；工作包、验收用例与证据口径见[开发文档 165](165-backend-development-guide.md)，实施与复验证据见[文档 166](166-p0-implementation-record.md) 和[文档 167](167-p0-independent-review.md)。

## 1. 本轮独立重跑的复现结果

| 命令 | 本次结果 | 证据位置 |
| --- | --- | --- |
| `tsc --noEmit`（Node 24.22.2） | 退出码 0 | `test-results/p0-review-20261103/reverify-run.log`（仓库根） |
| `src/cases/run-all.ts` | 清空 `prototypes/p0/data/c06-*` 后连续 3 次通过，11 个用例 37 项检查，整套约 18.3 秒 | `prototypes/p0/data/p0-summary.json`、`test-results/p0-review-20261103/p0all-repeat.log` 与 `p0all-run2.log`（仓库根） |
| `reviews/20261103-review.ts` | 5/5 `contractPassed: true` | `prototypes/p0/test-results/review-20261103/review-1793691252683.json` |
| `reviews/20261103-crash-review.ts` | 4/4 通过，效果／调用／结果／正式回复各 1 次、同一 `tool_call_id`、角色版本 2 | `prototypes/p0/test-results/re-review-20261103/crash-review-1793691608517.json` |

仓库根的 `test-results/p0-review-20261103/` 另存有本轮修正前的原自验证据快照（`self-verify-data-snapshot/`）。第 4 项的 P0-C06 单次失败见 P0-L01，属证据链问题，不是执行链失败。

## 2. 遗留项一览

| 编号 | 内容 | 优先级 | 建议处理位置 | 是否阻塞 P1 |
| --- | --- | --- | --- | --- |
| P0-L01 | `p0:all` 判定可采信到上一轮的旧报告 | 高 | 小样 `run-all.ts`／`harness.ts` | 否，但影响后续所有阶段证据可信度 |
| P0-L02 | `step_key` 不含参数身份，同轮同工具不同参数会被判成复用 | 高 | P1 工程契约，随 P1 落实 | 否 |
| P0-L03 | `state_version_seen` 被三种语义复用 | 中 | P1 数据契约 | 否 |
| P0-L04 | 任务与执行 1:1，DL-101 的持续目标没有落点 | 高 | P1 数据契约 | 是，属 P1 范围内必须定清 |
| P0-L05 | DL-70 的“前台／后台另记”没有字段 | 中 | P1 数据契约 | 是 |
| P0-L06 | 工具结果状态映射仍偏宽，缺四态对照表 | 中 | P1 契约，按 DL-70 收口 | 是 |
| P0-L07 | `paused` 被新消息取代且不 resume 的分支无覆盖 | 中 | 小样补用例或并入 P4 组合验收 | 否 |
| P0-L08 | 状态检查与实际派发之间存在竞争窗口 | 低 | P4 组合验收 | 否 |
| P0-L09 | 复核轮次的执行者与报告归属未标注 | 低 | 文档约定 | 否 |

## 3. 小样与证据层

### P0-L01 报告归属未校验，并发或早退时会读到上一轮报告

[run-all.ts:106-120](../prototypes/p0/src/cases/run-all.ts#L106) 的用例结论等于“子进程退出码为 0”加“读 `data/<case>/report.json` 且其 `ok === true`”，报告里没有本轮标识；用例目录是固定名，[config.ts:14-19](../prototypes/p0/src/config.ts#L14) 在每次运行开始时 `rmSync` 重建。

实际发生：同一目录上有两个 `p0:all` 并行时，P0-C06 的子进程只运行 756 毫秒就退出，汇总行仍打印 `c06-verify:ok 3/3`（读到的是上一轮幸存的报告），`c06-unverifiable` 因没有报告而记为 `0/0`，整套以 `ok: false` 结束。也就是说用例在启动阶段就崩溃时，另一个用例的报告可以被误当作本轮通过。

判据：报告与本轮建立可验证的归属关系，例如 `report.json` 写入 runId 并由汇总校验，或改用 `data/<runId>/<case>/`；任一情况下都要求目录清理失败时该用例直接判失败而不是沿用旧报告。同步在 `prototypes/p0/README.md` 与文档 166 的限制节写明“同一时刻只运行一个 `run-all`”。

### P0-L02 步骤身份不含参数，第二次同工具调用会被静默丢弃

[build.ts:139](../prototypes/p0/src/graph/build.ts#L139) 生成 `执行编号:turn-N:工具名`，[business.ts:416-431](../prototypes/p0/src/storage/business.ts#L416) 与 `(execution_id, step_key)` 唯一索引据此去重。真实模型在同一轮里对同一工具发起两次不同参数的调用是正常输入，例如连续写两个文件，此时第二次会被判为“复用同一次调用”，参数不同的那次不再执行也不留下记录。P0 的脚本每轮只发一个工具请求，所以该行为没有暴露。

判据：P1 契约先定清一次逻辑步骤的身份（含参数摘要或轮内序号），并补一个“同轮同工具不同参数”的用例，证明两次调用分别登记、分别保存结果。

### P0-L03 `state_version_seen` 承担三种语义

同一字段现有三个写入方：每次读取上下文时写入当时版本（[business.ts:399-405](../prototypes/p0/src/storage/business.ts#L399)）、正式提交时写入新版本（[business.ts:706](../prototypes/p0/src/storage/business.ts#L706)）、提交重入的幂等分支把它当作“已提交版本”返回（[business.ts:656-675](../prototypes/p0/src/storage/business.ts#L656)）。恢复后只要再经过一次上下文读取，幂等提交返回的版本就不再是当初提交的那一版；同一份 `report.json` 里 `completed` 行与 `paused`／`failed` 行的同名数字也代表不同的事。

判据：P1 数据契约拆为“本轮加载到的版本”与“本轮提交的版本”两个字段；在此之前，166 与 `report.json` 的说明需注明该字段含义随状态不同。文档 165 第 4.2 节“不得用同一个编号混代身份、任务和执行进度”应覆盖这种情况。

## 4. 与已确认需求的缺口（进入 P1 契约处理）

### P0-L04 任务仍与执行 1:1

[business.ts:433-437](../prototypes/p0/src/storage/business.ts#L433) 按 `execution_id` 查找任务、找不到就以本轮用户消息为 `goal` 新建，[business.ts:608-646](../prototypes/p0/src/storage/business.ts#L608) 在旧执行被替代时把该执行名下的任务一律置为 `paused`。C04 的最终状态即是一个 `paused` 任务，它名下唯一的工具调用已经 `success`，没有任何未完成项可承接。

DL-101 确认“原任务与已发工具独立延续、结果保留且不重复执行”，DL-69、DL-72 确认任务不因回复中断或图暂停而结束。小样目前的结构无法表达一个任务跨多个执行存在，也无法表达新决策接管同一目标；R01～R04 与 P0-L01～L03 都不覆盖这一点，首轮复核也未登记。

判据：P1 数据契约给任务独立的身份与状态机（与执行一对多），并定义新执行如何接管同一目标；在此之前不把“P0 通过”外推为任务规则已成立。

### P0-L05 前台／后台独立记录缺少承载

DL-70 除五种工具调用基础状态外还确认“前后台另记”。小样 `tool_calls` 的五态 CHECK（[business.ts:185-195](../prototypes/p0/src/storage/business.ts#L185)）已齐，但没有前台／后台归属字段，也没有对应的记录或查询，166 与 167 全文未出现该项。

判据：P1 数据契约定出前／后台记录方式与切换时的保留规则，并给一条可验证的用例；不预设小样已覆盖。

### P0-L06 工具结果状态映射需要一张对照表

现在的分类是：工具返回 `isError` 或 `TOOL_RESULT_WITHOUT_TEXT` 抛 `McpToolError` 后归 failed（[client.ts:79-84](../prototypes/p0/src/mcp/client.ts#L79)、[executor.ts:84-89](../prototypes/p0/src/mcp/executor.ts#L84)）；连接建立前失败归 failed（[executor.ts:56-65](../prototypes/p0/src/mcp/executor.ts#L56)）；请求交给连接之后的超时、断连**以及其他任何异常**归 unknown 并进核查（[executor.ts:94-101](../prototypes/p0/src/mcp/executor.ts#L94)）。其中 [client.ts:86](../prototypes/p0/src/mcp/client.ts#L86) 的 `JSON.parse` 失败属于“服务器已正常应答、本地无法解析结果”，与“发出后失联”语义不同，却共用 `TOOL_RESPONSE_LOST`。

判据：按 DL-70 给出四类对照——明确工具错误、发出前失败、发出后结果未知、已应答但结果不可用——分别定义状态、是否进入核查、核查失败时的落点。166 的 MCP 分类限制条目保留到该表定出为止。

## 5. 用例与窗口补验

### P0-L07 `paused` 被新消息取代没有用例

[business.ts:614](../prototypes/p0/src/storage/business.ts#L614) 允许从 `paused` 转入 `superseded`，但 `markExecutionSuperseded` 现有调用点只有 [c04.ts:97](../prototypes/p0/src/cases/c04.ts#L97) 与复核探针，两处被替代的执行都处于 `running`。C02／C05／C03 是暂停后 resume，强杀探针的四个边界也不涉及被替代。

未覆盖的实际时序：暂停期间新消息到达、旧执行不再恢复。此时已保存的工具结果、`paused` 任务、检查点残留和角色状态如何各自落位，没有证据。

判据：补一个低成本小样用例，断言旧执行 `superseded`、已保存结果不重发、角色状态不被旧值覆盖；如判定属 P4 组合范围，则在 166 限制节单列该分支未验证。

### P0-L08 检查与派发之间的竞争窗口

[build.ts:304-325](../prototypes/p0/src/graph/build.ts#L304) 先确认执行仍是 `running`，随后才实际调用 MCP。替换若恰好落在两者之间，副作用仍会发生。R01 探针覆盖的是模型返回后的更宽窗口，进程内无法消除这一格。

判据：不把它写成已解决。在 166 限制节明确该窗口，并按 DL-113 留到 P4 组合验收，验收口径沿用“已发出调用的实际结果仍保存、旧提交被拒”。

## 6. 记录约定

### P0-L09 复核轮次标注执行者、命令与报告文件名

`prototypes/p0/test-results/review-20261103/` 现存两份相差 880 毫秒的探针报告（`review-1793691252683.json` 与 167 引用的 `review-1793691253563.json`），实现方复验与独立复验同日、同目录并行执行。文档 165 第 6 节要求实现方自验与独立复核分别留证，因此每轮结论应注明由谁执行、用什么命令、对应哪份报告文件。

判据：166 与 167 后续新增轮次记录时按“执行者／命令／报告文件名／时间”四项标注，不改写历史轮次的结论。

## 7. 条目合理性核对（2026-11-03）

执行者：本次 Codex 条目核对会话。范围：对照当前代码、已确认决定和 P0／P1 分工，判断条目是否成立；未修改实现、依赖或产品决定，未重新运行全套用例，也不把静态判断写成完整运行验收。

### 逐项结论

| 编号 | 判断 | 应修正的表述或安排 |
| --- | --- | --- |
| L01 | 成立，属于证据归属缺口 | 同名目录和报告没有 runId，确实可能串读其他运行的报告；已有日志证明单个分支报告归属不可靠，但该次 C06 和整套都判为 FAIL，不能据此声称已经复现“整套错误通过”。非零退出码仍会使该用例失败。建议在下一次作为验收依据前处理归属／隔离，单次运行约定仅为临时措施 |
| L02 | 当前正常链路下不成立；未来批量工具调用需要设计 | `ModelDecision` 每次只含一个工具请求，`modelTurn` 每次递增。连续同工具不同参数会得到 turn-0、turn-1 两个不同 step_key，已实测两次均执行。未来若支持一次模型响应内多个调用，应增加稳定 callId／轮内序号；不能仅按参数摘要去重，否则相同参数的两次有意操作也可能被合并。相同步骤身份却出现不同参数可作为一致性问题另行处理，但不是当前链路已吞掉第二次调用的证据 |
| L03 | 成立，属于数据契约语义问题 | 字段同时表示最近读取版本和提交版本确实不稳，应分开。当前普通 `commit_reply` 检查点重放不经过上下文加载，原复验路径未出错；已补证的是显式再次记录上下文后，幂等返回版本会变化，不能把它描述成每次正常恢复必现 |
| L04 | 成立，属于正式任务模型缺口 | 持续目标应独立于图执行，后续存储／调度必须能关联原任务。放入 P1 相关数据契约合理；不等于阻止所有 P1 工作开始，关联基数仍按实际执行职责设计。工具已 success 不能证明任务没有剩余工作，原文对 C04“没有任何未完成项”的推断不成立，目标是否结束仍由角色判断 |
| L05 | 成立，属于已确认能力尚未落地 | P0 没有前／后台模式记录，不能宣称已实现该条。应在正式调用记录及切换机制中落实；可在 P1 先定数据承载，运行行为及组合验证按既定后续阶段推进，不扩大 P0 验收范围 |
| L06 | 成立，但需要补充结果格式兼容这一原因 | 明确工具错误、派发前失败、结果失联和结果适配失败应区分诊断原因；这四类情形不等于新增四种调用状态，仍沿用既有五态。当前客户端强制 JSON 文本；普通文本及仅 structuredContent 的响应也被已安装 SDK 接受，不能把“没有文本／不能 JSON.parse”直接解释为工具明确执行失败。应保存可用的原始／结构化响应并按实际确认程度映射，不要求用户重新确认既有原则 |
| L07 | 原先是覆盖缺口，本次基础场景已补验通过 | 已暂停执行被标记 superseded、原执行不 resume、新执行完成后，旧工具结果保留且效果仍 1 次，旧检查点保留 pause_gate，角色状态由新执行保存。没有复现现有缺陷；正式调度和检查点保留策略继续按后续阶段验收 |
| L08 | 作为“当前已确认竞态缺陷”的结论不成立；派发边界需要明确 | 同一事件循环中状态检查、pending→running 和进入执行器之间没有 await，不存在任意插入消息回调的窗口；执行器建连中可能让出。DL-70 已明确 running 表示进入调用流程，不证明远端已经开始，因此不能用“远端效果发生在新消息后”单独判错。测试在 tool_started 后替代旧执行，实际结果仍保存、旧提交拒绝，符合在途处理原则。正式调度应明确派发接纳的边界，防止尚未接纳的旧请求被派发；“进程内无法消除”也不宜作为确定结论 |
| L09 | 合理的证据维护建议，非功能缺陷 | 现有 166／167 已分别列出实现方和独立复验的命令及确切报告；两份报告时间接近不表示同一轮报告被冒用。补充稳定执行者／轮次标识有助于审计，但不能将时间接近本身写成既有复核归属错误的证明 |

“阻塞 P1”应改为说明相关契约或模块的前置条件：L04～L06 需要在对应正式结构／功能落地前定清，不意味着 P1 所有工作均不能开始。L01 建议优先修复，避免之后的验收继续依赖可能串读的报告。以上是核对建议，不新增产品规则；实际修复与复验见第 8 节。

### 本次针对性证据

在 `prototypes/p0` 下执行（Node.js 24.22.2）：

```powershell
& './.runtime/node-v24.22.2-win-x64/node.exe' node_modules/tsx/dist/cli.mjs test-results/followup-assessment-20261103/probe.ts
```

探针和原始结果为本地忽略的运行证据：

- `prototypes/p0/test-results/followup-assessment-20261103/probe.ts`。
- `prototypes/p0/test-results/followup-assessment-20261103/followup-assessment-1793692350180.json`，含本轮时间、节点状态、调用参数与业务快照。
- L02：真实本地 MCP 连续调用 `append_note` 写 `0.md`／`1.md`，两条不同 step_key、两条调用、两次效果，两个文件均存在。
- L03：原提交版本 2；通过公开存储接口再记录版本 3 后，重入 `commitTurn` 返回版本 3。这是字段复用的针对性证明，不冒充正常恢复的复现。
- L07：旧执行 paused→superseded 后不恢复；新执行完成，旧调用效果仍为 1，历史中只有新执行的正式回复，状态为 `lastReply=new`，旧检查点下一节点仍为 pause_gate。
- L08：在 `tool_started` 同步回调内将旧执行替代，此时调用记录已经 running；后续效果 1 次、结果保存成功，正式提交报 `EXECUTION_NOT_RUNNING:superseded`。该证据需结合 DL-70 的在途定义解释。
- L06：对已安装 `@modelcontextprotocol/sdk` 的 `CallToolResultSchema` 直接运行 `safeParse`，普通文本 `{ content: [{ type: "text", text: "已完成" }], isError: false }` 和 `{ content: [], structuredContent: { ok: true }, isError: false }` 均返回成功；源码 `client.ts` 仍分别 JSON.parse／抛出无文本错误。本次未宣称已完成通用 MCP 兼容验收。

L01 另核对了原始 `test-results/p0-review-20261103/reverify-run.log`：记录为 `P0-C06 FAIL 756ms c06-verify:ok 3/3 c06-unverifiable:fail 0/0`，汇总 `ok: false`；日志足以支持“报告归属不稳”，不足以支持“这次整套误判通过”。

## 8. 修复实施记录（2026-11-03）

执行者：本次 Codex 实现会话。范围：按第 7 节处理 L01、L03、L06；其余条目不修改实现。命令均在 `prototypes/p0` 下使用 Node.js 24.22.2。

### 8.1 已修正

| 编号 | 实际修改 | 实现方复验 |
| --- | --- | --- |
| L01 | `run-all.ts` 每次运行生成 `runId` 并传入子进程；P0-01 与所有用例报告写入 `runId`；汇总要求退出码为 0、报告存在、可解析、`runId` 匹配；运行前清理目标报告，清理失败、报告缺失、归属不符或不可解析均判该用例失败 | `p0:all` 11 个用例、38 项检查通过；`reviews/20261103-l01-report.ts` 6/6，报告 `test-results/l01-report-ownership/report-1793693265344.json` |
| L03 | `executions` 拆分 `state_version_loaded` 与 `state_version_committed`；上下文读取只写 loaded，正式提交只写 committed，completed 重入返回 committed；C05 断言加载版本 2、提交版本 3 | `p0:all` 中 C05 6/6；报告快照可见两个字段 |
| L06 | 新增 `adaptMcpToolResult`：`isError=true` 仍为明确失败；JSON 文本解析后保存；普通文本、`structuredContent`、其他原始内容按成功应答保存；不再把“无 JSON 文本”当作工具失败；连接建立前失败、发出后超时／失联的既有分类保持不变 | P0-01 4/4；其中结果适配检查覆盖 JSON 文本、普通文本、`structuredContent`、图片块、空内容和 `isError` 六种输入 |

四类错误对照及核查落点写入[文档 166](166-p0-implementation-record.md)的“MCP 结果与错误分类”一节。167 的 R01～R04 结论不变。

### 8.2 不需要修改或不在本轮范围

| 编号 | 处理 |
| --- | --- |
| L02 | 当前 `ModelDecision` 每轮只含一个工具请求，`modelTurn` 递增；168 第 7 节已实测连续两次调用分别执行。未来支持一次响应多个调用时，在 P1 契约增加稳定 callId／轮内序号，不能仅按参数摘要去重 |
| L04 | 任务与执行 1:1 是 P1 正式任务模型的缺口；本轮不把 P0 任务结构改成一对多，P1 数据契约定清任务独立身份、状态机和新执行接管 |
| L05 | 前台／后台模式尚无承载；P1 先定记录字段与切换保留规则，运行行为按后续阶段验证，不扩大 P0 验收范围 |
| L07 | 168 第 7 节的针对性探针已覆盖 paused→superseded、不 resume、旧结果保留、新执行提交；未复现现有缺陷，不新增 `p0:all` 用例，正式调度与检查点保留策略留 P4 |
| L08 | 同一事件循环内状态检查、pending→running 与进入执行器之间没有 await；连接建立阶段可让出。不把“远端效果发生在新消息后”单独判错；正式调度的派发接纳边界留 P4，166 限制节已按此表述 |
| L09 | 证据维护约定：后续新增复验轮次按执行者／命令／报告文件名／时间标注；不重写 166、167 的历史轮次结论 |

### 8.3 复验结果

- `tsc --noEmit`：退出码 0。
- `src/cases/run-all.ts`：11 个用例、38 项检查、0 失败；本次 `runId` 为 `run-20261103080754928-48ce7e7b`。
- `reviews/20261103-review.ts`：5/5 `contractPassed: true`，报告 `test-results/review-20261103/review-1793693349293.json`。
- `reviews/20261103-l01-report.ts`：6/6，报告 `test-results/l01-report-ownership/report-1793693265344.json`。
- 以上为实现方复验；记录该轮时独立复核尚未进行。后续独立结论另列如下，不覆盖该轮历史证据。

## 9. 修复后的独立复核与提交准备（2026-11-03）

执行者：本次 Codex 独立复核会话。复核对象为 `codex/p0-runtime-spike` 的 L01／L03／L06 修正后工作树；本轮未改动 `src/` 或依赖，新增独立探针 [20261103-followup-review.ts](../prototypes/p0/reviews/20261103-followup-review.ts)。用户已要求复核无阻塞问题后做一次本地提交，并交付下一阶段开发文档；不推送远程。

环境：Windows，Node.js 24.22.2；全套运行时间为 `2026-11-03T08:15:00.113Z`～`08:15:18.877Z`。后续探针时间分别保存在报告文件或文件名中。本次源码 SHA-256 清单为 `prototypes/p0/test-results/final-review-20261103/source-manifest.json`；源码及文档版本以包含本记录的本地 Git 提交为准，运行验证发生在提交前。

在 `prototypes/p0` 下，显式使用 `.runtime/node-v24.22.2-win-x64/node.exe` 执行：

| 命令／范围 | 独立结果 | 本次报告（相对 `prototypes/p0/`） |
| --- | --- | --- |
| `node_modules/typescript/bin/tsc --noEmit` | 退出码 0 | 本次工具运行记录 |
| `node_modules/tsx/dist/cli.mjs src/cases/run-all.ts` | 11 个用例、38/38 检查通过；逐报告核对 runId 一致 | `test-results/final-review-20261103/independent-suite-summary.json`，runId=`run-20261103081500113-21cd2e05` |
| `node_modules/tsx/dist/cli.mjs reviews/20261103-review.ts` | 原恢复／过期决策／最新上下文／断连场景 5/5 通过 | `test-results/review-20261103/review-1793693719549.json` |
| `node_modules/tsx/dist/cli.mjs reviews/20261103-crash-review.ts` | 4/4 真实强杀恢复通过，工具效果各 1 次 | `test-results/re-review-20261103/crash-review-1793693721513.json` |
| `node_modules/tsx/dist/cli.mjs reviews/20261103-l01-report.ts` | 报告存在／缺失、旧 runId、缺 runId、损坏及清理路径 6/6 通过 | `test-results/l01-report-ownership/report-1793693811470.json` |
| `node_modules/tsx/dist/cli.mjs reviews/20261103-followup-review.ts` | 报告清理失败显式返回错误；加载版本变化不改写提交版本，2/2 通过 | `test-results/final-review-20261103/followup-review-1793693812732.json` |

L01 探针本次通过同进程 `--import tsx` 引导执行，执行前验证其实际 PID 对应的清理目录位于 P0 的 `data/` 下；测试语义与上表直接命令一致。全套 `run-all` 独占执行，未并行清理固定用例目录。runId 校验阻止报告串用，尚不代表已支持并发运行多个 `p0:all`。

L03 的专项证据：首次提交版本为 2，随后角色更新及再次加载版本为 3；已提交版本仍为 2，重入返回同一 replyMessageId 和版本 2，角色最新版本保持 3，正式回复仍只有一条。

L06 的独立全套重跑包含 P0-01 的六类结果适配输入，C06 的可核查成功／不可核查 unknown 和 C08 明确工具错误仍通过。这里只确认所列本地样例和适配输入，不声称所有远程服务、多内容块组合或正式模型兼容性已验证。

结论：**本轮修复通过独立复核，可作为 P0 的本地提交基线。** 未发现阻塞本次提交的问题；原已确认的 P0 范围不扩大。L04／L05 等正式任务与模式契约、L06 正式结果保存契约在 [P1 开发文档](169-p1-role-storage-development-guide.md)承接，P1 尚未开始编码。
