# 角色配置、全局资源与活动守卫规范

> **状态**：现行规范 · **适用范围**：`apps/backend/src/{http,application,domain,bootstrap,cli}` 与 `apps/desktop/renderer/src/{pages/Settings.tsx,components/*}`  
> **覆盖关系**：整合 [252](../archive/04-role-settings-and-media/252-role-config-settings-development-plan.md)、[254](../archive/04-role-settings-and-media/254-role-activity-config-guard.md)、[257](../archive/04-role-settings-and-media/257-resource-management.md)、[262](../archive/04-role-settings-and-media/262-role-appearance-deletion-history.md)、[278 §1～§3 与 §5 配置守卫部分](../archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md#1-角色配置在原页面完成)、[280](../archive/06-workflow-simplification/280-278-progress-role-workspace-dialogue-receipt.md)、[281](../archive/06-workflow-simplification/281-278-progress-guarded-panels.md)、[282](../archive/06-workflow-simplification/282-278-progress-model-impact-resource-detail.md) 及 [292 §1～§2、§6～§7](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#1-角色删除同页暂停278-14) 的现行配置契约与操作链路规则；历史实施方案保留原文仅作归档。

---

## 1. 适用范围、上游决定与依赖规范

### 1.1 适用范围

- **角色活动与配置写入守卫**：角色三态（`active` / `stopping` / `stopped`）、停启控制、写保护租约与读体二次校验、重启收敛与恢复重调度。
- **角色配置读写与直接删除**：人设档案与修订号、自主额度、资源全表绑定与乐观锁合并、外观服饰/差分运维与回退、角色语音/场景生图配置写入，以及角色带历史选项删除（`keepHistory`）。
- **全局资源与语音／生图服务维护**：全局模型 / MCP / Skill 资源目录的创建、更新、凭据只写与换站重验、MCP 环境变量脱敏、占用报告（`references`）、依赖影响范围（`impact`）、模型维护窗口协调（`maintenance`）与两阶段删除；以及全局语音／生图服务按依赖维护和删除。
- **桌面设置页与后台协调**：设置页（[Settings.tsx](../../apps/desktop/renderer/src/pages/Settings.tsx)）的同页暂停保存/删除、并发绑定自动合并，以及句段标注/过场图规划的维护等待协调。
- **不包含范围**（归入其他现行规范）：
  - 前端设计语言、字体/间距/颜色/动效令牌与 `ui/` 组件约定：统一见 [前端设计规范](./frontend-design-system.md)。
  - 对话演出/输入防抖/SSE/过场图生成流程、ComfyUI 与 TTS 具体服务适配与推理协议、角色存储/记忆整理/自主任务调度/首次配置引导（`278 §4`）：分别见 [对话演出与过场图规范](./conversation-performance-and-scene-images.md)、[TTS 与生图服务接入规范](./tts-and-image-services.md) 与 [存储、记忆与自主执行规范](./storage-memory-and-autonomy.md)。

### 1.2 上游产品决定（`161 DL-xx`）

| 决定 | 约束摘要 | 落地与偏差说明 |
| --- | --- | --- |
| [DL-71](../161-digital-life-direction-decisions.md#dl-71-资源关闭前台立即关闭既有任务链继续至结束) · [DL-72](../161-digital-life-direction-decisions.md#dl-72-任务链边界按具体目标组织由角色判断结束) · [DL-73](../161-digital-life-direction-decisions.md#dl-73-任务恢复持久保留原任务链的资源延续关系) | 资源关闭对前台与新任务立即生效，已在执行的原任务链延续使用至角色判定目标结束或终止，并跨重启持久保留延续关系；不包装额外授权审批 | 对应 `ROLE_BINDING` / `TASK_CHAIN` 占用与恢复延续 |
| [DL-118](../161-digital-life-direction-decisions.md#dl-118-首批模型接入openai-与-anthropic-协议获取列表后选择模型) · [DL-119](../161-digital-life-direction-decisions.md#dl-119-模型配置手动填写列表失败保留与主动测试连接) · [DL-120](../161-digital-life-direction-decisions.md#dl-120-测试连接行为简短实际请求独立于角色对话与自主额度) | 模型支持列表探测、手动填写与独立连接测试（不占对话与自主额度） | `POST /v1/model-services/*` 与 `/v1/resources/:id/{models,model-test}` |
| [DL-121](../161-digital-life-direction-decisions.md#dl-121-本地客户端通信http-api-与-ssecli-和桌面共用入口) · [DL-124](../161-digital-life-direction-decisions.md#dl-124-记忆整理模型默认继承对话模型支持角色单独绑定) | CLI 与桌面共用本地 HTTP API；记忆模型未单独绑定时继承对话模型 | `impact()` 与运行时使用同一套模型解析规则 |
| [DL-147](../161-digital-life-direction-decisions.md#dl-147-移除陪伴角色概念按角色查看和编辑) | 移除陪伴角色状态及相关操作，冷启动先经角色选择页再共享当前角色；设置页只改编辑对象，异步操作按发起时的 `roleId` 归属。 | 现有请求按 `roleId` 与请求令牌结算。冷启动选角页与陪伴入口移除待实施。 |
| [DL-153](../161-digital-life-direction-decisions.md#dl-153-唯一主角色席位默认播种夏澄沿用现有对话链路) | 主角色席位不可删除。设置页可修改显示名、编辑或清空介绍、维护预置服饰和素材。管理员职责与管理知识随席位注入。 | 人设写入沿用停机守卫与修订号校验，外观沿用普通角色维护约束。 |
| [DL-148](../161-digital-life-direction-decisions.md#dl-148-配置修改直接删除与运行限制) | 改删角色前由后端确认已停止；「已请求停止」与「已停止」分离且以后端为准；模型维护按具体服务只暂停实际依赖目标；删角色由用户选保留或清理记忆与对话；恢复保留待办与自主额度 | **规范文本滞后注记**：`161` 正文仍写着「MCP/Skill 被占用时后端拒绝全局关闭」，实现已按 `278 §3` / `282 §2` 先行放行全局单独停用（`canDisable: true`），待统一修订 `161` 正文 |
| [DL-149](../161-digital-life-direction-decisions.md#dl-149-角色语音只保留当前一份配置) | 每角色只保留一份语音配置；停用保留配置，新配置覆盖旧配置 | `PUT /v1/roles/:roleId/voice` 与 `/voice/enabled` |
| [DL-152](../161-digital-life-direction-decisions.md#dl-152-全局管理语音服务角色从设置中选择服务并配置专属音色与试听) | 设置「模型 -> 语音」全局管理语音服务（协议、地址、可选默认引擎、启停与删除受全局守卫）；角色选服务配音色 | `/v1/voice-services*` 与 `PATCH/DELETE` 入 `GLOBAL_CONFIG_WRITES` |
| [DL-151](../161-digital-life-direction-decisions.md#dl-151-删除不做归档) | 删除角色、外观或资源直接执行不做归档；受管外观副本按保留历史引用按需留存或清理；用户源目录始终保留 | 软删除服饰 + 无历史引用素材清理 + `role_deletions` / `resource_deletions` |
| [DL-183](../161-digital-life-direction-decisions.md#dl-183-全局设置页提供持久-token-消耗统计) | 全局设置「用量」分区只读展示本机持久累计的 7 类模型 Token 消耗（不计本地 TTS／生图），删角色／模型服务后保留历史并暂不提供手动清零 | `GET /v1/usage/tokens` ＋ 全局设置「用量」分区（[TokenUsageSection](../../apps/desktop/renderer/src/components/config/TokenUsageSection.tsx)） |

### 1.3 依赖规范

- [持续决策记录（161）](../161-digital-life-direction-decisions.md)
- [前端设计规范](./frontend-design-system.md)
- [后端使用与运行说明](../../apps/backend/README.md)
- [当前状态看板（STATUS）](../STATUS.md)

---

## 2. 正常入口、输入输出与数据归属

### 2.1 角色活动状态入口（HTTP 与 CLI 共用）

| 操作 | HTTP 方法与路径 | CLI 子命令 | 关键返回字段与说明 |
| --- | --- | --- | --- |
| 列出全部角色活动状态 | `GET /v1/activities` | `activity list` | `{ items: RoleActivityView[] }` |
| 查询单角色活动状态 | `GET /v1/roles/:roleId/activity` | `activity get --role <id>` | `{ activity: RoleActivityView }`：`roleId`、`state`（`active \| stopping \| stopped`）、`requestedAt`、`confirmedAt`、`boundaryExecutionId`、`updatedAt`、`initStatus`、`running`；无持久化记录时视 `state: "active"`、`updatedAt: null` |
| 请求停止角色活动 | `POST /v1/roles/:roleId/activity/stop` | `activity stop --role <id>` | `{ activity: RoleActivityView, confirmed: boolean }`；无在途执行时同步确认 `stopped` 并返回 `confirmed: true` |
| 恢复角色活动 | `POST /v1/roles/:roleId/activity/resume` | `activity resume --role <id>` | `{ activity: RoleActivityView }`；切回 `active` 并接回因停止暂缓的任务链与到期待办；角色当前模型服务处于维护窗口时返回 `409 RESOURCE_MAINTENANCE`，当前语音／生图服务处于维护窗口时返回 `409 MEDIA_SERVICE_MAINTENANCE` |

### 2.2 受保护的配置写入接口与守卫分类

策略清单元头在 [config-writes.ts](../../apps/backend/src/http/config-writes.ts)，实际路由守卫绑定在 [routes.ts](../../apps/backend/src/http/routes.ts#L99-L108) 与 [write-guard.ts](../../apps/backend/src/http/write-guard.ts)：

1. **角色级写入（`ROLE_CONFIG_WRITES`，经 `Router.setGuard` 自动包装 `roleWrite`）**：
   - **角色档案、删除与绑定**：
     - `DELETE /v1/roles/:roleId?keepHistory=0|1|true|false`：必填 `keepHistory`（缺省 `400 KEEP_HISTORY_REQUIRED`，非法 `400 INVALID_QUERY`）；返回 `{ roleId, keepHistory, filesRemoved }`。
     - `PATCH /v1/roles/:roleId/definition`（CLI：`role update`）：`{ displayName?, bio?, definition?: { text, payload? }, expectedRevision? }`。名称、介绍和角色卡至少提供一项；`bio: ""` 清空介绍，省略时保留原值。三者共享角色卡修订号。
     - `PUT /v1/roles/:roleId/bindings`（CLI：`binding put`）：`{ bindings: Array<{ capability: "chat_model" \| "memory_model" \| "mcp" \| "skill", resourceId, modelName?, enabled? }>, expectedRevision? }`；返回 `{ items, revision }`。
   - **自主额度**：
     - `PUT /v1/roles/:roleId/autonomy/budget`：`{ unlimited: boolean, dailyLimit?: number }`（`dailyLimit` 为 `1..1_000_000` 整数）。
   - **语音与场景生图配置**：
     - `PUT /v1/roles/:roleId/voice`（JSON 或 `multipart/form-data` 含 `payload` 与 `file`）、`PUT /v1/roles/:roleId/voice/enabled`（`{ enabled }`）、`POST /v1/roles/:roleId/voice/reference`、`DELETE /v1/roles/:roleId/voice/references/:assetId`
     - `PUT /v1/roles/:roleId/scene-image`
   - **外观衣柜**：
     - `POST /v1/roles/:roleId/appearance/outfits`、`PATCH /v1/roles/:roleId/appearance/outfits/:outfitId`、`POST /v1/roles/:roleId/appearance/outfits/:outfitId/home`、`DELETE /v1/roles/:roleId/appearance/outfits/:outfitId`、`POST /v1/roles/:roleId/appearance/outfits/:outfitId/sprites`、`DELETE /v1/roles/:roleId/appearance/outfits/:outfitId/sprites/:assetId`、`DELETE /v1/roles/:roleId/appearance/outfits/:outfitId/home/:assetId`。
     - 服饰 PATCH 可附带 `assetNames`（素材 ID 至显示名的映射），与名称、说明同时提交。上传单张差分时可附带 `replaceAssetId` 替换指定差分。立绘与差分的历史引用沿用原素材，删除服饰仍须至少保留一套。

2. **全局语音／生图服务写入**：
   - `PATCH` 和 `DELETE /v1/voice-services/:serviceId`、`/v1/image-services/:serviceId` 由服务维护协调器按当前依赖处理。`GLOBAL_CONFIG_WRITES` 现为空，后端这四条路由允许无关角色继续活动。见 [§3.2.1](#321-语音生图服务维护窗口)。

3. **全局资源维护与删除（`RESOURCE_CONFIG_WRITES`，[routes.ts](../../apps/backend/src/http/routes.ts#L103-L107) 不再挂载旧 `resourceWrite`，改为处理器与服务层分级处理）**：
   - `PATCH /v1/resources/:resourceId`（CLI：`resource update`）：`{ name?, enabled?, config?, secret?: string | null }`。
     - `kind === "model"`：仅改 `name` 或 `enabled` 不暂停角色；连接参数或凭据变化（`protocol` / `baseUrl` / `credentialRef` / `secret`）时只暂停 `impact` 中 `state !== "stopped"` 且承担 `chat` / `memory` 用途的角色，响应返回 `{ ...resourceView, maintenance: { connectionChanged, pausedRoleIds } }`。
     - `kind === "mcp" | "skill"`：仅切换 `enabled`（`onlyToggle`：`!nameChanged && !configChanged && secret === undefined`）时**直接放行**；若同时修改名称、命令/参数/环境变量或 `sourcePath`，则按占用检查（有启用绑定或未结束任务链拒绝 `409 RESOURCE_IN_USE`）。
   - `DELETE /v1/resources/:resourceId`（CLI：`resource delete`）：返回 `{ resourceId }`。
     - `model` / `mcp` / `skill` 均在 `ResourceService.remove()` 内校验 `references().canDelete`（`!enabledBinding && chains.length === 0 && inflight.length === 0`），**不再要求全局无关角色停机**；已被受理处于待清理状态时重试同一 `DELETE` 幂等继续清理。

### 2.3 新建、只读与草稿探测入口（不触发停机守卫）

- **角色**：`GET /v1/roles`、`POST /v1/roles`（返回 `201`，新建角色通过 `markCreatedStopped` 初始即设为 `stopped`）、`GET /v1/roles/:roleId`、`POST /v1/roles/:roleId/initialize`。
- **全局资源查询、影响与探测**：
  - `POST /v1/resources`（`201`，支持 `kind: "model" | "mcp" | "skill"`、`name`、`enabled?`、`config`、`secret?`；CLI：`resource create`）
  - `GET /v1/resources`（可选 `?kind=model|mcp|skill`；CLI：`resource list`）、`GET /v1/resources/:resourceId`（CLI：`resource get`）
  - `GET /v1/resources/:resourceId/references`（CLI：`resource references`）：返回 `{ resourceId, kind, references, canUpdate, canDisable, canDelete }`；每条引用含 `reason: "ROLE_BINDING" | "TASK_CHAIN" | "INFLIGHT_CALL"`、`roleId`、`capability`、`bindingEnabled` 及可选 `taskId` / `taskStatus`。其中 `canDisable` 恒为 `true`，`canUpdate` 对 `mcp`/`skill` 为 `!enabledBinding && chains.length === 0`（对 `model` 为 `true`），`canDelete` 为 `!enabledBinding && chains.length === 0 && inflight.length === 0`。
  - `GET /v1/resources/:resourceId/impact`：按运行时同一模型解析规则返回 `{ resourceId, kind, roles: Array<{ roleId, displayName, usages: Array<"chat" | "memory" | "task">, taskIds, state, running }>, blockingTasks }`；全局停用且无续用的服务不计入依赖，独立记忆模型不可用时回退至对话模型计入实际目标，仅旧任务链依赖记为 `["task"]`。
  - `POST /v1/model-services/models`、`POST /v1/model-services/test`、`POST /v1/resources/:resourceId/models`、`POST /v1/resources/:resourceId/model-test`（`{ model }`）、`POST /v1/resources/:resourceId/secret/reveal`（仅在用户在详情页主动点击「显示」时按需返回当前模型凭据原文或引用）。
- **角色配置读取与草稿试听/测试**：
  - `GET /v1/roles/:roleId/bindings`（CLI：`binding get`，返回 `{ items, revision }`，读侧自动过滤 `resource_deletions` 待清理项）
  - `GET /v1/roles/:roleId/autonomy`、`GET /v1/roles/:roleId/autonomy/budget`
  - `GET /v1/roles/:roleId/voice`、`GET /v1/roles/:roleId/voice/references`、`POST /v1/roles/:roleId/voice/probe`、`POST /v1/roles/:roleId/voice/preview`
  - `GET /v1/voice-services`、`POST /v1/voice-services`、`POST /v1/voice-services/probe`、`POST /v1/voice-services/:serviceId/probe`
  - `GET /v1/image-services`、`POST /v1/image-services`、`POST /v1/image-services/probe`、`POST /v1/image-services/:serviceId/probe`
  - `GET /v1/roles/:roleId/scene-image`、`POST /v1/roles/:roleId/scene-image/probe`、`POST /v1/roles/:roleId/scene-image/preview`、`POST /v1/roles/:roleId/scene-image/anchor-prompts`（注：`292-R07` 校验服饰属于当前角色且未删除，见第 5 节）。
- **全局 Token 用量只读查询与展示（`DL-183`）**：`GET /v1/usage/tokens`（支持 `range=today|7d|30d|all`、`roleKey`、`category`、`modelKey`，非法参数返回 `400 INVALID_QUERY`）；桌面端在全局设置「用量」分区只读展示（无手动清零入口），使用 `BigInt` 聚合超 64 位整数字符串并自适应换算 `K` / `M` / `B` / `T`（悬停提示精确整数）。

#### 2.3.1 模型服务商与候选来源

设置页的「协议」可选择通用协议或指定服务商。指定服务商会填入官方基础地址，用户仍可改为自己的代理。新服务和已保存服务均可点击「读取列表」。角色配置里的对话模型和记忆模型使用所选资源的目录，也可以直接输入模型 ID。网络或鉴权失败时保留已有候选和输入值。「测试连接」单独发送简短生成请求。全局模型和生图服务的完整表单在模型名旁提供一次连接测试；单独编辑连接时可就地测试。语音服务一次测试同时读取引擎目录。

下表的入口核对日期为 **2026-11-20**。目录路径相对于所选基础地址。

| 服务商 | 官方基础地址 | 模型候选与生成方式 |
| --- | --- | --- |
| OpenCode Go | `https://opencode.ai/inference/go` | 从 `/v1/models` 读取 Go 目录。文本模型走 `/openai/v1/chat/completions`。客户端以 Nowadays 标识自己，并为每个对话窗口发送稳定的 `x-opencode-session`。官方将此订阅用于编码代理工作负载。[Go 使用范围](https://opencode.ai/docs/console/go/) · [目录](https://opencode.ai/docs/console/api/models/) · [协议与会话头](https://opencode.ai/docs/console/harnesses) |
| DeepSeek | `https://api.deepseek.com` | 用 Bearer 密钥读取 `/models`。带工具的 Chat Completions 请求按原次序回传本轮各批调用的 `reasoning_content`。[模型目录](https://api-docs.deepseek.com/api/list-models/) · [思考模式](https://api-docs.deepseek.com/guides/thinking_mode/) |
| OpenRouter | `https://openrouter.ai/api/v1` | 有密钥时读取 `/models/user`，应用账户的供应商偏好与隐私设置。无密钥时读取公开的 `/models`。这两个入口默认返回文本输出模型。[账户模型](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails) · [公开模型](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) · [推理续轮](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) |
| xAI | `https://api.x.ai/v1` | 用 Bearer 密钥读取 `/language-models` 的模型 ID 和别名，生成走 Responses，续轮携带加密推理块。[语言模型目录](https://docs.x.ai/developers/rest-api-reference/inference/models) · [推理模型调用](https://docs.x.ai/developers/model-capabilities/text/best-practices) |
| Z.AI | `https://api.z.ai/api/paas/v4` | 用 Bearer 密钥读取 `/models`，生成走 Chat Completions。Coding Plan 用户可将基础地址改为 `https://api.z.ai/api/coding/paas/v4`，并填入对应套餐的密钥。[账户类型与端点](https://zcode.z.ai/en/docs/configuration) · [标准目录](https://api.z.ai/api/paas/v4/models) |
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | 用 `api-key` 读取 `/models` 和调用 Chat Completions。文本选择器过滤独立 ASR、TTS 模型。连续调用工具时完整回传各批推理字段。[模型目录](https://mimo.mi.com/docs/en-US/api/model/list-models) · [推理续轮](https://mimo.mi.com/docs/en-US/usage-guide/passing-back-reasoning_content) |
| Google AI Studio | `https://generativelanguage.googleapis.com/v1beta` | 点击后按 `nextPageToken` 读取各页，只列出支持 `generateContent` 的候选。[模型目录](https://ai.google.dev/api/models#method:-models.list) |
| Google Vertex AI 自动连接 | `https://aiplatform.googleapis.com/v1/publishers/google` | 下拉框提供 Gemini 4 Neon、Hydrogen、Carbon、Argon，以及 3.8 Flash、3.5 Flash、3.1 Pro Preview、3 Flash Preview、3.5 Flash-Lite 和 3.1 Flash-Lite，也可手填其他 ID。可用「测试连接」确认当前账号能否调用所选模型。[Express 概览](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview) · [模型生命周期](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions) |
| Google Vertex AI 标准全局端点 | `https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google` | 使用自己的项目 ID。候选包含 Gemini 4 Neon、Hydrogen、Carbon、Argon 及通用 Flash 模型，实际调用取决于项目权限。[Gemini 4 接入指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/get-started-with-gemini-4) |

官方 Vertex 默认在「测试连接」时先试 Express。若 Google 返回 404 并指明同一模型所在项目的非全局区域，再测试该项目的 global 入口。成功后按服务、凭据版本和模型记录入口，草稿的测试结果在保存服务时关联。正式对话与记忆请求直接使用已验证入口，未测试时沿用服务地址。「高级设置」中可指定 Express、global 或其他地区。指定地区后，测试和对话始终使用该地址。global 与其他项目端点需要 Google Cloud 项目 ID 或编号。[Google 端点与地区](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations)

Vertex 的「连接 → 安全阈值」对四类可配置内容统一生效。高从低风险起拦截，默认沿用模型默认阈值，关闭对应 `OFF`。每次生成（含连接测试和工具续轮）均在顶层 `safetySettings` 发送四类设置。旧资源默认沿用模型阈值。[Google 安全过滤说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/configure-safety-filters)

模型资源的可选 `provider` 标识服务商，`protocol` 记录实际传输协议。没有 `provider` 的既有资源继续使用原配置。凭据复用按服务商、协议和 origin 校验。服务商变化会使模型候选缓存和测试结果失效。角色只向同一资源、服务商、协议、地址和模型续传原生推理与签名。同一轮中各批原生调用与工具结果按产生顺序配对。DeepSeek 和 MiMo 启用工具时，本地保存的历史回复通过带角色标记的引用提供。

### 2.4 数据归属与凭据脱敏规则

- **App 中心库（`AppStore`）**：持有角色索引与 `initStatus`、角色活动三态与停止边界记录（`role_activity`）、全局资源与模型测试摘要（`protocol` 或 `baseUrl` 变动时清除旧 `lastTest`）、全局语音与生图服务、加密凭据引用、两阶段删除待清理队列（`resource_deletions`、`role_deletions`）。
- **角色独立库（`roles/<roleId>/`）**：持有角色设定与 `definitionRevision`、全表资源绑定（`role_bindings`）、自主额度与唤醒待办、对话与任务链/资源延续记录、外观软删除记录与素材引用、角色语音与场景生图配置；`keepHistory=1` 删除时只移出 App 索引与活动记录、保留角色目录，`keepHistory=0` 时加入 `role_deletions` 并删除 `roles/<roleId>` 目录，用户原始素材目录在任何情况下都不删除。
- **凭据只写、按需显隐与脱敏**：
  - `model` / `image-service` 常规创建、列表与详情视图均仅返回凭据状态不回显明文；模型资源详情支持在用户主动点击「显示」时通过 `POST /v1/resources/:resourceId/secret/reveal` 按需取回原文，默认仍以掩码文本形式编辑（未改则保留、清空则删除、改写则替换）；直填 `secret` 与 `config.credentialRef` 不可并存（`409 RESOURCE_CREDENTIAL_CONFLICT`）；更换 `protocol` 或站点（`baseUrl` origin 变更）而试图沿用旧密钥或未变更的 `credentialRef` 会被拒绝（`409 RESOURCE_CREDENTIAL_STALE`）。
  - `mcp` 资源 `config.env` 所有值统一脱敏返回 `***`；更新 `mcp` 时 `mergeRedactedMcpEnv` 将提交值仍为 `***` 的键保留库中原值。

#### 本地 MCP 与 Skill 导入

桌面按 DL-194 导入本地扩展。MCP 新建表单识别 `mcpServers` 或单个 stdio 配置，多服务可选择本次添加项。草稿通过 `POST /v1/resources/mcp/probe` 启动测试，读取工具清单并关闭进程。Skill 的 `POST /v1/resources/skills/discover` 读取单包或一级子目录的名称与用途，`POST /v1/resources/skills/import` 将勾选项原子登记为各自独立的资源。技能文件沿用所选目录，历史绑定的整库路径仍可按需发现和读取技能。

### 2.5 关键 HTTP 状态码与错误码

| HTTP | 错误码 | 触发场景与处理 |
| --- | --- | --- |
| `400` | `KEEP_HISTORY_REQUIRED` / `INVALID_QUERY` | `DELETE /v1/roles/:roleId` 缺少 `keepHistory` 或取值非 `0 \| 1 \| true \| false`；`GET /v1/resources` 的 `kind` 非法 |
| `400` | `INVALID_RESOURCE_CONFIG` / `INVALID_BINDING` | 资源配置结构或绑定字段校验失败 |
| `404` | `ROLE_NOT_FOUND` / `RESOURCE_NOT_FOUND` / `IMAGE_SERVICE_NOT_FOUND` | 目标角色、全局资源或全局生图服务不存在 |
| `409` | `ROLE_NOT_STOPPED` | `ROLE_CONFIG_WRITES` 目标角色非 `stopped`（含读体后并发恢复） |
| `409` | `ROLES_NOT_STOPPED` | 模型或语音／生图服务维护遇角色暂停协调失败或未配置 `pauseRoles`。响应可在 `details.roles` 或 `details.maintenance.pausedRoleIds` 带回状态 |
| `409` | `ROLE_ACTIVITY_CONFLICT` | 请求 `resume` 时持写租约冲突或状态不允许 |
| `409` | `ROLE_STOP_REQUESTED` / `ROLE_ACTIVITY_STOPPED` / `ROLE_BUSY` | 角色正请求停止/已停止时拒绝新执行；删除等待在途收尾（默认 `roleDeletionWaitMs = 15000`）超时返回 `ROLE_BUSY` |
| `409` | `RESOURCE_IN_USE` | `DELETE /v1/resources/:id` 存在启用绑定/`TASK_CHAIN`/`INFLIGHT_CALL`，或修改被占用的 MCP/Skill；`details.references` 返回具体占用项 |
| `409` | `RESOURCE_MAINTENANCE` | 并发对同一模型维护、维护期间向该资源新增启用绑定、维护后复查出现新增依赖角色，或恢复依赖维护中资源的已停止角色 |
| `409` | `MEDIA_SERVICE_MAINTENANCE` | 并发维护同一语音／生图服务、维护期间新领取该服务、角色改绑或恢复受影响、在途调用未在期限内结算等 |
| `409` | `MEDIA_SERVICE_IN_USE` | 删除语音／生图服务时有非 `stopped` 角色引用或在途调用。`details.roles` 给出活动依赖，`details.inFlightRoleIds` 给出在途角色 |
| `409` | `RESOURCE_CREDENTIAL_CONFLICT` / `RESOURCE_CREDENTIAL_STALE` | 同时传入 `secret` 与 `credentialRef`；或换协议/换站点时仍沿用旧密钥/旧引用 |
| `409` | `BINDING_REVISION_CONFLICT` / `REVISION_CONFLICT` | `PUT /bindings` 传入的 `expectedRevision` 过期；或人设版本冲突 |
| `409` | `LAST_ROLE_REQUIRED` / `LAST_OUTFIT_REQUIRED` | 试图删除最后一个角色或角色最后一套服饰 |
| `409` | `IMAGE_SERVICE_DISABLED` | 新建或改绑选择了已停用的生图服务，或请求通过该服务探测、生成 |

---

## 3. 状态变化、并发约束、前后端分工与失败恢复

### 3.1 角色活动三态与写入租约

1. **三态转移与边界**：
   - 新建角色默认通过 `markCreatedStopped` 置为 `stopped`，避免未配模型即处于活动态。
   - `active` -> `requestStop`：若 `activityRuntime.isRunning(roleId)` 为 `false` 则同步写入 `stopped`（`confirmed: true`）；若正在运行则先置 `stopping`，禁止新对话/自主唤醒与新节点，待运行节点走到可保存进度边界由 `confirmStop` 确认 `stopped`。
   - `resume`：仅把 `stopped` 切回 `active` 并调用 `resumeWork(roleId)` 接回停机前待办与暂停任务链，不清理待办、不重置自主额度；恢复前先过 `resourceService.assertResumeAllowed(roleId)` 检查，若当前解析的 `chat` 或 `memory` 模型正处维护窗口则拒绝（`409 RESOURCE_MAINTENANCE`）。
   - `reconcileStartup`（后端启动时）：清理历史运行状态并把无在途执行的 `stopping` 请求收敛为 `stopped`。
2. **并发写锁与读体后复验（[RoleActivityService](../../apps/backend/src/application/role/role-activity-service.ts)、[write-guard.ts](../../apps/backend/src/http/write-guard.ts)）**：
   - `guardRole` 按 `roleId` 维度的 `writeChains` 队列串行执行配置写入，并在持有 `roleLeases` 期间阻断并发 `resume`。
   - `guardAll` 的全局租约机制保留，当前 `GLOBAL_CONFIG_WRITES` 清单为空。
   - 对带请求体的配置写入，通过 `setBodyReadHook` 在异步读取完整请求体后、进入处理器之前再次执行 `assertStopped` / `assertAllStopped`，防止读体间隙有其他调用恢复角色导致写入越权。

### 3.2 模型连接维护窗口与后台调用协调

仅修改 `model` 的连接参数或凭据（`protocol` / `baseUrl` / `credentialRef` / `secret`）时，[routes.ts](../../apps/backend/src/http/routes.ts#L608-L695) 按下列顺序协调，其它无关角色继续运行：

1. **先预检再进窗口**：调用 `validateUpdate`（凭据冲突/换站旧密钥等可预判错误直接拒绝，不暂停任何角色）。
2. **计算影响与进入维护窗口**：调用 `maintenancePlan(resourceId, body)`；当 `connectionChanged` 为真时调用 `beginMaintenance(resourceId)`（同一 `resourceId` 禁止并发进入维护窗口）。
3. **只暂停实际 `chat` / `memory` 依赖的活跃角色并等在途调用**：
   - 对 `plan.pauseRoleIds`（非 `stopped` 且承担 `chat` 或 `memory`）调用 `pauseRoles`（[app.ts](../../apps/backend/src/bootstrap/app.ts#L104-L135)，最长等 20s，仅把原本 `state === "active"` 且本次被停下的角色计入 `pausedRoleIds`；若等待前角色已 `stopping`，会等其停稳而不纳入前端一键恢复名单）。
   - 对 `plan.waitRoleIds`（目标服务上已有在途调用的所有角色，含已停止但后台记忆/标注/规划调用尚未结算的角色）调用 `waitForInflightIdle(resourceId, waitRoleIds, 20_000)`；超时抛出 409。
4. **写前复查防竞态**：若执行了暂停或等待，写库前重新计算 `maintenancePlan`，发现新接入依赖角色且不在本次 `pausedRoleIds` 中时拒绝返回 `409 RESOURCE_MAINTENANCE`。
5. **落库、失败带回与退出唤醒**：写入成功返回 `{ ...view, maintenance: { connectionChanged, pausedRoleIds } }`；若暂停后写入或等待失败，通过 `withMaintenanceDetails` 在错误 `details.maintenance.pausedRoleIds` 带回本次已暂停角色；`finally` 必调 `endMaintenance(resourceId)` 唤醒等待者并调用 `wakePendingWork()`。
6. **维护期间的四处并发护栏**：
   - `replaceBindings` 拒绝为处于 `maintenanceResources` 中的服务新增启用绑定；
   - `assertResumeAllowed` 拒绝恢复当前对话/记忆解析到维护中服务的已停止角色；
   - **仅旧任务链依赖（`TASK_CHAIN`）** 目标模型而不作当前角色默认绑定时，不暂停整个角色，改为在调度入口 `chatTargetUnderMaintenance` 按任务暂缓；
   - 句段标注与过场图规划通过 `isResourceUnderMaintenance` / `waitForMaintenanceEnd` / `claimModelCall`（在同一同步步骤完成维护态校验与在途计数登记）等待维护结束，醒来后重新解析已保存配置再发请求。

#### 3.2.1 语音／生图服务维护窗口

角色已绑定的服务被全局停用后，可以保留原服务 ID、修改该角色其他参数。其他角色的新绑定、改绑到另一个停用服务、实际合成与生成仍受停用守卫约束。已删除的服务须重新选择。语音会话中曾为备用服务暂存的草稿不构成绑定。

- [MediaMaintenance](../../apps/backend/src/application/media/media-maintenance.ts) 读取就绪角色库内当前保存的 `serviceId` 并结合活动状态计算依赖。连接字段或凭据实际变更及全局停用进入维护窗口；只修改名称、默认引擎／模型或重新启用直接提交。
- 维护先校验可预判的输入错误，只暂停目标服务的活动依赖并等待已经领取的语音合成、试听或生图调用。窗口内阻止对同服务的并发写入、新领取、相关改绑和角色恢复，写前复验实际依赖。成功返回 `{ service, maintenance: { connectionChanged, pausedRoleIds } }`，失败也回带本次已暂停的角色 ID。已停止或原本正在停止的角色不计入本次恢复名单。
- 手动过场图重放已有幂等键仍返回原任务。单次生成超时可先结算任务，服务领取保留到实际生成调用结束；维护等待有界。删除时检查活动依赖和在途调用，停止角色的旧引用保留在角色库，用于界面提示重新选择。

### 3.3 删除两阶段事务与启动恢复

- **全局资源删除（[ResourceService.remove](../../apps/backend/src/application/resources/resource-service.ts#L707-L748)）**：
  - `app.sqlite` 为决策提交源，所有就绪角色库为从属清理对象；通过 `runWithDecisionCommit` 先确保任一角色库读取/打开或清理准备失败时整笔回滚、原绑定完好。
  - 决策库提交资源删除与 `resource_deletions` 记录后若部分角色库绑定清理失败，删后读取 `listBindings` 会过滤 `listResourceDeletions()`，由后端启动清理或客户端重试同个 `DELETE` 幂等完成剩余清理。
- **角色删除（[RoleDeletionService](../../apps/backend/src/application/role/role-deletion-service.ts)）**：
  - 通过串行队列与 `deleting` 互斥防止并发重复删/同时删光所有角色；事务内二次校验 `LAST_ROLE_REQUIRED`。
  - 清理内存/后台执行时经 `disposeRole` 取消过场图与排队标注，并等待 `waitForRoleInflightIdle`（默认 `roleDeletionWaitMs = 15000`）与记忆空闲；超时抛 `409 ROLE_BUSY` 并经 `onDeletionFailed` 调用 `conversation.wakePendingWork(roleId)` 补发删除期间被拒的维护唤醒。
  - `keepHistory=0` 时记录 `role_deletions` 并删除角色目录，目录被占用未删净时在响应 `filesRemoved: false` 后由下次启动 `reconcilePendingDeletions` 续删。
- **外观服饰删除**：软删除从 `listOutfits()`（衣柜与 Agent 共享数据源）移出；删除当前服饰回退到剩余服饰中最早创建的一套；仅删除不再被任何历史句段（`home_asset_id` / `sprite_asset_id`）引用的受管素材文件。

### 3.4 前后端协作分工与冲突恢复（桌面设置页）

| 职责 | 后端（唯一权威） | 桌面设置页（`Settings.tsx` 与子面板） |
| --- | --- | --- |
| 状态判定 | 维护唯一 `active`/`stopping`/`stopped` 状态、在途判断与维护窗口 | 不本地缓存假定可写；提交前拉取最新 `/v1/activities` 决定先暂停还是直接保存 |
| 角色同页暂停与保存 | 提供 `/activity/stop`、`/activity`、配置 `PUT/PATCH/POST/DELETE` 与 `guardRole` | 人设、绑定、额度与 `AppearancePanel` / `VoicePanel` / `ImagePanel` 统一经 `ensureRoleStopped` / `guardAction` 请求停止并按 250ms 轮询至 `stopped`（20s 上限），写完后在原处提供 `继续活动` |
| 模型服务变更与恢复 | `PATCH /v1/resources/:id` 协调依赖角色暂停并在成功响应或失败详情带回 `pausedRoleIds` | 在资源详情页展示 `/impact`；有活跃依赖时按钮文案切换为「暂停相关角色并保存」；失败保留草稿并根据 `pausedRoleIds` 提供「继续本次活动暂停的角色」 |
| 全局语音／生图服务改删 | 服务维护协调器按 §3.2.1 处理 | 桌面设置直接提交服务变更，使用后端返回的暂停名单展示恢复操作。活动依赖和在途请求的最终判定在后端。桌面复核范围见 [400 §26](../archive/08-config-pages-v6/400-config-pages-v6-migration-progress.md#26-主进程复核与系统适配2026-11-20) |
| 对象隔离与过期丢弃 | 按请求 URL 的 `roleId` 落库与加锁 | 捕获操作发起时的 `roleId`、`roleToken` 与请求序列号 `seq`（`AppearancePanel` / `VoicePanel` / `ImagePanel` / `useModelProbe`），切换编辑角色或页签后旧异步响应不污染新页面草稿（`DL-147`） |
| 绑定并行并发合并 | `PUT /bindings` 校验 `expectedRevision`，过期抛 `409 BINDING_REVISION_CONFLICT` | 捕获冲突后自动拉取最新 `/bindings`，调用 [mergeBindingDrafts](../../apps/desktop/renderer/src/components/model/binding-merge.ts) 按范围字段级合并（`models` 按能力名、`ext` 按 `capability:resourceId`）；无互斥改动时带最新 `revision` 自动重提一次，有互斥冲突则清空 `bindingRevision`、保留草稿并提示重新读取确认 |

---

### 3.5 后端热扩展（DL-184、DL-188）

主角色通过 `app_extension_upsert({extId, manifest, files})` 安装和升级扩展。`extId` 由小写字母开头，可含数字及连字符，最长 24 字符。`manifest` 指定 `version`、相对入口 `entry` 及可选 `ui: [{slot, file}]`。`files` 将相对路径映射到完整文本，可提交多份 `.mjs` 与 `ui/` 文本资源。每次更新使用新的版本目录，重载当前版本使用 `reload`。

主角色可用 `app_extension_source({extId, file?, version?, offset?})` 在新窗口查阅已安装的项目（DL-192）。省略 `file` 时按相对路径排序，每页列出最多 50 个文件；指定路径时，每页返回最多 6000 个 UTF-8 字节的完整字符。用返回的 `nextOffset` 续页，传回 `version` 可在版本切换时得到明确冲突。停用期间仍可维护源码。普通角色和桌面资源接口沿用各自的权限。

后端从 `config.appRoot` 派生 `extensions/<extId>/`，在每级路径核实真实位置并拒绝 junction。源码放在 `versions/<version>/`。每个扩展的 `manifest.json` 原子保存现行版本、工具声明、启停状态与最近错误。扩展 KV 独立保存在同目录的 `kv.json`，与清单分别原子替换。管理查询仅投影公开字段。删除扩展会同时删除所有版本和 KV。

扩展 KV 的键名须为非空白字符串、最长 128 字符，且不得为 `__proto__`、`constructor` 或 `prototype`，否则返回 400 `EXTENSION_KV_KEY_INVALID`；查找与写入都会拒绝。单值序列化后默认上限为 64 KiB，超出返回 413 `EXTENSION_KV_VALUE_TOO_LARGE`。每个扩展默认最多 256 个键、合计 1 MiB，超出返回 413 `EXTENSION_KV_QUOTA_EXCEEDED`；每秒最多 60 次写入，超出返回 429 `EXTENSION_KV_RATE_LIMITED`。拒绝仅回传到发起写入的扩展调用，不终止子进程。运行期写入先更新内存，再由 150 ms 防抖合并为最新快照并串行原子落盘；停用、升级时旧进程退出、应用关闭及宿主显式 `flushKv` 均会排空待写快照。旧布局保存在 `manifest.json` 的 `kv` 字段在启动恢复时自动迁移到 `kv.json`，并从清单中清除。

固定 runner 在独立 Node 24 子进程中创建 Cordis Context，通过文件 URL 导入入口。入口导出 `default(ctx, api)` 或具名 `apply(ctx, api)`。依赖文件使用相对导入；Cordis Context 由 runner 传入。runner 以 Node 24 `--permission` 限制文件系统读取范围，但该模式不会阻断网络出站，扩展后端仍可发起网络连接；隔离边界依赖独立子进程与文件权限，而不是网络沙箱。桌面端扩展前端始终运行在 `connect-src 'none'` 的 iframe CSP 中，不能直接访问网络。平台服务如下。

| 接口 | 契约 |
| --- | --- |
| `api.tools.register({name, description, inputSchema, scope, roleIds?}, handler)` | 返回注销函数。`inputSchema.type` 为 `object`。处理器接收参数和角色、窗口、执行、任务、自主执行标记，返回 JSON。模型看到的工具名为 `ext_<extId>__<name>`，每次模型请求刷新目录。范围可选 `admin_only`、`all_roles` 或 `selected_roles`。 |
| `api.events.on(name, handler)` | 返回退订函数。`dialogue_batch` 投递已向席位交付的批次事实，`role_exchange` 投递双边已落库的会话状态。向当时已订阅的扩展发送，业务提交无需等待处理器。 |
| `api.ui.onAction(name, handler)` | 在当前 Cordis Context 登记精确动作名并返回注销函数。handler 接收 JSON payload，可以读写本扩展 KV，返回 JSON。动作表独立于角色工具与平台事件，退出时由 Context 清理。 |
| `await api.kv.get(key)`、`await api.kv.set(key, value)` | 键须为非空白字符串且通过键名、单值、容量与写频校验，值为 JSON，缺失返回 `null`。候选初始化的写入在版本切换时提交并落盘。 |
| `await api.notify({message, data?})` | 后端订阅者通过 `extensions.onNotice(listener)` 接收含真实 `extId` 的结构化提示。候选初始化期间暂存，激活后发出。 |
| `ctx.effect(() => dispose)` | 在子进程中登记清理函数。停用、删除、升级和应用关闭均先排空在途调用，再停止 Context 并等待 PID 退出。 |
| `api.onDispose(cleanup)` | 在扩展停止时执行额外的清理函数，支持异步清理。通过 `api.tools.register` 和 `api.events.on` 登记的资源自动注销。 |

按 DL-196，主角色可先用 `app_roles_list` 查询普通角色编号，再声明 `scope: "selected_roles", roleIds: ["<roleId>"]`。名单必填，元素为去除首尾空白后的非空字符串，按首次出现顺序去重。加载时只读取声明，缺失或已删的角色 ID 可保留。空名单仅主角色可用。工具目录和调用派发均按当前版本名单匹配实际调用者，主角色验收时处理器收到其自身的 `context.roleId`。

每次注册都分配进程内递增的代次。宿主按本次授权的代次派发，处理器执行前核对活动代次。同名工具注销再注册后，旧代次调用返回 `EXTENSION_UNAVAILABLE`。

桌面接收扩展快照时，将缺失或为 `null` 的 `tools`、`ui` 视为空列表。故障求助保留扩展原始诊断首行（最多 240 字符）。同一目标窗口和扩展按版本、状态、完整错误码与完整诊断识别待确认提交。断流保留提交号，同一故障可重试。快照确认故障变化、恢复、换版或移除后，旧提交号失效。

按 DL-199，`app_extension_publish_work` 与 `app_extension_upsert` 提示主角色可按人设和当下意图，自行决定是否通过 `app_role_chat_start` 向相关角色征求新扩展反馈。发布本身不发起往来。

同一扩展的管理操作串行。候选握手成功后切换工具与事件注册，旧进程只排空已派发工作。新版语法或初始化失败保持旧版可用，管理工具回执提供错误码、版本及诊断。新调用遇到停用、删除、已撤销的工具或已被移出名单的调用者时得到 `EXTENSION_UNAVAILABLE`。初始化默认限时 10 秒，工具与事件单次调用默认限时 15 秒。运行中崩溃或超时置为 `failed`，关闭时清理超过 2 秒的进程由父进程强制回收。启动时仅恢复上次启用的扩展。

| HTTP 接口 | 对应主角色管理工具 |
| --- | --- |
| `GET /v1/extensions`、`GET /v1/extensions/:extId` | `app_extensions_list`、`app_extension_get` |
| `POST /v1/extensions/:extId/enable`、`disable`、`reload`（同一路径前缀） | `app_extension_toggle({extId, action})` |
| `DELETE /v1/extensions/:extId` | `app_extension_delete({extId})` |

桌面订阅独立的 `GET /v1/extension-events`（SSE）。连接及重连首先收到 `snapshot`，内容为各扩展的标识、版本、状态、UI 声明、工具摘要和最近错误。HTTP 查询与 SSE 使用相同的工具摘要 `{name, scope, roleIds?}`。桌面按当前角色名展示范围，缺失的角色显示原始 ID。激活、停用、删除、失败及活动版本注册或注销工具时更新快照。当前活动版本的 `api.notify` 产生 `notice`（`extId`、`version`、`message`），候选版本的初始化通知在版本切换成功后投递。该流独立于角色、对话窗口和输入客户端。

桌面父页通过 `POST /v1/extensions/:extId/ui-action` 提交 `{version,action,payload}`，成功返回 `{data}`。请求体上限为 16 KiB 加 256 字节，payload 自身上限为 16 KiB。后端同步核对启用状态与活动版本，并将请求登记在当时捕获的子进程中。动作沿用 15 秒默认调用超时，停用或升级时已派发动作随原进程排空。已停用返回 409 `EXTENSION_UNAVAILABLE`，旧版本返回 409 `EXTENSION_VERSION_MISMATCH`，未知动作返回 404 `EXTENSION_UI_ACTION_NOT_FOUND`，处理器抛错返回 422 `EXTENSION_UI_ACTION_FAILED`。

**宿主共玩（DL-198）。** 仅 `page`、`widget`、`overlay` 可声明 `coplay: [{action,label}]`，最多 4 项，动作名沿用 `api.ui.onAction` 的规则，按钮文案为 1～32 字。静态资源继续使用 `asset`。HTTP 与 SSE 快照原样提供这些声明。宿主共玩 POST 额外发送 `{coplay:true, roleId, slot, file}`，按当前活动版本、槽位种类、文件和动作名核对。声明的处理器可返回 `{data,summary?}`。宿主将 `data` 送回当前子页，有非空字符串摘要才触发反应。普通 `ext:action` 保留原 JSON 返回值，即使包含摘要也只更新游戏。

同一扩展和角色共享从首击开始的五秒固定窗。等待动作结果或角色空闲期间，宿主继续合并次数及最近返回的动作与结果。统一调度领取时在同一事务创建 `autonomy_wakes` 与自主执行。停机、预算耗尽、进程替换、禁用或卸载会清除待发批次，恢复后不会补发。角色决定发言时由 `autonomy_share` 写入其默认窗口。主角色沿用分享 SSE；普通角色共玩的分享落库后，经扩展 SSE 的 `coplay-share` 送至同一跨页纸签。

扩展 SSE 首次连接从当前窗口游标开始。重连携带 `Last-Event-ID`，按各角色的游标补读断流期间已落库的共玩分享。桌面按 `messageId` 去重，先于角色列表到达的分享保留至角色可展示。

Pi 的 `nowadays-mod.mjs` 提供互动计数器的清单、入口和 HTML 示例。主角色的 `app_extension_upsert`、`app_extension_publish_work` 描述与 Pi 提示使用同一动作、回包和主题契约。

`GET /v1/extensions/:extId/ui/<相对文件>` 逐级核实活动版本目录及文件真实路径，只读取当前启用版本在 `manifest.ui` 明确列出的普通文件。可附 `?v=<版本>` 精确匹配。未声明、越界、链接、后端模块、私有清单及过期版本的资产请求均不可用。直接打开 HTTP 资源时响应带无脚本 CSP 沙箱。桌面协议和布局契约见[扩展槽位](./frontend-design-system.md#扩展槽位dl-188)。

### 3.6 受托管工程 MCP（DL-195）

后端在启动时以 MCP 命令 `nowadays-pi` 识别内置 Pi，包括老库中改过显示名的同命令资源。首次引入时自动创建全局资源并为唯一主角色席位启用绑定。升级时沿用已有资源 ID、全局开关及席位的关闭或解绑选择。历史同命令项按创建顺序合并，绑定冲突保留停用，原任务续用关系随资源迁移。用户删除该资源后，重启会补回停用的目录项。资源接口通过 `adminSeatOnly` 标记内置 Pi。桌面「工程」分区管理其开关，普通 MCP 目录隐藏该资源。角色绑定、工具发现和实际调用均按持久化主角色席位校验。普通角色可使用主角色已发布的公开扩展。启停与原任务续用沿用 DL-59、DL-71。

开发态从 `apps/pi-mcp` 启动独立 stdio 服务。Windows 桌面包从 `resources/pi-mcp` 加载入口、工程扩展和子包自己的运行依赖，使用 `resources/node-runtime/node.exe`。开发和打包布局均可用 `NOWADAYS_PI_MCP_ROOT` 显式覆盖子包根目录。主角色获得 `pi_task_start({extId,prompt})` 和以 `jobId` 操作的 `pi_task_status`、`pi_task_result`、`pi_task_cancel`。启动立即返回，角色可继续回复用户。宿主在角色业务库登记 job、父任务、原窗口、发起源、扩展、草稿目录、起止时间和终态摘要。主角色可按 jobId 读取已归档的结果。人工暂停或熔断优先于工程等待，期间回执持久化排队，原任务明确恢复后领取。角色迁移携带工程事实和回执，省略源机草稿路径。在途工程归为中断、结果未知，缺少待交付回执的工程等待归为迁移中断。

每个任务使用独立的 Pi SDK 会话和临时配置目录。子包 [src/extensions](../../apps/pi-mcp/src/extensions/) 中的 `.mjs` 文件默认导出 Pi 扩展工厂，由新会话按文件名顺序加载。内置 `nowadays-mod.mjs` 在 `before_agent_start` 注入工作区、Cordis 工具登记和 UI 槽位契约。工程设置 `allowShell` 默认为 false，变更仅影响新工程，同一父任务后续新建的工程也立即使用最新值。两态本机工具均包含限制在当前草稿目录的 `read`、`write`、`edit` 及受控 `draft_test`；文件操作解析目标和父目录的真实路径。开启时额外提供平台 Shell（Windows 为 `powershell`，其他平台为 `bash`），拥有当前账户权限，可访问个人文件、修改文件和运行系统命令。`draft_test` 仅接受工程内普通且现存的相对 `.js` / `.mjs` 文件，以 Node `--permission` 限制读写路径和子进程，使用清洁环境，限时 30 秒、标准输出与错误合计 64 KiB。这是工程级限制，不是操作系统强沙箱。租约共享的 Skill 和常规外部 MCP 工具另按下述契约提供，不属于本机工具集合。Windows 工作者在执行 SDK 前加入由 MCP 服务独占句柄的 Job Object，回收覆盖派生的本地测试进程。

工程模型由独立的有序消耗池提供。默认优先级降级，也可按任务轮询。Pi 已启用、主角色已绑定且至少有一项结构有效时才挂载工程工具。维护和冷却仅影响派发，全员暂不可用时启动返回 `PI_ENGINEERING_POOL_EXHAUSTED`。每个 job 固定服务与型号，首次上游故障结束该工程。仅当上游故障无错误状态码（如断连），或状态码为 401、402、403、429 或 ≥500 时，成员才在内存中冷却 180 秒。429 的有效较长 `Retry-After` 可延长等待。400、422 等请求错误只结束当前工程。维护结束立即重新参选。已有工程按未结束父任务的登记取证续用。

同一 Google 服务的裸型号、`models/` 与 `publishers/google/models/` 别名共用成员身份、轮询位置和冷却。原任务续用和删除保护以本机派发记录为准，迁入的工程保留源机的模型 ID、型号与回执供查询。Vertex 自动入口按探测时实际凭据的 SHA-256 摘要匹配；原地轮换环境变量或凭据文件后须重新验证入口。OAuth 换令牌和生成请求按相同 HTTP 状态规则冷却，本地凭据错误只结束当次工程。服务账号令牌端点使用 HTTPS，回环地址可使用 HTTP。

宿主签发 15 分钟的回环租约。OpenAI Chat、Responses 使用 Bearer，Anthropic Messages 使用 `x-api-key`，Gemini 与 Vertex 使用 `x-goog-api-key`。宿主按已签型号核对线路，每次取得调用权后解析当前配置、已验证的 Vertex 入口与凭据，向 worker 提供回环地址和租约。每次出站以独立 `pi:` 调用号进入 DL-183 账本，对话委派计入 dialogue，自主委派计入 autonomy。取消、停机和到期撤销租约。

代理在派发前拒绝顶层备用路由字段及 SDK 白名单外的 Anthropic beta。非流式回执按协议校验生成结果或完成标记。单个 SSE 事件上限为 4 MiB，非流式回包上限为 16 MiB，超限结束调用并保留已解析的用量。

共享工具和释放接口只接受同一租约的 Bearer 头。主角色绑定与全局资源表决定新任务的目录，父任务持久化的资源续用关系决定停用后的原链可见性。启动元数据中的 Skill 只有稳定 ID、名称和摘要。Pi 的 `skill_read` 经宿主读取当前磁盘上的 `SKILL.md` 或包内相对路径文件；`skill_run` 仅接受包内 `.js`、`.mjs`，由宿主用 Node 权限模式执行，允许读取包和工程工作区，写入范围为工程工作区。脚本进程使用单独的环境变量白名单。单次参考文件读取上限为 1 MiB，脚本的标准输出和标准错误各保留最多 1,000,000 字节。

共享工具端点均为 `POST /v1/internal/tool-proxy/` 下的子路由。 `skill/read` 接受 `{id,path?}`，`skill/run` 接受 `{id,path,args?}`，`list` 返回本工程可用的外部 MCP 工具，`call` 接受 `{name,arguments}`。工具名由资源 ID 和原始工具名共同生成，宿主按工程目录反查，并使用当前资源配置建立 stdio 连接。宿主按对端声明的服务名和工具名排除已知的托管 Pi、平台管理与发布、内置命令和桌面接管项。DL-71 采用单用户自管边界，外部 MCP 的实际行为由安装并启用它的用户负责。工具描述、schema 和回执均检查环境值以及启动参数中的凭据，上游错误返回稳定错误码。

宿主读完请求体、取得上游连接后都会复核租约。派发前撤销返回 HTTP 403 与 `PI_LEASE_REVOKED`。自主工程的外部 MCP 调用与 Skill 脚本先预留工具额度，派发时提交，未派发时退回。已派发调用的晚到结果仍记入原任务，失联记为 `unknown`。[共享工具集成测试](../../apps/backend/tests/integration/pi-shared-tools.test.ts)

Pi 在 `<app-root>/extensions-work/0-pi-jobs/<jobId>/<extId>/` 下独立开发。主角色核对结果后调用 `app_extension_publish_work({jobId})`。宿主从当前角色库解析工程的目标扩展；调用时可同时传入 `extId` 核对归属。手工草稿继续通过 `app_extension_publish_work({extId})` 从 `<app-root>/extensions-work/<extId>/` 发布。宿主逐级核对真实路径并拒绝 junction，读取 `manifest.json`、`.mjs` 源码与 `ui/` 资产。发布复用 §3.5 的版本暂存与候选进程握手，成功后同一任务的下一轮即可发现新工具。普通角色可调用全员工具，以及按 DL-196 分发给自己的工具。离线验收范围见[当前状态](../STATUS.md)。

桌面壳为自启后端生成 32 字节随机会话令牌，主框架通过 preload 取得请求头，宿主代理签发流与资产请求。常规 `/v1/*` 统一校验 `X-Nowadays-Host-Token`，裸跑可通过 `NOWADAYS_HOST_TOKEN` 启用。内部代理沿用独立 Bearer 租约。CORS 接受回环 HTTP、桌面本地协议和无 Origin 请求。扩展动作在原进程结算，活动进程已替换或卸载时返回版本失配。

后台工程接口：

| 接口 | 行为 |
| --- | --- |
| `GET /v1/engineering/settings` | 读取总开关、`allowShell`、模式、成员顺序、各项状态与就绪情况。 |
| `PUT /v1/engineering/settings` | 部分更新，包括 `allowShell`。显式开启工程时幂等启用主角色绑定，单独保存池、模式或 Shell 权限保留原有绑定。 |
| `GET /v1/engineering/jobs` | 返回当前运行中的工程摘要，含 jobId、roleId、extId、短标题、状态和 startedAt。 |
| `GET /v1/engineering/events` | 独立 SSE 连接。连接和重连立即收到 `snapshot`，每次登记或终态提交后推送最新运行列表，无需输入通道的 clientId。 |
| `POST /v1/engineering/jobs/:jobId/cancel` | 撤销该工程租约并请求 Pi 终止对应工作进程。原任务仍可领取取消回执及其他工程结果。 |

## 4. 验收场景与可运行命令

> 下列命令均区分验证边界；离线/本地假端点通过**不能**外推为真实外部模型/ComfyUI/TTS 联调或正式打包通过。

### 4.1 后端单元测试与类型检查（离线模型与本地工具样例，Node 24）

```bash
cd apps/backend
npm run typecheck
npm test
```

本专项核心定向测试文件：

```bash
cd apps/backend
npx -y node@24 --import tsx --test tests/integration/role-activity.test.ts tests/integration/resource-management.test.ts tests/integration/role-deletion.test.ts tests/integration/workflow-simplification-fixes.test.ts tests/integration/workflow-recovery-fixes.test.ts tests/unit/model-maintenance.test.ts tests/integration/appearance-management.test.ts tests/integration/voice-tts.test.ts
```

关键覆盖场景：`role-activity`（三态、`guardRole`/`guardAll`、`resume` 不清待办不重置额度、`reconcileStartup`）；`resource-management`（引用报告、MCP/Skill 占用与仅开关放行、全表替换版本冲突、凭据换站拦截、两阶段删除故障注入与幂等重试）；`role-deletion`（双路径角色删除与最后角色 409）；`workflow-simplification-fixes` / `workflow-recovery-fixes` / `model-maintenance`（依赖范围影响与只暂停相关角色、仅旧任务依赖暂缓、连续维护、删除超时唤醒与任务结束整理恢复）；`appearance-management` / `voice-tts`（服饰与语音启停守卫）。

### 4.2 后端离线交付验收脚本（离线假服务）

```bash
cd apps/backend
npx -y node@24 scripts/verify/accept-offline.mjs
```

### 4.3 桌面端静态检查、构建与单测（Node 24）

```bash
cd apps/desktop/renderer
npm run check
npm test
npm run build

cd ..
npx -y node@24 --test tests/unit/*.test.cjs
```

本专项核心前端单测包括 `apps/desktop/renderer/tests/` 下的 `binding-merge.test.ts`、`model-cache.test.ts`、`model-picker.test.ts`、`image-config.test.ts`、`voice-config.test.ts`、`appearance-import.test.ts`、`outfit-display.test.ts`。

### 4.4 本机真实后端 HTTP + Electron 全链路检查（离线模型桩 / 本地假 HTTP 端点）

```bash
npx -y node@24 apps/desktop/tests/e2e/workflow-real-backend-chain.e2e.cjs
npx -y node@24 apps/desktop/tests/e2e/settings-sheet-focus.e2e.cjs
npx -y node@24 apps/desktop/tests/e2e/settings-media-sheet.e2e.cjs
npx -y node@24 apps/desktop/tests/e2e/settings-v6-behavior.e2e.cjs
```

- **纸笺与分区交接**。按 v6 §7.3、§7.9，点击参数片段后关闭纸笺，焦点回到该行的「编辑」。切分区或切换既有角色后聚焦新分区标题。切角色先处理当前纸笺的 T9，再判断是否有设定草稿需要 T37。新建角色成功后收起纸笺和双层压暗，焦点回到底栏选择器。跨页打开设置时聚焦目标分区标题。对应检查见 [settings-sheet-focus.e2e.cjs](../../apps/desktop/tests/e2e/settings-sheet-focus.e2e.cjs)。
- **媒体及展示回归**。语音按角色和服务保存会话草稿，后端保存当前一份。系统减少动效、昼夜与三种视口、停止卡对比度、仅对摘要确有变化的行播放保存反馈等检查见 [媒体纸笺回归](../../apps/desktop/tests/e2e/settings-media-sheet.e2e.cjs)与 [v6 行为验收](../../apps/desktop/tests/e2e/settings-v6-behavior.e2e.cjs)。

- **已同步工具与并发绑定回写**：E2E 脚本已通过 [electron-executable.cjs](../../apps/desktop/tests/helpers/electron-executable.cjs) 优先解析 `apps/desktop/node_modules/electron`（`292-R08` 与 `292-R06` 已在 [283 §29](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) 复核通过）；`292-R09` 模拟服务与 CDP 有界超时清理已按 [292 §10](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#10-283-29292-r09doc-r01-邻接契约与-settings-review-fixes-checkcjs-收口自验) 完成补修自验（待独立复核）。[settings-review-fixes.e2e.cjs](../../apps/desktop/tests/e2e/settings-review-fixes.e2e.cjs) 已同步更新以分别覆盖非重叠 `mergeBindingDrafts` 自动合并、同用途重叠冲突阻断 + `503` 重读恢复、以及删除取消焦点回退与删后刷新重试；同时修复 [Settings.tsx](../../apps/desktop/renderer/src/pages/Settings.tsx#L531) 在 `409` 自动合并重提成功后改调 `mergeRefreshedBindings` 同步跨标签页草稿状态，避免另一页草稿滞留假脏标记（自验通过，待独立复核）。

### 4.5 真实外部服务与打包范围（当前未纳入离线自动验收）

- 真实 OpenAI / Anthropic / ComfyUI / TTS 外部服务联调、`278 §4` 首次配置交互恢复真人端到端验收，以及桌面安装包（`package:win`）打包后实机运行行为，均需另行联调并记录实测证据。

---

## 5. 源文档、实现位置、状态分级与独立复核

### 5.1 已确认且已独立复验（离线 / 本机假端点范围）

| 子专题 | 源实施文档 | 独立复核与关闭依据 |
| --- | --- | --- |
| 角色活动三态与写入守卫 | [252](../archive/04-role-settings-and-media/252-role-config-settings-development-plan.md) · [254](../archive/04-role-settings-and-media/254-role-activity-config-guard.md) | [255 独立复核（RA-R01～R05 关闭）](../archive/04-role-settings-and-media/255-role-activity-independent-review.md) · [259](../archive/04-role-settings-and-media/259-role-activity-resource-review-fixes.md) |
| 全局资源管理与两阶段删除 | [257](../archive/04-role-settings-and-media/257-resource-management.md) | [258 独立复核（RP-R01～R07 关闭）](../archive/04-role-settings-and-media/258-resource-management-independent-review.md) · [259](../archive/04-role-settings-and-media/259-role-activity-resource-review-fixes.md) |
| 外观运维与角色删除 | [262](../archive/04-role-settings-and-media/262-role-appearance-deletion-history.md) | [263 独立复核（AD-R01～R06 关闭）](../archive/04-role-settings-and-media/263-role-appearance-deletion-independent-review.md) |
| 设置页前端基础交互与合并 | [278 §1～§3](../archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md#1-角色配置在原页面完成) · [280](../archive/06-workflow-simplification/280-278-progress-role-workspace-dialogue-receipt.md) · [281](../archive/06-workflow-simplification/281-278-progress-guarded-panels.md) · [282](../archive/06-workflow-simplification/282-278-progress-model-impact-resource-detail.md) | [266 设置前端独立复核（CF-R01～R05 关闭）](../archive/04-role-settings-and-media/266-role-settings-frontend-independent-review.md#267-补修-cf-r05-独立复验) |
| 同页删除暂停、模型依赖维护与背景整理恢复 | [292 §1～§2](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#1-角色删除同页暂停278-14) | [283 §1～§26（R01～R09、292-R01～R04 已闭环至 306）](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md) |

### 5.2 来源冲突 / 规范滞后（实现先行，待统一修订正文）

1. **MCP / Skill 全局单独停用（`161 DL-148` vs `278 §3` / `282 §2`）**：`161` 正文当前仍保留「被角色开启或未结束任务链占用期间拒绝全局关闭」；实现（[resource-service.ts](../../apps/backend/src/application/resources/resource-service.ts#L260-L275)）已先行改为仅切换 `enabled` 时直接放行（`canDisable: true`）、新任务立即阻止、原任务链继续至结束；[161 DL-148 注记](../161-digital-life-direction-decisions.md#dl-148-配置修改直接删除与运行限制) 已挂出待统一修订。
2. **资源路由守卫分类文件残留**：[config-writes.ts](../../apps/backend/src/http/config-writes.ts#L40-L43) 的 `RESOURCE_CONFIG_WRITES` 与 [write-guard.ts](../../apps/backend/src/http/write-guard.ts#L49-L65) 的 `resourceWrite()` 仍保留于源码树中，但 [routes.ts](../../apps/backend/src/http/routes.ts#L103-L107) 已将 `PATCH/DELETE /v1/resources/:resourceId` 改由路由与服务层按 `maintenancePlan` 及 `references().canDelete` 分级协调（仅维护参数变更暂停实际依赖角色，删除无需全局无依赖角色停机）。

### 5.3 已补修待独立复核与未闭环项（见 `STATUS.md`、`283 §27` 与 `292 §8`）

- **`292-R05`（已通过 `283 §28` 独立复核）**：[ImagePanel.tsx](../../apps/desktop/renderer/src/components/image/ImagePanel.tsx#L308-L354) 的 `save()` 先校本地服务启用态，并在发起 `guardWrite` 停机前重读 `/v1/image-services` 确认服务仍存在且 `enabled === true`；停用时直接报错 `IMAGE_SERVICE_DISABLED`（见 [283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)）。
- **`292-R06`（原跨页与在途编辑场景均已独立复验）**：[ImagePanel.tsx](../../apps/desktop/renderer/src/components/image/ImagePanel.tsx#L149-L505) 与 [imageServiceSnapshotKey](../../apps/desktop/renderer/src/image-config.ts#L195-L210) 为 `probe`/`preview` 绑定 `{ serviceId, snapshotKey }`，跨页失效后拒收晚到响应；针对 `283 §28` 指出的在途编辑导致按钮长期锁死于「正在出图…」，[292 §9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#9-283-28-补修复核跟进与文档勘误自验292-r06-在途编辑292-r08-干净隔离环境与-doc-r01r04) 新增 `invalidateProbe`／`invalidatePreview`（`#L149-L165`、`#L295-L306`、`#L606-L618`）同步重置忙态按钮并丢弃旧响应，复核结论见 [状态页](../STATUS.md)。
- **`292-R07`（已通过 `283 §28` 独立复核）**：[scene-image-settings.ts](../../apps/backend/src/application/media/scene-image-settings.ts#L155-L195) 的 `preview()` 对非空 `outfitId` 通过 `AppearanceStore.getOutfit(outfitId)` 核验当前角色下未删除服饰，否则在生图前抛出 `404 OUTFIT_NOT_FOUND`（见 [283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)）。
- **`292-R08`（独立隔离 E2E 通过）**：[electron-executable.cjs](../../apps/desktop/tests/helpers/electron-executable.cjs) 按环境变量 → `apps/desktop/node_modules/electron` → 开发机根目录兜底解析，新增 `resolveElectronExecutableInfo` 暴露实际解析来源（`electronExecutableSource`、`electronExecutableResolvedFromDesktop`）并支持 `NOWADAYS_ALLOW_ROOT_ELECTRON_FALLBACK=0` 禁止回落根目录；已在仅含 `apps/desktop/node_modules` 的无根目录依赖隔离副本完成完整构建与全链路 E2E 自验（见 [292 §9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#9-283-28-补修复核跟进与文档勘误自验292-r06-在途编辑292-r08-干净隔离环境与-doc-r01r04)）。
- **已更新历史测试与本轮待复核项**：[settings-review-fixes.e2e.cjs](../../apps/desktop/tests/e2e/settings-review-fixes.e2e.cjs) 已同步 `mergeBindingDrafts` 非重叠自动合并与同用途重叠冲突恢复，`292-R09` 有界等待清理及 [Settings.tsx](../../apps/desktop/renderer/src/pages/Settings.tsx#L531) 自动合并草稿回写同步均已完成自验（见 [292 §10](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#10-283-29292-r09doc-r01-邻接契约与-settings-review-fixes-checkcjs-收口自验) 与 [STATUS.md](../STATUS.md)），待独立复核。
- **待实测/复核项**：`278 §4` 首次配置交互恢复链（[279 §3](../archive/06-workflow-simplification/279-workflow-simplification-two-pass-review.md#3-第三轮端到端复核)）尚未完成真实后端完整复验；真实外部模型/ComfyUI/TTS 服务与桌面端实际打包行为待联调留证。

### 5.4 核心实现索引

- **后端路由、校验与守卫**：[config-writes.ts](../../apps/backend/src/http/config-writes.ts) · [write-guard.ts](../../apps/backend/src/http/write-guard.ts) · [role-activity-routes.ts](../../apps/backend/src/http/role-activity-routes.ts) · [routes.ts](../../apps/backend/src/http/routes.ts) · [router.ts](../../apps/backend/src/http/router.ts) · [schemas.ts](../../apps/backend/src/http/schemas.ts) · [voice-service-routes.ts](../../apps/backend/src/http/voice-service-routes.ts) · [image-service-routes.ts](../../apps/backend/src/http/image-service-routes.ts) · [voice-routes.ts](../../apps/backend/src/http/voice-routes.ts) · [appearance-routes.ts](../../apps/backend/src/http/appearance-routes.ts) · [commands.ts](../../apps/backend/src/cli/commands.ts)
- **后端领域与协调服务**：[role-activity.ts](../../apps/backend/src/domain/role-activity.ts) · [errors.ts](../../apps/backend/src/domain/errors.ts) · [role-activity-service.ts](../../apps/backend/src/application/role/role-activity-service.ts) · [role-deletion-service.ts](../../apps/backend/src/application/role/role-deletion-service.ts) · [role-service.ts](../../apps/backend/src/application/role/role-service.ts) · [resource-service.ts](../../apps/backend/src/application/resources/resource-service.ts) · [global-voice-service.ts](../../apps/backend/src/application/media/global-voice-service.ts) · [conversation-service.ts](../../apps/backend/src/application/conversation/conversation-service.ts) · [appearance-service.ts](../../apps/backend/src/application/media/appearance-service.ts) · [app.ts](../../apps/backend/src/bootstrap/app.ts)
- **桌面设置端**：[Settings.tsx](../../apps/desktop/renderer/src/pages/Settings.tsx) · [binding-merge.ts](../../apps/desktop/renderer/src/components/model/binding-merge.ts) · [use-model-probe.ts](../../apps/desktop/renderer/src/components/model/use-model-probe.ts) · [ImagePanel.tsx](../../apps/desktop/renderer/src/components/image/ImagePanel.tsx) · [VoicePanel.tsx](../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx) · [VoiceServiceEditor.tsx](../../apps/desktop/renderer/src/components/voice/VoiceServiceEditor.tsx) · [VoiceProbeView.tsx](../../apps/desktop/renderer/src/components/voice/VoiceProbeView.tsx) · [use-voice-probe.ts](../../apps/desktop/renderer/src/components/voice/use-voice-probe.ts) · [voice-cache.ts](../../apps/desktop/renderer/src/components/voice/voice-cache.ts) · [AppearancePanel.tsx](../../apps/desktop/renderer/src/components/appearance/AppearancePanel.tsx)
