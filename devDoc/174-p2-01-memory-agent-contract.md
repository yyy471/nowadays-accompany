# P2-01 事件记忆与对话执行契约

日期：2026-11-03。

状态：**P2-01 契约固定；P2-02～P2-04 已实现并自验，P2-04 本地离线范围通过[178 第 6 节](178-p2-04-independent-review.md)独立复验。** 本文落实 173 的工程契约，不表示完整 P2 联动或真实模型已验收。P1 基线见 170、172，实现方记录见 175～177、179。

依据：[持续决策记录](161-digital-life-direction-decisions.md) DL-16～DL-28、DL-48、DL-51、DL-56、DL-57、DL-64、DL-70、DL-71、DL-77～DL-84、DL-87～DL-100、DL-104～DL-111、DL-116～DL-128；[执行清单](164-backend-prototype-execution-checklist.md)；[P2 开发文档](173-p2-memory-agent-development-guide.md)。

## 1. 固定边界

- P2 在现有 `backend/` 内完成“实际记录形成记忆 → 多维检索与维护 → Agent 按需深入后回复”的闭环，仍为单角色验收、一个 TypeScript 后端进程、本地 HTTP／SSE。
- 后台整理与实时回复独立调度；整理不占用角色决策位置，聊天不等待整理完成。
- P2 只接受实际保存的消息、实际工具结果和角色自主写下的日记作为记忆来源；模型草稿、计划、未执行工具请求不进入证据。
- 原始消息、工具原始响应和实际观测不改写；纠错只修改整理后的事件、摘要与索引。
- 不增加固定事件等级、人工审核、逐次授权、内容预检或自动换模型。
- 自主唤醒、定时日记、完整额度周期归 P3；完整退出／重启组合验收归 P4；远程 MCP 归 P5 后。
- 本文固定工程承载；未确认的用户可见行为列在第 16 节，不由本文默认为新决定。

## 2. 运行时、依赖与模块布局

继续使用 Node.js 24.22.2 / win32-x64、TypeScript 5.9.3、tsx 4.23.15、better-sqlite3 12.10.0、zod 4.6.7、`node:http`、`node:test`。

P0 已验证的编排依赖作为 P2 候选基线：

| 用途 | 候选 | 说明 |
| --- | --- | --- |
| 图编排 | `@langchain/langgraph` 1.6.0、`@langchain/core` 1.3.4 | 沿用 P0 已验证 API；P2-05 复验 |
| 检查点 | `@langchain/langgraph-checkpoint-sqlite` 1.1.0 | 每个角色仍使用独立 `execution.sqlite` |
| 本地 MCP | `@modelcontextprotocol/sdk` 1.32.2 | P0 已验证 stdio 客户端；P2-04 扩展本地工具服务 |
| 模型协议 | `openai` 与 `@anthropic-ai/sdk` 候选，或薄 `fetch` 适配 | 三类协议分别验证后锁定版本；不把 P0 脚本模型当作真实协议兼容 |

不引入 ORM、向量数据库、前端框架或按角色部署的服务。模型调用、记忆操作、外部工具各自通过显式接口注入，不创建模块级可变业务单例。

```text
backend/src/
  domain/
    memory.ts              # 证据、事件、摘要、日记、召回、修订类型
    dialogue.ts            # 执行、消息片段、SSE 事件类型
    model.ts               # 统一模型请求／事件／工具协议
  application/
    memory-service.ts      # 形成、检索、精炼、纠错、日记
    chat-service.ts        # 对话调度、执行、中断、提交
    model-service.ts       # 模型列表、连接测试、适配器选择
    role-runtime.ts        # 单角色调度器与运行态，不跨角色共享可变状态
    role-runtime-manager.ts
  storage/
    role-store.ts          # P1 角色／消息／任务／执行基础，保留
    dialogue-store.ts      # 共享同一 business.sqlite 连接的执行与 SSE
    memory-store.ts        # 共享同一 business.sqlite 连接的证据与记忆
    checkpoint-store.ts    # P2-05 改为 SqliteSaver + 版本校验
  runtime/
    graph.ts               # 正式 LangGraph 决策链
    tools/memory-tools.ts  # 进程内记忆工具
    tools/external.ts      # MCP／Skill 工具适配
  model/
    port.ts
    offline.ts             # 脚本化离线模型，与真实模型同一入口
    adapters/openai-chat.ts
    adapters/openai-responses.ts
    adapters/anthropic-messages.ts
  http/
    sse.ts
```

`RoleRuntimeManager` 在应用启动时枚举 `ready` 角色并为每个角色启动独立调度器；角色初始化完成后也注册运行态。关闭应用时先停止调度器，再关闭角色存储和 `app.sqlite`。同一角色的决策与整理各自串行，不共享同一个执行槽位。

### 2.1 运行数据目录

运行数据根为 `<appRoot>/data/`。2026-11-03 用户要求运行数据目录以 `data/` 开头，P1 原 `.nowadays` 名称据此修订；P2 新增表、证据、FTS 和检查点全部位于该目录下的角色分库。当前工作区没有既有运行数据，不自动迁移旧 `.nowadays` 目录。

## 3. Schema 版本与升级路径

| 数据库 | P1 | P2 | 升级方式 |
| --- | --- | --- | --- |
| `app.sqlite` | 1 | 2 | 新增全局模型测试记录表；事务内建表并设置版本 |
| `business.sqlite` | 1 | 2 | 增加消息／执行字段、记忆相关表、索引和 FTS；事务内建表与回填并设置版本 |
| `execution.sqlite` | 1 | 2 | 由 LangGraph 检查点驱动创建 `checkpoints`／`writes`，校验后设置版本 |

通用规则：

- 打开时 `user_version` 等于目标版本才进入正常校验；低于目标版本且等于已知 P1 版本时执行一次显式迁移；高于目标版本返回 `SCHEMA_VERSION_UNSUPPORTED`。
- 已有空文件或版本 0 的业务库仍不在读取路径初始化；只有角色初始化重试允许创建新库。
- 迁移在单个 SQLite 事务内完成；任何 DDL、回填或 FTS 创建失败都回滚，版本保持 1，返回 `SCHEMA_MIGRATION_FAILED`，不留下半迁移结构。
- 迁移不删除 P1 数据、不重建空库、不改变角色目录归属。迁移后重新执行必需表、索引、列和 FTS 校验。
- 新角色直接按 v2 结构创建，不先创建 v1 再迁移。
- FTS5 不可用时启动失败并报告 `FTS5_UNAVAILABLE`，不静默退回纯 LIKE 模式。
- `execution.sqlite` 的检查点表由 `SqliteSaver` 创建；我们校验 `checkpoints`、`writes` 及其必需列后设置 `user_version=2`。若检查点初始化中断，版本保持 1，下次启动重试。

### 3.1 业务库 v1 → v2 迁移步骤

