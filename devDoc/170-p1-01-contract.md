# P1-01 角色与存储工程契约

日期：2026-11-03。

状态：**P1-01 契约固定，P1-02～P1-06 的实现、自验及最终独立复验完成（P1 范围）**。实际实现见[171](171-p1-implementation-record.md)，最终证据见[172 第 12 节](172-p1-independent-review.md)。本文是 P1 工程契约，历史候选与未验证平台不能外推为全部环境已通过。

依据：[持续决策记录](161-digital-life-direction-decisions.md) DL-14、DL-15、DL-64～DL-73、DL-86、DL-101～DL-103、DL-121～DL-123、DL-128；[执行清单](164-backend-prototype-execution-checklist.md)；[P1 开发文档](169-p1-role-storage-development-guide.md)；[168 第 7 节](168-p0-followup-fix-list.md)对 L04／L05 的核对。

## 1. 本契约固定的边界

- P1 只做单角色数据与配置的持久化、读取和本地 API／CLI 验证；模型回复、MCP／Skill 实际调用、完整记忆、调度器和正式前端不进入本阶段。
- 数据结构使用稳定 roleId／windowId／taskId／executionId／toolCallId／resourceId，不依赖“当前只有一条记录”。
- 任务与执行独立建模，支持一个任务跨多个执行；完成一次图执行或单个工具 success 不自动结束任务。
- 工具调用保留五态，并单独记录前台／后台模式历史；调用身份不因转后台或模式变化而改变。
- 模型凭据只保存引用（`env:` 或 `file:`），P1 不接收、不落库、不回显明文密钥；P1 不读取凭据、不验证环境变量是否存在。
- 资源删除／运行中改绑、角色卡导入格式、额度运行中切换仍按 164 第 4 节逐项讨论；P1 不增加相关接口。

## 2. 运行时、依赖与工程布局

P0 已验证的运行时为 Node.js 24.22.2 / win32-x64。P1 候选依赖如下，P1-02 安装后以实际锁文件和运行结果为准；同职责依赖的兼容调整按 DL-128 直接记录：

| 用途 | 候选 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js 24.22.2 | `engines` 不宣称未验证的其他版本 |
| 语言 | TypeScript 5.9.3、tsx 4.23.15 | 与 P0 一致，P1-02 复验 |
| 业务存储 | better-sqlite3 12.10.0 | 同步事务；P1-02 复验原生模块 |
| 请求校验 | zod 4.6.7 | 与 P0 一致；按 kind 校验配置 |
| HTTP | Node.js `node:http` | 不引入额外框架；P1-02 用健康检查验证路由／关闭 |
| 测试 | Node.js `node:test`、内置 `fetch` | 不引入测试框架；集成测试启动真实后端 |

正式后端位于 `backend/`，独立 `package.json`、锁文件、配置和测试；不复制 `prototypes/p0/` 的用例控制器，也不沿用根目录旧依赖。

```text
backend/
  package.json
  package-lock.json
  tsconfig.json
  .gitignore                 # node_modules、data、test-results、dist
  src/
    main.ts                  # 后端入口：解析参数、启动服务、等待关闭
    cli.ts                   # CLI 入口：只调用 HTTP，不直接写数据库
    bootstrap/
      config.ts
      app.ts
    domain/
      role.ts
      message.ts
      resource.ts
      task.ts
    application/
      role-service.ts
      message-service.ts
      resource-service.ts
    storage/
      app-store.ts
      role-store.ts
      checkpoint-store.ts
      schema.ts
    http/
      server.ts
      router.ts
      errors.ts
    cli/
      client.ts
      commands.ts
  tests/
    p1-02-storage.test.ts
    p1-03-role-message.test.ts
    p1-04-resource-task.test.ts
    p1-05-api-cli.test.ts
```

依赖注入方式：`createApp(config)` 返回 `{ httpServer, appStore, close }`；应用服务接收显式存储对象，不创建模块级可变单例。CLI 只接收 `baseUrl`，不接收数据库路径。

