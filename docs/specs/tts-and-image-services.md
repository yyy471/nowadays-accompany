# TTS 与生图服务接入规范

> **状态**：现行规范 · **适用范围**：`apps/backend/src/{tts,scene,model,http,application,domain,storage}` 与 `apps/desktop/renderer/src/{components/voice,components/image,voice-config.js,image-config.js,pages/Settings.tsx}`  
> **覆盖关系**：整合 [218](../archive/03-appearance-and-performance/218-tts-implementation-record.md)～[222](../archive/03-appearance-and-performance/222-tts-unified-independent-review.md)、[243](../archive/04-role-settings-and-media/243-voice-settings-desktop.md)、[246](../archive/04-role-settings-and-media/246-role-voice-toggle.md)、[247](../archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md)、[248](../archive/04-role-settings-and-media/248-comfyui-adaptation.md)、[250](../archive/04-role-settings-and-media/250-comfyui-independent-review.md)、[251](../archive/04-role-settings-and-media/251-comfyui-review-fixes.md) 与 [292 §6～§7](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) 的语音与生图接入现行规则。角色活动写锁见 [角色配置与活动守卫规范](./role-config-and-activity.md)，过场图任务与按句播报消费见 [对话演出、输入状态、SSE 与过场图规范](./conversation-performance-and-scene-images.md)，待办与复核总表见 [STATUS.md](../STATUS.md)。

---

## 1. 适用范围、上游决定与边界分工

### 1.1 适用范围

1. **全局语音服务与角色语音接入**：全局 `voice_services` CRUD 与探测、`nowadays-tts-v1` 服务能力探测、多引擎选择与预置／参考克隆双音源、旧 `indextts` 本机桥接兼容、角色单份语音配置保存与启停、受管参考音频资产与临时暂存试听。
2. **全局生图服务管理（ComfyUI）**：全局 `image_services` CRUD、直填密钥或 `env:`／`file:` 引用与换站重验、连接与工作流节点探测（含草稿探测）。
3. **角色文生图／图生图配置、参考图管理与推理生成**：`role_scene_image_settings`（含 `model_type: "text2img" | "img2img"` 与自动过场图字段）、`role_scene_references` 服饰参考图存取、内置 MOSS-Image 默认工作流、自定义 ComfyUI 工作流按 `class_type` 打补丁与 `LoadImage`/纯背景分支隔离、角色草稿探测／测试出图及过场图生成时的运行时解析边界。

### 1.2 边界分工（不在此处重复）

- **角色停止三态、配置写入守卫与设置页导航骨架**：写接口前置活动检查（`ROLE_CONFIG_WRITES` / `GLOBAL_CONFIG_WRITES`）、停启与写前暂停交互、全局设置页模型分类三栏布局（`['模型', '语音', '生图']`）与跨角色草稿切换提示，统一见 [角色配置、全局资源与活动守卫规范](./role-config-and-activity.md)。
- **对话句段消费与过场图任务调度**：按句切分、对话页 `POST /speech` 防抖与缓存、旁白跳过、`scene_image_tasks` 创建、历史服饰与图层消费边界，统一见 [对话演出、输入状态、SSE 与过场图规范](./conversation-performance-and-scene-images.md)。
- **桌面视觉令牌与组件样式约束**：见 [前端设计规范](./frontend-design-system.md)。

### 1.3 上游产品决定（[161 持续决策记录](../161-digital-life-direction-decisions.md)）