1. 读取并校验 P1 必需表／索引；结构不符合 P1 预期时拒绝迁移，保留现场。
2. 执行第 4.1 节的列扩展和第 4.2～4.8 节的建表、索引、FTS 与触发器 DDL。
3. 为已有 `messages` 回填证据：每条用户和助手消息一条 `evidence_records`，`occurred_at` 使用 `created_at`，`source_status` 使用消息状态，`local_date` 使用迁移时配置的时区换算；按 `occurred_at, source_kind, source_id` 分配角色内递增 `role_sequence`。
4. 为已有 `tool_results` 回填证据：`source_id` 使用 `tool_call_id`，窗口／任务／执行取自 `tool_calls`，`occurred_at` 使用 `saved_at`，状态使用工具结果状态；与消息一起排序后重新分配角色内序号。
5. 为每条证据插入 `evidence_processing(status='pending')`。
6. 设置 `user_version=2`，提交事务，再执行完整 schema 校验。

迁移时无法得知 P1 消息真实发生地的历史时区，`local_date` 以迁移时配置时区解释 `created_at`；该限制记录在 P2 实施记录中。P2 新证据在登记时按当时配置时区计算日期。

## 4. 业务库 v2 结构

以下 DDL 为 v2 目标结构；P1 已存在的表不重复。所有时间为 ISO 8601 UTC 字符串，所有业务 ID 为 UUID v4，流事件编号除外。

### 4.1 现有表扩展

```sql
ALTER TABLE messages ADD COLUMN execution_id TEXT REFERENCES executions(execution_id);
ALTER TABLE messages ADD COLUMN claimed_by_execution_id TEXT REFERENCES executions(execution_id);
ALTER TABLE messages ADD COLUMN processed_by_execution_id TEXT REFERENCES executions(execution_id);

ALTER TABLE executions ADD COLUMN decision_round INTEGER;
ALTER TABLE executions ADD COLUMN superseded_by_execution_id TEXT REFERENCES executions(execution_id);

ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
  CHECK (origin IN ('user', 'autonomous', 'memory'));
ALTER TABLE tasks ADD COLUMN initiator_execution_id TEXT REFERENCES executions(execution_id);
```

- `messages.execution_id` 只用于助手消息，指向产生该消息的执行；用户消息的认领和完成分别使用 `claimed_by_execution_id`、`processed_by_execution_id`。
- 助手消息状态允许 `generating`、`completed`、`interrupted`；用户消息继续使用 `received`。首次文本增量在同一事务内创建 `generating` 助手消息，后续增量写入流事件；提交时更新为 `completed` 并写入完整正文，中断、被替代或出错时更新为 `interrupted` 并写入已产生部分。没有任何文本的执行不创建助手消息。
- `executions.decision_round` 只在该执行完成一次针对用户消息的回复决策时分配，按角色内 `MAX(decision_round)+1` 递增；纯工具、自主活动和后台整理不计轮次。`superseded_by_execution_id` 记录替代关系。
- `tasks.origin` 记录任务来源；P1 已有任务默认 `user`。`initiator_execution_id` 用于同一次决策创建的任务归属。
- 新增索引：

```sql
CREATE UNIQUE INDEX idx_executions_role_round
  ON executions (role_id, decision_round)
  WHERE decision_round IS NOT NULL;

CREATE INDEX idx_messages_pending_decision
  ON messages (window_id, sequence)
  WHERE sender = 'user'
    AND processed_by_execution_id IS NULL
    AND claimed_by_execution_id IS NULL;

CREATE INDEX idx_messages_execution
  ON messages (execution_id)
  WHERE execution_id IS NOT NULL;
```

### 4.2 证据与整理批次

```sql
CREATE TABLE memory_batches (
  batch_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  input_from_sequence INTEGER NOT NULL,
  input_to_sequence INTEGER NOT NULL,
  context_budget_chars INTEGER NOT NULL,
  output_reserve_chars INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_memory_batch_single_running
  ON memory_batches (role_id)
  WHERE status = 'running';

CREATE TABLE memory_triggers (
  trigger_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  kind TEXT NOT NULL CHECK (kind IN ('message_threshold', 'idle', 'task_end', 'manual', 'retry')),
  window_id TEXT REFERENCES windows(window_id),
  task_id TEXT REFERENCES tasks(task_id),
  consumed_at TEXT,
  batch_id TEXT REFERENCES memory_batches(batch_id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_memory_triggers_pending
  ON memory_triggers (role_id, created_at)
  WHERE consumed_at IS NULL;

CREATE TABLE evidence_records (
  evidence_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'tool_result')),
  source_id TEXT NOT NULL,
  window_id TEXT REFERENCES windows(window_id),
  task_id TEXT REFERENCES tasks(task_id),
  execution_id TEXT REFERENCES executions(execution_id),
  source_status TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  role_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_evidence_role_sequence
  ON evidence_records (role_id, role_sequence);

CREATE UNIQUE INDEX idx_evidence_source
  ON evidence_records (role_id, source_kind, source_id);

CREATE INDEX idx_evidence_window_occurred
  ON evidence_records (window_id, occurred_at);

CREATE TABLE evidence_processing (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_records(evidence_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'deferred', 'failed')),
  last_batch_id TEXT REFERENCES memory_batches(batch_id),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  deferred_after_sequence INTEGER,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_evidence_processing_ready
  ON evidence_processing (status, next_retry_at);

CREATE TABLE memory_evidence_segments (
  evidence_id TEXT NOT NULL REFERENCES evidence_records(evidence_id),
  segment_index INTEGER NOT NULL,
  from_char INTEGER NOT NULL,
  to_char INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'failed')),
  batch_id TEXT REFERENCES memory_batches(batch_id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (evidence_id, segment_index)
);

CREATE INDEX idx_memory_segments_batch
  ON memory_evidence_segments (batch_id, status);
```

- 证据只登记实际保存的内容：用户消息与助手回复在执行完成、被替代、失败或中断的同一事务中登记；尚无任何回复结果的用户消息不提前进入整理。工具结果在保存结果的同一事务中登记，unknown 与后续补录都保留真实状态。
- `evidence_records.source_status` 是登记时状态；工具结果补录或助手消息最终状态确定时同步更新。原始正文仍以 `messages.content`、`tool_results.raw_response_json`／`adapted_result_json` 为准，证据表不复制正文。
- `role_sequence` 用于固定批次顺序，由同一事务分配；批次开始后新增证据序号更大，不进入本批。
- `evidence_processing` 的可处理范围：`pending`；到期可重试的 `failed`；有更大 `role_sequence` 新证据或手动触发时的 `deferred`。`processing` 表示已被某批锁定。
- 单条证据超过容量时，`memory_evidence_segments` 按字符边界分段；只有全部分段处理成功才把证据标为 `processed`。分段不截断原始内容，未处理分段保留 `pending`。
- 批次开始时把范围内证据标为 `processing` 并写 `last_batch_id`；提交成功后才推进状态。失败保留已提交分段，未完成证据按第 11 节重试。

### 4.3 事件、摘要与日记

