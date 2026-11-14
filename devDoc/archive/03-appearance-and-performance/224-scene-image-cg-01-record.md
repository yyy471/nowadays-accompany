# 224 生成过场图第一包实施记录：任务与读取契约

> **现行规范入口**：本文涉及的过场图任务状态、幂等与受管素材读取契约已整合至 [对话演出、输入状态、SSE 与过场图规范](../../specs/conversation-performance-and-scene-images.md)；下文保留 CG-01 实施与自验记录。

2026-11-09，`dev-front` 工作树。按 [223 开发文档](223-conversation-performance-development-guide.md) 的 CG-01 完成过场图任务与读取契约：从指定已保存回复发起任务，结果可从原窗口与原句段查回，并用本地假生成器验证迁移、跨窗口拒绝和重连。工作树未提交、未推送，未调用真实模型、真实生图服务或付费接口。CG-02 的模型规划、CG-03 的自动触发和 CG-04 的独立复核尚未开始，本文结论只覆盖 CG-01。

## 1. 范围与结果

- 新增过场图任务，锚定一条已保存的角色回复和同轮句段区间，记录角色、窗口、消息、执行归属、触发来源、幂等标识、图层模式、起止句段、状态、规划结果、错误摘要与结果素材引用。
- 手动入口从一条已保存的角色回复发起；同一幂等键复用原任务，新请求创建任务并异步推进 `queued → planning → generating → succeeded`。
- 任务读取同时校验角色、窗口和任务归属；受管图片按角色归属读取，跨窗口、跨角色和跨角色库均返回 404。
- 消息分页与单条消息详情返回 `sceneImages`；任务每次状态变化写入 `scene_image_task` 流事件，按既有窗口游标重放，重连可补齐晚到状态。
- 两种图层分别产出：`background` 为 1024×576，`full_scene` 为 832×1216；本轮由本地假生成器输出确定性 PNG，不访问网络。
- 失败、显式重试、进程重启结算与幂等并发均有离线测试；生成失败不影响原回复文字与句段。
- 统一离线验收 21／21 步、270 项正式测试通过，真实服务调用 0。

## 2. 存储与迁移

业务库版本升至 v13，新增两张表：

