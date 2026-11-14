# 对话演出、输入状态、SSE 与过场图规范

> **定位与范围**：本文件为对话演出引擎、输入状态同步、窗口快照与 SSE 重连、桌面对话演出协同以及过场图生命周期的**现行开发与验收权威规范**，整合 `174 §8`、`213`、`223`、`225`、`270 §1～§2`、`280 §2` 的现行有效规则及独立复核定稿。首次配置交互与对话恢复（`278 §4`）及存储／记忆／自主执行主体见 [存储、记忆与自主执行规范](storage-memory-and-autonomy.md)；TTS 与生图服务底层适配见 [TTS 与生图服务接入规范](tts-and-image-services.md)，当前通过基线与待收口事项以 [当前状态看板](../STATUS.md) 为准。

---

## 1. 范围、上游决策与依赖边界

### 1.1 涵盖子系统

1. **窗口与消息快照协议**：按 `roleId + windowId` 隔离的窗口创建／列表、消息分页（默认最新一页、`before` 向前翻页、`after` 增量同步），与单事务一致的 SSE 游标及 `activeReply`。
2. **正在输入状态与打断调度**：按 `(roleId, windowId, clientId)` 维护内存态输入状态、1 秒固定过期与续期、断开清理、新消息打断未完成回复而打字不打断、以及消息提交去重与等待原因回执（`waitReason`）。
3. **句段切分与异步表情标注**：单条助手消息持久化，按自然句段切分为 `speech` / `narration`、流式部分句段与终态重对账、异步差分标注、历史服饰与主页立绘回退链。
4. **SSE 事件流与前端会话同步**：`execution` 事件流（13 种 `ConversationStreamType`）、`after` 与 `Last-Event-ID` 游标协商、15 秒注释心跳、请求期事件暂存与重连恢复。
5. **桌面对话演出与语音协同**：点击／`Enter`／`Space` 逐句推进、输入框隐藏与恢复、旁白跳过语音与在播台词切段不早停、按句合成消费与预取、历史定位与舞台冻结、`237～239` 布局与换光现状。
6. **过场图任务与受管素材（当前仅手动触发与文生图）**：已保存助手消息上的手动过场图创建、幂等复用、模型／固定画面规划、`background` 与 `full_scene` 图层约束、历史服饰参考图、受管落盘与读取、启动故障结算。

### 1.2 边界分工（不在此处重复）

- **角色活动三态、配置写入守卫、生图/语音全局服务管理、草稿探测与 `292-R07` 预览服饰归属**：归属 [角色配置、全局资源与活动守卫规范](role-config-and-activity.md)。
- **桌面视觉令牌、`lint:styles`、主题变体与 Reduced Motion 策略**：归属 [前端设计规范](frontend-design-system.md)。
- **TTS 服务协议、IndexTTS 桥接、ComfyUI workflow 节点打补丁、凭据与生图参数校验**：见 [TTS 与生图服务接入规范](tts-and-image-services.md)。
- **首次配置引导（`278 §4`）、分库存储、记忆整理与自主活动调度主体**：见 [存储、记忆与自主执行规范](storage-memory-and-autonomy.md)。

### 1.3 上游决策依据（[161 持续决策记录](../161-digital-life-direction-decisions.md)）

| 决策编号 | 约束要点 |
| --- | --- |
| `DL-80`～`DL-83` | 结合正在输入状态启动回复；停止输入 1 秒后退出且不配置开关；仅实际发送新消息才中断未完成回复；输入态属实时交互状态无需落库恢复，前端断连／切换时按窗口游标与去重提交恢复 |
| `DL-121`～`DL-122` | 后端同时提供进程内异步调用与本机 HTTP + SSE 实时流；消息提交通过 `submissionId` 幂等去重，防网络抖动与重复发送 |
| `DL-136`～`DL-140` | 对话共用角色衣柜与每日穿搭素材；单轮助手回复保存一条消息并按自然句段切分展示；差分与表情保持可选；支持按句调用统一 TTS 直接返回音频 |
| `DL-141` | 桌面对话点击或快捷键按句推进；生成或待展示期间隐藏输入框并在末句出现后恢复；旁白只展现动作／神态不调用 TTS，且不主动打断正在播放的上一句台词 |
| `DL-142`～`DL-143` | 过场图支持手动与（后续）自动触发；分为 `background`（仅替换背景保留立绘）与 `full_scene`（临时覆盖双层并带服饰参考图）；迟到或不在实时窗口时不强切当前阅读，挂载在所属句段旁且允许关闭 |
| `DL-144`～`DL-146` | 精简对话页独立顶栏，演出设置与历史入口并入对话栏右上角；性能设置内提供本地偏好的「隐藏底部导航栏」；模型服务失败或未配置等状态明确可见 |

---

## 2. 正常入口、输入输出、数据归属与状态码

### 2.1 对话、输入状态、SSE 与语音消费接口

