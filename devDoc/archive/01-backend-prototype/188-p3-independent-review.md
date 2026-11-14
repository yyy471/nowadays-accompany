# P3 自主安排、唤醒与额度独立复核

日期：2026-11-04。依据：[161 持续决策](../../161-digital-life-direction-decisions.md)的 DL-71、DL-98、DL-105～DL-112，[186 P3 开发文档](186-p3-autonomy-development-guide.md)、[187 实现记录](187-p3-autonomy-implementation-record.md)。

**最新结论：第 7 节定向复验通过，P3-R01～P3-R06 均已关闭。** 类型检查、142 项回归及全部 11 个边界场景通过，最后两处跨日／模式切换预留结算问题已修正，未发现新的阻断项。第 1～6 节保留历史失败与部分通过记录，[189](189-p3-independent-review-fix-record.md)保留实现方自验。本结论限定 P3 离线模型及本地 MCP 范围，不扩大为真实 P3 或正式交付完成；未修改业务源码、未提交或推送。

## 1. 基线与运行证据

| 项目 | 本轮证据 |
| --- | --- |
| 分支／基线 | `codex/p1-role-storage`，Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a`＋187 对应的 P3 未提交工作树 |
| 环境 | Windows x64、P0 专用 Node.js 24.22.2、独立 backend 依赖 |
| 运行编号 | `p3-independent-20261104-180217` |
| 证据目录 | `backend/test-results/p3-independent-20261104-180217/`（Git 忽略） |
| 后端类型检查 | `tsc --noEmit` 退出码 0；`typecheck.log` |
| 全量回归 | 119／119，0 失败、0 取消；`tests.log`（含 backend 既有 P1／P2 105 项与 P3 14 项，不含独立 P0 小样测试） |
| 边界脚本类型检查 | 严格模式检查退出码 0；`probe-typecheck.log` |
| 边界场景 | 7 个场景均复现缺口，无脚本异常；`p3-review-report.json`、`p3-probes.log` |
| 源码归属 | `source-manifest-before.json`、`source-manifest.json`；复核期间既有源码、测试及依赖清单未变 |
| 复现脚本 | [20261104-p3-review.ts](../../../backend/reviews/20261104-p3-review.ts) |

全部模型为离线脚本端口，MCP 为真实本地 stdio 服务与临时工作空间；未调用真实 DeepSeek、付费模型、QQ 或远程 MCP。TEMP／TMP 及 `P1_REVIEW_TMP_ROOT` 指向本轮 `tmp/`，沿用既有递归删除守卫；样例结束后关闭应用并清理自身临时目录。日期跨日用注入时钟实现，没有修改系统时间，也不依赖强杀、重启或多进程异常来复现。

## 2. 发现与修复验收条件

### P3-R01 [P1] 自主日记及分享绕过额度，最后一点用完后仍产生实际操作

位置：[agent-graph.ts:366](../../../backend/src/application/agent-graph.ts#L366)～389；同文件状态工具分支 :340；[187 第 3 节](187-p3-autonomy-implementation-record.md)对内部工具全部免扣的描述。

非 MCP 工具分支只对 `tool.source === "skill"` 扣点并登记工具计量。`diary_write` 的来源为 `memory`，`autonomy_share`／`autonomy_schedule` 为 `autonomy`，因此直接执行而不检查余额。把后台记忆维护的豁免套给角色主动写日记，违反 DL-109 明确规定；DL-105／DL-108 也不允许最后一点用于模型后继续发出实际工具操作。

复现：总额度设为 1。自主模型耗去最后一点后请求 `diary_write` 和 `autonomy_share`；两项实际副作用仍执行，生成 1 篇 Markdown 日记、主窗口新增 1 条分享；`usedPoints=1`，计量只有 1 条模型记录，没有两项工具记录。直到模型准备再思考时才暂停。

修复与验收：按调用服务的任务来源及操作职责计量，不能按 `memory`／内部工具来源一概豁免。自主日记与其他实际活动工具应在调用前受同一余额限制并登记实际调用；后台整理及用户任务的既有豁免保留。覆盖最后一点用于模型后的日记／分享、多工具请求遇到余额边界、无限制及用户任务；未发请求保持未执行，已发结果照常保留，不额外调用模型收尾。若工程文档扩大了豁免，应修正工程说明，不改 DL-109 来迁就实现。

### P3-R02 [P1] 带时区的合法 ISO 安排按原字符串比较，到点不能唤醒

位置：[autonomy-store.ts:215](../../../backend/src/storage/autonomy-store.ts#L215)、:248、:265、:474；[autonomy-service.ts:96](../../../backend/src/application/autonomy-service.ts#L96)的解析与保存路径。

入口只用 `Date.parse` 验证时间，但原样保存 `scheduledAt`；后续 SQL 按字符串排序，并用 `scheduled_at <= nowISO` 判断到期。计时器却按 `Date.parse` 计算实际时刻，两者口径不一致。

复现：安排 `2026-11-04T11:00:01+08:00`，实际是 `03:00:01Z`。注入当前时刻 `03:00:02Z` 后正式 `runDueAutonomy` 返回 false，模型调用 0 次，安排仍 pending。文本中的 `11:` 大于当前 UTC 文本 `03:`，尽管实际已到期也不会领取；原始字串排序还会影响多个不同格式安排的先后顺序。

修复与验收：对接受的时间统一规范化为可比较的 UTC 格式或以实际时间数值存储／查询，计时器、最近安排和到期领取使用同一规则；考虑已有接受记录的比较。覆盖正负时区偏移、跨日、相同瞬间的不同 ISO 表示及多个安排排序。无需新增用户配置或改变时区额度规则。

### P3-R03 [P1] 预算暂停清理原链资源，次日恢复无法沿用已关闭的模型或 MCP

位置：[conversation-service.ts:513](../../../backend/src/application/conversation-service.ts#L513)～515、:850～857、:1114～1132。

`finally` 仅在 `running.superseded && task.active` 时保留任务资源目录。预算耗尽置任务 paused 后走关闭分支，删除目录与绑定缓存；次日 `budget_resume` 又按新任务解析启用资源，且 `startDueAutonomy` 要求当前启用的 chat binding。DL-108 明确预算暂停不结束原任务链，DL-71 的原链资源使用资格应持续至任务结束。

两个同进程跨日场景均复现：

- 首次自主模型请求 MCP 写文件，但最后一点已用于模型，调用尚未发出，任务暂停。关闭模型后推进到次日并恢复额度，恢复入口返回 false，模型调用仍只有 1 次，任务保持 paused、恢复安排 pending。
- 同样暂停后只关闭 MCP、保留模型；次日决策确实启动，但原 MCP 工具未提供，成果文件不存在。说明这不是单纯 UI 状态问题，也不是保存结果的重放策略。

修复与验收：预算暂停期间保留同一任务链的模型绑定、工具资源资格和必要会话；恢复可使用原资源并在派发时读取最新配置，新任务继续受关闭开关约束。覆盖关闭模型、MCP／Skill、改绑、跨暂停的有状态服务连续性及原任务最终结束后的释放。本例没有重启，不应整体后置到 P4。

### P3-R04 [P1] 已结束暂停任务的恢复安排自动创建替代任务并继续执行

位置：[autonomy-store.ts:517](../../../backend/src/storage/autonomy-store.ts#L517)～551；[conversation-service.ts:222](../../../backend/src/application/conversation-service.ts#L222)的任务结束路径。

领取 `budget_resume` 时，若关联原任务已 completed／failed，代码将 `taskId` 改为空，随后进入通用“新建自主任务”分支。正式结束原任务也没有消除这项恢复安排，因此旧恢复安排被转换成新任务发起依据。

复现：原任务因额度暂停后，正式调用 `finishTask` 标为 completed，原因“用户明确结束原任务”。次日恢复额度，旧恢复安排仍启动，模型调用由 1 增至 3，另创建 1 个任务并实际写出 1 篇日记。旧任务虽然保持 completed，副作用却通过替代任务继续发生。

修复与验收：`budget_resume` 必须绑定仍可恢复的原任务，终态／缺失任务不得退化成新任务。结束时失效关联恢复安排，领取时也重查任务终态，保留可追溯的历史及原因。覆盖 completed／failed、结束与领取交错、同一任务多次恢复和正常 scheduled 新任务；结束后不得产生新模型／工具调用或替代任务。

### P3-R05 [P2] 自主活动被计为对话轮次，提前推进记忆精炼观察期

位置：[conversation-service.ts:1000](../../../backend/src/application/conversation-service.ts#L1000)；[conversation-store.ts:638](../../../backend/src/storage/conversation-store.ts#L638)～650。

自主活动完成也直接调用通用 `commitConversation`，其无条件分配下一个 `decision_round`。DL-98 的观察轮次用于“完成针对已发送消息的回复决策”，无输入消息的自主计划执行不应额外计为对话轮次。

复现：角色无任何用户消息，从当前轮次 0 开始，仅完成一次自主活动。用户消息数仍为 0，但 `getCurrentRound` 变为 1，autonomous execution 的 `decision_round=1`。连续自主活动会提前达到 100 轮候选阈值，影响事件精炼及最近 100 轮召回窗口。

修复与验收：按已确认的有效消息回复口径分配轮次，区分自主活动记录与对话轮次；自主消息、结果、状态和记忆证据仍正常保存。覆盖纯自主活动不加轮次、真实用户回复加一、多工具不重复计、用户消息插入自主活动及任务续行；不要将所有后台活动都算一轮。

### P3-R06 [P2] 原暂停记录永久参与当前状态，任务完成后仍显示 paused

位置：[autonomy-store.ts:326](../../../backend/src/storage/autonomy-store.ts#L326)～332、:565～587；[autonomy-service.ts:47](../../../backend/src/application/autonomy-service.ts#L47)～57。

预算恢复为同一任务新增活动记录，原活动仍保持 paused；`hasPausedActivity` 查询任意历史 paused 行，不参考任务当前状态或该任务最新活动。只要曾经暂停过，状态接口就会持续报告 paused。

复现：额度耗尽后次日正常恢复，原任务已 completed，最新活动 completed，没有暂停任务；状态接口却仍为 `paused=true`，同一 taskId 的旧活动 paused、新活动 completed。

修复与验收：当前暂停状态只反映仍待恢复的实际任务／最新活动，保留历史暂停轨迹而不把历史状态当现状。覆盖恢复运行中、成功／失败终态、显式结束暂停任务、多项活动中仅一项仍暂停等情况；状态与实际任务一致。

## 3. 复现与报告解释

在 `backend/` 使用专用 Node 执行：

```powershell
$env:NOWADAYS_REVIEW_OUTPUT="test-results/p3-independent-20261104-180217"
# TEMP／TMP、P1_REVIEW_TMP_ROOT 同时设为该目录下的 tmp/
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --import ./test-results/p1-review-20261103/fs-guard.mjs --test tests/*.test.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --import ./test-results/p1-review-20261103/fs-guard.mjs reviews/20261104-p3-review.ts
```

`contractPassed=false` 表示复现契约缺口，脚本返回 1；`probeError` 才代表脚本本身异常。本轮 7 场景均为 false 且没有 probeError；P3-R03 对应模型／MCP 两个分场景，其余每项一个场景。报告保存实际日记、分享、额度、计量、任务、安排、活动及轮次观察，不用模型口头声称作为副作用证据。

## 4. 范围与后续

基础实现中的 v3 初始化／既有迁移回归、额度默认值与日期恢复、普通安排、MCP 样例、主动分享、串行切换、隔离及 CLI／API 用例通过，187 的实现方自验历史保留；但上述失败属于 P3 已声明实现及沿用规则，不能用 119 项回归通过代替边界验收。

下一步先修复 P3-R01～P3-R06，补充对应自验和独立复验，再决定 P3 收口、提交及进入 P4。P2 在 184 的通过结论保留；本轮没有将强杀恢复、多进程、远程 MCP 或网页浏览等后续事项列为新增 P3 缺陷。P3 真实模型尚未联调，不把 P2 真实 DeepSeek 证据移作 P3 自主额度或唤醒的通过证据。

本轮未修改业务源码，未提交、未推送。

## 5. 189 修复后的独立复验

2026-11-04，用户要求“再次复核”。核对 189 修复代码、10 项新增正式回归及原 188 复现逻辑；独立运行类型检查、全量测试和原探针，并按 P3-R01／R03 原验收条件补测实际派发与同一服务会话，不把基础路径通过视为全部关闭。

### 5.1 基线与证据

| 检查 | 本轮结果 |
| --- | --- |
| 基线 | `codex/p1-role-storage`，Git `3fa50e6`＋189 修复后的未提交工作树 |
| 环境 | Windows x64、P0 专用 Node.js 24.22.2、独立 backend 依赖 |
| 运行编号／目录 | `p3-recheck-20261104-185903`；`backend/test-results/p3-recheck-20261104-185903/`（Git 忽略） |
| 类型检查 | `tsc --noEmit` 退出码 0；`typecheck.log` |
| 全量回归 | 129／129，0 失败、0 取消；`tests.log` |
| 原 7 个场景 | 7／7 `contractPassed=true`，无 `probeError`；`p3-review-report.json`、`original-probes.log` |
| 扩展场景 | 2 个均复现遗留，无 `probeError`；`p3-extended-report.json`、`extended-probes.log` |
| 扩展脚本类型检查 | 严格模式退出码 0；`extended-typecheck.log` |
| 源码归属 | `source-manifest-before.json`、`source-manifest.json`；测试期间既有源码、测试、依赖和原探针未变，仅新增扩展脚本 |

本轮仅使用离线模型与真实本地 stdio MCP、专用 TEMP／TMP 和既有递归删除守卫，未访问真实模型或付费服务，也没有强杀或重启应用。扩展脚本：[20261104-p3-fix-recheck.ts](../../../backend/reviews/20261104-p3-fix-recheck.ts)。与原脚本一样，`contractPassed=false` 表示复现问题；报告异常单列为 `probeError`，本轮没有该类异常。

### 5.2 P3-R01：内部工具额度已补齐，但异步建连结束前扣点且失去计量对应

位置：[agent-graph.ts:436](../../../backend/src/application/agent-graph.ts#L436)；实际派发边界 [agent-tools.ts:1026](../../../backend/src/application/agent-tools.ts#L1026)；`agent-graph.ts` 的 `executeExternal` 中 `TASK_ENDED`／`EXECUTION_SUPERSEDED` 抛出路径。

自主日记、分享、安排、状态与记忆工具已统一受余额限制，原最后一点及多工具边界通过。但 MCP 在 `meterTool()` 扣点后还要异步建连，建连结束才执行 `checkDispatch`，然后发送真正的 `callTool`。如果这期间任务正式结束，检查会阻止实际工具派发；额度却不撤销，而且异常路径绕过 `recordToolMetering`。

扩展场景让 stdio 服务在第二次建连时等待门控：第一连接仅发现工具，第二连接尚未完成、服务没有收到工具请求时，正式结束任务，再释放门控。结果：

- `dispatched=false`，服务没有写出派发标记；
- 工具保存 `failed`／`TASK_ENDED`；
- 仅发起 1 次自主模型调用，`usedPoints=2`；
- `call_metering` 只有 1 条 counted=1 的模型记录，总计 1 点，没有工具计量。

这不仅是扣点时机问题，也使持久余额与实际调用账本不一致。DL-105 按实际发起计次，DL-108／既有任务终态规则要求区分未派发和已发在途调用。

待修复：将建连准备期间的额度校验／预留与实际派发扣点、取消撤销及计量记录衔接；任务失效且未发出的调用不最终消耗点数，也不能留下账本缺口。已真正发出的调用继续收取结果并计一次，不可因任务中途结束一概退还。覆盖建连期间任务结束、新消息替代、连接失败，以及已经派发后的晚到成功／失败；不新增用户配置或审批。

### 5.3 P3-R03：资源资格恢复通过，但预算暂停仍关闭 MCP 服务会话

位置：[conversation-service.ts:1206](../../../backend/src/application/conversation-service.ts#L1206)～1227。

`task_resource_continuations` 与 `resolveChatForTask` 已修正关闭模型／MCP 后的使用资格，两个原分场景通过，原链模型选择和最新配置读取也已接入。但 `finally` 仍只在 superseded 且 task.active 时保留目录；预算 paused 路径继续关闭目录和 MCP 连接池。次日即使资源配置完全没变，恢复也重新启动服务进程，资源 ID 的资格记录无法恢复进程内会话状态。

扩展场景使用真实有状态 stdio 服务：`advance` 对进程内计数器递增。第一天额度 2，先用 1 点模型及 1 点工具得到 `1`，任务正常因下一次模型调用受限而暂停；同一进程内推进到次日并恢复同一任务，配置、开关和服务代码均不变。第二次实际 `advance` 仍得到 `1`，结果为 `["1","1"]`，不是连续同会话的 `["1","2"]`。两个调用归属相同 taskId，任务最终 completed，故不能用“同一任务 ID 保留”证明会话连续。

待修复：预算暂停不等于任务结束；配置未变且进程未退出时，保留仍属原任务链的 MCP 客户端／服务及必要目录上下文，直到任务结束再释放。配置变更仍按既定规则影响后续调用，在途请求保留真实结果，新任务仍受开关限制。覆盖有状态服务跨暂停、关闭后原链延续、最新配置与最终释放。该条件已在首轮 P3-R03 的验收中明确，不要求持久保存服务进程或把应用重启恢复提前到 P3。

### 5.4 关闭项与下一步

- **P3-R02 通过关闭**：新记录规范为 UTC，查询以实际时间比较；原偏移复现、正负偏移／跨日／同瞬间等正式回归通过，已有偏移文本也能按时刻排序。
- **P3-R04 通过关闭**：正式结束取消关联恢复安排，领取前重查原任务终态；原场景不再创建替代任务或执行副作用，直接存储终态用例也通过。
- **P3-R05 通过关闭**：自主提交不再推进 `decision_round`，真实用户回复仍计一轮。
- **P3-R06 通过关闭**：当前 paused 与实际暂停任务关联，保留历史活动且恢复完成后不再误报。

**P3-R01、P3-R03 仅部分修复，保持未通过；下一步先补齐这两项并定向复验，再决定 P3 收口。** 本轮没有修改业务源码或正式测试，不将新探针发现的问题写成已修复；未提交、未推送。P2 的 184 通过范围保持，P3 真实模型、强杀／重启组合、多进程、远程 MCP 和网页浏览仍按既有阶段另验。

## 6. 189 第 9 节补正后的独立复验

2026-11-04，用户要求“再次复核”。核对新的工具预留／提交／取消和预算暂停保留目录逻辑，重跑全部回归、原七场景与第 5 节两场景；在补正新增的状态转移上检查跨日和有限／无限制切换，未修改业务源码或正式测试。

### 6.1 运行与证据

| 检查 | 本轮结果 |
| --- | --- |
| 基线／环境 | `codex/p1-role-storage`，Git `3fa50e6`＋189 第 9 节修复工作树；Windows x64、P0 专用 Node.js 24.22.2、独立 backend 依赖 |
| 运行编号 | `p3-final-recheck-20261104-192738` |
| 证据目录 | `backend/test-results/p3-final-recheck-20261104-192738/`（Git 忽略） |
| 类型检查 | `tsc --noEmit` 退出码 0；`typecheck.log` |
| 全量回归 | 135／135，0 失败、0 取消；`tests.log` |
| 原探针 | 7／7，通过，无 `probeError`；`p3-review-report.json`、`20261104-p3-review.log` |
| 第 5 节扩展 | 2／2，通过，无 `probeError`；`p3-extended-report.json`、`20261104-p3-fix-recheck.log` |
| 新预留边界 | 2 个均复现遗漏，无 `probeError`；`reservation-boundary-report.json`、`reservation-boundary.log` |
| 新脚本类型检查 | 严格模式退出码 0；`reservation-typecheck.log` |
| 源码归属 | `source-manifest-before.json`、`source-manifest.json`；原有源码／测试／依赖未变，仅新增本轮复核脚本 |

新增脚本：[20261104-p3-reservation-boundary-review.ts](../../../backend/reviews/20261104-p3-reservation-boundary-review.ts)。沿用独立输出目录、专用 TEMP／TMP 和删除守卫，用专用 Node 加载 `tsx` 手动运行；`contractPassed=false` 表示缺口复现，脚本错误才记为 `probeError`。本轮仍仅调用离线模型及真实本地 stdio MCP，无真实服务费用；日期变化通过应用注入时钟，模式变化使用公开的 `setBudget`，没有改系统时间或直接篡改额度表。

### 6.2 已通过的补正

P3-R03：预算 paused 时保留任务工具目录与连接池；同一任务、同一配置、同一应用进程跨预算暂停后，真实有状态服务结果为 `["1","2"]`，任务 completed，最终资源续行结束。任务正式结束会关闭目录，配置变更仍按指纹切换。**P3-R03 通过关闭。**

P3-R01 的第 5 节复现路径已修正：同日有限模式下，任务在建连期间结束、工具未派发，预留被取消，`usedPoints=1`、账本同为 1；连接失败和新消息替代的取消，以及真正派发后的晚到成功／失败正式回归通过。这些通过结果保留，但还不能关闭新增预留状态边界。

### 6.3 P3-R01 遗留 A：预留跨零点提交，实际调用未扣当天额度

位置：[conversation-service.ts:907](../../../backend/src/application/conversation-service.ts#L907)～917；[autonomy-service.ts:285](../../../backend/src/application/autonomy-service.ts#L285)的预留日期；额度每日恢复沿用 `AutonomyStore.ensureBudgetRow`。

`reserveTool` 预先调用 `consumePoint` 扣去当日一点，保存预留日期；`commit` 却只把内存句柄标为已结算／已提交，没有检查派发时是否已进入新的额度日。

复现：时区为 Asia/Shanghai，Nov 4 本地 23:59:59 发起模型并开始工具建连，此时 `usedPoints=2`（模型＋预留）。让建连等待，推进到 Nov 5 本地 00:00:01，读取额度恢复为 0，再允许建连完成与真正派发。工具实际成功，随后模型完成回复；新一天账本有 1 次工具与 1 次模型、合计 **2 点**，但 `usedPoints` 最终只有 **1 点**。预留已在昨日，今日实际派发的工具没有重新占用今日额度。

这违反 DL-105 的实际发起计次及 DL-106 的每日日期归属，也可能在新一天余额不足时沿用昨日资格派发。本例没有退出、重启或并发进程，属于 P3 日期恢复与现有异步准备的组合。

待修复：提交预留时按实际派发日结算，跨日重新检查／取得当天余额，避免用昨日预留免除今日扣点；保留当日余额不足时未派发请求和暂停状态，不先发送再发现透支。取消旧日预留不得减少新日其他调用的点数；已经发出的调用仍只计一次。

### 6.4 P3-R01 遗留 B：无限制下未扣点的预留取消，误退已发生模型调用

位置：[conversation-service.ts:919](../../../backend/src/application/conversation-service.ts#L919)～924；[autonomy-store.ts:177](../../../backend/src/storage/autonomy-store.ts#L177)～187。

`cancel` 不检查 `reserved.counted`，无论该预留是否扣过点都调用 `releasePoint`。存储层只判断当前是有限模式、日期相同、总 used_points 大于 0，再从总额减一，无法确认减的是该预留的点数。

复现：先在有限模式发起模型，合法消耗 1 点；在模型返回工具请求前切为无限制，随后工具进入建连等待，无限制预留没有增加点数。建连期间切回有限模式并正式结束任务。工具未派发，取消该预留却把 `usedPoints` 从 **1 减为 0**；账本仍有一条实际模型调用 `counted=1`。被退掉的是另一项实际调用的点数，不是预留自己的点数。

待修复：取消只能撤销该预留确实占用的点数，并与原所属日期及运行中模式切换一致；未扣点的无限制预留不能退任何点，已扣点的有限预留也不能因模式暂时改变而遗失。补测有限→无限制、无限制→有限的成功派发／取消／失败与跨日，余额、counted 标记和实际调用保持一致，不通过清零余额掩盖错误。

### 6.5 当前结论

**P3-R02～P3-R06 均通过关闭；P3-R01 仍未通过，仅剩工具额度预留在日期和模式变化时的结算。** 135 项回归及此前九场景通过不覆盖上述两个新边界，先修正并定向复验再决定 P3 收口。189 第 9 节保留实现方自验证据，本节单列独立复验，未修改产品源码、未提交或推送。P2 通过范围保持，真实 P3、强杀组合、远程工具和桌面交付仍按后续阶段另验。

## 7. 189 第 10 节额度结算补正的最终定向复验

2026-11-04，用户要求“再次复核”。核对 `commitReservation`、预留取消、跨日额度判断及额度耗尽的未派发处理，再独立运行全部回归和此前三组探针。**P3-R01 通过关闭，P3-R02～R06 保持关闭；本轮 P3 离线独立复核通过，未发现新的阻断项。**

### 7.1 环境与证据

| 检查 | 本轮结果 |
| --- | --- |
| 基线 | `codex/p1-role-storage`，Git `3fa50e6`＋189 第 10 节补正后的未提交工作树 |
| 环境 | Windows x64、P0 专用 Node.js 24.22.2、独立 backend 依赖 |
| 运行编号／目录 | `p3-reservation-recheck-20261104-194313`；`backend/test-results/p3-reservation-recheck-20261104-194313/`（Git 忽略） |
| 类型检查 | `tsc --noEmit` 退出码 0；`typecheck.log` |
| 全量回归 | 142／142，0 失败、0 取消；`tests.log` |
| 原 7 场景 | 7／7，通过，无 `probeError`；`p3-review-report.json`、`20261104-p3-review.log` |
| 第 5 节两场景 | 2／2，通过，无 `probeError`；`p3-extended-report.json`、`20261104-p3-fix-recheck.log` |
| 第 6 节两场景 | 2／2，通过，无 `probeError`；`reservation-boundary-report.json`、`20261104-p3-reservation-boundary-review.log` |
| 源码归属 | `source-manifest-before.json`、`source-manifest.json`；既有源码、测试、依赖和探针均未在复核中修改 |

三组脚本均使用新的 `NOWADAYS_REVIEW_OUTPUT`，未覆盖首轮失败报告或实现方自验文件。使用同一专用 Node，在 `backend/` 执行类型检查、`--import tsx --import ./test-results/p1-review-20261103/fs-guard.mjs --test tests/*.test.ts` 及三组既有探针。TEMP／TMP／`P1_REVIEW_TMP_ROOT` 仍指向本轮隔离目录；所有模型均为离线端口，工具为真实本地 stdio MCP，无真实模型或付费服务调用。

### 7.2 P3-R01 两处预留结算均已修正

跨日提交现在通过 `AutonomyService.commitReservation` 结算，使用预留日期及实际派发日期判断；跨日需重新取得当天额度，额度不足会在实际 `callTool` 前抛出预算耗尽，工具不派发，执行进入暂停。取消仅释放该预留确实扣过且属于原日期的点数，无限制下未扣点的预留取消时不再减总额。

独立复现结果：

- 本地 23:59:59 预留、次日 00:00:01 实际派发：当日工具与后续模型各计 1 点，`usedPoints=2`、当天账本同为 2。
- 有限模式模型消耗 1 点后，转为无限制准备工具，再切回有限并取消：工具未派发，`usedPoints=1`、账本同为 1，没有误退模型点数。

代码与新增正式回归同时覆盖：新一天余额已满时拒绝派发、未扣点预留在有限模式派发前取得额度、已扣点预留取消时不受当前无限制标记影响、同日已有预留不重复扣点，以及取消／连接失败／新消息替代和已派发晚到结果的既有口径。未改变用户任务及后台记忆维护的豁免，不增加开关、审批、配置或额外模型调用。

### 7.3 既有修复与范围

原七场景继续确认额度限制、时区安排、关闭资源后的原任务延续、终态不创建替代任务、自主活动不推进对话轮次和当前暂停状态正确。第 5 节会话场景仍为 `["1","2"]`，同日建连期间结束的余额及账本仍为 1；本次没有回退此前已关闭项。

189 的实现方自验与本节独立结果分开保留，142 项包含原 135 项及第 10 节新增 7 项；不借用 P0 独立小样测试计数，也不把 P2 的真实 DeepSeek 验证当作 P3 自主场景的真实验证。

目前已无已知 P3 阻断项，具备准备 P4 恢复连续性、执行真实性及规则组合验收的条件。**本次只确认 P3 离线复核通过；工作树尚未提交、未推送，按 186 第 6 节不在此宣告 P3 正式完成或交付完成。** P3 真实模型关键场景、强杀／完整重启组合、多进程、远程 MCP、浏览器与桌面页面仍按既有阶段单列验证。本轮未修改业务源码或正式测试。
