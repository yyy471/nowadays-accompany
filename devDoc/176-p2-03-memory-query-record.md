# P2-03 查询、维护与主观记忆实施记录

日期：2026-11-03。

状态：**P2-03 实现方自验完成；摘要精炼 R05 已修复并通过独立复验，最新见[178 第 6 节](178-p2-04-independent-review.md)。** 当时 42 项测试通过的实现方证据保留。本次针对问题的复验与回归不代表全部记忆行为已全面独立验收；完整联动按 P2-05、P2-06 验收。

需求依据：[持续决策记录 161](161-digital-life-direction-decisions.md) DL-24～DL-28、DL-87、DL-88；阶段范围见[执行清单 164](164-backend-prototype-execution-checklist.md)与 [P2 开发文档 173](173-p2-memory-agent-development-guide.md)；工程契约见 [P2-01 契约 174](174-p2-01-memory-agent-contract.md) 第 6、7、10、11、12、14 节。日记 Markdown 的用户要求已于 2026-11-03 记入 161 与 174。

## 1. 运行环境与源码基线

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a` + 本轮未提交工作树 |
| 运行环境 | win32-x64，Node.js 24.22.2，npm 11.19.1 |
| 依赖 | 沿用 P1／P2-02，无新增依赖；未调用真实模型或远程服务 |
| 执行目录 | `backend/` |
| 运行编号 | `p2-03-20261103T120000Z` |
| 证据日志 | `backend/test-results/p2-03-20261103T120000Z.log`（Git 忽略） |
| 数据目录 | `<appRoot>/data/`；测试使用临时目录 |

命令与结果：

```bash
PATH="/d/app/nowadays/accompany/prototypes/p0/.runtime/node-v24.22.2-win-x64:$PATH" \
  npm run typecheck
PATH="/d/app/nowadays/accompany/prototypes/p0/.runtime/node-v24.22.2-win-x64:$PATH" \
  npm test