以下路由均由 [routes.ts](../../backend/src/http/routes.ts#L224-L405) 与 [voice-routes.ts](../../backend/src/http/voice-routes.ts#L231-L252) 注册。

| 方法与路径 | 输入 / 查询参数 | 成功响应 | 主要校验与错误码 |
| --- | --- | --- | --- |
| `POST /v1/roles/:roleId/windows` | JSON：`windowSchema` | `201` 创建新窗口 | 按 [routes.ts](../../backend/src/http/routes.ts#L224-L240) 写入窗口记录 |
| `GET /v1/roles/:roleId/windows` | — | `200 { items }` | 角色目录与 `initStatus` 校验（`RoleAccess`） |
| `POST /v1/roles/:roleId/windows/:windowId/messages` | JSON：`{ content, submissionId, source }` | `201` 新消息 / `200` 重复提交；均含 `{ message, duplicate, decisionScheduled, waitReason }` | 先执行 `findSubmittedMessage`，**之后**才检查 `activity.assertCanStart(roleId)`；同 `submissionId` 不同内容返回 `409 SUBMISSION_CONFLICT`；未入库新消息遇到角色停用返回 `409 ROLE_ACTIVITY_STOPPED` |
| `GET /v1/roles/:roleId/windows/:windowId/messages` | `?after=` 或 `?before=`（互斥），`limit`（`1..200`，默认 `50`） | `200 { items, hasMore, nextAfter, nextBefore, segments, activeReply, cursor, sceneImages }` | `after` 与 `before` 同传或非整数越界返回 `400 INVALID_QUERY`；单读事务采集全字段与 `cursor`，确保快照与 SSE 无缝衔接 |
| `GET /v1/roles/:roleId/windows/:windowId/messages/:messageId` | — | `200 { message, segments, sceneImages }` | 窗口与消息归属不匹配返回 `404 WINDOW_NOT_FOUND` / `404 MESSAGE_NOT_FOUND` |
| `POST /v1/roles/:roleId/windows/:windowId/input-state` | JSON：`{ clientId, typing }` | `200` 输入态或清空确认 | 请求体结构校验失败（空或空白 `clientId`、非布尔 `typing`、缺少 `typing` 或多余字段，[schemas.ts](../../backend/src/http/schemas.ts#L130-L135)）返回 `400 INVALID_REQUEST`；省略 `clientId` 或空白路径标识触发输入态业务校验（`InputStateInvalidError`，[input-state.ts](../../backend/src/application/input-state.ts#L144-L154)）返回 `400 INPUT_STATE_INVALID`；更新内存态并在 `typing=false` 时顺带触发 `schedule` |
| `DELETE /v1/roles/:roleId/windows/:windowId/input-state` | `?clientId=`（必填） | `200 { cleared: true }` | `clientId` 缺失或为空返回 `400 INPUT_STATE_INVALID`；清理指定客户端状态并触发 `schedule` |
| `GET /v1/roles/:roleId/windows/:windowId/events` | `?after=` 与／或 Header `Last-Event-ID`，可选 `?clientId=` | `200 text/event-stream` | 游标非法或非本窗口有效事件编号返回 `400 SSE_CURSOR_INVALID`；见 §2.4 重放与心跳 |
| `GET /v1/roles/:roleId/executions/:executionId` | — | `200` 执行详情 | 不存在返回 `404 EXECUTION_NOT_FOUND` |
| `POST /v1/roles/:roleId/windows/:windowId/segments/:segmentId/speech` | 可选 JSON：`{ emotion? }` | `200` 音频字节流（`cache-control: no-store`） | 空文本 `400 VOICE_SEGMENT_EMPTY`；角色语音停用 `409 VOICE_DISABLED`；未找到句段 `404 MESSAGE_SEGMENT_NOT_FOUND`；上游异常 `409 TTS_VOICE_UNAVAILABLE` / `502 TTS_SYNTHESIS_FAILED` / `503 TTS_SERVICE_UNAVAILABLE` / `504 TTS_TIMEOUT` |

### 2.2 过场图任务与受管素材接口

以下路由由 [scene-image-routes.ts](../../backend/src/http/scene-image-routes.ts#L14-L64) 注册，请求体由 [schemas.ts](../../backend/src/http/schemas.ts) 与路由校验约束：

| 方法与路径 | 输入 | 成功响应 | 主要校验与错误码 |
| --- | --- | --- | --- |
| `POST /v1/roles/:roleId/windows/:windowId/messages/:messageId/scene-images` | `{ idempotencyKey, layerMode? }` | `201` 新任务 / `200` 同一幂等键复用；均含 `{ task, duplicate }` | 角色删除中 `409 ROLE_DELETING`；非助手消息／缺少执行归属／消息仍 `generating` 返回 `409 SCENE_IMAGE_ANCHOR_INVALID`；消息无句段返回 `409 SCENE_IMAGE_SEGMENTS_MISSING` |
| `GET /v1/roles/:roleId/windows/:windowId/scene-images/:taskId` | — | `200 { task }` | 跨窗口或不存在返回 `404 SCENE_IMAGE_TASK_NOT_FOUND` |
| `GET /v1/roles/:roleId/scene-images/assets/:assetId` | — | `200` 原始图片字节（`cache-control: private, max-age=31536000, immutable`） | 记录缺失 `404 SCENE_IMAGE_ASSET_NOT_FOUND`；文件丢失 `404 SCENE_IMAGE_ASSET_FILE_MISSING`；格式／长度不符 `500 SCENE_IMAGE_ASSET_CORRUPT` |

### 2.3 数据归属与持久/内存分布

| 存储层级 | 具体载体 | 归属与生命周期说明 |
| --- | --- | --- |
| **每角色业务库**（`BUSINESS_SCHEMA_VERSION = 17`，见 [schema.ts](../../backend/src/storage/schema.ts#L12)） | `windows`、`messages`、`executions`、`message_segments`、`execution_stream_events`、`scene_image_tasks`、`scene_image_assets`、`model_calls` | 一轮回复在 `messages` 保持一条；`message_segments` 记录 `segment_id`、`ordinal`、`kind`（`speech` / `narration`）、字符起止偏移、`outfit_id`、`home_asset_id`、`sprite_asset_id`、`annotated_at`；`scene_image_tasks` 记录锚点消息／执行、`trigger_source`（`manual` / `auto`）、`layer_mode`、`start_segment_id`～`end_segment_id`、`attempt_no`、`config_json`（固定服务与锚点快照）；`scene_image_assets` 按 `task_id` 唯一索引约束每任务最多一张成图 |
| **每角色文件系统** | `<roleDir>/scene-images/<assetId>.<ext>` | 仅通过 `readAsset(roleId, assetId)` 校验路径与魔数读取，相对路径不通过 HTTP 暴露 |
| **后端进程内存态** | `InputStateRegistry`（[input-state.ts](../../backend/src/application/input-state.ts#L12)）与 `blockedWindows` | 输入状态 1 秒自动过期，重启动清空，不持久化；执行异常写入 `blockedWindows` 直到该窗口收到新消息或用户显式重试（`283 R02`） |
| **桌面渲染器内存与本地存储** | `useWindowSession` 会话状态与 `drafts`；`localStorage` | `drafts` 按 `${roleId}:${windowId}` 分键隔离；`nowadays-dialogue-voice` / `nowadays-dialogue-scene` 与 `nowadays-dialogue-dock`（见 [Conversation.tsx](../../desktop/desk-preview/renderer/src/pages/Conversation.tsx#L22-L27)）记录演出本地偏好；音频缓存（`MAX_CACHE = 48`）通过 `URL.createObjectURL` 驻留并在切换角色／窗口／卸载时释放 |

### 2.4 SSE 事件类型与消息接收等待原因

1. **SSE 数据帧与心跳**（[conversation-service.ts](../../backend/src/application/conversation-service.ts#L620-L647)）：
   - 每条持久化流事件发送为 `id: <streamEventId>\nevent: execution\ndata: {"streamEventId":...,"type":...,...}\n\n`。
   - 游标解析（[routes.ts](../../backend/src/http/routes.ts#L972-L998)）：同时存在查询参数 `?after=` 与请求头 `Last-Event-ID` 时取 `Math.max(...)`，防止 `EventSource` 带旧 URL 自动重连时重复吐字。
   - 空闲连接每 `15_000` ms 输出 `: heartbeat\n\n`；客户端断连或 `closeStreams(roleId)` 时立即清理对应的 `clientId` 输入态并尝试恢复队列调度。
2. **现行 13 种 `ConversationStreamType`**（[conversation.ts](../../backend/src/domain/conversation.ts#L6-L23)，已从 `174 §8.5` 原设计的 8 种扩展）：
   - `execution_started`、`message_delta`、`tool_started`、`tool_backgrounded`、`tool_result_saved`、`message_segments`（支持流式 `partial: true` 与终态正式段）、`segment_annotations`、`scene_image_task`、`message_completed`、`message_interrupted`、`execution_superseded`、`execution_paused`、`execution_failed`。
3. **消息接收等待原因 `ConversationWaitReason`**（[conversation.ts](../../backend/src/domain/conversation.ts#L25-L30) 与 [conversation-service.ts](../../backend/src/application/conversation-service.ts#L1091-L1134)）：
   - `ROLE_STOPPED`：角色处于停止／暂停态。
   - `MODEL_MISSING`：未配置或缺失可用对话模型。
   - `BUSY`：角色其他执行仍在运行（含后台任务／主动执行占槽）。
   - `WINDOW_BLOCKED`：当前窗口因上轮失败被加入 `blockedWindows`。
   - `QUEUE_PENDING`：无上述阻断但排队尚未轮到当前消息。

---

## 3. 状态流转、并发切换、失败恢复与前后端边界

### 3.1 输入状态、消息提交去重与打断语义

- **输入态保活与 1 秒退出**（[typing-state.js](../../desktop/desk-preview/renderer/src/conversation/typing-state.js#L2-L51)、[input-state.ts](../../backend/src/application/input-state.ts#L10-L96)）：
  - 前端 `createTypingState` 串行泵送更新并维护 `delay = 1000` ms 定时器；持续键入只刷新过期时间，停输 1 秒后发送 `typing: false`；切换窗口／卸载调用 `close()` 在最后一次请求完成后调用 `DELETE .../input-state?clientId=`；打字本身**不会**中断正在生成的回复（`DL-81`）。
- **提交与活动停止态的判定先后**（[280 §2](../archive/06-workflow-simplification/280-278-progress-role-workspace-dialogue-receipt.md#L15-L45)、[routes.ts](../../backend/src/http/routes.ts#L251-L280)、[conversation-service.ts](../../backend/src/application/conversation-service.ts#L264-L296)）：
  - `POST .../messages` 先查 `findSubmittedMessage`：已存在的 `submissionId` 跳过「禁止新建」门槛，重新清理 `blockedWindows` 并重新评估调度与 `waitReason` 返回 `200`；真正的新提交才触发 `activity.assertCanStart(roleId)`，角色停止时拒绝入库并返回 `409 ROLE_ACTIVITY_STOPPED`。
  - 当返回 `decisionScheduled: false` 且 `waitReason` 为 `ROLE_STOPPED`、`MODEL_MISSING` 或 `WINDOW_BLOCKED` 时，桌面端释放待机输入区并保留原 `submissionId`，显示对应的就地动作（「恢复活动」／「配置对话模型」／「重试」）。
  - 并发竞争保护（`283 §5 R02`）：若 POST 响应尚未返回时 SSE `execution_started` 已经到达并点名 `messageIds` 包含刚入库的用户消息，前端先在 `awaitingSubmission` 期将事件缓存在 `bufferedEvents`，拿到响应后优先以 SSE 为准进入正常演出，避免误跌入 `wait` 提示。
- **打断与暂停节点收敛**（[conversation-service.ts](../../backend/src/application/conversation-service.ts#L1859-L2338)）：
  - **新消息抢占（`supersedeWindow`）**：同窗口运行中（或他窗口正在自主运行）的执行被标为 `superseded` 并中止控制器；若已有 `partialText`，落库为 `status = 'interrupted'`、生成正式句段并发送 `message_segments` -> `message_interrupted` -> `execution_superseded`；若尚无文字，则清理占位生成的空 `generating` 记录。
  - **角色请求停止（`ROLE_STOP_REQUESTED`）**：只在图节点边界检查（`checkStopBoundary`），不在模型流吐字半途强切；执行与任务记为 `paused`，用户消息保持 claimed 状态等待恢复后续行；若没有后台记忆等在途收尾工作则立即确认停止。
  - **慢工具转后台（`TOOL_BACKGROUNDED`）**：放弃当前执行槽位并保留用户消息领取态，待工具完成后续行。

### 3.2 句段切分、异步标注与舞台立绘回退

- **句段切分规则**（[message-segments.ts](../../backend/src/domain/message-segments.ts)）：
  - 整行 `*...*`、`旁白：`、`【旁白】` 划为 `narration`；显式旁白内若出现引号台词或 `台词：` / `对白：` 再切出 `speech`；行内 `*动作*` 与台词拆分保留原文起止偏移；短句合并门槛为 `SHORT_SEGMENT_CHARS = 8`、`MAX_MERGED_CHARS = 30`。
  - 流式增量期间 `insertMessageSegments(..., partial=true)` 为已稳定段落提前发出 `message_segments`（`partial: true`）并保持 `segmentId`；终态提交或打断时对齐／替换未稳定末段。前端 `reconcileFinalSegments` 同步修正 `shown` 进度：若被缩短或末尾段已露出，则立即恢复输入框（`FE-R01` 闭环）。
- **异步表情标注与计量边界**（[segment-annotation-service.ts](../../backend/src/application/segment-annotation-service.ts#L103-L315)）：
  - 回复正式提交（或主动分享写入）之后异步派发；先校验消息未生成、存在未标注句段、有当前服饰且该服饰有至少 1 张 `sprites`。
  - 经 `resolveClaimedModelBinding` 协调模型维护窗口与在途占用，并**在扣点与 `model_calls` 登记前先完成适配器及凭据初始化**；因此 `file:` 凭据缺失或格式错误时 `model_calls` 与自主点数均不递增（`216 R03` 终版闭环）。
  - 仅在模型调用返回合法 JSON 且通过本服饰 `sprites` 白名单校验后写回 `sprite_asset_id` 并推送 `segment_annotations`；任何解析异常或调用失败都只记录调用结局，**不影响已保存正文与句段展示**。
- **立绘渲染与跨服饰回退链**（[ConversationStage.tsx](../../desktop/desk-preview/renderer/src/conversation/ConversationStage.tsx#L88-L115) 与 [270 §1](../archive/05-model-settings-and-dialogue/270-268-progress-dialogue-model-picker.md#L5-L12)）：
  - 差分选取由 `spriteForRow` 按 `spriteAssetId` 应用，不强制要求句段携带 `outfitId`；同一轮无标注句段沿用同轮前一个有效差分；每一段在提交时同时固化当轮 `outfitId` 与 `homeAssetId`。
  - 舞台角色图按严格降级链取首个未触发解码错误（`failedSources`）的源：`spriteAssetId` 差分图 -> 句段当轮快照 `segmentHomeUrl`（`homeAssetId`） -> 角色当前服饰主页图 `outfitUrl` -> 主题角色底图 `themeUrl`。双缓冲 `CrossfadeLayer` 仅在新图解码完成后切槽淡入。

### 3.3 桌面对话交互、按句语音与对象切换隔离

- **逐句推进与等待反馈**（[ChatPane.tsx](../../desktop/desk-preview/renderer/src/conversation/ChatPane.tsx#L177-L335)、[advance.js](../../desktop/desk-preview/renderer/src/conversation/advance.js)）：
  - 用户发送后立即清除当前 `wait` 与错误、聚焦消息滚动容器并隐藏输入框；收到首个可用句段即自动推进显示第一句；之后用户在消息区域点击（`shouldAdvanceFromClick`，避开按钮／链接／输入框／已选中文本）或按键 `Enter` / `Space`（`shouldAdvanceFromKey`，且已处理 `Shift+Enter` 换行与 IME `isComposing`/`keyCode === 229`）推进下一段；未到下一段时显示「正在组织回复…」或「下一句还在准备…」（`271 MR-05`）。
  - 一旦终态到达且末段展示完毕（含单句或失败空回复），立即还原输入框并归还草稿焦点（非历史查看态时）。
- **语音播放、预取与停用处理**（[use-segment-voice.ts](../../desktop/desk-preview/renderer/src/conversation/use-segment-voice.ts)）：
  - 播放键为 `[roleId, windowId, voiceRevision, segmentId, text]`（按 `roleId` 变化从 `GET .../voice` 刷新 `updatedAt` 版本，前端目前未传 `emotion` 字段，由服务端按文本推断）。
  - 仅自动播放已开启且当前处于实时跟随且历史面板未打开时的 `speech`（非 `action`）段；遇到 `action`（旁白）只取消 220 ms 自动播放防抖（`cancelPending`），**保留已经在播的上一句音频直到自然结束或遇到新台词**；新音频切换在 `onplaying` 触发后才停掉旧 `<audio>`（`FE-R02`）。
  - 预取 `current` 及后续最多 2 个可播句段；若后端返回 `409 VOICE_DISABLED`，自动播放与预取即刻静默跳过以省去重复报错，唯有用户手动点击小喇叭会清除停用标记并向服务端重查及 toast 提示。
- **对象切换、恢复草稿与历史隔离**（[use-window-session.ts](../../desktop/desk-preview/renderer/src/conversation/use-window-session.ts)、[Conversation.tsx](../../desktop/desk-preview/renderer/src/pages/Conversation.tsx)）：
  - 每次切换 `roleId` 或 `windowId` 递增 `generation`，关闭旧 `EventSource`、释放全部语音对象 URL 并重置 `CacheGeneration` 与阅读跟随状态；各窗口未发送草稿独立记忆在 `drafts` Map；仅当快照确认了之前因异常恢复且**未被用户编辑过**（`shouldClearRecoveredDraft`）的草稿时才自动清空，避免吞掉用户续写内容（`283 §9 R02`）。
  - 打开 `HistoryPanel`、向上滚动离开底部跟随或定位历史消息时，`stageLive` 变为 `false`，舞台冻结在进入回看前的 `frozenScene` 与 `stageRow`；新到过场图与背景切换不打断当前回看，点击「回到最新」后才按实时进度更新（`FE-R04`）。

### 3.4 过场图任务状态机、配置锁定与图层语义

- **状态流转**：`queued` -> `planning` -> `generating` -> 终态（`succeeded` / `skipped` / `failed`）。每次状态变化写入 `scene_image_task` 流事件并在重连时按游标补全。
- **接收时配置锁定与跨站点保护**（[scene-image-service.ts](../../backend/src/application/scene-image-service.ts#L121-L162)、[comfyui-generator.ts](../../backend/src/scene/comfyui-generator.ts#L215-L250)）：
  - 任务创建当刻调用 `generator.lock(roleId)` 将当前服务协议、基地址、超时期限、角色生图设置与服饰锚点序列化进 `config_json`；规划期间用户在设置页修改配置或锚点不影响已在途的旧任务（`CG-R03`）。
  - 进入 ComfyUI 生成前核对快照站点标识与当前服务记录站点标识：若跨站点／改地址，直接结算失败 `409 SCENE_IMAGE_SERVICE_CHANGED`（避免将新站点令牌发往旧地址 `CG-R05`）；同站点更新路径或轮换令牌则继续沿用快照地址与新令牌完成生成。
- **规划输入与图层约束**（[scene-image-service.ts](../../backend/src/application/scene-image-service.ts#L335-L450)、[scene-image-store.ts](../../backend/src/storage/scene-image-store.ts#L154-L200)）：
  - 上下文取锚点消息之前最多 4 条已结束消息；`outfitForMessage` 只读取目标轮句段固化的 `outfit_id`，不回退角色当前穿着（`227 R04`）。
  - 默认注入 `ModelSceneImagePlanner`（以 `FixedSceneImagePlanner` 为缺绑定兜底）：无对话模型时回退固定规划（首段到末段 + 请求图层）；有模型但模型调用失败、登记 `model_calls` 失败或返回非法／与手动冲突的图层模式时直接以 `SCENE_IMAGE_PLAN_FAILED` / `SCENE_IMAGE_PLAN_INVALID` / `SCENE_IMAGE_PLAN_UNAVAILABLE` 失败，不回退掩盖错误（`227 R02/R03`）。
  - `background`：严格禁止拼入角色／服饰锚点且不附带参考图（`CG-R01`）；`full_scene`：传入历史服饰 `home` 参考图（经魔数与大小校验 `<= 8 MiB`，缺失或损坏时降级为无参考继续出图）。
- **超时竞争、中断清理与启动恢复**：
  - 使用服务侧外层超时（`generator` 固定超时期限或默认 180 秒）+ `AbortSignal` 与 `raceWithSignal` 双重竞争，范围同时覆盖生图请求**与图片像素校验解码**，落盘前再次复查取消状态；ComfyUI 轮询遇到中止时会请求一次 `/queue` 清理远端排队（`CG-R04`）。
  - 写入受管文件采用排他打开 `fs.openSync(..., "wx")` 并立即登记清理路径；中途 `ENOSPC` 等失败会删去半写入文件，即使清理被 `EPERM` 拒绝仍按原失败原因持久化任务终态与 SSE 通知并打警告日志（`227 R05/R06`）。
  - 进程启动执行 `recoverOnStartup()`，将未结束的 `scene_image_tasks` 统一结算为 `failed`（`SCENE_IMAGE_INTERRUPTED`）。
- **前端展示与晚到归属**：
  - 前端只认任务的 `startSegmentId` 挂载操作入口（查看／生成中／失败）；若引用句段不在当前列表则展示于独立「未找到对应句段」栏（`FE-R03`）；当 `sceneAuto` 开启、未被用户手动「收起过场图」（`dismissed`）且当前 `stageLive` 句段序号落在 `[start, end]` 时自动演示。

---

## 4. 验证范围与可执行命令

> 严格区分验证范围与真实服务边界：除显式标注为「待真实联调」的项外，当前全部自动化与独立复核均运行于本地 SQLite、离线脚本模型与本机模拟 HTTP 替身（`realServiceCalls=0`）。

### 4.1 已通过独立复核范围（离线 / 模拟外部服务）

| 范围 | 测试与验证证据 |
| --- | --- |
| 句段切分、流式部分段、异步表情标注与计量、SSE 重连与快照游标 | [p7-performance.test.ts](../../backend/tests/p7-performance.test.ts) · [216 独立复核](../archive/03-appearance-and-performance/216-conversation-performance-independent-review.md#6-217-第-7-节补修独立复验) |
| 手动过场图任务幂等、模型／固定规划、`background` vs `full_scene`、历史服饰、故障写盘与启动恢复 | [p10-scene-image.test.ts](../../backend/tests/p10-scene-image.test.ts) · [p11-scene-image-planning.test.ts](../../backend/tests/p11-scene-image-planning.test.ts) · [227 独立复核](../archive/03-appearance-and-performance/227-scene-image-independent-review.md#7-228-第-10-节-r06-独立复验) |
| ComfyUI 过场图适配器、配置锁定、跨站点变更拒绝（`CG-R01～R05`） | [p13-comfyui.test.ts](../../backend/tests/p13-comfyui.test.ts) · [250 独立复核](../archive/04-role-settings-and-media/250-comfyui-independent-review.md#251-第-5-节补修独立复验) |
| 消息接收去重、`waitReason` 回执、乱序 SSE 缓冲与恢复确认 | [p17-message-receipt.test.ts](../../backend/tests/p17-message-receipt.test.ts) · [p18-278-review-fixes.test.ts](../../backend/tests/p18-278-review-fixes.test.ts) · [283 §4～§9](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#4-284-修复独立复验) |
| 桌面对话演化、输入状态 1 秒防抖／清理、窗口会话、立绘降级链、逐句点击与 `FE-R01～R04` / `MR-04～05` | [conversation-advance.test.cjs](../../desktop/desk-preview/tests/conversation-advance.test.cjs) · [conversation-typing.test.cjs](../../desktop/desk-preview/tests/conversation-typing.test.cjs) · [conversation-window-model.test.cjs](../../desktop/desk-preview/tests/conversation-window-model.test.cjs) · [conversation-performance.test.cjs](../../desktop/desk-preview/tests/conversation-performance.test.cjs) · [conversation-review-regression.py](../../desktop/desk-preview/tests/conversation-review-regression.py) · [231 独立复核](../archive/03-appearance-and-performance/231-conversation-desktop-independent-review.md#4-232-修复独立复验) · [271 §8](../archive/05-model-settings-and-dialogue/271-model-settings-and-dialogue-independent-review.md#8-276-补修独立复验) |

### 4.2 实现方自验、待独立复核范围

- [237 对话页日落刻度明暗切换](../archive/02-desktop-ui-and-relations/237-dialogue-theme-transition.md)（对应脚本 [theme-transition-check.cjs](../../desktop/desk-preview/tests/theme-transition-check.cjs)）：对话舞台光线、纸面 14 档逐行推进、历史层切换与 reduced-motion 收尾。
- [238 对话页顶部精简与布局调整](../archive/02-desktop-ui-and-relations/238-dialogue-layout-refinement.md) 与 [239 隐藏底部导航栏偏好](../archive/02-desktop-ui-and-relations/239-dialogue-dock-visibility.md)（对应脚本 [dialogue-layout-check.cjs](../../desktop/desk-preview/tests/dialogue-layout-check.cjs)）：右上角图标收纳、窄屏适配与 Dock 持久化偏好。

### 4.3 未实现能力与真实联调缺口

- **尚未实现的能力**：
  - `CG-03` **完成回复后自动触发过场图**：当前 [conversation-service.ts](../../backend/src/application/conversation-service.ts) 与 `SceneImageService` 之间没有任何自动调用挂钩，仅实现了显式 `requestManual`；冷却时间、间隔频率、`skipped` 决策阈值等策略未实施。
  - `CG-04` **过场图增量独立复核与真实服务适配**（[223 §2](../archive/03-appearance-and-performance/223-conversation-performance-development-guide.md)）：已完成基于模拟服务的后端自验、MOSS-Image 设置接入与 `CG-R01～R05` 测试，尚待结合 `223` 汇总开展过场图增量独立复核与真实生图服务联调。
  - **ComfyUI 图生图与服饰锚点图上传**（[248 §10](../archive/04-role-settings-and-media/248-comfyui-adaptation.md#10-未完成与后续)）：目前仅接入 MOSS-Image 文生图工作流，图生图与参考图上传作为后续能力单列。
  - **生图配置未就绪占位 vs 失败策略**：当前未配置真实生图服务时仍沿用 `FakeSceneImageGenerator` 产出样例图（`248 §10` 指出正式版需收口为明确失败或开关边界）。
  - **服务端历史按日期统计与关键词检索接口**：当前桌面 `HistoryPanel` 通过循环 `before` 分页拉取全部历史并在前端 [history.js](../../desktop/desk-preview/renderer/src/conversation/history.js) 建立索引（`231 §1`）。
  - **半写入残留自动清扫任务**：当前依赖单次失败删除及管理员／日志定位，`227 §7` 遗留后台清扫尚未实施。
  - **`DL-142` 未定交互细则**（[223 §4](../archive/03-appearance-and-performance/223-conversation-performance-development-guide.md)）：指定句段范围出图、重画／替换同轮旧图等产品交互仍未拍板。
- **尚未真实联调的能力**：真实模型长时间流式断开恢复、真实 TTS / IndexTTS 中文听感与设备输出、真实 ComfyUI + MOSS-Image 显存与耗时（[STATUS.md §2](../STATUS.md#2-当前待推进事项backlog)）、Windows 打包后整包运行。

### 4.4 可执行验证命令

```powershell
# 1. 后端类型检查、全量单元测试与 21 步统一离线验收（Node 24）
cd backend
npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit
npx -y node@24 --import tsx --test tests/*.test.ts
npx -y node@24 scripts/accept-offline.mjs

# 定向复验本专题核心测试
npx -y node@24 --import tsx --test tests/p7-performance.test.ts tests/p10-scene-image.test.ts tests/p11-scene-image-planning.test.ts tests/p13-comfyui.test.ts tests/p17-message-receipt.test.ts tests/p18-278-review-fixes.test.ts

# 2. 桌面渲染层门禁、构建与逻辑单测
cd desktop/desk-preview/renderer
npm run check
npm run build
cd ..
npx -y node@24 --test tests/*.test.cjs

# 3. 隔离 Electron + 本地后端链路／布局／换光验收脚本（仓库根目录）
npx -y node@24 desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs
npx -y node@24 desktop/desk-preview/tests/dialogue-layout-check.cjs
npx -y node@24 desktop/desk-preview/tests/theme-transition-check.cjs
```

---

## 5. 源文件、已知缺陷与复核追溯

### 5.1 已知缺陷与未决清单

| 编号 / 来源 | 问题摘要 | 当前状态 |
| --- | --- | --- |
| `292-R07`（[283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)） | `POST /v1/roles/:roleId/scene-image/preview` 通过 `AppearanceStore.getOutfit(outfitId)` 核验当前角色未删除服饰归属，异常或不存在返回 `404 OUTFIT_NOT_FOUND` | **已独立复核通过**（[283 §28](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)） |
| `237～239`（[STATUS.md](../STATUS.md#1-当前结论概览)） | 对话页日落换光、右上角图标收纳及隐藏 Dock 开关已完成实现方自验 | 待独立复核 |
| `223 §2` / `223 §4` / `248 §10` / `231 §1` | `CG-03` 自动触发过场图、`CG-04` 独立复核与真实生图适配、ComfyUI 图生图与服饰锚点图上传（后续能力）、未配置占位图回退策略、服务端历史检索、残留文件清扫 | 待设计／待实施／待复核联调 |
| [STATUS.md §2](../STATUS.md#2-当前待推进事项backlog) | `278 §4` 首次配置与对话恢复完整联调、真实 TTS／ComfyUI／多模型服务联调 | 待联调 |

### 5.2 核心实现文件清单

- **后端域模型、路由与输入验证**：
  - [conversation.ts](../../backend/src/domain/conversation.ts) · [message-segments.ts](../../backend/src/domain/message-segments.ts) · [scene-image.ts](../../backend/src/domain/scene-image.ts) · [errors.ts](../../backend/src/domain/errors.ts)
  - [routes.ts](../../backend/src/http/routes.ts) · [scene-image-routes.ts](../../backend/src/http/scene-image-routes.ts) · [voice-routes.ts](../../backend/src/http/voice-routes.ts) · [schemas.ts](../../backend/src/http/schemas.ts)
- **后端应用服务与存储**：
  - [conversation-service.ts](../../backend/src/application/conversation-service.ts) · [message-service.ts](../../backend/src/application/message-service.ts) · [input-state.ts](../../backend/src/application/input-state.ts)
  - [segment-annotation-service.ts](../../backend/src/application/segment-annotation-service.ts) · [scene-image-service.ts](../../backend/src/application/scene-image-service.ts) · [voice-service.ts](../../backend/src/application/voice-service.ts)
  - [model-planner.ts](../../backend/src/scene/model-planner.ts) · [fixed-planner.ts](../../backend/src/scene/fixed-planner.ts) · [comfyui-generator.ts](../../backend/src/scene/comfyui-generator.ts)
  - [conversation-store.ts](../../backend/src/storage/conversation-store.ts) · [scene-image-store.ts](../../backend/src/storage/scene-image-store.ts) · [schema.ts](../../backend/src/storage/schema.ts)
- **桌面前端渲染器**：
  - [Conversation.tsx](../../desktop/desk-preview/renderer/src/pages/Conversation.tsx) · [use-window-session.ts](../../desktop/desk-preview/renderer/src/conversation/use-window-session.ts) · [use-segment-voice.ts](../../desktop/desk-preview/renderer/src/conversation/use-segment-voice.ts)
  - [ChatPane.tsx](../../desktop/desk-preview/renderer/src/conversation/ChatPane.tsx) · [ConversationStage.tsx](../../desktop/desk-preview/renderer/src/conversation/ConversationStage.tsx) · [HistoryPanel.tsx](../../desktop/desk-preview/renderer/src/conversation/HistoryPanel.tsx)
  - [typing-state.js](../../desktop/desk-preview/renderer/src/conversation/typing-state.js) · [advance.js](../../desktop/desk-preview/renderer/src/conversation/advance.js) · [window-model.js](../../desktop/desk-preview/renderer/src/conversation/window-model.js) · [history.js](../../desktop/desk-preview/renderer/src/conversation/history.js) · [performance.js](../../desktop/desk-preview/renderer/src/conversation/performance.js) · [dialogue-theme.ts](../../desktop/desk-preview/renderer/src/conversation/dialogue-theme.ts)

### 5.3 归档与复核文档追溯

- 契约与方案来源：[174 P2-01 契约 §8](../archive/01-backend-prototype/174-p2-01-memory-agent-contract.md#8-对话执行输入状态与中断) · [213 对话演出方案](../archive/03-appearance-and-performance/213-conversation-performance-backend-plan.md) · [223 对话演出开发文档](../archive/03-appearance-and-performance/223-conversation-performance-development-guide.md) · [225 桌面对话开发文档](../archive/03-appearance-and-performance/225-conversation-desktop-development-guide.md) · [248 ComfyUI 适配](../archive/04-role-settings-and-media/248-comfyui-adaptation.md) · [270 §1～§2](../archive/05-model-settings-and-dialogue/270-268-progress-dialogue-model-picker.md) · [280 §2](../archive/06-workflow-simplification/280-278-progress-role-workspace-dialogue-receipt.md#2-消息接收结果与等待原因)
- 实施与自验记录：[215 句段与标注](../archive/03-appearance-and-performance/215-conversation-segments-implementation.md) · [224 CG-01](../archive/03-appearance-and-performance/224-scene-image-cg-01-record.md) · [226 CG-02](../archive/03-appearance-and-performance/226-scene-image-cg-02-record.md) · [229 FE-01](../archive/03-appearance-and-performance/229-conversation-desktop-fe-01-record.md) · [230 FE-02](../archive/03-appearance-and-performance/230-conversation-desktop-fe-02-progress.md) · [237 换光](../archive/02-desktop-ui-and-relations/237-dialogue-theme-transition.md) · [238 布局](../archive/02-desktop-ui-and-relations/238-dialogue-layout-refinement.md) · [239 Dock](../archive/02-desktop-ui-and-relations/239-dialogue-dock-visibility.md)
- 独立复核记录：[216 第一包复核](../archive/03-appearance-and-performance/216-conversation-performance-independent-review.md#6-217-第-7-节补修独立复验) · [227 过场图复核](../archive/03-appearance-and-performance/227-scene-image-independent-review.md#7-228-第-10-节-r06-独立复验) · [231 桌面对话复核](../archive/03-appearance-and-performance/231-conversation-desktop-independent-review.md#4-232-修复独立复验) · [250 ComfyUI 复核](../archive/04-role-settings-and-media/250-comfyui-independent-review.md#251-第-5-节补修独立复验) · [271 §8](../archive/05-model-settings-and-dialogue/271-model-settings-and-dialogue-independent-review.md#8-276-补修独立复验) · [283 复核](../archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md)
