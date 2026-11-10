# 226 生成过场图第二包实施记录：规划与手动生成

2026-11-09，`dev-front` 工作树。按 [223 开发文档](223-conversation-performance-development-guide.md) 的 CG-02 完成规划与手动生成：从目标轮及附近上下文规划画面，使用该回复保存的服饰与可用参考素材，接通生成适配、文件校验、落盘、失败与重试。真实生图服务尚未确定，生成端仍为本地假生成器；自动触发（CG-03）与独立复核（CG-04）尚未开始，本文结论只覆盖 CG-02 的离线范围。

[227 独立复核](227-scene-image-independent-review.md) 的 R01～R04 修复与自验见 [228](228-scene-image-review-fixes.md)；本文相关描述已按修复后的口径更新。

## 1. 范围与结果

- 规划默认使用角色绑定的对话模型：读取目标回复正文、目标轮之前的上下文和该轮保存的服饰，返回画面描述、图层模式与同轮起止句段。
- 没有可用对话模型或适配器无法初始化时回退固定规划器（首段到末段、图层沿用请求），手动任务仍可完成；模型调用失败或返回非法方案时任务失败，不回退掩盖问题。
- 模型调用按锚点执行归属登记到 `model_calls`，记录资源、模型、协议、用途、用量与原始响应；重连、读图和复用已有任务不产生新调用。
- 手动请求的 `layerMode` 优先于规划结果；`background` 只产出环境背景（1024×576），`full_scene` 产出人物加场景（832×1216），并把该服饰的 `home` 参考图传给生成端。
- 参考素材按角色归属与魔数校验读取；缺失、不可读、格式不符或超出上限时降级为无参考图，不把整张图判为失败。
- 生成默认 120 秒超时，超时结算为 `SCENE_IMAGE_GENERATION_TIMEOUT`；生成失败、规划失败和超时都不影响原回复文字与句段读取。
- 同一幂等键复用原任务且不重复生成；新幂等键按新尝试推进 `attempt`，失败后可重试成功。
- 统一离线验收 21／21 步、276 项正式测试通过，真实模型与真实生图调用 0。

## 2. 规划输入与上下文

