# ComfyUI 生图适配（CG-03）

2026-11-10。按 [236 第 6.2／6.3 节](236-role-settings-backend-gap-review.md#62-各类测试的现状与缺口) 的生图缺口和 [DL-150](161-digital-life-direction-decisions.md#dl-150-生图首版适配-comfyui先测-moss-image) 实现。前一包 CG-01／CG-02 的任务与规划链路见 [224](224-scene-image-cg-01-record.md)、[226](226-scene-image-cg-02-record.md)，独立复核见 [227](227-scene-image-independent-review.md)。

2026-11-11：[250 独立复核](250-comfyui-independent-review.md) 的 CG-R01～CG-R05 已按 [251](251-comfyui-review-fixes.md) 修复，独立复验待执行。

## 1. 范围与结论

| 目标 | 结论 |
| --- | --- |
| 先适配 ComfyUI | 新增全局「生图服务」：地址、凭据、单次等待上限；协议首版只有 `comfyui` |
| 首版测试 MOSS-Image | 内置 MOSS-Image 官方推荐参数的工作流（50 steps、CFG 3、Shift 5、SLG 22、Euler + sgm_uniform、1024²），可直接提交 |
| 不绑定单一模型 | 参数按 `class_type` 写入工作流，不写死节点 id；角色可换自定义工作流跑其他开源模型 |
| 角色配置 | 服务、模型路径、基础锚点提示词、服饰提示词、尺寸、采样参数、种子、输出节点 |
| 测试连接 | `GET /system_stats` + `GET /object_info`，报告节点是否齐全、缺哪些、有哪些可用模型 |
| 测试生图 | 用当前配置真出一张可解码的图片，回给配置流程，不写入过场图历史 |
| 过场图任务 | 已配置时走 ComfyUI；完全没配置时沿用占位生成器，保持首轮演示行为 |
| 桌面配置页 | 设置页新增「生图」区：服务选择与新建、模型目录、锚点与服饰提示词、采样参数、测试连接、测试生图 |

未纳入本轮：图生图的锚点图上传与按类型切换、真实服务联调。

## 2. 为什么是 ComfyUI + MOSS-Image

- **ComfyUI 不规定模型。** 它只负责按工作流执行节点图，模型是加载节点的输入。所以「适配 ComfyUI」等于「适配一套提交与取图协议」，换模型换的是工作流模板，不是代码。
- **首版需要一个具体模型验证端到端。** 选 MOSS-Image：OpenMOSS 开源，5B DiT 主干 + 冻结的 Qwen3.5-9B 文本编码器 + FLUX.2 VAE，Apache-2.0，ComfyUI 侧有官方加载插件与 API 格式示例工作流。
- **官方推荐参数直接固化进默认模板。** 50 steps、CFG 3、Shift 5、负分支跳层 22、Euler + sgm_uniform、1024×1024；分辨率需为 16 的倍数，总像素推荐 1M～2M。这些都能在角色配置里改，但默认值保证「装好就能出图」。
- **只做文生图。** MOSS-Image 是文生图模型；图生图要先把「角色基础锚点 + 各服饰锚点图」的上传与关联做完（236 §6.3），单独一包。

## 3. 存储与凭据

- **app 库升到 V4**，新增 `image_services`（`service_id`、`name`、`enabled`、`config_json`、时间戳）。ComfyUI 通常只有一个地址，所以连接与模型分开：连接全局存一份，模型参数落在角色配置里。[schema.ts](../backend/src/storage/schema.ts)
- **业务库升到 V15**，新增 `role_scene_image_settings`：每个角色一份，保存即整份覆盖（与 [DL-149](161-digital-life-direction-decisions.md#dl-149-角色语音只保留当前一份配置) 的语音配置同构）。`outfit_prompts_json` 按 `outfitId` 存服饰锚点提示词，`workflow_json` 为空时用内置模板。[scene-image-settings-store.ts](../backend/src/storage/scene-image-settings-store.ts)
- **凭据复用统一解析。** 密钥仍写 `resource_secrets`（键为 `service_id`），支持 `secret` 直填与 `env:`／`file:` 引用，二选一由服务层拒绝并存；读接口只回 `stored`／`reference`／`missing`／`unavailable` 状态。[image-service.ts](../backend/src/application/image-service.ts)
- **换服务要重新确认凭据。** 协议或 origin 变化、请求未给新密钥、仍持有旧凭据时返回 `RESOURCE_CREDENTIAL_STALE`；同站点换路径仍算同一个服务。这条规则与 [245 第 2 节](245-role-settings-review-fixes.md) 的模型资源一致。

## 4. ComfyUI 客户端

只用公开接口，不依赖 websocket：

| 用途 | 接口 |
| --- | --- |
| 探测服务是否在 | `GET /system_stats` |
| 探测节点与可用模型 | `GET /object_info` |
| 提交工作流 | `POST /prompt`（`{ prompt, client_id }`） |
| 轮询结果 | `GET /history/{prompt_id}` |
| 取图 | `GET /view?filename=&subfolder=&type=` |
| 取消（尽力而为） | `POST /queue`（`{ delete: [prompt_id] }`） |

- **轮询代替推送。** 默认 750 ms 一次，单次生成上限默认 180 秒（服务配置可改），超时后先尝试取消再按 `IMAGE_GENERATION_TIMEOUT` 结算。[comfyui-client.ts](../backend/src/scene/comfyui-client.ts)
- **错误码固定。** 连不上或响应不是 ComfyUI 形状 → `IMAGE_SERVICE_UNAVAILABLE`(502)；401／403 → `IMAGE_SERVICE_AUTH_FAILED`(401)；`/prompt` 返回 400 或没有 `prompt_id` → `IMAGE_WORKFLOW_INVALID`(400)；执行报错或结果为空／超限 → `IMAGE_GENERATION_FAILED`(502)；超时 → `IMAGE_GENERATION_TIMEOUT`(504)。
- **不跟随重定向。** `redirect: "manual"`，3xx 直接判失败，避免把凭据带到未确认的站点。
- **取图格式兜底。** 服务没给 `content-type` 时按扩展名推断；真正的格式仍由完整解码校验决定。

## 5. 工作流模板与参数打补丁

- 默认模板是一张 9 节点的 MOSS-Image 图：`MOSSImageHFLoader → CLIPTextEncode(正/负) → EmptyFlux2LatentImage → ModelSamplingSD3 → SkipLayerGuidanceDiTSimple → KSampler → VAEDecode → SaveImage`。[comfyui-workflow.ts](../backend/src/scene/comfyui-workflow.ts)
- **按类型定位，不按 id。** 用户从 ComfyUI 导出的官方工作流节点 id 各不相同，所以补丁按 `class_type` 找加载节点、采样节点、潜空间节点和输出节点；提示词沿 `KSampler.positive/negative` 的连线找到对应文本节点再写入。
- **只改存在的键。** 例如 `KSampler` 用 `seed`、`KSamplerAdvanced` 用 `noise_seed`，两个都试但只写已存在的；加载节点同理（`model_path`／`unet_name`／`ckpt_name`）。这样同一套代码也能跑 Checkpoint 类模型。
- **输出节点可覆盖。** 默认找 `SaveImage`；角色配置可显式指定 `outputNodeId`，保存时校验该节点确实在工作流里。
- **模板不被就地修改。** 每次生成都深拷贝后再打补丁，同一份配置可以重复使用。

## 6. 提示词组装与生成链路

- 组装顺序：**角色基础锚点提示词 → 目标服饰提示词 → 本次场景描述**，空段跳过。基础锚点描述脸型、发型、发色、瞳色等跨场景特征，服饰提示词按 `outfitId` 取，场景描述来自规划器。
- `SceneImageGenerationInput` 增加 `roleId` 与 `outfit`（`outfitId`／`name`／`description`），生成器据此取该服饰的提示词；现有假生成器与测试生成器不受影响。[scene-image.ts](../backend/src/domain/scene-image.ts)
- **过场图任务**：`ConfiguredSceneImageGenerator` 先查角色配置；有配置走 ComfyUI，完全没有配置才回退占位生成器。配置存在但服务被删除或停用时**不回退**，直接以 `SCENE_IMAGE_NOT_CONFIGURED`／`IMAGE_SERVICE_DISABLED` 失败，避免「明明关了还在出图」。[comfyui-generator.ts](../backend/src/scene/comfyui-generator.ts)
- **测试生图**走同一条生成路径，只是结果以 base64 回给配置流程，不落过场图历史、不写角色对话、不占自主额度。

## 7. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/image-services` | 服务列表（含凭据状态） |
| POST | `/v1/image-services` | 新建服务，可同时写密钥 |
| PATCH | `/v1/image-services/:serviceId` | 改名、启停、改地址、替换或清除密钥 |
| POST | `/v1/image-services/:serviceId/probe` | 探测节点与可用模型 |
| GET | `/v1/roles/:roleId/scene-image` | 角色生图配置与服务摘要 |
| PUT | `/v1/roles/:roleId/scene-image` | 保存整份配置 |
| POST | `/v1/roles/:roleId/scene-image/probe` | 用候选服务／工作流探测 |
| POST | `/v1/roles/:roleId/scene-image/preview` | 测试生图，返回 base64 |

请求体用 `.strict()` 拒绝多余字段；服务配置与角色配置共用领域 schema，路由不再重复定义形状。

## 8. 测试与验收

- 新增 `tests/p13-comfyui.test.ts`（6 项），用假 ComfyUI 服务端覆盖五个接口：
  - 内置工作流是按类型可打补丁的 MOSS-Image 图，打补丁不改原模板；
  - 探测报告节点齐全与可用模型，缺节点时给出 `missingNodes`；
  - 保存配置拒绝未知输出节点（`IMAGE_WORKFLOW_INVALID`）、拒绝已停用服务（`IMAGE_SERVICE_DISABLED`）；
  - 测试生图拼出「基础 + 服饰 + 场景」提示词，提交的工作流带上模型路径、尺寸、种子、步数与 CFG，返回的 PNG 可解码；
  - `/prompt` 400、执行报错、401 分别映射到稳定错误码；
  - 过场图任务走已配置的 ComfyUI，产出图片可读取。
- 版本断言同步：app 3→4、业务 14→15，`p1-02` 的表清单加入 `image_services`。
- 后端全量 **308／308** 通过。离线验收 `npx -y node@24 scripts/accept-offline.mjs` 21／21 步、308／308 项，`realServiceCalls=0`、`sourceUnchanged=true`，目录 `backend/test-results/p5-2026-11-10T09-20-17-560Z-2f90b35b/`。
- 桌面端新增 `tests/image-config.test.cjs`（8 项），覆盖默认值、载荷裁剪、参数越界、摘要与错误码文案；桌面全量 **97／97** 通过，`renderer` 下 `tsc --noEmit` 与 `vite build` 通过。

## 9. 桌面配置页

- 设置页在「声音」之后新增「生图」区（`ImagePanel`），沿用声音页的令牌与忙碌状态约定：切角色即递增 `roleToken`，晚到响应不写进另一个角色的页面。[ImagePanel.tsx](../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx)
- 表单字段与服务端 schema 对齐：服务、模型目录、基础锚点提示词、负向提示词、宽高／步数／CFG／采样器／调度器／种子，以及按服饰逐条填写的锚点提示词。
- 「新建服务」内联在页面里，保存后自动选中；「测试连接」用当前选中的服务探测节点，「测试生图」用已保存的配置真出一张并就地预览。
- 纯逻辑抽到 `image-config.js`：默认值、请求载荷（去掉空白与空服饰提示词）、校验（服务必选、模型目录必填、尺寸 16 的倍数且在 256～2048、步数 1～150、CFG 0～30、种子范围）、摘要与错误码文案。[image-config.js](../desktop/desk-preview/renderer/src/image-config.js)
- 测试生图要求先保存配置：页面上的参数改动需要先「保存配置」才会进入预览，避免用未保存的草稿出图造成误解。

## 10. 未完成与后续

- **图生图。** 需要锚点图上传、按服饰关联、按模型类型切换表单，以及缺锚点图时的提示；MOSS-Image 本身是文生图模型，首版不涉及。
- **未配置时的回退策略。** 首版为保留演示行为沿用占位生成器；正式版应改为「未配置即失败」，避免用户误以为真在出图。
- **取消语义。** 本地超时会尽力取消服务端任务，但 ComfyUI 已经开始执行的采样无法中断，只能等它跑完。
- **真实联调。** 本轮全部用假服务端验证，真实 ComfyUI 与 MOSS-Image 权重下的显存、首帧加载时间与参数区间仍需实测。
