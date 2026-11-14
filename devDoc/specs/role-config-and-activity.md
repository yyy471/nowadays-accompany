# 角色配置、全局资源与活动守卫规范

> **状态**：现行规范 · **适用范围**：`backend/src/{http,application,domain,bootstrap,cli}` 与 `desktop/desk-preview/renderer/src/{pages/Settings.tsx,components/*}`  
> **覆盖关系**：整合 [252](../archive/04-role-settings-and-media/252-role-config-settings-development-plan.md)、[254](../archive/04-role-settings-and-media/254-role-activity-config-guard.md)、[257](../archive/04-role-settings-and-media/257-resource-management.md)、[262](../archive/04-role-settings-and-media/262-role-appearance-deletion-history.md)、[278 §1～§3 与 §5 配置守卫部分](../archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md#1-角色配置在原页面完成)、[280](../archive/06-workflow-simplification/280-278-progress-role-workspace-dialogue-receipt.md)、[281](../archive/06-workflow-simplification/281-278-progress-guarded-panels.md)、[282](../archive/06-workflow-simplification/282-278-progress-model-impact-resource-detail.md) 及 [292 §1～§2、§6～§7](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#1-角色删除同页暂停278-14) 的现行配置契约与操作链路规则；历史实施方案保留原文仅作归档。

---

## 1. 适用范围、上游决定与依赖规范

### 1.1 适用范围

- **角色活动与配置写入守卫**：角色三态（`active` / `stopping` / `stopped`）、停启控制、写保护租约与读体二次校验、重启收敛与恢复重调度。
- **角色配置读写与直接删除**：人设档案与修订号、自主额度、资源全表绑定与乐观锁合并、外观服饰/差分运维与回退、角色语音/场景生图配置写入，以及角色带历史选项删除（`keepHistory`）。
- **全局资源与生图服务维护**：全局模型 / MCP / Skill 资源目录的创建、更新、凭据只写与换站重验、MCP 环境变量脱敏、占用报告（`references`）、依赖影响范围（`impact`）、模型维护窗口协调（`maintenance`）与两阶段删除；以及全局生图服务写删的全局守卫。
- **桌面设置页与后台协调**：设置页（[Settings.tsx](../../desktop/desk-preview/renderer/src/pages/Settings.tsx)）的同页暂停保存/删除、并发绑定自动合并，以及句段标注/过场图规划的维护等待协调。
- **不包含范围**（归入其他现行规范）：
  - 前端设计语言、字体/间距/颜色/动效令牌与 `ui/` 组件约定：统一见 [前端设计规范](frontend-design-system.md)。
  - 对话演出/输入防抖/SSE/过场图生成流程、ComfyUI 与 TTS 具体服务适配与推理协议、角色存储/记忆整理/自主任务调度/首次配置引导（`278 §4`）：分别见 [对话演出与过场图规范](conversation-performance-and-scene-images.md)、[TTS 与生图服务接入规范](tts-and-image-services.md) 与 [存储、记忆与自主执行规范](storage-memory-and-autonomy.md)。

### 1.2 上游产品决定（`161 DL-xx`）

| 决定 | 约束摘要 | 落地与偏差说明 |
| --- | --- | --- |
| [DL-71](../161-digital-life-direction-decisions.md#dl-71-资源关闭前台立即关闭既有任务链继续至结束) · [DL-72](../161-digital-life-direction-decisions.md#dl-72-任务链边界按具体目标组织由角色判断结束) · [DL-73](../161-digital-life-direction-decisions.md#dl-73-任务恢复持久保留原任务链的资源延续关系) | 资源关闭对前台与新任务立即生效，已在执行的原任务链延续使用至角色判定目标结束或终止，并跨重启持久保留延续关系；不包装额外授权审批 | 对应 `ROLE_BINDING` / `TASK_CHAIN` 占用与恢复延续 |
| [DL-118](../161-digital-life-direction-decisions.md#dl-118-首批模型接入openai-与-anthropic-协议获取列表后选择模型) · [DL-119](../161-digital-life-direction-decisions.md#dl-119-模型配置手动填写列表失败保留与主动测试连接) · [DL-120](../161-digital-life-direction-decisions.md#dl-120-测试连接行为简短实际请求独立于角色对话与自主额度) | 模型支持列表探测、手动填写与独立连接测试（不占对话与自主额度） | `POST /v1/model-services/*` 与 `/v1/resources/:id/{models,model-test}` |
| [DL-121](../161-digital-life-direction-decisions.md#dl-121-本地客户端通信http-api-与-ssecli-和桌面共用入口) · [DL-124](../161-digital-life-direction-decisions.md#dl-124-记忆整理模型默认继承对话模型支持角色单独绑定) | CLI 与桌面共用本地 HTTP API；记忆模型未单独绑定时继承对话模型 | `impact()` 与运行时使用同一套模型解析规则 |
| [DL-147](../161-digital-life-direction-decisions.md#dl-147-设置页编辑角色与当前陪伴角色分离) | 设置页选中编辑对象与当前陪伴角色分离；保存、导入、试听结果归属发起时的 `roleId` | 桌面前端按调用时闭包 `roleId` 与请求令牌结算 |
| [DL-148](../161-digital-life-direction-decisions.md#dl-148-配置修改直接删除与运行限制) | 改删角色前由后端确认已停止；「已请求停止」与「已停止」分离且以后端为准；模型维护按具体服务只暂停实际依赖目标；删角色由用户选保留或清理记忆与对话；恢复保留待办与自主额度 | **规范文本滞后注记**：`161` 正文仍写着「MCP/Skill 被占用时后端拒绝全局关闭」，实现已按 `278 §3` / `282 §2` 先行放行全局单独停用（`canDisable: true`），待统一修订 `161` 正文 |
| [DL-149](../161-digital-life-direction-decisions.md#dl-149-角色语音只保留当前一份配置) | 每角色只保留一份语音配置；停用保留配置，新配置覆盖旧配置 | `PUT /v1/roles/:roleId/voice` 与 `/voice/enabled` |
| [DL-151](../161-digital-life-direction-decisions.md#dl-151-删除不做归档) | 删除角色、外观或资源直接执行不做归档；受管外观副本按保留历史引用按需留存或清理；用户源目录始终保留 | 软删除服饰 + 无历史引用素材清理 + `role_deletions` / `resource_deletions` |

### 1.3 依赖规范

- [持续决策记录（161）](../161-digital-life-direction-decisions.md)
- [前端设计规范](frontend-design-system.md)
- [后端使用与运行说明](../../backend/README.md)
- [当前状态看板（STATUS）](../STATUS.md)

---

## 2. 正常入口、输入输出与数据归属

### 2.1 角色活动状态入口（HTTP 与 CLI 共用）

| 操作 | HTTP 方法与路径 | CLI 子命令 | 关键返回字段与说明 |
| --- | --- | --- | --- |
| 列出全部角色活动状态 | `GET /v1/activities` | `activity list` | `{ items: RoleActivityView[] }` |
| 查询单角色活动状态 | `GET /v1/roles/:roleId/activity` | `activity get --role <id>` | `{ activity: RoleActivityView }`：`roleId`、`state`（`active \| stopping \| stopped`）、`requestedAt`、`confirmedAt`、`boundaryExecutionId`、`updatedAt`、`initStatus`、`running`；无持久化记录时视 `state: "active"`、`updatedAt: null` |
| 请求停止角色活动 | `POST /v1/roles/:roleId/activity/stop` | `activity stop --role <id>` | `{ activity: RoleActivityView, confirmed: boolean }`；无在途执行时同步确认 `stopped` 并返回 `confirmed: true` |
| 恢复角色活动 | `POST /v1/roles/:roleId/activity/resume` | `activity resume --role <id>` | `{ activity: RoleActivityView }`；切回 `active` 并接回因停止暂缓的任务链与到期待办；若角色当前 `chat` 或 `memory` 模型正处维护窗口，拒绝返回 `409 RESOURCE_MAINTENANCE` |

### 2.2 受保护的配置写入接口与守卫分类

策略清单元头在 [config-writes.ts](../../backend/src/http/config-writes.ts)，实际路由守卫绑定在 [routes.ts](../../backend/src/http/routes.ts#L99-L108) 与 [write-guard.ts](../../backend/src/http/write-guard.ts)：

1. **角色级写入（`ROLE_CONFIG_WRITES`，共 15 个路由，经 `Router.setGuard` 自动包装 `roleWrite`）**：
   - **角色档案、删除与绑定**：
     - `DELETE /v1/roles/:roleId?keepHistory=0|1|true|false`：必填 `keepHistory`（缺省 `400 KEEP_HISTORY_REQUIRED`，非法 `400 INVALID_QUERY`）；返回 `{ roleId, keepHistory, filesRemoved }`。
     - `PATCH /v1/roles/:roleId/definition`（CLI：`role update`）：`{ displayName?, definition?: { text, payload? }, expectedRevision? }`（至少提供 `displayName` 或 `definition`）。
     - `PUT /v1/roles/:roleId/bindings`（CLI：`binding put`）：`{ bindings: Array<{ capability: "chat_model" \| "memory_model" \| "mcp" \| "skill", resourceId, modelName?, enabled? }>, expectedRevision? }`；返回 `{ items, revision }`。
   - **自主额度**：
     - `PUT /v1/roles/:roleId/autonomy/budget`：`{ unlimited: boolean, dailyLimit?: number }`（`dailyLimit` 为 `1..1_000_000` 整数）。
   - **语音与场景生图配置**：
     - `PUT /v1/roles/:roleId/voice`（JSON 或 `multipart/form-data` 含 `payload` 与 `file`）、`PUT /v1/roles/:roleId/voice/enabled`（`{ enabled }`）、`POST /v1/roles/:roleId/voice/reference`、`DELETE /v1/roles/:roleId/voice/references/:assetId`
     - `PUT /v1/roles/:roleId/scene-image`
   - **外观衣柜**：
     - `POST /v1/roles/:roleId/appearance/outfits`、`PATCH /v1/roles/:roleId/appearance/outfits/:outfitId`、`POST /v1/roles/:roleId/appearance/outfits/:outfitId/home`、`DELETE /v1/roles/:roleId/appearance/outfits/:outfitId`、`POST /v1/roles/:roleId/appearance/outfits/:outfitId/sprites`、`DELETE /v1/roles/:roleId/appearance/outfits/:outfitId/sprites/:assetId`

2. **全局生图服务写入（`GLOBAL_CONFIG_WRITES`，共 2 个路由，包装 `globalWrite`）**：
   - `PATCH /v1/image-services/:serviceId`、`DELETE /v1/image-services/:serviceId`：全局写锁 `guardAll` + 读体后复验 `assertAllStopped`，要求全部角色均已处于 `stopped`。

3. **全局资源维护与删除（`RESOURCE_CONFIG_WRITES`，[routes.ts](../../backend/src/http/routes.ts#L103-L107) 不再挂载旧 `resourceWrite`，改为处理器与服务层分级处理）**：
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
  - `GET /v1/image-services`、`POST /v1/image-services`、`POST /v1/image-services/probe`、`POST /v1/image-services/:serviceId/probe`
  - `GET /v1/roles/:roleId/scene-image`、`POST /v1/roles/:roleId/scene-image/probe`、`POST /v1/roles/:roleId/scene-image/preview`（注：`292-R07` 校验服饰属于当前角色且未删除，见第 5 节）。

### 2.4 数据归属与凭据脱敏规则

- **App 中心库（`AppStore`）**：持有角色索引与 `initStatus`、角色活动三态与停止边界记录（`role_activity`）、全局资源与模型测试摘要（`protocol` 或 `baseUrl` 变动时清除旧 `lastTest`）、全局生图服务、加密凭据引用、两阶段删除待清理队列（`resource_deletions`、`role_deletions`）。
- **角色独立库（`roles/<roleId>/`）**：持有角色设定与 `definitionRevision`、全表资源绑定（`role_bindings`）、自主额度与唤醒待办、对话与任务链/资源延续记录、外观软删除记录与素材引用、角色语音与场景生图配置；`keepHistory=1` 删除时只移出 App 索引与活动记录、保留角色目录，`keepHistory=0` 时加入 `role_deletions` 并删除 `roles/<roleId>` 目录，用户原始素材目录在任何情况下都不删除。
- **凭据只写、按需显隐与脱敏**：
  - `model` / `image-service` 常规创建、列表与详情视图均仅返回凭据状态不回显明文；模型资源详情支持在用户主动点击「显示」时通过 `POST /v1/resources/:resourceId/secret/reveal` 按需取回原文，默认仍以掩码文本形式编辑（未改则保留、清空则删除、改写则替换）；直填 `secret` 与 `config.credentialRef` 不可并存（`409 RESOURCE_CREDENTIAL_CONFLICT`）；更换 `protocol` 或站点（`baseUrl` origin 变更）而试图沿用旧密钥或未变更的 `credentialRef` 会被拒绝（`409 RESOURCE_CREDENTIAL_STALE`）。
  - `mcp` 资源 `config.env` 所有值统一脱敏返回 `***`；更新 `mcp` 时 `mergeRedactedMcpEnv` 将提交值仍为 `***` 的键保留库中原值。

### 2.5 关键 HTTP 状态码与错误码

| HTTP | 错误码 | 触发场景与处理 |
| --- | --- | --- |
| `400` | `KEEP_HISTORY_REQUIRED` / `INVALID_QUERY` | `DELETE /v1/roles/:roleId` 缺少 `keepHistory` 或取值非 `0 \| 1 \| true \| false`；`GET /v1/resources` 的 `kind` 非法 |
| `400` | `INVALID_RESOURCE_CONFIG` / `INVALID_BINDING` | 资源配置结构或绑定字段校验失败 |
| `404` | `ROLE_NOT_FOUND` / `RESOURCE_NOT_FOUND` / `IMAGE_SERVICE_NOT_FOUND` | 目标角色、全局资源或全局生图服务不存在 |
| `409` | `ROLE_NOT_STOPPED` | `ROLE_CONFIG_WRITES` 目标角色非 `stopped`（含读体后并发恢复） |
| `409` | `ROLES_NOT_STOPPED` | `GLOBAL_CONFIG_WRITES` 时仍有角色非 `stopped`，或模型维护暂停协调失败/未配置 `pauseRoles`（错误 `details.roles` / `details.maintenance.pausedRoleIds` 可带回状态） |
| `409` | `ROLE_ACTIVITY_CONFLICT` | 请求 `resume` 时持写租约冲突或状态不允许 |
| `409` | `ROLE_STOP_REQUESTED` / `ROLE_ACTIVITY_STOPPED` / `ROLE_BUSY` | 角色正请求停止/已停止时拒绝新执行；删除等待在途收尾（默认 `roleDeletionWaitMs = 15000`）超时返回 `ROLE_BUSY` |
| `409` | `RESOURCE_IN_USE` | `DELETE /v1/resources/:id` 存在启用绑定/`TASK_CHAIN`/`INFLIGHT_CALL`，或修改被占用的 MCP/Skill；`details.references` 返回具体占用项 |
| `409` | `RESOURCE_MAINTENANCE` | 并发对同一模型维护、维护期间向该资源新增启用绑定、维护后复查出现新增依赖角色，或恢复依赖维护中资源的已停止角色 |
| `409` | `RESOURCE_CREDENTIAL_CONFLICT` / `RESOURCE_CREDENTIAL_STALE` | 同时传入 `secret` 与 `credentialRef`；或换协议/换站点时仍沿用旧密钥/旧引用 |
| `409` | `BINDING_REVISION_CONFLICT` / `REVISION_CONFLICT` | `PUT /bindings` 传入的 `expectedRevision` 过期；或人设版本冲突 |
| `409` | `LAST_ROLE_REQUIRED` / `LAST_OUTFIT_REQUIRED` | 试图删除最后一个角色或角色最后一套服饰 |
| `409` | `IMAGE_SERVICE_DISABLED` | 角色生图保存引用已停用的生图服务 |

---

## 3. 状态变化、并发约束、前后端分工与失败恢复

### 3.1 角色活动三态与写入租约

1. **三态转移与边界**：
   - 新建角色默认通过 `markCreatedStopped` 置为 `stopped`，避免未配模型即处于活动态。
   - `active` -> `requestStop`：若 `activityRuntime.isRunning(roleId)` 为 `false` 则同步写入 `stopped`（`confirmed: true`）；若正在运行则先置 `stopping`，禁止新对话/自主唤醒与新节点，待运行节点走到可保存进度边界由 `confirmStop` 确认 `stopped`。
   - `resume`：仅把 `stopped` 切回 `active` 并调用 `resumeWork(roleId)` 接回停机前待办与暂停任务链，不清理待办、不重置自主额度；恢复前先过 `resourceService.assertResumeAllowed(roleId)` 检查，若当前解析的 `chat` 或 `memory` 模型正处维护窗口则拒绝（`409 RESOURCE_MAINTENANCE`）。
   - `reconcileStartup`（后端启动时）：清理历史运行状态并把无在途执行的 `stopping` 请求收敛为 `stopped`。
2. **并发写锁与读体后复验（[RoleActivityService](../../backend/src/application/role-activity-service.ts)、[write-guard.ts](../../backend/src/http/write-guard.ts)）**：
   - `guardRole` 按 `roleId` 维度的 `writeChains` 队列串行执行配置写入，并在持有 `roleLeases` 期间阻断并发 `resume`。
   - `guardAll` 持有 `globalLeases` 阻断全局写期间任一角色恢复或启动，覆盖 `GLOBAL_CONFIG_WRITES`。
   - 对带请求体的配置写入，通过 `setBodyReadHook` 在异步读取完整请求体后、进入处理器之前再次执行 `assertStopped` / `assertAllStopped`，防止读体间隙有其他调用恢复角色导致写入越权。

### 3.2 模型连接维护窗口与后台调用协调

仅修改 `model` 的连接参数或凭据（`protocol` / `baseUrl` / `credentialRef` / `secret`）时，[routes.ts](../../backend/src/http/routes.ts#L608-L695) 按下列顺序协调，其它无关角色继续运行：

1. **先预检再进窗口**：调用 `validateUpdate`（凭据冲突/换站旧密钥等可预判错误直接拒绝，不暂停任何角色）。
2. **计算影响与进入维护窗口**：调用 `maintenancePlan(resourceId, body)`；当 `connectionChanged` 为真时调用 `beginMaintenance(resourceId)`（同一 `resourceId` 禁止并发进入维护窗口）。
3. **只暂停实际 `chat` / `memory` 依赖的活跃角色并等在途调用**：
   - 对 `plan.pauseRoleIds`（非 `stopped` 且承担 `chat` 或 `memory`）调用 `pauseRoles`（[app.ts](../../backend/src/bootstrap/app.ts#L104-L135)，最长等 20s，仅把原本 `state === "active"` 且本次被停下的角色计入 `pausedRoleIds`；若等待前角色已 `stopping`，会等其停稳而不纳入前端一键恢复名单）。
   - 对 `plan.waitRoleIds`（目标服务上已有在途调用的所有角色，含已停止但后台记忆/标注/规划调用尚未结算的角色）调用 `waitForInflightIdle(resourceId, waitRoleIds, 20_000)`；超时抛出 409。
4. **写前复查防竞态**：若执行了暂停或等待，写库前重新计算 `maintenancePlan`，发现新接入依赖角色且不在本次 `pausedRoleIds` 中时拒绝返回 `409 RESOURCE_MAINTENANCE`。
5. **落库、失败带回与退出唤醒**：写入成功返回 `{ ...view, maintenance: { connectionChanged, pausedRoleIds } }`；若暂停后写入或等待失败，通过 `withMaintenanceDetails` 在错误 `details.maintenance.pausedRoleIds` 带回本次已暂停角色；`finally` 必调 `endMaintenance(resourceId)` 唤醒等待者并调用 `wakePendingWork()`。
6. **维护期间的四处并发护栏**：
   - `replaceBindings` 拒绝为处于 `maintenanceResources` 中的服务新增启用绑定；
   - `assertResumeAllowed` 拒绝恢复当前对话/记忆解析到维护中服务的已停止角色；
   - **仅旧任务链依赖（`TASK_CHAIN`）** 目标模型而不作当前角色默认绑定时，不暂停整个角色，改为在调度入口 `chatTargetUnderMaintenance` 按任务暂缓；
   - 句段标注与过场图规划通过 `isResourceUnderMaintenance` / `waitForMaintenanceEnd` / `claimModelCall`（在同一同步步骤完成维护态校验与在途计数登记）等待维护结束，醒来后重新解析已保存配置再发请求。

### 3.3 删除两阶段事务与启动恢复

- **全局资源删除（[ResourceService.remove](../../backend/src/application/resource-service.ts#L707-L748)）**：
  - `app.sqlite` 为决策提交源，所有就绪角色库为从属清理对象；通过 `runWithDecisionCommit` 先确保任一角色库读取/打开或清理准备失败时整笔回滚、原绑定完好。
  - 决策库提交资源删除与 `resource_deletions` 记录后若部分角色库绑定清理失败，删后读取 `listBindings` 会过滤 `listResourceDeletions()`，由后端启动清理或客户端重试同个 `DELETE` 幂等完成剩余清理。
- **角色删除（[RoleDeletionService](../../backend/src/application/role-deletion-service.ts)）**：
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
| 全局生图服务改删 | `globalWrite` 要求全部角色 `stopped` | `stopActiveRolesForGlobalWrite` 逐一停下全部非 `stopped` 角色后再提交，删后尝试逐一恢复本次暂停角色 |
| 对象隔离与过期丢弃 | 按请求 URL 的 `roleId` 落库与加锁 | 捕获操作发起时的 `roleId`、`roleToken` 与请求序列号 `seq`（`AppearancePanel` / `VoicePanel` / `ImagePanel` / `useModelProbe`），切换编辑角色或页签后旧异步响应不污染新页面草稿（`DL-147`） |
| 绑定并行并发合并 | `PUT /bindings` 校验 `expectedRevision`，过期抛 `409 BINDING_REVISION_CONFLICT` | 捕获冲突后自动拉取最新 `/bindings`，调用 [mergeBindingDrafts](../../desktop/desk-preview/renderer/src/components/model/binding-merge.js) 按范围字段级合并（`models` 按能力名、`ext` 按 `capability:resourceId`）；无互斥改动时带最新 `revision` 自动重提一次，有互斥冲突则清空 `bindingRevision`、保留草稿并提示重新读取确认 |

---

## 4. 验收场景与可运行命令

> 下列命令均区分验证边界；离线/本地假端点通过**不能**外推为真实外部模型/ComfyUI/TTS 联调或正式打包通过。

### 4.1 后端单元测试与类型检查（离线模型与本地工具样例，Node 24）

```bash
cd backend
npm run typecheck
npm test
```

本专项核心定向测试文件：

```bash
cd backend
npx -y node@24 --import tsx --test tests/p14-role-activity.test.ts tests/p15-resource-management.test.ts tests/p16-role-deletion.test.ts tests/p18-278-review-fixes.test.ts tests/p19-model-maintenance.test.ts tests/p6-appearance.test.ts tests/p8-voice.test.ts
```

关键覆盖场景：`p14`（三态、`guardRole`/`guardAll`、`resume` 不清待办不重置额度、`reconcileStartup`）；`p15`（引用报告、MCP/Skill 占用与仅开关放行、全表替换版本冲突、凭据换站拦截、两阶段删除故障注入与幂等重试）；`p16`（双路径角色删除与最后角色 409）；`p18`/`p19`（依赖范围影响与只暂停相关角色、仅旧任务依赖暂缓、连续维护、删除超时唤醒与任务结束整理恢复）；`p6`/`p8`（服饰与语音启停守卫）。

### 4.2 后端离线交付验收脚本（离线假服务）

```bash
cd backend
npx -y node@24 scripts/accept-offline.mjs
```

### 4.3 桌面端静态检查、构建与单测（Node 24）

```bash
cd desktop/desk-preview/renderer
npm run check
npm run build

cd ..
npx -y node@24 --test tests/*.test.cjs
```

本专项核心前端单测包括：`binding-merge.test.cjs`、`model-cache.test.cjs`、`model-picker.test.cjs`、`image-config.test.cjs`、`voice-config.test.cjs`、`appearance-import.test.cjs`、`outfit-display.test.cjs`、`environment.test.cjs`。

### 4.4 本机真实后端 HTTP + Electron 全链路检查（离线模型桩 / 本地假 HTTP 端点）

```bash
npx -y node@24 desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs
```

- **已同步工具与并发绑定回写**：E2E 脚本已通过 [electron-executable.cjs](../../desktop/desk-preview/tests/electron-executable.cjs) 优先解析 `desktop/desk-preview/node_modules/electron`（`292-R08` 与 `292-R06` 已在 [283 §29](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) 复核通过）；`292-R09` 模拟服务与 CDP 有界超时清理已按 [292 §10](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#10-283-29292-r09doc-r01-邻接契约与-settings-review-fixes-checkcjs-收口自验) 完成补修自验（待独立复核）。[settings-review-fixes-check.cjs](../../desktop/desk-preview/tests/settings-review-fixes-check.cjs) 已同步更新以分别覆盖非重叠 `mergeBindingDrafts` 自动合并、同用途重叠冲突阻断 + `503` 重读恢复、以及删除取消焦点回退与删后刷新重试；同时修复 [Settings.tsx](../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L531) 在 `409` 自动合并重提成功后改调 `mergeRefreshedBindings` 同步跨标签页草稿状态，避免另一页草稿滞留假脏标记（自验通过，待独立复核）。

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

1. **MCP / Skill 全局单独停用（`161 DL-148` vs `278 §3` / `282 §2`）**：`161` 正文当前仍保留「被角色开启或未结束任务链占用期间拒绝全局关闭」；实现（[resource-service.ts](../../backend/src/application/resource-service.ts#L260-L275)）已先行改为仅切换 `enabled` 时直接放行（`canDisable: true`）、新任务立即阻止、原任务链继续至结束；[161 DL-148 注记](../161-digital-life-direction-decisions.md#dl-148-配置修改直接删除与运行限制) 已挂出待统一修订。
2. **资源路由守卫分类文件残留**：[config-writes.ts](../../backend/src/http/config-writes.ts#L40-L43) 的 `RESOURCE_CONFIG_WRITES` 与 [write-guard.ts](../../backend/src/http/write-guard.ts#L49-L65) 的 `resourceWrite()` 仍保留于源码树中，但 [routes.ts](../../backend/src/http/routes.ts#L103-L107) 已将 `PATCH/DELETE /v1/resources/:resourceId` 改由路由与服务层按 `maintenancePlan` 及 `references().canDelete` 分级协调（仅维护参数变更暂停实际依赖角色，删除无需全局无依赖角色停机）。

### 5.3 已补修待独立复核与未闭环项（见 `STATUS.md`、`283 §27` 与 `292 §8`）

- **`292-R05`（已通过 `283 §28` 独立复核）**：[ImagePanel.tsx](../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx#L308-L354) 的 `save()` 先校本地服务启用态，并在发起 `guardWrite` 停机前重读 `/v1/image-services` 确认服务仍存在且 `enabled === true`；停用时直接报错 `IMAGE_SERVICE_DISABLED`（见 [283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)）。
- **`292-R06`（原跨页与在途编辑场景均已独立复验）**：[ImagePanel.tsx](../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx#L149-L505) 与 [imageServiceSnapshotKey](../../desktop/desk-preview/renderer/src/image-config.js#L195-L210) 为 `probe`/`preview` 绑定 `{ serviceId, snapshotKey }`，跨页失效后拒收晚到响应；针对 `283 §28` 指出的在途编辑导致按钮长期锁死于「正在出图…」，[292 §9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#9-283-28-补修复核跟进与文档勘误自验292-r06-在途编辑292-r08-干净隔离环境与-doc-r01r04) 新增 `invalidateProbe`／`invalidatePreview`（`#L149-L165`、`#L295-L306`、`#L606-L618`）同步重置忙态按钮并丢弃旧响应，复核结论见 [状态页](../STATUS.md)。
- **`292-R07`（已通过 `283 §28` 独立复核）**：[scene-image-settings.ts](../../backend/src/application/scene-image-settings.ts#L155-L195) 的 `preview()` 对非空 `outfitId` 通过 `AppearanceStore.getOutfit(outfitId)` 核验当前角色下未删除服饰，否则在生图前抛出 `404 OUTFIT_NOT_FOUND`（见 [283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)）。
- **`292-R08`（独立隔离 E2E 通过）**：[electron-executable.cjs](../../desktop/desk-preview/tests/electron-executable.cjs) 按环境变量 → `desktop/desk-preview/node_modules/electron` → 开发机根目录兜底解析，新增 `resolveElectronExecutableInfo` 暴露实际解析来源（`electronExecutableSource`、`electronExecutableResolvedFromDesktop`）并支持 `NOWADAYS_ALLOW_ROOT_ELECTRON_FALLBACK=0` 禁止回落根目录；已在仅含 `desktop/desk-preview/node_modules` 的无根目录依赖隔离副本完成完整构建与全链路 E2E 自验（见 [292 §9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#9-283-28-补修复核跟进与文档勘误自验292-r06-在途编辑292-r08-干净隔离环境与-doc-r01r04)）。
- **已更新历史测试与本轮待复核项**：[settings-review-fixes-check.cjs](../../desktop/desk-preview/tests/settings-review-fixes-check.cjs) 已同步 `mergeBindingDrafts` 非重叠自动合并与同用途重叠冲突恢复，`292-R09` 有界等待清理及 [Settings.tsx](../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L531) 自动合并草稿回写同步均已完成自验（见 [292 §10](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#10-283-29292-r09doc-r01-邻接契约与-settings-review-fixes-checkcjs-收口自验) 与 [STATUS.md](../STATUS.md)），待独立复核。
- **待实测/复核项**：`278 §4` 首次配置交互恢复链（[279 §3](../archive/06-workflow-simplification/279-workflow-simplification-two-pass-review.md#3-第三轮端到端复核)）尚未完成真实后端完整复验；真实外部模型/ComfyUI/TTS 服务与桌面端实际打包行为待联调留证。

### 5.4 核心实现索引

- **后端路由、校验与守卫**：[config-writes.ts](../../backend/src/http/config-writes.ts) · [write-guard.ts](../../backend/src/http/write-guard.ts) · [role-activity-routes.ts](../../backend/src/http/role-activity-routes.ts) · [routes.ts](../../backend/src/http/routes.ts) · [router.ts](../../backend/src/http/router.ts) · [schemas.ts](../../backend/src/http/schemas.ts) · [image-service-routes.ts](../../backend/src/http/image-service-routes.ts) · [voice-routes.ts](../../backend/src/http/voice-routes.ts) · [appearance-routes.ts](../../backend/src/http/appearance-routes.ts) · [commands.ts](../../backend/src/cli/commands.ts)
- **后端领域与协调服务**：[role-activity.ts](../../backend/src/domain/role-activity.ts) · [errors.ts](../../backend/src/domain/errors.ts) · [role-activity-service.ts](../../backend/src/application/role-activity-service.ts) · [role-deletion-service.ts](../../backend/src/application/role-deletion-service.ts) · [role-service.ts](../../backend/src/application/role-service.ts) · [resource-service.ts](../../backend/src/application/resource-service.ts) · [conversation-service.ts](../../backend/src/application/conversation-service.ts) · [appearance-service.ts](../../backend/src/application/appearance-service.ts) · [app.ts](../../backend/src/bootstrap/app.ts)
- **桌面设置端**：[Settings.tsx](../../desktop/desk-preview/renderer/src/pages/Settings.tsx) · [binding-merge.js](../../desktop/desk-preview/renderer/src/components/model/binding-merge.js) · [use-model-probe.ts](../../desktop/desk-preview/renderer/src/components/model/use-model-probe.ts) · [ImagePanel.tsx](../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx) · [VoicePanel.tsx](../../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx) · [AppearancePanel.tsx](../../desktop/desk-preview/renderer/src/components/appearance/AppearancePanel.tsx)
