# 268 进展二：对话演出、模型草稿探测与统一选择

2026-11-11。本轮处理 [268](268-model-settings-and-dialogue-fix-plan.md) 第 1、2、3、5 节与第 6 节的核对部分。第 4 节与外观预览修复见 [269](269-268-progress-first-launch-import-preview.md)。实施与独立复核分别留证。[271 独立复核](271-model-settings-and-dialogue-independent-review.md) 发现五项缺口，已按 [272](272-271-review-fixes.md) 修复。

## 1. 对话差分与舞台（268 §1）

- 舞台不再要求句段带 `outfitId`：已有 `spriteAssetId` 的句段直接使用差分；同一轮同服饰的无标注句段继续沿用前一个有效表情（`spriteForRow` 规则不变）。
- 差分图片解码失败时回退到句段的主页立绘快照，再回退当前服饰立绘与主题图；不会停留在旧表情或空白。
- 历史与实时共用同一回退链：句段 `homeAssetId` → 当前服饰 `home` → 主题角色图；纯背景过场只替换背景，整幅过场收起后恢复当前句段的角色图。
- 对话输入区增加衣柜提示：衣柜非空但当前未选择服饰显示「当前未选择服饰」，当前服饰没有差分显示「这套服饰没有对话表情，可先补一张差分」。
- 标注写回、窗口快照与 SSE 合并沿用既有逻辑：已显示句段收到晚到标注后按稳定行 ID 更新；快照与历史分页保留已收到的标注。

## 2. 对话等待与点击推进（268 §5）

- 移除消息下方的等待／「下一句」整条控制栏。等待状态改为消息区内提示：「正在组织回复…」或「等对方开口…」；完整动效显示点状动画，减少动效时只显示静态文字。
- 消息区可点击推进：正文、动作文字与空白都可以推进下一段；按钮、链接、输入框、可拖动控件与已选中的文字保留原操作。焦点在消息区时 Enter／空格推进，并提供 `aria-keyshortcuts` 与可访问说明。
- 发送后焦点交给消息区，键盘可直接继续；末句出现后恢复输入框。会话状态机、首句自动出现、单句自动结束等行为保持不变。
- 新增 `renderer/src/conversation/advance.js`（纯判定）与桌面用例；历史复核脚本 `tests/conversation-review-regression.py` 的推进选择器改为 `.dialogue-messages[data-can-advance="true"]`。

## 3. 模型草稿探测与统一选择（268 §2、§3）

**后端。**

- 草稿探测 `POST /v1/model-services/models|test` 接受可选 `resourceId`：以已保存资源为基准解析密钥，仅当协议与 origin 一致时复用；换站点、协议或端口返回 400 `RESOURCE_CREDENTIAL_STALE`。填了新密钥时按新密钥探测。草稿测试仍不落库。
- `p12` 增加草稿复用已保存密钥、跨 origin 拒绝的用例。

**桌面。**

- 新增 `useModelProbe` 与 `ModelNamePicker`：统一的「选择或输入模型名称」控件，候选来自服务列表并可筛选，手填始终可用；读取列表与测试连接由按钮主动触发，显示加载、空列表、失败与重试；请求带配置键和代际，表单变化或切换后迟到结果只归属原请求。
- 设置页新建与编辑共用该控件：新建表单填写协议、地址与密钥后即可列表和测试，保存独立执行；编辑表单解除「未保存不能探测」的限制，未保存的修改走草稿探测，保留已保存密钥时由后端按资源解析并核对协议与 origin。
- 角色页对话／记忆模型改为「先选已保存供应商，再选或输入模型」；切换供应商清空该项模型与候选；未选择对话模型显示「未选择」，记忆为空显示「跟随对话模型」；删除角色页「＋ 新建模型服务」入口与创建后预填草稿的逻辑，统一从设置进入。

## 4. 同类入口核查（268 §6）

| 入口 | 结论 |
| --- | --- |
| 角色语音 | 已有草稿地址与协议探测、试听与参考音频管理，保持现状；本轮未改。 |
| 设置页生图服务与角色生图 | 目前只按已保存服务探测，测试生图未携带草稿服务、工作流与服饰参数；需要新增草稿探测与测试生图契约，**本轮未实施**。 |
| MCP／Skill | 后端没有探测协议与探测接口，未伪造列表或测试入口；保持创建、编辑、占用与删除。 |
| 探测归属与活动保护 | 模型探测结果按配置键隔离；保存与真实对话仍各自走正式配置与活动守卫。语音、生图的旧结果隔离沿用既有实现。 |

## 5. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--test-concurrency=8 tests/*.test.ts` | 355／355 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0`、`sourceUnchanged=true` |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 105／105（新增推进判定与模型候选/文案用例） |
| 渲染端类型检查与构建 | `desktop/desk-preview/renderer && npm run typecheck && npm run build` | 通过 |
| Electron 设置联调脚本 | `tests/settings-workspace-check.cjs` | 本工作区缺少 `pngjs` 依赖未能执行；脚本已按新控件更新，需在桌面联调环境跑通 |

验收报告：`backend/test-results/p5-2026-11-11T16-58-03-660Z-76b6e991/summary.json`。

## 6. 变更清单

| 文件 | 变更 |
| --- | --- |
| `backend/src/domain/model.ts` | 草稿探测 schema 增加可选 `resourceId` |
| `backend/src/application/model-service.ts` | 复用已保存密钥的草稿探测与协议／origin 核对 |
| `backend/tests/p12-role-settings.test.ts` | 草稿复用已保存密钥、跨 origin 拒绝用例 |
| `desktop/.../conversation/ConversationStage.tsx` | 差分不再依赖 outfitId；解码失败回退立绘快照 |
| `desktop/.../conversation/ChatPane.tsx` | 移除底部控制栏；消息区等待提示、点击／键盘推进与衣柜提示 |
| `desktop/.../conversation/advance.js`、`advance.d.ts`、`styles/conversation.css` | 推进判定与等待／提示样式 |
| `desktop/.../pages/Conversation.tsx` | 传递衣柜提示 |
| `desktop/.../components/model/{model-picker.js,use-model-probe.ts,ModelNamePicker.tsx}` | 模型候选、探测与统一选择控件 |
| `desktop/.../pages/Settings.tsx` | 新建／编辑模型草稿探测；角色页统一选择；移除新建与预填 |
| `desktop/.../styles/settings-workspace.css` | 模型候选下拉样式 |
| `desktop/desk-preview/tests/{conversation-advance,model-picker}.test.cjs`、`conversation-review-regression.py`、`settings-workspace-check.cjs` | 新增纯逻辑用例；更新推进选择器与新控件流程 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/268`、项目工作记忆 |

## 7. 交接边界

- 本轮为实施方自验；268 的整体验收仍待 Electron／真实服务联调与独立复核。
- 268 §6 中生图草稿探测与测试生图参数、MCP／Skill 探测仍未实施；不提供伪造入口。
- 角色页模型选择与设置页探测共享候选与手填规则，但保存绑定仍按角色 `revision` 校验，探测不写入对话与正式配置。