规划端口输入扩展为角色、窗口、消息、执行归属、正文、句段、服饰记录、附近上下文和请求图层。 [scene-image.ts](../backend/src/domain/scene-image.ts#L88)

- 上下文取目标轮之前最多 4 条消息，按时间升序，跳过仍在生成的回复；单条截断到 600 字符，正文截断到 4000 字符。 [scene-image-store.ts](../backend/src/storage/scene-image-store.ts#L223)
- 服饰只取该回复句段记录的 `outfitId`，没有记录时按未知服饰处理，不回退角色当前服饰，避免后来换装回填旧场景（[227 R04](227-scene-image-independent-review.md) 修复后口径）。名称与用途说明进入提示词，不暴露素材路径。 [scene-image-store.ts](../backend/src/storage/scene-image-store.ts#L148)
- 提示词要求只输出 JSON：`description`、`layerMode`、`startSegmentId`、`endSegmentId`；明确 `background` 不画人物、`full_scene` 画角色与场景、区间必须来自给出句段且首尾包含。 [model-planner.ts](../backend/src/scene/model-planner.ts#L209)
- 解析容忍代码块与前后解释文字，但严格校验描述非空与图层取值；区间归属与顺序由服务层再次校验。 [model-planner.ts](../backend/src/scene/model-planner.ts#L260)

## 3. 模型规划器与回退

`ModelSceneImagePlanner` 实现规划端口： [model-planner.ts](../backend/src/scene/model-planner.ts#L45)

1. 解析角色的 `chat_model` 绑定；缺少绑定或适配器初始化（含凭据读取）失败时使用固定规划器，不留下调用记录。
2. 调用前按锚点执行登记 `model_calls`，用途取该执行的 `user_chat`／`autonomous`；本轮 `counted=false`，自主额度扣点留到 CG-03 与自动触发一起确定。
3. 流式收集文本与用量，完成后闭合调用记录；未完成或抛错时记录失败码，并把任务结算为 `SCENE_IMAGE_PLAN_INVALID`。
4. 手动任务强制使用请求图层；自动任务（CG-03）才采用规划返回的图层。

装配默认值在 `createBackendApp`：没有显式注入规划器时使用模型规划器加固定规划器回退；测试可通过 `sceneImagePlanner` 固定为契约实现。 [app.ts](../backend/src/bootstrap/app.ts#L134)

## 4. 参考素材与假生成器

- 生成端口新增可选 `references`，首版只支持 `role: "character"` 的服饰主参考图。 [scene-image.ts](../backend/src/domain/scene-image.ts#L109)
- 只有 `full_scene` 读取参考图：按 `appearance/` 根目录校验相对路径、8 MiB 上限与媒体类型魔数，任一项不满足返回空数组。 [scene-image-service.ts](../backend/src/application/scene-image-service.ts#L463)
- 假生成器在整幅图模式把参考图缩放到画面下部并合成，纯背景图保持渐变；输出仍为确定性 PNG，便于断言参考图确实到达生成端。 [fake-generator.ts](../backend/src/scene/fake-generator.ts#L62)
- 参考图合成使用 `sharp` 的 `rotate → resize → composite`，不读取真实生图服务，也不产生费用。

## 5. 超时、失败与重试

- 单次生成使用 `AbortSignal.any([任务信号, AbortSignal.timeout(120s)])`；超时优先结算为 `SCENE_IMAGE_GENERATION_TIMEOUT`，服务关闭仍结算为 `SCENE_IMAGE_INTERRUPTED`。 [scene-image-service.ts](../backend/src/application/scene-image-service.ts#L396)
- 生成结果继续做非空、32 MiB 上限与完整解码校验；写盘失败或取消时删除未提交文件，成功状态与素材引用同事务提交。
- 失败任务保留错误码与摘要，回复正文与句段照常读取；同一幂等键重放返回原失败任务，不触发第二次生成。
- 新幂等键创建新任务并推进 `attempt`，重试成功后结果与原句段关联；重试不是自动重发，仍需显式请求。

## 6. 测试与自验

新增 `p11-scene-image-planning.test.ts` 6 项，覆盖：

- 模型规划读取回复、服饰与附近上下文，规划区间写入任务，模型调用登记为 `user_chat`／`succeeded`。
- 手动图层优先于规划结果；`background` 不带参考图、1024×576；`full_scene` 带 1 张角色参考图、832×1216，且底部像素与参考素材颜色一致。
- 非法区间使任务失败为 `SCENE_IMAGE_PLAN_INVALID`，回复文字与句段仍可读。
- 移除对话模型绑定后回退固定规划器，手动任务仍成功。
- 首次生成失败后同一幂等键复用失败任务、不重复生成；新幂等键成为第 2 次尝试并成功。
- 生成超时结算为 `SCENE_IMAGE_GENERATION_TIMEOUT`，回复不受影响。

CG-01 的 `p10-scene-image.test.ts` 8 项固定使用固定规划器，避免脚本化对话模型被规划调用消耗；其余回归未改动断言。

最终验收：`npm run accept:offline`（经 Node 24.22.2）21／21 步通过，正式测试 276／276，交付回归 2／2，`sourceUnchanged=true`，`realServiceCalls=0`。运行目录为 `backend/test-results/p5-2026-11-09T08-55-01-320Z-2364ee85/`，`summary.json` 记录逐步结果与源码哈希。

## 7. 未完成与后续

- 真实生图服务尚未确定：接口地址、认证、参考图能力、支持的图像模式、尺寸、超时、错误码与幂等能力仍需在适配时固定；本轮未新增真实 HTTP 生成适配器，避免按猜测协议实现。
- 自动触发、判图与冷却、`skipped` 语义、资源停用与计量归属属于 CG-03；`idx_scene_image_auto_attempt` 与 `skipped` 状态已预留。
- 手动区间的用户交互（是否允许改起止句或确认画面方案）与首版重画／多版本展示仍待产品确认，见 223 第 4 节。
- 桌面对话演出的过场图切换、晚到结果展示与历史读取留到桌面前端工作包。
- CG-04 独立复核尚未开始；本文为实施方自验，不替代独立结论。