```sql
CREATE TABLE daily_summaries (
  summary_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  experience_date TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_daily_summaries_role_date
  ON daily_summaries (role_id, experience_date);

CREATE TABLE daily_summary_sources (
  summary_source_id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL REFERENCES daily_summaries(summary_id),
  window_id TEXT REFERENCES windows(window_id),
  from_sequence INTEGER,
  to_sequence INTEGER,
  occurred_from TEXT NOT NULL,
  occurred_to TEXT NOT NULL
);

CREATE INDEX idx_summary_sources_summary
  ON daily_summary_sources (summary_id);

CREATE TABLE memory_events (
  event_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  subjective_experience TEXT NOT NULL DEFAULT '',
  occurred_at_start TEXT NOT NULL,
  occurred_at_end TEXT,
  experience_date TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active', 'refined')),
  refined_summary_id TEXT REFERENCES daily_summaries(summary_id),
  version INTEGER NOT NULL,
  last_supplemented_round INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_memory_events_role_date
  ON memory_events (role_id, experience_date);

CREATE INDEX idx_memory_events_refine_candidates
  ON memory_events (role_id, lifecycle_status, last_supplemented_round);

CREATE TABLE memory_event_tags (
  event_id TEXT NOT NULL REFERENCES memory_events(event_id),
  dimension TEXT NOT NULL CHECK (dimension IN ('person', 'topic', 'place', 'emotion', 'source')),
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  PRIMARY KEY (event_id, dimension, normalized_value)
);

CREATE INDEX idx_memory_event_tags_lookup
  ON memory_event_tags (dimension, normalized_value);

CREATE TABLE memory_event_sources (
  event_id TEXT NOT NULL REFERENCES memory_events(event_id),
  evidence_id TEXT NOT NULL REFERENCES evidence_records(evidence_id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (event_id, evidence_id)
);

CREATE INDEX idx_memory_event_sources_evidence
  ON memory_event_sources (evidence_id);

CREATE TABLE diaries (
  diary_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  relative_path TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  experience_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_diaries_role_date
  ON diaries (role_id, experience_date);

CREATE TABLE diary_events (
  diary_id TEXT NOT NULL REFERENCES diaries(diary_id),
  event_id TEXT NOT NULL REFERENCES memory_events(event_id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (diary_id, event_id)
);

CREATE TABLE memory_revisions (
  revision_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('event', 'daily_summary')),
  target_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  change_source TEXT NOT NULL CHECK (change_source IN ('memory_batch', 'agent_correction')),
  content_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (target_type, target_id, revision_number)
);
```

- 事件正文与主观体验分开保存；事件来源只关联证据编号，原始内容按需读取。跨天事件按发生开始日期归属 `experience_date`，实际起止时间保留，摘要来源范围不截断。
- `memory_event_tags` 的 `normalized_value` 用于大小写／空白归一后的过滤；标签维度固定为人物、主题、地点、情绪、来源，不新增重要等级。
- `daily_summaries` 正文只概括；`daily_summary_sources` 保存窗口及消息／时间范围，不建立逐句证据清单。工具证据只有时间范围时，消息序号为空。
- 日记正文以 UTF-8 Markdown 文件保存为 `<roleDir>/workspace/diaries/<YYYY-MM-DD>/<diaryId>.md`，`relative_path` 记录相对 workspace 的路径；`business.sqlite.diaries` 保存元数据、正文快照与 SHA-256，供检索和完整性校验。文件是正文的权威来源，数据库快照不得独立改写为另一份内容。
- 日记写入顺序：先写同目录临时文件并原子替换目标 `.md`，再在业务库事务中插入日记行、事件关联与 FTS 文档；数据库事务失败时删除本次新建文件，避免留下未登记日记。读取时以文件正文为准并校验哈希；发现外部修改时在同一事务内更新数据库快照与检索文档。P2 不监听工作空间的外部文件变化，检索使用最近一次写入或读取时刷新的快照。
- 日记与事件的关联可选，角色写入时提供已知事件编号即可；没有事件关联的日记仍按日期和正文检索。
- 修订只作用于事件和日常摘要；日记是角色主观记录，不进入纠错流程。修订记录保存目标版本、依据版本、修改后内容与来源编号。

### 4.4 检索、召回与轮次

```sql
CREATE TABLE retrieval_queries (
  retrieval_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT REFERENCES executions(execution_id),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'agent', 'manual')),
  query_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_retrieval_queries_role_time
  ON retrieval_queries (role_id, created_at);

CREATE TABLE retrieval_results (
  retrieval_id TEXT NOT NULL REFERENCES retrieval_queries(retrieval_id),
  rank INTEGER NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('event', 'daily_summary', 'diary')),
  record_id TEXT NOT NULL,
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1)),
  PRIMARY KEY (retrieval_id, record_type, record_id)
);

CREATE TABLE memory_recalls (
  recall_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  record_type TEXT NOT NULL CHECK (record_type IN ('event', 'daily_summary', 'diary')),
  record_id TEXT NOT NULL,
  recalled_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_memory_recalls_execution_record
  ON memory_recalls (execution_id, record_type, record_id);

CREATE INDEX idx_memory_recalls_record
  ON memory_recalls (record_type, record_id);
```

- 自动召回、Agent 主动检索和 CLI／人工查询都写 `retrieval_queries`，分别标记 `auto`、`agent`、`manual`；查询失败写 `status='failed'` 与错误码，成功但无命中写成功和空结果。
- 只有实际进入角色上下文或作为工具结果返回给角色的结果才写 `memory_recalls`；同一 `execution_id` 同一记录只计一次。`manual` 查询没有执行编号，不写召回统计。
- 轮次来自 `executions.decision_round`；未提交、被替代或失败的执行没有轮次，不计入 100 轮观察期。
- 精炼候选：`currentRound - last_supplemented_round >= 100`，且最近 100 个已完成轮次内该事件召回次数不超过 1。候选只交给整理模型判断，不自动精炼。

### 4.5 对话执行与 SSE

```sql
CREATE TABLE execution_stream_events (
  stream_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT REFERENCES windows(window_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'execution_started', 'message_delta', 'tool_started', 'tool_result_saved',
    'message_completed', 'message_interrupted', 'execution_superseded',
    'execution_failed'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_execution_stream_window
  ON execution_stream_events (window_id, stream_event_id);

CREATE INDEX idx_execution_stream_execution
  ON execution_stream_events (execution_id, stream_event_id);
```

- 每个 SSE 事件先写入该表再发送；没有客户端连接时也写，重连可补读。
- `stream_event_id` 使用 `AUTOINCREMENT`，作为 SSE 的 `id`；客户端用 `after` 或 `Last-Event-ID` 补读，按窗口查询。
- 文本增量事件只保存增量；助手消息正文在完成／中断事务中落库。重连不重新调用模型或工具。
- 事件与业务变更尽量同事务提交：完成、中断、被替代事件与消息、状态、执行状态在同一事务；纯文本增量只要求先持久化再发送。
- P2 不清理历史流事件；保留策略和压缩在后续工作包处理。

### 4.6 模型调用与计量

```sql
CREATE TABLE model_calls (
  model_call_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT REFERENCES executions(execution_id),
  batch_id TEXT REFERENCES memory_batches(batch_id),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'user_chat', 'user_task', 'memory_maintenance', 'autonomous', 'connection_test'
  )),
  resource_id TEXT,
  model_name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN (
    'openai-chat', 'openai-responses', 'anthropic-messages'
  )),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  usage_json TEXT,
  raw_response_json TEXT
);

CREATE INDEX idx_model_calls_role_time
  ON model_calls (role_id, started_at);

CREATE TABLE call_metering (
  metering_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  execution_id TEXT REFERENCES executions(execution_id),
  task_id TEXT REFERENCES tasks(task_id),
  batch_id TEXT REFERENCES memory_batches(batch_id),
  call_kind TEXT NOT NULL CHECK (call_kind IN ('model', 'tool')),
  call_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'user_chat', 'user_task', 'memory_maintenance', 'autonomous', 'connection_test'
  )),
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (call_kind, call_id)
);
```