- `scene_image_tasks`：一条任务一行，含角色、窗口、消息、锚点执行、触发来源、图层模式、起止句段、状态、幂等键、尝试序号、规划 JSON、错误码与摘要、时间。 [schema.ts](../../../backend/src/storage/schema.ts#L1292)
- `scene_image_assets`：生成结果素材，含任务、角色、窗口、消息、媒体类型、相对路径、宽高、字节数与时间；`task_id` 唯一，一个任务最多一个已提交结果。

索引按契约固定：

| 索引 | 作用 |
| --- | --- |
| `idx_scene_image_manual_key` | 手动幂等键在角色、窗口、消息内唯一，重复请求复用原任务 |
| `idx_scene_image_auto_attempt` | 同一条消息的自动判图按尝试序号唯一，为 CG-03 预留 |
| `idx_scene_image_window` | 按窗口与消息读取快照引用 |
| `idx_scene_image_status` | 启动结算扫描未完成任务 |
| `idx_scene_image_assets_task` / `idx_scene_image_assets_role` | 结果唯一归属与按角色读取 |

`execution_stream_events` 按既有表重建方式加入 `scene_image_task` 事件类型，旧事件原样保留。过场图事件沿用锚点回复的 `execution_id` 写入同一窗口流，因此快照 `cursor`、断线重连和事件补读仍是单一游标来源，不需要第二条事件流。新建与重新打开角色库都按 v13 校验表、列和索引；P1、P2、P8、P9 的 schema 版本断言同步更新。v12 → v13 迁移由测试真实重放：删除新表并回退 `user_version` 后重新打开，消息、句段、事件与游标保持不变，新任务仍可从旧回复发起。

## 3. 任务契约与状态

| 字段 | 说明 |
| --- | --- |
| `taskId` / `roleId` / `windowId` / `messageId` | 任务与目标回复归属；任务不随窗口切换改变归属 |
| `executionId` | 锚点回复的执行编号，用于流事件与追溯；回复缺少执行归属时拒绝发起 |
| `trigger` | `manual` 或 `auto`；本轮只开放手动 |
| `layerMode` | `background` 只覆盖背景层，`full_scene` 覆盖背景与立绘两层 |
| `startSegmentId` / `endSegmentId` | 同轮已保存句段，首尾均包含；创建时取目标回复首段到末段 |
| `status` | `queued`、`planning`、`generating`、`succeeded`、`skipped`、`failed` |
| `attempt` | 同消息同来源递增；显式重试是新任务、新尝试 |
| `plan` | 画面描述、图层模式和最终区间；规划前为空 |
| `errorCode` / `errorSummary` | 失败终态的错误码与摘要，成功时为空 |
| `result` | 受管素材引用：`assetId`、媒体类型、宽高、字节数和创建时间 |

- 状态推进由存储层按前置状态守卫：`queued → planning → generating → succeeded`，任一步失败进入 `failed`；`skipped` 留给 CG-03 的自动判图。
- 区间校验要求起止句段都属于目标回复且段序有效；手动请求的图层模式优先于规划结果，自动任务才采用规划给出的模式。
- 结果素材与 `succeeded` 状态在同一事务提交；提交前写入的文件在事务失败时删除，不留下未引用素材。
- 同一手动幂等键无论请求体中的图层模式是否变化都返回原任务；唯一索引兜底多进程并发。

## 4. 接口与读取

| 入口 | 行为 |
| --- | --- |
| `POST /v1/roles/:roleId/windows/:windowId/messages/:messageId/scene-images` | 请求体 `{ idempotencyKey, layerMode? }`；新任务返回 201，复用返回 200，响应 `{ task, duplicate }` |
| `GET /v1/roles/:roleId/windows/:windowId/scene-images/:taskId` | 返回 `{ task }`；任务不属于该角色窗口时 404 `SCENE_IMAGE_TASK_NOT_FOUND` |
| `GET /v1/roles/:roleId/scene-images/assets/:assetId` | 返回图片字节与图像 MIME；素材不属于该角色时 404 |
| 消息分页 / 单条消息详情 | 增加 `sceneImages`，按消息顺序返回任务与结果引用 |
| 窗口 SSE | `scene_image_task` 携带任务编号、消息编号、状态、区间、规划、结果与错误摘要 |

拒绝规则：用户消息、仍在生成的回复、缺少执行归属的回复返回 409 `SCENE_IMAGE_ANCHOR_INVALID`；没有句段返回 409 `SCENE_IMAGE_SEGMENTS_MISSING`；消息不存在返回 404 `MESSAGE_NOT_FOUND`。 [路由](../../../backend/src/http/scene-image-routes.ts#L8) · [服务](../../../backend/src/application/scene-image-service.ts#L58)

受管图片读取校验角色归属、文件签名与记录字节数，格式或长度不一致返回 500 `SCENE_IMAGE_ASSET_CORRUPT`；像素可解码性在写入前由既有 `inspectImage` 完整解码确认。相对路径与真实服务配置不通过接口暴露。

## 5. 假规划与假生成器

- [FixedSceneImagePlanner](../../../backend/src/scene/fixed-planner.ts#L15) 取目标回复首段到末段作为区间，画面描述由回复正文摘要和回复时服饰名组成，图层沿用请求或默认背景。真实模型规划在 CG-02 接入，端口不变。
- [FakeSceneImageGenerator](../../../backend/src/scene/fake-generator.ts#L26) 按 `图层模式 + 描述` 的 SHA-256 生成确定性的斜向渐变 PNG，两种图层使用不同画布尺寸，不访问网络、不产生费用。
- 规划与生成分别通过 `SceneImagePlannerPort`、`SceneImageGeneratorPort` 注入，桌面与后续真实服务只替换适配器，不改任务与读取契约。 [端口定义](../../../backend/src/domain/scene-image.ts#L85)

## 6. 失败、重启与幂等

- 生成失败：任务进入 `failed` 并保存错误码与摘要，原回复文字、句段和消息状态不变；已写入的未提交文件被删除，`scene_image_assets` 不新增记录。
- 显式重试：使用新的幂等键创建新任务，`attempt` 在同消息同来源内递增，失败与重试可区分；已成功结果继续从原句段读取。
- 重启结算：服务启动时把上次停留在 `queued`、`planning`、`generating` 的任务结算为 `failed`，错误码 `SCENE_IMAGE_INTERRUPTED`；已成功任务与素材保持可读。真实服务接入后按 223 第 3.2 节先查询或恢复上游调用，再决定是否结算。
- 幂等：同一幂等键的并发请求只产生一个任务、一次规划与一次生成；重连、读图和复用已有任务都不产生新调用。

## 7. 测试与自验

新增 [p10-scene-image.test.ts](../../../backend/tests/p10-scene-image.test.ts)，8 项：

- 手动任务从已保存回复发起，任务字段、区间、两种读取入口、图片解码、分页与详情引用、事件顺序 `queued → planning → generating → succeeded` 一致。
- 同一幂等键并发请求只创建一个任务、只生成一次；重复请求不改变原图层模式。
- 跨窗口、跨角色、用户消息锚点和不存在消息的拒绝码正确。
- 两种图层分别记录模式与画布尺寸。
- 生成失败保留正文与句段，不产生素材；新幂等键重试成功且尝试序号递增。
- v12 → v13 迁移保留消息、句段、事件和游标，旧回复仍可发起新任务。
- 重启把停留在 `generating` 的任务结算为 `SCENE_IMAGE_INTERRUPTED`，已成功结果仍可读。
- SSE 从较早游标重连补齐 `planning`、`generating`、`succeeded`，从最新游标重读不重复。

满载并行运行全量测试时，既有的输入状态等待用例（1 秒输入窗口）和任务暂停用例（1.5 秒自动唤醒）会先于断言到期。本轮把两处等待窗口分别放宽到 3 秒和 6 秒，并降低假图 PNG 压缩等级，断言内容和被测行为不变；调整后满载环境连续两次运行 270 项测试均无失败。

执行结果：Node.js 24.22.2，类型检查通过；全量正式测试 270 项通过（原 262 项加本轮 8 项）；统一离线验收 21／21 步通过，交付回归 2／2，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-09T08-23-00-526Z-b7f61b84/`，`summary.json` 记录逐步结果与源码哈希。

## 8. 未完成与后续

- CG-02：模型规划、附近上下文、服饰参考图与真实生图适配尚未接入；本轮只固定端口、文件验证、落盘、失败与重试。
- CG-03：自动判图、冷却、跳过与计量尚未开始；`idx_scene_image_auto_attempt` 与 `skipped` 状态已预留。
- CG-04：独立复核未进行；真实服务、桌面渲染和打包结果需分别留证。
- 223 第 4 节的手动区间交互、自动触发规则、首个生图服务和重画／多版本仍待确认，本文不将其写成已定需求。
