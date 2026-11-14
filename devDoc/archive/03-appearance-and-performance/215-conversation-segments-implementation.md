# 对话演出第一包实施记录：句段与表情标注

> **现行规范入口**：本文涉及的现行句段切分、流式事件与异步表情标注契约已整合至 [对话演出、输入状态、SSE 与过场图规范](../../specs/conversation-performance-and-scene-images.md)；下文保留第一包实施与自验记录。

2026-11-09，`dev-front` 工作树。按 [213](213-conversation-performance-backend-plan.md) 的开发顺序完成第一包：用离线模型确定回复句段标识、表情标注和恢复契约。音色、试听、语音合成与生成过场图尚未开始。工作树未提交、未推送，未调用真实模型或付费服务。独立复核见 [216](216-conversation-performance-independent-review.md)，R01～R04 及 [216 第 4 节](216-conversation-performance-independent-review.md#4-217-修复独立复验)补充缺口的修复见 [217](217-conversation-performance-review-fixes.md)。

## 1. 范围与结果

- 一轮角色回复仍只保存一条助手消息，完整正文、发送者和状态不变。
- 正文按自然句段切分并保存稳定 `segmentId`、段序、原文起止位置、文字与台词／旁白类型。
- 正常提交、用户打断和主动分享都会生成句段；句段事件先于回复完成或中断事件发布。
- 消息列表一次返回本页句段和未完成回复文字；单条消息可按消息编号读取消息与句段。
- 角色当前有服饰差分时，回复提交后异步调用同一对话模型为句段选择差分，校验归属后保存 `outfitId`／`spriteAssetId`，并以晚到的 `segment_annotations` 事件发布。
- 没有服饰、服饰没有差分、模型返回非法素材或标注调用失败时，只保留正文与句段，不改变回复状态。
- 统一离线验收 21 步、221 项正式测试通过，`sourceUnchanged=true`，真实服务调用 0。

## 2. 存储与迁移

业务库版本升至 v8，新增 `message_segments` 表：一条句段一行，含消息、窗口、段序、类型、文字、起止位置、标注服饰与差分、标注时间；`(message_id, ordinal)` 唯一，按窗口和消息建索引。`execution_stream_events` 按既有表重建方式加入 `message_segments` 与 `segment_annotations` 两种事件类型，旧事件原样保留。 [schema.ts](../../../backend/src/storage/schema.ts#L1076) · [句段表](../../../backend/src/storage/schema.ts#L1078)

新建与重新打开角色库均按 v8 校验表、列和索引；P1、P2 的 schema 版本断言同步更新。v7 到 v8 的迁移沿用 V5 的事件表重建模式，本轮未保留可迁移的 v7 实体库，未单独重放旧库迁移。

## 3. 句段切分

[segmentMessage](../../../backend/src/domain/message-segments.ts#L29) 为纯函数：

- 换行固定分段；空行只增加段间边界，不产生空段。
- 在括号外的 `。！？!?…` 处断句，英文句点后接空白或行尾时断句；连续的句末符号和右引号并入前段。
- 行首的 `（…）`、`(…)`、`【…】` 动作段单独成段，其后的台词另起一段。
- 整段由括号包裹、以 `旁白：`／`旁白:` 开头或以 `*…*` 包裹时标为 `narration`，其余为 `speech`。
- 同一行内，任一侧少于 8 个字符且合并后不超过 30 个字符的相邻台词合并为一段；不跨行合并，不与旁白合并。
- 始终满足 `content.slice(startOffset, endOffset) === text`，便于回看原文和后续按段合成。
- 空白正文返回空数组；空正文不会生成空句段。

句段在提交、打断或主动分享的同一事务内写入；`insertMessageSegments` 已存在句段时直接返回，避免重入重复插入。 [insertMessageSegments](../../../backend/src/storage/conversation-store.ts#L665)

## 4. 事件与读取契约

| 场景 | 事件顺序 |
| --- | --- |
| 正常回复 | `message_delta`… → `message_segments` → `message_completed` |
| 用户打断或执行失败 | `message_delta`… → `message_segments` → `message_interrupted` → 终态事件 |
| 主动分享 | `message_segments`（`proactive=true`）→ `message_completed` |
| 表情标注 | `message_completed` 之后追加 `segment_annotations` |

句段事件携带 `replyMessageId` 与完整句段；`segment_annotations` 携带消息编号和本次写入的 `segmentId`、`outfitId`、`spriteAssetId`。两者都写入 `execution_stream_events`，按既有游标重放。

消息列表响应增加两个字段：`segments` 返回本页消息的全部句段，`activeReply` 在回复生成中返回消息编号、执行编号和已产生的文字（来自 `message_delta` 事件）；生成中的消息正文在列表中仍为空。 [消息列表](../../../backend/src/application/message-service.ts#L32) · [未完成回复快照](../../../backend/src/storage/conversation-store.ts#L590)

新增 `GET /v1/roles/:roleId/windows/:windowId/messages/:messageId`，返回 `{ message, segments }`；消息不属于该角色窗口时返回 404 `MESSAGE_NOT_FOUND`。 [消息详情路由](../../../backend/src/http/routes.ts#L233) · [详情读取](../../../backend/src/storage/conversation-store.ts#L540)

## 5. 表情标注

[SegmentAnnotationService](../../../backend/src/application/segment-annotation-service.ts#L63) 在回复提交后运行：

1. 读取消息和待标注句段，要求消息不是 `generating` 状态；按提交时捕获的角色状态确定服饰，读取该服饰的差分。没有服饰或差分为空时直接结束，不调用模型。
2. 使用角色当前对话模型绑定，发送只含句段与差分清单的 JSON 请求，不携带工具，要求返回 `{"segments":[{"segmentId","spriteAssetId"}]}`。 [提示词](../../../backend/src/application/segment-annotation-service.ts#L197)
3. 解析时允许代码块包裹，只接受属于本消息的 `segmentId` 和属于本服饰的 `spriteAssetId`；未知编号、重复段和非法形状丢弃。 [解析](../../../backend/src/application/segment-annotation-service.ts#L223)
4. 在同一事务内只更新尚未标注的句段，保存 `outfitId`、`spriteAssetId` 和 `annotatedAt`，并追加 `segment_annotations`。
5. 标注调用失败、响应不完整或没有任何有效选择时静默结束；正文、句段和消息状态不受影响。

提交时从 `commitConversation` 返回值捕获本轮状态，因此换装后新回复使用新服饰，旧句段保留原服饰和原差分；测试覆盖了两次换装后的历史读取。标注任务计入角色空闲判定，`waitForIdle` 会等待其结束；关闭服务时中止在途标注并等待收尾。主动分享由 `AutonomyService` 的消息通知接入同一队列。 [标注排队](../../../backend/src/application/conversation-service.ts#L212) · [提交后触发](../../../backend/src/application/conversation-service.ts#L1715) · [空闲判定](../../../backend/src/application/conversation-service.ts#L2438)

## 6. 测试与自验

新增 [p7-performance.test.ts](../../../backend/tests/p7-performance.test.ts)，8 项：

- 纯句段切分：短句合并、长句拆分、动作旁白、换行与空正文，逐段断言原文范围。
- 一条回复只保存一条助手消息，句段稳定、列表与详情一致、`message_segments` 先于完成事件、按游标重放一致、详情路由与 404。
- 用户打断：部分文字形成句段，`message_segments` 先于 `message_interrupted`；生成中的快照返回已产生文字，结束后快照为空。
- 主动分享：一条消息、两段句段、两个事件按序保存。
- 表情标注：从提交服饰选择差分、非法段与非法差分被丢弃、晚到事件在完成事件之后、历史重放保留旧服饰、换装后的新回复使用新服饰。
- 真实 SSE：按 `after=0` 重放时 `message_segments` → `message_completed` → `segment_annotations` 顺序正确，标注事件包含正确素材。
- 服饰没有差分时不调用标注模型，也不产生标注事件。
- 标注输出解析器只接受已知句段和差分。

执行结果：Node.js 24.22.2，类型检查通过；全量正式测试 221 项通过（原 213 项加本轮 8 项）；统一离线验收 21／21 步通过，交付回归 2／2，`sourceUnchanged=true`，真实服务调用 0。运行目录为 `backend/test-results/p5-2026-11-08T16-35-22-007Z-f0db781c/`，`summary.json` 记录逐步结果与源码哈希。

## 7. 未完成与后续

- 213 的后续工作包尚未开始：角色音色配置、试听、按句段直接返回音频的 TTS，以及过场图的画面规划、生成任务和触发规则。
- 标注模型调用目前不写入 `model_calls`／`call_metering`，也未使用独立模型用途枚举；调用成本暂不可从既有模型调用记录统计。
- 标注失败不重试；重连只能读到已保存的句段和标注，不会重新发起标注。
- 桌面尚未接入句段气泡、立绘切换、TTS 播放和过场图；本轮只完成后端契约与离线验证。
- 本轮未在真实 v7 业务库上重放迁移，未验证真实模型服务的标注质量，也未验证大型回复的标注时延。
- 按 213 的顺序，下一步先接角色音色与试听，再完成按句段合成；过场图在后。独立复核通过前不提交。