## 3. 数据根目录与启动参数

- 后端参数：`--app-root <path>` 必填；也接受环境变量 `NOWADAYS_APP_ROOT`。两者同时存在时以参数为准。缺失时返回 `APP_ROOT_REQUIRED`，不从当前工作目录猜测。
- `appRoot` 在启动时解析为绝对路径并固定；运行中不随工作目录改变。
- 数据根为 `<appRoot>/data/`；首次启动创建目录。2026-11-03 用户要求运行数据目录以 `data/` 开头，原 `.nowadays` 名称据此修订；当前工作区没有既有运行数据，不自动迁移旧目录。
- `--port` 默认 `3210`；测试和集成测试可用 `--port 0` 获取临时端口。监听地址固定 `127.0.0.1`，不提供对外监听参数。
- 启动成功后向 stdout 输出一行 JSON：`{"event":"listening","host":"127.0.0.1","port":<实际端口>,"appRoot":"<路径>"}`。错误写 stderr，不把凭据写入日志。
- SIGINT／SIGTERM 关闭 HTTP 连接和已打开数据库；重复关闭幂等。
- CLI 参数：`--base-url` 默认 `http://127.0.0.1:3210`；每次命令新建 HTTP 客户端，不自动启动后端。

```text
<appRoot>/data/
  app.sqlite
  roles/<roleId>/
    business.sqlite
    execution.sqlite
    workspace/
```

`execution.sqlite` 在 P1 创建并记录 schema 版本，但不创建 LangGraph 检查点表；P2 接入图执行时由检查点驱动初始化。P1 不实现旧主线或 P0 数据导入。

## 4. 存储契约

### 4.1 通用规则

- 每个数据库独立使用 `PRAGMA user_version` 记录 schema 版本；P1 均为 `1`。打开时版本不符返回 `SCHEMA_VERSION_UNSUPPORTED`，不自动降级或迁移。
- 打开参数：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- 所有时间为 ISO 8601 UTC 字符串；所有 ID 为服务端生成的 UUID v4，客户端提交编号除外。
- 每次正式写入使用显式事务；跨 `app.sqlite` 与角色业务库不声称单笔原子事务。
- `app.sqlite` 打开时验证应用级表；角色业务库打开时验证角色表、必需索引的存在、唯一性、部分索引属性、列顺序，以及完整 WHERE 谓词的整体匹配（不接受附加 AND／OR 改变约束；字符串常量按原样比较，仅允许引号外格式差异）。缺失或版本不符时报告存储错误，不静默重建已有文件。
- 已建角色读取必须以打开现有文件的方式打开：roleDir、workspace、business.sqlite、execution.sqlite 缺失时返回存储错误并保留现场，不创建替代文件；只有初始化重试允许补齐缺失文件。空文件或版本 0 的已有库不在读取路径中初始化。

### 4.2 `app.sqlite`

```sql
CREATE TABLE roles (
  role_id TEXT PRIMARY KEY,
  relative_dir TEXT NOT NULL UNIQUE,
  init_status TEXT NOT NULL CHECK (init_status IN ('initializing', 'ready', 'failed')),
  init_error TEXT,
  init_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE resources (
  resource_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'mcp', 'skill')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`resources.config_json` 按 `kind` 校验：

| kind | 配置结构 |
| --- | --- |
| model | `{ protocol: "openai-chat"｜"openai-responses"｜"anthropic-messages", baseUrl: string, credentialRef?: "env:<NAME>"｜"file:<PATH>" }` |
| mcp | `{ command: string, args: string[], env: Record<string, string> }`；P1 不启动、不连接、不试运行 |
| skill | `{ sourcePath: string }`；P1 不读取、不执行、不审查内容或依赖 |

模型名不写死在资源条目；由角色绑定保存 `modelName`。凭据原始值不进入数据库、API 响应、错误正文或测试报告；`credentialRef` 允许保存和返回引用本身。

### 4.3 `business.sqlite`

```sql
CREATE TABLE roles (
  role_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  definition_text TEXT NOT NULL,
  definition_payload_json TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE windows (
  window_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  kind TEXT NOT NULL CHECK (kind IN ('main', 'custom')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES windows(window_id),
  sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
  content TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  status TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  submission_id TEXT,
  submission_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (window_id, sequence)
);

CREATE UNIQUE INDEX idx_messages_window_submission
  ON messages (window_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  end_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE executions (
  execution_id TEXT PRIMARY KEY, -- 即 LangGraph thread_id
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT REFERENCES windows(window_id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('user_message', 'autonomous', 'tool_result', 'recovery')),
  trigger_message_id TEXT REFERENCES messages(message_id),
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'superseded', 'failed')),
  state_version_loaded INTEGER,
  state_version_committed INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE execution_tasks (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  relation TEXT NOT NULL CHECK (relation IN ('initiates', 'continues', 'references')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, task_id)
);

CREATE TABLE tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  step_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'unknown')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (execution_id, step_key)
);

