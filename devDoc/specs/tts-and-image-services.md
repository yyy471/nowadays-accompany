# TTS 与生图服务接入规范

> **状态**：现行规范 · **适用范围**：`backend/src/{tts,scene,model,http,application,domain,storage}` 与 `desktop/desk-preview/renderer/src/{components/voice,components/image,voice-config.js,image-config.js,pages/Settings.tsx}`  
> **覆盖关系**：整合 [218](../archive/03-appearance-and-performance/218-tts-implementation-record.md)～[222](../archive/03-appearance-and-performance/222-tts-unified-independent-review.md)、[243](../archive/04-role-settings-and-media/243-voice-settings-desktop.md)、[246](../archive/04-role-settings-and-media/246-role-voice-toggle.md)、[247](../archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md)、[248](../archive/04-role-settings-and-media/248-comfyui-adaptation.md)、[250](../archive/04-role-settings-and-media/250-comfyui-independent-review.md)、[251](../archive/04-role-settings-and-media/251-comfyui-review-fixes.md) 与 [292 §6～§7](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) 的语音与生图接入现行规则。角色活动写锁见 [角色配置与活动守卫规范](role-config-and-activity.md)，过场图任务与按句播报消费见 [对话演出、输入状态、SSE 与过场图规范](conversation-performance-and-scene-images.md)，待办与复核总表见 [STATUS.md](../STATUS.md)。

---

## 1. 适用范围、上游决定与边界分工

### 1.1 适用范围

1. **统一语音与旧 IndexTTS 接入**：`nowadays-tts-v1` 服务能力探测、预置／参考克隆双音源、旧 `indextts` 本机桥接兼容、角色单份语音配置保存与启停、受管参考音频资产与临时暂存试听。
2. **全局生图服务管理（ComfyUI）**：全局 `image_services` CRUD、直填密钥或 `env:`／`file:` 引用与换站重验、连接与工作流节点探测（含草稿探测）。
3. **角色文生图配置与推理生成**：`role_scene_image_settings` 参数校验、内置 MOSS-Image 默认工作流、自定义 ComfyUI 工作流按 `class_type` 打补丁、角色草稿探测／测试出图及过场图生成时的运行时解析边界。

### 1.2 边界分工（不在此处重复）

- **角色停止三态、配置写入守卫与设置页导航骨架**：写接口前置活动检查（`ROLE_CONFIG_WRITES` / `GLOBAL_CONFIG_WRITES`）、停启与写前暂停交互、全局设置页两栏布局（`['模型', '生图']`）与跨角色草稿切换提示，统一见 [角色配置、全局资源与活动守卫规范](role-config-and-activity.md)。
- **对话句段消费与过场图任务调度**：按句切分、对话页 `POST /speech` 防抖与缓存、旁白跳过、`scene_image_tasks` 创建、历史服饰与图层消费边界，统一见 [对话演出、输入状态、SSE 与过场图规范](conversation-performance-and-scene-images.md)。
- **桌面视觉令牌与组件样式约束**：见 [前端设计规范](frontend-design-system.md)。

### 1.3 上游产品决定（[161 持续决策记录](../161-digital-life-direction-decisions.md)）

