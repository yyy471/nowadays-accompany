# 278 进展一：角色同页暂停保存与对话接收结果

2026-11-12。本轮开始实施 [278 操作链路简化](278-project-workflow-simplification-fix-plan.md)。第一包覆盖第 1 节的人设、绑定与额度写入，以及第 4 节的消息接收结果、等待原因与恢复入口。外观／语音／生图写入、附件工作包与视觉对照仍待后续。外观／语音／生图写入接入同一暂停路径见 [281](281-278-progress-guarded-panels.md)。

## 1. 角色配置在原页面暂停并保存

- 人设、模型／扩展绑定、自主额度的保存不再要求用户先去设置页手动停止：保存时先在校验通过后调用停止接口，轮询后端活动状态，确认 `stopped` 后才提交本次写入。
- 按钮按当前状态显示「保存…」或「暂停并保存」；等待期间显示「正在暂停角色…」，停止确认失败、保存失败或状态未取到时在原操作区显示原因，草稿保留。
- 本次操作发起的暂停在完成后显示「继续活动」入口；操作前已经停止的角色不提供该入口，保持停止。
- 既有后端规则不变：停止仍以可保存节点确认为准，写入继续经过活动租约与提交前重验。
- 外观、声音、生图的写入仍沿用「角色须已停止」的既有入口，尚未接入同一条暂停路径；角色删除的对话框与导入按钮文案也待后续包处理。

## 2. 消息接收结果与等待原因

**后端。**

- 消息路由先按提交标识找回已接收消息，再决定是否要求角色活动：同一标识与内容的已接收消息，即使角色随后停止也能查回原结果；同标识改内容返回冲突；角色停止仍拒绝未接收的新消息。
- `POST .../messages` 的结果新增 `decisionScheduled` 与可读的 `waitReason`：`ROLE_STOPPED`、`MODEL_MISSING`、`BUSY`、`WINDOW_BLOCKED`、`QUEUE_PENDING`。等待原因由角色活动、当前执行、窗口阻塞与对话模型解析共同判断，不再依赖单一布尔值。
- 重复提交且角色与模型恢复可用时，会按原消息标识重新尝试调度；角色仍停止或缺少模型时不启动新步骤。
- 新增只读查询 `findSubmittedMessage`，供路由在活动校验前确认是否已入库。

**桌面。**

- 发送结果中的 `ROLE_STOPPED`／`MODEL_MISSING`／`WINDOW_BLOCKED` 会释放输入区的等待状态，保留用户消息并显示等待原因；`BUSY`／`QUEUE_PENDING` 仍按正常排队显示。
- 等待提示提供「恢复活动」「配置对话模型」与「重试」：恢复走活动接口后按原提交标识重试；配置跳到角色配置的模型分区并定位到发起角色；重试复用原提交标识，避免重复入库。
- 消息、窗口与角色切换时清理等待状态；草稿与逐句演出逻辑不变。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p17-message-receipt.test.ts` | 3／3 |
| 后端全量测试 | `--test-concurrency=8 tests/*.test.ts` | 358／358 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0`、`sourceUnchanged=true` |
| 渲染端类型检查与构建 | `desktop/desk-preview/renderer && npm run typecheck && npm run build` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 109／109 |
| Electron 联调 | 暂停并保存、等待原因与「配置对话模型」返回来源角色需在桌面环境实机核对 | 待联调 |

验收报告：`backend/test-results/p5-2026-11-12T04-38-37-057Z-98f5cfb2/summary.json`。

## 4. 变更清单

| 文件 | 变更 |
| --- | --- |
| `backend/src/storage/role-store.ts` | 新增 `findMessageBySubmission()` |
| `backend/src/domain/conversation.ts` | 新增 `ConversationWaitReason` |
| `backend/src/application/conversation-service.ts` | 重复提交重新调度、等待原因判断、只读找回已接收消息 |
| `backend/src/http/routes.ts` | 消息路由先去重再校验活动；返回 `decisionScheduled` 与 `waitReason` |
| `backend/tests/p17-message-receipt.test.ts` | 缺少模型、停止后找回、正常调度三项用例 |
| `desktop/.../pages/Settings.tsx` | 人设／绑定／额度「暂停并保存」与「继续活动」；来源角色与模型分区定位 |
| `desktop/.../conversation/api-types.ts`、`use-window-session.ts` | 接收结果与等待状态；原提交标识重试 |
| `desktop/.../conversation/ChatPane.tsx`、`pages/Conversation.tsx`、`App.tsx`、`styles/conversation.css` | 等待提示、恢复／配置／重试入口与导航 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/278`、项目工作记忆 |

## 5. 交接边界

- 本轮为实施方自验；278 第 1 节的外观／语音／生图写入与批量导入按钮文案、第 2、3、5 节的大部分工作包尚未实施。
- 「暂停并保存」当前覆盖设置页内由角色编辑器直接发起的写入；外观导入、单张上传、语音与生图面板仍要求角色已停止，需在后续包接入同一守卫。
- 等待原因中的 `BUSY`／`QUEUE_PENDING` 仍按正常排队展示；SSE 重连与切换窗口读回等待状态的实机验收待联调。
- 直接创建角色入口、「开始对话」按钮与首次配置引导尚未交付。
