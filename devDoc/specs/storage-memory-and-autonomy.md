# 存储、记忆与自主执行规范

> **状态**：现行规范 · **适用范围**：`backend/src/{bootstrap,security,storage,domain,application,mcp,skills,http,cli}` 与 `desktop/desk-preview/renderer/src/{App.tsx,pages/{Home,Conversation,Settings}.tsx,conversation/{ChatPane,use-window-session}.ts}`  
> **覆盖关系**：整合 [170](../archive/01-backend-prototype/170-p1-01-contract.md)（角色与存储）、[174 §1～§7 与 §9～§14](../archive/01-backend-prototype/174-p2-01-memory-agent-contract.md)（记忆、Agent 与本地 MCP／Skill）、[186](../archive/01-backend-prototype/186-p3-autonomy-development-guide.md)（自主执行）、[190](../archive/01-backend-prototype/190-p4-recovery-acceptance-report.md)（启动崩溃恢复）、[196](../archive/01-backend-prototype/196-backend-capability-gap-plan.md)～[199](../archive/01-backend-prototype/199-p5-gaps-review-fix-record.md)（`GAP-01`～`GAP-06`）、[278 §4](../archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md#4-第一次配置与对话恢复)（首次配置与对话恢复）及 [306 记忆恢复修复](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#26-306-补修独立复验) 的现行规则。

---

## 1. 适用范围、边界分工与上游决定

### 1.1 适用范围

1. **分库存储与密钥保护**：`<app-root>` 目录结构、全局 `app.sqlite` 与每角色独立分库（`business.sqlite`／`execution.sqlite`／`workspace/`）、SQLite PRAGMA 与事务迁移策略、`SecretCipher` 静态密钥封装与跨库提交顺序。
2. **角色实例与初始化**：角色列表（`GET /v1/roles`）、创建及 4 步初始化、幂等重试、设定修订号、当前状态乐观锁，以及工作空间与历史目录维护。
3. **LangGraph 执行、工具链与能力补齐**：对话／自主统一图循环、`ModelPort` 三协议与 `continuation` 续轮、慢工具自动转后台（`GAP-01`）、角色任务决定（`GAP-02`）、`unknown` 核查补录（`GAP-03`）、本地 stdio MCP 越界防护、Agent Skills 按需加载与随包脚本执行（`GAP-05`）。
4. **记忆形成、检索与演化**：四类后台整理触发与同角色单批串行队列、模型绑定继承（`DL-124`）、按模型容量分批与超长分段（`GAP-04`）、`FTS5 trigram` ＋短词 `LIKE` 混合检索、100 轮低召回精炼、工作空间 Markdown 日记读写与码点分段（`GAP-06`）以及事件／摘要纠错。
5. **自主执行与崩溃恢复**：优先队列与 `nowadays-autonomy` 自定义窗口、`autonomy_budget` 每日点数／工具预留与次日零点恢复、以及进程重启后的完整启动恢复链。
6. **首次配置引导（`278 §4`）**：桌面空白态创建角色、模型绑定返回、`开始对话（先恢复活动）` 与对话页 `waitReason` 就地恢复入口。

### 1.2 边界分工（不在此处重复）

- **角色活动三态、资源绑定／影响分析、模型维护窗口与删角色删资源流程**：见 [角色配置、全局资源与活动守卫规范](role-config-and-activity.md)。
- **窗口消息快照与游标、1 秒正在输入状态、`submissionId` 提交去重、句段切分、SSE 事件流与过场图**：见 [对话演出、输入状态、SSE 与过场图规范](conversation-performance-and-scene-images.md)（原 `174 §8`）。
- **TTS 桥接、ComfyUI 文生图与服务凭据细则**：见 [TTS 与生图服务接入规范](tts-and-image-services.md)。
- **桌面设计令牌与 CLI 逐条用法**：见 [前端设计规范](frontend-design-system.md) 与 [后端 README](../../backend/README.md)。

### 1.3 上游产品决定（[161 持续决策记录](../161-digital-life-direction-decisions.md)）

| 决定编号 | 核心约束 | 工程落点与当前边界 |
| --- | --- | --- |
| [DL-01](../161-digital-life-direction-decisions.md#dl-01-产品中心nowadays-是数字生命的载体)～[DL-06](../161-digital-life-direction-decisions.md#dl-06-agent-核心采用-langgraph-typescript-编排) · [DL-47](../161-digital-life-direction-decisions.md#dl-47-数据隔离每个角色独立-sqlite-数据库) | Nowadays 为中心、单角色独立分库＋工作空间、多窗口独立上下文、全角色共享长期记忆、LangGraph TS 统一编排 | `<app-root>/data/roles/<roleId>/`＋`execution.sqlite`；无分枝回档（`DL-54`） |
| [DL-07](../161-digital-life-direction-decisions.md#dl-07-自主活动属于核心设计目标)～[DL-14](../161-digital-life-direction-decisions.md#dl-14-角色工作空间独立持久保存默认位于-nowadays-所在目录) · [DL-35](../161-digital-life-direction-decisions.md#dl-35-mcp支持外部工具接入)～[DL-39](../161-digital-life-direction-decisions.md#dl-39-扩展分工外部工具统一-mcp方法知识采用通用-skill) | 自主活动为核心目标；外部工具统一 MCP、方法知识用通用 Agent Skills；仅启停开关，不加权限审批 | 本地 stdio MCP 随库提供；远程 MCP（`DL-115`）后置 |
| [DL-48](../161-digital-life-direction-decisions.md#dl-48-状态更新角色自主提出局部变化核心校验保存)～[DL-53](../161-digital-life-direction-decisions.md#dl-53-工具异常明确失败自主处理结果未知先核查) · [DL-58](../161-digital-life-direction-decisions.md#dl-58-skill-脚本第一版支持执行内容与环境由用户负责) | 状态局部浅合并并程序校验；新用户消息优先进入下轮决策；工具未知先核查补录；Skill 内容／环境用户自担 | 内部 `state_update`、`tool_reconcile`、`skill_run` |
| [DL-16](../161-digital-life-direction-decisions.md#dl-16-记忆基础以经历事件组织记忆关联原始证据)～[DL-30](../161-digital-life-direction-decisions.md#dl-30-重启恢复结合当前情况重新评估安排) · [DL-100](../161-digital-life-direction-decisions.md#dl-100-记忆并发修改旧结果不覆盖新版本受影响内容重新处理) | 证据→事件→100 轮低召回日摘要＋工作空间 Markdown 日记；模型判语义、程序校验版本号并保存，保留全部原始证据 | 纠错只改事件／摘要并写修订；不改原始对话与工具观测（`DL-57`） |
| [DL-101](../161-digital-life-direction-decisions.md#dl-101-新消息替代旧回复新决策重新组织回答原任务与工具独立延续)～[DL-111](../161-digital-life-direction-decisions.md#dl-111-混合模型调用按发起目的计一次后续工具分别归属) | 插话替代前台回复但不中断原任务／已派发工具；自主任务每次模型与外部工具调用各扣 1 点（每日 200／不限，本地零点重置），用户任务与记忆维护豁免 | `autonomy_budget` ＋ `autonomy_tool_reservations` |
| [DL-116](../161-digital-life-direction-decisions.md#dl-116-真实模型首轮联调p2-完整链路具备后单独验证) · [DL-124](../161-digital-life-direction-decisions.md#dl-124-记忆整理模型默认继承对话模型支持角色单独绑定)～[DL-127](../161-digital-life-direction-decisions.md#dl-127-整理容量按可用上下文分批超长记录分段且原文完整保留) | 记忆继承对话模型或独立绑定；失败后台退避重试且**不自动换模型**；按模型可用容量分批分段 | `ModelBindingResolver.resolveMemory` ＋ `MemoryService` 序列化预算校验 |

---

## 2. 存储布局、Schema、核心接口与错误码

### 2.1 应用目录与 SQLite 分库规范

由 [config.ts](../../backend/src/bootstrap/config.ts#L6-L89) 与 [role-storage.ts](../../backend/src/storage/role-storage.ts#L8-L72) 约束数据路径：

| 路径 | 职责与版本 | 关键约束 |
| --- | --- | --- |
| `<app-root>/data/app.sqlite` | 全局索引库（`APP_SCHEMA_VERSION = 7`，8 张表） | 存 `roles` 索引（`initializing`/`ready`/`failed`）、`resources`、`resource_secrets`、`model_test_calls`、`image_services`、`role_activity`、`resource_deletions`、`role_deletions` |
| `<app-root>/secrets/master.key` | 本地主密钥盒（AES-256-GCM `v1`） | [secret-cipher.ts](../../backend/src/security/secret-cipher.ts#L20-L100) `0o700` 目录／`0o600` 密钥文件，竞争写使用 `flag: "wx"` |
| `.../roles/<roleId>/business.sqlite` | 角色业务库（`BUSINESS_SCHEMA_VERSION = 17`，45 张表） | 含核心会话（`roles`/`windows`/`messages`/`tasks`/`executions`/`task_notes`）、工具计量（`tool_calls`/`tool_results`/`call_metering`）、记忆（`evidence_*`/`memory_*`/`daily_summaries`/`diaries`/`memory_search_fts`）、自主（`autonomy_*`）及外观／语音／生图演出表（分归规范 #1～#3） |
| `.../roles/<roleId>/execution.sqlite` | 图检查点库（`EXECUTION_SCHEMA_VERSION = 1`） | `@langchain/langgraph-checkpoint-sqlite` 的 `SqliteSaver` 专用 |
| `.../roles/<roleId>/workspace/` | 角色独立工作空间 | 本地 MCP 根目录；日记落盘 `diaries/YYYY-MM-DD/<diaryId>.md`；外观／语音／过场图分置同级 `appearance/`、`voice/`、`scene-images/` |

- **统一 PRAGMA 与强校验**（[schema.ts](../../backend/src/storage/schema.ts#L1644-L1738)）：全部连接强制开启 `journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`。打开时在同一事务内校验 `user_version`、必需表、索引（含部分索引 `WHERE`）、必需列以及 `memory_search_fts`（FTS5 `trigram`），缺任一项直接 fail-closed；跨库变更通过 [transaction-group.ts](../../backend/src/storage/transaction-group.ts#L14-L45) 的 `runWithDecisionCommit` 由 `app.sqlite` 先提交，从库失败留待读侧过滤或启动清理。

### 2.2 核心 HTTP API 与 CLI 约定

以下汇总本专项主控的 HTTP 路由（[routes.ts](../../backend/src/http/routes.ts#L111-L925)；其余活动、资源、窗口快照、SSE、TTS 与生图路由见规范 #1～#3）。所有路由监听 `127.0.0.1`（默认端口 `3210`），JSON 上限 `1 MiB`，错误统一为 `{ error: { code, message, details? } }`，不回传凭据或堆栈。CLI（[commands.ts](../../backend/src/cli/commands.ts#L6-L51)）仅调用本地 HTTP，不直接打开 SQLite。

| 组别与路由 | 核心字段／查询 | 说明与典型校验／错误码 |
| --- | --- | --- |
| `GET /v1/health` | — | 返回服务存活与版本 |
| `GET /v1/roles` · `POST /v1/roles` · `POST /v1/roles/:roleId/initialize` | `displayName`, `definition{text,payload?}`, `state?` | 列表含 `status`(`initializing`/`ready`/`failed`) 与 `defaultWindowId`；初始化幂等重试（`ROLE_INITIALIZATION_FAILED`、`ROLE_NOT_READY`） |
| `GET /v1/roles/:roleId` · `PATCH /v1/roles/:roleId/definition` · `GET/PUT /v1/roles/:roleId/state` | `expectedRevision` / `expectedVersion` | 受活动守卫的写路径校验详见规范 #1；版本冲突返回 `409 REVISION_CONFLICT` / `STATE_VERSION_CONFLICT` |
| `GET /v1/roles/:roleId/executions/:executionId` · `GET /v1/roles/:roleId/tasks` · `GET .../tasks/:taskId` · `POST .../tasks/:taskId/finish` | `finish` 传 `{status:"completed"|"failed", endReason}` | `finish` 幂等重放；已按另一终态结束返回 `409 TASK_STATE_CONFLICT` |
| `GET /v1/roles/:roleId/autonomy` · `GET/PUT .../autonomy/budget` · `GET/POST .../wakes` · `DELETE .../wakes/:wakeId` · `GET .../activities` | `dailyLimit`（`1..1_000_000`）, `unlimited`, `wakeAt`, `intent`, `taskId?` | 写预算受角色活动守卫；过去时间 `400 AUTONOMY_WAKE_TIME_PAST` |
| `POST /v1/roles/:roleId/memory/search` · `GET/PATCH .../events/:eventId` · `GET .../evidence/:evidenceId` · `GET/PATCH .../summaries/:summaryId` | `query`/`types`/标签/`dateFrom`/`dateTo`/`limit`; 纠错必带 `expectedVersion` | 手动查询不写 `memory_recalls`；版本过期返回 `409 MEMORY_VERSION_CONFLICT`；区分空列表与 `500 MEMORY_QUERY_FAILED` |
| `GET/POST /v1/roles/:roleId/diaries` · `GET /v1/roles/:roleId/diaries/:diaryId` | `content`, `eventIds?`, `occurredAt?` | 创建写原子临时文件改名落盘；读取 `:diaryId` 同步刷新 Markdown 哈希快照（文件缺失 `500 DIARY_FILE_MISSING`） |
| `GET /v1/roles/:roleId/memory/status` · `GET/POST /v1/roles/:roleId/memory/batches` | `limit?`（默认 `50`） | `GET` 查询状态与批次；`POST .../batches` 登记 `manual` 触发并做去重（角色删除中返回 `409 ROLE_DELETING`，否则异步返回 `202 { triggerId, duplicate }`；`MEMORY_BATCH_CONFLICT` 仅用于后台 `runBatch` 并发锁） |

### 2.3 本领域主要错误码（[errors.ts](../../backend/src/domain/errors.ts#L17-L510)）

| 分类 | HTTP 状态与错误码 |
| --- | --- |
| 存储与初始化 | `400 INVALID_ROLE_ID`、`404 ROLE_NOT_FOUND`、`409 ROLE_NOT_READY`、`500 ROLE_INITIALIZATION_FAILED`、`500 STORAGE_ERROR`、`500 SCHEMA_MIGRATION_FAILED`、`500 FTS5_UNAVAILABLE` |
| 执行、任务与工具 | `404 TASK_NOT_FOUND`／`EXECUTION_NOT_FOUND`／`TOOL_CALL_NOT_FOUND`／`TOOL_RESULT_NOT_FOUND`、`409 EXECUTION_NOT_RUNNING`／`EXECUTION_SUPERSEDED`／`TASK_ENDED`／`TASK_STATE_CONFLICT`／`TOOL_RESULT_CONFLICT`／`TOOL_CALL_STATUS_CONFLICT`、`400 INVALID_TOOL_CALL_REFERENCE` |
| 记忆、日记与 Skill | `404 MEMORY_EVENT_NOT_FOUND`／`MEMORY_SUMMARY_NOT_FOUND`／`DIARY_NOT_FOUND`／`SKILL_NOT_FOUND`、`400 INVALID_MEMORY_CORRECTION`／`SKILL_FILE_INVALID`、`409 MEMORY_VERSION_CONFLICT`／`ROLE_DELETING`（`MEMORY_BATCH_CONFLICT` 为后台 `runBatch` 并发锁）、`500 MEMORY_OPERATION_INVALID`／`MEMORY_QUERY_FAILED`／`DIARY_FILE_MISSING`、`502 MEMORY_CAPACITY_EXCEEDED` |
| 自主与模型调用 | `400 AUTONOMY_WAKE_TIME_INVALID`／`AUTONOMY_WAKE_TIME_PAST`／`AUTONOMY_SHARE_EMPTY`、`409 AUTONOMY_BUDGET_EXHAUSTED`、`500 MODEL_BINDING_MISSING`／`MODEL_CREDENTIAL_UNAVAILABLE`、`502 MODEL_REQUEST_FAILED`／`MODEL_TOOL_ARGUMENTS_INVALID`、`504 MODEL_REQUEST_TIMEOUT` |

---

## 3. 核心机制、状态机与约束

### 3.1 角色创建与 4 步初始化

[RoleService](../../backend/src/application/role-service.ts#L66-L153) 创建角色按顺序执行：(1) `app.sqlite` 插入 `initializing` 索引与初始 payload；(2) `role_activity` 默认设为 `stopped`（`268 §4`：先配置模型再显式开始）；(3) 创建角色目录、初始化 `business.sqlite`／`execution.sqlite` 并生成默认 `main` 窗口（`source="nowadays"`）；(4) 标记 `ready`。任一步失败记录错误信息为 `failed` 并抛出 `ROLE_INITIALIZATION_FAILED`，后续 `POST /v1/roles/:roleId/initialize` 幂等补齐缺失结构。

### 3.2 Agent 图执行、慢工具转后台与任务链决策（`GAP-01`～`GAP-03`、`GAP-05`）

- **图编排与模型续轮**：[AgentGraphRunner](../../backend/src/application/agent-graph.ts#L159-L260) 构建 `START -> model <-> tools -> END` 双节点 `StateGraph`（以 `execution.sqlite` 持久化检查点，默认最多 `8` 轮模型／工具回合）。[ModelPort](../../backend/src/model/protocols.ts) 统一适配 `openai-chat`、`openai-responses` 与 `anthropic-messages`；相同 `protocol + baseUrl + modelName` 间原样回传厂商 `continuation` 块，配置变更则切回归一化历史；上游请求异常或提前 EOF 直接报错并保留已收到增量，**不自动切换其他模型**。
- **工具目录与本地 MCP 隔离**（[agent-tools.ts](../../backend/src/application/agent-tools.ts#L48-L1552)）：
  - **内部工具**：`memory_{search,event,evidence,summary,summary_evidence,correct_event,correct_summary,diary}`、`diary_write`、`state_update`、`autonomy_{schedule,share}`、`skill_{read,run}`、`task_{progress,pause,finish}`、`tool_reconcile`。
  - **本地 stdio MCP**（[local-server.ts](../../backend/src/mcp/local-server.ts#L21-L260)）：提供 `workspace_{read,write,search}` 与 `command_run`（`shell: false`、继承用户环境，不做额外内容审批或沙箱）；`safePath` 在读前和写建目录前校验 `realpath`（含最近存在祖先）严格位于 `workspace/` 内，拒绝经 junction／symlink 越界。
- **内部步骤幂等（`executeInternal`）**：[executeInternal](../../backend/src/application/agent-graph.ts#L1005-L1061) 生成稳定步骤键 `tool:<executionId>:<round>:<index>:<name>`，执行副作用前先写 `tool_started` 凭据并记自主计量；恢复或重放遇到仅开始凭据时归档 `unknown / PROCESS_INTERRUPTED`，不重复写日记或外部副作用。
- **慢工具自动转后台（`GAP-01`／`R04`）**：[executeExternalTracked](../../backend/src/application/agent-graph.ts#L756-L955) 默认以 `DEFAULT_TOOL_FOREGROUND_WAIT_MS = 2000` 毫秒为前台窗口（包含 MCP 二次握手）。超时而当前执行未停止时，切换工具调用模式为 `background`、追加 `tool_backgrounded` 流事件、结束当前前台图等待同时保留用户消息认领与 `task_resource_continuations`；后台结算由 [handleBackgroundToolSettled](../../backend/src/application/conversation-service.ts#L2431) 用全新数据库句柄重查任务状态并排队续行。若超时前已被新消息替代，则不再转后台，等待该调用自然收尾。
- **任务暂停、继续、结束与 `unknown` 补录（`GAP-02`／`GAP-03`／`R01`～`R02`）**：`task_pause` 与 `task_finish` 在回复提交同一事务中写入 `executions.task_decision_json`，由 [applyCommittedTaskDecision](../../backend/src/application/conversation-service.ts#L2515) 落实暂停（保留原任务号与 `task_resource_continuations`）或终结（触发记忆整理）；未声明决策按 `completed / 回复完成` 收尾。`tool_reconcile` 经 `resolveToolCallReference` 将模型 wire ID 映射到业务 `toolCallId`，并在事务内强制校验 `requireReconciledFromUnknown`（`pending`/`running`/已定案调用一律拒绝为 `409 TOOL_CALL_STATUS_CONFLICT`），冲突结论报 `TOOL_RESULT_CONFLICT`。
- **Skill 按需与脚本执行（`GAP-05`／`R03`）**：上下文仅加载 `SKILL.md` frontmatter 元数据；[SkillLibrary.resolveScript](../../backend/src/skills/skill-library.ts#L104-L135) 校验目标位于启用 Skill 目录内的 `.js`/`.mjs` 后，由 `skill_run` 以 `shell: false`、Skill 目录为 `cwd`、注入 `NOWADAYS_WORKSPACE` 启动子进程；即使前台收到用户插话替代回复，已派发脚本仍运行至结束或触发 `SKILL_SCRIPT_TIMEOUT` 才结算归原调用。

### 3.3 记忆形成、容量预算、检索与主客观演化（`GAP-04`、`GAP-06`、`306`）

- **触发、串行与模型继承**：证据在消息入库与工具结算时写入 `evidence_records` 并按当时配置时区固定 `experience_date`。同一角色经 `idx_memory_batch_single_running` 与 [MemoryRuntime](../../backend/src/application/memory-runtime.ts#L60-L413) 双重约束保持单批串行且不阻塞聊天。触发条件为同窗待处理消息 `>=50`（`message_threshold`）、`>=30` 且停歇 `60s`（`idle`）、任务进入 `completed`/`failed` 或晚到工具结果补记（`task_end`）及 `manual`。模型通过 `resolveMemory` 取启用的 `memory_model`，未单独绑定则继承 `chat_model`；缺绑定、角色删除中或模型维护时保留触发与进度、暂不调度；失败按 `[30s, 2m, 10m, 1h]` 退避（之后维持 1 小时），**不自动换模型**；角色目录暂时缺失或 `SQLITE_BUSY` 时暂停轮询并保留启动恢复标记（[283 §26](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#26-306-补修独立复验)）。
- **容量分批与严谨 JSON 校验（`GAP-04`／`R06`）**：[MemoryService](../../backend/src/application/memory-service.ts#L112-L345) 在绑定模型声明 `maxInputChars`／`maxOutputChars` 时，按完整请求（系统提示 ＋ `1000` 骨架冗余 ＋ 候选元数据 ＋ JSON 转义后证据分段 `memory_evidence_segments` ＋ 输出预留）核算预算并在发送前复检 `assertRequestCapacity`；未声明时使用保守默认（`DEFAULT_MEMORY_BUDGET_CHARS = 24_000`、`DEFAULT_OUTPUT_RESERVE_CHARS = 4_000`、`requestOverheadChars = 2_000`）。每子批校验严格 JSON schema 后原子提交并推进证据状态，任一操作失败整批回滚（已提交前序子批保留）。
- **混合检索、召回与 100 轮精炼**：[MemoryQueryService](../../backend/src/application/memory-query-service.ts#L83-L600) 统一检索 `active` 事件、日常摘要与日记：`>=3` 字符词元走 `FTS5 trigram`（`bm25`），`1～2` 字符走转义 `LIKE`；支持 `今天`／`昨天`／`前天` 与 `YYYY-MM-DD` 相对日期及角色隔离。只有进入模型上下文的命中（`decision_round` 非空）才按 `(executionId, record)` 去重写入 `memory_recalls`；创建／最近补充起满 `>=100` 轮且最近 100 轮召回 `<=1` 次的 `active` 事件进入 `refineCandidates`，同日（`experienceDate`）可创建或经 `expectedSummaryVersion` 补充 `daily_summaries`，精炼后事件退为 `refined` 并删全文检索项、保留全部原始证据。
- **日记文件与主观分离（`GAP-06`）**：日记写入工作空间 Markdown 文件，读取 `getDiary`／Agent 工具 `memory_diary`（经 `getDiarySegment` 按 Unicode 码点切片，默认 `4000`、上限 `20_000` 字符）时比对 SHA-256，外部修改实时回写快照与检索索引。角色 `state_update` 仅在决策提交同一事务内浅合并更新（乐观锁），后台整理不可直接改动当前状态；纠错仅改事件／摘要并写 `memory_revisions`。

### 3.4 自主活动调度与统一额度预算（`186`＋`190`）

- **优先级与窗口**：调度优先处理待处理用户消息 → 到期或中断后待续任务（含带原 `taskId` 唤醒）→ 到期 `autonomy_wakes`；自主推进使用懒创建的 `nowadays-autonomy` 自定义窗口，仅当角色显式调用 `autonomy_share` 时向主窗口写入主动消息并推送 SSE。
- **额度口径与跨日预留**：[AutonomyService](../../backend/src/application/autonomy-service.ts#L35-L475) 默认每日 `200` 点（可设 `unlimited`），在本地零点随 `localDate` 重置且不累计余额。**只有 `autonomous` 来源执行与其工具调用扣点**；由带原 `taskId` 唤醒续跑的 `origin="user"` 任务沿用 `user_chat / counted=0`（`198 R05`）。外部工具在连接建立前按派发时刻写入 `autonomy_tool_reservations`；实际派发立即提交（跨日重启补记仍归原 `localDate`），未派发失败则退还预留；额度耗尽时 `pauseForBudget` 保留原任务进度并自动安排次日零点 `budget_resume` 唤醒（`AUTONOMY_BUDGET_EXHAUSTED`）。

### 3.5 启动崩溃恢复顺序（`app.ts`＋`P4`＋`198 R01`＋`306`）

进程启动时按 [app.ts](../../backend/src/bootstrap/app.ts#L244-L349) 固定顺序收敛上次异常退出遗留状态：
1. `memoryRuntime.recoverOnStartup()` 将 `running` 批次标记 `failed (PROCESS_INTERRUPTED)`，回退未提交 `processing` 证据保留已提交子批与待处理触发（目录暂不可用则登记 `pendingStartupRecoveryRoles` 待就绪后先补救）；
2. [conversation.recoverOnStartup()](../../backend/src/application/conversation-service.ts#L653-L760) 逐角色检查 `execution.sqlite` 可续跑检查点生成 `resumableIds` → 清理中断 `model_calls` → `reconcileInterruptedInternalTools()` 将 started-only 内部操作归档 `unknown` 并按原日期补账 → `reconcileToolReservations()` 结算工具预留 → `recoverInterruptedExecutions()` 把非续跑执行转为失败／中断并按最新流标记分段保存半截输出为 `interrupted` 消息 → 将遗留外部工具标为 `unknown` → `reconcileCommittedGaps()` 应用尚未落实的 `task_decision_json`（按同任务最新执行择一且排除已有更晚主执行或续行记录的历史旧暂停，`198 R01`）→ 将仍为 `active` 的自主／用户任务重新入队恢复；
3. `activity.reconcileStartup()` 收敛无在途工作的 `stopping` 记录 → `resourceService.reconcilePendingDeletions()` → `sceneImages.recoverOnStartup()` → `roleDeletion.reconcilePendingDeletions()`。

### 3.6 首次配置引导与对话恢复流（`278 §4`）

1. **空白态创建角色**：[Home.tsx](../../desktop/desk-preview/renderer/src/pages/Home.tsx#L75) 与 [Conversation.tsx](../../desktop/desk-preview/renderer/src/pages/Conversation.tsx#L382-L386) 在无角色时渲染 `创建角色` 按钮打开 [Settings.tsx](../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L224) 新建表单；新建后角色活动默认 `stopped` 以便先配置绑定。
2. **对话模型绑定与启动入口**：在角色配置「模型 → 对话」选中保存服务与模型名（`Settings.tsx#L600-L602`）且存在已启用 `chat_model` 后，展示 `开始对话（先恢复活动）`／`开始对话` 按钮，必要时调用 `/activity/resume` 并跳转到对话页（[App.tsx#L155](../../desktop/desk-preview/renderer/src/App.tsx#L155)）。
3. **对话页 `waitReason` 与就地恢复**：[ChatPane.tsx#L300-L315](../../desktop/desk-preview/renderer/src/conversation/ChatPane.tsx#L300-L315) 与 [use-window-session.ts#L816-L829](../../desktop/desk-preview/renderer/src/conversation/use-window-session.ts#L816-L829) 区分三类等待与拒绝：`MODEL_MISSING` 提供 `配置对话模型`＋`重试`；`ROLE_STOPPED` 与发送被拒（`ROLE_ACTIVITY_STOPPED`）保留当前草稿并提供 `恢复活动` 按钮（前者随后自动以原 `submissionId` 重试，后者清除拒收提示由用户重发）；`WINDOW_BLOCKED` 提示当前窗口不可继续。
4. **已知实现与目标差异**：当前从 `Conversation` 点击 `配置对话模型` 进入设置再点 `开始对话` 会重置到该角色的 `defaultWindowId`（因切页卸载 `ConversationPage`，未保留原自定义子窗口 ID），属于 `283 §3` 标出的待联调项之一。

---

## 4. 已验证范围、未实现／未验证边界与验证命令

### 4.1 覆盖边界矩阵

| 类别 | 范围与依据 |
| --- | --- |
| **已通过离线／本机假端点独立复验** | • P0～P5 全部后端链路（[184](../archive/01-backend-prototype/184-p2-06-acceptance-report.md)、[188](../archive/01-backend-prototype/188-p3-independent-review.md)、[190](../archive/01-backend-prototype/190-p4-recovery-acceptance-report.md)、[195](../archive/01-backend-prototype/195-p5-independent-review.md)）<br>• `GAP-01`～`GAP-06` 离线能力补齐（[198 第三轮复验](../archive/01-backend-prototype/198-p5-capability-gaps-independent-review.md#r01-第三次补修的独立复验) 关闭 `R01`～`R06`）<br>• 任务结束记忆整理与存储／目录异常恢复（[283 §26](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#26-306-补修独立复验)）<br>• 另：最新本地全量基线为 `407/407` 后端单测、`21/21` 步 `accept-offline.mjs`（`realServiceCalls=0`）、`125/125` 桌面逻辑测试（见 [STATUS.md](../STATUS.md#1-当前结论概览)） |
| **已确认但未实现** | • `DL-115` 远程 Streamable HTTP MCP（排期于桌面端收口后）<br>• [196 管理与体验候选](../archive/01-backend-prototype/196-backend-capability-gap-plan.md#管理与体验候选) 13 项（角色导出导入、取消待处理消息、资源归档、MCP 测试连接、全量按用途 Token 统计、全局端口／目录 GUI 设置、诊断导出包、离开期间未读摘要、消息附件／图片理解、定时一致性备份与恢复）<br>• [196 `OPS-01`～`OPS-04`](../archive/01-backend-prototype/196-backend-capability-gap-plan.md#同类功能排查)（失败执行主动重试入口、窗口当前执行聚合快照、按角色独立暂停自主活动开关、任务／活动／日记游标分页与筛选） |
| **已实现但待真实服务／端到端独立验收** | • `278 §4` 首次配置完整链路、自定义子窗口返回、重连恢复等待状态与模型失效重验（见 [279 §3](../archive/06-workflow-simplification/279-workflow-simplification-two-pass-review.md#3-第三轮端到端复核) 与 [283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)）<br>• 非历史 DeepSeek Anthropic Messages 之外的真实模型服务兼容、真实上游流式中断＋续传恢复、真实第三方 Skill 环境依赖<br>• `toolForegroundWaitMs`（原型默认 `2000ms`）按真实工具延时校准、多后端并发与更广泛 SQLite 损坏场景 |

### 4.2 可运行验证命令

```powershell
# 1. 后端类型检查与全部正式单元测试（须 Node 24；离线模型与本地工具样例）
cd backend
npm run typecheck
npm test

# 2. 后端 P0～P5 + 离线完整 21 步验收脚本（输出到 backend/test-results/）
npx -y node@24 scripts/accept-offline.mjs

# 3. 桌面渲染器检查 + 桌面逻辑测试（292-R08 已切换为 desktop/desk-preview 优先的 electron-executable.cjs 解析并完成无根 node_modules 隔离复验）
cd ../desktop/desk-preview/renderer
npm run check
npm run build
cd ..
npx -y node@24 --test tests/*.test.cjs

# 4. 文档链接与规范巡检
node scripts/check-docs.mjs
```

---

## 5. 遗留问题、源码索引与归档溯源

### 5.1 遗留问题与后续入口

- `278 §4` 首次配置、返回来源窗口与断线等待原因尚未经过端到端独立复验（参见 [STATUS.md](../STATUS.md#2-当前待推进事项backlog) 与 [283 §3／§27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)）。
- E2E 启动依赖隔离（`292-R08`）已切到优先解析 `desktop/desk-preview/node_modules/electron` 并保留环境变量与开发机根目录兜底，已在无根目录 `node_modules` 的干净隔离目录实测通过（见 [292 §8～§9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#8-292-r05292-r08-补修与自验生图停用拦停跨页探测样图失效预览服饰归属与-e2e-依赖解析)），独立复验及真包交付进度见 [状态页](../STATUS.md)。
- 远程 MCP（`DL-115`）、备份／恢复／诊断／失败主动重试（`196` 候选与 `OPS`）按 [STATUS.md](../STATUS.md) 优先级推进前逐项确认产品决定。

### 5.2 主要源码索引

| 分层 | 核心文件 |
| --- | --- |
| 启动、配置与加密 | [config.ts](../../backend/src/bootstrap/config.ts) · [app.ts](../../backend/src/bootstrap/app.ts) · [secret-cipher.ts](../../backend/src/security/secret-cipher.ts) |
| 存储引擎与事务 | [schema.ts](../../backend/src/storage/schema.ts) · [role-storage.ts](../../backend/src/storage/role-storage.ts) · [checkpoint-store.ts](../../backend/src/storage/checkpoint-store.ts) · [transaction-group.ts](../../backend/src/storage/transaction-group.ts) · [app-store.ts](../../backend/src/storage/app-store.ts) · [role-store.ts](../../backend/src/storage/role-store.ts) · [conversation-store.ts](../../backend/src/storage/conversation-store.ts) · [memory-store.ts](../../backend/src/storage/memory-store.ts) · [autonomy-store.ts](../../backend/src/storage/autonomy-store.ts) |
| 角色、图执行与工具 | [role-access.ts](../../backend/src/application/role-access.ts) · [role-service.ts](../../backend/src/application/role-service.ts) · [conversation-service.ts](../../backend/src/application/conversation-service.ts) · [agent-graph.ts](../../backend/src/application/agent-graph.ts) · [agent-tools.ts](../../backend/src/application/agent-tools.ts) · [model-binding-resolver.ts](../../backend/src/application/model-binding-resolver.ts) · [local-server.ts](../../backend/src/mcp/local-server.ts) · [client.ts](../../backend/src/mcp/client.ts) · [skill-library.ts](../../backend/src/skills/skill-library.ts) |
| 记忆、自主与通信 | [memory-service.ts](../../backend/src/application/memory-service.ts) · [memory-runtime.ts](../../backend/src/application/memory-runtime.ts) · [memory-query-service.ts](../../backend/src/application/memory-query-service.ts) · [autonomy-service.ts](../../backend/src/application/autonomy-service.ts) · [routes.ts](../../backend/src/http/routes.ts) · [errors.ts](../../backend/src/domain/errors.ts) · [commands.ts](../../backend/src/cli/commands.ts) |
| 桌面首次配置入口 | [App.tsx](../../desktop/desk-preview/renderer/src/App.tsx) · [Home.tsx](../../desktop/desk-preview/renderer/src/pages/Home.tsx) · [Conversation.tsx](../../desktop/desk-preview/renderer/src/pages/Conversation.tsx) · [Settings.tsx](../../desktop/desk-preview/renderer/src/pages/Settings.tsx) · [ChatPane.tsx](../../desktop/desk-preview/renderer/src/conversation/ChatPane.tsx) · [use-window-session.ts](../../desktop/desk-preview/renderer/src/conversation/use-window-session.ts) |

### 5.3 归档与独立复核溯源

- **P1 角色与存储**：[169 P1 开发文档](../archive/01-backend-prototype/169-p1-role-storage-development-guide.md) · [170 P1 契约](../archive/01-backend-prototype/170-p1-01-contract.md) · [171 实现记录](../archive/01-backend-prototype/171-p1-implementation-record.md) · [172 独立复验](../archive/01-backend-prototype/172-p1-independent-review.md)
- **P2 记忆、Agent 与本地 MCP／Skill**：[173 开发文档](../archive/01-backend-prototype/173-p2-memory-agent-development-guide.md) · [174 P2 契约](../archive/01-backend-prototype/174-p2-01-memory-agent-contract.md) · [180 回复链记录](../archive/01-backend-prototype/180-p2-05-agent-conversation-record.md) · [184 整体验收](../archive/01-backend-prototype/184-p2-06-acceptance-report.md)
- **P3 自主推进**：[186 开发文档](../archive/01-backend-prototype/186-p3-autonomy-development-guide.md) · [187 实施记录](../archive/01-backend-prototype/187-p3-autonomy-implementation-record.md) · [188 独立复验](../archive/01-backend-prototype/188-p3-independent-review.md)
- **P4 崩溃恢复**：[190 验收报告](../archive/01-backend-prototype/190-p4-recovery-acceptance-report.md) · [191 修复记录](../archive/01-backend-prototype/191-p4-recovery-fix-record.md)
- **P5 交付与 GAP-01～06 能力补齐**：[193 交付指南](../archive/01-backend-prototype/193-p5-prototype-delivery-guide.md) · [195 整体复核](../archive/01-backend-prototype/195-p5-independent-review.md) · [196 缺口计划](../archive/01-backend-prototype/196-backend-capability-gap-plan.md) · [197 实施记录](../archive/01-backend-prototype/197-p5-capability-gaps-implementation-record.md) · [198 独立复核](../archive/01-backend-prototype/198-p5-capability-gaps-independent-review.md) · [199 修复记录](../archive/01-backend-prototype/199-p5-gaps-review-fix-record.md)
- **操作链路简化与记忆收口**：[278 §4 首次配置](../archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md#4-第一次配置与对话恢复) · [279 端到端场景](../archive/06-workflow-simplification/279-workflow-simplification-two-pass-review.md#3-第三轮端到端复核) · [283 §26 记忆复验／§27 文档与待测](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#26-306-补修独立复验)
