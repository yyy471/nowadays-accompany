# P1 独立开发复核

日期：2026-11-03。执行者：本次 Codex 独立复核会话，与 P1 实现方自验分别记录。

最新结论：**最终独立复验通过（P1 范围），R01～R04 全部关闭。** 类型检查、13 个测试及三组共 13 个复核场景全部通过，见第 12 节。用户本轮要求本地提交并交付下一阶段文档，P2 准备稿见[173](173-p2-memory-agent-development-guide.md)，尚未开始 P2 编码；不推送远程。

首轮历史：原 8 个测试通过，新增 6 个场景中 5 个未满足契约，归并为 R01～R04。第 7 节保留实现方修正与自验，第 8 节记录本次独立复验，不以实现方自验替代独立证据。

历史轮次：第 7、9 节分别保留两轮实现方修正与自验；第 8、10 节分别记录独立复验，不用后续结果覆盖历史证据。

本轮未修改 `backend/src/`、原测试或依赖，新增[独立探针](../backend/reviews/20261103-p1-review.ts)及本记录，并同步文档状态；未提交、推送或改变用户决定。

## 1. 对象与证据

- 依据：161 的 DL-53、DL-64～DL-73、DL-86、DL-101～DL-103；169 的 P1 范围与验收；170 的初始化、必需索引及存储契约；171 的实现方自验记录。
- 对象：`codex/p1-role-storage` 未提交工作树，不能用分支 HEAD（P0 提交）充当 P1 源码版本。本次摘要保存在 `backend/test-results/p1-review-20261103/source-manifest.json`。
- 环境：Windows / win32-x64，显式使用 P0 下载的 Node.js 24.22.2，P1 独立 `backend/node_modules`；未使用根目录旧依赖，未调用模型、MCP、Skill 或真实 QQ。
- 原有验证：`tsc --noEmit` 退出码 0；`node --import tsx --test tests/*.test.ts` 8 个测试通过、0 失败，约 3.7 秒。实际命令另外加载本地文件清理保护器，将 TEMP／TMP 指向本次测试目录，在每次递归清理前检查目标位于该目录内；未修改原测试语义。
- 日志：`backend/test-results/p1-review-20261103/typecheck.log`、`tests.log`；自验记录中的 8 项与本次独立结果不合并为 16 项。
- 补充探针报告：`backend/test-results/p1-independent-1793695922077-9f5bc0f5/report.json`，runId 为 `p1-independent-1793695922077-9f5bc0f5`，时间为 `2026-11-03T08:52:02Z` 附近。报告含实际 HTTP 响应、业务索引、调用记录与错误。

补充探针在 `backend/` 下运行：

```powershell
& '../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe' node_modules/tsx/dist/cli.mjs reviews/20261103-p1-review.ts
```

探针每次创建唯一 `test-results/<runId>/`，不清除原有自验目录；模拟数据库缺失使用重命名保留原文件备份。脚本退出码 0 表示采集完成，契约是否满足以各项 `contractPassed` 为准，不能把退出码当作复核通过。

## 2. P1-R01［高／P1］已有角色的存储缺失被当成首次创建