CREATE TABLE tool_call_mode_events (
  event_id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(tool_call_id),
  mode TEXT NOT NULL CHECK (mode IN ('foreground', 'background')),
  changed_at TEXT NOT NULL
);

CREATE TABLE tool_results (
  tool_call_id TEXT PRIMARY KEY REFERENCES tool_calls(tool_call_id),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'unknown')),
  raw_response_json TEXT,
  adapted_result_json TEXT,
  diagnostic_code TEXT,
  error_json TEXT,
  saved_at TEXT NOT NULL,
  previous_status TEXT CHECK (previous_status IN ('unknown')),
  previous_diagnostic_code TEXT,
  previous_raw_response_json TEXT,
  previous_adapted_result_json TEXT,
  previous_error_json TEXT,
  reconciled_at TEXT
);

CREATE TABLE role_bindings (
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  capability TEXT NOT NULL CHECK (capability IN ('chat_model', 'memory_model', 'mcp', 'skill')),
  resource_id TEXT NOT NULL,
  model_name TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role_id, capability, resource_id)
);

CREATE UNIQUE INDEX idx_role_single_chat_model
  ON role_bindings (role_id)
  WHERE capability = 'chat_model';

CREATE UNIQUE INDEX idx_role_single_memory_model
  ON role_bindings (role_id)
  WHERE capability = 'memory_model';

