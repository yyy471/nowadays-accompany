# P3 独立复核 R01～R06 修复与第 5／6 节补正记录

日期：2026-11-04。依据：[188 P3 独立复核](188-p3-independent-review.md)第 2 节；[186 P3 开发文档](186-p3-autonomy-development-guide.md)；[187 实现记录](187-p3-autonomy-implementation-record.md)；持续决策记录中的 DL-71、DL-98、DL-105～DL-112。

状态：**[188 第 7 节](188-p3-independent-review.md)最终定向复验通过，P3-R01～P3-R06 均关闭。** 类型检查、142 项回归及全部 11 个边界场景独立通过，最后两处预留结算已验证，未发现新的阻断项。本记录保留实现方修复与自验，不代替独立证据；未提交、未推送，不扩大为真实 P3 或正式交付完成。

## 1. 环境与证据

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6` + 当前未提交 P3 工作树 |
| 运行环境 | win32-x64，P0 专用 Node.js 24.22.2，独立 `backend/` 依赖 |
| 执行目录 | `backend/` |
| 运行编号 | `p3-fix-20261104` |
| 证据目录 | `backend/test-results/p3-fix-20261104/`（Git 忽略） |
| 证据文件 | `typecheck.log`、`tests.log`、`p3-review-probes.log`、`p3-review-report.json`、`summary.json` |

实际运行：

```powershell
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test tests/*.test.ts
$env:NOWADAYS_REVIEW_OUTPUT="test-results/p3-fix-20261104"
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p3-review.ts
```

| 检查 | 结果 |
| --- | --- |
| 后端类型检查 | 退出码 0 |
| 全量回归 | 129／129 通过，0 失败、0 取消 |
| 188 边界场景 | 7／7 `contractPassed=true`，无 `probeError` |
| 新增正式回归 | 10 项（P3-01 存储 2 项、P3 复核修复 8 项） |

全部模型为离线脚本端口，MCP 为真实本地 stdio 服务与临时工作空间；没有调用真实 DeepSeek、付费模型、QQ 或远程 MCP，也没有修改真实配置。

## 2. P3-R01 自主工具按实际调用计量

修改：

- [agent-graph.ts:626](../backend/src/application/agent-graph.ts#L626) 的 `meterTool()` 不再按工具来源筛选；自主目的下所有工具调用统一先受余额限制。
- [agent-graph.ts:341](../backend/src/application/agent-graph.ts#L341) 的 state 分支与 [agent-graph.ts:377](../backend/src/application/agent-graph.ts#L377) 的非 MCP 分支在调用前扣点，并在 [agent-graph.ts:633](../backend/src/application/agent-graph.ts#L633) 的 `recordSyntheticToolMetering` 写入与 MCP 同口径的 `call_metering` 记录。`diary_write`、`autonomy_share`、`autonomy_schedule`、记忆与状态工具不再因来源为 `memory`／`state`／`autonomy` 而豁免。
- 后台记忆维护仍不走 Agent 工具计量；用户任务目的仍不扣自主额度，DL-109 的原有豁免保留。
- 同步修正 [186 的额度说明](186-p3-autonomy-development-guide.md)，明确自主活动内的记忆检索、日记、分享与再安排按实际工具调用扣点，只有用户任务及后台维护保留豁免。

自验：

- [p3-review-fixes.test.ts:180](../backend/tests/p3-review-fixes.test.ts#L155) 把额度设为 1，自主模型用掉最后一点后同轮请求 `diary_write` 与 `autonomy_share`。断言日记数为 0、主窗口消息数为 0、`usedPoints=1`，计量只有 1 条模型记录；执行、任务和活动均为 paused，安排以 `AUTONOMY_BUDGET_EXHAUSTED` 结束。
- [p3-review-fixes.test.ts:252](../backend/tests/p3-review-fixes.test.ts#L227) 覆盖多工具请求撞上余额边界：额度为 2，模型与首篇日记各用一点后，已请求的日记正常保留，后续分享保持未执行，执行暂停。
- 既有 [p3-02-autonomy-runtime.test.ts:88](../backend/tests/p3-02-autonomy-runtime.test.ts#L88) 与 :282 两处计量条数随新口径更新：MCP、分享、再安排及记忆检索都登记实际工具调用；无限额度时全部记录 `counted=0`。

## 3. P3-R02 安排时间统一为可比较的实际时刻

修改：

- [autonomy-store.ts:185](../backend/src/storage/autonomy-store.ts#L185) 在接受安排时用 `Date.parse` 解析并保存规范 UTC ISO，不再保留带偏移的原字符串。
- [autonomy-store.ts:250](../backend/src/storage/autonomy-store.ts#L250)、:262、:493 的最近安排、到期列表和领取查询统一按 `julianday(scheduled_at)` 比较与排序。
- 已有带偏移记录无需迁移：到期判断与排序已按实际时间解析，计时器、`nextPendingWake` 与领取规则一致。

自验：

- [p3-01-autonomy-store.test.ts:241](../backend/tests/p3-01-autonomy-store.test.ts#L241) 覆盖 `+08:00`、`-05:00`、跨日与同一瞬间的不同写法。断言保存值为 canonical UTC，同一瞬间按创建顺序稳定排序，且 `03:00:01Z` 前不到期、到点恰好到期，跨日安排只在 `04:30:00Z` 到期。
- [p3-review-fixes.test.ts:317](../backend/tests/p3-review-fixes.test.ts#L292) 用 `11:00:01+08:00` 安排，在当前 UTC 文本仍为 `03:00:02Z` 时正式 `runDueAutonomy` 启动并完成。

## 4. P3-R03 预算暂停保持原任务链资源资格

修改：

- [conversation-service.ts:536](../backend/src/application/conversation-service.ts#L536) 新增 `grantTaskResources`，在自主任务链每次执行时把已启用的 chat_model、MCP、Skill 登记到既有 `task_resource_continuations`；已有模型授权不被替换。
- [model-binding-resolver.ts:43](../backend/src/application/model-binding-resolver.ts#L43) 新增 `resolveChatForTask`，任务链已有模型资格时即使绑定或资源已关闭仍可解析，模型名与配置仍读取现有记录及最新资源配置；[model-binding-resolver.ts:35](../backend/src/application/model-binding-resolver.ts#L35) 的 `hasChatForTask` 供恢复前检查使用。
- [agent-tools.ts:35](../backend/src/application/agent-tools.ts#L35) 接收任务链资源 ID，已关闭但属于原链的 MCP／Skill 仍生成候选并提供工具。
- [conversation-service.ts:523](../backend/src/application/conversation-service.ts#L523) 的启动检查允许 `budget_resume` 在聊天模型已关闭时凭原任务资格启动；[conversation-service.ts:928](../backend/src/application/conversation-service.ts#L928) 的续行使用任务模型与续行资源。新任务仍只使用当前启用资源，派发时继续读取最新配置。
- 任务结束时沿用既有逻辑结束全部资源续行，资格随整条任务链释放。

自验：[p3-review-fixes.test.ts:346](../backend/tests/p3-review-fixes.test.ts#L321) 分别关闭模型与 MCP 后跨日恢复。两个场景都断言恢复确实启动、原任务最终 completed、成果文件写出、MCP 工具仍被提供；历史暂停活动保留。

## 5. P3-R04 已结束任务不再退化为新任务

修改：

- [autonomy-store.ts:539](../backend/src/storage/autonomy-store.ts#L539) 在领取 `budget_resume` 前重查原任务：缺失或非自主任务以 `AUTONOMY_RESUME_TASK_MISSING` 取消，completed／failed 以 `AUTONOMY_RESUME_TASK_ENDED` 取消；校验通过前不插入执行、不创建活动，也不进入通用新建任务分支。
- [autonomy-service.ts:137](../backend/src/application/autonomy-service.ts#L137) 新增取消待恢复安排的入口；[conversation-service.ts:247](../backend/src/application/conversation-service.ts#L247) 的正式 `finishTask` 与 [conversation-service.ts:1252](../backend/src/application/conversation-service.ts#L1252) 的执行结束路径在任务终结时取消关联恢复安排，原因记为 `TASK_ENDED`。

自验：

- [p3-01-autonomy-store.test.ts:287](../backend/tests/p3-01-autonomy-store.test.ts#L287) 直接结束暂停任务后领取到期恢复安排，断言返回空、安排 cancelled／`AUTONOMY_RESUME_TASK_ENDED`、任务仍只有 1 个且没有新活动。
- [p3-review-fixes.test.ts:425](../backend/tests/p3-review-fixes.test.ts#L400) 走正式 `finishTask`，恢复时模型调用数不增加、没有日记、任务保持 completed、恢复安排 cancelled／`TASK_ENDED`，执行记录只有 1 条。

## 6. P3-R05 自主活动不占用对话轮次

修改：

- [conversation-store.ts:75](../backend/src/storage/conversation-store.ts#L75) 的提交输入增加 `countsAsConversationRound`；[conversation-store.ts:639](../backend/src/storage/conversation-store.ts#L639) 仅在需要计轮时分配下一个 `decision_round`，否则写入 `NULL` 并从事件负载省略。
- [conversation-service.ts:1096](../backend/src/application/conversation-service.ts#L1096) 自主执行提交时传 `false`，用户消息执行保持原有计轮规则。

自验：[p3-review-fixes.test.ts:489](../backend/tests/p3-review-fixes.test.ts#L464) 断言纯自主活动前后当前轮次都为 0、自主执行 `decision_round=NULL`、用户消息数为 0；随后提交真实用户消息，轮次变为 1 且该执行 `decision_round=1`。

## 7. P3-R06 暂停状态只反映仍待恢复的任务

修改：[autonomy-store.ts:360](../backend/src/storage/autonomy-store.ts#L360) 的 `hasPausedActivity` 连接 `tasks`，只统计活动 paused 且所属任务仍 paused 的记录。历史 paused 活动继续保留，但不再把已完成任务报告为当前暂停。

自验：[p3-review-fixes.test.ts:553](../backend/tests/p3-review-fixes.test.ts#L528) 先确认暂停状态为真、活动为 paused；跨日恢复并完成后断言任务全部 completed、`paused=false`、活动状态为 `["completed","paused"]`（历史保留）、没有待执行安排、当日额度使用 1 点。

## 8. 回归范围与后续

- 全量回归从 119 项增至 129 项：新增 P3-01 存储 2 项、P3 复核修复 8 项；既有 P1／P2／P3 用例全部通过。两处既有计量条数按 R01 新口径更新，没有放宽其他断言。
- 188 的 7 个边界场景全部通过且无 `probeError`，说明本轮修复覆盖了原复现路径；正式回归同时覆盖了最后一点模型后的日记／分享、偏移与跨日安排、关闭模型／MCP 后的预算恢复、结束任务的恢复取消、自主轮次与暂停状态。
- 未验证真实模型、强杀恢复、多进程、远程 MCP 或网页浏览；这些不属于本轮修复范围，也不能据本轮自验宣称 P3 已通过。
- 下一步由独立复验重跑类型检查、全量回归与 188 场景；复验通过后再决定 P3 收口、提交及进入 P4。本轮未提交、未推送。

## 9. 188 第 5 节复验遗留修复

日期：2026-11-04。依据：[188 第 5.2／5.3 节](188-p3-independent-review.md)与扩展脚本 [20261104-p3-fix-recheck.ts](../backend/reviews/20261104-p3-fix-recheck.ts)。

### 9.1 P3-R01 建连期间预留与实际派发计费一致

修改：

- [agent-graph.ts:33](../backend/src/application/agent-graph.ts#L33) 增加工具额度预留句柄；[agent-graph.ts:444](../backend/src/application/agent-graph.ts#L444) 在 MCP 工具执行前预留 1 点，不再在异步建连前直接最终扣点；重复调用的既有路径不重复预留。
- [agent-graph.ts:539](../backend/src/application/agent-graph.ts#L539) 的 `executeExternal` 把派发确认传入工具上下文；[agent-graph.ts:569](../backend/src/application/agent-graph.ts#L569) 仅在 MCP 建连与任务检查都通过、即将 `callTool` 时提交预留。[agent-tools.ts:1027](../backend/src/application/agent-tools.ts#L1027) 在真正发送工具请求前调用该确认。
- 未派发时撤销预留并且不写工具计量；连接失败、建连期间任务结束或用户消息替代均不消耗工具点。[agent-graph.ts:656](../backend/src/application/agent-graph.ts#L656) 的计量记录只在预留已提交时写入；已真正派发的晚到成功／失败仍计 1 点并保留真实结果。
- [autonomy-service.ts:285](../backend/src/application/autonomy-service.ts#L285) 新增预留入口，复用存储层已有扣点；[autonomy-store.ts:177](../backend/src/storage/autonomy-store.ts#L177) 增加按预留本地日期撤销，跨日时不会误减新一天的额度。

自验：新增 5 个正式场景，覆盖建连期间任务结束、用户消息替代、连接失败、已派发后的晚到成功与失败。建连期间结束：工具未派发、工具结果 `failed/TASK_ENDED`、`usedPoints=1`、计量只有 1 条模型记录；派发后结束：工具结果照常保存，模型与工具各计 1 点，`accountedPoints=usedPoints`。

### 9.2 P3-R03 预算暂停保留 MCP 会话直至任务结束

修改：

- [conversation-service.ts:932](../backend/src/application/conversation-service.ts#L932)、:1165、:1247 区分预算暂停：任务仍 paused 时保留任务资源目录与 MCP 连接池，次日恢复复用同一进程内客户端；预算暂停不再按执行结束处理。
- 任务正式结束时 [conversation-service.ts:255](../backend/src/application/conversation-service.ts#L255) 关闭任务目录并释放连接；恢复完成、失败或用户显式结束都会走到最终释放。
- 配置变更仍由连接池的配置指纹处理：下一次派发读取最新配置，指纹变化时重建客户端；新任务继续只使用当前启用资源。

自验：[p3-review-fixes.test.ts:593](../backend/tests/p3-review-fixes.test.ts#L568) 使用真实有状态 stdio 服务，额度 2 时先模型与工具各 1 点得到 `1` 后暂停，跨日恢复同一任务后第二次得到 `2`，工具结果按顺序为 `["1","2"]`，任务 completed 且资源续行全部结束。复核方扩展脚本 `P3-R03-stateful-MCP-survives-budget-pause` 也为 `contractPassed=true`。

### 9.3 自验证据

以下为第 9 节当时证据；第 10 节补正后的最新证据见 10.2。

| 项目 | 结果 |
| --- | --- |
| 运行编号 | `p3-fix2-20261104` |
| 证据目录 | `backend/test-results/p3-fix2-20261104/`（Git 忽略） |
| 后端类型检查 | 退出码 0；`typecheck.log` |
| 全量回归 | 135／135 通过，0 失败、0 取消；`tests.log` |
| 原 188 场景 | 7／7 `contractPassed=true`，无 `probeError`；`original-probes.log` |
| 第 5 节扩展场景 | 2／2 `contractPassed=true`，无 `probeError`；`extended-probes.log` |
| 新增正式回归 | 6 项，均在 [p3-review-fixes.test.ts](../backend/tests/p3-review-fixes.test.ts)，该文件共 14 项 |

全部模型为离线脚本端口，MCP 为真实本地 stdio 服务与临时工作空间；本轮没有调用真实模型、付费服务、QQ 或远程 MCP，也没有重启应用或多进程组合。保留的会话连续性仅限同进程内，应用重启后的恢复仍属 P4 范围。

### 9.4 后续

两项遗留已按 188 第 5 节的验收条件补齐，等待定向复验重跑全量回归、原 7 场景与扩展 2 场景；复验通过后再决定 P3 收口、提交及进入 P4。本轮未提交、未推送。

## 10. 188 第 6 节额度预留边界补正

日期：2026-11-04。依据：[188 第 6.3／6.4 节](188-p3-independent-review.md)与脚本 [20261104-p3-reservation-boundary-review.ts](../backend/reviews/20261104-p3-reservation-boundary-review.ts)。

### 10.1 跨日提交按实际派发日结算

修改：

- [conversation-service.ts:916](../backend/src/application/conversation-service.ts#L916) 的预留提交不再只改内存状态，而是调用 [autonomy-service.ts:304](../backend/src/application/autonomy-service.ts#L304) 的 `commitReservation`。
- 提交时比较预留所属本地日期与实际派发日期：同日已扣点的预留保持；跨日或原本未扣点的预留在当前额度日重新检查并按当前模式取得点数。当天有限且余额不足时在真正 `callTool` 前抛出额度耗尽，请求不派发、执行暂停。
- 取消只撤销确实扣过点的预留；[autonomy-store.ts:177](../backend/src/storage/autonomy-store.ts#L177) 按原所属日期释放，不再要求当前仍为有限模式，也不会因当前无限制而遗失已扣点。未扣点的无限制预留取消时不减任何点数。
- [agent-tools.ts](../backend/src/application/agent-tools.ts) 透传额度耗尽，[agent-graph.ts](../backend/src/application/agent-graph.ts) 保存未派发工具结果并让执行进入预算暂停。

自验：

- [p3-review-fixes.test.ts:961](../backend/tests/p3-review-fixes.test.ts#L961) 复现本地 23:59:59 预留、00:00:01 派发：工具与新一天模型各计 1 点，`usedPoints` 与当天账本均为 2。
- [p3-review-fixes.test.ts:1030](../backend/tests/p3-review-fixes.test.ts#L1030) 新一天余额已满时不派发，工具结果记为 `failed/AUTONOMY_BUDGET_EXHAUSTED`，执行与活动 paused，当天不新增计量。
- [p3-review-fixes.test.ts:1099](../backend/tests/p3-review-fixes.test.ts#L1099) 有限模型计 1 点后切换无限制、再切回有限并取消无限制预留，`usedPoints` 仍为 1，不会退掉模型点数。
- [p3-review-fixes.test.ts:1167](../backend/tests/p3-review-fixes.test.ts#L1167) 覆盖有限→无限制、无限制→有限的成功派发，分别得到 1 点与 2 点，`accountedPoints=usedPoints`。
- [p3-review-fixes.test.ts:1225](../backend/tests/p3-review-fixes.test.ts#L1225) 已扣点的预留切到无限制后取消，仍按原日期退回该点，模型调用点数保留。
- [p3-review-fixes.test.ts:1278](../backend/tests/p3-review-fixes.test.ts#L1278) 已扣点的预留切到无限制后成功派发，工具点保留，后续模型按无限制记录 `counted=0`，`usedPoints=2` 与已计点数一致。

### 10.2 自验证据

| 项目 | 结果 |
| --- | --- |
| 运行编号 | `p3-fix3-20261104` |
| 证据目录 | `backend/test-results/p3-fix3-20261104/`（Git 忽略） |
| 后端类型检查 | 退出码 0；`typecheck.log` |
| 全量回归 | 142／142 通过，0 失败、0 取消；`tests.log` |
| 原 188 场景 | 7／7 `contractPassed=true`；`original-probes.log` |
| 第 5 节扩展场景 | 2／2 `contractPassed=true`；`extended-probes.log` |
| 第 6 节预留边界场景 | 2／2 `contractPassed=true`；`reservation-boundary.log` |
| 新增正式回归 | 7 项，均在 [p3-review-fixes.test.ts](../backend/tests/p3-review-fixes.test.ts)，该文件共 21 项 |

本轮仍只使用离线模型、真实本地 stdio MCP、临时目录与注入时钟；没有调用真实模型、付费服务、QQ 或远程 MCP，也没有修改系统时间、重启应用或多进程组合。

### 10.3 后续

P3-R02～R06 保持关闭；P3-R01 的跨日与模式切换预留结算已补正。等待定向复验重跑类型检查、142 项回归、此前 9 个场景及第 6 节 2 个预留边界场景；复验通过后再决定 P3 收口、提交及进入 P4。本轮未提交、未推送。