| 决定编号 | 核心约束 | 当前实现边界 |
| --- | --- | --- |
| [DL-139](../161-digital-life-direction-decisions.md#dl-139-首版-tts-采用-indextts) | 首版 TTS 引擎为 IndexTTS 本机 HTTP 桥接 | 保留 `protocol: "indextts"` 向后兼容 |
| [DL-140](../161-digital-life-direction-decisions.md#dl-140-tts-统一接入音色克隆与预置音色) | 同一套界面随服务能力切换参考克隆与预置音色；试听与配置不写多余历史 | `nowadays-tts-v1` 协议按 `/health` 声明动态渲染与校验 |
| [DL-143](../161-digital-life-direction-decisions.md#dl-143-统一语音桥接支持可选情绪指令) | 统一语音桥接支持可选情绪指令（`emotion` 不自动映射立绘差分名） | 句段标注写入 `message_segments.voice_emotion`（仅 `speech`）；`/speech` 自动消费并等待标注障栅，`/preview` 与 `/speech` 均支持可选 `emotion` |
| [DL-149](../161-digital-life-direction-decisions.md#dl-149-角色语音只保留当前一份配置) | 每个角色只保留当前一份语音配置；停用保留原配置，新配置直接覆盖 | `role_voice_settings` 主键 `role_id`；`PUT /voice` 不改 `enabled` |
| [DL-150](../161-digital-life-direction-decisions.md#dl-150-生图首版适配-comfyui先测-moss-image) | 生图首版适配 ComfyUI，先测 MOSS-Image；按节点类型打参数补丁 | 已支持 `modelType: "text2img" | "img2img"` 与自定义工作流 `LoadImage` 服饰参考图上传；`CG-04` 按 [223](../archive/03-appearance-and-performance/223-conversation-performance-development-guide.md) 指过场图增量独立复核与真实生图适配 |
| [DL-152](../161-digital-life-direction-decisions.md#dl-152-全局管理语音服务角色从设置中选择服务并配置专属音色与试听) | 设置「模型 -> 语音」全局管理语音服务；角色选择全局服务并配音色 | `app.sqlite`（APP V9）维护全局 `voice_services`；`role_voice_settings`（V20）增 `service_id` 且启动自动回填已有角色地址；保留直连 HTTP API 向后兼容 |

---

## 2. 接口契约、上游协议与数据归属

### 2.1 应用 HTTP 路由

语音与生图路由分别注册于 [voice-service-routes.ts](../../apps/backend/src/http/voice-service-routes.ts)、[voice-routes.ts](../../apps/backend/src/http/voice-routes.ts) 与 [image-service-routes.ts](../../apps/backend/src/http/image-service-routes.ts)。角色守卫由 [config-writes.ts](../../apps/backend/src/http/config-writes.ts) 分类；全局服务改删按 [语音／生图服务维护窗口](./role-config-and-activity.md#321-语音生图服务维护窗口) 协调。

| 方法与路径 | 守卫／请求形态 | 主要入参与成功响应 | 典型业务／校验错误码 |
| --- | --- | --- | --- |
| `GET /v1/voice-services` | 无写锁 | `{ items: VoiceServiceView[] }` | — |
| `POST /v1/voice-services` | 无写锁；JSON | `{ name, enabled?, config }`（`config: { protocol, baseUrl, defaultEngine? }`），返回 `201 { service }` | `400 INVALID_VOICE_SERVICE_CONFIG`、`400 VOICE_BASE_URL_INVALID` |
| `PATCH /v1/voice-services/:serviceId` | **依赖维护**；JSON | `{ name?, enabled?, config? }`，返回 `{ service, maintenance: { connectionChanged, pausedRoleIds } }` | `409 MEDIA_SERVICE_MAINTENANCE` / `ROLES_NOT_STOPPED`、`404 VOICE_SERVICE_NOT_FOUND`、`400 INVALID_VOICE_SERVICE_CONFIG` |
| `DELETE /v1/voice-services/:serviceId` | **依赖检查** | 删除全局语音服务（仅删全局表；角色已保存配置保留以供重选），返回 `{ serviceId, deleted: true }` | `409 MEDIA_SERVICE_IN_USE` / `MEDIA_SERVICE_MAINTENANCE`、`404 VOICE_SERVICE_NOT_FOUND` |
| `POST /v1/voice-services/probe` · `POST /v1/voice-services/:serviceId/probe` | 无写锁；JSON | 探测 `nowadays-tts-v1` 全局草稿 `{ config: { protocol, baseUrl } }` 或已保存服务；拒绝旧 `indextts` | `400 VOICE_PROBE_UNSUPPORTED`/`VOICE_BASE_URL_INVALID`、`404 VOICE_SERVICE_NOT_FOUND`、`502 TTS_PROBE_FAILED` |
| `GET /v1/roles/:roleId/voice` | 无写锁；JSON | 返回 `{ voice: VoiceConfigView \| null }`（含 `serviceId?`、`service?` 与 `reference` 摘要） | `404 ROLE_NOT_FOUND` |
| `PUT /v1/roles/:roleId/voice` | **角色守卫**；JSON 或 `multipart/form-data`（`payload`+单文件 `file`） | 覆盖保存（推荐传 `serviceId`，亦兼容直连 `baseUrl`/`protocol`）+ `ttsEngine`/`voiceSource`/`capabilities`/`language`/`speed`/`emoAlpha`；保留原 `enabled` | `404 VOICE_SERVICE_NOT_FOUND`、`409 VOICE_SERVICE_DISABLED`、`400 VOICE_BASE_URL_*`/`VOICE_SOURCE_*`/`VOICE_REFERENCE_MODE_*`/`VOICE_ENGINE_UNSUPPORTED`、`409 ROLE_NOT_STOPPED`、`413 AUDIO_TOO_LARGE` |
| `PUT /v1/roles/:roleId/voice/enabled` | **角色守卫**；JSON `{ enabled }` | 仅更新 `enabled`，保留全部已保存语音配置 | `400 VOICE_NOT_CONFIGURED`、`409 ROLE_NOT_STOPPED` |
| `POST /v1/roles/:roleId/voice/probe` | 无写锁；JSON `{ serviceId }` 或 `{ baseUrl }` | 探测 `nowadays-tts-v1` 服务，返回 `{ probe }`（含纯 `capabilities` 及可选 `engines`、`defaultEngine`，不落库） | `404 VOICE_SERVICE_NOT_FOUND`、`400 VOICE_PROBE_UNSUPPORTED`/`VOICE_BASE_URL_INVALID`、`502 TTS_PROBE_FAILED`/`TTS_PROTOCOL_INVALID` |
| `POST /v1/roles/:roleId/voice/reference` | **角色守卫**；multipart `file` | 上传并注册受管参考音频，返回 `201 { reference }` | `400 VOICE_REFERENCE_FILE_REQUIRED`/`AUDIO_FORMAT_UNSUPPORTED`/`AUDIO_FILE_EMPTY`、`413 AUDIO_TOO_LARGE` |
| `GET /v1/roles/:roleId/voice/references` | 无写锁 | 列出角色参考音频 `{ items }`，含 `inUse` 标记 | `404 ROLE_NOT_FOUND` |
| `DELETE /v1/roles/:roleId/voice/references/:assetId` | **角色守卫** | 删记录并清理磁盘文件，返回 `{ deleted: true, fileRemoved }` | `409 VOICE_REFERENCE_IN_USE`、`404 VOICE_REFERENCE_NOT_FOUND` |
| `POST /v1/roles/:roleId/voice/preview` | 无写锁；JSON 或 multipart | 接收 `text`、`emotion?` 与互斥的 `config?`/平铺字段（含 `ttsEngine?`）；返回 `audio/wav`（`no-store`） | `400 VOICE_PREVIEW_TEXT_*`/`VOICE_REFERENCE_TEXT_REQUIRED`/`VOICE_ENGINE_UNSUPPORTED`、`502/503/504 TTS_*` |
| `POST /v1/roles/:roleId/windows/:windowId/segments/:segmentId/speech` | 无写锁；可选 JSON `{ emotion? }` | 按已保存配置（优先请求 `emotion`，否则等待并读取 `segment.voice_emotion`）合成 `speech` 句段并返回 `audio/wav` | `409 VOICE_DISABLED`、`400 VOICE_SEGMENT_NOT_SPEAKABLE`/`VOICE_SEGMENT_EMPTY`、`409 TTS_VOICE_UNAVAILABLE` |
| `GET /v1/image-services` | 无写锁 | `{ items: ImageServiceView[] }`；凭据只返回 `credential: { status, reference, resolvable }` | — |
| `POST /v1/image-services` | 无写锁；JSON | `{ name, enabled?, config, secret? }`（`config.modelName?` 为可选默认模型名），返回 `201 { service }` | `400 INVALID_IMAGE_SERVICE_CONFIG`、`409 RESOURCE_CREDENTIAL_CONFLICT` |
| `PATCH /v1/image-services/:serviceId` | **依赖维护**；JSON | `{ name?, enabled?, config?, secret? }`（`secret: null` 清除、`undefined` 保留），返回 `{ service, maintenance: { connectionChanged, pausedRoleIds } }` | `409 MEDIA_SERVICE_MAINTENANCE` / `ROLES_NOT_STOPPED` / `RESOURCE_CREDENTIAL_CONFLICT` / `RESOURCE_CREDENTIAL_STALE`、`404 IMAGE_SERVICE_NOT_FOUND` |
| `DELETE /v1/image-services/:serviceId` | **依赖检查** | 删除服务及密钥，返回 `{ serviceId, deleted: true }` | `409 MEDIA_SERVICE_IN_USE` / `MEDIA_SERVICE_MAINTENANCE`、`404 IMAGE_SERVICE_NOT_FOUND` |
| `POST /v1/image-services/probe` | 无写锁；JSON | `{ serviceId?, config, secret?, workflow? }`（草稿探测，不落库） | `409 RESOURCE_CREDENTIAL_STALE`、`401 IMAGE_SERVICE_AUTH_FAILED`、`502 IMAGE_SERVICE_UNAVAILABLE` |
| `POST /v1/image-services/:serviceId/probe` | 无写锁 | 探测已保存服务与内置 MOSS-Image 工作流节点齐全度 | `404 IMAGE_SERVICE_NOT_FOUND`、`502 IMAGE_SERVICE_UNAVAILABLE` |
| `GET /v1/roles/:roleId/scene-image` | 无写锁 | 返回 `{ settings, service, configured }`（`service` 含 `modelName?` 展示字段，不解析凭据） | `404 ROLE_NOT_FOUND` |
| `PUT /v1/roles/:roleId/scene-image` | **角色守卫**；JSON | 保存 `sceneImageSettingsSchema` 校验后的角色生图配置（`img2img` 须导入包含单一 `LoadImage` 上游与至多一个纯背景分支的自定义工作流） | `404 IMAGE_SERVICE_NOT_FOUND`、`409 IMAGE_SERVICE_DISABLED`、`400 IMAGE_WORKFLOW_INVALID`、`400 SCENE_REFERENCE_WORKFLOW_REQUIRED` |
| `GET /v1/roles/:roleId/scene-image/references` | 无写锁；— | 列出角色 `role_scene_references` 中全部服饰的 `img2img` 参考图元数据 | — |
| `GET/PUT/DELETE /v1/roles/:roleId/scene-image/outfits/:outfitId/reference` | `PUT/DELETE` 须**角色守卫**；`PUT` 为 `multipart/form-data`（单文件 `image`） | 读取／上传替换／删除指定服饰的 `img2img` 参考图（校验解码与 `<= 8 MiB` 上限） | `400 SCENE_REFERENCE_REQUIRED`、`404 OUTFIT_NOT_FOUND`、`413 SCENE_REFERENCE_TOO_LARGE`、`404 SCENE_REFERENCE_MISSING` |
| `POST /v1/roles/:roleId/scene-image/probe` | 无写锁；JSON | `{ serviceId?, serviceDraft?, workflow? }`（`serviceId` 与 `serviceDraft` 互斥） | `409 SCENE_IMAGE_NOT_CONFIGURED`、`400 IMAGE_WORKFLOW_INVALID` |
| `POST /v1/roles/:roleId/scene-image/preview` | 无写锁；JSON | `{ prompt?, outfitId?, serviceDraft?, settings?\|平铺草稿 }`（`settings` 兼容完整 `autoGenerateEnabled`/`autoCooldownMinutes` 表单字段）；返回 `dataBase64` 样图（不入历史） | `400 IMAGE_WORKFLOW_INVALID`（含样图超 8 MiB）、`409 SCENE_IMAGE_NOT_CONFIGURED`/`IMAGE_SERVICE_DISABLED`、`400 SCENE_REFERENCE_WORKFLOW_REQUIRED`、`422 SCENE_REFERENCE_MISSING` |
| `POST /v1/roles/:roleId/scene-image/anchor-prompts` | 无写锁；JSON 或 `multipart/form-data`（`payload`+可选图片 `image`） | 调用角色已绑定且启用的 `chat_model` 视觉能力提炼 `base` 或指定 `outfitId` 的锚点提示词，支持传 `previousPrompt` 反复重生成；返回 `{ target, outfitId, prompt, source }` | `400 SCENE_IMAGE_ANCHOR_IMAGE_REQUIRED`/`IMAGE_DECODE_FAILED`/`MULTIPLE_ANCHOR_IMAGES`、`404 OUTFIT_NOT_FOUND`、`409 SCENE_IMAGE_CHAT_MODEL_REQUIRED`/`RESOURCE_MAINTENANCE`、`502 MODEL_REQUEST_FAILED` |

### 2.2 外部上游协议规范

1. **统一 TTS 协议 `nowadays-tts-v1`**（[unified-tts-client.ts](../../apps/backend/src/tts/unified-tts-client.ts) · [voice-capabilities.ts](../../apps/backend/src/domain/voice-capabilities.ts)）：
   - `GET /health`：须返回 `protocol: "nowadays-tts-v1"`、`service`、`model`、`ready` 及严格 `capabilities`（`referenceModes` 最多 32 项、`presetVoices` 布尔、`languages` 最多 32 项 BCP-47 风格代码、`speed: { min, max } | null`，且非空区间必须落在 `0.1..10` 内并包含 `1.0`）；同时支持顶层可选 `engines`（各子引擎 `{ ready, active, onDemand }` 状态映射，独立于 `capabilities` 外以保持严格校验兼容）与 `defaultEngine`。
   - `GET /voices`：当 `capabilities.presetVoices === true` 且 `ready === true` 或 `engines` 含按需引擎时请求，返回 `{ voices: [{ id, label }] }`（多引擎桥接支持带前缀如 `cosy:` / `index:` 的音色 ID）。
   - `POST /tts`（`multipart/form-data`，`redirect: "manual"`）：传 `text`（<= 1000 Unicode 码点）、`mode`（`reference` 或 `preset`）、可选 `engine`（指定子引擎）、参考模式下带 `reference_mode` + `reference_audio` + 可选 `reference_text`（当 `requiresReferenceText: true` 时必填），预置模式下带 `voice_id`，以及可选 `language`、`speed`、`emotion`。上游返回 404 且机器码为 `VOICE_NOT_FOUND` / `PRESET_VOICE_NOT_FOUND`（大小写两种约定）时映射为 `409 TTS_VOICE_UNAVAILABLE`；仅接受 `Content-Type` 为 `audio/wav|audio/x-wav|audio/wave` 的非空合法 PCM WAV（`isPcmWav`），响应上限 **16 MiB**，默认探测超时 **10 秒**、合成超时 **180 秒**（兼容按需 GPU 引擎冷切换，见 [transport.ts](../../apps/backend/src/tts/transport.ts)）。
2. **旧 IndexTTS 协议 `indextts`**（[indextts-client.ts](../../apps/backend/src/tts/indextts-client.ts#L27-L86)）：
   - 仅支持参考音频来源（禁止预置），`POST /tts` 发送 JSON：`{ text, lang, spk_audio_path, emo_audio_path: null, emo_vector: null, emo_alpha, duration_factor }`；限制 `lang ∈ {zh, en, ja, es, ar}`、`speed ∈ [0.5, 2]`（映射为 `duration_factor = clamp(1 / speed, 0.5, 2)`）、`emoAlpha ∈ [0, 1]`。`spk_audio_path` 要求本地绝对路径（对未保存临时试听，后端写入系统临时目录并在 `finally` 删除，见 [voice-service.ts](../../apps/backend/src/application/media/voice-service.ts#L670-L691)）。
   - `POST /tts` 使用手动重定向模式。遇到 HTTP 3xx 时中止上游，返回 `TTS_SYNTHESIS_FAILED`。
3. **ComfyUI 协议 `comfyui`**（[comfyui-client.ts](../../apps/backend/src/scene/comfyui-client.ts#L29-L350)）：
   - HTTP 正文按声明长度和流式累计字节限制。图片上限 32 MiB，JSON 上限 16 MiB。超限时提前关闭正文流。
   - 探测：依次请求 `GET /system_stats` 与 `GET /object_info`，核对工作流 `requiredNodeTypes` 是否存在（给出 `missingNodes`、`workflowReady`），并从 `CheckpointLoaderSimple.ckpt_name`、`MOSSImageUNETLoader.unet_name`、`UNETLoader.unet_name` 提取模型下拉候选（支持数组与 `["COMBO", { options }]` 两种结构）。
   - 执行：当 `img2img` 含参考图分支时先经 `POST /upload/image` 上传参考图并将文件名与宽高写入 `LoadImage`/`ImageScale`；向 `POST /prompt` 提交 `{ prompt: workflow, client_id: "nowadays" }`（HTTP 400 -> `400 IMAGE_WORKFLOW_INVALID`）；每 **750ms** 轮询 `GET /history/{promptId}`（单次 HTTP 超时 **20 秒**，整体生成默认上限 **180 秒**、可配 **5～900 秒**）；从指定 `outputNodeId` 或首个非 `type: "temp"` 输出取图，经 `GET /view?...` 读取 PNG／JPEG／WebP（服务端读图上限 **32 MiB**；测试预览图在应用层再限 **8 MiB**）。超时或取消时 best-effort 调用 `POST /queue`（`{ delete: [promptId] }`）。全部请求设置 `redirect: "manual"`，禁止跟随重定向，支持可选 `Bearer <token>`（401/403 -> `401 IMAGE_SERVICE_AUTH_FAILED`）。

### 2.3 数据存储与受管文件（物理文件名见 [config.ts](../../apps/backend/src/bootstrap/config.ts#L68-L84) 与 [存储规范](./storage-memory-and-autonomy.md#21-应用目录与-sqlite-分库规范)）

| 存储位置 | 表／目录 | 关键字段与保留规则 |
| --- | --- | --- |
| `<app-root>/data/app.sqlite`（全局库） | `voice_services`（APP V9，[schema.ts](../../apps/backend/src/storage/core/schema.ts)） | `service_id`、`name`、`enabled`、`config_json`（`{ protocol: "nowadays-tts-v1" \| "indextts", baseUrl, defaultEngine? }`）；支持启动时从已有角色配置 `backfillFromRoles` 自动创建并关联 |
| `<app-root>/data/app.sqlite`（全局库） | `image_services`（V4，[schema.ts](../../apps/backend/src/storage/core/schema.ts)） | `service_id`、`name`、`enabled`、`config_json`（`{ protocol: "comfyui", baseUrl, modelName?, credentialRef?, timeoutMs? }`）；密钥存共享 `resource_secrets` |
| `.../roles/<roleId>/business.sqlite`（角色业务库） | `voice_assets`（V9，[schema.ts](../../apps/backend/src/storage/core/schema.ts)） | 受管参考音频元数据（支持 WAV/MP3/FLAC/OGG，单文件上限 **32 MiB**），物理路径落在 `<roleDir>/voice/<assetId>.<ext>` |
| `.../roles/<roleId>/business.sqlite`（角色业务库） | `role_voice_settings`（V9→V20，[schema.ts](../../apps/backend/src/storage/core/schema.ts)） | 主键 `role_id` 仅存一份配置；含 `service_id`（V20 新增，可空兼容直连与删后重选）、`protocol`、`base_url`、`voice_source`、`reference_asset_id`、`reference_mode`、`reference_text`、`preset_voice_id`、`capabilities_json`（严格保持纯净）、`tts_engine`、`engines_json`、`default_engine`（V19 新增多引擎持久化列）、`reference_mode_confirmed`（V12 回填修复）、`enabled`（V14 新增默认 1，`saveSettings` UPSERT 刻意跳过以保留停用态） |
| `.../roles/<roleId>/business.sqlite`（角色业务库） | `role_scene_image_settings`（V26，[schema.ts](../../apps/backend/src/storage/core/schema.ts)）、`role_scene_references`（V27） | `role_scene_image_settings` 主键 `role_id`：绑定全局 `service_id`、`model_type IN ('text2img','img2img')`、`auto_generate_enabled`、`auto_cooldown_minutes`（`0..10080` 默认 `30`）、`model_path`、`base_prompt`、`negative_prompt`、`outfit_prompts_json`、`width`/`height`（`256..2048` 步长 16，默认 `1024`）、`steps`（`1..150`，默认 `25`）、`cfg`（`0..30`，默认 `2.5`）、`sampler`（默认 `er_sde`）、`scheduler`（默认 `simple`）、`seed`（`0..2147483647\|null`）、`workflow_json`、`output_node_id`；`role_scene_references` 保存 `img2img` 每套服饰专属参考图路径与校验元数据 |

---

## 3. 核心流程与架构约束

### 3.1 TTS 服务切换、能力确认与暂存试听

1. **地址归一化与安全边界**（[normalizeVoiceBaseUrl](../../apps/backend/src/domain/voice.ts)）：仅允许 `http:`/`https:`，拒绝内嵌账号密码、查询串与 `#` 片段；`UnifiedTtsClient` 均使用 `redirect: "manual"`，任何 3xx 响应立即中止并报错。
2. **切换服务／协议强制重选机制**（[voice-service.ts](../../apps/backend/src/application/media/voice-service.ts)）：
   - 当保存或试听提交的 `baseUrl` 或 `protocol` 与已保存配置不同（`serviceChanged`）时，若原为 `preset` 则抛出 `400 VOICE_SOURCE_REQUIRED`；若原为 `reference` 则清空 `referenceMode` 并置 `referenceModeConfirmed = false`。
   - 仅当「同服务（`!serviceChanged`）且目标能力仅有 1 个参考模式且此前未处于待确认态」时才允许自动补选；换服务后连续仅改语速／语言仍会停在待确认态并被合成路径以 `VOICE_REFERENCE_MODE_REQUIRED` 拦截（V12 迁移同步回填修复老库状态）。
3. **未保存参考录音的暂存试听与原子保存**（[VoicePanel.tsx](../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx#L246-L386) · `292 §6`）：
   - 选定本地音频后仅在前端保留 `'待上传'` 文件对象（清空上次录音残留的 `referenceText`），不预先调用 `POST /voice/reference`。
   - 点「生成试听」直接走 multipart 提交 `POST /voice/preview`，不写入 `voice_assets` 或修改 `role_voice_settings`；点「保存声音配置」走 multipart 提交 `PUT /voice`，后端在数据库事务外写盘、失败时清理文件（不留孤儿文件或半写入记录）。正在使用的音频禁止删除（`409 VOICE_REFERENCE_IN_USE`）。
4. **单份语音启停与竞态隔离**（[VoicePanel.tsx](../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx) · [use-segment-voice.ts](../../apps/desktop/renderer/src/conversation/use-segment-voice.ts)）：
   - 配置页通过 `inFlight` 互斥锁阻止保存与启停并发覆盖；`VOICE_DISABLED` 仅拦截按句对话合成，配置页试听始终可用。
   - 对话页 `useSegmentVoice` 收到首个 `VOICE_DISABLED` 后暂停后续自动播放与预取请求，同时保留用户手动点击某句重试的能力；切角色／切窗口时递增世代号与 `playToken`，丢弃晚到音频与错误提示。
5. **多引擎选择、试听情绪与本地 WSL 桥接实测**（[voice-service.ts](../../apps/backend/src/application/media/voice-service.ts) · [voice-config.ts](../../apps/desktop/renderer/src/voice-config.ts) · [VoicePanel.tsx](../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx)）：
   - `nowadays-tts-v1` 可同时声明多个后端引擎（`engines` 与 `defaultEngine`）；角色保存或试听提交不在 `engines` 内的 `ttsEngine` 会返回 `400 VOICE_ENGINE_UNSUPPORTED`，切换到不声明目标引擎的服务时清理已选引擎并引导重选。
   - 配置页支持选择具体引擎、按所选引擎匹配并自动回退对应前缀预置音色（`cosy:` / `index:`），并在试听卡片提供可选 `emotion` 输入框随 `POST /voice/preview` 下发。
   - **实机对比（本机 WSL `http://127.0.0.1:9890` 双引擎实测）**：`CosyVoice3-0.5B` 输出 `24000 Hz` 单声道 WAV，热态推理 `5.6–7.3 秒`，显存约 `5.0–5.3 GiB`，原生支持自由中文 `instruct2` 情绪指令，推荐为首版默认引擎；`IndexTTS-2.5` 输出 `22050 Hz` 单声道 WAV，热态推理更快（实测 `4.7 秒` / 约 `1.05 RTF`），但显存占用较高（约 `8.2 GiB`）且情绪由中文关键词映射到 8 维向量。两引擎按需冷切换约 `28.6–39.7 秒`（对应 WSL 宿主机外部脚本修改保留 `.bak-pre-emotion` 备份，独立于本仓库源码）。
6. **全局语音服务目录、角色引用与跨页缓存共享**（[global-voice-service.ts](../../apps/backend/src/application/media/global-voice-service.ts) · [voice-service.ts](../../apps/backend/src/application/media/voice-service.ts) · [Settings.tsx](../../apps/desktop/renderer/src/pages/Settings.tsx) · [VoiceServiceEditor.tsx](../../apps/desktop/renderer/src/components/voice/VoiceServiceEditor.tsx) · [voice-cache.ts](../../apps/desktop/renderer/src/components/voice/voice-cache.ts) · [use-voice-probe.ts](../../apps/desktop/renderer/src/components/voice/use-voice-probe.ts)）：
   - 全局「设置 -> 模型 -> 语音」统一维护语音服务的名称、接口协议、服务地址、可选默认引擎（`defaultEngine`）、在线连接探测及全局启用／停用／删除。后端按服务依赖处理维护。启动时通过 `backfillFromRoles` 将既有角色已保存 `(protocol, baseUrl)` 自动归入 `voice_services` 并回填 `service_id`。
   - 角色配置「模型 -> 语音」不保留手填地址／协议输入，改为下拉选择已配置语音服务，并提供「测试连接」与「在设置中管理 →／去设置添加 →」直达设置页；全局详情页改址／删改时通过 `serviceRefreshVersion` 与 `serviceEpochs` 通知角色页同步列表并按服务版本清除 `voice-cache.ts` 缓存。
   - 角色保存前在发起 `guardWrite` 停机前先校验服务选择及重查 `/v1/voice-services`，拦截已删除或全局停用的服务；当角色引擎选回「跟随服务默认」时通过显式 `clearEngine` 清空角色覆盖列（`tts_engine = NULL`），运行时（合成与后台情绪标注 `resolveVoiceRuntime`）实时校验全局服务启用状态并继承最新 `service.config.defaultEngine`。

### 3.2 生图服务凭据隔离与草稿探测

1. **凭据二选一与跨站点防护**（[image-service.ts](../../apps/backend/src/application/media/image-service.ts#L113-L223) · [imageServiceSiteIdentity](../../apps/backend/src/domain/image-service.ts#L59-L67)）：
   - 直填明文 `secret` 与 `config.credentialRef`（`env:`/`file:`）不能共存（`409 RESOURCE_CREDENTIAL_CONFLICT`）；仅保存环境变量／文件引用时可读写配置页，待真正探测或生图时再通过 `resolveConnection` 解析。
   - 当 `protocol` 与 `URL.origin` 发生变化（跨站点修改）而沿用已存储密钥或原 `credentialRef` 时，无论正式 `PATCH /v1/image-services/:id` 还是草稿 `resolveDraftConnection` 均拒绝并抛出 `409 RESOURCE_CREDENTIAL_STALE`，防止把凭据发送给新地址。
2. **先校验后停机的前端顺序与统一模型选取**（[Settings.tsx](../../apps/desktop/renderer/src/pages/Settings.tsx) · [ResourceDetailSection.tsx](../../apps/desktop/renderer/src/components/config/ResourceDetailSection.tsx) · [ImageModelPicker.tsx](../../apps/desktop/renderer/src/components/image/ImageModelPicker.tsx) · [use-image-probe.ts](../../apps/desktop/renderer/src/components/image/use-image-probe.ts) · [image-cache.ts](../../apps/desktop/renderer/src/components/image/image-cache.ts) · `292 §7.1`）：
   - 提交前校验地址格式（`http:`/`https:`）及跨站点换密确认。后端也在暂停前校验密钥冲突和换站重验，详见 [语音／生图服务维护窗口](./role-config-and-activity.md#321-语音生图服务维护窗口)。
   - 全局设置页（创建/详情）与角色配置页共用 `ImageModelPicker`、`useImageProbe` 与按服务密钥代次隔离的 `image-cache.ts` 缓存（与文本模型 `ModelNamePicker` / `useModelProbe` 对齐）：`读取模型列表` 与 `测试连接` 的状态日志在当前页相互覆盖、切页或切换服务即清零；在全局生图服务可选保存 `config.modelName` 后，角色配置切换或初选该服务时自动带入默认模型，同时允许从已探测候选下拉选择或手填覆盖。
   - 全局探测与角色草稿探测／测试出图均只读不写库；`ImagePanel` 不保留重复的内联「新建生图服务」表单，新建／修改统一跳设置页并在返回时经 `serviceRefreshVersion` 与 `serviceEpochs` 同步服务列表与失效缓存（`292-R05` 已通过独立复核；`292-R06` 原跨页场景通过后已于 [292 §9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#9-283-28-补修复核跟进与文档勘误自验292-r06-在途编辑292-r08-干净隔离环境与-doc-r01r04) 补修在途编辑阻塞，复核结论见第 5.1 节）。

3. **对话模型视觉提炼基础与服饰锚点提示词**（[scene-image-settings.ts](../../apps/backend/src/application/media/scene-image-settings.ts) · [model.ts](../../apps/backend/src/domain/model.ts) · [protocols.ts](../../apps/backend/src/model/protocols.ts) · [google-gemini.ts](../../apps/backend/src/model/google-gemini.ts) · [ImagePanel.tsx](../../apps/desktop/renderer/src/components/image/ImagePanel.tsx)）：
   - `ModelMessage`（`role: "user"`）支持可选多模态附件 `images: ModelImageAttachment[]`，在 `openai-chat`（`image_url` Data URI）、`openai-responses`（`input_image`）、`anthropic-messages`（`base64` `image`）与 `google-gemini`（`inlineData`）协议适配层统一序列化。
   - `POST /v1/roles/:roleId/scene-image/anchor-prompts` 按角色绑定的活跃对话模型（通过 `ModelBindingResolver` + `claim` / 维护锁保护）读取角色外观立绘（`target: "base"` 优先当前服饰主页立绘，其次任一主页立绘或差分；`target: "outfit"` 读取对应 `outfitId` 主页立绘或首张差分）或用户上传的单张参考图（上限 32 MiB，支持 PNG/JPEG/WebP），生成并清洗一行中文全角逗号分隔提示词；支持传入草稿中已有的 `previousPrompt` 供用户多次点击重生成并立刻在同页配合「测试生图」验证效果，结果仅写入前端草稿直至点击保存。
   - 角色配置「模型 -> 生图」面板直接展示「服饰锚点提示词」卡片区（含立绘缩略图与生成/重生成/传参考图按钮），并将负向提示词、尺寸、步数、CFG、采样器、调度器与种子收敛在「生成参数」折叠区中。

### 3.3 ComfyUI 工作流按节点类型打补丁与运行时回退策略

1. **默认工作流与节点定位**（[comfyui-workflow.ts](../../apps/backend/src/scene/comfyui-workflow.ts#L27-L293)）：
   - 内置 11 节点 `MOSS_IMAGE_WORKFLOW` 适配 ComfyUI 0.45+ 原生节点与 Spectrum 加速：`UNETLoader`（`unet_name: "moss_image_sft_int8_convrot.safetensors"`）+ `CLIPLoader`（`clip_name: "qwen3.5_9b_w4a8_gptq.safetensors"`, `type: "moss_image"`）+ `VAELoader`（`vae_name: "flux2-vae_small.safetensors"`）→ `SpectrumMOSSImageManual` → `SkipLayerGuidanceDiTSimple`（`single_layers: "22"`）→ 双 `CLIPTextEncode` → `EmptyFlux2LatentImage`（`1024×1024`）→ `KSampler`（`steps: 25`、`cfg: 2.5`、`er_sde`、`simple`、`denoise: 1`）→ `VAEDecode` → `SaveImage`。
   - `applyWorkflowParams` 深拷贝工作流后按 `class_type`（而非写死节点 id）匹配打补丁，且**只修改节点 `inputs` 中已存在的键**，防止把未知键塞给自定义工作流引起 ComfyUI 400 校验错误：加载器优先级 `MOSSImageHFLoader.model_path` > `MOSSImageUNETLoader.unet_name` > `CheckpointLoaderSimple.ckpt_name` > `UNETLoader.unet_name`；采样器兼容 `KSampler` / `KSamplerAdvanced`（`seed` / `noise_seed`），并沿 `positive` / `negative` 连线追踪写入对应 `CLIPTextEncode.text`；尺寸写入首个含 `width`、`height` 的 `Empty*` 潜空间节点；输出优先使用指定 `outputNodeId` 否则查找 `SaveImage`。
2. **提示词拼装与快照隔离**（[comfyui-generator.ts](../../apps/backend/src/scene/comfyui-generator.ts#L49-L259)）：
   - 文生图按 DL-193 以换行拼接画风、出镜人物、当前服饰和本镜头。**固定**的是柔细线稿、渐层上色、材质和空间深度的画法，以及有人物时眼睛、头发、皮肤和衣褶的画法。
   - **随剧情变化**的是出镜者及其可见外貌、穿着和镜头。规划器以 `basePrompt` 与目标回复的服饰锚点为默认，结合前文逐人输出 `cast`，每人记录姓名、当前外貌和穿着。结果完整替换默认锚点。镜头段交代动作、表情、景别、物体位置与大小、环境和光照。背景图只拼画风与镜头。
   - 设置页试画共用上述拼装器，使用草稿锚点和手填镜头。缺少对话模型的手动任务沿用固定规划兜底。负向提示词和采样参数沿用角色配置。
   - `ConfiguredSceneImageGenerator` 在角色**未配置**生图数据时回退占位生成器，以保留离线原型能力；一旦存在 `role_scene_image_settings`（或任务快照中锁定了配置），若服务被删除（`409 SCENE_IMAGE_NOT_CONFIGURED`）、停用（`409 IMAGE_SERVICE_DISABLED`）或执行前站址发生跨站变更（`409 SCENE_IMAGE_SERVICE_CHANGED`），必须明确失败，不得静默退回占位图。

---

## 4. 已验证范围、未实现功能与可执行检查

### 4.1 已验证范围与限制（离线／本地假端点）

- **后端单元测试与离线验收**：[222](../archive/03-appearance-and-performance/222-tts-unified-independent-review.md)（`v10→v12` 迁移回填、重定向拦截、双形状试听与语速 `0.1..10` 范围）、[247](../archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md)／[249](../archive/04-role-settings-and-media/249-role-voice-toggle-review-fixes.md)（语音启停保留配置、切换防误报）、[250](../archive/04-role-settings-and-media/250-comfyui-independent-review.md)／[251](../archive/04-role-settings-and-media/251-comfyui-review-fixes.md)（ComfyUI 探测、超时队列清理、凭据换站拦截、任务配置快照）及 [292 §6～§7](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) 均在本机假 HTTP 端点与 `accept-offline.mjs`（`realServiceCalls: 0`）下通过验证。
- **桌面端全链路检查**：[workflow-real-backend-chain.e2e.cjs](../../apps/desktop/tests/e2e/workflow-real-backend-chain.e2e.cjs) 与 [settings-workspace.e2e.cjs](../../apps/desktop/tests/e2e/settings-workspace.e2e.cjs) 通过真实 Electron + 真实本机后端验证了草稿探测、测试生图、语音暂存试听与原子 multipart 保存、停用保留与对话按句播报／手动过场图联调（外部模型、TTS 与 ComfyUI 为本地假服务端点）。

### 4.2 未实现或待设计功能（来自 `246 §6` 与 `248 §10`）

1. **对话页语音停用状态同步**（[246 §6](../archive/04-role-settings-and-media/246-role-voice-toggle.md#6-未完成与后续)）：对话页顶栏／菜单目前不展示「语音已停用」常驻标识；在设置页重新启用语音后，已打开的对话窗口需通过手动点播、切角色或刷新清除 `voiceDisabled` 缓存，尚未按实时配置版本号自动刷新并发起预取。
2. **未配置真实生图服务失败策略**（[248 §10](../archive/04-role-settings-and-media/248-comfyui-adaptation.md#10-未完成与后续)）：正式发布前需按产品开关将 `ConfiguredSceneImageGenerator` 在无配置时的默认行为从「回退占位图」切换或可选切换为「提示先配置生图服务」。
3. **多模型扩展工作流模板**：Flux / SDXL 等模型虽可通过自定义工作流 API JSON 接入，但尚无内置模板选择器。

### 4.3 已实机联调与尚未实机验证项

- **离线与本机实时媒体 Electron E2E（已通过独立复核，2026-11-21）**：[media-live-check.mjs](../../apps/desktop/tests/live/media-live-check.mjs) 已顺序完成 `sample sample`、`cosyvoice sample`（`127.0.0.1:9890`，`duration=3.64s`、`rms=0.106`）、`indextts sample`（`127.0.0.1:9890`，`duration=2.635s`、`rms=0.121`）与 `sample comfy`（`127.0.0.1:8188`，ComfyUI `0.45.0` + `MOSS-Image`，自动 `background` 与上传服饰参考图 `img2img` `full_scene` `512×512` 出图及截图目视核验），验证表情差分切换、分段语音播放与波形解码、`pause` 清理防串窗、过场图渲染及重载恢复（文本模型为确定性桩）。
- **已在本机 WSL 联调（脚本级 E2E）**：既往通过后端 HTTP 路由与真实 WSL `nowadays-tts-v1` 桥接（`http://127.0.0.1:9890`）完成 `CosyVoice3-0.5B` 与 `IndexTTS-2.5` 的 `/voice/probe`、配置切换、带 `emotion` 试听与对话 `segment_annotations -> /speech` 双向切引擎合成实测。
- **尚未实机验证（仍待补充）**：真实多语种长句、Electron 设置页内 `img2img`／参考音频实时上传 UI 交互回归、真实多模态 LLM 对话流全栈串联，以及 ComfyUI 长等待取消清队列、并发任务与 8 MiB／32 MiB 上限实测。

### 4.4 可执行验证命令

```powershell
# 1. 后端类型检查与语音／ComfyUI 定向单测（Node 24）
cd apps/backend
npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit
npx -y node@24 --import tsx --test tests/integration/voice-tts.test.ts tests/integration/tts-unified.test.ts tests/unit/tts-engines-emotion.test.ts tests/integration/comfyui-client.test.ts
npx -y node@24 scripts/verify/accept-offline.mjs

# 2. 桌面前端检查、构建与纯逻辑单测
cd ../desktop/renderer
npm run check
npm run build
npx -y node@24 --import ../node_modules/tsx/dist/loader.mjs --test tests/voice-config.test.ts tests/voice-engines-emotion.test.ts tests/image-config.test.ts

# 3. 真实本机后端 + Electron 设置／对话全链路检查（仓库根目录，外接假 TTS/ComfyUI 端点）
cd ../../..
npx -y node@24 apps/desktop/tests/e2e/workflow-real-backend-chain.e2e.cjs
```

---

## 5. 已知缺陷、源文件清单与归档追溯

### 5.1 复核缺陷处理状态（均与 [role-config-and-activity.md](./role-config-and-activity.md#53-已补修待独立复核与未闭环项见-statusmd283-27-与-292-8) 联动登记）

| 编号 / 来源 | 问题位置与处理摘要 | 当前状态 |
| --- | --- | --- |
| `292-R05`（[283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#271-待修复项)） | v6 保留新绑定或改选停用服务的预校验。同一角色可以保留已停用的原服务并保存其他字段，探测和生成继续受守卫约束。现行口径见[服务维护窗口](./role-config-and-activity.md#321-语音生图服务维护窗口)。 | 原场景的[独立复验](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)；v6 后续见 [400](../archive/08-config-pages-v6/400-config-pages-v6-migration-progress.md) |
| `292-R06`（[283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#271-待修复项) · [§28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)） | [ImagePanel.tsx](../../apps/desktop/renderer/src/components/image/ImagePanel.tsx#L149-L505) 与 [imageServiceSnapshotKey](../../apps/desktop/renderer/src/image-config.ts#L195-L210) 为探测／样图绑定快照键并在 [292 §9](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#9-283-28-补修复核跟进与文档勘误自验292-r06-在途编辑292-r08-干净隔离环境与-doc-r01r04) 新增 `invalidateProbe`／`invalidatePreview`（`#L149-L165`、`#L295-L306`、`#L606-L618`），跨页失效或在途修改测试描述／服饰／草稿时同步释放忙态按钮并拒收晚到响应 | 原跨页失效场景已通过 [283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)；在途编辑按钮恢复通过 [283 §29](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) |
| `292-R07`（[283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#271-待修复项)） | [scene-image-settings.ts](../../apps/backend/src/application/media/scene-image-settings.ts#L155-L195) 的 `preview()` 对非空 `outfitId` 调用 `AppearanceStore.getOutfit(outfitId)` 核验当前角色下未删除服饰，否则生图前拒绝并返回 `404 OUTFIT_NOT_FOUND` | **已独立复核通过**（[283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)） |

### 5.2 核心实现文件清单

- **后端域模型、路由与输入验证**：
  - [voice.ts](../../apps/backend/src/domain/voice.ts) · [voice-service.ts](../../apps/backend/src/domain/voice-service.ts) · [voice-capabilities.ts](../../apps/backend/src/domain/voice-capabilities.ts) · [image-service.ts](../../apps/backend/src/domain/image-service.ts) · [scene-image-settings.ts](../../apps/backend/src/domain/scene-image-settings.ts) · [model.ts](../../apps/backend/src/domain/model.ts) · [errors.ts](../../apps/backend/src/domain/errors.ts)
  - [voice-routes.ts](../../apps/backend/src/http/voice-routes.ts) · [voice-service-routes.ts](../../apps/backend/src/http/voice-service-routes.ts) · [image-service-routes.ts](../../apps/backend/src/http/image-service-routes.ts) · [config-writes.ts](../../apps/backend/src/http/config-writes.ts) · [schemas.ts](../../apps/backend/src/http/schemas.ts)
- **后端应用、协议客户端与存储**：
  - [global-voice-service.ts](../../apps/backend/src/application/media/global-voice-service.ts) · [voice-service.ts](../../apps/backend/src/application/media/voice-service.ts) · [image-service.ts](../../apps/backend/src/application/media/image-service.ts) · [scene-image-settings.ts](../../apps/backend/src/application/media/scene-image-settings.ts) · [audio-inspect.ts](../../apps/backend/src/application/media/audio-inspect.ts)
  - [transport.ts](../../apps/backend/src/tts/transport.ts) · [unified-tts-client.ts](../../apps/backend/src/tts/unified-tts-client.ts) · [indextts-client.ts](../../apps/backend/src/tts/indextts-client.ts)
  - [protocols.ts](../../apps/backend/src/model/protocols.ts) · [google-gemini.ts](../../apps/backend/src/model/google-gemini.ts) · [comfyui-client.ts](../../apps/backend/src/scene/comfyui-client.ts) · [comfyui-workflow.ts](../../apps/backend/src/scene/comfyui-workflow.ts) · [comfyui-generator.ts](../../apps/backend/src/scene/comfyui-generator.ts)
  - [voice-store.ts](../../apps/backend/src/storage/media/voice-store.ts) · [voice-service-store.ts](../../apps/backend/src/storage/media/voice-service-store.ts) · [image-service-store.ts](../../apps/backend/src/storage/media/image-service-store.ts) · [scene-image-settings-store.ts](../../apps/backend/src/storage/media/scene-image-settings-store.ts) · [schema.ts](../../apps/backend/src/storage/core/schema.ts)
- **桌面前端渲染器与纯逻辑单测**：
  - [VoicePanel.tsx](../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx) · [VoiceServiceEditor.tsx](../../apps/desktop/renderer/src/components/voice/VoiceServiceEditor.tsx) · [VoiceProbeView.tsx](../../apps/desktop/renderer/src/components/voice/VoiceProbeView.tsx) · [use-voice-probe.ts](../../apps/desktop/renderer/src/components/voice/use-voice-probe.ts) · [voice-cache.ts](../../apps/desktop/renderer/src/components/voice/voice-cache.ts) · [voice-config.ts](../../apps/desktop/renderer/src/voice-config.ts) · [ImagePanel.tsx](../../apps/desktop/renderer/src/components/image/ImagePanel.tsx) · [ImageModelPicker.tsx](../../apps/desktop/renderer/src/components/image/ImageModelPicker.tsx) · [use-image-probe.ts](../../apps/desktop/renderer/src/components/image/use-image-probe.ts) · [image-cache.ts](../../apps/desktop/renderer/src/components/image/image-cache.ts) · [image-config.ts](../../apps/desktop/renderer/src/image-config.ts) · [Settings.tsx](../../apps/desktop/renderer/src/pages/Settings.tsx) · [use-segment-voice.ts](../../apps/desktop/renderer/src/conversation/use-segment-voice.ts)
  - [voice-config.test.ts](../../apps/desktop/renderer/tests/voice-config.test.ts) · [voice-engines-emotion.test.ts](../../apps/desktop/renderer/tests/voice-engines-emotion.test.ts) · [image-config.test.ts](../../apps/desktop/renderer/tests/image-config.test.ts) · [voice-tts.test.ts](../../apps/backend/tests/integration/voice-tts.test.ts) · [tts-unified.test.ts](../../apps/backend/tests/integration/tts-unified.test.ts) · [tts-engines-emotion.test.ts](../../apps/backend/tests/unit/tts-engines-emotion.test.ts) · [comfyui-client.test.ts](../../apps/backend/tests/integration/comfyui-client.test.ts)

### 5.3 归档与复核文档追溯

- 语音接入方案、实现与复核：[218 首轮实施](../archive/03-appearance-and-performance/218-tts-implementation-record.md) · [219 IndexTTS 规范](../archive/03-appearance-and-performance/219-indextts-integration-spec.md) · [220 TTS 统一规范](../archive/03-appearance-and-performance/220-tts-unified-integration.md) · [221 统一接入实施](../archive/03-appearance-and-performance/221-tts-unified-implementation.md) · [222 独立复核（v12 回填关闭 R01～R04）](../archive/03-appearance-and-performance/222-tts-unified-independent-review.md#221-第-11-节-v12-回填独立复验)
- 角色语音设置、启停与复核：[243 语音设置](../archive/04-role-settings-and-media/243-voice-settings-desktop.md) · [246 语音启停](../archive/04-role-settings-and-media/246-role-voice-toggle.md) · [247 独立复核](../archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md) · [249 补修](../archive/04-role-settings-and-media/249-role-voice-toggle-review-fixes.md)
- 生图 ComfyUI 适配、草稿试听与复核：[248 ComfyUI 适配](../archive/04-role-settings-and-media/248-comfyui-adaptation.md) · [250 独立复核](../archive/04-role-settings-and-media/250-comfyui-independent-review.md#251-第-5-节补修独立复验) · [251 补修](../archive/04-role-settings-and-media/251-comfyui-review-fixes.md) · [292 §6～§7](../archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) · [283 §27](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)
