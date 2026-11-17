# 310 夏澄默认助手首版开发文档

日期：2026-11-16（经复核定稿）。本工作包依据 [DL-147](../../161-digital-life-direction-decisions.md#dl-147-移除陪伴角色概念按角色查看和编辑) 与 [DL-153～DL-159](../../161-digital-life-direction-decisions.md#dl-153-夏澄作为预置默认助手沿用现有对话链路) 实施，并与现行规范 [角色配置与活动守卫](../../specs/role-config-and-activity.md)、[存储、记忆与自主执行](../../specs/storage-memory-and-autonomy.md)、[对话演出与过场图](../../specs/conversation-performance-and-scene-images.md) 及 [前端设计规范](../../specs/frontend-design-system.md) 保持一致。本工作包当前待实施。

> **范围边界（不纳入本工作包）**：夏澄新美术立绘与服饰资产重绘、独立的「任务管理」页面（仅在后端预留任务取消与统计查询接口）、本地电脑操作独立小样及远程 Streamable HTTP MCP（[DL-115](../../161-digital-life-direction-decisions.md#dl-115-远程-mcp-排期桌面前端完成后实施)）留待后续工作包。

---

## 1. 内置角色身份、数据模型与幂等初始化

### 1.1 Schema 扩展与身份识别

现行 [schema.ts](../../../backend/src/storage/schema.ts#L141-L173) 尚无内置标识与独立只读展示介绍字段。需按既有版本迁移机制推进 `APP_SCHEMA_VERSION` 与 `BUSINESS_SCHEMA_VERSION`：

1. **`app.sqlite`（`roles` 表）**：新增 `builtin_key TEXT`（唯一部分索引 `WHERE builtin_key IS NOT NULL`），夏澄固定为 `"xiacheng"`；`GET /v1/roles` 与 `GET /v1/roles/:roleId` 返回 `isBuiltin: boolean` 与 `builtinKey: string | null`。
2. **`business.sqlite`（`roles` 表）**：新增 `builtin_key TEXT` 与独立展示字段 `bio_text TEXT NOT NULL DEFAULT ''`（供关系页「角色介绍」只读展示预置介绍）；**不得**再用 `definition_text` 同时充当只读展示介绍与可编辑人设。
3. **外观表（`outfits` 与 `outfit_assets`）**：新增 `is_preset INTEGER NOT NULL DEFAULT 0 CHECK (is_preset IN (0, 1))`，随包预置的默认服饰与官方立绘／差分均标记 `is_preset = 1`；列表与详情接口返回 `isPreset: boolean`。
4. **任务表（`tasks`）**：补充任务级可续行与等待字段（如 `continuable INTEGER` / `wait_reason TEXT` / `consecutive_failures INTEGER` 等）以支撑 `DL-154` / `DL-158`（见第 5 节）。

### 1.2 唯一实例、共存与启动初始化

- **后端启动初始化**：在后端启动链（`RoleService` 复用 [role-service.ts](../../../backend/src/application/role-service.ts#L66-L153) 四步初始化）中按 `builtin_key = 'xiacheng'` 查找内置实例：
  - **不存在时**：生成或分配稳定 `roleId`，写入 `builtin_key = 'xiacheng'`、`displayName = '夏澄'`、预置 `bioText`、初始可编辑 `definitionText`、初始 `stopped` 活动态（沿用 `markCreatedStopped` 与首次模型引导规则）及预置默认服饰／差分；
  - **初始化中断（`initializing` / `failed`）或重启重试时**：沿用原 `roleId` 调用 `initializeRole` 幂等补齐缺失数据库、主窗口或预置外观；
  - **升级与同名共存**：同一数据目录最多创建一个 `builtin_key = 'xiacheng'` 实例；既有历史库中若已存在名为「夏澄」但 `builtin_key IS NULL` 的普通角色，保持其原 `roleId` 与数据不动，不将其强行改写为内置实例。升级与重启保留夏澄已保存的角色卡正文、模型与扩展绑定、自定义服饰、记忆及对话历史。

### 1.3 人设分层注入

[ConversationService.buildSystemPrompt](../../../backend/src/application/conversation-service.ts#L2858) 对 `builtinKey === 'xiacheng'` 的角色采用**底座＋补充正文**两层组装：

1. **不可覆盖的系统底座（后端固定注入）**：包含默认通用办事助手定位、真实调用工具与严禁编造结果约束、多步推进分段续行与 `task_pause` 澄清规范，以及第 6 节的「运行中自改禁区与指导用户去设置页」规则。
2. **用户可编辑的角色卡正文（`definitionText`）**：作为夏澄的性格、语气、称呼与协作偏好注入，无论用户如何修订或清空补充内容，都不覆盖系统底座职责。

---

## 2. 后端写入、删除与配置保护约束

所有写入保护均在后端接口与服务层强制执行，前端禁用态仅作配合提示，不得仅靠前端隐藏按钮。

| 操作对象 / 路由 | 夏澄（`builtin_key = 'xiacheng'`）约束 | 普通角色 |
| --- | --- | --- |
| `DELETE /v1/roles/:roleId`（[RoleDeletionService](../../../backend/src/application/role-deletion-service.ts#L76-L122)） | **拒绝删除**，在处置前返回 `409 BUILTIN_ROLE_PROTECTED`。 | 允许删除（包括删光所有普通角色仅保留夏澄；`length <= 1` 仅作总角色兜底）。 |
| `PATCH /v1/roles/:roleId/definition`（[schemas.ts](../../../backend/src/http/schemas.ts#L37-L47)） | **允许**修改 `definition`（角色卡正文／payload）；若提交与「夏澄」不同的 `displayName`，拒绝返回 `409 BUILTIN_FIELD_LOCKED`（同值幂等或省略放行）；不接受改写只读 `bioText`。 | 正常修改 `displayName` 与 `definition`。 |
| `PUT /v1/roles/:roleId/bindings`（[ResourceService](../../../backend/src/application/resource-service.ts#L563-L598)） | **放开** `chat_model`、`mcp`、`skill` 绑定；`memory_model` 沿用既有回退规则（未单独绑定时继承 `chat_model`；如禁止单独绑定 `memory_model` 则统一在校验中拒绝非空 `memory_model` 或随现有回退规则处理）。 | 正常配置全部能力绑定。 |
| `PUT /v1/roles/:roleId/autonomy/budget`、语音 `/voice*`、生图 `/scene-image` | **放开**，走现有 `ROLE_CONFIG_WRITES` 守卫与业务规则。 | 正常配置。 |
| 外观服饰与差分（`appearance-routes.ts` / [AppearanceService](../../../backend/src/application/appearance-service.ts)） | **允许**新增自定义服饰（`isPreset = false`）并对自添服饰正常增删改；**禁止**对 `is_preset = 1` 的预置服饰或其预置 `home`／`sprite` 素材执行改名、替换、上传覆盖或删除（返回 `409 PRESET_APPEARANCE_LOCKED`）。 | 正常增删改，保留 `LAST_OUTFIT_REQUIRED`。 |

> **附带守卫检查**：[config-writes.ts](../../../backend/src/http/config-writes.ts) 当前覆盖 15 个 `ROLE_CONFIG_WRITES` 路由；夏澄相关的预置校验应挂在领域／服务层（在 `roleWrite` 验证角色已停止后、实际落库前拒绝并返回可识别错误码，不留未受保护直写旁路）。

---

## 3. 预置资料、外观空态与打包素材交付

### 3.1 解耦主题兜底图与角色立绘

按 `DL-153` 修订，必须消除现行前端「用夏澄主题图给所有无衣柜角色兜底」的耦合：

1. [HomeScene.tsx](../../../desktop/desk-preview/renderer/src/components/home/HomeScene.tsx#L101) 与 [Conversation.tsx](../../../desktop/desk-preview/renderer/src/pages/Conversation.tsx#L307-L314)：当选中角色衣柜为空或未选定有效 `home` 立绘时，**普通角色保持空态**（仅呈现书房／背景与空状态提示），不再回退展示夏澄主题人物插画。
2. [Relations.tsx](../../../desktop/desk-preview/renderer/src/Relations.tsx#L295-L300) 与 [load-dossier.ts](../../../desktop/desk-preview/renderer/src/relations/load-dossier.ts#L37-L47)：
   - 关系页「角色介绍」对内置角色优先展示只读预置介绍 `bioText`（可附带展示当前设定摘要），避免用户编辑性格正文后覆盖官方介绍；
   - 夏澄初始化时自动激活默认预置服饰（写入初始 `state.outfitId`），防止进入对话时误触发 `awaitingInitialOutfit` 卡在「正在换装」或因无 `home` 图在关系页显示空白。
3. **日夜切换与预置差分协同**：在夏澄新立绘与服饰重做完成前，首版预置默认服饰与差分复用现有夏澄资源注册进后端受管目录（复用 [AppearanceService](../../../backend/src/application/appearance-service.ts#L76) 与 [SegmentAnnotationService](../../../backend/src/application/segment-annotation-service.ts#L385)）；同时明确日夜主题与句段差分的取图协同——当仅命中基础形象而非特定句段差分时，支持夏澄按日夜主题切换对应基础立绘，后续重做正式服饰资产时直接替换预置资源目录并按 `is_preset = 1` 同步更新受管副本。

### 3.2 打包与资产定位

现行 [desktop/desk-preview/package.json](../../../desktop/desk-preview/package.json#L21) 与 [main.cjs](../../../desktop/desk-preview/main.cjs#L34-L70) 尚未把后端与随包预置素材写入打包清单。实施时需同步：

- 在后端配置（`BackendConfig` / 环境变量如 `NOWADAYS_PRESET_ASSETS_DIR`）支持显式指定随包交付的只读预置素材目录，桌面启动托管后端及发布构建脚本均注入对应路径（开发环境指向仓库资源目录，打包产物指向随应用交付的资源目录），不得写死源码相对路径；
- 自动化测试覆盖「桌面发布包（或隔离构建产物）启动 -> 空数据目录初始化夏澄 -> 读取预置人物介绍、日夜基础立绘与默认服饰差分」。

---

## 4. 桌面入口：冷启动角色选择页、去除「陪伴」与共享状态

1. **冷启动角色选择页（`DL-147`）**：
   - 应用冷启动进入主工作区前，先展示全屏「选择角色」入口页（视觉与交互参考 [Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L398-L410) 的藏书票墙弹窗并进一步精修排版与材质表现，严格使用 [前端设计规范](../../specs/frontend-design-system.md) `--nd-*` 令牌并通过 `npm run check`）。
   - 列表展示全部已建角色，夏澄带内置默认助手标识与快捷进入高亮；允许直接在入口页触发「创建角色」。用户选定某角色后进入系统主界面。
2. **全站移除「陪伴」概念与共享当前角色**：
   - 移除 [App.tsx](../../../desktop/desk-preview/renderer/src/App.tsx#L174) 的 `onSelectCompanion`、[Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L369-L404) 的「当前陪伴 / 设为当前陪伴 / 设为陪伴」标签与操作按钮、[Relations.tsx](../../../desktop/desk-preview/renderer/src/Relations.tsx#L225) 涉及「陪伴」的残留文案及对应样式类（`.config-companion`）。
   - 进入系统后，主页、关系页与对话页**共享**当前选中角色 `currentId`（可通过关系页「换一位」或对话页右上角色切换变更）；设置页维持仅修改当前编辑对象 `editId` 的隔离机制。
   - 角色配置页（[Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L700-L780)）对夏澄显示「内置助手 · 不可删除」说明与只读显示名／只读人物介绍／预置服饰锁定标识，但允许编辑角色卡正文、添加自定义服饰、配置对话模型、MCP／Skill 开关、自主额度与语音／生图。
3. **对话内轻量任务取消**：在存在运行中或暂停待答复的可续行办事任务时，对话栏提供轻量的「取消任务」操作调用第 5.3 节取消接口（不违背 `DL-141` 移除普通流式输出打断「停止」按钮的约定）。

---

## 5. 办事任务续行、暂停澄清、熔断取消与 Token 统计（`DL-154`～`DL-158`）

### 5.1 单段上限、自动续行与连续失败熔断

1. **显式续行语义与 15 轮切段**：
   - 修复现行 [agent-graph.ts](../../../backend/src/application/agent-graph.ts#L171-L341) 与 [conversation-service.ts](../../../backend/src/application/conversation-service.ts#L2315-L2337) 达到 `maxToolRounds` 直接抛 `ToolRoundLimitError` 把任务标 `failed` 并拉黑窗口的缺陷。
   - **单段执行上限默认设为 `15` 轮**（可通过配置项覆盖）。当办事任务在图内达到单段轮次上限、或模型显式调用续行工具（如 `task_continue` / 携带 `continue: true` 提交阶段进度汇报）时，后端提交本轮进度回复与状态（任务维持 `active`），并在 `finally` 阶段通过 `queueTaskContinuation` 沿原 `taskId` 自动排入下一执行段继续推进；普通闲聊及未声明续行的常规回复仍按默认 `completed` 结束，不误触发续行。
2. **连续失败／无进展熔断**：
   - 在原任务上累计连续失败计数：同一工具或同错误码连续失败 `3` 次，或连续 `3` 段续行既无成功新工具调用又无进度笔记推进时，强制触发熔断：停止继续派发，将任务置为 `paused`（原因记为熔断暂停），并向当前窗口提交说明当前障碍与已保存进度的汇报，等待用户决定是否调整或取消。
3. **用户输入优先与并发协调**：
   - 自动续行排队严格遵循 `DL-50`、`DL-80`～`DL-82`：待处理用户消息与正在输入退出优先于 `pendingContinuations`，新消息到达打断当前在途回复后由新决策综合判断；跨任务链继续沿用 [DL-110](../../161-digital-life-direction-decisions.md#dl-110-消耗按任务来源归属用户任务不扣自主额度自主任务继续扣点)（`origin = 'user'`，不扣角色自主活动点数）。

### 5.2 模型暂停、即时停派与用户澄清恢复（`DL-158`）

1. **图内即时停派**：改造 [agent-tools.ts](../../../backend/src/application/agent-tools.ts#L1244-L1289) 与 [agent-graph.ts](../../../backend/src/application/agent-graph.ts#L352) 中的 `task_pause` 语义：一旦该轮执行了 `task_pause`（写入 `reason` 与可选 `question` / `note`），当前 `toolsNode` 立即停止派发同一批后续未执行的外部工具（标为跳过/未派发），下一节点仅允许模型产出面向用户的澄清提问或进度说明（禁止再派发新工具调用），回复提交后任务以 `status = 'paused'` 落库，已发出的在途/后台工具仍按 `DL-53` / `DL-103` 保存真实结果或核查未知状态。
2. **用户回复澄清后接回原任务**：改造 [conversation-store.ts](../../../backend/src/storage/conversation-store.ts#L253-L389) 的 `beginExecution`：
   - 当用户在同一窗口发送新消息、且该窗口存在关联着因模型提问／熔断而处于 `paused` 状态的原用户委托任务时，新执行**自动关联并恢复该原 `taskId`**（`paused -> active`、`relation = 'continues'`），将原任务目标、进度笔记、`toolCalls` 历史及 `task_resource_continuations` 注入上下文，不另开新任务导致累计 token 与任务链断裂。
   - 若用户在同一窗口通过新消息明确放弃／取消，模型可调用 `task_finish(status="failed"|"completed", ...)` 结束原任务；或由用户直接点击显式取消入口。

### 5.3 显式任务取消接口

- 新增 `POST /v1/roles/:roleId/tasks/:taskId/cancel`（及 `ConversationService.cancelTask`）：
  - 若任务当前正在运行，中止对应执行（已发送工具结果仍按 `DL-103` 保存不强制重发）、清除 `pendingContinuations` 中对应任务、将任务置终态（如 `failed` + `endReason = 'USER_CANCELLED'`）并立即释放已无在途调用的资源延续占用，同时广播流事件通知前端。
  - 若任务处于 `paused` 等待用户状态，直接终结该任务链，后续在该窗口发新消息不再自动接回此已取消任务。
  - 供对话内轻量「取消任务」操作及后续独立的「任务管理」页面调用。

### 5.4 Token 分项采集、协议归一化与任务累计（`DL-155`～`DL-157`）

1. **四协议归一化（[protocols.ts](../../../backend/src/model/protocols.ts) · [google-gemini.ts](../../../backend/src/model/google-gemini.ts)）**：
   - `ModelEvent` 的 `usage` 扩展为：`{ inputTokens?: number; cachedTokens?: number; outputTokens?: number; cacheCreationTokens?: number }`。
   - 统一口径：**`inputTokens` 一律表示本次请求的总输入 token（含缓存读取与缓存写入），`cachedTokens` 表示命中缓存读取的 token**（恒满足 `cachedTokens <= inputTokens`）：
     - `openai-chat`：`inputTokens = prompt_tokens`，`cachedTokens = prompt_tokens_details?.cached_tokens`，`outputTokens = completion_tokens`；
     - `openai-responses`：`inputTokens = input_tokens`，`cachedTokens = input_tokens_details?.cached_tokens`，`outputTokens = output_tokens`；
     - `google-gemini`：`inputTokens = promptTokenCount`，`cachedTokens = cachedContentTokenCount`，`outputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)`；
     - `anthropic-messages`：`inputTokens = (input_tokens ?? 0) + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)`（并在流结束时取 `message_start` 与 `message_delta` 的最新累计值），`cachedTokens = cache_read_input_tokens`，`outputTokens = output_tokens`。
2. **采集与归属边界**：
   - 在 [conversation-service.ts](../../../backend/src/application/conversation-service.ts#L1798-L1805) 区分 `purpose`：用户委托办事任务／有续行任务归为 `'user_task'`（或通过 `execution_tasks` 关联 `taskId`）；
   - [agent-graph.ts](../../../backend/src/application/agent-graph.ts#L304-L314) 在上游失败／中断异常抛出前，若已收到部分 `usage` 事件也写入 `model_calls.usage_json`，不得丢弃；未返回 usage 时保留 `null` 不伪造为 `0`；
   - **明确排除**：后台记忆整理（`memory_maintenance`）与回复完成后的异步句段标注（[segment-annotation-service.ts](../../../backend/src/application/segment-annotation-service.ts)）**不计入**办事任务 token 统计。
3. **任务级查询输出**：
   - `GET /v1/roles/:roleId/tasks` 与 `GET /v1/roles/:roleId/tasks/:taskId` 返回 `usage: { inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; callCount: number; missingUsageCalls: number }`（按关联到该 `taskId` 的主决策 `model_calls` 汇总）。首版桌面端暂不在界面渲染该统计数值，由后端准确持久化与输出接口留待后续页面展示。

---

## 6. 夏澄内部管理工具清单与 MCP 扩展（`DL-159`）

### 6.1 内部管理工具清单（仅面向内置默认助手加载）

夏澄作为 `builtin_key = 'xiacheng'` 时，在 `loadAgentTools` 中挂载后端内部管理工具（直接调用现有应用服务，不经过本地 HTTP 自循环，保留操作来源与任务记录）。按**方案 A** 严格划分读写边界：

| 类别 | 工具名称（建议） | 底层复用服务 | 守卫与边界规则 |
| --- | --- | --- | --- |
| **只读查询** | `app_roles_list` / `app_role_get` / `app_activities_list` | `RoleService`、`RoleActivityService` | 读取全部角色档案、默认窗口、活动三态（`active`/`stopping`/`stopped`）与任务摘要。 |
| **只读查询** | `app_role_records_query` | `MessageService`、`MemoryQueryService`、`AutonomyService`、`ConversationService` | 按角色读取窗口历史消息、记忆事件／摘要／日记、自主额度、唤醒队列及任务详情（含 `usage`）。 |
| **只读查询** | `app_resources_list` / `app_resource_inspect` / `app_media_services_list` | `ResourceService`、`GlobalVoiceService`、`ImageServiceService` | 读取全局模型／MCP／Skill（含 `references` 与 `impact`）、语音服务、生图服务；**严禁返回密钥明文**，遵守 `env` 脱敏规则。 |
| **普通角色管理** | `app_role_create` / `app_role_activity` | `RoleService`、`RoleActivityService` | 创建普通角色；启停**其他普通角色**（禁止停止夏澄自身）。 |
| **普通角色管理** | `app_role_update` / `app_role_bindings_set` / `app_role_autonomy_set` | `RoleService`、`ResourceService`、`AutonomyService`、`RoleActivityService` | **仅限非夏澄角色**。目标普通角色处于 `active`/`stopping` 时，工具内部先调用 `requestStop` 并轮询等待确认 `stopped`（超时报明确状态），写入完成后按参数或原状态决定是否恢复或汇报用户；沿用 `bindingRevision` 与资源占用／维护校验。 |
| **全局安全配置** | `app_resource_create` / `app_resource_toggle` / `app_resource_update` / `app_resource_delete` / `app_model_test` | `ResourceService`、`ModelService`、`GlobalVoiceService`、`ImageServiceService` | 支持新建全局资源（模型／MCP／Skill／语音／生图）、触发连接探测与模型测试、全局启停 MCP/Skill（`onlyToggle`）。修改模型连接参数或删除资源前先查 `impact()` / `references()`：**若受影响活跃角色包含夏澄自身（或目标资源被夏澄正占用／使用为对话或记忆模型），直接拒绝写删**；若仅依赖其他普通角色，按现有 `maintenance` 协调暂停并修改。 |
| **能力触发** | `app_role_memory_trigger` / `app_role_wake_manage` | `MemoryRuntime`、`AutonomyService` | 触发指定角色的手动记忆整理批次（`POST .../memory/batches` 同语义），管理普通角色唤醒安排。 |

**对话内自改红线（强制拒绝并返回引导错误码 `409 SELF_MODIFICATION_VIA_SETTINGS_ONLY`）**：
1. 修改夏澄自身的 `definition`、绑定、自主额度、语音、生图、外观，或停止／删除夏澄；
2. 修改夏澄当前作为 `chat_model` 或 `memory_model`（含回退目标）正在使用的全局模型服务连接参数或凭据；
3. 修改或删除任何全局语音／生图服务（因 `GLOBAL_CONFIG_WRITES` 要求含夏澄在内的全员角色 `stopped`）。
夏澄收到此类请求时，应先调只读工具说明影响与当前配置状态，再在回复中明确指导用户前往「角色配置」或「设置」页面操作。

### 6.2 MCP 外部能力接入

- 沿用现有 [client.ts](../../../backend/src/mcp/client.ts)、`loadAgentTools` 与慢工具转后台链路接入本地 stdio MCP（电脑操作、联网搜索通过 MCP 工具扩展，夏澄可按 `DL-59` 在「角色配置 -> 扩展」独立开关各 MCP 与 Skill）。
- 首版自动化验收在离线测试中使用可控本地 stdio MCP 样例分别模拟「联网搜索」与「桌面控制」工具发现、参数校验、调用保存、慢工具转后台与错误恢复；真实第三方搜索／桌面 MCP 服务的安装与端到端联调另行独立留证，不把离线样例混作真实兼容性通过。

---

## 7. 验收清单与实施顺序

### 7.1 建议实施拆包顺序

1. **包 1（数据与约束基线）**：Schema 迁移（`builtin_key`、`bio_text`、`is_preset`、`tasks` 续行与取消字段）、启动预置与同名共存、不可删除／锁定校验、人设分层底座、取消接口与四协议 Token 归一化汇总。
2. **包 2（续行、澄清与夏澄管理工具）**：单段 15 轮自动切段、连续失败熔断、`task_pause` 图内即时停派与同窗回复接回原 `taskId`、内部管理工具清单与方案 A 守卫、MCP 样例闭环。
3. **包 3（桌面冷启动选角页与配置体验）**：冷启动精修选角页、移除全站「陪伴」概念、无图角色空态解耦、夏澄只读介绍／预置服饰锁定＋自添服饰开放、对话内轻量取消任务入口，以及打包产物预置素材路径对齐。

### 7.2 验收通过条件

| 场景 | 可验证通过条件 |
| --- | --- |
| **预置、重启与同名共存** | 空数据启动仅创建一个 `builtin_key = 'xiacheng'` 实例（初始 `stopped`）；启动中断再试与重启后 `roleId` 保持不变，既有用户数据与同名为「夏澄」的普通角色不受影响且可共存。 |
| **写入保护与开放项** | 删夏澄返回 `409 BUILTIN_ROLE_PROTECTED`；改显示名返回 `409 BUILTIN_FIELD_LOCKED`；改预置服饰／预置素材返回 `409 PRESET_APPEARANCE_LOCKED`；可正常修改角色卡正文、追加并删除自定义服饰、配置对话模型、开关 MCP/Skill、修改自主额度与语音/生图配置；普通角色全删至只剩夏澄可通过。 |
| **空态、选角页与去陪伴** | 普通无图角色在主页、关系、对话均保持空态（不闪现夏澄图）；冷启动先进入选角页并可选择角色进入共享工作区；全站无「当前陪伴／设为陪伴」残留；夏澄系统底座与可编辑正文分离生效，只读人物介绍不受性格修改影响。 |
| **自动续行、熔断与澄清恢复** | 多步办事任务超过 15 轮不报错 `failed` 也不拉黑窗口，保存进度自动续行；连续 3 次同类工具报错自动熔断暂停并向用户汇报；`task_pause` 后当执行立刻停止新工具派发；用户回复澄清后自动接回原 `taskId` 继续并保留原进度笔记与资源延续；通过指令与 `POST .../cancel` 均可彻底取消任务链；普通闲聊不误续行。 |
| **Token 归一化与累计** | 离线四协议（含 OpenAI/Responses/Gemini/Anthropic 缓存字段与失败带 usage 场景）归集一致，`cachedTokens <= inputTokens`；跨段续行与暂停恢复累加到同一 `taskId`，后台记忆整理与句段标注**不计入**该统计；无 usage 时真实累计 `missingUsageCalls`。 |
| **内部管理与 MCP** | 夏澄在对话中可查询全局与各角色状态／任务用量、自动停机并修改运行中的普通角色配置；请求修改夏澄自身配置、正在用的模型连接或需全员停机的语音/生图服务时，后端返回引导拒绝、夏澄明确说明引导去设置页；本地模拟搜索／桌面 MCP 完成工具发现、执行与慢工具转后台验收；打包产物可正确定位并初始化预置素材。 |
| **全仓回归门禁** | 实施与复核均按约定通过：后端 `npm run typecheck`、`npm test`、`accept-offline.mjs`；桌面 `npm run check`、`npm run build`、`tests/*.test.cjs`；隔离 Electron E2E 与 `node scripts/check-docs.mjs`；真实外部模型与真实第三方 MCP 联调单独留证。 |

## 8. 包 1 独立复核

2026-11-17。在 `dev-front` 的 `dd2a8c0` 基础上复核包 1 实施工作树。**独立复核未通过，以下三个边界均已复现。**

后端实际运行 `npm run accept:offline`，Node.js v24.22.2 下 21 步全部通过。433 项正式测试含包 1 的 9 项用例，另有 2 项交付回归。195 项验收清单文件的哈希一致，真实服务调用为 0。运行结果在 `backend/test-results/p5-2026-11-17T01-10-23-333Z-2ddf916d/summary.json`。补充用例与观测在 `backend/test-results/310-pack1-independent-20261117/probe.ts` 和同目录的 `report.json`。

| 编号 | 独立复现与验收要求 |
| --- | --- |
| R01 · P2 · 取消写入失败后执行和任务状态分裂 | 在离线模型处理已启动的任务时，向 SQLite 注入任务终态写入错误。取消抛出错误，原执行已从 `running` 变为 `failed`，任务仍为 `active`，取消事件为 0。解除故障并让原执行收尾，调度器创建新执行，任务随后完成。取消请求应保证任务终态、执行终态、取消事件与内存调度一致。复验覆盖写任务终态失败、写取消事件失败及请求重试。 [取消流程](../../../backend/src/application/conversation-service.ts#L483) |
| R02 · P2 · 同名自定义服饰导致预置重复导入 | 无素材启动后给夏澄新增自定义「日常常服」，随后放入名为「日常常服」的官方 `default` 素材。首次启动创建「日常常服（预置）」，之后两次启动各生成一套带后缀的新预置。三次启动预置数量为 1、2、3，角色编号始终相同。预置应按稳定来源标识匹配。复验需保留同名自定义服饰，重复启动及预置显示名修改时沿用已有预置服饰身份。 [预置服饰匹配](../../../backend/src/application/preset-assistant.ts#L120) |
| R03 · P2 · 工具参数无效时丢掉已收到的 token 用量 | 本地 OpenAI Chat SSE 已返回输入 27、输出 9，并正常发送 `[DONE]`。工具参数为截断 JSON，适配器抛出 `MODEL_TOOL_ARGUMENTS_INVALID`，期间没有发出 `usage` 事件。解析在流异常处理块外执行，且先于最终用量事件。应保留已收到的用量，同时维持原解析错误及禁止派发无效调用的行为。复验覆盖 OpenAI Chat，并检查同样先解析工具参数再发用量的 Responses、Anthropic 路径和任务汇总。 [流结束后的工具解析](../../../backend/src/model/protocols.ts#L227) |

本次复核仅覆盖包 1 后端、随仓预置素材和本地离线验收。桌面后续包、发布包运行、真实模型和第三方 MCP 联调另按对应工作包复验。

### 8.1 包 1 复核缺口补修（2026-11-17，自验通过，待独立复验）

针对第 8 节提出的 R01～R03 已完成修复并补充自动化回归用例，全部进入本地离线全量自验（尚待独立复验）：

1. **R01 · 取消写入与内存状态原子收敛**：[ConversationService.cancelTask](../../../backend/src/application/conversation-service.ts#L483) 将 `interruptExecution`、`finishTask` 与 `appendStreamEvent("task_cancelled")` 合并至单笔 SQLite 事务内执行且不再吞掉执行中断写库异常；仅在事务成功提交后清理 `pendingContinuations` 并中止／摘除在途执行句柄，确保写入任务终态或取消事件失败时整笔回滚、重试与放行原执行均保持一致。
2. **R02 · 预置服饰稳定来源标识（`BUSINESS V22`）**：[schema.ts](../../../backend/src/storage/schema.ts#L12) 升级业务库至 V22，在 `outfits` 新增 `preset_key TEXT` 与局部唯一索引 `idx_outfits_role_preset_key`（[appearance.ts](../../../backend/src/domain/appearance.ts) · [appearance-store.ts](../../../backend/src/storage/appearance-store.ts)）；[preset-assistant.ts](../../../backend/src/application/preset-assistant.ts#L116) 优先按 `presetKey`（目录 slug，兼容 V21 遗留 `preset_key IS NULL` 回填）匹配已有预置服饰并排除自身后解决冲突命名，重复重启及修改预置显示名时沿用原 `outfitId` 且保留同名自定义服饰。
3. **R03 · 后置解析工具参数异常保留已收到的 Token 用量**：[protocols.ts](../../../backend/src/model/protocols.ts) 中 `streamOpenAiChat`、`streamOpenAiResponses` 与 `streamAnthropic` 均将流结束后的 `parseToolArguments` 提前放入外层 `try ... catch` 块内执行（先完成全部工具参数 JSON 解析并暂存，任一参数无效时由 `catch` 在抛出 `MODEL_TOOL_ARGUMENTS_INVALID` 前优先发出已收到的 `usage` 事件，且不发出 `tool_call` 或 `completed`），配合 `AgentGraph` 将该轮消耗累计至任务失败调用与任务 `usage` 汇总。
4. **自验证据**：新增 R01～R03 专项回归至 [p19-preset-assistant-pack1.test.ts](../../../backend/tests/p19-preset-assistant-pack1.test.ts)（共 12 项全部通过）；全量 `npx -y node@24 scripts/accept-offline.mjs` 21／21 步通过（`436/436` 正式测试、2 项交付测试、`process-smoke` 与 16 项独立脚本校验通过，`realServiceCalls = 0`，报告位于 `backend/test-results/p5-2026-11-17T02-25-43-104Z-e98155af/summary.json`）。