CREATE TABLE task_resource_continuations (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  resource_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (task_id, resource_id)
);
```

约束说明：

- `messages.status` 不在 SQLite 层写死完整枚举；当前应用层允许 `received`／`completed`／`interrupted`，P2 流式契约再补 `generating` 等值，避免 P1 过早锁定。
- `messages.sequence` 在窗口内单调递增，由同一事务内 `MAX(sequence)+1` 分配；读取按 sequence 升序，不用毫秒时间戳排序。
- `submission_id` 只用于用户消息；`submission_hash` 为内容规范化后的 SHA-256。相同 `(window_id, submission_id)` 且哈希相同返回原消息；哈希不同返回 `SUBMISSION_CONFLICT`；新编号即使正文相同也插入新消息。
- 任务和执行通过 `execution_tasks` 多对多关联；`tool_calls.task_id` 指向任务，`execution_id` 指向发起执行。完成任务只能由显式结束操作设置 `status`／`end_reason`，图完成或工具 success 不自动完成。
- `step_key` 由执行层提供，必须在一个执行内唯一；P1 不用参数摘要代替身份。未来一轮多个工具调用使用稳定 callId／轮内序号。
- 工具调用创建时写入一条 `foreground` 模式事件；转后台追加 `background` 事件，不修改 toolCallId、不重发调用。当前模式取最新事件。
- 工具结果同时保留原始响应和适配结果；明确工具错误、发出前失败、发出后失联、结果适配失败分别使用 `diagnostic_code`，业务状态仍只用五态。已保存 `unknown` 的调用可在同一 toolCallId 下补录确定的 success／failed，原 unknown 状态、诊断、原始响应、适配结果与错误保存在 `previous_*` 字段，`reconciled_at` 记录补录时间；已经确定的 success／failed 不允许被冲突结果改写。补录必须提供显式结果（原始响应、适配结果或错误，允许显式 null），仅声明状态或只提供诊断码不构成核查依据。调用状态先为 `unknown`、结果尚未保存时，后续确定结果仍可在同一 toolCallId 下保存，并记录 `previous_status='unknown'`。
- `role_bindings` 的 `resource_id` 必须存在于 `app.sqlite.resources`，且 kind 与 capability 匹配：模型能力对应 model，MCP 对应 mcp，Skill 对应 skill。模型能力必须填写 `model_name`；没有 `memory_model` 绑定时表示继承 `chat_model`。绑定替换在角色业务库事务中完成，并在仓储层再次限制每个角色最多一个 `chat_model` 与一个 `memory_model`，不依赖索引是否存在。
- `task_resource_continuations` 记录原任务链对资源的延续资格；P1 只保存和读取，不执行资源连接或开关判断。

### 4.4 `execution.sqlite`

P1 创建文件并设置 `user_version=1`，不创建检查点表；数据库工厂提供 `open`／`close`／`schemaVersion`。P2 接入 LangGraph 时由检查点驱动初始化其表，资产归属仍为同一 roleId 目录。

## 5. 初始化与身份

`POST /v1/roles` 按以下顺序执行：

1. 生成 roleId；在 `app.sqlite.roles` 插入 `initializing`、相对目录和本次初始请求载荷（用于失败重试），提交。
2. 创建角色目录、`business.sqlite`、`execution.sqlite`、`workspace/`。
3. 在角色业务库事务中写入角色行（初始设定修订号 1、状态版本 1、初始状态可为空对象）和默认窗口（kind=`main`，source=`nowadays`）。
4. 更新 `app.sqlite.roles` 为 `ready`，清空 `init_payload_json`，返回角色摘要。

中途失败：把索引标记为 `failed` 并保存 `init_error`；不递归清除已存在的角色目录或工作空间；返回 `ROLE_INITIALIZATION_FAILED`，响应包含 roleId 和当前状态。`POST /v1/roles/:roleId/initialize` 可重试：

- `ready` 直接返回当前角色，不重复创建窗口或角色。
- `initializing`／`failed` 检查已有目录和表，使用 `init_payload_json` 补齐缺失的角色行和默认窗口（若角色行已存在则不重复写入），再标记 `ready` 并清空初始载荷；同一 roleId 不创建第二个角色。
- 重试遇到无法判断的半成品时返回 `STORAGE_ERROR`，保留现场供检查。

所有角色数据路由先验证索引为 `ready`；否则返回 `ROLE_NOT_READY`。P1 允许存储多个角色记录，但只验收一个角色，所有查询仍按 roleId 限定。

## 6. HTTP API 契约

### 6.1 通用规则

- 仅监听 `127.0.0.1`，不实现认证、网页或远程访问。
- 请求和响应均为 JSON；请求体上限 1 MiB；非 JSON 内容类型返回 `UNSUPPORTED_MEDIA_TYPE`。
- 成功响应直接返回资源对象；列表统一为 `{ "items": [...] }`，消息列表另带 `nextAfter`。
- 错误响应：`{ "error": { "code": "<ENGLISH_CODE>", "message": "<中文说明>", "details"?: ... } }`。
- 状态码：请求结构／参数错误 400，未找到 404，状态／修订／提交冲突 409，存储错误 500，内部错误 500。错误正文不回显凭据、SQL 或堆栈。
- 时间返回 ISO 8601 UTC；ID 为 UUID 字符串；请求中的未知字段拒绝。

### 6.2 路由

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET | `/v1/health` | — | `{ status: "ok", version: string }` |
| POST | `/v1/roles` | `{ displayName, definition: { text, payload? }, state? }` | 201 `{ roleId, status: "ready", defaultWindowId, definitionRevision: 1, stateVersion: 1 }` |
| POST | `/v1/roles/:roleId/initialize` | — | 200 同上；角色已 ready 时幂等返回 |
| GET | `/v1/roles/:roleId` | — | `{ roleId, displayName, definition: { text, payload }, definitionRevision, defaultWindowId, stateVersion, createdAt, updatedAt }` |
| PATCH | `/v1/roles/:roleId/definition` | `{ displayName?, definition?, expectedRevision? }` | `{ definitionRevision, updatedAt }`；修订不符 409 `REVISION_CONFLICT` |
| GET | `/v1/roles/:roleId/state` | — | `{ state, stateVersion, updatedAt }` |
| PUT | `/v1/roles/:roleId/state` | `{ state, expectedVersion? }` | `{ stateVersion, updatedAt }`；版本不符 409 `STATE_VERSION_CONFLICT` |
| POST | `/v1/roles/:roleId/windows` | `{ kind?: "custom", source?: string }` | 201 `{ windowId, roleId, kind, source, createdAt }` |
| GET | `/v1/roles/:roleId/windows` | — | `{ items: [...] }` |
| POST | `/v1/roles/:roleId/windows/:windowId/messages` | `{ content, submissionId, source? }` | 201 新消息／200 重试原消息 `{ message, duplicate }` |
| GET | `/v1/roles/:roleId/windows/:windowId/messages?after=&limit=` | — | `{ items: [...], nextAfter: number｜null }` |
| POST | `/v1/resources` | `{ kind, name, enabled?, config }` | 201 资源对象 |
| GET | `/v1/resources?kind=` | — | `{ items: [...] }` |
| GET | `/v1/resources/:resourceId` | — | 资源对象（`credentialRef` 可返回，原始凭据不返回） |
| PATCH | `/v1/resources/:resourceId` | `{ name?, enabled?, config? }` | 更新后的资源对象 |
| GET | `/v1/roles/:roleId/bindings` | — | `{ items: [...] }` |
| PUT | `/v1/roles/:roleId/bindings` | `{ bindings: [...] }` | `{ items: [...] }`，全量替换 |

角色创建默认窗口为 `main`；创建额外窗口只允许 `kind="custom"`，默认 `source="nowadays"`。消息接口只创建用户消息，P1 不触发模型；assistant／interrupted 记录由 P2 使用同一存储服务写入。

消息提交：`submissionId` 必填，长度 1～128；同窗口同编号重试返回原消息并标记 `duplicate: true`；同编号不同内容返回 409 `SUBMISSION_CONFLICT`；新编号即使正文相同也创建新消息。正文规范化只用于哈希比较，不改变保存原文。

消息读取：`after` 为上一页最后一个 `sequence`，默认空；`limit` 默认 50，范围 1～200；返回按 `sequence` 升序；`nextAfter` 在还有下一页时给出最后一条 sequence，否则为 `null`。窗口必须属于该 roleId，否则 404。

资源创建请求按 kind 校验 config；未知 kind 或缺失字段 400。更新资源只允许修改 name、enabled、config，不提供删除。启用／停用状态原样保存，P1 不读取或连接资源。

绑定请求为数组，每项 `{ capability, resourceId, modelName?, enabled? }`。服务端验证资源存在、kind 匹配、模型能力填写 `modelName`、每个角色最多一个 chat_model／memory_model；整组替换在角色业务库事务中完成。没有 memory_model 绑定表示继承 chat_model，P2 解析；P1 只保存和回读。

### 6.3 共享服务边界

任务、执行、工具调用及资源延续不做 HTTP 路由；P1-04 通过应用服务／存储测试验证约束，避免为尚未实现的调度器提供“成功”接口。P2 接入图执行时复用同一事务和幂等规则。

## 7. CLI 契约

CLI 只通过 HTTP 调用后端，不读取 `appRoot`、不直接写 SQLite。全局参数 `--base-url` 默认 `http://127.0.0.1:3210`；命令输出 JSON 到 stdout，错误写 stderr 并以非零退出。