```

类型检查退出码 0；`node --import tsx --test tests/*.test.ts` 共 42 项通过、0 失败，用时约 3.62 秒。

## 2. 实际实现

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 检索服务 | `src/application/memory-query-service.ts` | 统一检索事件／摘要／日记；FTS5 trigram 长词元与 LIKE 短词兜底；类型、标签、日期过滤；结果排序、截断与摘要片段 |
| 检索记录 | `src/storage/memory-store.ts` | `retrieval_queries`、`retrieval_results` 写入；按 execution 唯一登记 `memory_recalls`；手动查询不计召回 |
| 事件与证据 | `src/application/memory-query-service.ts`、`src/storage/memory-store.ts` | 事件详情含标签与来源；原始证据返回真实消息正文或工具原始／适配／错误记录 |
| 精炼 | `src/application/memory-service.ts`、`src/storage/memory-store.ts` | `refine_event` 操作；100 轮观察期与最近 100 轮召回不超过 1 次；同日多事件聚合或补充已有摘要，生成概括正文、来源范围、事件退出独立索引、原证据保留；R05 修复见 [179](179-p2-04-review-fix-record.md) |
| 纠错 | `src/application/memory-query-service.ts`、`src/storage/memory-store.ts` | 事件与摘要按 `expectedVersion` 校验；正文／标签／来源／检索文档／修订原子更新；版本冲突 409 |
| 日记 | `src/application/memory-query-service.ts`、`src/storage/memory-store.ts` | `<workspace>/diaries/<YYYY-MM-DD>/<diaryId>.md`；临时文件＋原子替换；数据库保存路径、快照与 SHA-256；读取校验并刷新外部修改；事件关联校验 |
| HTTP | `src/http/schemas.ts`、`src/http/routes.ts` | 检索、事件／证据／摘要读取、事件／摘要纠错、日记列表／写入／读取、记忆状态、批次历史、手动触发 |
| CLI | `src/cli/commands.ts` | `memory search/event/evidence/summary/status/batches/trigger`、`diary list/create` |
| 错误映射 | `src/domain/errors.ts`、`src/storage/schema.ts` | `SCHEMA_MIGRATION_FAILED`、`FTS5_UNAVAILABLE`、`MEMORY_QUERY_FAILED`、`MEMORY_SUMMARY_NOT_FOUND`、`DIARY_NOT_FOUND`、`DIARY_FILE_MISSING`、`INVALID_MEMORY_CORRECTION` |
| 测试 | `tests/p2-03-memory-query.test.ts` | 11 项 P2-03 用例，见第 4 节 |

## 3. 关键语义

- **检索**：查询按空白、标点和常见中文连接词切分；≥3 字词元使用 FTS5 `trigram MATCH`，1～2 字词元使用转义后的 `LIKE` 兜底。候选按词元命中数、FTS 相关度、经历日期、更新时间稳定排序；角色过滤始终通过 `memory_search_documents.role_id`。
- **过滤**：事件标签按维度 AND、同维度取值 OR；事件已精炼后不返回；摘要与日记按各自经历日期过滤；空命中返回成功空列表，执行异常返回 `MEMORY_QUERY_FAILED` 并写失败检索记录。
- **检索记录**：每次查询写 `retrieval_queries`；结果写 `retrieval_results`。手动／CLI 查询 `delivered=0` 且不写召回；Agent／自动检索的返回项写 `delivered=1`，并按 `execution_id + 记录` 唯一登记 `memory_recalls`。
- **精炼**：候选为 `currentRound - last_supplemented_round >= 100` 且最近 100 轮召回不超过 1 次的事件；候选随整理模型输入提供，`refine_event` 只能引用本批候选。提交时按模型给出的概括正文创建或补充同日摘要、按窗口汇总消息序号与时间范围、将事件标为 `refined`、删除事件检索文档、保留原始证据，并写事件与摘要修订。R05 修复后的多事件聚合与 `summaryCandidates` 见 [179](179-p2-04-review-fix-record.md)。
- **纠错**：事件纠错可改正文、主观体验、时间、标签及补充来源；开始时间变化时重算经历日期；已精炼事件纠错不会重新进入独立检索。摘要纠错原子更新正文、版本与检索文档。两者都写 `memory_revisions`，旧版本不覆盖新版本。
- **日记**：Markdown 文件是正文权威来源。写入先在同目录写临时文件并原子替换，再在业务库事务中写入日记、事件关联与检索文档；事务失败删除本次文件。读取以文件为准并校验 SHA-256，外部修改时刷新数据库快照与检索文档。P2 不监听文件变化。
- **错误**：v1→v2 迁移失败回滚并返回 `SCHEMA_MIGRATION_FAILED`（保留原始原因）；运行环境缺少 FTS5／trigram 时返回 `FTS5_UNAVAILABLE`；无命中与失败可区分。

## 4. 自验用例

| 用例 | 核对结果 |
| --- | --- |
| 中文长词与短词检索 | “杭州 旧书店”走 FTS；“杭州”“林”走 LIKE；标签、类型、日期过滤正确；结果含片段与排名 |
| 角色隔离与空结果 | 两个角色相同词元互不返回；无命中为成功空列表并写 succeeded 检索记录 |
| 失败与空结果区分 | 制造 FTS 不可用后检索返回 `MEMORY_QUERY_FAILED`，检索记录为 failed 并保存错误码 |
| 同角色跨窗口 | 主窗口与自定义窗口的事件同时被同一角色检索命中 |
| 观察期边界 | 99 轮不进入候选、100 轮进入；1 次召回仍为候选，2 次召回剔除 |
| 事件／证据读取与纠错 | 事件标签与来源完整；证据返回原始消息；纠错版本 2、原消息不变、修订来源 `agent_correction`；过期版本 409；空补丁 400 |
| 精炼 | 模型输入含候选；提交后事件 refined、版本 2、摘要可检索、事件文档删除、来源范围正确；精炼后纠错不重新索引 |
| 摘要纠错 | 版本递增，旧版本冲突 409，新正文可检索 |
| 日记 Markdown | 文件路径、正文与 SHA-256 正确；事件关联可读；外部修改后读取刷新快照与检索；失败写入不残留文件；列表不读文件 |
| HTTP 与 CLI | 检索、事件、证据、日记写入／读取、状态、批次、触发路由通过；CLI 检索与日记列表／写入通过 |
| Agent 检索召回 | 返回项 `delivered=1`；同一 execution 同一记录只计一次；手动查询不计召回 |

## 5. 已知限制与未覆盖

- 精炼候选只在已有待整理证据的批次中交给模型；没有待整理证据时，仅针对候选的独立后台批次和其失败退避尚未调度，留给 P2-05 的整理调度接入。
- Agent 读取事件详情或按来源读取证据时的召回登记接口已提供（`recordRecall`），但实际 Agent 工具接线属 P2-05；当前只验证 Agent 检索返回自动登记。
- 未调用真实模型；候选精炼使用离线脚本模型。真实服务联调属 P2-04／P2-06。
- 未模拟真实缺少 FTS5 模块的进程启动，只实现错误映射；失败检索用例通过替换 FTS 表结构模拟。
- 摘要与日记的列表／搜索使用最近一次写入或读取时刷新的快照；P2 不监听工作空间外部文件变化。
- 事件详情读取不会自动写召回，需由 Agent 工具显式调用；CLI／HTTP 人工读取保持不计召回。
- 未实现正式前端、桌面打包、自动召回条件构造或 LangGraph 对话链接；这些属后续工作包。
- 本记录中的通过结论只代表当时实现方自验；后续回归及摘要精炼问题见[178](178-p2-04-independent-review.md)，尚未全面通过独立验收。
