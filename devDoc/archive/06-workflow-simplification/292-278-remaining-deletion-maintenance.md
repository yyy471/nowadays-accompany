# 292 278 剩余项：删除同页暂停与后台调用维护协调

> **现行规范入口**：本文角色删除同页暂停、标注/过场规划维护协调及设置配置守卫的现行契约已并入 [角色配置、全局资源与活动守卫规范](../../specs/role-config-and-activity.md)，第 6 节生图草稿探测与语音暂存试听契约已并入 [TTS 与生图服务接入规范](../../specs/tts-and-image-services.md)（其中 [283 §29](283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) 已确认 `292-R05～R08` 通过；第 10 节记录 `292-R09`、`DOC-R01` 邻接契约与 `settings-review-fixes-check.cjs` 收口自验，待独立复核）；下文保留实施与 E2E 复验记录。

2026-11-12。继续实施 [278](278-project-workflow-simplification-fix-plan.md) 尚未完成的部分：§1.4 角色删除同页暂停，以及 §2.1 句段标注和过场图规划的维护窗口协调。外观语音生图 §5 的草稿探测、未保存录音试听与设置导航收敛仍待下一包。283 第 12 节复核后的补修见 [293](293-292-review-fixes.md)。

## 1. 角色删除同页暂停（278 §1.4）

- 删除角色的对话框不再要求用户先到角色状态里停止。角色处于启用或正在停止时，主按钮显示「暂停并删除角色」；确认后先请求停止并等待后端确认 `stopped`，再提交带历史选择（保留／一并删除）的删除请求。
- 暂停与删除的进度在原对话框显示（「正在暂停角色…」「正在删除…」）。暂停超时或删除失败时不执行删除：错误留在原处，角色状态按后端实际结果刷新，并保留「继续活动」入口。
- 角色原本已停止时仍显示「删除角色」并直接提交。至少保留一个角色的既有规则不变。

## 2. 标注与过场图规划的维护协调（278 §2.1）

- 资源服务新增 `waitForMaintenanceEnd`：目标服务进入维护窗口后，后台调用等待结束；维护成功、失败或取消都会唤醒。
- 句段标注在解析出对话模型后检查维护状态；维护中不领取新调用，结束后重新解析绑定再标注，避免用旧地址发起请求。
- 过场图模型规划同样在维护窗口内等待，结束后按已保存配置重新解析再规划；维护期间任务保持未完成，不会提前领取或改走固定回退。
- 记忆整理此前已在批入口暂缓并在维护结束唤醒，三者现在使用同一维护窗口。

## 3. 变更文件

- 后端：`resource-service.ts`（维护等待原语与唤醒）、`conversation-service.ts`（把等待传入句段标注）、`segment-annotation-service.ts`（维护检查与重新解析）、`scene/model-planner.ts`（维护检查与重新解析）、`bootstrap/app.ts`（装配）。
- 桌面：`pages/Settings.tsx`（删除对话框按活动状态暂停并删除、失败后继续活动入口）。
- 测试：`tests/p11-scene-image-planning.test.ts` 新增「过场图规划等待模型维护窗口」集成用例。

## 4. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 373／373 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-12T13-39-02-516Z-9b1f038c/summary.json`。

新增用例覆盖：目标服务上挂起一次后台记忆调用并进入模型维护；此时请求过场图规划，规划模型调用保持未领取；维护结算并写入新地址后规划继续，任务成功。

## 5. 交接边界

- 角色删除同页流程与规划等待为实施方自验；Electron 删除对话框需按活动/停止两种状态复验，真实服务联调待验。
- 句段标注的等待路径与规划共用同一原语，未单独构造挂起用例；后续可按 278 §2.1 补测。
- 278 §5 剩余：草稿生图连接探测与草稿样图、未保存录音试听（临时输入）、设置导航收敛；§4 的跨页返回与重连等待原因仍待联调。

## 6. 生图草稿探测、语音暂存试听与设置导航收敛