- 模型调用在请求实际发出时写 `model_calls`；后台整理填 `batch_id`，用户对话填 `execution_id`，连接测试不写角色库。
- `call_metering` 登记实际发起的模型／工具调用；重连、重放、复用已有结果不新增。用户对话与后台维护 `counted=0`，自主活动 `counted=1`；P2 只登记，P3 执行额度周期。
- 工具调用的 `call_id` 为 `tool_call_id`；记忆内部工具不写 `call_metering`，其检索与修改分别写检索记录、修订记录。
- `raw_response_json` 可保存模型原始响应；不得写入凭据或请求头。连接测试记录在 `app.sqlite` 的 `model_test_calls`，不进入角色记忆。

### 4.7 全局模型测试记录（app.sqlite v2）

```sql
CREATE TABLE model_test_calls (
  test_call_id TEXT PRIMARY KEY,
  resource_id TEXT,
  model_name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN (
    'openai-chat', 'openai-responses', 'anthropic-messages'
  )),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  usage_json TEXT
);
```

### 4.8 统一记忆检索索引

```sql
CREATE TABLE memory_search_documents (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  record_type TEXT NOT NULL CHECK (record_type IN ('event', 'daily_summary', 'diary')),
  record_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (role_id, record_type, record_id)
);

CREATE VIRTUAL TABLE memory_search_fts USING fts5(
  title,
  body,
  content='memory_search_documents',
  content_rowid='document_id',
  tokenize='trigram'
);

CREATE TRIGGER memory_search_documents_ai AFTER INSERT ON memory_search_documents BEGIN
  INSERT INTO memory_search_fts(rowid, title, body)
  VALUES (new.document_id, new.title, new.body);
END;

CREATE TRIGGER memory_search_documents_ad AFTER DELETE ON memory_search_documents BEGIN
  INSERT INTO memory_search_fts(memory_search_fts, rowid, title, body)
  VALUES ('delete', old.document_id, old.title, old.body);
END;

CREATE TRIGGER memory_search_documents_au AFTER UPDATE ON memory_search_documents BEGIN
  INSERT INTO memory_search_fts(memory_search_fts, rowid, title, body)
  VALUES ('delete', old.document_id, old.title, old.body);
  INSERT INTO memory_search_fts(rowid, title, body)
  VALUES (new.document_id, new.title, new.body);
END;
```

- 事件、日常摘要、日记写入时在同一事务更新 `memory_search_documents`；事件精炼后删除事件的检索文档，摘要文档保留。
- 查询长度 ≥3 的连续词元使用 FTS5 trigram `MATCH`；1～2 字的词元使用 `LIKE '%词%'` 兜底。词元按空白、标点和常见连接词切分；中文整句直接匹配不到时，P2-03 用实际样例调整切分与排序，不新增向量依赖。
- 角色过滤必须通过 `memory_search_documents.role_id`，不能只依赖查询文本；事件标签过滤使用 `memory_event_tags`，全文命中与标签过滤在程序层合并、去重和排序。
- 无命中返回空结果；FTS 查询异常返回失败，不伪装成空结果。

## 5. 记忆形成协议

### 5.1 触发与批次

- 同窗口待整理消息达到 50 条，或至少 30 条且最后一条消息后停歇 60 秒，登记 `message_threshold`／`idle` 触发。
- 任务从 active 进入 completed／failed 且该任务有新证据时登记 `task_end`；工具结果晚到时若所属任务已结束，也补登记。
- 多个触发合并为同一角色的一批；批次开始后新增证据保留待处理。同一角色通过 `idx_memory_batch_single_running` 和调度器双保险，只允许一个运行中批次。
- 批次结束或失败后立即检查固定范围内是否仍有 `pending` 或到期 `failed` 证据；有则继续安排后续批次，不重新等待 30／50 条阈值，也不阻塞聊天。
- 后台整理使用独立调度器与决策队列，不占用角色聊天决策槽位；不同角色独立。

### 5.2 批次输入

- 批次固定 `input_from_sequence`／`input_to_sequence`，只处理范围内可处理证据；活动触发可跨窗口，但输入按窗口分组，不混并窗口原始历史。
- 按角色内证据顺序装满输入容量，并预留输出容量；单条过长证据使用 `memory_evidence_segments` 分段，按顺序送入并持续补充同一事件。
- 同一批次可多次调用整理模型；每个子批结果保存成功后才推进对应证据／分段状态。
- 输入同时提供低召回 `refineCandidates` 与这些候选经历日期下已有的 `summaryCandidates`（摘要编号、日期、主题、正文、版本），供模型决定新建摘要或补充已有摘要；候选之外的事件和摘要不能作为精炼目标。

### 5.3 模型输出协议

整理模型返回单个 JSON 对象，由程序按严格 schema 校验：

```json
{
  "operations": [
    {
      "op": "create_event",
      "localKey": "event-1",
      "title": "在杭州旧书店和小林挑书",
      "summary": "10 月 28 日下午，角色与小林在杭州西湖边的旧书店停留，讨论植物书和旧地图。",
      "subjectiveExperience": "角色觉得那天很安静，期待下个月再去看旧地图。",
      "occurredAtStart": "2026-10-28T01:10:00.000Z",
      "occurredAtEnd": "2026-10-28T02:00:00.000Z",
      "experienceDate": "2026-10-28",
      "tags": { "person": ["小林"], "topic": ["旧书店"], "place": ["杭州"], "emotion": ["平静"], "source": ["nowadays"] },
      "evidenceIds": ["ev-1", "ev-2"]
    },
    {
      "op": "update_event",
      "eventId": "event-id",
      "expectedVersion": 2,
      "patch": { "summary": "补充说明", "tags": { "topic": ["旧地图"] } },
      "addEvidenceIds": ["ev-3"],
      "reason": "后续记录补充同一经历"
    },
    {
      "op": "refine_event",
      "events": [
        { "eventId": "event-id-1", "expectedVersion": 3 },
        { "eventId": "event-id-2", "expectedVersion": 2 }
      ],
      "summary": "两人同一天在杭州旧书店和湖边散步，最后一起吃了晚饭。",
      "targetSummaryId": "summary-id",
      "expectedSummaryVersion": 2,
      "topic": "杭州旧书店",
      "reason": "长期低召回，合并为日常摘要并补充已有概括"
    },
    { "op": "defer", "evidenceIds": ["ev-4"], "reason": "信息不足，等待后续记录" }
  ]
}
```

规则：