位置：[RoleAccess.withStore](../backend/src/application/role-access.ts#L35)、[RoleStorage 构造](../backend/src/storage/role-storage.ts#L14)、[openRawDatabase](../backend/src/storage/schema.ts#L288)。

触发：先创建角色并正常关闭后端，保持应用索引 `ready`，将其某一数据库移为备份，再重启并通过真实 `GET /v1/roles/:roleId` 读取。

| 缺失文件 | 当前实际结果 |
| --- | --- |
| `business.sqlite` | 工厂创建新的空业务库；API 返回 404 `ROLE_NOT_FOUND`，应用索引仍是 ready，未将已建存储丢失报告为存储异常 |
| `execution.sqlite` | 工厂重新创建文件并写 schema 版本 1；API 返回 200，未暴露存储缺失 |

根因是已建角色的读取与首次初始化共用自动建目录／建库逻辑。170 第 4.1 节明确要求缺失时报告存储错误、不静默重建已有文件；正常角色读取不能将存储丢失当作初始化。当前 P1 的检查点文件还没有 LangGraph 数据，本探针没有声称已丢失真实图进度。

修正要求：区分首次初始化与打开已有角色；ready 角色要求其必需文件和 schema 完整，缺失时返回明确存储错误并保留现场，不创建替代空库。initializing／failed 的合法初始化重试仍应能按同一 roleId 补齐文件。

复验：上述两个缺失场景不产生新文件；普通角色重开与已验证的初始化失败重试仍通过。

## 3. P1-R02［高／P1］已保存 unknown 的调用无法补存后续确定结果

位置：[saveToolResult](../backend/src/storage/role-store.ts#L1062)、[finishToolCall](../backend/src/storage/role-store.ts#L985)。

触发：创建任务及执行关联，登记并标记调用 running，保存 `unknown / RESPONSE_LOST`；随后为同一 toolCallId 提供确定结果样例，尝试补存 success。

实际：`saveToolResult` 返回 `TOOL_RESULT_CONFLICT`；另走 `finishToolCall` 也返回 `TOOL_CALL_STATUS_CONFLICT`，原结果始终 unknown。这里验证的是仓储能否接纳已确认结果，不冒称 P1 已有真实核查器或执行过外部操作。

unknown 表示目前无法确认，不能等同于永远不可核实的事实终态。DL-53、DL-70 的核查原则，以及 DL-103 按原调用保存晚到真实结果，需要正式仓储存在受控的确定结果补录路径。原 8 项测试只覆盖 unknown 的保存／重开，没有覆盖后续确认。

修正要求：提供同一调用从 unknown 到已确认 success／failed 的受控核查或迟到结果保存路径，保留原诊断与核查依据；已明确的 success／failed 仍禁止被冲突结果任意改写。不得为更新状态重发工具或创建另一次调用。

复验：unknown 保存并重启后，补存确认结果仍沿用 toolCallId，原结果未知原因可追溯，调用不重复；冲突改写明确结果的原测试继续通过。

## 4. P1-R03［中／P2］步骤幂等忽略任务归属

位置：[beginToolCall 幂等分支](../backend/src/storage/role-store.ts#L863)。

触发：同一执行合法关联任务 A、B。先以 A 登记 `same-step / sample / {}`，再以 B 和相同执行、步骤、工具、参数登记。

实际：第二次返回 `duplicate: true`，但 toolCall.taskId 仍是 A。当前冲突检查只比较工具名和参数，未比较 taskId，导致调用方对 B 的登记被静默视作 A 的重试。

这不是“相同工具参数应该自动分成两次调用”的主张。步骤身份相同时应保持既有调用，同时检查不可变的任务归属；不同归属是冲突，不能静默复用。任务关联用于后续结果交接、预算及资源延续，不能在幂等时忽略。

修正要求：幂等重试校验既有 taskId 与请求一致，不一致返回明确冲突；同一任务、相同逻辑步骤重试仍复用原记录，不按参数重新生成身份。

复验：上述 B 请求返回冲突，A 调用及模式记录不变；A 的合法重试继续通过。

## 5. P1-R04［中／P2］打开角色业务库未验证必需索引

位置：[openVersionedDatabase](../backend/src/storage/schema.ts#L267)、[assertTables](../backend/src/storage/schema.ts#L363)。

触发：角色库版本仍为 1、所有表仍在，移除 `idx_messages_window_submission` 和 `idx_role_single_chat_model`，关闭并重新打开角色。

实际：`GET /v1/roles/:roleId` 返回 200。工厂只检查表名，`user_version` 等于当前版本时跳过初始化，没有验证必需索引。

170 第 4.1 节要求角色库打开时验证必需索引。上述索引承担消息提交去重与单对话模型的数据库约束，不能仅以表存在判断存储契约完整。本探针只证明索引缺失未被拒绝，没有声称正常环境会自行丢索引或已产生重复数据。

修正要求：打开已有库时检查必要索引及其关键约束，而不只是 `user_version` 和表名；已有库结构不符合预期时返回存储错误，不能静默迁移。首次初始化仍正常建立索引。

复验：缺失或错误定义的必需索引被识别，完整 schema 的正常打开与重启测试继续通过。

## 6. 其他补验与边界

- 超过 1 MiB 的真实 HTTP 请求返回 413 JSON `PAYLOAD_TOO_LARGE`，此项通过，未登记为缺陷。
- 单用户、无正式调度器、无真实模型／MCP／Skill、无 LangGraph 检查点表属于已确认阶段边界，不作为本次缺陷。未把模型列表／连接测试或 P2 记忆链未实现算作 P1 问题。
- 本轮没有修改 170 的用户需求或自行重设凭据、导入、删除与运行中改绑行为。
- 原有 8 个测试通过不覆盖上述缺失存储、未知结果补录及幂等身份场景。新增边界通过前，P1-06 不能关闭。

下一步由实现方修正 P1-R01～R04，补充对应自验，再独立复验。优先级括号中的 P1／P2 是代码审查严重性，不是建议把问题后置到项目的 P2 阶段。

## 7. 修正与实现方复验

2026-11-03，实现方按上述要求修正；未改变用户决定、未提交或推送。

| 问题 | 修正 | 关键文件 |
| --- | --- | --- |
| P1-R01 存储缺失被当作首次创建 | 角色存储区分`initialize`与`open`：ready 角色打开时要求 roleDir、workspace、business.sqlite、execution.sqlite 均存在；缺失时不创建替代文件或目录，返回 500 `STORAGE_ERROR`，`details.reason` 指出缺失类别并保留现场。空文件或只有版本 0 的业务库也不会被静默初始化。initializing／failed 的重试仍使用初始化模式补齐文件。 | `src/storage/role-storage.ts`、`src/storage/schema.ts`、`src/application/role-access.ts` |
| P1-R02 unknown 结果无法补录 | 工具结果增加`previous_status`、`previous_diagnostic_code`、`previous_raw_response_json`、`previous_adapted_result_json`、`previous_error_json`、`reconciled_at`；同一调用在已保存`unknown`后可用 success／failed 补录确定结果，保留原未知诊断、原始结果与核查依据，沿用同一 toolCallId。明确 success／failed 仍拒绝冲突改写；重复补录同状态幂等。补录必须携带确定结果，不提供只改调用状态的路径。 | `src/storage/role-store.ts`、`src/storage/schema.ts` |
| P1-R03 步骤幂等忽略任务归属 | `beginToolCall` 的幂等重试同时比较 taskId、工具名与规范化参数；任务归属不同返回 `TOOL_CALL_CONFLICT`，不静默复用既有调用。 | `src/storage/role-store.ts` |
| P1-R04 未验证必需索引 | 打开业务库时检查必需索引的存在、唯一性、部分索引属性、列顺序及谓词，包括消息提交去重和单对话／记忆模型约束；同时检查工具结果表的必需列。缺失、错误定义或旧结构返回存储错误，不自动迁移。 | `src/storage/schema.ts` |

补充测试：

- `tests/p1-02-storage.test.ts` 新增 4 项：ready 角色 business／execution 缺失时不重建且返回 `STORAGE_ERROR`；空业务库不被初始化；工具结果表缺列被拒绝；必需索引缺失或错误定义被拒绝，正常角色仍可读取。
- `tests/p1-04-resource-task.test.ts` 扩展：同一执行关联两个任务时，不同 taskId 的同步骤请求返回 `TOOL_CALL_CONFLICT`，原调用及模式记录不变；unknown 保存并重启后补录 success，保留 `previousDiagnosticCode`，重复补录幂等，冲突改写被拒绝。

实现方复验（不是独立复核）：

| 命令／探针 | 结果 |
| --- | --- |
| `npm run typecheck` | 退出码 0 |
| `npm test` | 12 个测试通过、0 失败，运行编号 `p1-r01-r04-20261103T171357` |
| `reviews/20261103-p1-review.ts` | 6/6 场景 `contractPassed: true`，报告 runId `p1-independent-1793697247418-457c7a7b` |

证据日志位于 `backend/test-results/p1-r01-r04-20261103T171357/`、`backend/test-results/p1-review-recheck-20261103T171407/` 及探针报告 `backend/test-results/p1-independent-1793697247418-457c7a7b/report.json`，均被 Git 忽略。

仍需独立复验：上述探针由实现方重跑，只能证明当前实现满足 172 列出的边界，不能替代独立会话的复验结论。P1 仍未完成。

已知限制：`BUSINESS_SCHEMA_VERSION` 仍为 1；本次工具结果新增列只保证当前 schema 的完整性检查，不为修正前生成的旧业务库提供迁移，旧库会因必需表／索引或列不符而拒绝打开。缺失 workspace 也按存储缺失处理，不自动创建空目录。

## 8. 修正后的独立复验（2026-11-03）

执行者：本次 Codex 独立复验会话。复核对象为 `codex/p1-role-storage` 修正后未提交工作树，未修改 `src/`、原测试或依赖；新增[补查探针](../backend/reviews/20261103-p1-recheck.ts)。用户要求仅在无问题时本地提交并给出下一阶段文档；本轮仍有问题，因此不提交，也不将 P2 文档作为已可开工的下一阶段交付。

### 8.1 独立结果与证据

环境：Windows / Node.js 24.22.2，使用 P1 独立依赖，不调用外部模型或工具。

| 验证 | 结果 | 证据（相对 `backend/`） |
| --- | --- | --- |
| `tsc --noEmit` | 退出码 0 | `test-results/p1-recheck-20261103/typecheck.log` |
| `node --import tsx --test tests/*.test.ts` | 12/12，通过 | `test-results/p1-recheck-20261103/tests.log` |
| `reviews/20261103-p1-review.ts` | 原 6 个场景全部 `contractPassed: true` | `test-results/p1-independent-1793697462783-cfc6aa5c/report.json` |
| `reviews/20261103-p1-recheck.ts` | 新增 3 个边界均未满足对应契约，归入 R02／R04 | `test-results/p1-recheck-1793697514597-8cd9d35f/report.json`，时间 `2026-11-03T09:18:34Z` 附近 |

源码摘要：`test-results/p1-recheck-20261103/source-manifest.json`。全套运行还加载了前轮清理保护器，并把 TEMP／TMP 指向本次目录，实际清理前核对绝对路径。补查探针首次因复核脚本误调用不存在的辅助方法而中止，修正为实际构造接口后重新运行；仅以上完整报告作为结论证据，不将脚本错误当作实现失败。

| 原问题 | 本次状态 |
| --- | --- |
| R01 已建角色存储缺失 | 修正通过：缺失 business／execution 返回 500 STORAGE_ERROR，未创建替代文件；新增空库及合法初始化重试测试通过 |
| R02 unknown 补录 | 原“已存 unknown 结果后补录 success”场景通过，但还有下列两条遗漏，未关闭 |
| R03 步骤幂等的任务归属 | 修正通过：taskId 不同返回 TOOL_CALL_CONFLICT，原调用保留 |
| R04 必需索引校验 | 缺索引及原测试中的错误定义被拒绝，但附加谓词改变约束仍未被识别，未关闭 |

### 8.2 R04：谓词只按子串匹配，失效索引仍可通过

位置：[schema.ts 的谓词匹配](../backend/src/storage/schema.ts#L432)。

将索引改为：

```sql
CREATE UNIQUE INDEX idx_role_single_chat_model
ON role_bindings(role_id)
WHERE capability = 'chat_model' AND 0;
```

实际：`GET /v1/roles/:roleId` 返回 200；仓储仍能打开，随后通过存储接口写入两条 chat_model 绑定成功。原始索引要求每个角色只有一条对话模型绑定，而此索引永远不包含任何行，已失去该约束。HTTP 绑定服务还有独立数量检查，本探针没有声称 HTTP 接口也直接接受了这两条绑定。

原因：`normalizeSql(row.sql).includes(normalizeSql(spec.predicate))` 只要求包含预期片段，不能验证整个谓词。此项属于原 R04 的“错误定义”边界，不是新增产品要求。

修正及复验要求：完整验证所需谓词／约束，而不是子串匹配；附加 AND／OR 改变条件的索引应被拒绝，原正确 schema 及已覆盖错误定义的测试继续通过。

### 8.3 R02：状态空补录与结果尚未保存的中间态

位置：[saveToolResult 的 existing 分支](../backend/src/storage/role-store.ts#L1082)及[无结果分支的状态检查](../backend/src/storage/role-store.ts#L1126)。

1. **只传状态即可补录成功。** 先保存 unknown，再调用 `saveToolResult({ roleId, toolCallId, status: "success" })`。实际接受并写为 success／reconciledAt 非空，rawResponse、adaptedResult、error 均为 null，没有提供任何结果或核查依据。第 7 节声称“补录必须携带确定结果、不提供只改状态路径”，当前实现尚未做到。应区分合法的显式空结果和根本未提供结果，不能只依赖状态声明完成核查补录。
2. **只有调用状态 unknown 时，确定结果仍被拒绝。** 用现有公开接口 `markToolCallRunning` → `finishToolCall(..., "unknown")` 保存调用状态，暂未写 tool_results；随后为同一 toolCallId 保存带 `rawResponse: { confirmed: true }` 的 success，实际返回 TOOL_CALL_STATUS_CONFLICT。修正仅覆盖了已有 unknown 结果行的路径。

修正及复验要求：明确核查／迟到结果补录需要的显式结果记录或依据；允许合法空结果，不做结果内容审查。对第二条，要么状态与结果原子保存，避免公开接口形成该中间态，要么支持该中间态下的确定结果补录。两条都继续沿用原 toolCallId，保留未知原因；已明确 success／failed 的冲突保护继续保留，不重发实际操作。

在 `backend/` 下使用同一 Node 运行：

```powershell
& '../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe' node_modules/tsx/dist/cli.mjs reviews/20261103-p1-recheck.ts
```

该脚本为采集探针，退出码 0 仅表示采集结束，以报告中 `contractPassed` 为准。下一步先完成 R02／R04 剩余修正，补对应自验，再独立复验；暂不创建本地提交或开始 P2。

## 9. 第二轮修正与实现方复验

2026-11-03，实现方按第 8 节要求修正 R02、R04 剩余项；未改变用户决定、未提交或推送。R01、R03 维持已验证修正，未重新打开。

| 问题 | 修正 | 关键文件 |
| --- | --- | --- |
| R04 谓词只做子串匹配 | 从 `sqlite_master.sql` 提取完整 `WHERE` 子句，规范化后与预期谓词**整体相等**才通过；`AND`／`OR` 附加条件、不同谓词均返回 `SCHEMA_INDEX_INVALID`，不再接受包含关系。仓储写入角色绑定时另行校验每个角色最多一个对话／记忆模型，即使索引在连接打开后被改坏也不会写入两条同类绑定。 | `src/storage/schema.ts`、`src/storage/role-store.ts` |
| R02 只传状态即可补录 | 保存任何 success／failed 结果都必须提供至少一项显式结果（`rawResponse`、`adaptedResult` 或 `error`），包括首次保存和 unknown 补录；显式空结果（如 `rawResponse: null`）允许，`diagnosticCode` 单独存在不算结果。仅传 status 或只给诊断码返回 `TOOL_RESULT_EVIDENCE_REQUIRED`，原结果保持 unknown。 | `src/storage/role-store.ts`、`src/domain/errors.ts` |
| R02 调用状态 unknown 但尚无结果 | 公开接口 `finishToolCall(...unknown)` 形成的中间态可在同一 toolCallId 下补录带证据的 success／failed；新结果记录 `previous_status='unknown'` 与 `reconciled_at`，并更新调用状态。已明确 success／failed 的冲突保护不变。 | `src/storage/role-store.ts` |

补充测试：

- `tests/p1-02-storage.test.ts` 的索引测试增加谓词附加 `AND 0` 场景，返回 500 `STORAGE_ERROR`。
- `tests/p1-04-resource-task.test.ts` 增加：首次成功保存、unknown 补录只传状态或只给诊断码均被拒绝且原结果不变；显式空结果 `rawResponse: null` 可补录；未知调用状态、尚无结果时可带结果补录，重启后保留 previous 状态与 reconciledAt；删除单对话模型索引后，仓储仍拒绝写入两个对话模型绑定。

实现方复验（不是独立复核）：

| 命令／探针 | 结果 |
| --- | --- |
| `npm run typecheck` | 退出码 0 |
| `npm test` | 12 个测试通过、0 失败，运行编号 `p1-r02-r04-round2-20261103T180130` |
| `reviews/20261103-p1-review.ts` | 原 6/6 场景 `contractPassed: true`，报告 runId `p1-independent-1793700085883-c62888d7` |
| `reviews/20261103-p1-recheck.ts` | 新增 3/3 场景 `contractPassed: true`，报告 runId `p1-recheck-1793700085373-0bda098f` |

证据日志位于 `backend/test-results/p1-r02-r04-round2-20261103T180130/`、`backend/test-results/p1-review-recheck-20261103T180125/`、`backend/test-results/p1-review-original-20261103T180125/` 及对应探针报告，均被 Git 忽略。

仍需独立复验：上述结果只能证明当前实现满足第 8 节列出的边界，不能替代独立会话的复验结论。P1 仍未完成，未创建提交或开始 P2。

## 10. 第三轮独立复验（2026-11-03）

执行者：本次 Codex 独立复验会话。对象：`codex/p1-role-storage` 未提交工作树。未修改 `backend/src/`、原测试或依赖；新增[字符串常量探针](../backend/reviews/20261103-p1-index-literals.ts)，只操作本次唯一测试目录。未调用外部服务。

环境仍为 Windows / Node.js 24.22.2，使用 backend 独立依赖。源码摘要为 `backend/test-results/p1-final-check-20261103/source-manifest.json`。

| 独立验证 | 结果 | 报告（相对 backend/） |
| --- | --- | --- |
| `tsc --noEmit` | 退出码 0 | `test-results/p1-final-check-20261103/typecheck.log` |
| `node --import tsx --test tests/*.test.ts` | 12/12 通过，约 4 秒 | `test-results/p1-final-check-20261103/tests.log` |
| 原复核探针 `20261103-p1-review.ts` | 6/6 contractPassed | `test-results/p1-independent-1793700309041-ef9b1615/report.json` |
| 第二轮探针 `20261103-p1-recheck.ts` | 3/3 contractPassed | `test-results/p1-recheck-1793700309538-73580d2c/report.json` |
| 新字符串常量探针 | 正常关键字格式控制通过；3 个无效字符串谓词均被误接纳 | `test-results/p1-literal-review-1793700435167-500424a4/report.json`，时间 `2026-11-03T10:07:15Z` 附近 |

全套仍使用清理保护器和本次 TEMP／TMP；实际递归清理前验证目标绝对路径。没有并行重写同一测试目录。原报告的运行日志另保存在 `test-results/p1-final-check-20261103/`，不将采集脚本的退出码 0 误当成全部契约通过。

### 10.1 目前已验证修正

- R01、R03 保持通过。
- R02 三条补录路径通过：有结果的 unknown 可补为 success／failed，只有状态的补录被拒绝，调用 unknown 但无结果行时能接纳确定结果；原调用编号和历史诊断保留。显式空结果及已确定结果的冲突保护也由全套测试覆盖。R02 关闭。
- R04 的缺失索引、非唯一／错误列及 `AND 0` 附加谓词已被拒绝；仓储新增的绑定数量检查有效。本轮不声称经该仓储还能写入两个对话模型绑定。

### 10.2 R04 剩余：规范化改变了字符串值

位置：[schema.ts: normalizeSql](../backend/src/storage/schema.ts#L462)。

当前对整个 WHERE 文本调用 `toLowerCase()`，并删除所有空白和括号。这些变换同时作用于引号内的字符串，而 SQLite 中字符串的大小写、尾部空格和括号属于值的一部分。

| 谓词 | 预期 | 实际 |
| --- | --- | --- |
| `where CAPABILITY = 'chat_model'` | 合法格式变化，接纳 | 200，通过控制场景 |
| `WHERE capability = 'CHAT_MODEL'` | 不同常量，拒绝 | 200，误接纳 |
| `WHERE capability = 'chat_model '` | 不同常量，拒绝 | 200，误接纳 |
| `WHERE capability = 'chat_(model)'` | 不同常量，拒绝 | 200，误接纳 |

探针同时执行 SQLite 实际比较，上述三个常量与 `'chat_model'` 的相等比较均为 0。角色绑定 capability 的合法值是小写 `chat_model`，错误谓词不会索引该值，已经改变原本的唯一约束；文件版本、索引名称和列都不变，当前工厂仍允许读取。

这属于原 R04 的“错误谓词必须拒绝”要求，不是增加新的产品功能。新增仓储绑定检查虽然保护了当前写入入口，不能代替 schema 验证正确识别索引定义。

修正要求：保留 SQL 字符串常量的内容及边界，不对引号内文本做大小写转换、删除空白或括号；可以只规范化引号外语法，也可以对无法可靠识别的定义明确拒绝，不需要实现任意 SQL 的自动修复／迁移。

复验要求：保留上表的合法控制场景、三个无效常量场景，以及先前的缺失索引、错误列、AND／OR 附加条件测试；原 12 项和两轮探针继续通过。

运行命令（backend/ 下）：

```powershell
& '../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe' node_modules/tsx/dist/cli.mjs reviews/20261103-p1-index-literals.ts
```

结论：**R01～R03 已通过，R04 尚未关闭，P1 尚未完成**。本轮未创建本地提交或下一阶段开发入口；先补齐 R04，复验通过后再按用户要求提交并交付 P2 开发文档。

## 11. 第三轮修正与实现方复验

2026-11-03，实现方按第 10.2 节修正 R04 的字符串常量规范化；未改变用户决定、未提交或推送。R01～R03 维持已验证状态，未重新打开。

| 问题 | 修正 | 关键文件 |
| --- | --- | --- |
| R04 规范化改变字符串值 | `normalizeSql` 改为逐字符扫描：遇到单引号、双引号或反引号时，把引号、引号内文本及成对转义引号原样复制；仅对引号外文本做大小写归一，并删除空白、括号和分号。`extractWhereClause` 仍取完整 `WHERE` 子句，规范化后整体相等才通过。`'CHAT_MODEL'`、`'chat_model '`、`'chat_(model)'` 不再等于 `'chat_model'`，返回 `SCHEMA_INDEX_INVALID`；关键字大小写与空白格式变化仍被接纳。 | `src/storage/schema.ts` |

补充测试：

- `tests/p1-02-storage.test.ts` 新增 `index predicate string literals are compared exactly`：同一批角色分别写入控制谓词 `where CAPABILITY = 'chat_model'` 与三个无效常量谓词 `'CHAT_MODEL'`、`'chat_model '`、`'chat_(model)'`；控制场景返回 200，三个无效常量均返回 500 `STORAGE_ERROR`（`reason: SCHEMA_INDEX_INVALID`）。

实现方复验（不是独立复核）：

| 命令／探针 | 结果 |
| --- | --- |
| `npm run typecheck` | 退出码 0 |
| `npm test` | 13 个测试通过、0 失败，运行编号 `p1-r04-literal-round3-20261103T182447` |
| `reviews/20261103-p1-index-literals.ts` | 4/4 场景 `contractPassed: true`（含合法控制场景），报告 runId `p1-literal-review-1793701478091-7de11acd` |
| `reviews/20261103-p1-review.ts` | 原 6/6 场景 `contractPassed: true`，报告 runId `p1-independent-1793701497017-684be66a` |
| `reviews/20261103-p1-recheck.ts` | 新增 3/3 场景 `contractPassed: true`，报告 runId `p1-recheck-1793701497459-89009a51` |

以上均在 Node.js 24.22.2 下执行；证据日志位于 `backend/test-results/p1-r04-literal-round3-20261103T182447/` 及对应探针报告，均被 Git 忽略。

仍需独立复验：上述结果只能证明当前实现满足第 10.2 节要求，不能替代独立会话的复验结论。P1 仍未完成，未创建提交或开始 P2。

## 12. 最终独立复验与本地提交基线（2026-11-03）

执行者：本次 Codex 独立复验会话，与第 11 节实现方自验分别记录。用户本轮明确要求本地提交并给出下一阶段文档；读取工作树后发现 R04 已有第三轮修正，因此在提交前完成独立复验。本轮未修改 `backend/src/`、原测试或依赖。

环境：Windows / Node.js 24.22.2，backend 独立依赖；未调用外部模型、MCP 或 Skill。验证发生在本地提交前，源码 SHA-256 清单为 `backend/test-results/p1-closeout-20261103/source-manifest.json`；正式源码版本以包含本记录的 Git 提交为准。

| 独立命令／范围 | 结果 | 本次报告（相对 backend/） |
| --- | --- | --- |
| `tsc --noEmit` | 退出码 0 | `test-results/p1-closeout-20261103/typecheck.log` |
| `node --import tsx --test tests/*.test.ts` | 13/13 通过、0 失败，约 3.9 秒 | `test-results/p1-closeout-20261103/tests.log` |
| `reviews/20261103-p1-review.ts` | 6/6 contractPassed | `test-results/p1-independent-1793701692775-a4abe8db/report.json` |
| `reviews/20261103-p1-recheck.ts` | 3/3 contractPassed | `test-results/p1-recheck-1793701693360-32e41c8d/report.json` |
| `reviews/20261103-p1-index-literals.ts` | 4/4 contractPassed，含合法控制场景 | `test-results/p1-literal-review-1793701693823-8bdbcbf7/report.json` |

三组探针时间为 `2026-11-03T10:28:12Z`～`10:28:14Z` 附近，确切时间保存在报告内。完整输出另存于 `test-results/p1-closeout-20261103/`。全套测试仍采用本次临时目录和清理保护器，递归清理前核对实际绝对路径；没有修改原测试语义。

### 12.1 问题关闭

- R01：ready 角色缺失文件、空库与结构不完整返回存储错误，不创建替代库；合法初始化重试保持同一身份。
- R02：只有状态的确定结果补录被拒绝，显式空结果允许；只有调用 unknown、尚无结果行时，可沿同一调用补存确定结果，保留历史状态；明确结果冲突保护继续通过。
- R03：步骤幂等包含原任务归属，不同 taskId 返回冲突，合法重试复用原记录。
- R04：完整谓词校验拒绝额外条件；字符串值的大小写、空格、括号均保持语义，三个无效常量返回 STORAGE_ERROR，正常关键字格式控制返回 200；必需索引和列检查仍通过。

没有发现阻止本次本地提交的问题，P1-01～P1-06 完成。旧自验与历次失败结论按轮次保留，不改写成当时已通过；当前结论以本节为准。

### 12.2 后续边界

P1 通过只表示角色、配置、存储及 CLI／API 的既定阶段范围完成，不代表完整 Agent、真实模型兼容或自主调度已完成。未实现的运行时调用、图检查点表、任务调度、真实服务及桌面打包等限制仍按 171 和阶段计划保留。

下一阶段开发文档为[173 P2 完整事件记忆、Agent 对话与扩展](173-p2-memory-agent-development-guide.md)。本文与源码、开发准备文档纳入用户要求的一次本地提交，不合并 master 或推送；P2 尚未编码。