| 分组 | 命令 |
| --- | --- |
| 状态 | `cli health` |
| 角色 | `cli role create --name <name> --definition <text|@file> [--payload <json|@file>] [--state <json|@file>]`、`cli role get --role <id>`、`cli role update --role <id> [--name] [--definition] [--payload] [--expected-revision]`、`cli role initialize --role <id>` |
| 状态 | `cli state get --role <id>`、`cli state put --role <id> --state <json|@file> [--expected-version]` |
| 窗口 | `cli window create --role <id> [--kind custom] [--source <source>]`、`cli window list --role <id>` |
| 消息 | `cli message send --role <id> --window <id> --content <text> --submission-id <id> [--source <source>]`、`cli message list --role <id> --window <id> [--after <n>] [--limit <n>]` |
| 资源 | `cli resource create --kind <kind> --json <json|@file>`、`cli resource list [--kind <kind>]`、`cli resource get --id <id>`、`cli resource update --id <id> --json <json|@file>` |
| 绑定 | `cli binding get --role <id>`、`cli binding put --role <id> --json <json|@file>` |

CLI 不吞掉错误，不在后端不可用时直接写数据库；后端不可达时返回非零退出码和明确错误。P1-05 用真实后端进程和独立 CLI 进程验证同一入口。

## 8. 初始化、版本与失败语义