- `create_event` 至少引用本批证据；`update_event` 必须属于本角色、版本匹配、至少有一项正文／标签／证据变化；`refine_event` 只能针对本批提供的候选，`events` 中的事件必须全部属于本角色、版本匹配、仍为 `active` 且经历日期相同。
- `refine_event` 的 `summary` 是整理模型给出的日常概括，不是事件正文的机械拼接；`targetSummaryId` 与 `expectedSummaryVersion` 必须同时出现，指向本批提供的同日摘要候选并补充其正文；省略时创建新摘要。`topic` 用于同日同主题聚合，已有摘要主题非空时不得冲突。
- `title`、`summary` 非空且长度受限；`occurredAtStart` 不晚于 `occurredAtEnd`；`experienceDate` 必须与原始时间在配置时区下的日期一致，不按整理当天填写。
- 标签维度只允许 `person`、`topic`、`place`、`emotion`、`source`；空值、重复值由程序归一化。
- 被 create／update 引用的证据在提交后标为 `processed`；被 defer 的标为 `deferred`，记录 `deferred_after_sequence`；输入范围内未被引用且未被 defer 的证据按“已考虑”标为 `processed`。
- `create_event` 的 `last_supplemented_round` 设为创建时最新的已完成角色决策轮次（没有则为 0）；后续正文、标签或来源补充都重置为当时的轮次，避免新事件立即进入精炼候选。
- 一个模型响应的全部操作在同一事务中校验并提交；任一操作失败则整个子批回滚，受影响证据／分段标为 `failed`，已提交的前序子批保留。
- `refine_event` 在同一事务内创建或补充 `daily_summaries`、合并写入摘要来源范围、更新全部目标事件为 `refined` 并删除事件全文文档；原始证据不删除。新增与补充都写入摘要修订，补充使用 `expectedSummaryVersion` 防止旧版本覆盖。
- 程序只校验格式、归属、来源存在、目标版本和提交一致性，不引入第二模型做语义审核，不要求用户确认。

### 5.4 内容边界

- 用户消息与助手回复一起形成事件；中断回复的已表达部分可以参与整理，但截断内容保持未完成，不补成完整承诺。
- 工具是否完成以实际结果为准；unknown 保留 unknown，不因模型措辞写成成功。
- 未被发送的草稿、模型计划、未执行工具请求不是证据，不进入事件。
- 事实经过与主观体验分开保存；角色可以重新理解旧事，但原始证据不改。

## 6. 检索、召回与精炼

### 6.1 查询入口

统一记忆检索同时返回事件、日常摘要和日记，结果带 `type`、编号、标题／摘要和相关度；事件已精炼后不再作为独立结果返回，通过摘要的范围读取原文。

查询条件：

```json
{
  "query": "杭州 旧书店",
  "types": ["event", "daily_summary", "diary"],
  "people": ["小林"],
  "topics": ["旧书店"],
  "places": ["杭州"],
  "emotions": [],
  "sources": ["nowadays"],
  "dateFrom": "2026-10-01",
  "dateTo": "2026-10-31",
  "limit": 8
}
```

- 自动召回由程序构造首批条件：本轮待处理消息、最近窗口消息中出现的已知人物／地点／主题标签、明确的日期线索，以及当前状态中可用的关注词；不额外调用一次模型。
- 日期线索至少支持 `今天`、`昨天`、`前天` 和 `YYYY-MM-DD`，以注入的时钟和配置时区计算；更复杂的相对时间表达式留到 P2-03 用样例决定。
- 手动／CLI 查询不写召回统计；Agent 查询与自动召回写查询记录，实际提供给角色上下文的结果才写 `memory_recalls`。
- 查询失败返回错误并记录；无命中返回成功空列表。Agent 必须能区分两者，未命中不推断事情从未发生。

### 6.2 召回统计

- 自动召回结果进入本轮模型上下文时，逐条登记 `memory_recalls`；Agent 主动搜索返回结果、读取事件详情或按事件来源读取证据时，登记相关事件召回。
- 同一 `execution_id` 同一记录只登记一次；候选匹配但被预算裁掉、仅在后台维护中查询的结果不登记。
- 召回次数按包含该事件的已提交执行轮次统计；只有 `decision_round` 非空的执行计入 100 轮窗口，未完成或被替代的决策不计。
- 日记和摘要也登记召回，但只有事件参与 100 轮精炼候选判断。

### 6.3 精炼

- 事件创建或最近一次补充后，观察期从当时的角色决策轮次重新计算。
- 达到“至少 100 轮且最近 100 轮召回不超过 1 次”的事件进入候选，由整理模型决定是否精炼；不自动删除、不按固定等级排序。
- 精炼后事件退出独立检索，归入按经历日期聚合的日常摘要；同一天内容多或话题不同可形成多条摘要。
- 整理模型给出概括正文，可一次精炼同一天的一个或多个事件，也可通过 `targetSummaryId` 与 `expectedSummaryVersion` 补充已有摘要；同一天同主题可合并，不同经历日期不得合并。
- 摘要正文、主题、来源范围、版本、修订和检索文档在同一事务更新；补充已有摘要时旧版本冲突返回 `MEMORY_VERSION_CONFLICT`，事件保持 `active` 并回滚整次操作。
- 摘要来源范围来自被精炼事件关联的消息证据（窗口＋序号）和工具证据（时间范围）；原始对话、工具结果、证据记录全部保留。
- 日记独立保留，不被摘要替代，也不因精炼自动生成。

## 7. 主观记忆、状态与纠错

- 角色当前状态由角色在决策中提出局部补丁，提交时与回复、执行完成标记同一事务合并；后台整理不能直接改当前状态。
- 状态补丁按浅合并应用，版本号递增；提交前发现加载版本已过期时拒绝覆盖，执行失败或重新决策，不用旧结果覆盖新状态。
- 日记由角色自主决定书写；P2 提供 `diary_write` 工具和读取／检索接口，P3 才接入定时自主书写。用户邀请后写入仍以角色记录呈现，不伪造模型输出。
- 日记可以关联已知事件；不重复生成事实事件，不把每批整理自动变成日记。
- 纠错只允许改事件和日常摘要：校验所属角色、目标版本和来源，原子更新正文、标签、来源与检索文档，并写 `memory_revisions`。旧版本不覆盖新版本，冲突返回 `MEMORY_VERSION_CONFLICT`。
- 后台整理与纠错并发时，以 `expectedVersion`／`base_revision` 判断；冲突的批次证据保持待处理或失败重试，已提交修订保留。
- unknown 工具结果的核查补录沿用 P1 规则；补录只更新真实状态，不改变事件已经保存的事实边界。

## 8. 对话执行、输入状态与中断

### 8.1 决策启动

- 消息提交先保存；同窗口存在 `typing=true` 时不启动该窗口的新决策，停止输入 1 秒后自动退出。
- 同一角色只运行一个有效决策。按最早未处理用户消息的顺序选择窗口；其他窗口排队等待，不并行启动第二轮决策。
- 决策创建 `executions` 记录，认领该窗口全部未处理用户消息（写 `claimed_by_execution_id`），读取最新设定、状态、绑定、近期消息、召回概况和已有工具结果。
- 同一角色后台整理独立调度，不与聊天决策争用串行槽位。

### 8.2 输入状态与断线

