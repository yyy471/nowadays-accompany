# P2-02 记忆形成与保存实施记录

日期：2026-11-03。

状态：**P2-02 实现方自验完成，等待独立复核。** 业务库 v1→v2 迁移、证据登记、整理批次与分段、离线整理、事件保存与检索索引、触发、失败退避均已实现；类型检查退出码 0，31 个测试全部通过（P1 回归 13 项、P2-02 18 项）。本记录只记录实现方证据，不表示 P2 或整个阶段完成。

需求依据：[持续决策记录 161](../../161-digital-life-direction-decisions.md) DL-87、DL-88；阶段范围见[执行清单 164](164-backend-prototype-execution-checklist.md)与 [P2 开发文档 173](173-p2-memory-agent-development-guide.md)；工程契约见 [P2-01 契约 174](174-p2-01-memory-agent-contract.md) 第 3、4.1～4.2、5、13、14 节。

## 1. 运行环境与源码基线

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a` + 本轮未提交工作树 |
| 运行环境 | win32-x64，Node.js 24.22.2，npm 11.19.1 |
| 依赖 | 沿用 P1：better-sqlite3 12.10.0、zod 4.6.7、TypeScript 5.9.3、tsx 4.23.15；P2-02 未新增依赖 |
| 执行目录 | `backend/` |
| 运行编号 | `p2-02-20261103T112856Z` |
| 证据日志 | `backend/test-results/p2-02-20261103T112856Z.log`（Git 忽略） |
| 数据目录 | `<appRoot>/data/`，角色目录 `data/roles/<roleId>/`；测试全部使用临时目录 |

执行命令：

```bash
PATH="/d/app/nowadays/accompany/prototypes/p0/.runtime/node-v24.22.2-win-x64:$PATH" \
  npm run typecheck
PATH="/d/app/nowadays/accompany/prototypes/p0/.runtime/node-v24.22.2-win-x64:$PATH" \
  npm test