2026-11-14。本节在原档内追加记录 [278 §5](278-project-workflow-simplification-fix-plan.md#5-外观语音生图草稿测试与设置导航收敛)、[268 §6](../05-model-settings-and-dialogue/268-model-settings-and-dialogue-fix-plan.md#6-核查同类入口) 生图草稿探测、Windows 桌面单测路径修复及 Electron E2E 发现的两个设置页真实缺陷的实施与离线自验结果。

### 6.1 实施内容

- **桌面单测 Windows ESM 路径修复**：`desktop/desk-preview/tests/design-tokens.test.cjs` 动态 `import` 转为 `pathToFileURL`，修复 Windows Node 24 下失败问题。
- **全局与角色生图草稿探测、预览及服务 CRUD（`268 §6`、`278 §5`）**：
  - 后端提供 `POST /v1/image-services`、`PATCH /v1/image-services/:serviceId`、`DELETE /v1/image-services/:serviceId`、`POST /v1/image-services/probe`（接收 `serviceId?`、`config`、`secret?`、`workflow?`），以及角色草稿路径 `POST /v1/roles/:roleId/scene-image/probe` 和 `POST /v1/roles/:roleId/scene-image/preview`（接收草稿 `serviceDraft`、`settings`/`workflow`、`prompt`、`outfitId` 等参数）；草稿探测与预览均不写回已保存配置。
  - 桌面端在设置页将服务分类收拢为 `['模型', '生图']` 两项，补齐 `ImageServiceCreate` 与 `ImageServiceDetail`（名称、地址、`timeoutMs`、密钥保留/替换/清除、草稿连接探测、全局启停与按角色活动状态暂停后删除）；角色生图 `ImagePanel` 支持跨页回跳设置保留草稿、探测模型候选 chip、参数折叠区与草稿测试生图，且修改未保存前在角色海报卡展示 `.config-poster-dirty` 标记。
- **语音未保存参考录音临时试听与原子 multipart 保存（`278 §5`）**：
  - 后端 `POST /v1/roles/:roleId/voice/preview` 与 `PUT /v1/roles/:roleId/voice` 支持 `application/json` 或 `multipart/form-data`（`payload` + `file`）；临时试听不写入角色音频资产库，原子保存失败时保留原有配置且不留下孤儿录音记录。
  - 桌面端 `VoicePanel` 选定本地参考音频后仅暂存 `'待上传'` 状态，不提前调用 `/voice/references`；试听与「保存声音配置」直接走 multipart 提交。
- **E2E 暴露并修复的两个前端缺陷（`Settings.tsx`）**：
  - `RoleEditor` 非当前编辑角色的内层 `.config-prose` 与 `.config-model-details` 缺少 `!active || ...` 条件隐藏，导致同页 DOM 查询匹配到隐藏角色面板内容；已补齐与 `.config-role-editor` 一致的隐藏门控。
  - `saveBindings('ext')` 直接把带 `modelName: null` 的扩展绑定发往后端，触发 `PUT /bindings` 校验拒绝（`bindingSchema` 要求 `modelName` 若存在则为非空字符串）；已改为经 `asInput` 过滤空字段。

### 6.2 变更文件

- 后端：`backend/src/application/{credential-resolver,image-service,scene-image-settings,voice-service}.ts`、`backend/src/domain/scene-image-settings.ts`、`backend/src/http/{config-writes,image-service-routes,schemas,voice-routes}.ts`、`backend/src/scene/comfyui-workflow.ts`、`backend/tests/{p8-voice,p9-tts-unified,p13-comfyui}.test.ts`。
- 桌面与测试：`desktop/desk-preview/renderer/src/{api.ts,image-config.d.ts,image-config.js,voice-config.d.ts,voice-config.js,pages/Settings.tsx}`、`desktop/desk-preview/renderer/src/components/{image/ImagePanel.tsx,voice/VoicePanel.tsx}`、`desktop/desk-preview/renderer/src/styles/{image.css,settings-workspace.css}`、`desktop/desk-preview/tests/{design-tokens,image-config,voice-config}.test.cjs`、`desktop/desk-preview/tests/settings-workspace-check.cjs`。

### 6.3 验证结果（实施方离线自验）

| 检查项 | 命令／脚本 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `cd backend && npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `cd backend && npx -y node@24 --import tsx --test --test-concurrency=8 tests/*.test.ts` | **406／406** 通过，0 失败，0 跳过 |
| 后端离线验收 | `cd backend && npx -y node@24 scripts/accept-offline.mjs` | **21／21** 步通过，`realServiceCalls=0` |
| 渲染端检查与构建 | `cd desktop/desk-preview/renderer && npm run check && npm run build` | `tokens:check` 最新，`lint:styles` 22 个 CSS 违规 0（豁免 389），`tsc --noEmit` 通过，`vite build` 118 模块通过 |
| 桌面逻辑单测 | `cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs` | **122／122** 通过（含 `design-tokens.test.cjs`） |
| 设置工作区 E2E | `npx -y node@24 desktop/desk-preview/tests/settings-workspace-check.cjs` | 通过（`errors: []`，覆盖 2 栏设置、生图服务 CRUD/草稿探测、角色生图草稿预览与跨页保留、语音暂存试听与 multipart 保存、删除流程等） |
| 绑定/自动合并/本地真后端/布局/主题 E2E | `settings-binding-recovery-check.cjs`、`settings-auto-reload-check.cjs`、`settings-real-backend-check.cjs`、`dialogue-layout-check.cjs`、`theme-transition-check.cjs` | 5 项脚本均退出 0（本地 mock 或本机后端隔离库） |

验收报告：`backend/test-results/p5-2026-11-13T17-04-19-168Z-156917c6/summary.json`。

### 6.4 已知边界与待办

- 本节结论为**实施方离线自验**，独立复核尚未执行；真实模型、真实语音（TTS）、真实 ComfyUI 生图服务与桌面对话实时联调仍待执行。
- 既有用例说明：`settings-review-fixes-check.cjs` 未随早期提交 `0cd50ba`（`mergeBindingDrafts` 非重叠绑定自动合并）同步更新，在本次修补前即超时失败（第 84–90 行仅改服务端 `mcp`、期待旧版手点冲突重试提示，而现行为自动合并成功）；重叠冲突重试由 `settings-binding-recovery-check.cjs` 覆盖。
- 仍未在本轮范围的后续能力：ComfyUI 图生图与服饰锚点图上传、过场图 `CG-03` 自动触发与 `CG-04` 真实适配、`237～239` 独立复核、`278 §4` 首次配置联调、Windows 打包、远程 MCP（`DL-115`）及角色本体修订（`DL-148`）。

## 7. 改动链路端到端复核与缺陷收口

2026-11-14。在完成 `§6` 后，按用户要求对所有修改项补充真实前端点击＋真实本机后端 HTTP/SQLite 运行时（搭配本地假 OpenAI、统一语音与 ComfyUI 服务端点）的主链路与「正被使用／已删除／刚恢复」支链路完整复核，并逐张检查 Electron 截图。

### 7.1 复核暴露并修复的新缺陷

1. **`ResourceService.impact()` 角色展示名退化为原始 UUID（`backend/src/application/resource-service.ts`）**：`AppStore.markRoleReady` 会将 `init_payload_json` 清为 `NULL`，导致 `impact()` 原先读取 `index.initPayload?.displayName ?? index.roleId` 对所有就绪角色返回 UUID；改为在 `withStore` 内直接读取角色库 `storage.business.getRole(index.roleId).displayName`。
2. **`ModelManagement` 与 `ExtensionManagement` 引用列表直接暴露原始 UUID（`desktop/desk-preview/renderer/src/pages/Settings.tsx`）**：占用列表与「关闭全部启用绑定」失败提示原先直接拼接 `item.roleId`；已抽离 `roleDisplayName` 并向两组件传入 `roles`，统一展示角色名称。
3. **设置页跳转状态残留与切换角色遮挡卡死（`desktop/desk-preview/renderer/src/pages/Settings.tsx`）**：
   - 「在设置中查看模型 →」未显式切回 `modelKind: 'model'`；且从外部跳入设置页时，`newModel` / `newExtension` / `newImageService` 新建表单状态可能残留。「添加模型服务」面板的 `hidden` 条件同步收紧为含 `modelKind !== 'model'`。
   - `chooseRole` 原仅依赖 `animation.finished`，在窗口被遮挡时动画帧暂停会导致角色切换卡住；已补 `700ms` 幂等兜底（`finishFlight`）。
4. **生图入口收敛、跨站点留密误停与失效服务防护（`ImagePanel.tsx`、`Settings.tsx`、`styles/image.css`）**：
   - 撤除 `ImagePanel` 内与设置页重复的内联「新建服务」表单及无用样式规则 `.nd-image-new-service`，仅保留设置管理跳转并带回 `createNew`。
   - 从设置返还角色配置时通过 `serviceRefreshVersion` 同步最新 `/v1/image-services`；已删除或未选生图服务显式展示 `请选择生图服务` / `原服务已删除（请重新选择）`、行内 `[role="alert"]` 提示，并在探测/草稿生图/保存前拦截，不再静默改选第一项或先暂停活跃角色再报错。
   - `ImageServiceDetail.save()` 在调用 `stopActiveRolesForGlobalWrite` 前先行校验 `http:`/`https:` 与跨站点留密冲突（`RESOURCE_CREDENTIAL_STALE`），避免报错前误停全部活跃角色。
5. **角色「继续活动」后紧邻写操作与全局生图停用竞态（`Settings.tsx`）**：
   - `RoleEditor.resumeAfterWrite` 原在 `await onRefresh()` 完成前就清除 `pausedForWrite` 且无在途锁；`ensureRoleStopped` 与 `stopActiveRolesForGlobalWrite` 原直接信任可能过期的 React 属性 `activity` / `activities`，导致刚恢复活动后紧接修改（如 `PUT /voice/enabled` 或全局删除生图服务）跳过暂停步骤并被后端以 409 拒绝。
   - 已将 `resumeAfterWrite` 改为锁定按钮（「正在继续…」）并等待 `onRefresh()` 完成后再清除提示；`ensureRoleStopped` 与 `stopActiveRolesForGlobalWrite` 写入前均先查询实时 `/v1/activities` 再按真实状态暂停。

### 7.2 新增全链路实测与截屏复核结果

- **全链路端到端脚本**：新增 [workflow-real-backend-chain-check.cjs](../../../desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs)，拉起真实 `backend/src/main.ts` HTTP 服务（独立 SQLite 分库 + 写前停止守卫 + LangGraph 对话 + SSE）与真实 Electron 窗口，串联 7 条主/支链路：
  1. 导航状态清理（「添加生图/模型服务」与「在设置中查看模型」状态不串台）。
  2. 模型主链路（创建、拉取模型列表、探测、`stopped` 绑定）与被用支链路（`impact` 准确展示角色名与用途、仅改名不暂停、改连接与密钥仅暂停关联角色甲而乙保持 `active`、一键恢复后真实对话改打新地址与新密钥）。
  3. 扩展链路（MCP 创建、角色启用保存、占用显示人类可读角色名且禁删、「关闭全部启用绑定」后全局停用并删除）。
  4. 生图全链收敛（`ImagePanel` 无重复内联新建、设置内跨站点留密预拦截、草稿探测与样图不影响已保存配置、活跃角色保存与恢复、删除备用服务后原绑定显式报错且不误停角色）。
  5. 语音链路（选择本地 WAV 仅暂存 `待上传` 且零上传、试听零写库、`zero_shot` 缺参考文本写前拦截不误停、原子 multipart 保存后使用中参考音频禁删、开关停用保留配置且可重启用）。
  6. 跨角色未保存草稿切换（`.config-dirty-prompt` 与 `.config-poster-dirty` 徽标）与真实对话（SSE 句段推进、语音合成调用 `/speech -> /tts`、手动过场图经 `ModelSceneImagePlanner` 规划并调用 ComfyUI 渲染展示）。
- **视觉截图核对**：已在 `test-results/full-chain-review/` 检查 1280×800（昼主题：`settings-model-1280.png`、`role-image-1280.png`、`dialogue-ready.png`、`dialogue-scene.png`）与 720×540（夜主题：`role-voice-night-720.png`）全部 5 张截图，确认布局对齐、文案折行、对比度与按钮状态正常，无遮挡或冗余表单。

### 7.3 最终代码修改后完整复验基线（离线／本地假服务端点）

| 检查项 | 命令／脚本 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `cd backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `cd backend && npx -y node@24 --import tsx --test tests/*.test.ts` | **406／406** 通过，0 失败，0 跳过 |
| 后端离线验收 | `cd backend && npx -y node@24 scripts/accept-offline.mjs` | **21／21** 步通过，`realServiceCalls: 0`（`backend/test-results/p5-2026-11-13T17-58-19-172Z-3a73d235/summary.json`） |
| 渲染端检查与构建 | `cd desktop/desk-preview/renderer && npm run check && npm run build` | `tokens:check` 最新，`lint:styles` 22 个 CSS 违规 0（豁免 389），`tsc --noEmit` 通过，`vite build` 118 模块通过 |
| 桌面逻辑单测 | `cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs` | **122／122** 通过，0 失败，0 跳过 |
| 全链路真实后端 E2E | `npx -y node@24 desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs` | 退出 0，`errors: []`，全部 7 条主／支链路与对话闭环通过 |
| 其余桌面 E2E 回归 | `settings-workspace-check.cjs`、`settings-binding-recovery-check.cjs`、`settings-auto-reload-check.cjs`、`settings-real-backend-check.cjs`、`dialogue-layout-check.cjs`、`theme-transition-check.cjs` | 6 项脚本全部退出 0（零异常报错） |

> 边界说明：本轮端到端联调使用真实前端、真实 Electron 主进程与真实本地后端服务（真实 SQLite 持久化与并发守卫），外接模型、统一语音与 ComfyUI 为本地假服务端点；真实第三方远端/本地模型服务实机联调与独立复核仍待单独执行。

## 8. `292-R05`～`292-R08` 补修与自验（生图停用拦停、跨页探测／样图失效、预览服饰归属与 E2E 依赖解析）

2026-11-14。针对 [283 §27](283-278-workflow-simplification-independent-review.md#271-待修复项) 复核发现的 4 项 `P2` 缺口在同一文档内追加补修记录与离线／真进程自验结果。

### 8.1 修复内容与文件索引

1. **`292-R05`（已停用生图服务保存前拦截）**：
   - [ImagePanel.tsx](../../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx#L301-L347) 的 `save()` 新增本地启用状态预检（`!currentLocal.enabled`），并在调用 `guardWrite(...)` 前向后端重新拉取 `/v1/image-services` 二次确认所选服务仍存在且 `enabled === true`；若已停用则直接行内报错（`IMAGE_SERVICE_DISABLED`）并刷新本地列表提示「当前所选生图服务已停用，请先启用或重新选择。」，不会先把活跃角色暂停后再失败。切换回已启用服务后可正常保存。
2. **`292-R06`（跨页删除／停用／修改服务连接后旧探测与旧样图立即失效，拒收在途晚到响应且保留草稿）**：
   - [image-config.js](../../../desktop/desk-preview/renderer/src/image-config.js#L195-L210)（及 `image-config.d.ts`）新增 `imageServiceSnapshotKey(service, epoch)` 纯函数，纳入 `serviceId`、`enabled`、`protocol`、`baseUrl`、`timeoutMs`、`credentialRef`、`credential.status/reference`、`updatedAt` 与每服务修改代次 `epoch`。
   - [Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L102-L106) 追踪 `imageServiceEpochs`（仅在 `ImageServiceDetail` 保存或启停切换、或创建／删除服务时递增），并将 `serviceEpochs` 与 `outfitRefreshVersion={lookVersion}` 传入 `ImagePanel`。
   - [ImagePanel.tsx](../../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx#L180-L505) 为 `probe` 与 `preview` 绑定 `{ serviceId, snapshotKey }` 标签，跨页同步或服务快照变化时立即失效清除旧 `probe` 模型芯片／摘要与旧 `preview` 测试样图、清理对应短暂状态提示并递增 `probeSeq`／`previewSeq`（同时在切离页面及请求起始校验快照键，`finally` 仅按当前序列重置 `busy` 标志），确保在途晚到响应不会写回旧芯片或旧样图；用户的未保存草稿字段全程保留。同步在服饰列表刷新移除选中预览服饰时清理失效 `previewOutfitId` 与旧样图。
3. **`292-R07`（预览接口校验 `outfitId` 角色归属与未删除状态）**：
   - [scene-image-settings.ts](../../../backend/src/application/scene-image-settings.ts#L155-L195) 的 `SceneImageSettingsService.preview()` 在解析运行时配置后、调用 `this.generator.generate(...)` 前，对非空 `outfitId` 调用 `new AppearanceStore(storage.business.db, roleId).getOutfit(outfitId)` 查核当前角色下未删除服饰记录，未命中时直接抛出 `404 OUTFIT_NOT_FOUND`（`fakeComfy` 调用次数保持为 `0`）；当前角色有效服饰以及未传／`null`／空串均正常放行。
   - 同步在 [p13-comfyui.test.ts](../../../backend/tests/p13-comfyui.test.ts#L298-L309) 引入真实建服饰辅助函数 `createTestOutfit`，替换既有预览测试中的合成 `"outfit-1"`／`"outfit-draft"`，并新增跨角色服饰、当前角色已删除服饰、不存在服饰 ID（在调用 ComfyUI 前拒绝且 `0` 次下游请求）的集成用例。
4. **`292-R08`（Electron E2E 解析 `desktop/desk-preview` 声明的依赖）**：
   - 新增 [electron-executable.cjs](../../../desktop/desk-preview/tests/electron-executable.cjs)（及单测 [electron-executable.test.cjs](../../../desktop/desk-preview/tests/electron-executable.test.cjs)），按「`NOWADAYS_ELECTRON_PATH`／`ELECTRON_EXEC_PATH` 环境变量 → `desktop/desk-preview/node_modules/electron`（跨平台读取 `path.txt` / 入口）→ 基于 `desktop/desk-preview` 的 Node 解析 → 开发机历史根目录兜底（可通过 `allowRootFallback: false` 关闭）」顺序解析可执行文件。
   - 更新 [workflow-real-backend-chain-check.cjs](../../../desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs) 及同目录其余 9 个 Electron E2E `.cjs` 检查脚本（`dialogue-layout-check.cjs`、`relations-desktop-check.cjs`、`relations-review-234.cjs`、`settings-auto-reload-check.cjs`、`settings-binding-recovery-check.cjs`、`settings-real-backend-check.cjs`、`settings-review-fixes-check.cjs`、`settings-workspace-check.cjs`、`theme-transition-check.cjs`），将 `root` 锚定到 `path.resolve(__dirname, '../../..')` 并统一调用 `resolveElectronExecutable({ repoRoot: root })`（同步在 `settings-workspace-check.cjs` 解除 `pngjs` 对根目录 `node_modules` 的硬编码）；并在 `workflow-real-backend-chain-check.cjs` 补充了 `292-R05` 与 `292-R06`（停用／改配／删除＋在途慢探测与慢预览拦截）端到端 UI 断言。

### 8.2 本轮全量验证结果（实现方自验，待独立复核）

| 检查项 | 命令／脚本 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `cd backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `cd backend && npx -y node@24 --import tsx --test tests/*.test.ts` | **407／407** 通过，0 失败，0 跳过（`p13-comfyui.test.ts` 18／18） |
| 后端离线验收 | `cd backend && npx -y node@24 scripts/accept-offline.mjs` | **21／21** 步通过，`realServiceCalls: 0`（`backend/test-results/p5-2026-11-14T03-30-05-251Z-e089f443/summary.json`） |
| 渲染端检查与构建 | `cd desktop/desk-preview/renderer && npm run check && npm run build` | `tokens:check` 最新，`lint:styles` 22 个 CSS 违规 0（豁免 389），`tsc --noEmit` 通过，`vite build` 118 模块通过 |
| 桌面逻辑单测 | `cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs` | **125／125** 通过，0 失败，0 跳过（含 `image-config.test.cjs` 10／10 与 `electron-executable.test.cjs` 2／2） |
| 无根目录依赖 Electron 真进程解析验证 | 临时隔离 `desktop/desk-preview/node_modules/electron`（`allowRootFallback: false`）执行二进制版本查询 | 返回 `resolvedInsideDesktop: true`、`electronVersion: "39.8.10"` |
| 全链路真实后端 E2E（根目录与 `desktop/desk-preview` 双工作目录） | `npx -y node@24 desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs` 与 `cd desktop/desk-preview && npx -y node@24 tests/workflow-real-backend-chain-check.cjs` | 两次均退出 0，`errors: []`（新增 `imageDisabledSaveGuardedBeforePause`、`imageCrossPageProbeAndPreviewInvalidated`、`electronExecutableResolvedCleanly` 全部 `true`） |
| 其余 8 项桌面 E2E 回归脚本 | `settings-workspace-check.cjs`、`dialogue-layout-check.cjs`、`theme-transition-check.cjs`、`relations-desktop-check.cjs`、`relations-review-234.cjs`、`settings-auto-reload-check.cjs`、`settings-binding-recovery-check.cjs`、`settings-real-backend-check.cjs` | 全部退出 0，零异常报错（`settings-review-fixes-check.cjs` 因历史 `mergeBindingDrafts` 断言分歧保留在待更新清单） |

> 交接与边界说明：以上结果为补修后的实现方自验，使用真实 Electron、真实渲染器构建与真实本地后端 SQLite，外接模型／TTS／ComfyUI 为本地假端点；本轮 `292-R05`～`292-R08` 仍需独立复核确认关闭，真实外部服务联调与桌面真包打包待另行验证。

## 9. `283 §28` 补修复核跟进与文档勘误自验（`292-R06` 在途编辑、`292-R08` 干净隔离环境与 `DOC-R01～R04`）

2026-11-14。针对 [283 §28](283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验) 对第 8 节独立复验留下的两项代码跟进项，以及 [文档优化方案 §7](../07-documentation/documentation-optimization-plan.md#7-导航与现行契约独立复核) 指出的 `DOC-R01`～`DOC-R04` 文档勘误，完成补修与全量自验（待独立复核）。

### 9.1 补修与勘误内容

1. **`292-R06` 在途编辑导致「测试生图」按钮长期锁死**：
   - 根因：`ImagePanel` 此前在编辑 `previewPrompt`、`previewOutfitId`、`updateForm` 等路径直接 `previewSeq.current += 1` 丢弃在途响应，而 `runPreview()` / `runProbe()` 的 `finally` 仅在序号未变时才 `setPreviewBusy(false)` / `setProbeBusy(false)`，导致用户尚未收到上次结果前改动任何测试参数都会把按钮永久留在禁用的「正在出图…」。
   - 修复：[ImagePanel.tsx](../../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx#L149-L165) 统一抽取 `invalidateProbe(clearResult)` 与 `invalidatePreview(clearResult)`，在递增 `probeSeq`/`previewSeq` 的同时立即释放 `probeBusy`/`previewBusy`，并在需要清理陈旧结果的场景（切角色、服务切换／失效、丢弃草稿、服饰删除）同步清空旧探测／样图和对应提示；在 `previewPrompt` / `previewOutfitId` / `updateForm` 等在途编辑路径保留既有样图并立刻允许用最新草稿重新点击「测试生图」，旧的晚到响应或失败仍按序列号拒收不覆写界面。
   - E2E 扩充：[workflow-real-backend-chain-check.cjs](../../../desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs) 新增端到端真实界面交互断言（`imageInFlightDraftEditRecoversPreviewButton`），为角色 B 上传服饰「冬装」，覆盖慢测试出图在途中修改「测试画面描述」、修改测试服饰＋基础形象提示词＋测试描述，以及已有样图时在途编辑恢复按钮、丢弃旧结果并按最新草稿出图全过程。
2. **`292-R08` 解析来源去误报与无根目录 `node_modules` 干净隔离环境全链路自验**：
   - 修复：[electron-executable.cjs](../../../desktop/desk-preview/tests/electron-executable.cjs) 新增 `resolveElectronExecutableInfo(options)`（返回 `{ executable, source }`，区分 `'env'`、`'desktop-local'`、`'desktop-node-resolve'`、`'repo-root-fallback'`）并支持 `NOWADAYS_ALLOW_ROOT_ELECTRON_FALLBACK=0|false|no` 禁止回落根目录；[workflow-real-backend-chain-check.cjs](../../../desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs) 移除硬编码的 `electronExecutableResolvedCleanly: true`，改记真实 `electronExecutableSource` 与 `electronExecutableResolvedFromDesktop`（仅在 `'desktop-local'` 或 `'desktop-node-resolve'` 时为 `true`），并在 [electron-executable.test.cjs](../../../desktop/desk-preview/tests/electron-executable.test.cjs) 补充 `resolveElectronExecutableInfo` 与环境变量禁用兜底单测。
3. **`DOC-R01`～`DOC-R04` 现行规范与导航勘误同步修正**：
   - `DOC-R01`：[conversation-performance-and-scene-images.md](../../specs/conversation-performance-and-scene-images.md) §2.1 修正 `DELETE .../input-state` 为 `200 { cleared: true }` 与 `400 INPUT_STATE_INVALID`（并在 [p2-05-api-cli.test.ts](../../../backend/tests/p2-05-api-cli.test.ts) 补缺 `clientId` 返回 `400 INPUT_STATE_INVALID` 断言）；[storage-memory-and-autonomy.md](../../specs/storage-memory-and-autonomy.md) §2.2/§2.3 澄清 `POST .../memory/batches` 在角色删除中返回 `409 ROLE_DELETING`，否则异步返回 `202 { triggerId, duplicate }`，`MEMORY_BATCH_CONFLICT` 为后台 `runBatch` 并发锁内部错误码。
   - `DOC-R02`：[conversation-performance-and-scene-images.md](../../specs/conversation-performance-and-scene-images.md)、[tts-and-image-services.md](../../specs/tts-and-image-services.md) 与 [specs/README.md](../../specs/README.md) 统一按 [223](../03-appearance-and-performance/223-conversation-performance-development-guide.md) 保持 `CG-04` 为过场图增量独立复核与真实生图适配，不再把「ComfyUI 图生图与服饰锚点图上传」写成 `CG-04`。
   - `DOC-R03`：[tts-and-image-services.md](../../specs/tts-and-image-services.md) §2.3 修正物理库名为 `<app-root>/data/app.sqlite` 与 `<app-root>/data/roles/<roleId>/business.sqlite`。
   - `DOC-R04`：[devDoc/README.md](../../README.md) `#常用专项` 取消静态 `(待修 ...)` 标签，统一只保留中性复核链接并指向 [STATUS.md](../../STATUS.md)。

### 9.2 补修后全量验证结果（实现方自验，待独立复核）

| 检查项 | 命令／环境 | 结果 |
| --- | --- | --- |
| 后端类型检查、单测与离线验收 | `cd backend && tsc --noEmit`、`node@24 --import tsx --test tests/*.test.ts`、`node@24 scripts/accept-offline.mjs` | 类型检查通过；**407／407** 后端单测通过（含新增 `INPUT_STATE_INVALID` 断言）；**21／21** 步离线验收通过，`realServiceCalls: 0`（`backend/test-results/p5-2026-11-14T04-32-19-368Z-5c9b9fdf/summary.json`） |
| 桌面渲染器检查与逻辑单测 | `cd desktop/desk-preview/renderer && npm run check && npm run build`；`cd desktop/desk-preview && node@24 --test tests/*.test.cjs` | `tokens:check` 最新、`lint:styles` 22 CSS 0 违规（豁免 389）、`tsc --noEmit` 与 `vite build`（118 模块）通过；**125／125** 桌面逻辑单测通过（0 失败，0 跳过） |
| 干净独立环境完整 E2E（零根目录 `node_modules`） | 复制干净隔离工程副本（仅在 `desktop/desk-preview/node_modules` 安装 `electron`，仓库根目录无 `node_modules`、`NOWADAYS_ALLOW_ROOT_ELECTRON_FALLBACK=0`），分别从隔离根目录与 `desktop/desk-preview` 运行完整检查＋`workflow-real-backend-chain-check.cjs` | 两工作目录均退出 0、`errors: []`，实际输出 `"electronExecutableSource": "desktop-local"`、`"electronExecutableResolvedFromDesktop": true`、`"imageInFlightDraftEditRecoversPreviewButton": true` |
| 主工作区 E2E 与 8 项回归脚本 | 主工作区（`workflow-real-backend-chain-check.cjs` 及 `settings-workspace-check.cjs`、`dialogue-layout-check.cjs`、`theme-transition-check.cjs`、`relations-desktop-check.cjs`、`relations-review-234.cjs`、`settings-auto-reload-check.cjs`、`settings-binding-recovery-check.cjs`、`settings-real-backend-check.cjs`） | 全链路退出 0（真实报告 `"electronExecutableSource": "repo-root-fallback"`、`"electronExecutableResolvedFromDesktop": false`、`"imageInFlightDraftEditRecoversPreviewButton": true`）；8 项回归全部退出 0（`settings-review-fixes-check.cjs` 仍保留在历史断言待决清单，未并入本轮通过口径） |
| 文档规范与链接巡检 | `npx -y node@24 scripts/check-docs.mjs --json` 与 `node scripts/check-docs.mjs` | `0` 错误、`0` 警告 |

> 交接说明：`292-R06` 在途编辑补修、`292-R08` 干净独立环境 E2E 证据与 `DOC-R01`～`DOC-R04` 文档修正均属实现方自验，需由独立复核确认关闭；真实外部模型／ComfyUI／TTS 实机联调及桌面真包交付仍需另行验证。


## 10. 283 §29（292-R09）、DOC-R01 邻接契约与 settings-review-fixes-check.cjs 收口自验

2026-11-14。针对 [283 §29](283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) 遗留的 `292-R09`、[文档优化方案 §7.1](../07-documentation/documentation-optimization-plan.md#71-现行规范勘误独立复验) 的 `DOC-R01` 邻接契约差异，以及第 6.4 节遗留的历史测试 [settings-review-fixes-check.cjs](../../../desktop/desk-preview/tests/settings-review-fixes-check.cjs) 同步决策，本轮完成以下补修与自验（以下为本轮自验结果，待独立复核）：

1. **`292-R09` 模拟服务等待与 CDP 有界超时／清理**（[workflow-real-backend-chain-check.cjs](../../../desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs)）：
   - 由共享辅助 `createComfyHold` 收敛 `holdNextObjectInfo` 与 `holdNextPrompt`：为 `arrived` 绑定有限超时 `DEFAULT_WAIT_MS`（读 `NOWADAYS_E2E_WAIT_MS`，默认 `25000ms`）与情景标签 `label`；超时时主动释放门闩 `release()` 并以 `等待超时(<label>): 模拟 ComfyUI <ms>ms 内未收到 <kind> 请求` 拒绝。
   - `releaseAllHolds` 统一登记未释放的 `release` 回调；`until()`、`cmd()`、`ws.onopen` 与 `ws.onclose` 均接入有限超时或待决命令拒绝。
   - `.finally()` 依次释放全部 `releaseAllHolds`、关闭 CDP 与浏览器/后端子进程、对所有模拟 HTTP 服务调用 `closeAllConnections?.()` + `close()` 并清理 `nowadays-chain-*` 临时目录。
   - 自验：正常全链路 `npx -y node@24 desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs` 退出码 `0`（`errors: []`、`imageInFlightDraftEditRecoversPreviewButton: true`）；故障注入脚本在 `r06-inflight-edit-1-prompt`（`1500ms` 超时）跳过点击「测试生图」按钮，于 `9740ms` 退出码 `1`，抛出预期 `等待超时(r06-inflight-edit-1-prompt): 模拟 ComfyUI 1500ms 内未收到 /prompt 请求`，`nowadays-chain-*` 临时目录零泄漏，且 `Win32_Process` 查询确认零残留 Electron／后端进程。
2. **`DOC-R01` 邻接契约（`POST .../input-state` 双 `400` 错误码区分）**：
   - 同步更新 [对话演出与过场图规范 §2.1](../../specs/conversation-performance-and-scene-images.md#21-对话输入状态sse-与语音消费接口)：请求体结构校验（空或空白 `clientId`、非布尔 `typing`、缺少 `typing` 或多余字段，[schemas.ts](../../../backend/src/http/schemas.ts#L130-L135)）返回 `400 INVALID_REQUEST`；省略 `clientId` 或空白路径标识触发输入态业务校验（`InputStateInvalidError`，[input-state.ts](../../../backend/src/application/input-state.ts#L144-L154)）返回 `400 INPUT_STATE_INVALID`。
   - 在 [p2-05-api-cli.test.ts](../../../backend/tests/p2-05-api-cli.test.ts) 补齐 HTTP `400 INVALID_REQUEST`（`{ clientId: "   ", typing: true }` 与 `{ clientId: "client-http", typing: "yes" }`）断言，与既有 `{ typing: true }` -> `400 INPUT_STATE_INVALID` 断言并列验证；`cd backend && tsc --noEmit` 与 `npx -y node@24 --import tsx --test tests/*.test.ts` 共 **407／407** 通过，0 失败，0 跳过。
3. **`settings-review-fixes-check.cjs` 更新与同步暴露的前端草稿同步缺陷修复**：
   - 核对现存 10 个桌面 E2E 脚本后确认，`settings-review-fixes-check.cjs` 唯一覆盖「删除角色／服饰／差分取消键焦点回退」与「删后 `/v1/roles` 延迟旧响应 + `503` 重试恢复」链路，故决定**更新保留而非归档**。
   - 脚本改用 `process.execPath` 启动后端，将绑定冲突场景细化为：(a) 非重叠变更自动字段级合并 `[409, 200]` 与「已与最新绑定自动合并并保存」；(b) 同用途 `chat_model` 冲突阻断重提 + 「重试读取绑定」注入 `503` 后二次读取保留本地草稿并保存；(c) 扩展页取消 `mcp` 同时外部变更 `chat_model` 触发自动合并保留外部模型。
   - **顺带发现并修复前端真实状态同步缺口**（[Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L531)）：`saveBindings` 遇到 `409` 自动合并并重提成功后，此前直接 `setBindings(retried.items)` 而未调用 `mergeRefreshedBindings(bindings, retried, removedResources)`，导致非当前标签页的草稿状态（如在模型页自动合并入服务端的 `mcp: true` 到扩展草稿，或在扩展页自动合并入的 `chat_model` 到模型草稿）不同步并残留假脏状态。改为调用 `mergeRefreshedBindings(bindings, retried, removedResources)` 后重新构建渲染器：
     - `cd desktop/desk-preview/renderer && npm run check && npm run build` 通过（22 个 CSS 零违规）；
     - `npx -y node@24 desktop/desk-preview/tests/settings-review-fixes-check.cjs` 退出码 `0`（`conflictRecovery: true`、`roleRefreshRetry: true`、`roleFocus: true`、`outfitFocus: true`、`spriteFocus: true`、`errors: []`）；
     - `npx -y node@24 desktop/desk-preview/tests/settings-binding-recovery-check.cjs` 复测通过；
     - `cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs` 共 **125／125** 通过，0 失败，0 跳过。
