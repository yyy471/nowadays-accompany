# 310 夏澄默认助手首版开发文档

日期：2026-11-16（经复核定稿）。本工作包依据 [DL-147](../../161-digital-life-direction-decisions.md#dl-147-移除陪伴角色概念按角色查看和编辑) 与 [DL-153～DL-159](../../161-digital-life-direction-decisions.md#dl-153-夏澄作为预置默认助手沿用现有对话链路) 实施，并与现行规范 [角色配置与活动守卫](../../specs/role-config-and-activity.md)、[存储、记忆与自主执行](../../specs/storage-memory-and-autonomy.md)、[对话演出与过场图](../../specs/conversation-performance-and-scene-images.md) 及 [前端设计规范](../../specs/frontend-design-system.md) 保持一致。本工作包当前待实施。

> **范围边界（不纳入本工作包）**：夏澄新美术立绘与服饰资产重绘、独立的「任务管理」页面（仅在后端预留任务取消与统计查询接口）、本地电脑操作独立小样及远程 Streamable HTTP MCP（[DL-115](../../161-digital-life-direction-decisions.md#dl-115-远程-mcp-排期桌面前端完成后实施)）留待后续工作包。

---

## 1. 内置角色身份、数据模型与幂等初始化

### 1.1 Schema 扩展与身份识别

现行 [schema.ts](../../../apps/backend/src/storage/core/schema.ts#L141-L173) 尚无内置标识与独立只读展示介绍字段。需按既有版本迁移机制推进 `APP_SCHEMA_VERSION` 与 `BUSINESS_SCHEMA_VERSION`：

1. **`app.sqlite`（`roles` 表）**：新增 `builtin_key TEXT`（唯一部分索引 `WHERE builtin_key IS NOT NULL`），夏澄固定为 `"xiacheng"`；`GET /v1/roles` 与 `GET /v1/roles/:roleId` 返回 `isBuiltin: boolean` 与 `builtinKey: string | null`。
2. **`business.sqlite`（`roles` 表）**：新增 `builtin_key TEXT` 与独立展示字段 `bio_text TEXT NOT NULL DEFAULT ''`（供关系页「角色介绍」只读展示预置介绍）；**不得**再用 `definition_text` 同时充当只读展示介绍与可编辑人设。
3. **外观表（`outfits` 与 `outfit_assets`）**：新增 `is_preset INTEGER NOT NULL DEFAULT 0 CHECK (is_preset IN (0, 1))`，随包预置的默认服饰与官方立绘／差分均标记 `is_preset = 1`；列表与详情接口返回 `isPreset: boolean`。
4. **任务表（`tasks`）**：补充任务级可续行与等待字段（如 `continuable INTEGER` / `wait_reason TEXT` / `consecutive_failures INTEGER` 等）以支撑 `DL-154` / `DL-158`（见第 5 节）。

### 1.2 唯一实例、共存与启动初始化

- **后端启动初始化**：在后端启动链（`RoleService` 复用 [role-service.ts](../../../apps/backend/src/application/role/role-service.ts#L66-L153) 四步初始化）中按 `builtin_key = 'xiacheng'` 查找内置实例：
  - **不存在时**：生成或分配稳定 `roleId`，写入 `builtin_key = 'xiacheng'`、`displayName = '夏澄'`、预置 `bioText`、初始可编辑 `definitionText`、初始 `stopped` 活动态（沿用 `markCreatedStopped` 与首次模型引导规则）及预置默认服饰／差分；
  - **初始化中断（`initializing` / `failed`）或重启重试时**：沿用原 `roleId` 调用 `initializeRole` 幂等补齐缺失数据库、主窗口或预置外观；
  - **升级与同名共存**：同一数据目录最多创建一个 `builtin_key = 'xiacheng'` 实例；既有历史库中若已存在名为「夏澄」但 `builtin_key IS NULL` 的普通角色，保持其原 `roleId` 与数据不动，不将其强行改写为内置实例。升级与重启保留夏澄已保存的角色卡正文、模型与扩展绑定、自定义服饰、记忆及对话历史。

### 1.3 人设分层注入

[ConversationService.buildSystemPrompt](../../../apps/backend/src/application/conversation/conversation-service.ts#L2858) 对 `builtinKey === 'xiacheng'` 的角色采用**底座＋补充正文**两层组装：

1. **不可覆盖的系统底座（后端固定注入）**：包含默认通用办事助手定位、真实调用工具与严禁编造结果约束、多步推进分段续行与 `task_pause` 澄清规范，以及第 6 节的「运行中自改禁区与指导用户去设置页」规则。
2. **用户可编辑的角色卡正文（`definitionText`）**：作为夏澄的性格、语气、称呼与协作偏好注入，无论用户如何修订或清空补充内容，都不覆盖系统底座职责。

---

## 2. 后端写入、删除与配置保护约束

所有写入保护均在后端接口与服务层强制执行，前端禁用态仅作配合提示，不得仅靠前端隐藏按钮。

| 操作对象 / 路由 | 夏澄（`builtin_key = 'xiacheng'`）约束 | 普通角色 |
| --- | --- | --- |
| `DELETE /v1/roles/:roleId`（[RoleDeletionService](../../../apps/backend/src/application/role/role-deletion-service.ts#L76-L122)） | **拒绝删除**，在处置前返回 `409 BUILTIN_ROLE_PROTECTED`。 | 允许删除（包括删光所有普通角色仅保留夏澄；`length <= 1` 仅作总角色兜底）。 |
| `PATCH /v1/roles/:roleId/definition`（[schemas.ts](../../../apps/backend/src/http/schemas.ts#L37-L47)） | **允许**修改 `definition`（角色卡正文／payload）；若提交与「夏澄」不同的 `displayName`，拒绝返回 `409 BUILTIN_FIELD_LOCKED`（同值幂等或省略放行）；不接受改写只读 `bioText`。 | 正常修改 `displayName` 与 `definition`。 |
| `PUT /v1/roles/:roleId/bindings`（[ResourceService](../../../apps/backend/src/application/resources/resource-service.ts#L563-L598)） | **放开** `chat_model`、`mcp`、`skill` 绑定；`memory_model` 沿用既有回退规则（未单独绑定时继承 `chat_model`；如禁止单独绑定 `memory_model` 则统一在校验中拒绝非空 `memory_model` 或随现有回退规则处理）。 | 正常配置全部能力绑定。 |
| `PUT /v1/roles/:roleId/autonomy/budget`、语音 `/voice*`、生图 `/scene-image` | **放开**，走现有 `ROLE_CONFIG_WRITES` 守卫与业务规则。 | 正常配置。 |
| 外观服饰与差分（`appearance-routes.ts` / [AppearanceService](../../../apps/backend/src/application/media/appearance-service.ts)） | **允许**新增自定义服饰（`isPreset = false`）并对自添服饰正常增删改；**禁止**对 `is_preset = 1` 的预置服饰或其预置 `home`／`sprite` 素材执行改名、替换、上传覆盖或删除（返回 `409 PRESET_APPEARANCE_LOCKED`）。 | 正常增删改，保留 `LAST_OUTFIT_REQUIRED`。 |

> **附带守卫检查**：[config-writes.ts](../../../apps/backend/src/http/config-writes.ts) 当前覆盖 15 个 `ROLE_CONFIG_WRITES` 路由；夏澄相关的预置校验应挂在领域／服务层（在 `roleWrite` 验证角色已停止后、实际落库前拒绝并返回可识别错误码，不留未受保护直写旁路）。

---

## 3. 预置资料、外观空态与打包素材交付

### 3.1 解耦主题兜底图与角色立绘

按 `DL-153` 修订，必须消除现行前端「用夏澄主题图给所有无衣柜角色兜底」的耦合：

1. [HomeScene.tsx](../../../apps/desktop/renderer/src/components/home/HomeScene.tsx#L101) 与 [Conversation.tsx](../../../apps/desktop/renderer/src/pages/Conversation.tsx#L307-L314)：当选中角色衣柜为空或未选定有效 `home` 立绘时，**普通角色保持空态**（仅呈现书房／背景与空状态提示），不再回退展示夏澄主题人物插画。
2. [Relations.tsx](../../../apps/desktop/renderer/src/pages/Relations.tsx#L295-L300) 与 [load-dossier.ts](../../../apps/desktop/renderer/src/relations/load-dossier.ts#L37-L47)：
   - 关系页「角色介绍」对内置角色优先展示只读预置介绍 `bioText`（可附带展示当前设定摘要），避免用户编辑性格正文后覆盖官方介绍；
   - 夏澄初始化时自动激活默认预置服饰（写入初始 `state.outfitId`），防止进入对话时误触发 `awaitingInitialOutfit` 卡在「正在换装」或因无 `home` 图在关系页显示空白。
3. **日夜切换与预置差分协同**：在夏澄新立绘与服饰重做完成前，首版预置默认服饰与差分复用现有夏澄资源注册进后端受管目录（复用 [AppearanceService](../../../apps/backend/src/application/media/appearance-service.ts#L76) 与 [SegmentAnnotationService](../../../apps/backend/src/application/conversation/segment-annotation-service.ts#L385)）；同时明确日夜主题与句段差分的取图协同——当仅命中基础形象而非特定句段差分时，支持夏澄按日夜主题切换对应基础立绘，后续重做正式服饰资产时直接替换预置资源目录并按 `is_preset = 1` 同步更新受管副本。

### 3.2 打包与资产定位

现行 [apps/desktop/package.json](../../../apps/desktop/package.json#L21) 与 [main.cjs](../../../apps/desktop/electron/main.cjs#L34-L70) 尚未把后端与随包预置素材写入打包清单。实施时需同步：

- 在后端配置（`BackendConfig` / 环境变量如 `NOWADAYS_PRESET_ASSETS_DIR`）支持显式指定随包交付的只读预置素材目录，桌面启动托管后端及发布构建脚本均注入对应路径（开发环境指向仓库资源目录，打包产物指向随应用交付的资源目录），不得写死源码相对路径；
- 自动化测试覆盖「桌面发布包（或隔离构建产物）启动 -> 空数据目录初始化夏澄 -> 读取预置人物介绍、日夜基础立绘与默认服饰差分」。

---

## 4. 桌面入口：冷启动角色选择页、去除「陪伴」与共享状态

1. **冷启动角色选择页（`DL-147`）**：
   - 应用冷启动进入主工作区前，先展示全屏「选择角色」入口页（视觉与交互参考 [Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L398-L410) 的藏书票墙弹窗并进一步精修排版与材质表现，严格使用 [前端设计规范](../../specs/frontend-design-system.md) `--nd-*` 令牌并通过 `npm run check`）。
   - 列表展示全部已建角色，夏澄带内置默认助手标识与快捷进入高亮；允许直接在入口页触发「创建角色」。用户选定某角色后进入系统主界面。
2. **全站移除「陪伴」概念与共享当前角色**：
   - 移除 [App.tsx](../../../apps/desktop/renderer/src/App.tsx#L174) 的 `onSelectCompanion`、[Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L369-L404) 的「当前陪伴 / 设为当前陪伴 / 设为陪伴」标签与操作按钮、[Relations.tsx](../../../apps/desktop/renderer/src/pages/Relations.tsx#L225) 涉及「陪伴」的残留文案及对应样式类（`.config-companion`）。
   - 进入系统后，主页、关系页与对话页**共享**当前选中角色 `currentId`（可通过关系页「换一位」或对话页右上角色切换变更）；设置页维持仅修改当前编辑对象 `editId` 的隔离机制。
   - 角色配置页（[Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L700-L780)）对夏澄显示「内置助手 · 不可删除」说明与只读显示名／只读人物介绍／预置服饰锁定标识，但允许编辑角色卡正文、添加自定义服饰、配置对话模型、MCP／Skill 开关、自主额度与语音／生图。
3. **对话内轻量任务取消**：在存在运行中或暂停待答复的可续行办事任务时，对话栏提供轻量的「取消任务」操作调用第 5.3 节取消接口（不违背 `DL-141` 移除普通流式输出打断「停止」按钮的约定）。

---

## 5. 办事任务续行、暂停澄清、熔断取消与 Token 统计（`DL-154`～`DL-158`）

### 5.1 单段上限、自动续行与连续失败熔断

1. **显式续行语义与 15 轮切段**：
   - 修复现行 [agent-graph.ts](../../../apps/backend/src/application/conversation/agent-graph.ts#L171-L341) 与 [conversation-service.ts](../../../apps/backend/src/application/conversation/conversation-service.ts#L2315-L2337) 达到 `maxToolRounds` 直接抛 `ToolRoundLimitError` 把任务标 `failed` 并拉黑窗口的缺陷。
   - **单段执行上限默认设为 `15` 个模型决策轮**（可通过配置项覆盖）。这里的「轮」指模型决策轮：图内判定为 `state.round + 1 >= maxToolRounds` 时该轮只提交进度、不再派发工具，因此**单段最多实际派发 `maxToolRounds - 1` 次工具调用（默认 14 次）**，「15 轮」不等于「15 次工具派发」。当办事任务达到单段轮次上限、或模型显式调用续行工具（如 `task_continue` / 携带 `continue: true` 提交阶段进度汇报）时，后端提交本轮进度回复与状态（任务维持 `active`），并在 `finally` 阶段通过 `queueTaskContinuation` 沿原 `taskId` 自动排入下一执行段继续推进；普通闲聊及未声明续行的常规回复仍按默认 `completed` 结束，不误触发续行。
2. **连续失败／无进展熔断**：
   - 在原任务上累计连续失败计数：同一工具或同错误码连续失败 `3` 次，或连续 `3` 段续行既无成功新工具调用又无进度笔记推进时，强制触发熔断：停止继续派发，将任务置为 `paused`（原因记为熔断暂停），并向当前窗口提交说明当前障碍与已保存进度的汇报，等待用户决定是否调整或取消。
3. **用户输入优先与并发协调**：
   - 自动续行排队严格遵循 `DL-50`、`DL-80`～`DL-82`：待处理用户消息与正在输入退出优先于 `pendingContinuations`，新消息到达打断当前在途回复后由新决策综合判断；跨任务链继续沿用 [DL-110](../../161-digital-life-direction-decisions.md#dl-110-消耗按任务来源归属用户任务不扣自主额度自主任务继续扣点)（`origin = 'user'`，不扣角色自主活动点数）。

### 5.2 模型暂停、即时停派与用户澄清恢复（`DL-158`）

1. **图内即时停派**：改造 [agent-tools.ts](../../../apps/backend/src/application/conversation/agent-tools.ts#L1244-L1289) 与 [agent-graph.ts](../../../apps/backend/src/application/conversation/agent-graph.ts#L352) 中的 `task_pause` 语义：**`task_pause` 需当前执行已关联活动任务（`context.taskId !== null`）才生效**；若首个工具即为 `task_pause`（任务尚未建立），工具返回 `TASK_REQUIRED`、暂停不生效，同批后续调用照常派发（工具描述已注明该前置条件）。一旦该轮成功执行 `task_pause`（写入 `reason` 与可选 `question` / `note`），当前 `toolsNode` 立即停止派发同一批后续未执行的外部工具（标为跳过/未派发），下一节点仅允许模型产出面向用户的澄清提问或进度说明（禁止再派发新工具调用），回复提交后任务以 `status = 'paused'` 落库，已发出的在途/后台工具仍按 `DL-53` / `DL-103` 保存真实结果或核查未知状态。
2. **用户回复澄清后接回原任务**：改造 [conversation-store.ts](../../../apps/backend/src/storage/conversation/conversation-store.ts#L253-L389) 的 `beginExecution`：
   - 当用户在同一窗口发送新消息、且该窗口存在关联着因模型提问／熔断而处于 `paused` 状态的原用户委托任务时，新执行**自动关联并恢复该原 `taskId`**（`paused -> active`、`relation = 'continues'`），将原任务目标、进度笔记、`toolCalls` 历史及 `task_resource_continuations` 注入上下文，不另开新任务导致累计 token 与任务链断裂。
   - 若用户在同一窗口通过新消息明确放弃／取消，模型可调用 `task_finish(status="failed"|"completed", ...)` 结束原任务；或由用户直接点击显式取消入口。

### 5.3 显式任务取消接口

- 新增 `POST /v1/roles/:roleId/tasks/:taskId/cancel`（及 `ConversationService.cancelTask`）：
  - 若任务当前正在运行，中止对应执行（已发送工具结果仍按 `DL-103` 保存不强制重发）、清除 `pendingContinuations` 中对应任务、将任务置终态（如 `failed` + `endReason = 'USER_CANCELLED'`）并立即释放已无在途调用的资源延续占用，同时广播流事件通知前端。
  - 若任务处于 `paused` 等待用户状态，直接终结该任务链，后续在该窗口发新消息不再自动接回此已取消任务。
  - 供对话内轻量「取消任务」操作及后续独立的「任务管理」页面调用。

### 5.4 Token 分项采集、协议归一化与任务累计（`DL-155`～`DL-157`）

1. **四协议归一化（[protocols.ts](../../../apps/backend/src/model/protocols.ts) · [google-gemini.ts](../../../apps/backend/src/model/google-gemini.ts)）**：
   - `ModelEvent` 的 `usage` 扩展为：`{ inputTokens?: number; cachedTokens?: number; outputTokens?: number; cacheCreationTokens?: number }`。
   - 统一口径：**`inputTokens` 一律表示本次请求的总输入 token（含缓存读取与缓存写入），`cachedTokens` 表示命中缓存读取的 token**（恒满足 `cachedTokens <= inputTokens`）：
     - `openai-chat`：`inputTokens = prompt_tokens`，`cachedTokens = prompt_tokens_details?.cached_tokens`，`outputTokens = completion_tokens`；
     - `openai-responses`：`inputTokens = input_tokens`，`cachedTokens = input_tokens_details?.cached_tokens`，`outputTokens = output_tokens`；
     - `google-gemini`：`inputTokens = promptTokenCount`，`cachedTokens = cachedContentTokenCount`，`outputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)`；
     - `anthropic-messages`：`inputTokens = (input_tokens ?? 0) + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)`（并在流结束时取 `message_start` 与 `message_delta` 的最新累计值），`cachedTokens = cache_read_input_tokens`，`outputTokens = output_tokens`。
2. **采集与归属边界**：
   - 在 [conversation-service.ts](../../../apps/backend/src/application/conversation/conversation-service.ts#L1798-L1805) 区分 `purpose`：用户委托办事任务／有续行任务归为 `'user_task'`（或通过 `execution_tasks` 关联 `taskId`）；
   - [agent-graph.ts](../../../apps/backend/src/application/conversation/agent-graph.ts#L304-L314) 在上游失败／中断异常抛出前，若已收到部分 `usage` 事件也写入 `model_calls.usage_json`，不得丢弃；未返回 usage 时保留 `null` 不伪造为 `0`；
   - **明确排除**：后台记忆整理（`memory_maintenance`）与回复完成后的异步句段标注（[segment-annotation-service.ts](../../../apps/backend/src/application/conversation/segment-annotation-service.ts)）**不计入**办事任务 token 统计。
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

- 沿用现有 [client.ts](../../../apps/backend/src/mcp/client.ts)、`loadAgentTools` 与慢工具转后台链路接入本地 stdio MCP（电脑操作、联网搜索通过 MCP 工具扩展，夏澄可按 `DL-59` 在「角色配置 -> 扩展」独立开关各 MCP 与 Skill）。
- 首版自动化验收在离线测试中使用可控本地 stdio MCP 样例分别模拟「联网搜索」与「桌面控制」工具发现、参数校验、调用保存、慢工具转后台与错误恢复；真实第三方搜索／桌面 MCP 服务的安装与端到端联调另行独立留证，不把离线样例混作真实兼容性通过。

---

## 7. 验收清单与实施顺序

### 7.1 建议实施拆包顺序

1. **包 1（数据与约束基线）**：Schema 迁移（`builtin_key`、`bio_text`、`is_preset`、`tasks` 续行与取消字段）、启动预置与同名共存、不可删除／锁定校验、人设分层底座、取消接口与四协议 Token 归一化汇总。
2. **包 2（续行、澄清与夏澄管理工具）**：单段 15 个模型轮（最多实派 14 次工具）自动切段、连续失败熔断、`task_pause` 图内即时停派与同窗回复接回原 `taskId`、内部管理工具清单与方案 A 守卫、MCP 样例闭环。
3. **包 3（桌面冷启动选角页与配置体验）**：冷启动精修选角页、移除全站「陪伴」概念、无图角色空态解耦、夏澄只读介绍／预置服饰锁定＋自添服饰开放、对话内轻量取消任务入口，以及打包产物预置素材路径对齐。

### 7.2 验收通过条件

| 场景 | 可验证通过条件 |
| --- | --- |
| **预置、重启与同名共存** | 空数据启动仅创建一个 `builtin_key = 'xiacheng'` 实例（初始 `stopped`）；启动中断再试与重启后 `roleId` 保持不变，既有用户数据与同名为「夏澄」的普通角色不受影响且可共存。 |
| **写入保护与开放项** | 删夏澄返回 `409 BUILTIN_ROLE_PROTECTED`；改显示名返回 `409 BUILTIN_FIELD_LOCKED`；改预置服饰／预置素材返回 `409 PRESET_APPEARANCE_LOCKED`；可正常修改角色卡正文、追加并删除自定义服饰、配置对话模型、开关 MCP/Skill、修改自主额度与语音/生图配置；普通角色全删至只剩夏澄可通过。 |
| **空态、选角页与去陪伴** | 普通无图角色在主页、关系、对话均保持空态（不闪现夏澄图）；冷启动先进入选角页并可选择角色进入共享工作区；全站无「当前陪伴／设为陪伴」残留；夏澄系统底座与可编辑正文分离生效，只读人物介绍不受性格修改影响。 |
| **自动续行、熔断与澄清恢复** | 多步办事任务达到单段上限（15 个模型决策轮，最多实派 14 次工具）不报错 `failed` 也不拉黑窗口，保存进度自动续行；连续 3 次同类工具报错自动熔断暂停并向用户汇报；`task_pause` 后当执行立刻停止新工具派发；用户回复澄清后自动接回原 `taskId` 继续并保留原进度笔记与资源延续；通过指令与 `POST .../cancel` 均可彻底取消任务链；普通闲聊不误续行。 |
| **Token 归一化与累计** | 离线四协议（含 OpenAI/Responses/Gemini/Anthropic 缓存字段与失败带 usage 场景）归集一致，`cachedTokens <= inputTokens`；跨段续行与暂停恢复累加到同一 `taskId`，后台记忆整理与句段标注**不计入**该统计；无 usage 时真实累计 `missingUsageCalls`。 |
| **内部管理与 MCP** | 夏澄在对话中可查询全局与各角色状态／任务用量、自动停机并修改运行中的普通角色配置；请求修改夏澄自身配置、正在用的模型连接或需全员停机的语音/生图服务时，后端返回引导拒绝、夏澄明确说明引导去设置页；本地模拟搜索／桌面 MCP 完成工具发现、执行与慢工具转后台验收；打包产物可正确定位并初始化预置素材。 |
| **全仓回归门禁** | 实施与复核均按约定通过：后端 `npm run typecheck`、`npm test`、`accept-offline.mjs`；桌面 `npm run check`、`npm run build`、`tests/*.test.cjs`；隔离 Electron E2E 与 `node scripts/check-docs.mjs`；真实外部模型与真实第三方 MCP 联调单独留证。 |

## 8. 包 1 独立复核

2026-11-17。在 `dev-front` 的 `dd2a8c0` 基础上复核包 1 实施工作树。**独立复核未通过，以下三个边界均已复现。**

后端实际运行 `npm run accept:offline`，Node.js v24.22.2 下 21 步全部通过。433 项正式测试含包 1 的 9 项用例，另有 2 项交付回归。195 项验收清单文件的哈希一致，真实服务调用为 0。运行结果在 `apps/backend/test-results/p5-2026-11-17T01-10-23-333Z-2ddf916d/summary.json`。补充用例与观测在 `apps/backend/test-results/310-pack1-independent-20261117/probe.ts` 和同目录的 `report.json`。

| 编号 | 独立复现与验收要求 |
| --- | --- |
| R01 · P2 · 取消写入失败后执行和任务状态分裂 | 在离线模型处理已启动的任务时，向 SQLite 注入任务终态写入错误。取消抛出错误，原执行已从 `running` 变为 `failed`，任务仍为 `active`，取消事件为 0。解除故障并让原执行收尾，调度器创建新执行，任务随后完成。取消请求应保证任务终态、执行终态、取消事件与内存调度一致。复验覆盖写任务终态失败、写取消事件失败及请求重试。 [取消流程](../../../apps/backend/src/application/conversation/conversation-service.ts#L483) |
| R02 · P2 · 同名自定义服饰导致预置重复导入 | 无素材启动后给夏澄新增自定义「日常常服」，随后放入名为「日常常服」的官方 `default` 素材。首次启动创建「日常常服（预置）」，之后两次启动各生成一套带后缀的新预置。三次启动预置数量为 1、2、3，角色编号始终相同。预置应按稳定来源标识匹配。复验需保留同名自定义服饰，重复启动及预置显示名修改时沿用已有预置服饰身份。 [预置服饰匹配](../../../apps/backend/src/application/role/preset-assistant.ts#L120) |
| R03 · P2 · 工具参数无效时丢掉已收到的 token 用量 | 本地 OpenAI Chat SSE 已返回输入 27、输出 9，并正常发送 `[DONE]`。工具参数为截断 JSON，适配器抛出 `MODEL_TOOL_ARGUMENTS_INVALID`，期间没有发出 `usage` 事件。解析在流异常处理块外执行，且先于最终用量事件。应保留已收到的用量，同时维持原解析错误及禁止派发无效调用的行为。复验覆盖 OpenAI Chat，并检查同样先解析工具参数再发用量的 Responses、Anthropic 路径和任务汇总。 [流结束后的工具解析](../../../apps/backend/src/model/protocols.ts#L227) |

本次复核仅覆盖包 1 后端、随仓预置素材和本地离线验收。桌面后续包、发布包运行、真实模型和第三方 MCP 联调另按对应工作包复验。

### 8.1 包 1 复核缺口补修（2026-11-17，自验通过，待独立复验）

针对第 8 节提出的 R01～R03 已完成修复并补充自动化回归用例，全部进入本地离线全量自验（尚待独立复验）：

1. **R01 · 取消写入与内存状态原子收敛**：[ConversationService.cancelTask](../../../apps/backend/src/application/conversation/conversation-service.ts#L483) 将 `interruptExecution`、`finishTask` 与 `appendStreamEvent("task_cancelled")` 合并至单笔 SQLite 事务内执行且不再吞掉执行中断写库异常；仅在事务成功提交后清理 `pendingContinuations` 并中止／摘除在途执行句柄，确保写入任务终态或取消事件失败时整笔回滚、重试与放行原执行均保持一致。
2. **R02 · 预置服饰稳定来源标识（`BUSINESS V22`）**：[schema.ts](../../../apps/backend/src/storage/core/schema.ts#L12) 升级业务库至 V22，在 `outfits` 新增 `preset_key TEXT` 与局部唯一索引 `idx_outfits_role_preset_key`（[appearance.ts](../../../apps/backend/src/domain/appearance.ts) · [appearance-store.ts](../../../apps/backend/src/storage/media/appearance-store.ts)）；[preset-assistant.ts](../../../apps/backend/src/application/role/preset-assistant.ts#L116) 优先按 `presetKey`（目录 slug，兼容 V21 遗留 `preset_key IS NULL` 回填）匹配已有预置服饰并排除自身后解决冲突命名，重复重启及修改预置显示名时沿用原 `outfitId` 且保留同名自定义服饰。
3. **R03 · 后置解析工具参数异常保留已收到的 Token 用量**：[protocols.ts](../../../apps/backend/src/model/protocols.ts) 中 `streamOpenAiChat`、`streamOpenAiResponses` 与 `streamAnthropic` 均将流结束后的 `parseToolArguments` 提前放入外层 `try ... catch` 块内执行（先完成全部工具参数 JSON 解析并暂存，任一参数无效时由 `catch` 在抛出 `MODEL_TOOL_ARGUMENTS_INVALID` 前优先发出已收到的 `usage` 事件，且不发出 `tool_call` 或 `completed`），配合 `AgentGraph` 将该轮消耗累计至任务失败调用与任务 `usage` 汇总。
4. **自验证据**：新增 R01～R03 专项回归至 [p19-preset-assistant-pack1.test.ts](../../../apps/backend/tests/p19-preset-assistant-pack1.test.ts)（共 12 项全部通过）；全量 `npx -y node@24 scripts/accept-offline.mjs` 21／21 步通过（`436/436` 正式测试、2 项交付测试、`process-smoke` 与 16 项独立脚本校验通过，`realServiceCalls = 0`，报告位于 `apps/backend/test-results/p5-2026-11-17T02-25-43-104Z-e98155af/summary.json`）。

### 8.2 包 1 补修独立复验（2026-11-17，R01～R03 通过）

在 `9f10d5f`（工作树干净）上对 §8.1 补修做独立复验。**不采信作者用例作为结论依据**，改为复用 §8 的原始复现探针并补充场景，重新制造故障观测真实行为。**R01～R03 三项均已消除原失败现象，复验通过。**

| 编号 | 独立复验方法 | 实测结果 |
| --- | --- | --- |
| R01 · 取消写入失败后状态分裂 | 离线模型停在输入中途，分别注入「任务终态写失败」与「取消事件写失败」触发器，观察取消请求、任务、执行与取消事件 | 两种故障下取消均抛错，且任务保持 `active`、执行保持 `running`、取消事件 0 条（整笔回滚生效，不再出现「执行 `failed`、任务 `active`」）；解除故障后重试一次即收敛为任务 `failed`／`endReason = USER_CANCELLED`、执行 `failed`、取消事件 1 条，且不再新派执行 |
| R01 · 正常取消基线 | 无故障注入直接取消运行中任务 | 任务 `failed`、执行 `failed`、取消事件 1 条，收尾后不产生新执行 |
| R02 · 同名自定义服饰重复导入 | 先建同名自定义「日常常服」，再放入官方 `default` 素材，连续重启 4 次 | 预置数量恒为 `1,1,1,1`（原为 `1,2,3`），`roleId` 不变，同名自定义服饰始终保留；另测「修改预置显示名后重启」仍沿用原 `outfitId` 且不新增预置 |
| R03 · 无效工具参数丢失用量 | 本地 SSE 分别构造 Chat／Responses／Anthropic 三协议「已返回用量、工具参数为截断 JSON」 | 三协议均先吐出 `usage` 再抛 `MODEL_TOOL_ARGUMENTS_INVALID`，且不发出 `tool_call`／`completed`；Anthropic 归一化为 `inputTokens = 27`（20＋缓存读 5＋缓存写 2）、`cachedTokens = 5`、`outputTokens = 9` |
| R03 · 失败调用计入任务汇总 | 真实适配器接入本地 SSE，走完整 AgentGraph 链路 | 任务 `failed`／`endReason = MODEL_TOOL_ARGUMENTS_INVALID`，`usage` 为 `input 27／output 9／total 36／callCount 1／missingUsageCalls 0`，`model_calls` 失败行保留 `usage_json` |

**门禁结果**：`npm run typecheck` 通过；正式测试 `436/436` 通过；包 1 专项 `12/12` 通过；`node scripts/check-docs.mjs` 0 错误 0 警告；`BUSINESS_SCHEMA_VERSION = 22`、`APP_SCHEMA_VERSION = 10` 与 §8.1 一致。复验证据位于 `apps/backend/test-results/310-pack1-recheck-20261117/`（`report-recheck.json`、`r02-rename.json`、`r07-timing.json`）。

**门禁稳定性发现（非包 1 缺陷，需单独跟进）**：本次全量 `accept-offline.mjs` 为 20／21，失败步骤为 `p2-extended` 的 `R07-automatic-candidate-maintenance`（单独重跑 3 次失败 1 次）。该用例在 `waitForIdle` 后**固定等待 200ms** 即断言维护批次已启动，而实测批次出现时间为 **213～258ms**，余量仅 13～58ms，属阈值过紧的既有抖动：关闭本次新增的预置助手同步后延迟仍为 213～232ms，故与包 1 改动无关。建议将该断言改为轮询等待，未修复前不接受「21／21 全绿」作为稳定门禁结论。

**本次复验范围**：仅包 1 后端、随仓预置素材与本地离线验收。桌面包、发布包运行、真实模型与第三方 MCP 联调不在本次范围。受环境限制未能构建父提交对照工作树（依赖目录链接创建被安全策略拦截），R07 与包 1 无关的判断基于「失败点在被改动代码之前」＋「关闭新功能后延迟不变」两项证据，而非父提交实测对照。

### 8.3 门禁抖动修复（2026-11-17，自验通过，待独立复核）

针对 §8.2 记录的门禁稳定性发现（非包 1 缺陷）完成修复，仅改离线验收探针等待方式，不触及任何产品代码。

1. **修复点**：[20261104-p2-05-fix-recheck.ts](../../../apps/backend/reviews/20261104-p2-05-fix-recheck.ts) 的 `R07-automatic-candidate-maintenance` 在 `waitForIdle` 后由固定 `await delay(200)` 改为轮询等待维护批次真正启动：`until(() => calls > 0 && listRefineCandidates(...).length > 0)`。轮询复用文件内既有 `until`（8s 上限、20ms 间隔），条件与下方 `observed` 断言完全一致；真正的功能失败由 `until` 的 8s 超时兜底并报 `PROBE_WAIT_TIMEOUT`，不再依赖固定阈值。
2. **类型检查**：对修改后的 review 脚本按 `review-typecheck` 同等参数独立 `tsc --noEmit` 通过。
3. **稳定性验证**：单脚本串行重复运行 10 次，`R07-automatic-candidate-maintenance` 全部 `contractPassed=true`（`modelCalls=1／candidates=1`），同批 5 个探针均通过；原「3 次失败 1 次」抖动不再复现。
4. **全量门禁**：`npx -y node@24 scripts/accept-offline.mjs` **21／21 步通过**（原独立复验为 20／21），`sourceUnchanged=true`、`realServiceCalls=0`、正式测试 `436/436`，报告 `apps/backend/test-results/p5-2026-11-17T09-35-03-680Z-3493805f/summary.json`；`node scripts/check-docs.mjs` 0 错误 0 警告。

**性质说明**：本次为实施者自验稳定通过（结论已由 [§8.4](#84-门禁抖动修复独立复核2026-11-17通过) 独立复核通过）；依 §8.2 既有结论，该抖动与包 1 改动无关，修复只作用于离线验收脚本的等待策略，不改变被测系统行为。

### 8.4 门禁抖动修复独立复核（2026-11-17，通过）

对 §8.3 的修复做独立复核，不采信实施者自验结论，另行构造正反向验证。修复内容与 §8.3 一致（固定 `delay(200)` → `until` 轮询，条件与断言同源），**复核通过**。

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 抖动是否消除 | 连续独立运行 `p2-extended` 6 次（与实施者 10 次相互独立） | 6／6 全部通过，5 个探针均 `contractPassed = true`、退出码 0；单次耗时 10.9～11.7s（首跑 26.3s 为冷启动），未见耗时退化 |
| 是否退化为「恒通过」 | 负向对照：`disableMemoryRuntime = true` 使维护批次永不启动，套用同一 `until` 轮询条件 | 8007ms 抛出 `PROBE_WAIT_TIMEOUT`、`calls = 0`；经既有 `probe()` 记为 `contractPassed = false`，脚本退出码为 1 —— 真实功能缺失仍会被判失败 |
| 全量门禁 | 连续两次 `npx -y node@24 scripts/accept-offline.mjs` | 两次均 **21／21** 步通过（`436／436` 正式测试、`realServiceCalls = 0`），报告 `apps/backend/test-results/p5-2026-11-17T09-45-07-695Z-e8ac6c1e/summary.json` 与 `…09-51-35-370Z-b4d0c743/summary.json` |
| 改动面 | 读差异 | 仅 `apps/backend/reviews/20261104-p2-05-fix-recheck.ts` 一处等待策略，不触及产品代码；`delay` 在 R01 探针仍有使用，无未使用符号 |

证据目录：`apps/backend/test-results/310-gate-fix-recheck-20261117/`（`run-1..6.log`、`negative-control.json`）。

**遗留提示（不阻塞）**：轮询只保证维护批次「最终会发生」（上限 8s），不再校验启动及时性；若后续需守住延迟指标，应另加显式性能断言。同脚本 R01 的 `delay(150)` 仅作读取前稳定窗口、不参与断言，本次未改动。

## 9. 包 2 实施记录（2026-11-17，自验通过，待独立复核）

按 §7.1 包 2 范围实施「续行、澄清与夏澄管理工具」，覆盖单段 15 个模型轮（最多实派 14 次工具）自动切段、连续失败／无进展熔断、`task_pause` 图内即时停派、同窗回复接回原 `taskId`、方案 A 内部管理工具与 MCP 样例闭环。以下为实施者自验结论，独立复核另行留证。

### 9.1 单段切段与续行（DL-154）

1. **单段上限**：[agent-graph.ts](../../../apps/backend/src/application/conversation/agent-graph.ts) 新增 `DEFAULT_MAX_TOOL_ROUNDS = 15`，[conversation-service.ts](../../../apps/backend/src/application/conversation/conversation-service.ts) 默认沿用同一常量，仍可通过 `maxToolRounds` 覆盖。
2. **自动切段**：图内达到单段上限时不再抛 `ToolRoundLimitError`（该异常仅保留给未建立任务的普通对话），而是标记 `stopKind = round_limit`、停止派发同批剩余调用，并进入**收尾节点**（提供工具清单但忽略任何新调用）产出进度说明；回复提交后任务维持 `active`，由 `queueTaskContinuation` 沿原 `taskId` 排入下一执行段。
3. **显式续行**：新增内部工具 `task_continue`（[agent-tools.ts](../../../apps/backend/src/application/conversation/agent-tools.ts)），语义为「本段收尾、任务未完成」，走同一条收尾与排队路径；`task_finish`／普通回复仍按原语义结束任务。
4. **停派可见性**：同批未派发调用以 `TOOL_SKIPPED_AFTER_{PAUSE|CONTINUE|CIRCUIT_BREAKER|ROUND_LIMIT}` 回填配对工具消息，不写 `tool_calls`，避免被当作已执行。
5. **续行上下文**：`buildContinuationToolMessages` 只重放最近 40 条已保存调用证据，防止长任务续行上下文无限膨胀。

### 9.2 暂停、澄清恢复与熔断（DL-154 / DL-158）

1. **`task_pause` 图内即时停派**：一旦该轮成功执行 `task_pause`，同一批后续调用不再派发，下一节点只输出面向用户的澄清／进度说明，回复提交后任务以 `paused` 落库并写入 `wait_reason = AWAITING_USER_INPUT`、`continuable = 1`。
2. **同窗回复接回原任务**：[conversation-store.ts](../../../apps/backend/src/storage/conversation/conversation-store.ts) `beginExecution` 优先查找同窗口 `paused` 且 `continuable = 1`、`wait_reason ∈ {AWAITING_USER_INPUT, CIRCUIT_BREAKER}` 的用户任务，自动 `paused -> active` 并以 `relation = continues` 关联，原目标、进度笔记、已保存调用与资源延续随上下文注入；角色停止与额度暂停的恢复路径不变。
3. **连续失败熔断**：`RoleStore.taskToolFailureStreak` 按真实 `tool_results` 从新到旧统计「同一工具 + 同一错误码」的连续失败，`failed` 与 `unknown` 同样计入、成功或换错误码即中断；达到 `CIRCUIT_FAILURE_THRESHOLD = 3` 时标记 `circuit_breaker`，同批停派，任务暂停为 `TASK_CIRCUIT_BREAKER`。
4. **连续无进展熔断**：每次续行段收尾按「本段是否有新的成功工具调用或进度笔记」累计 `consecutive_no_progress`，连续 3 段无进展即暂停为 `TASK_CIRCUIT_BREAKER`，并向当前窗口补一条可见说明（含最近进度笔记），不只依赖任务状态。
5. **计数持久化**：`tasks.consecutive_failures` / `consecutive_no_progress` 由运行期回写（暂停中的任务仍可更新，终态不再改写），供任务查询与后续页面展示。
6. **崩溃恢复**：`reconcileCommittedGaps` 新增 `continue` 决定处理：回复已提交但续行未排队时，启动后补排续行；暂停决定补写 `wait_reason`。

### 9.3 夏澄内部管理工具与方案 A 守卫（DL-159）

新增 [admin-tools.ts](../../../apps/backend/src/application/role/admin-tools.ts)，仅在 `builtin_key = 'xiacheng'` 时由 `loadAgentTools` 挂载，直接调用应用服务（内部工具回执，不走 HTTP 自循环）：

- **只读**：`app_roles_list`、`app_role_get`、`app_activities_list`、`app_role_records_query`（消息／任务含 `usage`／记忆／日记／额度／唤醒）、`app_resources_list`、`app_resource_inspect`、`app_media_services_list`；MCP `env` 与模型凭据保持脱敏，不返回明文。
- **普通角色写**：`app_role_create`、`app_role_activity`、`app_role_update`、`app_role_bindings_set`（支持 `expectedRevision`）、`app_role_autonomy_set`；目标处于 `active`/`stopping` 时先 `requestStop` 并轮询等待 `stopped`（15s 上限，超时返回 `ROLE_STOP_TIMEOUT`），成功后按参数或原状态恢复。
- **全局资源**：`app_resource_create`（模型／MCP／Skill／语音／生图）、`app_resource_toggle`（仅 MCP/Skill 开关）、`app_resource_update`（沿用 `maintenancePlan` + 暂停角色 + 维护窗口，返回 `pausedRoleIds`）、`app_resource_delete`、`app_model_test`。
- **能力触发**：`app_role_memory_trigger`、`app_role_wake_manage`。
- **自改红线**：修改夏澄自身设定／绑定／额度／启停、修改其正在使用的模型资源（按 `impact()` 判定含任务续用）、以及任何全局语音／生图服务的增删改，一律返回 `409 SELF_MODIFICATION_VIA_SETTINGS_ONLY` 并引导去设置页；夏澄系统底座（§1.3）同步补充该禁区说明。

### 9.4 自验证据

- 新增 [p20-preset-assistant-pack2.test.ts](../../../apps/backend/tests/p20-preset-assistant-pack2.test.ts) 6 项：单段切段续行（含默认 15 轮常量与窗口不拉黑）、`task_pause` 同批停派与同窗接回原 `taskId`、同工具 3 次失败熔断、连续 3 段无进展熔断（含可见说明）、管理工具挂载范围与自改红线、样例 MCP 搜索／桌面控制与慢工具转后台结果回收。
- `npm run typecheck` 通过；全量正式测试 **442／442**；`node scripts/accept-offline.mjs` **21／21** 步通过（`realServiceCalls = 0`、`sourceUnchanged = true`），报告 `apps/backend/test-results/p5-2026-11-17T11-53-01-430Z-c8fd96f7/summary.json`；`node scripts/check-docs.mjs` 0 错误 0 警告。
- 未覆盖：真实第三方 MCP 服务的安装与端到端联调、真实模型在 15 轮切段下的表现、桌面端新增入口（§4.3 取消按钮属包 3）。以上按 §6.2 与 §7.2 另行留证。

## 10. 包 2 独立复核（2026-11-17，未通过：R04 待补修）

在 `c0651c2`（工作树干净）上复核包 2。**核心口径 5 项独立复验通过；发现 1 项 P2 缺陷（R04），故本次复核整体不通过**，需补修后复验。以下结论均来自独立探针，未采信 §9 自验。

### 10.1 通过项

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 默认单段上限与自动续行 | 不传 `maxToolRounds`，用本地 stdio MCP 外部工具持续推进 | 首段 15 个模型决策轮、实派 14 次工具调用（第 15 轮按「本轮只提交进度」不派发），随后自动以 `trigger = tool_result` 续行同一 `taskId`，两段执行均 `completed`、无 `failed`、任务 `completed` |
| `task_pause` 同批即时停派 | 同一批先 `task_pause`、后 `workspace_write` 真实写文件 | 暂停后写入**未落盘**（`b.md` 不存在）、`tool_calls` 仅记录暂停前那一次真实调用、任务 `paused` + `AWAITING_USER_INPUT` + `continuable = 1`、`task_pause` 的 `note` 正常保存 |
| 同窗回复接回原任务 | 暂停后在同一窗口再发消息 | 任务数量仍为 1、`execution_tasks` 关系为 `initiates` + `continues`、接回后新写入成功、暂停时被跳过的写入始终未落盘 |
| 自改红线 | 直接以夏澄身份调用写工具 | `app_role_update`／`app_role_activity(stop)`／`app_role_autonomy_set` 均返回 `SELF_MODIFICATION_VIA_SETTINGS_ONLY`，夏澄自身活动态未被改动 |
| 全量门禁 | 同一命令独立运行 | **21／21** 步通过，正式测试 `442／442`、`sourceUnchanged = true`、`realServiceCalls = 0`，报告 `apps/backend/test-results/p5-2026-11-17T13-02-57-536Z-05e11ec8/summary.json` |

### 10.2 R04 · P2 · 管理工具「先停角色」后写入失败不恢复活动态

**复现**：对处于 `active` 的普通角色调用 `app_role_bindings_set`，分别制造两种写入失败：

1. 传过期 `expectedRevision` → 返回 `BINDING_REVISION_CONFLICT`，**之后角色活动态为 `stopped`**（调用前为 `active`）；
2. 省略 `modelName` → 返回 `INVALID_BINDING`，**之后角色活动态同样为 `stopped`**。

**对照**：同一工具在写入成功时 `stoppedForWrite = true`、`resumed = true`、角色恢复 `active`。即缺陷只出现在失败路径：`stopForWrite` 之后没有 `try/finally`，写入抛错直接冒泡，恢复逻辑（`resumeIfNeeded`）永远不会执行。

**影响**：模型只要漏传 `modelName` 或遇到绑定版本冲突，用户的普通角色就会被静默停在 `stopped`，且在对话里不会得到「角色已停」的提示；用户需要自行去设置页重新启动。版本冲突恰恰是该工具声明的并发场景，`INVALID_BINDING` 也是模型高频出错点，实际触发概率不低。

**建议修复**：`app_role_update`、`app_role_bindings_set` 在 `stopForWrite` 之后用 `try { 写入 } finally { 写入未成功则 resumeIfNeeded 并按原状态汇报 }`；失败时返回体明确给出 `roleStopped: true` 与恢复结果，避免静默停机。`app_resource_update` 的 `pauseRoles` 失败路径存在同类现象（`finally` 只收尾维护窗口，不回滚已暂停角色），一并复核。

**证据**：`apps/backend/test-results/310-pack2-recheck-20261117/probe-admin-failure.json`（两次失败后状态均为 `stopped`）、`probe-admin-success.json`（成功路径 `resumed = true`）。

### 10.3 观察项（不阻塞，建议澄清）——三项均已处理

1. **单段轮次口径**：`state.round + 1 >= maxToolRounds` 使每段实派工具数为 `maxToolRounds - 1`（默认 14 次），模型决策轮为 15 轮。与 §5.1「提交本轮进度回复」的表述一致，但 §5.1 与 §7.2 均只写「15 轮」，建议在规范中明确「15 个模型轮／最多 14 次工具派发」，避免后续真实长任务按派发次数理解而低估段数。**已修复（见 §10.7）：§5.1／§5.2／§7.1／§7.2 统一为「15 个模型决策轮，最多实派 14 次工具」。**
2. **首个工具即 `task_pause`**：此时任务尚未建立，工具返回 `TASK_REQUIRED`，暂停不生效、同批后续调用照常派发。行为本身合理（无任务可暂停），但建议在工具描述或 §5.2 注明「需先有活动任务」，否则模型可能误以为已暂停。**已修复（见 §10.7）：`task_pause` 工具描述与 §5.2 均注明前置条件。**
3. **格式瑕疵**：[agent-tools.ts](../../../apps/backend/src/application/conversation/agent-tools.ts#L1365) `function taskFinishTool(  roleId: string,` 存在多余空格（后端无格式门禁，仅提示）。**已清理（见 §10.5）。**

### 10.4 复核范围与环境说明

- 仅覆盖包 2 后端与离线范围；真实第三方 MCP、真实模型 15 轮表现、桌面包不在本次范围。
- 环境：首轮 `npx -y node@24` 因 registry 502 失败、其后一次全量验收以 EPERM 写 `summary.json` 失败，均为环境问题；改用本地缓存的 Node v24.22.3 重跑后 21／21 通过，上述结论取自该次报告。

### 10.5 R04 补修（2026-11-17，自验通过；独立复核结论见 §10.6）

针对 §10.2 的 P2 缺陷 R04 完成补修，覆盖建议修复的全部三个写入工具；**仅改失败路径的活动态恢复与错误回执，不改变成功写入语义**。

1. **统一恢复辅助**：[admin-tools.ts](../../../apps/backend/src/application/role/admin-tools.ts) 新增 `failAfterStop`，在写入失败时先恢复目标角色活动态，再把 `roleStopped`／`resumed`（资源工具另有 `pausedRoleIds`／`rolledBackRoleIds`／各角色 `activity`）并入**原 `AppError` 的 details** 后重抛。保留原错误码（如 `BINDING_REVISION_CONFLICT`、`INVALID_BINDING`、`STORAGE_ERROR`），模型仍可据此判断冲突类型，回执同时明确给出停机已回滚，避免静默停机。
2. **`app_role_update`／`app_role_bindings_set`**：`stopForWrite` 之后的写入移入 `try`，`catch` 中 `resumeIfNeeded` 恢复原活动态并经 `failAfterStop` 重抛；成功路径的恢复逻辑与返回体不变。
3. **`app_resource_update`**：把角色恢复统一移到 `finally` 内、`endMaintenance` **之后**执行，再按 `failure` 决定恢复策略——成功按 `resumeRoles` 参数、失败无条件回滚本次暂停角色。原实现在 `catch` 中（维护窗口尚未结束）调用 `activity.resume`，会被 `resumeGuard`（`assertResumeAllowed`，283 R01）以 `RESOURCE_MAINTENANCE` 拒绝，导致回滚无效；调整顺序后失败回滚与成功恢复均生效（成功路径 `resumeRoles: true` 此前同样受此影响，本次一并修正）。
4. **回归测试**：[p20-preset-assistant-pack2.test.ts](../../../apps/backend/tests/p20-preset-assistant-pack2.test.ts) 新增 R04 专项 1 项，覆盖四场景：过期 `expectedRevision`、缺 `modelName`、`app_role_update` 存储写入抛错、资源连接变更暂停后写入抛错；断言失败码正确、角色活动态恢复 `active`、错误 details 带出恢复结果。包 2 用例由 6 项增至 7 项。
5. **门禁**：`tsc --noEmit` 通过；p20 专项 7／7 通过；全量 `npx -y node@24 scripts/accept-offline.mjs` **21／21 步**、正式测试 **443／443**、`sourceUnchanged=true`、`realServiceCalls=0`，报告 `apps/backend/test-results/p5-2026-11-17T13-26-48-525Z-2cfb15d8/summary.json`；`node scripts/check-docs.mjs` 0 错误 0 警告。

**顺带格式修正**：[agent-tools.ts](../../../apps/backend/src/application/conversation/agent-tools.ts) `taskFinishTool` 函数签名的多余空格（§10.3 观察项 3）已清理，无行为影响。

**当时未纳入、现已处理**：§10.3 观察项 1／2 当时属措辞澄清建议，未随 R04 补修擅改；用户确认后已按 [§10.7](#107-103-残余观察项澄清2026-11-17已处理) 处理。

**性质说明**：本次为实施者自验通过；结论已由 [§10.6](#106-r04-补修独立复核2026-11-17通过) 独立复核确认通过。

### 10.6 R04 补修独立复核（2026-11-17，通过）

对 §10.5 的补修做独立复核，仍不采信自验用例作为结论依据，另行构造探针验证四条路径，并检验新用例是否是真守卫。**R04 关闭，包 2 复核结论由「未通过」转为通过。**

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| R04 主场景 | 复用 §10.2 的原始探针（对 active 角色用过期 `expectedRevision` 触发写入失败） | 返回仍为 `BINDING_REVISION_CONFLICT`（原错误码保留），**角色活动态回到 `active`**；details 新增 `roleStopped = true`、`resumed = true`、`activity = active` |
| 资源维护路径 · 成功 | 改模型连接 + `resumeRoles = true` | `pausedRoleIds` 与 `resumedRoleIds` 均含该角色，角色最终 `active` |
| 资源维护路径 · 失败 | 注入 `resources.update` 抛错 | 返回 `STORAGE_ERROR`，details 带 `pausedRoleIds`／`resumedRoleIds`／`rolledBackRoleIds` 与各角色 `activity`，角色最终 `active` |
| 不误恢复（回归风险） | 先把角色按用户意愿停止，再触发同一条失败路径 | 角色仍为 `stopped`，details 为 `roleStopped = false`、`resumed = false`，未把用户停用的角色擅自拉起 |
| 用例是否真守卫 | 临时回退 `admin-tools.ts` 到补修前实现后单跑 p20 | 新增 R04 用例**失败**（6 pass / 1 fail）；恢复实现后 7／7 通过，确认该用例不是空断言 |
| 全量门禁 | 补修后独立运行 | **21／21** 步通过、正式测试 **443／443**、`sourceUnchanged = true`、`realServiceCalls = 0`，报告 `apps/backend/test-results/p5-2026-11-17T13-36-39-852Z-37815188/summary.json` |

**附带确认**：§10.5 第 3 点所述「原成功路径的 `resumeRoles` 在维护窗口内被守卫拒绝」经代码核对成立——[role-activity-service.ts](../../../apps/backend/src/application/role/role-activity-service.ts#L153) 的 `resume` 先过 `resumeGuard`，即 [resource-service.ts](../../../apps/backend/src/application/resources/resource-service.ts#L545) 的 `assertResumeAllowed`，维护中的目标服务会抛 `RESOURCE_MAINTENANCE`。故本次修复同时消除了一个此前未被发现的成功路径缺陷（`resumeRoles: true` 实际未恢复），「先 `endMaintenance` 再 `resume`」的顺序是必要修复而非可选优化。

**残余提示（不阻塞）**：

1. `app_resource_update` 的回滚写在 `finally` 内，若 `endMaintenance` 自身抛错则回滚不会执行；该路径为内存集合操作，实际概率极低，如后续做资源维护重构可改为 `try/finally` 嵌套。
2. `failAfterStop` 以原 `status`／`code`／`message` 重新构造 `AppError`，错误码契约不变，但原错误子类身份（如 `BindingRevisionConflictError`）在工具层丢失；当前仅工具回执消费错误码，无实际影响。

**证据**：`apps/backend/test-results/310-pack2-recheck-20261117/`（`probe-admin-failure.json`、`probe-resource-resume.json`、`probe-already-stopped.json`）。

**包 2 复核最终结论**：核心功能（切段续行、暂停停派、同窗接回、熔断、自改红线）与 R04 补修均通过，**包 2 独立复核通过**。§10.3 观察项 1／2 属规范措辞澄清，用户确认后已按 [§10.7](#107-103-残余观察项澄清2026-11-17已处理) 处理。

### 10.7 §10.3 残余观察项澄清（2026-11-17，已处理）

用户确认后处理 §10.3 的两项非阻塞措辞澄清，**均为文档／工具描述改动，不改变任何运行时行为**：

1. **观察项 1 · 单段轮次口径**：把「15 轮」统一明确为「15 个模型决策轮，最多实派 14 次工具」。改动 §5.1（标题下正文说明 `state.round + 1 >= maxToolRounds` 时该轮只提交进度、不派发工具）、§5.2、§7.1 包 2 条目与 §7.2 验收表。现行规范 [storage-memory-and-autonomy.md](../../specs/storage-memory-and-autonomy.md) 不含包 2 的 15 轮描述（第 89 行「默认最多 8 轮」属首轮原型旧述，不在此次范围），故无需改活规范。
2. **观察项 2 · `task_pause` 前置条件**：在 [agent-tools.ts](../../../apps/backend/src/application/conversation/agent-tools.ts) 的 `task_pause` 工具描述中注明「需先有活动任务（当前执行已关联任务编号）才能暂停，否则返回 `TASK_REQUIRED`、暂停不生效，同批后续调用照常派发」；并在 §5.2 第 1 点补充同样说明。仅改 `description` 文案，执行逻辑与错误码（`TASK_REQUIRED`）不变。
3. **验证**：`tsc --noEmit` 通过；全量 `npx -y node@24 scripts/accept-offline.mjs` 21／21 步、正式测试 443／443、`sourceUnchanged=true`、`realServiceCalls=0`，报告 `apps/backend/test-results/p5-2026-11-17T13-52-57-440Z-1cf7ace7/summary.json`；`node scripts/check-docs.mjs` 0 错误 0 警告。工具描述变更不影响离线模型按工具名选择，包 2 行为用例无需改动。

## 11. 包 3 实施记录（2026-11-17，自验通过，待独立复核）

按 §7.1 包 3 范围实施「桌面冷启动选角页与配置体验」，覆盖冷启动选角、全站去「陪伴」与共享当前角色、无图角色空态解耦、夏澄只读介绍／预置服饰锁定、对话内轻量取消任务，以及打包产物预置素材路径对齐。以下为实施者自验结论，独立复核另行留证。

### 11.1 冷启动选角页与共享当前角色（DL-147）

1. **入口页**：新增 [RoleEntry.tsx](../../../apps/desktop/renderer/src/pages/RoleEntry.tsx) 与 [role-entry.css](../../../apps/desktop/renderer/src/styles/role-entry.css)，全屏展示已建角色（立绘缩略、姓名、只读介绍）、内置助手标识（`data-builtin` + 「内置助手」徽标）、新建角色入口与「进入书房」；样式全部走 `--nd-*` 令牌，通过 `npm run check`。
2. **排序与选中**：纯逻辑抽到 [role-entry.js](../../../apps/desktop/renderer/src/entry/role-entry.ts)，内置夏澄优先、其余保持创建顺序；默认焦点落在内置助手，编号失效时回退第一位。
3. **冷启动门槛**：`App.tsx` 在启动配置读取完成后按 `needsEntryPick` 决定停在入口页还是直入工作区；选定角色后写入共享 `currentId`，主页、关系、对话三页同步（设置页仍只改 `editId`）。启动配置未读完前只渲染极短占位，避免入口页在跳过模式下闪现。
4. **自动化开关**：桌面壳 `api-config.json` 增加 `skipRolePicker`（读 `NOWADAYS_SKIP_ROLE_PICKER=1`），供既有 Electron 脚本直入工作区；产品冷启动默认始终显示入口页。
5. **立绘组件抽取**：`RolePortrait` 从 `Settings.tsx` 移到 [RolePortrait.tsx](../../../apps/desktop/renderer/src/components/RolePortrait.tsx)，入口页、藏书票墙与状态页共用；无主页图时显示明确空态。

### 11.2 去「陪伴」与无图空态解耦（DL-147 / DL-153）

1. **移除陪伴概念**：删除设置页「当前陪伴／设为当前陪伴／设为陪伴」标签与按钮、`onSelectCompanion` 回调及 `.config-companion` 样式；藏书票墙脚注改为内置标识；关系页「不必给陪伴打分」改为「不必给相处打分」，离线演出样例同步改写。全站已无「陪伴」文案。
2. **主页空态**：[HomeScene.tsx](../../../apps/desktop/renderer/src/components/home/HomeScene.tsx) 不再把夏澄主题人物图作为无衣柜角色的兜底，仅保留日夜书房背景与「这个角色还没有主页立绘」空态卡片；预解码与视差逻辑不变。
3. **对话空态**：[Conversation.tsx](../../../apps/desktop/renderer/src/pages/Conversation.tsx) 的 `sources.themeUrl` 恒为 `null`，舞台只显示背景；无衣柜时在输入区提示去外观添加服饰，不再闪现主题人物。
4. **关系页只读介绍**：[load-dossier.ts](../../../apps/desktop/renderer/src/relations/load-dossier.ts) 携带 `bioText` 与 `isBuiltin`，[Relations.tsx](../../../apps/desktop/renderer/src/pages/Relations.tsx) 对内置角色先展示「内置助手 · 官方介绍」只读段落，再展示可编辑角色卡正文；普通角色不出现该段。

### 11.3 夏澄只读介绍与预置服饰锁定（DL-153）

1. **角色配置页**：内置角色显示「内置助手 · 不可删除」说明块、只读显示名（附固定原因）与只读「官方介绍」；角色卡正文仍可编辑；显示名只读、保存不会产生显示名变更（实现仍提交同值 `displayName`，但输入框已禁用、值不变）；删除区替换为不可删除说明，不再出现删除流程。
2. **衣柜**：新增纯策略 [preset-lock.js](../../../apps/desktop/renderer/src/components/appearance/preset-lock.ts)，`isPreset = 1` 的服饰禁用改名、替换主页立绘、删除与补传差分，卡片标注「预置 · 只读」，补传目标下拉跳过预置项；自定义服饰全部操作保持开放。
3. **错误映射**：`PRESET_APPEARANCE_LOCKED` 在前端映射为「预置服饰与素材随应用交付，不能改名、替换或删除；可以新增自己的服饰」，与后端 409 契约一致。

### 11.4 对话内轻量取消任务（DL-154）

1. **入口**：对话页 toolbar 在存在可取消任务时显示轻量「取消任务／取消等待中的任务」按钮，点击弹出确认，确认后调用 `POST /v1/roles/:roleId/tasks/:taskId/cancel`（`reason = USER_CANCELLED`），成功即刷新角色状态。
2. **选择规则**：纯逻辑 [task-actions.js](../../../apps/desktop/renderer/src/conversation/task-actions.ts) 只挑 `origin = user` 且 `active` 或 `paused + continuable` 的任务，进行中优先、同状态取最近更新；自主／记忆任务与已终态任务不出现。
3. **刷新时机**：切换角色、执行中状态变化与每 5 秒轮询（页面隐藏时暂停），不干扰对话 SSE 与流式演出。

### 11.5 打包产物与预置素材路径（310 §3.2）

1. **布局解析**：新增 [backend-paths.cjs](../../../apps/desktop/electron/backend-paths.cjs)，区分「开发仓库」「打包产物」「显式覆盖（`NOWADAYS_BACKEND_ROOT`）」三种布局，统一给出后端入口、预置素材目录与包内 Node 运行时；`main.cjs` 以 `--preset-assets-dir` 显式传给后端，不再依赖源码相对路径。
2. **打包清单**：[package.json](../../../apps/desktop/package.json) 的 `files` 纳入 `backend-paths.cjs`，`extraResources` 把 `backend`（`src`、`assets/presets`、依赖与清单）与 `preset-assets` 复制到 `resources/`；Node 运行时按「包内 `node-runtime` → `NOWADAYS_NODE_PATH` → PATH」回退。
3. **路径验证**：新增后端用例 [p21-pack3-preset-assets.test.ts](../../../apps/backend/tests/p21-pack3-preset-assets.test.ts)，在隔离的 `resources/preset-assets` 布局下启动，断言夏澄官方介绍、两套预置服饰、主页图字节、差分数量、默认穿着与重启幂等（`outfitId` 不变、不重复导入）。

### 11.6 自验证据

- 渲染器：`npm run check` 通过（令牌最新、23 个 CSS 零违规、`tsc --noEmit` 通过）；`npm run build` 通过。
- 桌面单测：`node --test tests/*.test.cjs` **146／146**，新增 [pack3-entry.test.cjs](../../../apps/desktop/renderer/tests/pack3-entry.test.ts)（6 项：排序／标识／冷启动门槛／取消任务选择／文案／预置锁定）与 [pack3-packaging.test.cjs](../../../apps/desktop/tests/unit/pack3-packaging.test.cjs)（4 项：三种布局与运行时回退）。
- 冷启动 E2E：新增 [pack3-entry-check.cjs](../../../apps/desktop/tests/e2e/pack3-entry.e2e.cjs)，真实 Electron + 本地后端验证「先入选角页 → 内置标识与只读介绍 → 进入主页 → 关系页仍是同一位角色 → 全站无『陪伴』」，通过且无页面异常。
- 后端：`tsc --noEmit` 通过；全量正式测试 **444／444**；`node scripts/accept-offline.mjs` **21／21** 步（`realServiceCalls = 0`、`sourceUnchanged = true`、正式测试 444／444），报告 `apps/backend/test-results/p5-2026-11-17T15-22-27-980Z-d02c569a/summary.json`；`node scripts/check-docs.mjs` 0 错误 0 警告。
- **遗留（不阻塞包 3 范围）**：`startup-flow-fixes-check.cjs` 与 `workflow-real-backend-chain-check.cjs` 以「初始 0 角色」为前置，与包 1「启动即创建夏澄」冲突，首步 `home-create-btn` 无法出现；该漂移早于包 3，需另行改写为「已有内置助手时从角色配置新建」。真实安装包（`package:win`）实机启动与 Node 运行时随包交付仍待真实打包联调。

## 12. 包 3 独立复核（2026-11-17，未通过：E1 门禁项待补）

在 `6010e1b`（工作树干净）上复核包 3。**功能实现与离线门禁独立通过；但 Electron E2E 套件整体为红（E1），未满足 §7.2「全仓回归门禁」，故本次复核不通过。**

### 12.1 通过项

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 渲染器门禁 | 实跑 `npm run check` 与 `npm run build` | 令牌最新、**23 个 CSS 零违规**、`tsc --noEmit` 通过、构建成功 |
| 桌面单测 | 实跑 `node --test tests/*.test.cjs` | **146／146** 通过 |
| 后端门禁 | 实跑 `accept-offline.mjs` | **21／21** 步、**444／444**、`sourceUnchanged = true`、`realServiceCalls = 0`，报告 `apps/backend/test-results/p5-2026-11-17T15-35-03-695Z-394363f0/summary.json` |
| 文档巡检 | `node scripts/check-docs.mjs` | 0 错误 0 警告 |
| 冷启动真实桌面 | 实跑 `tests/pack3-entry-check.cjs`（真实 Electron + 本地后端） | 入口页出现、进入前**不渲染** `.studio-shell`、内置徽标「内置助手」、只读介绍非空、进入后主页就位、`document.body.innerText` **不含「陪伴」**、关系页仍为选定角色、无页面异常 |
| 全站去「陪伴」 | 全量搜索 `renderer/src` | 「陪伴」命中 **0**（含样式与组件文案） |
| 打包路径解析 | 直接调用 `backend-paths.cjs` 验证三种布局 | 仓库态指向 `apps/backend/` 与 `prototypes/p0/.runtime/...`；打包态指向 `resources/backend`＋`resources/preset-assets`＋`resources/node-runtime`；`NOWADAYS_BACKEND_ROOT` 覆盖优先 |
| 取消接口契约 | 比对前端调用与后端路由/schema | `POST /v1/roles/:roleId/tasks/:taskId/cancel` 的 `{ reason }` 与 `taskCancelBodySchema`（trim/1–2000/optional）一致；任务字段与 `pickCancelableTask` 期望一致 |
| 预置锁定数据 | 核对接口与类型 | `Outfit`／`OutfitAsset` 均带 `isPreset`（[p19](../../../apps/backend/tests/p19-preset-assistant-pack1.test.ts) 已断言主页图与差分），锁定策略不会因字段缺失退化为「可编辑」 |

### 12.2 E1 · P2 · Electron E2E 套件整体为红，不能作为包 3 回归门禁

上一轮（309）记录为「均退出 0」的 Electron 脚本，本轮实跑结果：

| 脚本 | 结果 | 失败断言 | 根因 |
| --- | --- | --- | --- |
| `tests/startup-flow-fixes-check.cjs` | 失败 | 等待 `home-create-btn` 超时 | 脚本以「初始 0 角色」为前置；包 1 起启动即创建夏澄，主页不再出现「创建角色」入口 |
| `tests/workflow-real-backend-chain-check.cjs` | 失败 | 等待 `status-wall-two` 超时（要求「恢复活动」恰好 2 个） | 同一前置问题：脚本另建甲／乙两个角色，加上夏澄实为 3 个 |

本次提交已在这两个脚本中加入 `NOWADAYS_SKIP_ROLE_PICKER=1`（让它们绕过选角页），**但未修正角色数量前置**，因此仍为红。§11.6 将该现象记为「早于包 3 的遗留」，经核对属实——漂移自包 1（`9f10d5f`）引入「启动即夏澄」时产生；但 §7.2 明确把「隔离 Electron E2E」列为全仓回归门禁，既然本次已改动这两个文件，应一并把前置改为「以已有内置助手为起点」、断言改用相对数量（`新建数 + 内置 1`）而非绝对 2，否则包 3 无法宣称门禁通过。

### 12.3 观察项（不阻塞，建议处理）——五项均已处理

1. **冷启动错误态不可达**：`needsEntryPick` 在「后端出错且无角色」时返回 `false`，App 直接进入工作区；`RoleEntry` 的 `error && cards.length === 0` 分支与 `onRetry` 因此永远走不到，且 [role-entry.js](../../../apps/desktop/renderer/src/entry/role-entry.ts) 的注释「出错且没有任何角色时仍停在入口页」与实现相反。建议二选一：让错误态停留在入口页（保留注释语义），或改正注释并删除死分支。**已处理（见 §12.5）：采用前者，错误态停留入口页，错误分支与重试可达。**
2. **打包交付未完成**：`extraResources` 未包含 `node-runtime`，`resolveNodeExecutable` 最终回退到 PATH 上的 `node`（本机 PATH 为 v22，后端要求 Node 24）；`appRoot` 默认落在安装目录 `resources/backend/.nowadays-desktop`，在 `Program Files` 类只读安装位会写失败。§11.6 已列为遗留，建议在 STATUS 中明确写为「打包交付待联调」，不要表述为已完成。**部分处理（见 §12.5）：打包态 `appRoot` 改到用户数据目录；`node-runtime` 因目录被 gitignore 未强行纳入，STATUS 已明确「打包交付待联调」。**
3. **预置素材重复打包**：`extraResources` 既复制 `apps/backend/assets/presets` 又单独复制到 `preset-assets`，运行期只用后者，多占约 59MB；建议从 backend filter 去掉 `assets/presets/**/*`。**已处理（见 §12.5）。**
4. **取消任务缺 E2E**：目前只有纯逻辑单测覆盖「选哪一条」，没有覆盖「按钮出现 → 确认 → 实际取消 → 任务终态」。建议在既有 Electron 脚本里补一条最短路径。**已处理（见 §12.5）：`startup-flow-fixes-check` 新增该最短路径。**
5. **表述与实现差异**：§11.3 写「保存时不再回传显示名变更」，实现仍以 `displayName: draft.name.trim()` 提交（内置角色输入框已禁用，值不变），建议改为「显示名只读、保存不会产生变更」。**已处理（见 §12.5）。**

### 12.4 复核范围

仅覆盖包 3 的桌面端、随仓预置素材与离线/Electron 本地范围；真实安装包（`package:win`）实机启动、真实模型与第三方 MCP 联调不在本次范围。证据：`desktop` 三条门禁实跑输出、`apps/backend/test-results/p5-2026-11-17T15-35-03-695Z-394363f0/summary.json`、`tests/pack3-entry-check.cjs` 运行结果。

### 12.5 E1 与观察项补修（2026-11-18，自验通过，待独立复核）

针对 §12.2 的 E1（Electron E2E 套件整体为红）与 §12.3 五项观察项完成补修；本轮**只改测试脚本、文档与打包配置**，不改变产品业务逻辑（唯一功能改动是冷启动错误态分支的启用，见观察项 1）。

**E1 · Electron E2E 恢复为可用门禁**

1. **根因**：包 1「启动即创建夏澄」后，各脚本以「初始 0 角色」为前置的假设失效；包 3 引入冷启动选角页后，未跳过选角页的脚本还会停在入口页。
2. **`startup-flow-fixes-check.cjs`**：改为「以已有内置助手为起点」，走「角色配置 → 切换角色 → 新建角色」创建「林雾」；角色定位由 `items[0]` 改为按显示名查找，避免夏澄占位。
3. **`workflow-real-backend-chain-check.cjs`**：角色墙断言由「恢复活动恰好 2 个」改为「甲乙各自可恢复」；绑定前显式切到甲角色（原依赖默认编辑对象）；所有「全员 active」断言改为只看甲乙（`bothActive`）；「仅改模型名后全员启用」改为按角色校验；删除后显式切到乙／丙继续删除链；生图保存按钮改为等待「保存配置／暂停并保存配置」任一文案后点击（活动态同步时差点按空）。
4. **其余 8 个 E2E**（`dialogue-layout`、`relations-desktop`、`settings-auto-reload`、`settings-binding-recovery`、`settings-real-backend`、`settings-review-fixes`、`settings-workspace`、`theme-transition`）：补 `NOWADAYS_SKIP_ROLE_PICKER=1` 以跳过选角页（这些脚本只验证工作区页面）；4 个 real-backend 设置脚本在进入角色配置后显式切到「联调甲」；`settings-review-fixes` 删除后的角色数量断言改为相对（`删除前数量 - 1`）；`settings-workspace` 修正包 3 已移除的「当前陪伴（右页脚）」断言，改为校验当前编辑对象（左页脚/编辑对象），并区分「新建后编辑对象为丙」。

**观察项 1 · 冷启动错误态**

[role-entry.js](../../../apps/desktop/renderer/src/entry/role-entry.ts) 的 `needsEntryPick` 增加 `error` 参数：无角色且读取失败时返回 `true`，冷启动停在入口页并由 `RoleEntry` 呈现错误与「重试」；[App.tsx](../../../apps/desktop/renderer/src/App.tsx) 传入 `error`，`role-entry.d.ts` 同步签名；[pack3-entry.test.cjs](../../../apps/desktop/renderer/tests/pack3-entry.test.ts) 补充「无角色+错误→停留」「有角色+错误→仍进入」断言。

**观察项 2/3/5 · 打包与表述**

- `extraResources` 从 backend filter 去掉 `assets/presets/**/*`，仅保留 `preset-assets`，消除约 59MB 重复（运行期本就使用后者）。
- [main.cjs](../../../apps/desktop/electron/main.cjs) 打包态 `appRoot` 改为 `app.getPath("userData")/data`，避免在只读安装位写失败；仓库态与 `NOWADAYS_APP_ROOT` 覆盖行为不变。
- `node-runtime` 未强行加入 `extraResources`：该目录被 `prototypes/p0/.gitignore` 忽略、未入库，直接引用会让干净检出构建失败；STATUS 明确记为「打包交付待联调」，待打包流水线提供运行时后再补。
- §11.3 表述已改为「显示名只读、保存不会产生变更」。

**观察项 4 · 取消任务 E2E**

`startup-flow-fixes-check.cjs` 末尾新增最短路径：向角色业务库预置一条 `paused + continuable` 的用户任务 → 对话页轮询发现 → 取消入口出现（文案「取消等待中的任务」）→ 点击 → 弹窗「确认取消任务」→ 真实 `POST .../cancel` → 任务终态 `failed / USER_CANCELLED` 且入口消失。任务创建本身不在本用例范围。

**门禁结果**：渲染器 `npm run check`（令牌最新、23 个 CSS 零违规、`tsc --noEmit`）与 `npm run build` 通过；桌面单测 **146／146**；**11 条 Electron E2E 全部退出 0**（含此前为红的三条：`startup-flow-fixes-check`、`workflow-real-backend-chain-check`、以及一批未跳过选角页的脚本）；后端 `accept-offline.mjs` **21／21 步**、正式测试 **444／444**、`sourceUnchanged=true`、`realServiceCalls=0`，报告 `apps/backend/test-results/p5-2026-11-18T02-31-13-777Z-5646bc7d/summary.json`；`node scripts/check-docs.mjs` 0 错误 0 警告。

**性质说明**：本次为实施者自验通过，尚未独立复核；E1 的复验仍应以独立实跑为准。

### 12.6 补修独立复核（2026-11-18，**未通过：E1 未收口**）

对 §12.5 的补修做独立复核。全部结论来自自行实跑与自建探针，不采信 §12.5 的自验数字。**十一条 E2E 中十条可由我独立复现通过；`workflow-real-backend-chain-check.cjs` 在我这里 7 次运行仅 1 次通过，E1 仍未收口，故本次复核不通过。**

#### 12.6.1 通过项

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 渲染器门禁 | 实跑 `npm run check`、`npm run build` | 令牌最新、**23 个 CSS 零违规**、`tsc --noEmit` 通过、构建成功 |
| 桌面单测 | 实跑 `node --test tests/*.test.cjs` | **146／146** |
| 后端门禁 | 实跑 `accept-offline.mjs` | **21／21** 步、**444／444**、`realServiceCalls = 0`、`sourceUnchanged = true`，报告 `apps/backend/test-results/p5-2026-11-18T02-40-07-559Z-01271d96/summary.json` |
| 文档巡检 | `node scripts/check-docs.mjs` | 0 错误 0 警告 |
| 观察项 1（产品改动） | 自建探针 `probe-entry-error.cjs`：真实 Electron + 假后端，`/v1/roles` 先 500 后恢复 | 失败态**未渲染** `.studio-shell`、入口页呈现「数据库暂时不可用」+「重试」、无角色卡；点「重试」后错误消失、列出角色、仍停选角页、进入后到 `home`。错误分支与重试**确实可达** |
| 观察项 3（打包去重） | 读 `package.json` `extraResources` | backend filter 已去掉 `assets/presets/**/*`，仅保留 `preset-assets`，约 59MB 重复消除 |
| 观察项 4（取消 E2E） | 实跑 `startup-flow-fixes-check.cjs` 4 次 | 4／4 通过（18～19s），输出 `issue7CancelTaskE2E: { status: failed, endReason: USER_CANCELLED }`，UI→后端→终态全链路真实生效 |
| 观察项 5（表述） | 读 §11.3 | 已改为「显示名只读、保存不会产生显示名变更」，与实现一致 |
| 观察项 2（部分） | 读 `main.cjs` | 打包态 `appRoot` 改为 `app.getPath("userData")/data`，仓库态与 `NOWADAYS_APP_ROOT` 覆盖不变；`node-runtime` 仍未随包，STATUS 已按「打包交付待联调」表述 |
| 其余 10 条 E2E | 各独立运行 1 次 | 全部退出 0：`dialogue-layout` 4s、`relations-desktop` 10s、`theme-transition` 18s、`settings-auto-reload` 9s、`settings-binding-recovery` 6s、`pack3-entry` 3s、`settings-real-backend` 7s、`settings-review-fixes` 7s、`settings-workspace` 23s、`startup-flow-fixes` 18s |

#### 12.6.2 E1 · P2 · `workflow-real-backend-chain-check.cjs` 仍不稳定

同一命令连续 7 次：**1 次通过（22s）、6 次失败**，两类失败点：

| 次数 | 失败点 | 现象 |
| --- | --- | --- |
| 5 次 | `:801` | `TypeError: Cannot read properties of undefined (reading 'click')` —— 找不到文案为「暂停并启用」的按钮 |
| 1 次 | `:647` | 等待 `.nd-model-options [role=option]` 达 2 项，25s 超时（`comfy-a-two-options`） |

**定位过程**：用临时诊断副本（仅替换 `:801` 的匹配方式，跑完即删，未留在仓库）连续运行 4 次，打印实际按钮文案：

- 3 次打印到文案：2 次为「**全局启用**」、1 次为「暂停并启用」；改为容忍两种文案后 **4／4 全部通过**（含 `:801` 之后所有断言）。
- 根因：该按钮文案随 `hasActiveRoles` 切换（[Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L1568)：`service.enabled ? (hasActiveRoles ? '暂停并停用' : '全局停用') : (hasActiveRoles ? '暂停并启用' : '全局启用')`），而脚本硬编码「暂停并启用」且不等待活动态就绪，进入设置后 `activities` 尚未落地时即点击。
- `:647`：`ImageModelPicker` 的候选列表依赖 `open` 状态（[ImageModelPicker.tsx](../../../apps/desktop/renderer/src/components/image/ImageModelPicker.tsx#L95)），脚本只 `focus()` 一次后干等；探测完成触发的重渲染或 `onBlur`（120ms 后关闭）会让列表不再渲染。

两处均在本次改动**未触及**的行，属既有脆弱等待模式；但 §7.2 把「隔离 Electron E2E」列为全仓回归门禁，`11 条全部退出 0` 在我这里不可复现（仓库 `test-results` 下也没有该次 E2E 日志留证），因此 E1 不能算通过。

**建议修复（最小改动）**：

1. `:801` 改为容忍两种文案 `find(x => /^(暂停并启用|全局启用)$/.test(x.textContent.trim()))`，或先等活动态文本就绪再点。
2. `:647` 把 `input.focus()` 换成 `input.click()`（组件 `onClick` 也会开列表），并等 `aria-expanded === 'true'` 再断言候选数。
3. 通用模式：把「`until` 判定存在 → 下一次 `ev` 里 `find().click()`」合并为同一次求值内 `find + click` 并返回布尔，交给 `until` 重试，避免两次求值之间被重渲染清掉。

#### 12.6.3 观察项（不阻塞）——四项已处理（见 §12.7）

1. **注释与实现不符**：[settings-workspace-check.cjs](../../../apps/desktop/tests/e2e/settings-workspace.e2e.cjs#L316) 新增说明「包 3 起编辑对象与当前角色共享 currentId」，但 `chooseRole` 只 `setEditId`（[Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L293)），`currentId` 不变，仅当 `editId` 失效时才回落到 `currentId`（同文件 `L190`）。断言本身成立（`config-footer-ident` 显示编辑对象），建议注释改为「编辑对象独立于当前角色」。
2. **覆盖缺口**：原先 `#config-footer-right` 断言「编辑乙时当前角色仍是甲」，右页脚改为「切换角色」按钮后该断言消失，「编辑他人不改变当前角色」现无 E2E 覆盖。建议补一条 `currentId` 或主页头像不变的断言。
3. **STATUS 数字过期**：验收基线写「22 个 CSS」，实为 23，已一并修正。
4. **打包数据目录迁移**：`appRoot` 由 `resources/backend/.nowadays-desktop` 改为 `userData/data`。未发布前无迁移负担，但需写入打包联调清单——旧安装产物里的数据不会被自动接管。

#### 12.6.4 复核范围

仅覆盖包 3 桌面端与离线／Electron 本地范围；真实安装包（`package:win`）实机启动、真实模型与第三方 MCP 联调不在本次范围。证据：`apps/backend/test-results/310-pack3-recheck-20261118/`（`probe-entry-error.json`、`e2e/*.log`、`e2e/diag1..3.log`）、`apps/backend/test-results/p5-2026-11-18T02-40-07-559Z-01271d96/summary.json`。

### 12.7 E1 收口与 §12.6.3 观察项补修（2026-11-18，自验通过，待独立复核）

针对 §12.6.2 的 E1（`workflow-real-backend-chain-check.cjs` 7 次仅 1 次通过）与 §12.6.3 四项观察项完成补修。本轮**只改测试脚本与文档**，不触及产品逻辑。

#### 12.7.1 E1 根因与改法

复核定位的两处脆弱点都属同一类模式：**「先在一个求值里等到存在，再在下一个求值里查找并点击」**，两次求值之间被重渲染清掉即抛 `TypeError: ... reading 'click'`；以及**只触发一次就干等**，错过时机后永不重试。

改为三个可重试原语，并全量替换脚本内的直接点击：

1. **`clickWhen(表达式)`**：在同一次求值内 `find → click → 返回 true`，找不到返回 `false` 交给 `until` 每 100ms 重试。脚本内 133 处 `await ev("…click()")` 全部替换，根除「两次求值之间元素消失」这一类失败。
2. **`untilModelOptions(scope, 数量)` / `pickModelOption(scope, 文案)`**：[ImageModelPicker](../../../apps/desktop/renderer/src/components/image/ImageModelPicker.tsx#L95) 的候选列表依赖 `open`，`onBlur` 会在 120ms 后收起，原脚本 `focus()` 一次后干等必然超时。新原语在**同一次求值内**「未展开则唤出（`focus`+`click`）→ 数候选 / 派发 `mousedown`」，把 `:647` 的 `comfy-a-two-options` 与两处「focus+等候选+dispatchEvent」全部换掉（候选按钮只用 `onMouseDown`，故仍派发 `mousedown` 而非 `click()`）。
3. **`clickAnyText(候选文案)` + `resumePausedIfAny()`**：生图／语音面板的启停按钮文案随「是否有启用中的角色」在「暂停并启用／全局启用」「暂停并停用／全局停用」间切换（[Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L1568)），原脚本硬编码单一文案且不等活动态就点。改为按候选文案匹配；启用／停用后是否出现「继续本次暂停的角色」也改为「出现则点、未出现则跳过」（`untilOrNull`），避免两种活动态下互斥的两个分支。

#### 12.7.2 稳定性结果

同一命令连续 7 次（复核用同一方法）：**7／7 通过**，耗时 21–27s（此前 7 次仅 1 次通过、失败固定在 `:801` 与 `:647`）。日志：`apps/backend/test-results/310-e1-recheck/run-1..7.log`。

#### 12.7.3 §12.6.3 四项观察项

1. **注释与实现不符**：[settings-workspace-check.cjs](../../../apps/desktop/tests/e2e/settings-workspace.e2e.cjs#L336) 两处说明改为「DL-147：编辑对象独立于当前角色」，与 `chooseRole` 只改 `editId` 的实现一致。
2. **覆盖缺口**：补「编辑他人不改变当前角色」断言——切到乙角色编辑后点 Dock「桌面」，断言主页英雄区 `.home-account h2` 仍为甲角色，再返回角色配置继续草稿流程（编辑对象仍为乙）。该断言同时覆盖了包 3 移除 `#config-footer-right` 后丢失的语义。
3. **STATUS 数字**：验收基线 CSS 数为 23，已核对一致。
4. **打包数据目录迁移**：写入 [STATUS](../../STATUS.md) 打包联调清单——`appRoot` 由 `resources/backend/.nowadays-desktop` 改为 `userData/data`，旧安装产物数据不会被自动接管，联调时需确认迁移策略（未发布前无真实负担）。

#### 12.7.4 门禁结果

- 渲染器：`npm run check`（令牌最新、**23 个 CSS 零违规**、`tsc --noEmit` 通过）与 `npm run build` 通过。
- 桌面单测：**146／146**。
- Electron E2E：**11 条全部退出 0**——`workflow-real-backend-chain-check` 另做 7 次连跑（7／7），其余 10 条各 1 次（`dialogue-layout` 3s、`relations-desktop` 9s、`theme-transition` 18s、`settings-auto-reload` 6s、`settings-binding-recovery` 6s、`pack3-entry` 2s、`settings-real-backend` 7s、`settings-review-fixes` 6s、`settings-workspace` 23s、`startup-flow-fixes` 18s）；日志在 `apps/backend/test-results/310-e1-recheck/`。
- 后端：`accept-offline.mjs` **21／21 步**、正式测试 **444／444**、`sourceUnchanged=true`、`realServiceCalls=0`，报告 `apps/backend/test-results/p5-2026-11-18T03-17-35-807Z-9c38e07e/summary.json`。
- 文档巡检：`node scripts/check-docs.mjs` 0 错误 0 警告。

**性质说明**：本次为实施者自验通过，尚未独立复核；E1 是否收口仍以独立实跑（含连续多次）为准。真实安装包实机启动与 Node 运行时随包交付仍待打包联调，不在本轮范围。

### 12.8 二次补修独立复核（2026-11-18，**通过；附 1 项低频遗留抖动**）

在 §12.7 工作树上独立复核，结论均来自自行实跑，不采信自验数字。**§12.6.2 已定位的两处失败点（`:801` 文案硬编码、`:647` 下拉只唤出一次）在 20 次连跑中 0 次复现，E1 复核通过。**

#### 12.8.1 独立验证

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| 工作流 E2E 稳定性 | 同一命令连续实跑 **20 次** | **19／20 退出 0**（22～25s）；唯一失败在第 9 次，`:942` 等待 `role-picked-voice-svc` 25s 超时（42s）。§12.6.2 的两处原失败点 0 次复现 |
| 其余 10 条 E2E | 各独立运行 1 次 | **10／10** 退出 0（`dialogue-layout` 3s、`relations-desktop` 9s、`theme-transition` 18s、`settings-auto-reload` 7s、`settings-binding-recovery` 6s、`pack3-entry` 3s、`settings-real-backend` 7s、`settings-review-fixes` 7s、`settings-workspace` 23s、`startup-flow-fixes` 18s），含新增「编辑乙时当前角色仍为甲」断言 |
| 渲染器门禁 | 实跑 `npm run check` + `npm run build` | 令牌最新、**23 个 CSS 零违规**、`tsc --noEmit` 通过、构建成功 |
| 桌面单测 | 实跑 | **146／146** |
| 后端门禁 | 实跑 `accept-offline.mjs` | **21／21** 步、**444／444**、`realServiceCalls = 0`、`sourceUnchanged = true`，报告 `apps/backend/test-results/p5-2026-11-18T04-16-46-162Z-11ba55db/summary.json` |
| 文档巡检 | `node scripts/check-docs.mjs` | 0 错误 0 警告 |

#### 12.8.2 改动质量核对

- `clickWhen` 在同一次求值内 `find → click → true`，找不到才重试；后续 `until` 断言仍校验点击效果，没有把失败吞成「恒通过」。133 处直接点击替换后，脚本只剩 1 处可选链直接点击（`.dialogue-messages?.click()`），无遗漏。
- `untilModelOptions`／`pickModelOption` 每次重试都重新唤出下拉，并使候选按钮的 `mousedown` 与组件 `onMouseDown` 契约一致；`clickAnyText` 容忍「暂停并启用／全局启用」两种文案，但启停后仍以 `until(bothActive)` 校验角色终态，不会因跳过恢复按钮而漏检。
- `untilOrNull` 会吞掉求值异常，但脚本末尾仍 `assert.deepEqual(errors, [])` 校验 `Runtime.exceptionThrown`，且终态断言保留，未见覆盖退化。
- 本轮只改测试脚本与文档，未触及产品代码，无新增产品回归面。
- §12.6.3 四项观察均已处理：注释改为「DL-147：编辑对象独立于当前角色」；新增断言用 `.home-account h2`（与 [Home.tsx](../../../apps/desktop/renderer/src/pages/Home.tsx#L67) 一致）验证切换编辑对象不改变当前角色，属真守卫；CSS 计数 23 与实跑一致；`appRoot` 迁移写入 STATUS 打包清单。

#### 12.8.3 遗留抖动（不阻塞，建议后续处理）

20 次中第 9 次在 `workflow-real-backend-chain-check.cjs:942` 的 `role-picked-voice-svc` 等待超时：从设置页新建全局语音服务并返回角色配置后，角色语音服务的下拉未在 25s 内自动选中新服务。该行不在本轮改动范围，属低频状态同步竞态——[VoicePanel.tsx](../../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx#L268) 的自动选中发生在 `serviceRefreshVersion` 变化触发的拉取完成之后，且要求 `form.serviceId === '' && !configured`。建议先等下拉选项含目标 `serviceId` 再断言自动选中，或在创建服务后显式触发角色刷新；若能稳定复现，再排查 `voiceServiceVersion` 从设置页返回角色 editors 的传递链路。

**结论**：E1 两处已定位缺陷确认修复，工作流失稳率由 §12.6 的 1／7 提升至 19／20，其余门禁全绿，**包 3 独立复核通过**。但不得表述为「E2E 零抖动」——上述 1／20 须作为遗留登记。打包交付（`node-runtime` 随包、`package:win` 实机启动、`appRoot` 迁移策略）仍在待联调范围，不随本次通过。

**证据**：`apps/backend/test-results/310-pack3-recheck2-20261118/e2e/`（`workflow-run1..20.log` 与其余 10 条脚本日志）、`apps/backend/test-results/p5-2026-11-18T04-16-46-162Z-11ba55db/summary.json`。

### 12.9 §12.8.3 遗留抖动修复与自验（2026-11-18，自验通过，待独立复核）

针对 §12.8.3 记录的 `workflow-real-backend-chain-check.cjs:942` 低频超时（20 次中 1 次出现 `role-picked-voice-svc` 超时），定位到设置页与角色配置面板之间的两处异步同步竞态并完成修复。

#### 12.9.1 根因定位

1. **卸载后丢弃创建／变更回调与探测缓存**：[VoiceServiceEditor.tsx](../../../apps/desktop/renderer/src/components/voice/VoiceServiceEditor.tsx#L65-L76)（`VoiceServiceCreate` 与 `VoiceServiceDetail`）及 [Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L1294-L1298)（`ImageServiceCreate` 与 `ImageServiceDetail`）在请求返回后先判断 `if (!live.current) return;`，再写入全局探测／模型缓存并调用 `onCreated`／`onUpdated`／`onRemoved`。当脚本（或用户）在后端刚提交 `POST /v1/voice-services` 后立即点击 `.config-return-footer` 返回角色配置页时，添加页先于 `fetch` 回调卸载、`live.current` 置为 `false`，导致 `writeVoiceProbeCache` 与 `onCreated` 被跳过，`voiceServiceVersion` 停留原值，[VoicePanel](../../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx) 永远收不到刷新信号。
2. **返回可见与初次加载并发同步缺少保序**：[VoicePanel.tsx](../../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx#L214-L280) 与 [ImagePanel.tsx](../../../apps/desktop/renderer/src/components/image/ImagePanel.tsx#L237-L310) 仅在 `serviceRefreshVersion` 变化时同步服务列表，不在 `active` 从 `false` 切回 `true` 时同步，且初始加载（`[roleId]`）与外部刷新缺少统一序号 `serviceSyncSeq` 保序（严格模式双挂载或并发刷新下旧请求可能覆盖新结果）。

#### 12.9.2 修复内容

1. **分离本地状态守卫与跨页提交通知**：在 [VoiceServiceEditor.tsx](../../../apps/desktop/renderer/src/components/voice/VoiceServiceEditor.tsx)（`VoiceServiceCreate`、`VoiceServiceDetail`）与 [Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx)（`ImageServiceCreate`、`ImageServiceDetail`）中，后端写删成功后**无条件**完成共享探测／模型缓存写入及 `onCreated`／`onUpdated`／`onRemoved` 父级回调，`live.current` 仅保护本地组件状态更新（`setBusy`、`setError`、`setMessage` 等）。
2. **统一服务列表同步与序号保序**：将表单自动选中与地址/协议/默认模型同步抽为纯函数 [syncVoiceFormServices](../../../apps/desktop/renderer/src/voice-config.ts) 与 [syncImageFormServices](../../../apps/desktop/renderer/src/image-config.ts)（无变化时返回原引用，不打断草稿）；[VoicePanel.tsx](../../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx) 与 [ImagePanel.tsx](../../../apps/desktop/renderer/src/components/image/ImagePanel.tsx) 引入 `serviceSyncSeq` 保序并在 `serviceRefreshVersion` 变更或 `active` 由 `false` 切为 `true` 时执行同步，同时避免严格模式首次挂载重复拉取。
3. **回归覆盖**：[voice-config.test.cjs](../../../apps/desktop/renderer/tests/voice-config.test.ts) 与 [image-config.test.cjs](../../../apps/desktop/renderer/tests/image-config.test.ts) 新增纯函数单测；[settings-workspace-check.cjs](../../../apps/desktop/tests/e2e/settings-workspace.e2e.cjs#L558-L574) 新增「挂起 `POST /v1/voice-services` → 返回角色配置卸载添加页 → 释放响应 → 自动选中且保留探测结果并可跳转管理」的确定性复现断言。

#### 12.9.3 自验证据

- **渲染器门禁**：`cd apps/desktop/renderer && npm run check && npm run build` 通过（令牌同步、23 个 CSS 零违规／豁免 388、`tsc --noEmit` 通过、`vite build` 130 模块）。
- **桌面单测**：`cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs` **148／148** 通过（0 失败，0 跳过）。
- **Electron E2E**：
  - `workflow-real-backend-chain-check.cjs` 连续实跑 **20／20 退出 0**（20.5～33.8s，原 `:942` `role-picked-voice-svc` 抖动 0 次复现）；
  - 其余 10 条 E2E（含新增延迟卸载竞态断言的 `settings-workspace-check.cjs`）**10／10 退出 0**；日志位于 `apps/backend/test-results/310-pack3-jitter-fix-20261118/e2e/`。
- **后端门禁**：`npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit` 与 `npx -y node@24 scripts/accept-offline.mjs` **21／21 步**通过（正式测试 **444／444**、`delivery-tests` 2／2、`realServiceCalls = 0`、`sourceUnchanged = true`，报告 `apps/backend/test-results/p5-2026-11-18T09-38-18-926Z-963de732/summary.json`）。

**性质说明**：本节修复及 20／20 复跑为实施者自验通过，待独立复核；真实安装包（`package:win`、`node-runtime` 随包、`appRoot` 迁移）与真实外部服务联调仍在待联调范围。

### 12.10 §12.9 抖动修复独立复核（2026-11-18，**通过**）

在 §12.9 工作树上独立复核，结论均来自自行实跑与回退对照，不采信 §12.9 自验数字。**工作流 E2E 连跑 20／20 通过，`:942` 抖动 0 次复现；两层修复均有回退对照验证为真守卫，§12.9 通过。**

#### 12.10.1 独立验证

| 验证项 | 独立方法 | 结果 |
| --- | --- | --- |
| 工作流 E2E 稳定性 | 同一命令连续实跑 **20 次** | **20／20 退出 0**（20～40s）；原 `:942` `role-picked-voice-svc` 0 次复现，`:801`／`:647` 亦 0 次复现；日志 `workflow-run1..20.log` |
| 其余 10 条 E2E | 各独立运行 1 次，`settings-workspace-check` 另加跑 3 次 | **全部退出 0**（`dialogue-layout` 11s、`relations-desktop` 12s、`theme-transition` 21s、`settings-auto-reload` 20s、`settings-binding-recovery` 27s、`pack3-entry` 17s、`settings-real-backend` 8s、`settings-review-fixes` 8s、`startup-flow-fixes` 20s；`settings-workspace` 32s／37s／26s 三次均过），各日志 `errors: []` |
| 渲染器门禁 | 实跑 `npm run check` + `npm run build` | 令牌最新、**23 个 CSS 零违规**（豁免 388）、`tsc --noEmit` 通过、构建成功 |
| 桌面单测 | 实跑 `node --test tests/*.test.cjs` | **148／148** 通过（含新增 `syncVoiceFormServices`／`syncImageFormServices` 单测） |
| 后端门禁 | 实跑 `accept-offline.mjs` | **21／21** 步、**444／444**、`realServiceCalls = 0`、`sourceUnchanged = true`，报告 `apps/backend/test-results/p5-2026-11-18T10-16-42-632Z-f525433f/summary.json` |
| 文档巡检 | `node scripts/check-docs.mjs` | 0 错误 0 警告 |

#### 12.10.2 用例是否真守卫（回退对照）

| 对照 | 方法 | 结果 |
| --- | --- | --- |
| 全量回退 | 临时把 `VoicePanel.tsx`／`ImagePanel.tsx`／`VoiceServiceEditor.tsx`／`Settings.tsx` 回退到 `6010e1b`，重建后单跑 `settings-workspace-check` | 在新增「延迟卸载」断言处等待超时（`:572` 自动选中 `voice-1`），确认用例不是空断言 |
| 半修复对照（仅回退回调侧） | 只回退 `VoiceServiceEditor.tsx`／`Settings.tsx`（卸载后仍丢弃缓存写入与 `onCreated`），保留面板 `serviceSyncSeq`／`active` 同步 | 仍失败，断在 `:573` 探测缓存未带入；说明用例同时覆盖「卸载后写缓存并通知父级」与「面板回归可见时重新同步」两侧，任一侧缺失即红 |
| 恢复后回归 | 还原补修文件（md5 与备份一致）重建 | `settings-workspace-check` 连跑 3 次全过 |

#### 12.10.3 改动质量核对

- **回调侧**：`VoiceServiceCreate`／`VoiceServiceDetail` 与 `ImageServiceCreate`／`ImageServiceDetail` 把「探测／模型缓存写入 + `onCreated`／`onUpdated`／`onRemoved`」移出 `live.current` 守卫，本地 UI 状态（`busy`／`error`／`message`）仍受守卫；缓存键与载荷取自响应结果与点击时快照，未引用已卸载组件的可变状态。React 19 下卸载后父级 `setState` 安全（父 `Settings` 仍挂载），不会产生警告或无效写入。
- **面板侧**：`syncVoiceFormServices`／`syncImageFormServices` 在无变化时返回原引用（不打断草稿），仅在「未配置且未选服务」时自动选中（语音优先启用项，生图同样），已选服务只同步协议／地址／默认模型；两个面板以 `serviceSyncSeq` 保序，并在 `serviceRefreshVersion` 变化或 `active` 由 `false` 切为 `true` 时同步，初次加载与同步并发时按序号丢弃旧结果，角色切换仍由 `roleToken` 拦截。
- **无覆盖退化**：同步失败仍 `catch` 后保留草稿、保存走正式校验；`savedForm` 比对维持脏标记；未把同步失败吞成「恒通过」。

#### 12.10.4 观察项（不阻塞）

1. **初次加载被后续同步超越的窄时序**：若角色切换的初次加载尚在途、同时 `serviceRefreshVersion` 变化触发新同步，`else` 分支会把 `savedForm` 基线写成 `baseForm`，可能与已同步 `form` 不一致而短暂误报未保存；仅影响脏标记，不改写表单内容。
2. **生图侧无延迟卸载 E2E**：新增确定性延迟卸载用例只覆盖语音路径；生图侧为同构修复，由纯函数单测与既有生图 CRUD／自动选中流程覆盖，未单设延迟卸载用例。
3. **E2E 防挂提示**：`settings-workspace-check` 的延迟响应 `Promise` 无超时，若保存点击未真正触发请求，脚本会挂起而非快速失败（测试健壮性建议，不影响结论）。

**结论**：§12.8.3 的 `:942` 遗留抖动在 20 次连跑中 0 次复现，两层根因（卸载后丢弃回调、面板缺少回归可见同步与保序）均有回退对照证明为真守卫，其余门禁全绿，**§12.9 补修独立复核通过**，包 3 结论维持「通过」。该结论不表述为「E2E 绝对零抖动」，仅证明本轮 20 次与回退对照通过；打包交付（`node-runtime` 随包、`package:win` 实机启动、`appRoot` 迁移策略）仍待联调，不随本次通过。

**证据**：`apps/backend/test-results/310-pack3-recheck3-20261118/e2e/`（`workflow-run1..20.log` 与其余 12 次脚本日志）、`apps/backend/test-results/p5-2026-11-18T10-16-42-632Z-f525433f/summary.json`。