- 设定修订号与状态版本分别递增：`definition_revision` 只在设定／显示名更新时 +1；`state_version` 只在状态保存时 +1；两者不互相代替。
- 执行的 `state_version_loaded` 记录本轮加载版本，`state_version_committed` 记录正式提交版本；提交重入返回后者，不因后续读取改写。
- 资源条目和角色绑定各自保存时间戳与变更；P1 不为资源引入版本号，启用状态按当前值读取。
- 角色业务库事务失败不留下半提交；初始化失败按第 5 节标记，不误删工作空间。
- 业务库与 `app.sqlite` 的跨文件操作不能保证单笔原子；初始化用状态机和幂等重试处理，读取时以角色索引状态为准。

## 9. 安全与凭据

- 只监听回环地址；请求体大小受限；错误和日志不包含凭据、SQL、堆栈或完整请求体。
- 模型凭据只接受 `env:<NAME>` 或 `file:<PATH>` 引用；P1 不读取引用目标。若用户把明文密钥放进 `mcp.config.env`，由用户自行承担；文档和 CLI 提示不要在普通配置中写入密钥。
- 资源列表和详情可以返回 `credentialRef` 引用本身，不返回被引用内容。测试报告不包含环境变量值。
- 不增加内容审查、依赖预检、授权审批或逐次确认。

## 10. 验收与证据

P1-06 按 169 第 6 节场景验收。P1-02 起每次测试使用唯一 runId 和临时 appRoot；测试报告写入 `backend/test-results/<runId>/`，数据库和日志被 Git 忽略。报告至少包含执行者、时间、命令、源码提交或摘要、依赖版本和结果；实现方自验与独立复核分别记录。

P1-02 的最小证据：临时目录启动、创建 app.sqlite／角色业务库、关闭后新进程重开且 schema 版本一致；P1-03 起按角色、消息、配置、任务关联逐步补证据。

## 11. 后续阶段与本契约不覆盖的行为

- 模型列表、测试连接、真实模型调用：P2。
- MCP／Skill 实际加载、执行、审查或环境预检：P2；资源删除／改绑、运行中切换额度：后续讨论。
- 多角色界面与管理、正式桌面、QQ、网页、视频、桌面控制：不进入 P1。
- LangGraph 检查点表、图执行、调度器和流式回复：P2／P3；P1 只预留 execution.sqlite 和关联字段。
- 明文凭据保存、密钥加密和凭据轮换：未在 P1 决定，当前只保存引用。

本契约固定的是 P1 的工程承载；若实施中发现需要改变已确认架构或用户可见行为，先讨论再修改，不把本文当作已实现或已验证。