- 输入状态只存在内存：`{roleId, windowId, clientId, expiresAt}`；实际编辑刷新为 `now+1000ms`，`typing=false`、窗口关闭、客户端确认断线或后端重启清除。
- 输入法组词由客户端持续发送编辑状态维持；仅焦点保持不算编辑。该状态不写入数据库，不恢复旧草稿。
- 消息已保存但输入状态仍为 true 时等待；退出后只处理已发送消息，未发送草稿不入模。
- 客户端 SSE 断开不停止执行，不重新发起模型或工具；重连按游标补读已有事件。

### 8.3 新消息、中断与部分文字

- 同窗口用户实际发送新消息时，若该窗口存在运行中执行，立即把旧执行标为 `superseded`：保存已产生的部分文字为 `interrupted` 助手消息、写中断／替代事件、释放旧执行认领的用户消息，然后等待输入状态退出再启动新决策。
- 单纯打字、进入输入状态、客户端断线不打断当前回复。
- 旧执行晚到的文本不写入新回复或状态；已发出的外部工具调用继续接收并按原调用保存真实结果，不重发。
- 旧执行在模型返回后、工具登记前和工具派发前都检查执行状态；过期请求不执行，迟到结果仍保存。
- 提交失败不能丢弃已显示文字：增量事件已持久化，恢复或中断时按事件重建部分消息；正式完成只在回复、状态、执行完成同一事务成功后通知。

### 8.4 正式提交

完成事务必须原子执行：

1. 校验执行仍为 running，且加载状态版本与当前一致；
2. 将本轮 `generating` 助手消息更新为 `completed` 并写入完整正文；
3. 合并角色状态补丁并递增 `state_version`；
4. 更新执行 `completed`、`state_version_committed`、`decision_round`；
5. 把认领用户消息标为 `processed_by_execution_id`；
6. 登记助手与用户证据（同一事务）；
7. 写 `message_completed` 流事件。

任一步失败则整体回滚，不提前通知完成；重复提交返回已提交的回复与版本，不写第二份消息。

### 8.5 SSE 事件

SSE 响应使用 `Content-Type: text/event-stream`，事件名固定 `execution`，`id` 为 `stream_event_id`，`data` 为 JSON：

```json
{ "streamEventId": 42, "type": "message_delta", "executionId": "uuid", "windowId": "uuid", "delta": "我", "createdAt": "2026-11-03T10:00:00.000Z" }
```

| `type` | 关键字段 |
| --- | --- |
| `execution_started` | `executionId`, `windowId`, `triggerType`, `messageIds` |
| `message_delta` | `executionId`, `delta` |
| `tool_started` | `executionId`, `toolCallId`, `toolName` |
| `tool_result_saved` | `executionId`, `toolCallId`, `status` |
| `message_completed` | `executionId`, `replyMessageId`, `stateVersion`, `decisionRound` |
| `message_interrupted` | `executionId`, `replyMessageId`, `reason` |
| `execution_superseded` | `executionId`, `supersededByExecutionId` |
| `execution_failed` | `executionId`, `errorCode` |

- 无 `after` 且无 `Last-Event-ID` 时只推送新事件；有游标时先补读该窗口的事件再进入实时流。游标非法返回 400 `SSE_CURSOR_INVALID`。
- 每 15 秒发送注释心跳，不写数据库。客户端按事件 `id` 去重。
- 事件持久化保留；P2 不做历史压缩。

## 9. 模型端口、Skill 与本地 MCP

### 9.1 统一模型端口

```ts
interface ModelRequest {
  modelName: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

interface ModelContinuation {
  protocol: "openai-chat" | "openai-responses" | "anthropic-messages";
  modelName: string;
  baseUrl: string;
  items: Record<string, unknown>[];
}

type ModelMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: Array<{ callId: string; name: string; arguments: unknown }>;
      continuation?: ModelContinuation;
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName?: string;
      content: string;
    };

type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; arguments: unknown }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | {
      type: "completed";
      stopReason: string;
      incomplete?: boolean;
      rawResponse?: unknown;
      continuation?: ModelContinuation;
    };
```

- 对话、后台整理和连接测试共用该端口，各自构造上下文；离线模型实现相同端口。
- 对话使用角色的 `chat_model` 绑定；存在启用的 `memory_model` 绑定时整理使用该绑定，否则继承 `chat_model` 的资源和模型名。缺少可用对话绑定返回 `MODEL_BINDING_MISSING`。
- 适配器负责协议、流式解析、工具调用格式和多内容块转换；业务层不直接依赖厂商 SDK 类型。
- 助手历史保留同一轮的文字与全部工具调用，工具结果通过调用编号关联；OpenAI Chat 发送 assistant `tool_calls`，OpenAI Responses 使用无状态完整 `input` 重放 `function_call` 与 `function_call_output`，Anthropic 发送 assistant `tool_use` 并把连续工具结果合并到同一条 user 消息。
- `completed.continuation` 保存适配层续轮材料，助手历史原样回传；业务层不解释其中的厂商字段。Responses 优先保留完整终态输出项（含 reasoning／加密内容、消息 phase 和调用），终态 output 为空时回退到已完成的 output item；Anthropic 保留有序内容块（含 thinking／signature／redacted_thinking）。有续轮材料时不再重复拼接归一化助手文字和调用；协议、baseUrl 或模型名变化时改用归一化历史，不向新服务发送旧服务的加密／签名材料。P2-05 将续轮材料与模型调用／执行记录关联保存，并独立维护业务调用编号与供应商 wire 编号的映射；回传不改写供应商原始内容块内的编号。
- 流式响应必须收到协议对应的完整终态（Chat `finish_reason` 加 `[DONE]`、Responses `response.completed`／`response.incomplete`、Anthropic `message_delta` 加 `message_stop`）；提前 EOF、空流和显式失败报错，不发出 `completed`。已收到的文字增量仍可交给上层保存。
- `stopReason` 为 `length`／`max_tokens`／`content_filter`／`pause_turn` 等显式不完整时，`completed.incomplete` 为 `true`；正常结束不设置该字段。
- 模型返回的工具调用由业务层分配稳定 `step_key`／`tool_call_id`，不直接使用厂商调用编号作为业务身份。
- 凭据只从 `env:` 或 `file:` 引用读取；`file:` 相对路径按 `appRoot` 解析。缺失、不可读或格式错误返回 `MODEL_CREDENTIAL_UNAVAILABLE`，不记录值。
- 模型请求失败、流中断或工具参数无法解析分别记录错误；不自动切换其他模型服务。

### 9.2 列表与测试连接

- 三类协议分别实现模型列表和最短连接测试；列表失败保留配置并返回实际原因，不自动清空或切换。
- 测试连接使用当前传入配置与模型 ID，发送简短实际请求，不携带角色、记忆或工具；必须收到完整终态且至少一段有效文字或工具调用才算成功，空流与提前 EOF 记为失败；结果写 `app.sqlite.model_test_calls`，不扣自主额度。
- 列表和测试都可通过 CLI／API 触发；保存配置不是调用前提。前端按钮不在 P2。

### 9.3 Skill 与本地 MCP