```

结果：类型检查退出码 0；`node --import tsx --test tests/*.test.ts` 共 31 项通过、0 失败，用时约 3.55 秒。

## 2. 实际实现

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 业务库 v2 | `src/storage/schema.ts` | 应用库与业务库版本升至 2；新增证据、批次、触发、分段、事件、标签、来源、修订、摘要、日记、召回、检索文档、FTS5 trigram 等表；v1→v2 在单事务内迁移并回填证据，失败整体回滚 |
| 证据登记 | `src/storage/evidence.ts` | 消息与工具结果登记为证据；按角色分配 `role_sequence`；计算本地日期；工具 unknown 补录同步来源状态；迁移时按时间、窗口、序号稳定回填 |
| 记忆存储 | `src/storage/memory-store.ts` | 触发去重、同角色单运行批次、按窗口分组与容量选证、长证据分段、事件创建／补充、标签、来源、修订、检索文档与 FTS 同步 |
| 记忆服务 | `src/application/memory-service.ts` | 50 条／30 条 + 60 秒／任务结束触发；批量与续批；离线模型端口调用；严格响应校验；事务提交；defer；失败退避 30 秒、2 分钟、10 分钟、1 小时 |
| 领域类型 | `src/domain/memory.ts` | 整理输入／输出 zod schema、事件补丁、标签、批次／证据／事件记录、预算与退避常量 |
| 错误码 | `src/domain/errors.ts` | `MEMORY_BATCH_CONFLICT`、`MEMORY_EVENT_NOT_FOUND`、`MEMORY_VERSION_CONFLICT`、`MEMORY_OPERATION_INVALID` |
| 离线模型 | `src/model/offline-memory.ts` | 可编排的离线模型，记录每次输入，供可重复时序测试 |
| 测试 | `tests/p2-02-memory.test.ts` | 18 项 P2-02 用例，见第 4 节 |
| 中文样例 | `tests/fixtures/p2-zh-memory.json` | P2-01 固定的中文事件、消息、日记与查询语料；P2-02 暂未消费，留给 P2-03 |

## 3. 形成与保存语义

- **证据**：只登记已实际保存的内容；`generating` 消息拒绝登记。用户消息与助手回复的成对登记在执行完成时接入，属于 P2-05；P2-02 提供登记函数及工具结果保存事务内登记。
- **批次**：同一角色只允许一个运行中批次；一个批次只处理同一窗口的原始证据，避免把不同窗口历史混入同一模型输入。批次固定 `input_from_sequence`／`input_to_sequence`，开始后新增证据序号更大，留到下一批。
- **容量**：按角色证据顺序装满输入容量；单条超长证据按字符边界写入 `memory_evidence_segments`，按序号分多次调用模型。同一批次可有多个子批，每个子批提交后才推进对应分段。
- **触发**：同窗口待整理消息达到 50 条，或至少 30 条且最后一条后停歇 60 秒；任务结束且该任务有新证据；手动登记。多个触发合并，批次开始即消费。
- **续批**：`runPending` 在当前批次完成或失败后继续检查待处理证据，立即安排后续批次；失败证据按退避时间控制，不重新等待 30／50 条阈值。
- **模型输出**：严格 zod 校验；操作引用必须属于本批次；`create_event` 日期必须与发生时间在配置时区一致；`update_event` 校验角色、版本和实际变化；全部操作与分段推进在同一事务内提交，任一失败整体回滚。
- **defer**：证据标为 `deferred` 并记录 `deferred_after_sequence`；本批其分段不标记完成。出现更大序号的新证据或手动包含时重新进入批次。
- **失败**：记录 `last_error_code`，受影响证据标为 `failed` 并递增尝试次数；已提交的子批和已处理分段保留。退避序列为 30 秒、2 分钟、10 分钟、1 小时，之后维持 1 小时；未到期不启动新批次。
- **索引**：事件正文、主观体验和标签写入 `memory_search_documents`，由触发器同步 `memory_search_fts`；FTS 使用 `trigram`，1～2 字查询的 LIKE 兜底留给 P2-03。

## 4. 自验用例

| 用例 | 核对结果 |
| --- | --- |
| v1 业务库迁移并回填证据 | 版本升至 2；消息证据按时间与窗口顺序编号；本地日期按 `Asia/Shanghai` 计算；处理状态为 pending |
| 迁移失败回滚 | FTS 表结构非法时拒绝打开；`user_version` 保持 1，新表未残留 |
| 实际消息形成事件并建索引 | 两个消息证据一次模型调用；事件、标签、来源、修订、检索文档和 FTS 命中一致；模型调用与计量记录正确 |
| 后续批次补充同一事件 | 事件版本 1→2；摘要与标签更新；来源累计 2 条、修订累计 2 条 |
| 非法模型输出重试 | 批次和证据标为失败；到期后用同一证据成功重试，不重复事件 |
| 长证据分段 | 25 字证据按 10 字预算分成 3 段，按 0／1／2 顺序调用；全部完成后证据才标为 processed |
| 跨窗口隔离 | 两个窗口分两批调用模型，模型输入不混并窗口；各自形成事件 |
| 容量分批 | 12 字证据在 10 字预算下拆成两批，逐批完成 |
| 运行中新增证据 | 整理期间登记的新证据不进入当前批次，下一批处理 |
| 失败退避 | 第 1～4 次失败分别安排 30 秒、2 分钟、10 分钟、1 小时；之后维持 1 小时；未到期不启动 |
| 过期版本原子回滚 | 子批中先 create 后 update 过期版本时整批失败；新事件未保存、旧事件版本不变；到期重试成功 |
| 工具结果形成事件 | 保存的工具结果登记为证据，形成事件并保留来源 |
| unknown 补录 | unknown 工具结果记录一条证据；补录 success 后来源状态更新且不重复登记 |
| 单运行批次 | 已有运行中批次时再次开始返回 `MEMORY_BATCH_CONFLICT`；服务返回 none 和该错误码 |
| 阈值边界 | 49 条不触发、50 条触发；30 条在 59 秒不触发空闲、60 秒触发 |
| 任务结束触发 | 任务结束且存在新证据时登记 `task_end`；工具证据带任务与执行标识 |

## 5. 已知限制与未覆盖

- P2-02 本身未接入 HTTP／CLI；P2-03 已补记忆检索、状态、批次、触发和日记路由及 CLI，见[176](176-p2-03-memory-query-record.md)。
- 未接入 LangGraph、模型绑定和实际模型协议；当前只验证离线模型端口。真实模型联调属 P2-04／P2-06。
- 用户消息与助手回复的成对证据登记、执行完成时触发、停止输入与新消息中断属 P2-05；本工作包只提供登记与触发函数。
- P2-02 完成时 `FTS5_UNAVAILABLE`、`MEMORY_QUERY_FAILED` 等面向 API 的错误映射尚未建立；P2-03 已补 `SCHEMA_MIGRATION_FAILED`、`FTS5_UNAVAILABLE`、`MEMORY_QUERY_FAILED` 等映射，见[176](176-p2-03-memory-query-record.md)。
- P2-02 完成时日记只有表结构与 Markdown 文件规范；P2-03 已实现 Markdown 写入、读取、外部修改刷新与 FTS 同步，见[176](176-p2-03-memory-query-record.md)。
- 摘要、精炼、召回统计、Agent 记忆工具和原始证据读取归 P2-03／P2-05。
- 仅验证 Node 24 / win32-x64 与临时目录；未验证其他平台、进程崩溃恢复组合或并发多进程写入。
- 独立复核尚未执行；本记录中的通过结论只代表实现方自验。
