# 309 · 308 启动、连接与对话体验问题（#1～#6）修复实施记录

> 状态：**已完成实施方自验（待独立复核）** · 日期：2026-11-16
> 依据文档：[308 从零启动、连接配置与页面体验评审指南](308-startup-and-connection-flow-audit.md#4-实际发现的问题待修) 与用户确认裁决：
> 1. **设置页外观控制裁决**：去掉「当前穿着」标签及初始进入自动选中第一套服饰的呈现，角色当前穿着完全由角色本人决定；生图参考选择保留并明确标注为仅影响试生图参考。
> 2. **首次进入对话阶段裁决（方案 B）**：当角色已有导入服饰但尚未由角色选中首套服饰（`outfitId === null`）或外观仍在加载时，不闪现夏澄主题人物与「当前未选择服饰」，优先保留背景并展示「即将赶来」过渡提示；仅在确认角色衣柜为空时才使用主题默认人物。
> 3. **范围约束**：本次先实施并验收 `308` 第 4 节问题 **#1～#6**，第 7 项通用引导文案优化后置另议。

## 1. 修复内容清单

1. **#1 创建角色弹窗闭环后不再重复打开**：
   - [App.tsx](../../../desktop/desk-preview/renderer/src/App.tsx) 增加单调 `workspaceRequestSeq` 与 `onWorkspaceRequestHandled` 消费清除回调；
   - [Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx) 的 `SettingsWorkspace` 使用 `handledWorkspaceKey` 记录已处理的请求键并在消费时通知外层清空，避免创建完成刷新角色列表或切回「角色配置」时重复弹出空白创建窗。
2. **#2 连续两轮实时对话消息顺序倒错**：
   - 后端 [conversation-store.ts](../../../backend/src/storage/conversation-store.ts) 在 SSE 事件（`message_segments`、`message_completed`、`message_interrupted`）写入并广播真实数据库序号 `replySequence` 与 `replyCreatedAt`；
   - 前端 [window-model.js](../../../desktop/desk-preview/renderer/src/conversation/window-model.js) 新增 `nextMessageSequence(messages)` 替代 `Number.MAX_SAFE_INTEGER` 兜底；[use-window-session.ts](../../../desktop/desk-preview/renderer/src/conversation/use-window-session.ts) 在 `PendingReply` 上承接 `replySequence` / `replyCreatedAt` 并用于 `finalizePending`，彻底消除首轮 SSE 回复排到第二轮真实用户消息之后的问题。
3. **#3 与外观显示裁决（首次进入对话 & 设置页衣柜）**：
   - [App.tsx](../../../desktop/desk-preview/renderer/src/App.tsx) 以 `appearanceRoleId` 派生同角色刷新不清空快照的 `appearanceLoading`，并在收到会话终态/标注事件时触发 `onRoleStateChanged` 及时同步最新服饰状态；
   - [Conversation.tsx](../../../desktop/desk-preview/renderer/src/pages/Conversation.tsx) 与 [ConversationStage.tsx](../../../desktop/desk-preview/renderer/src/conversation/ConversationStage.tsx) 移除「当前未选择服饰」提示，仅在确认 `outfits.length === 0` 时使用主题占位人物；否则在 `appearanceLoading` 或 `currentOutfit === null` 时展示背景与 `.dialogue-stage-arriving`（「正在整理画面…」 / 「`<角色名>` 正在换装，即将赶来…」）；
   - [Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx)、[AppearancePanel.tsx](../../../desktop/desk-preview/renderer/src/components/appearance/AppearancePanel.tsx) 与 [appearance.css](../../../desktop/desk-preview/renderer/src/styles/appearance.css) 移除 `currentOutfitId`、`当前穿着` 标签与初始 `items[0]` 自动高亮选中，补充 `.nd-outfit-manage-head` 的「收起」按钮与独立 `uploadTarget` 供底栏「补一张差分到已有服饰」直接使用；[ImagePanel.tsx](../../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx) 将「带哪套服饰」改名为「试生图参考服饰」。
4. **#4 逐句推进底部清晰交互与一次展开**：
   - [use-window-session.ts](../../../desktop/desk-preview/renderer/src/conversation/use-window-session.ts) 新增 `advanceAll()`；
   - [ChatPane.tsx](../../../desktop/desk-preview/renderer/src/conversation/ChatPane.tsx) 与 [conversation.css](../../../desktop/desk-preview/renderer/src/styles/conversation.css) 在 `.dialogue-zone` 增加 `.dialogue-advance-bar`：显示剩余句数、操作提示、「继续下一句」与当剩余超过 1 句时的「全部展开」按钮（等待中亦显示明确状态，不再塌陷为空白区）。
5. **#5 草稿测通结果保存继承与 `/models` 失败指引**：
   - 后端 [model.ts](../../../backend/src/domain/model.ts)、[app-store.ts](../../../backend/src/storage/app-store.ts)、[model-service.ts](../../../backend/src/application/model-service.ts)、[schemas.ts](../../../backend/src/http/schemas.ts) 与 [resource-service.ts](../../../backend/src/application/resource-service.ts) 在 `/v1/model-services/test` 返回 `testCallId`，创建或更新模型服务支持传入 `draftTestCallId`；服务端在同一事务内严格核对协议、地址、密钥指纹及可选 `modelName` 完全一致后挂载为资源最近测试结果，不一致时安全忽略；
   - 前端 [use-model-probe.ts](../../../desktop/desk-preview/renderer/src/components/model/use-model-probe.ts)、[Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx) 与 [ModelNamePicker.tsx](../../../desktop/desk-preview/renderer/src/components/model/ModelNamePicker.tsx) 透传 `draftTestCallId`，并在 `/models` 读取失败或返回空列表时明确提示部分兼容接口属正常现象、可手填模型名后直接测试保存。
6. **#6 新创建角色状态立即同步与生图／语音预览可取消**：
   - [Settings.tsx](../../../desktop/desk-preview/renderer/src/pages/Settings.tsx) 在 `createRole()` 成功后立即递增值刷新 `/v1/activities` 并区分 `正在同步状态` 与 `状态未获取`，使新建角色的写入操作即时解锁；
   - [ImagePanel.tsx](../../../desktop/desk-preview/renderer/src/components/image/ImagePanel.tsx) 与 [VoicePanel.tsx](../../../desktop/desk-preview/renderer/src/components/voice/VoicePanel.tsx) 为「测试生图」与「生成试听」接入 `AbortController`、秒数计时提示及实时「取消」按钮，切换标签页、切换角色或离开页面时同步中止在途预览请求。

## 2. 实施方自验结果

1. **后端编译、单元测试与离线验收**：
   - `cd backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit` 通过；
   - `cd backend && npx -y node@24 --import tsx --test --test-concurrency=8 tests/*.test.ts`：**424／424** 通过（新增 [p12-role-settings.test.ts](../../../backend/tests/p12-role-settings.test.ts) 草稿测试创建/更新挂载与错配隔离断言，以及 [p7-performance.test.ts](../../../backend/tests/p7-performance.test.ts) SSE `replySequence`／`replyCreatedAt` 断言）；
   - `cd backend && npx -y node@24 scripts/accept-offline.mjs`：**21／21** 步全部通过，`realServiceCalls=0`（报告 [summary.json](../../../backend/test-results/p5-2026-11-16T03-58-22-917Z-d6aa0d00/summary.json)）。
2. **桌面渲染器门禁与单元测试**：
   - `cd desktop/desk-preview/renderer && npm run check && npm run build` 通过（`tokens:check` 最新、`lint:styles` 22 个 CSS 零违规且豁免命中从 389 降至 388、`tsc --noEmit` 通过、126 模块打包通过）；
   - `cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs`：**136／136** 通过（含 [conversation-window-model.test.cjs](../../../desktop/desk-preview/tests/conversation-window-model.test.cjs) 新增 `nextMessageSequence` 顺序回归）。
3. **Electron 实机 DOM／真实本地后端端到端自验**（均于最终代码改动后运行，全部退出码 0，`errors: []`）：
   - 新增专项检查 [startup-flow-fixes-check.cjs](../../../desktop/desk-preview/tests/startup-flow-fixes-check.cjs)：验证 #1 创建弹窗不重开、#2 两轮实时消息正序、#3「即将赶来」不闪现主题图/「未选择服饰」、#4 底部推进条与「全部展开」、#5 `/models` 404 指引与新建草稿测试继承、#6 新建角色即时状态同步与慢速语音试听主动取消；
   - 回归更新并重跑 [settings-workspace-check.cjs](../../../desktop/desk-preview/tests/settings-workspace-check.cjs)、[settings-review-fixes-check.cjs](../../../desktop/desk-preview/tests/settings-review-fixes-check.cjs)、[settings-real-backend-check.cjs](../../../desktop/desk-preview/tests/settings-real-backend-check.cjs)、[workflow-real-backend-chain-check.cjs](../../../desktop/desk-preview/tests/workflow-real-backend-chain-check.cjs)、[dialogue-layout-check.cjs](../../../desktop/desk-preview/tests/dialogue-layout-check.cjs)、[settings-auto-reload-check.cjs](../../../desktop/desk-preview/tests/settings-auto-reload-check.cjs) 与 [settings-binding-recovery-check.cjs](../../../desktop/desk-preview/tests/settings-binding-recovery-check.cjs)。
4. **未覆盖与待办**：以上自动化均运行于离线本地桩模型／假 TTS 端点，真实外部接口联调与本包改动（309）之**独立复核**仍待推进；`308` 第 4 节第 7 项整体文案引导优化按确认范围后置另议。