- Skill 元数据在上下文构建时按需加载简介；正文、参考文件和脚本通过工具按需读取。不恢复旧私有插件协议。`SKILL.md` 的 YAML frontmatter 按标准 YAML 读取，支持引号字符串与折叠／保留块标量；格式读取不增加内容审查、依赖预检或试运行。
- Skill 脚本通过已启用的执行工具运行；依赖、环境和内容由用户负责，不增加预检、内容审查或试运行。
- 随程序提供本地 MCP 文件读写、目录检索和命令／脚本执行基础工具，使用 stdio 接入；文件类工具默认以角色工作空间为根，拒绝越界路径，写入前检查最近存在祖先及创建后目录的真实路径，防止经 junction／符号链接越界；命令工具以工作空间为工作目录运行，保留用户环境权限，不额外沙箱化。
- 外部 MCP／本地工具的每次实际调用沿用 P1 `tool_calls`／`tool_results` 五态与幂等规则；普通文本、结构化输出和多内容块都保留原始响应并适配模型输入。
- 关闭开关立即阻止新任务使用；原任务链按 DL-71、DL-73 延续到结束；配置修改后新调用用最新配置，已发调用不取消重发。
- 资源导入、运行中删除／改绑不在 P2 新增；仍按 164 第 4 节逐项处理。

## 10. HTTP API