| 决定编号 | 核心约束 | 当前实现边界 |
| --- | --- | --- |
| [DL-139](../161-digital-life-direction-decisions.md#dl-139-首版-tts-采用-indextts) | 首版 TTS 引擎为 IndexTTS 本机 HTTP 桥接 | 保留 `protocol: "indextts"` 向后兼容 |
| [DL-140](../161-digital-life-direction-decisions.md#dl-140-tts-统一接入音色克隆与预置音色) | 同一套界面随服务能力切换参考克隆与预置音色；试听与配置不写多余历史 | `nowadays-tts-v1` 协议按 `/health` 声明动态渲染与校验 |
| [DL-143](../161-digital-life-direction-decisions.md#dl-143-统一语音桥接支持可选情绪指令) | 统一语音桥接支持可选情绪指令（`emotion` 不自动映射立绘差分名） | 接口与客户端保留可选 `emotion`，对话自动按句播报暂未传值 |
| [DL-149](../161-digital-life-direction-decisions.md#dl-149-角色语音只保留当前一份配置) | 每个角色只保留当前一份语音配置；停用保留原配置，新配置直接覆盖 | `role_voice_settings` 主键 `role_id`；`PUT /voice` 不改 `enabled` |
| [DL-150](../161-digital-life-direction-decisions.md#dl-150-生图首版适配-comfyui先测-moss-image) | 生图首版适配 ComfyUI，先测 MOSS-Image；按节点类型打参数补丁 | 仅支持 `modelType: "text2img"`；图生图与锚点上传作为后续能力单列（`CG-04` 按 [223](../archive/03-appearance-and-performance/223-conversation-performance-development-guide.md) 指过场图独立复核与真实生图适配） |

---

## 2. 接口契约、上游协议与数据归属

### 2.1 应用 HTTP 路由

语音与生图路由分别注册于 [voice-routes.ts](../../backend/src/http/voice-routes.ts) 与 [image-service-routes.ts](../../backend/src/http/image-service-routes.ts)，其中标记「角色守卫」与「全局守卫」的写路由受 [config-writes.ts](../../backend/src/http/config-writes.ts#L10-L33) 约束：

| 方法与路径 | 守卫／请求形态 | 主要入参与成功响应 | 典型业务／校验错误码 |
| --- | --- | --- | --- |
| `GET /v1/roles/:roleId/voice` | 无写锁；JSON | 返回 `{ voice: VoiceConfigView \| null }`（含 `reference` 摘要） | `404 ROLE_NOT_FOUND` |
| `PUT /v1/roles/:roleId/voice` | **角色守卫**；JSON 或 `multipart/form-data`（`payload`+单文件 `file`） | 覆盖保存 `baseUrl`/`protocol`/`voiceSource`/`capabilities`/`language`/`speed`/`emoAlpha`；保留原 `enabled` | `400 VOICE_BASE_URL_*`/`VOICE_SOURCE_*`/`VOICE_REFERENCE_MODE_*`、`409 ROLE_NOT_STOPPED`、`413 AUDIO_TOO_LARGE` |
| `PUT /v1/roles/:roleId/voice/enabled` | **角色守卫**；JSON `{ enabled }` | 仅更新 `enabled`，保留全部已保存语音配置 | `400 VOICE_NOT_CONFIGURED`、`409 ROLE_NOT_STOPPED` |
| `POST /v1/roles/:roleId/voice/probe` | 无写锁；JSON `{ baseUrl }` | 探测 `nowadays-tts-v1` 服务，返回 `{ probe }`（不落库） | `400 VOICE_BASE_URL_INVALID`、`502 TTS_PROBE_FAILED`/`TTS_PROTOCOL_INVALID` |
| `POST /v1/roles/:roleId/voice/reference` | **角色守卫**；multipart `file` | 上传并注册受管参考音频，返回 `201 { reference }` | `400 VOICE_REFERENCE_FILE_REQUIRED`/`AUDIO_FORMAT_UNSUPPORTED`/`AUDIO_FILE_EMPTY`、`413 AUDIO_TOO_LARGE` |
| `GET /v1/roles/:roleId/voice/references` | 无写锁 | 列出角色参考音频 `{ items }`，含 `inUse` 标记 | `404 ROLE_NOT_FOUND` |
| `DELETE /v1/roles/:roleId/voice/references/:assetId` | **角色守卫** | 删记录并清理磁盘文件，返回 `{ deleted: true, fileRemoved }` | `409 VOICE_REFERENCE_IN_USE`、`404 VOICE_REFERENCE_NOT_FOUND` |
| `POST /v1/roles/:roleId/voice/preview` | 无写锁；JSON 或 multipart | 接收 `text`、`emotion?` 与互斥的 `config?`/平铺字段；返回 `audio/wav`（`no-store`） | `400 VOICE_PREVIEW_TEXT_*`/`VOICE_REFERENCE_TEXT_REQUIRED`、`502/503/504 TTS_*` |
| `POST /v1/roles/:roleId/windows/:windowId/segments/:segmentId/speech` | 无写锁；可选 JSON `{ emotion? }` | 按已保存配置合成 `speech` 句段并返回 `audio/wav` | `409 VOICE_DISABLED`、`400 VOICE_SEGMENT_NOT_SPEAKABLE`/`VOICE_SEGMENT_EMPTY`、`409 TTS_VOICE_UNAVAILABLE` |
| `GET /v1/image-services` | 无写锁 | `{ items: ImageServiceView[] }`；凭据只返回 `credential: { status, reference, resolvable }` | — |
| `POST /v1/image-services` | 无写锁；JSON | `{ name, enabled?, config, secret? }`（`config.modelName?` 为可选默认模型名），返回 `201 { service }` | `400 INVALID_IMAGE_SERVICE_CONFIG`、`409 RESOURCE_CREDENTIAL_CONFLICT` |
| `PATCH /v1/image-services/:serviceId` | **全局守卫**；JSON | `{ name?, enabled?, config?, secret? }`（`secret: null` 清除、`undefined` 保留） | `409 ROLES_NOT_STOPPED`/`RESOURCE_CREDENTIAL_CONFLICT`/`RESOURCE_CREDENTIAL_STALE`、`404 IMAGE_SERVICE_NOT_FOUND` |
| `DELETE /v1/image-services/:serviceId` | **全局守卫** | 删除服务及密钥，返回 `{ serviceId, deleted: true }` | `409 ROLES_NOT_STOPPED`、`404 IMAGE_SERVICE_NOT_FOUND` |
| `POST /v1/image-services/probe` | 无写锁；JSON | `{ serviceId?, config, secret?, workflow? }`（草稿探测，不落库） | `409 RESOURCE_CREDENTIAL_STALE`、`401 IMAGE_SERVICE_AUTH_FAILED`、`502 IMAGE_SERVICE_UNAVAILABLE` |
| `POST /v1/image-services/:serviceId/probe` | 无写锁 | 探测已保存服务与内置 MOSS-Image 工作流节点齐全度 | `404 IMAGE_SERVICE_NOT_FOUND`、`502 IMAGE_SERVICE_UNAVAILABLE` |
| `GET /v1/roles/:roleId/scene-image` | 无写锁 | 返回 `{ settings, service, configured }`（`service` 含 `modelName?` 展示字段，不解析凭据） | `404 ROLE_NOT_FOUND` |
| `PUT /v1/roles/:roleId/scene-image` | **角色守卫**；JSON | 保存 `sceneImageSettingsSchema` 校验后的角色生图配置 | `404 IMAGE_SERVICE_NOT_FOUND`、`409 IMAGE_SERVICE_DISABLED`、`400 IMAGE_WORKFLOW_INVALID` |
| `POST /v1/roles/:roleId/scene-image/probe` | 无写锁；JSON | `{ serviceId?, serviceDraft?, workflow? }`（`serviceId` 与 `serviceDraft` 互斥） | `409 SCENE_IMAGE_NOT_CONFIGURED`、`400 IMAGE_WORKFLOW_INVALID` |
| `POST /v1/roles/:roleId/scene-image/preview` | 无写锁；JSON | `{ prompt?, outfitId?, serviceDraft?, settings?\|平铺草稿 }`；返回 `dataBase64` 样图（不入历史） | `400 IMAGE_WORKFLOW_INVALID`（含样图超 8 MiB）、`409 SCENE_IMAGE_NOT_CONFIGURED`/`IMAGE_SERVICE_DISABLED` |
| `POST /v1/roles/:roleId/scene-image/anchor-prompts` | 无写锁；JSON 或 `multipart/form-data`（`payload`+可选图片 `image`） | 调用角色已绑定且启用的 `chat_model` 视觉能力提炼 `base` 或指定 `outfitId` 的锚点提示词，支持传 `previousPrompt` 反复重生成；返回 `{ target, outfitId, prompt, source }` | `400 SCENE_IMAGE_ANCHOR_IMAGE_REQUIRED`/`IMAGE_DECODE_FAILED`/`MULTIPLE_ANCHOR_IMAGES`、`404 OUTFIT_NOT_FOUND`、`409 SCENE_IMAGE_CHAT_MODEL_REQUIRED`/`RESOURCE_MAINTENANCE`、`502 MODEL_REQUEST_FAILED` |

### 2.2 外部上游协议规范

1. **统一 TTS 协议 `nowadays-tts-v1`**（[unified-tts-client.ts](../../backend/src/tts/unified-tts-client.ts#L94-L285) · [voice-capabilities.ts](../../backend/src/domain/voice-capabilities.ts#L4-L70)）：
   - `GET /health`：须返回 `protocol: "nowadays-tts-v1"`、`service`、`model`、`ready` 及 `capabilities`（`referenceModes` 最多 32 项、`presetVoices` 布尔、`languages` 最多 32 项 BCP-47 风格代码、`speed: { min, max } | null`，且非空区间必须落在 `0.1..10` 内并包含 `1.0`）。
   - `GET /voices`：仅当 `ready === true && capabilities.presetVoices === true` 时请求，返回 `{ voices: [{ id, label }] }`。
   - `POST /tts`（`multipart/form-data`，`redirect: "manual"`）：传 `text`（<= 1000 Unicode 码点）、`mode`（`reference` 或 `preset`）、参考模式下带 `reference_mode` + `reference_audio` + 可选 `reference_text`（当 `requiresReferenceText: true` 时必填），预置模式下带 `voice_id`，以及可选 `language`、`speed`、`emotion`。上游返回 404 且机器码为 `VOICE_NOT_FOUND` / `PRESET_VOICE_NOT_FOUND`（大小写两种约定）时映射为 `409 TTS_VOICE_UNAVAILABLE`；仅接受 `Content-Type` 为 `audio/wav|audio/x-wav|audio/wave` 的非空合法 PCM WAV（`isPcmWav`），响应上限 **16 MiB**，默认探测超时 **10 秒**、合成超时 **90 秒**（[transport.ts](../../backend/src/tts/transport.ts#L10-L92)）。
2. **旧 IndexTTS 协议 `indextts`**（[indextts-client.ts](../../backend/src/tts/indextts-client.ts#L27-L86)）：
   - 仅支持参考音频来源（禁止预置），`POST /tts` 发送 JSON：`{ text, lang, spk_audio_path, emo_audio_path: null, emo_vector: null, emo_alpha, duration_factor }`；限制 `lang ∈ {zh, en, ja, es, ar}`、`speed ∈ [0.5, 2]`（映射为 `duration_factor = clamp(1 / speed, 0.5, 2)`）、`emoAlpha ∈ [0, 1]`。`spk_audio_path` 要求本地绝对路径（对未保存临时试听，后端写入系统临时目录并在 `finally` 删除，见 [voice-service.ts](../../backend/src/application/voice-service.ts#L670-L691)）。
3. **ComfyUI 协议 `comfyui`**（[comfyui-client.ts](../../backend/src/scene/comfyui-client.ts#L29-L350)）：
   - 探测：依次请求 `GET /system_stats` 与 `GET /object_info`，核对工作流 `requiredNodeTypes` 是否存在（给出 `missingNodes`、`workflowReady`），并从 `CheckpointLoaderSimple.ckpt_name`、`MOSSImageUNETLoader.unet_name`、`UNETLoader.unet_name` 提取模型下拉候选（支持数组与 `["COMBO", { options }]` 两种结构）。
   - 执行：向 `POST /prompt` 提交 `{ prompt: workflow, client_id: "nowadays" }`（HTTP 400 -> `400 IMAGE_WORKFLOW_INVALID`）；每 **750ms** 轮询 `GET /history/{promptId}`（单次 HTTP 超时 **20 秒**，整体生成默认上限 **180 秒**、可配 **5～900 秒**）；从指定 `outputNodeId` 或首个非 `type: "temp"` 输出取图，经 `GET /view?...` 读取 PNG／JPEG／WebP（服务端读图上限 **32 MiB**；测试预览图在应用层再限 **8 MiB**）。超时或取消时 best-effort 调用 `POST /queue`（`{ delete: [promptId] }`）。全部请求设置 `redirect: "manual"`，禁止跟随重定向，支持可选 `Bearer <token>`（401/403 -> `401 IMAGE_SERVICE_AUTH_FAILED`）。

### 2.3 数据存储与受管文件（物理文件名见 [config.ts](../../backend/src/bootstrap/config.ts#L68-L84) 与 [存储规范](storage-memory-and-autonomy.md#21-应用目录与-sqlite-分库规范)）

| 存储位置 | 表／目录 | 关键字段与保留规则 |
| --- | --- | --- |
| `<app-root>/data/app.sqlite`（全局库） | `image_services`（V4，[schema.ts](../../backend/src/storage/schema.ts#L112-L123)） | `service_id`、`name`、`enabled`、`config_json`（`{ protocol: "comfyui", baseUrl, modelName?, credentialRef?, timeoutMs? }`）；密钥存共享 `resource_secrets` |
| `.../roles/<roleId>/business.sqlite`（角色业务库） | `voice_assets`（V9，[schema.ts](../../backend/src/storage/schema.ts#L1320-L1330)） | 受管参考音频元数据（支持 WAV/MP3/FLAC/OGG，单文件上限 **32 MiB**），物理路径落在 `<roleDir>/voice/<assetId>.<ext>` |
| `.../roles/<roleId>/business.sqlite`（角色业务库） | `role_voice_settings`（V9→V14，[schema.ts](../../backend/src/storage/schema.ts#L1332-L1375)） | 主键 `role_id` 仅存一份配置；含 `protocol`、`voice_source`、`reference_asset_id`、`reference_mode`、`reference_text`、`preset_voice_id`、`capabilities_json`、`reference_mode_confirmed`（V12 回填修复）、`enabled`（V14 新增默认 1，`saveSettings` UPSERT 刻意跳过以保留停用态） |
| `.../roles/<roleId>/business.sqlite`（角色业务库） | `role_scene_image_settings`（V15，[schema.ts](../../backend/src/storage/schema.ts#L1477-L1495)） | 主键 `role_id`：绑定全局 `service_id`、`model_type='text2img'`、`model_path`、`base_prompt`、`negative_prompt`、`outfit_prompts_json`、`width`/`height`（`256..2048` 步长 16，默认 `1024`）、`steps`（`1..150`，默认 `25`）、`cfg`（`0..30`，默认 `2.5`）、`sampler`（默认 `er_sde`）、`scheduler`（默认 `simple`）、`seed`（`0..2147483647\|null`）、`workflow_json`、`output_node_id` |

---

## 3. 核心流程与架构约束

### 3.1 TTS 服务切换、能力确认与暂存试听

1. **地址归一化与安全边界**（[normalizeBaseUrl](../../backend/src/application/voice-service.ts#L1278-L1304)）：仅允许 `http:`/`https:`，拒绝内嵌账号密码、查询串与 `#` 片段；`UnifiedTtsClient` 均使用 `redirect: "manual"`，任何 3xx 响应立即中止并报错。
2. **切换服务／协议强制重选机制**（[voice-service.ts](../../backend/src/application/voice-service.ts#L195-L247)、[resolveSource](../../backend/src/application/voice-service.ts#L918-L1039)）：
   - 当保存或试听提交的 `baseUrl` 或 `protocol` 与已保存配置不同（`serviceChanged`）时，若原为 `preset` 则抛出 `400 VOICE_SOURCE_REQUIRED`；若原为 `reference` 则清空 `referenceMode` 并置 `referenceModeConfirmed = false`。
   - 仅当「同服务（`!serviceChanged`）且目标能力仅有 1 个参考模式且此前未处于待确认态」时才允许自动补选；换服务后连续仅改语速／语言仍会停在待确认态并被合成路径以 `VOICE_REFERENCE_MODE_REQUIRED` 拦截（V12 迁移同步回填修复老库状态）。
3. **未保存参考录音的暂存试听与原子保存**（[VoicePanel.tsx](../../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx#L246-L386) · `292 §6`）：
   - 选定本地音频后仅在前端保留 `'待上传'` 文件对象（清空上次录音残留的 `referenceText`），不预先调用 `POST /voice/reference`。
   - 点「生成试听」直接走 multipart 提交 `POST /voice/preview`，不写入 `voice_assets` 或修改 `role_voice_settings`；点「保存声音配置」走 multipart 提交 `PUT /voice`，后端在数据库事务外写盘、失败时清理文件（不留孤儿文件或半写入记录）。正在使用的音频禁止删除（`409 VOICE_REFERENCE_IN_USE`）。
4. **单份语音启停与竞态隔离**（[VoicePanel.tsx](../../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx#L340-L413) · [use-segment-voice.ts](../../desktop/desk-preview/renderer/src/conversation/use-segment-voice.ts)）：
   - 配置页通过 `inFlight` 互斥锁阻止保存与启停并发覆盖；`VOICE_DISABLED` 仅拦截按句对话合成，配置页试听始终可用。
   - 对话页 `useSegmentVoice` 收到首个 `VOICE_DISABLED` 后暂停后续自动播放与预取请求，同时保留用户手动点击某句重试的能力；切角色／切窗口时递增世代号与 `playToken`，丢弃晚到音频与错误提示。

### 3.2 生图服务凭据隔离与草稿探测

1. **凭据二选一与跨站点防护**（[image-service.ts](../../backend/src/application/image-service.ts#L113-L223) · [imageServiceSiteIdentity](../../backend/src/domain/image-service.ts#L59-L67)）：
   - 直填明文 `secret` 与 `config.credentialRef`（`env:`/`file:`）不能共存（`409 RESOURCE_CREDENTIAL_CONFLICT`）；仅保存环境变量／文件引用时可读写配置页，待真正探测或生图时再通过 `resolveConnection` 解析。
   - 当 `protocol` 与 `URL.origin` 发生变化（跨站点修改）而沿用已存储密钥或原 `credentialRef` 时，无论正式 `PATCH /v1/image-services/:id` 还是草稿 `resolveDraftConnection` 均拒绝并抛出 `409 RESOURCE_CREDENTIAL_STALE`，防止把凭据发送给新地址。
2. **先校验后停机的前端顺序与统一模型选取**（[Settings.tsx](../../desktop/desk-preview/renderer/src/pages/Settings.tsx#L1214-L1547) · [ImageModelPicker.tsx](../../desktop/desk-preview/renderer/src/components/image/ImageModelPicker.tsx) · [use-image-probe.ts](../../desktop/desk-preview/renderer/src/components/image/use-image-probe.ts) · [image-cache.js](../../desktop/desk-preview/renderer/src/components/image/image-cache.js) · `292 §7.1`）：
   - `ImageServiceDetail.save()` 必须在调用 `stopActiveRolesForGlobalWrite` 前先行校验地址格式（`http:`/`https:`）及跨站点换密确认，避免合法拒绝前误停全部活跃角色。
   - 全局设置页（创建/详情）与角色配置页共用 `ImageModelPicker`、`useImageProbe` 与按服务密钥代次隔离的 `image-cache.js` 缓存（与文本模型 `ModelNamePicker` / `useModelProbe` 对齐）：`读取模型列表` 与 `测试连接` 的状态日志在当前页相互覆盖、切页或切换服务即清零；在全局生图服务可选保存 `config.modelName` 后，角色配置切换或初选该服务时自动带入默认模型，同时允许从已探测候选下拉选择或手填覆盖。
   - 全局探测与角色草稿探测／测试出图均只读不写库；`ImagePanel` 不保留重复的内联「新建生图服务」表单，新建／修改统一跳设置页并在返回时经 `serviceRefreshVersion` 与 `serviceEpochs` 同步服务列表与失效缓存（`292-R05` 已通过独立复核；`292-R06` 原跨页场景通过后已于 [292 §9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#9-283-28-补修复核跟进与文档勘误自验292-r06-在途编辑292-r08-干净隔离环境与-doc-r01r04) 补修在途编辑阻塞，复核结论见第 5.1 节）。

3. **对话模型视觉提炼基础与服饰锚点提示词**（[scene-image-settings.ts](../../backend/src/application/scene-image-settings.ts) · [model.ts](../../backend/src/domain/model.ts) · [protocols.ts](../../backend/src/model/protocols.ts) · [google-gemini.ts](../../backend/src/model/google-gemini.ts) · [ImagePanel.tsx](../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx)）：
   - `ModelMessage`（`role: "user"`）支持可选多模态附件 `images: ModelImageAttachment[]`，在 `openai-chat`（`image_url` Data URI）、`openai-responses`（`input_image`）、`anthropic-messages`（`base64` `image`）与 `google-gemini`（`inlineData`）协议适配层统一序列化。
   - `POST /v1/roles/:roleId/scene-image/anchor-prompts` 按角色绑定的活跃对话模型（通过 `ModelBindingResolver` + `claim` / 维护锁保护）读取角色外观立绘（`target: "base"` 优先当前服饰主页立绘，其次任一主页立绘或差分；`target: "outfit"` 读取对应 `outfitId` 主页立绘或首张差分）或用户上传的单张参考图（上限 32 MiB，支持 PNG/JPEG/WebP），生成并清洗一行中文全角逗号分隔提示词；支持传入草稿中已有的 `previousPrompt` 供用户多次点击重生成并立刻在同页配合「测试生图」验证效果，结果仅写入前端草稿直至点击保存。
   - 角色配置「模型 -> 生图」面板直接展示「服饰锚点提示词」卡片区（含立绘缩略图与生成/重生成/传参考图按钮），并将负向提示词、尺寸、步数、CFG、采样器、调度器与种子收敛在「生成参数」折叠区中。

### 3.3 ComfyUI 工作流按节点类型打补丁与运行时回退策略

1. **默认工作流与节点定位**（[comfyui-workflow.ts](../../backend/src/scene/comfyui-workflow.ts#L27-L293)）：
   - 内置 11 节点 `MOSS_IMAGE_WORKFLOW` 适配 ComfyUI 0.45+ 原生节点与 Spectrum 加速：`UNETLoader`（`unet_name: "moss_image_sft_int8_convrot.safetensors"`）+ `CLIPLoader`（`clip_name: "qwen3.5_9b_w4a8_gptq.safetensors"`, `type: "moss_image"`）+ `VAELoader`（`vae_name: "flux2-vae_small.safetensors"`）→ `SpectrumMOSSImageManual` → `SkipLayerGuidanceDiTSimple`（`single_layers: "22"`）→ 双 `CLIPTextEncode` → `EmptyFlux2LatentImage`（`1024×1024`）→ `KSampler`（`steps: 25`、`cfg: 2.5`、`er_sde`、`simple`、`denoise: 1`）→ `VAEDecode` → `SaveImage`。
   - `applyWorkflowParams` 深拷贝工作流后按 `class_type`（而非写死节点 id）匹配打补丁，且**只修改节点 `inputs` 中已存在的键**，防止把未知键塞给自定义工作流引起 ComfyUI 400 校验错误：加载器优先级 `MOSSImageHFLoader.model_path` > `MOSSImageUNETLoader.unet_name` > `CheckpointLoaderSimple.ckpt_name` > `UNETLoader.unet_name`；采样器兼容 `KSampler` / `KSamplerAdvanced`（`seed` / `noise_seed`），并沿 `positive` / `negative` 连线追踪写入对应 `CLIPTextEncode.text`；尺寸写入首个含 `width`、`height` 的 `Empty*` 潜空间节点；输出优先使用指定 `outputNodeId` 否则查找 `SaveImage`。
2. **提示词拼装与快照隔离**（[comfyui-generator.ts](../../backend/src/scene/comfyui-generator.ts#L49-L259)）：
   - 全景／人物提示词按 `basePrompt → outfitPrompts[outfitId] → 场景描述` 过滤空串并以中文逗号拼接（`buildScenePrompt`）；当过场图 `layerMode === "background"` 时只保留场景描述，不注入人物与服饰锚点（`composeSceneImagePrompt`）。
   - `ConfiguredSceneImageGenerator` 在角色**未配置**生图数据时回退占位生成器，以保留离线原型能力；一旦存在 `role_scene_image_settings`（或任务快照中锁定了配置），若服务被删除（`409 SCENE_IMAGE_NOT_CONFIGURED`）、停用（`409 IMAGE_SERVICE_DISABLED`）或执行前站址发生跨站变更（`409 SCENE_IMAGE_SERVICE_CHANGED`），必须明确失败，不得静默退回占位图。

---

## 4. 已验证范围、未实现功能与可执行检查

### 4.1 已验证范围与限制（离线／本地假端点）

- **后端单元测试与离线验收**：[222](../archive/03-appearance-and-performance/222-tts-unified-independent-review.md)（`v10→v12` 迁移回填、重定向拦截、双形状试听与语速 `0.1..10` 范围）、[247](../archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md)／[249](../archive/04-role-settings-and-media/249-role-voice-toggle-review-fixes.md)（语音启停保留配置、切换防误报）、[250](../archive/04-role-settings-and-media/250-comfyui-independent-review.md)／[251](../archive/04-role-settings-and-media/251-comfyui-review-fixes.md)（ComfyUI 探测、超时队列清理、凭据换站拦截、任务配置快照）及 [292 §6～§7](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) 均在本机假 HTTP 端点与 `accept-offline.mjs`（`realServiceCalls: 0`）下通过验证。
- **桌面端全链路检查**：[workflow-real-backend-chain-check.cjs](../../desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs) 与 [settings-workspace-check.cjs](../../desktop/desk-preview/tests/settings-workspace-check.cjs) 通过真实 Electron + 真实本机后端验证了草稿探测、测试生图、语音暂存试听与原子 multipart 保存、停用保留与对话按句播报／手动过场图联调（外部模型、TTS 与 ComfyUI 为本地假服务端点）。

### 4.2 未实现或待设计功能（来自 `246 §6` 与 `248 §10`）

1. **ComfyUI 图生图与服饰锚点图上传**（[248 §10](../archive/04-role-settings-and-media/248-comfyui-adaptation.md#10-未完成与后续)）：`scene_image_model_types` 目前仅包含 `text2img`，工作流尚无加载角色／服饰参考图（`LoadImage`）与对应的资产存储／绑定关系；该项作为后续生图能力单列，`CG-04` 则按 [223](../archive/03-appearance-and-performance/223-conversation-performance-development-guide.md) 指过场图增量独立复核与真实生图适配（见 [STATUS.md](../STATUS.md)）。
2. **对话页语音停用状态同步**（[246 §6](../archive/04-role-settings-and-media/246-role-voice-toggle.md#6-未完成与后续)）：对话页顶栏／菜单目前不展示「语音已停用」常驻标识；在设置页重新启用语音后，已打开的对话窗口需通过手动点播、切角色或刷新清除 `voiceDisabled` 缓存，尚未按实时配置版本号自动刷新并发起预取。
3. **未配置真实生图服务失败策略**（[248 §10](../archive/04-role-settings-and-media/248-comfyui-adaptation.md#10-未完成与后续)）：正式发布前需按产品开关将 `ConfiguredSceneImageGenerator` 在无配置时的默认行为从「回退占位图」切换或可选切换为「提示先配置生图服务」。
4. **多模型扩展工作流模板**：Flux / SDXL 等模型虽可通过自定义工作流 API JSON 接入，但尚无内置模板选择器。

### 4.3 尚未实机验证（必须真实外部部署联调）

- **真实 TTS 引擎**：真实 IndexTTS 2.5 与 `nowadays-tts-v1` 桥接下的中文／多语种长句、情绪参数（`emotion`/`emoAlpha`）、克隆参考音频首字延迟与设备输出播放效果。
- **真实 ComfyUI + MOSS-Image**：本地大模型目录（`MOSS-Image-Base`）加载、显卡 VRAM 峰值与实际推理耗时、长等待取消是否真实清出 ComfyUI 队列、并发任务与 8 MiB／32 MiB 上限实测。

### 4.4 可执行验证命令

```powershell
# 1. 后端类型检查与语音／ComfyUI 定向单测（Node 24）
cd backend
npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit
npx -y node@24 --import tsx --test tests/p8-voice.test.ts tests/p9-tts-unified.test.ts tests/p13-comfyui.test.ts
npx -y node@24 scripts/accept-offline.mjs

# 2. 桌面前端检查、构建与纯逻辑单测
cd desktop/desk-preview/renderer
npm run check
npm run build
cd ..
npx -y node@24 --test tests/voice-config.test.cjs tests/image-config.test.cjs

# 3. 真实本机后端 + Electron 设置／对话全链路检查（仓库根目录，外接假 TTS/ComfyUI 端点）
npx -y node@24 desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs
```

---

## 5. 已知缺陷、源文件清单与归档追溯

### 5.1 复核缺陷处理状态（均与 [role-config-and-activity.md](role-config-and-activity.md#53-已补修待独立复核与未闭环项见-statusmd283-27-与-292-8) 联动登记）

| 编号 / 来源 | 问题位置与处理摘要 | 当前状态 |
| --- | --- | --- |
| `292-R05`（[283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#271-待修复项)） | [ImagePanel.tsx](../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx#L308-L354) `save()` 先检查本地启用态并在 `guardWrite` 停机前重查 `/v1/image-services`，停用时直接报错 `IMAGE_SERVICE_DISABLED` | **已独立复核通过**（[283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)） |
| `292-R06`（[283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#271-待修复项) · [§28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)） | [ImagePanel.tsx](../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx#L149-L505) 与 [imageServiceSnapshotKey](../../desktop/desk-preview/renderer/src/image-config.js#L195-L210) 为探测／样图绑定快照键并在 [292 §9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#9-283-28-补修复核跟进与文档勘误自验292-r06-在途编辑292-r08-干净隔离环境与-doc-r01r04) 新增 `invalidateProbe`／`invalidatePreview`（`#L149-L165`、`#L295-L306`、`#L606-L618`），跨页失效或在途修改测试描述／服饰／草稿时同步释放忙态按钮并拒收晚到响应 | 原跨页失效场景已通过 [283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)；在途编辑按钮恢复通过 [283 §29](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) |
| `292-R07`（[283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#271-待修复项)） | [scene-image-settings.ts](../../backend/src/application/scene-image-settings.ts#L155-L195) 的 `preview()` 对非空 `outfitId` 调用 `AppearanceStore.getOutfit(outfitId)` 核验当前角色下未删除服饰，否则生图前拒绝并返回 `404 OUTFIT_NOT_FOUND` | **已独立复核通过**（[283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)） |

### 5.2 核心实现文件清单

- **后端域模型、路由与输入验证**：
  - [voice.ts](../../backend/src/domain/voice.ts) · [voice-capabilities.ts](../../backend/src/domain/voice-capabilities.ts) · [image-service.ts](../../backend/src/domain/image-service.ts) · [scene-image-settings.ts](../../backend/src/domain/scene-image-settings.ts) · [model.ts](../../backend/src/domain/model.ts) · [errors.ts](../../backend/src/domain/errors.ts)
  - [voice-routes.ts](../../backend/src/http/voice-routes.ts) · [image-service-routes.ts](../../backend/src/http/image-service-routes.ts) · [config-writes.ts](../../backend/src/http/config-writes.ts) · [schemas.ts](../../backend/src/http/schemas.ts)
- **后端应用、协议客户端与存储**：
  - [voice-service.ts](../../backend/src/application/voice-service.ts) · [image-service.ts](../../backend/src/application/image-service.ts) · [scene-image-settings.ts](../../backend/src/application/scene-image-settings.ts) · [audio-inspect.ts](../../backend/src/application/audio-inspect.ts)
  - [transport.ts](../../backend/src/tts/transport.ts) · [unified-tts-client.ts](../../backend/src/tts/unified-tts-client.ts) · [indextts-client.ts](../../backend/src/tts/indextts-client.ts)
  - [protocols.ts](../../backend/src/model/protocols.ts) · [google-gemini.ts](../../backend/src/model/google-gemini.ts) · [comfyui-client.ts](../../backend/src/scene/comfyui-client.ts) · [comfyui-workflow.ts](../../backend/src/scene/comfyui-workflow.ts) · [comfyui-generator.ts](../../backend/src/scene/comfyui-generator.ts)
  - [voice-store.ts](../../backend/src/storage/voice-store.ts) · [image-service-store.ts](../../backend/src/storage/image-service-store.ts) · [scene-image-settings-store.ts](../../backend/src/storage/scene-image-settings-store.ts) · [schema.ts](../../backend/src/storage/schema.ts)
- **桌面前端渲染器与纯逻辑单测**：
  - [VoicePanel.tsx](../../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx) · [voice-config.js](../../desktop/desk-preview/renderer/src/voice-config.js) · [ImagePanel.tsx](../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx) · [ImageModelPicker.tsx](../../desktop/desk-preview/renderer/src/components/image/ImageModelPicker.tsx) · [use-image-probe.ts](../../desktop/desk-preview/renderer/src/components/image/use-image-probe.ts) · [image-cache.js](../../desktop/desk-preview/renderer/src/components/image/image-cache.js) · [image-config.js](../../desktop/desk-preview/renderer/src/image-config.js) · [Settings.tsx](../../desktop/desk-preview/renderer/src/pages/Settings.tsx) · [use-segment-voice.ts](../../desktop/desk-preview/renderer/src/conversation/use-segment-voice.ts)
  - [voice-config.test.cjs](../../desktop/desk-preview/tests/voice-config.test.cjs) · [image-config.test.cjs](../../desktop/desk-preview/tests/image-config.test.cjs) · [p8-voice.test.ts](../../backend/tests/p8-voice.test.ts) · [p9-tts-unified.test.ts](../../backend/tests/p9-tts-unified.test.ts) · [p13-comfyui.test.ts](../../backend/tests/p13-comfyui.test.ts)

### 5.3 归档与复核文档追溯

- 语音接入方案、实现与复核：[218 首轮实施](../archive/03-appearance-and-performance/218-tts-implementation-record.md) · [219 IndexTTS 规范](../archive/03-appearance-and-performance/219-indextts-integration-spec.md) · [220 TTS 统一规范](../archive/03-appearance-and-performance/220-tts-unified-integration.md) · [221 统一接入实施](../archive/03-appearance-and-performance/221-tts-unified-implementation.md) · [222 独立复核（v12 回填关闭 R01～R04）](../archive/03-appearance-and-performance/222-tts-unified-independent-review.md#221-第-11-节-v12-回填独立复验)
- 角色语音设置、启停与复核：[243 语音设置](../archive/04-role-settings-and-media/243-voice-settings-desktop.md) · [246 语音启停](../archive/04-role-settings-and-media/246-role-voice-toggle.md) · [247 独立复核](../archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md) · [249 补修](../archive/04-role-settings-and-media/249-role-voice-toggle-review-fixes.md)
- 生图 ComfyUI 适配、草稿试听与复核：[248 ComfyUI 适配](../archive/04-role-settings-and-media/248-comfyui-adaptation.md) · [250 独立复核](../archive/04-role-settings-and-media/250-comfyui-independent-review.md#251-第-5-节补修独立复验) · [251 补修](../archive/04-role-settings-and-media/251-comfyui-review-fixes.md) · [292 §6～§7](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) · [283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)