继续监听 `127.0.0.1`，沿用 P1 的 JSON 错误结构和 1 MiB 请求上限。新增／扩展路由：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/roles/:roleId/windows/:windowId/input-state` | 更新输入状态 `{clientId, typing}` |
| DELETE | `/v1/roles/:roleId/windows/:windowId/input-state?clientId=` | 清除窗口输入状态 |
| GET | `/v1/roles/:roleId/windows/:windowId/events?after=&clientId=` | SSE 执行事件流 |
| GET | `/v1/roles/:roleId/executions/:executionId` | 查询执行、轮次、最新事件 |
| GET | `/v1/roles/:roleId/tasks` | 任务列表 |
| GET | `/v1/roles/:roleId/tasks/:taskId` | 任务详情 |
| POST | `/v1/roles/:roleId/tasks/:taskId/finish` | `{status, endReason}`，显式结束任务 |
| POST | `/v1/roles/:roleId/memory/search` | 统一检索，支持类型／标签／日期过滤 |
| GET | `/v1/roles/:roleId/memory/events/:eventId` | 事件详情、标签、来源 |
| GET | `/v1/roles/:roleId/memory/evidence/:evidenceId` | 原始证据读取 |
| GET | `/v1/roles/:roleId/memory/summaries/:summaryId` | 日常摘要详情 |
| PATCH | `/v1/roles/:roleId/memory/events/:eventId` | 事件纠错，必须带 `expectedVersion` |
| PATCH | `/v1/roles/:roleId/memory/summaries/:summaryId` | 摘要纠错，必须带 `expectedVersion` |
| GET | `/v1/roles/:roleId/diaries` | 日记列表 |
| POST | `/v1/roles/:roleId/diaries` | 角色邀请／验证用日记写入 |
| GET | `/v1/roles/:roleId/memory/status` | 待整理、失败、运行中批次 |
| GET | `/v1/roles/:roleId/memory/batches?limit=` | 批次历史 |
| POST | `/v1/roles/:roleId/memory/batches` | 手动登记整理触发（验证／CLI） |
| POST | `/v1/model-services/models` | 按传入配置获取模型列表 |
| POST | `/v1/model-services/test` | 按传入配置测试连接 |

请求／响应约定：

- 消息提交响应保持 P1 字段，并可增加 `decisionScheduled` 布尔值；重试同编号不重复调度、不打断当前回复。
- `memory/search` 请求见第 6.1 节；响应 `{retrievalId?, items:[{type, id, title, snippet, rank}], status:"succeeded"}`。手动查询不写召回。
- 事件／摘要纠错响应返回新版本号与更新时间；版本冲突 409。
- `model-services/test` 即使测试失败也返回 200 `{ok:false, elapsedMs, error:{code,message}}`，便于客户端展示；服务不可达等 API 错误使用 502 `MODEL_REQUEST_FAILED`。
- 任务结束接口只允许 `completed`／`failed`，重复相同结束幂等，冲突返回 409。
- 请求中的未知字段继续拒绝；错误正文不包含凭据、SQL、堆栈或完整上下文。上游模型服务的非 2xx 响应正文不转发，只保留状态码和白名单化的错误类型／代码作为原因。

## 11. CLI

CLI 仍只走 HTTP，不直接读写数据库。新增：

| 分组 | 命令 |
| --- | --- |
| 输入 | `cli input set --role <id> --window <id> --client <id> --typing <true|false>`、`cli input clear ...` |
| 事件流 | `cli events --role <id> --window <id> [--after <n>]` |
| 执行 | `cli execution get --role <id> --id <id>` |
| 任务 | `cli task list --role <id>`、`cli task get --role <id> --id <id>`、`cli task finish --role <id> --id <id> --status <completed|failed> --reason <text>` |
| 记忆 | `cli memory search --role <id> --json <json|@file>`、`cli memory event --role <id> --id <id>`、`cli memory evidence --role <id> --id <id>`、`cli memory summary --role <id> --id <id>`、`cli memory status --role <id>`、`cli memory batches --role <id>`、`cli memory trigger --role <id>` |
| 日记 | `cli diary list --role <id>`、`cli diary create --role <id> --content <text|@file> [--events <ids>] [--occurred-at <iso>]` |
| 模型 | `cli model models --json <config|@file>`、`cli model test --json <config|@file> --model <name>` |

`cli events` 逐行输出 SSE 的 `data` JSON；断线由用户重跑并带上次 `streamEventId` 作为 `--after`。CLI 不自动启动后端。

## 12. 错误码

新增错误沿用 `{error:{code,message,details?}}`：

| 错误码 | 场景 |
| --- | --- |
| `SCHEMA_MIGRATION_FAILED` | v1→v2 迁移失败，已回滚 |
| `FTS5_UNAVAILABLE` | 运行环境缺少 FTS5 trigram |
| `EXECUTION_NOT_RUNNING`／`EXECUTION_SUPERSEDED` | 旧执行已不能接受新文本或工具请求 |
| `SSE_CURSOR_INVALID` | 补读游标不是本窗口的有效事件编号 |
| `INPUT_STATE_INVALID` | 输入状态请求缺少 clientId 或类型错误 |
| `MODEL_BINDING_MISSING` | 角色没有可用的对话／整理模型绑定 |
| `MODEL_CREDENTIAL_UNAVAILABLE` | 凭据引用无法读取，不返回值 |
| `MODEL_REQUEST_FAILED` | 上游模型请求失败或不可达 |
| `MEMORY_EVENT_NOT_FOUND`／`MEMORY_SUMMARY_NOT_FOUND` | 目标不存在或不属于该角色 |
| `MEMORY_VERSION_CONFLICT` | 纠错／整理依据版本过期 |
| `MEMORY_QUERY_FAILED` | 检索执行失败；与空结果区分 |
| `MEMORY_BATCH_CONFLICT` | 同一角色已有运行中批次或状态不允许 |
| `DIARY_NOT_FOUND` | 日记不存在或不属于该角色 |

P1 错误码保持不变。

## 13. 并发、失败与重试

- 同一角色决策串行；不同角色独立。后台整理同角色单批串行，不占用决策槽位。
- 进程启动时清理上次异常退出遗留的运行态：运行中的整理批次标为 `failed`（`PROCESS_INTERRUPTED`），其 `processing` 证据回到失败或待处理并保留已提交分段；运行中的执行标为失败并释放用户消息认领，已产生的部分文字按流事件重建为 `interrupted` 助手消息；输入状态全部清空。完整恢复组合验收仍归 P4。
- 批次、纠错和状态提交都用显式事务和版本检查；数据库使用 WAL、外键和 5 秒 busy timeout。
- 整理模型请求、解析或保存失败：记录 `last_error_code`，未提交证据保持 `pending`／`failed`；已提交子批不重做。重试按 30 秒、2 分钟、10 分钟、1 小时递增，之后维持 1 小时；具体值在 P2-02 用可控时序验证。
- 失败不阻塞聊天，不自动换模型，不重新等消息凑阈值；配置恢复或重启后继续调度。
- 模型返回未知／流中断：执行按 `failed` 或 `interrupted` 处理，已显示文字保留；不把未知工具结果当成功。
- 工具结果保存领先检查点、unknown 补录、任务结束后晚到结果沿用 P1 语义；不因重连或恢复重发。
- SSE 重放只读持久事件，不触发业务动作；同一事件编号只对应一次业务变更。

## 14. 时间、排序与预算基线

- 生产默认使用系统时区；测试注入固定时钟和 `Asia/Shanghai`。`experience_date` 在证据登记时按当时时区计算并持久化，后续展示不随当前时区改写。
- 记忆检索排序初始为全文相关度优先、同分按发生时间新到旧；具体 bm25 权重与排序在 P2-03 用中文样例比较后调整。
- 初始工程预算（可在实测中调整并记录）：单批输入约 24k 字符、输出预留约 4k 字符；自动召回最多 8 条概况；单次检索返回最多 20 条候选；Agent 记忆工具单轮返回最多 8k 字符；单次决策最多 8 个模型／工具回合。上述不是已确认的产品参数，不写入用户配置承诺。
- 中文检索以 P2-03 样例为准：≥3 字词元用 FTS5 trigram，1～2 字用 LIKE 兜底；若命中或性能不达标，允许在 P2-03 内更换分词／索引实现并记录，不改变已确认的用户行为。

## 15. 中文样例与验收设计

P2-03 使用固定中文语料，至少包含：

- 窗口 `main`：10 月 28 日与小林去杭州旧书店、讨论植物书和旧地图；10 月 30 日下雨去巷口面馆。
- 窗口 `travel`：10 月 29 日补充杭州行程和旧地图到货。
- 一篇 10 月 29 日日记，关联杭州事件。
- 第二个角色保存包含相同词元的消息，用于验证角色隔离。

基线查询：

| 查询 | 期望 |
| --- | --- |
| `杭州 旧书店` | 命中杭州事件（FTS trigram） |
| `小林` | 命中杭州事件（2 字 LIKE 兜底＋人物标签） |
| `雨` | 命中面馆事件或对应日常摘要（1 字 LIKE＋情绪／主题标签） |
| `面馆` | 命中面馆事件 |
| `旧地图` | 命中杭州事件或行程补充 |
| `昨天` + 固定时钟 | 只返回相对日期对应范围；不返回其他日期 |
| 同一词元查询第二个角色 | 无跨角色结果 |

验收场景：

| 场景 | 必须核对 |
| --- | --- |
| v1→v2 迁移 | P1 消息／工具结果数量、正文、角色身份不变；证据回填顺序和待处理状态正确；版本 2；中途注入失败时版本仍 1 且结构完整 |
| 触发边界 | 49／50 条、29／30 条且 59／60 秒；任务结束独立触发；触发合并；批次运行中新证据保留待处理 |
| 记忆形成 | 离线整理模型从真实消息和工具结果创建事件、关联来源；第二批次补充同一事件不重复；跨窗口经历可归并，原始窗口不混并 |
| 失败重试 | 模型失败、JSON 非法、保存冲突均不提前完成；重试不重复事件；已提交子批保留；不阻塞聊天 |
| 检索与隔离 | 中文样例命中、无命中与查询失败可区分；同角色跨窗口可召回；第二个角色不可见；精炼事件不独立返回 |
| 召回与精炼 | 同执行同事件只计一次；候选匹配但未提供不计数；100 轮／1 次边界；补充后重算；摘要日期和来源范围正确 |
| 主观记录 | 事件事实与主观体验分开；日记实际写入 `.md` 文件、路径与内容哈希一致、关联与检索可用；纠错不改原始对话和工具观测 |
| 对话与流式 | 输入 1 秒退出；草稿不入模；重复提交不打断；新消息替代旧回复并保留部分文字；完成事务同时保存回复、状态、执行与事件 |
| 断线与工具 | SSE 断线后执行继续；重连补读不新增调用；unknown 补录、结果领先检查点、晚到结果均不重发 |
| 模型与扩展 | 三类协议离线／本地服务分别记录文本、流式和工具返回；同一轮多个工具调用与结果可继续下一轮；缺失终态、空流和上游错误不伪装成功且不泄露正文；列表失败保留配置；连接测试不带角色；Skill 标准 YAML 元数据可读取；本地 MCP 拒绝经链接越界的写入 |
| P1 回归 | 原有 13 个测试全部通过；角色、消息、绑定、任务、执行和存储缺失保护不退化 |

每项记录执行者、唯一 runId、隔离目录、命令、源码摘要、实际报告与持久业务证据；离线通过不等于真实服务兼容，真实联调按 DL-116 单独记录。

## 16. 工作包映射与未决事项

| 工作包 | 本文对应内容 |
| --- | --- |
| P2-02 | 第 3、4.1～4.2、5、13、14 节：迁移、证据、批次、离线整理、失败重试 |
| P2-03 | 第 4.3～4.4、4.8、6、7、15 节：检索、召回、精炼、日记、纠错 |
| P2-04 | 第 9 节：模型适配、列表／测试、Skill、本地 MCP |
| P2-05 | 第 8、10、11 节：图执行、输入、SSE、CLI、中断与提交 |
| P2-06 | 第 15 节及 P1 回归、真实配置联调、自验与独立复核分列 |

未决事项（不在本文默认为用户决定）：

- 日记已确认为工作空间 Markdown 文件；外部直接编辑在读取时刷新检索快照，P2 不做文件监听或自动导入。
- 记忆管理页面的编辑范围与交互属于后续前端阶段；P2 只提供后端数据管理接口。
- 历史流事件、证据和日志的保留／压缩策略未定；P2 不删除。
- 真实模型供应商、协议版本、列表分页和凭据文件格式在 P2-04 用用户配置验证后锁定。
- 资源导入、运行中删除／改绑、完整自主额度和远程 MCP 不在本契约内。
- 检索排序、分词、上下文预算和重试间隔是初始工程值，按第 14 节实测调整，不构成新的产品承诺。

本文固定 P2 的工程承载；若实施中发现需要改变已确认架构或用户可见行为，先讨论确认，再修改本文。
