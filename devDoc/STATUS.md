# 项目当前状态与基线（2026-11-16）

本文件集中维护当前开发状态、待办事项与最新验收基线，替代过去堆在 `AGENTS.md` 顶部的历史流水账。历史过程细节请直接查看 `archive/` 下各专项复核与实施记录。

## 1. 当前结论概览

| 模块 / 专项 | 当前状态（离线范围） | 核心证据 | 未决 / 下一阶段 |
| --- | --- | --- | --- |
| 首轮后端原型（P0～P5） | 已收口并合入 `master` | [195 P5 复核](archive/01-backend-prototype/195-p5-independent-review.md) · [198 缺口复验](archive/01-backend-prototype/198-p5-capability-gaps-independent-review.md#r01-第三次补修的独立复验) | 远程 Streamable HTTP MCP 按 DL-115 排在桌面前端完成后 |
| 角色外观与每日穿搭 | 首轮实施与离线复验通过（R01～R03 关闭） | [210](archive/03-appearance-and-performance/210-appearance-implementation-record.md) · [211](archive/03-appearance-and-performance/211-appearance-independent-review.md#r01-全帧校验补修独立复验) | 与真实服务、后续生图锚点联动 |
| 对话演出与过场图（CG-01／02） | 第一包与 CG-01／02 通过离线复验 | [216](archive/03-appearance-and-performance/216-conversation-performance-independent-review.md#6-217-第-7-节补修独立复验) · [227](archive/03-appearance-and-performance/227-scene-image-independent-review.md#7-228-第-10-节-r06-独立复验) | 按 [223](archive/03-appearance-and-performance/223-conversation-performance-development-guide.md) 推进 CG-03 自动触发与恢复、CG-04 独立复核与真实适配 |
| TTS 语音接入与启停 | 统一接入、IndexTTS 桥接及角色启停通过既往离线复验；双引擎（`CosyVoice3`／`IndexTTS-2.5`）、对话优先情绪指令（`V19`）与「设置 -> 模型 -> 语音」全局语音服务（`APP V9` / `V20`，`DL-152`）完成自验与本地 Electron E2E（待独立复核） | [222](archive/03-appearance-and-performance/222-tts-unified-independent-review.md#221-第-11-节-v12-回填独立复验) · [247](archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md#4-249-补修独立复验) · [TTS 与生图规范](specs/tts-and-image-services.md) | 新增全局语音服务目录、双引擎选择、配置试听 `emotion` 与对话 `voiceEmotion` 适配待独立复核及 Electron UI 实机播放联调 |
| ComfyUI 生图适配 | 文生图（MOSS-Image）接入完成，CG-R01～R05 关闭 | [248](archive/04-role-settings-and-media/248-comfyui-adaptation.md) · [250](archive/04-role-settings-and-media/250-comfyui-independent-review.md#251-第-5-节补修独立复验) | 真实生图联调；图生图与锚点图上传待实施 |
| 桌面关系藏页 & 对话页 | 关系藏页（EX-R01～R05）、桌面对话（FE-R01～R04）离线复验关闭；240 经用户确认；237～239 完成自验 | [231](archive/03-appearance-and-performance/231-conversation-desktop-independent-review.md#4-232-修复独立复验) · [234](archive/02-desktop-ui-and-relations/234-relations-exlibris-independent-review.md#4-235-第-7-节补修独立复验) · [237](archive/02-desktop-ui-and-relations/237-dialogue-theme-transition.md) · [240](archive/02-desktop-ui-and-relations/240-relations-header-removal.md) | 237～239 独立复核；真实服务语音播放与联调 |
| 角色配置与设置（252／253） | 后端三包（RS-01、活动守卫、资源管理、外观删除历史）与前端第三包均通过离线复验 | [244](archive/04-role-settings-and-media/244-role-settings-independent-review.md#7-245-第-12-节补修独立复验) · [255](archive/04-role-settings-and-media/255-role-activity-independent-review.md#259-修复独立复验) · [258](archive/04-role-settings-and-media/258-resource-management-independent-review.md#259-第-8-节补修独立复验) · [263](archive/04-role-settings-and-media/263-role-appearance-deletion-independent-review.md#264-第-7-节补修独立复验) · [266](archive/04-role-settings-and-media/266-role-settings-frontend-independent-review.md#267-补修-cf-r05-独立复验) | 真实模型、语音、生图服务联调 |
| 模型配置与对话修复（268） | MR-01～MR-05 离线复验关闭；292-R05～R07 独立复验通过，含跨页失效与在途编辑 | [271](archive/05-model-settings-and-dialogue/271-model-settings-and-dialogue-independent-review.md) · [283 §29](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) | 真实 ComfyUI 联调 |
| 操作链路简化与首次体验修复（278 / 308） | 同页暂停保存、模型维护、删除与记忆整理通过既有离线复验；292-R09、settings-review-fixes-check 与 **308 §4 问题 #1～#6 及两项外观裁决**（[309](archive/06-workflow-simplification/309-308-startup-flow-fixes.md)）已完成实施自验与 Electron E2E（待独立复核） | [278](archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md) · [283 §29](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) · [308](archive/06-workflow-simplification/308-startup-and-connection-flow-audit.md) · [309](archive/06-workflow-simplification/309-308-startup-flow-fixes.md) | 292-R09 与 [309](archive/06-workflow-simplification/309-308-startup-flow-fixes.md) 待独立复核；308 §4 第 7 项通用引导文案优化与真实外部服务联调后置 |
| 桌面前端设计系统与样式门禁 | 全站样式改用 `--nd-*` 令牌，`lint:styles` / `tokens:check` 与 `design-tokens.test.cjs`（Windows 路径已修）均通过 | [前端设计规范](specs/frontend-design-system.md) · [check-design-tokens.mjs](../desktop/scripts/check-design-tokens.mjs) | 历史样式豁免收敛（旧调板颜色、页面艺术色、纸感阴影、TS 耦合时长等，见规范第 12 节） |
| 预置默认助手夏澄（包 1） | R01（取消单事务回滚）、R02（`BUSINESS V22` `outfits.preset_key`）、R03（Chat/Responses/Anthropic 无效工具参数前吐出 `usage`）补修后经**独立复验通过**；`p2-extended` R07 阈值抖动改轮询后**独立复核通过**（6／6 稳定、负向对照仍判失败、两次全量 21／21） | [310 §8／8.1／8.2／8.4](archive/06-workflow-simplification/310-default-assistant-development-guide.md#8-包-1-独立复核) · [p19-preset-assistant-pack1.test.ts](../backend/tests/p19-preset-assistant-pack1.test.ts) | 已完成，后续缺口归包 2／3 |
| 预置默认助手夏澄（包 2：续行、澄清与管理工具） | 单段 15 轮自动切段与 `task_continue` 续行、同工具 3 次失败与连续 3 段无进展熔断、`task_pause` 图内停派、同窗回复接回原 `taskId`、方案 A 内部管理工具（19 项）与自改红线**实施自验通过** | [310 §9](archive/06-workflow-simplification/310-default-assistant-development-guide.md#9-包-2-实施记录2026-11-17自验通过待独立复核) · [p20-preset-assistant-pack2.test.ts](../backend/tests/p20-preset-assistant-pack2.test.ts) · [admin-tools.ts](../backend/src/application/admin-tools.ts) | 待独立复核；真实第三方 MCP 与真实模型 15 轮切段联调后置 |

## 2. 当前待推进事项（Backlog）

1. **测试与历史回归**：[283 §29](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) 的 292-R09 有界超时清理补修（含故障注入与零残留验证）及 [settings-review-fixes-check.cjs](../desktop/desk-preview/tests/settings-review-fixes-check.cjs) 冲突自动合并／同用途冲突覆盖更新（同步修复 [Settings.tsx](../desktop/desk-preview/renderer/src/pages/Settings.tsx#L531) `409` 自动合并后未调用 `mergeRefreshedBindings` 同步跨页草稿的问题）已在 [292 §10](archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#10-283-29292-r09doc-r01-邻接契约与-settings-review-fixes-checkcjs-收口自验) 完成自验，待独立复核。[278 §4](archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md#4-第一次配置与对话恢复) 首次配置与对话恢复、[237～239](archive/02-desktop-ui-and-relations/237-dialogue-theme-transition.md) 明暗切换与布局独立复核仍待推进。
2. **生图后续能力**：ComfyUI 图生图与服饰锚点图上传；过场图 `CG-03` 自动触发与 `CG-04` 独立复核及真实生图适配。
3. **真实服务联调与打包**：真实模型（当前真实证据仅限 DeepSeek Anthropic Messages）、真实语音服务（已完成后端与本机 WSL `nowadays-tts-v1` 双引擎脚本级 E2E 联调，Electron 界面实机播报试听及长多语种文本待测）、真实 ComfyUI、桌面对话语音播放与 SSE 即时刷新、Windows 桌面打包交付。
4. **预置默认助手夏澄**：按 [310 开发文档](archive/06-workflow-simplification/310-default-assistant-development-guide.md) 分包推进。包 1 已[独立复验通过](archive/06-workflow-simplification/310-default-assistant-development-guide.md#82-包-1-补修独立复验2026-11-17r01r03-通过)；包 2（续行、澄清、管理工具与 MCP 样例）已完成[实施自验](archive/06-workflow-simplification/310-default-assistant-development-guide.md#9-包-2-实施记录2026-11-17自验通过待独立复核)，**待独立复核**；包 3（冷启动选角页、去「陪伴」、无图空态、对话内取消入口与打包素材路径）待推进。
5. **远程扩展与后续能力**：桌面前端完成后恢复远程 Streamable HTTP MCP（`DL-115`），后续按 `DL-148` 补充角色本体修订。
6. **文档规范维护**：DOC-R01 原场景与 DOC-R02～R04 勘误通过独立复验；[文档优化方案 §7.1](archive/07-documentation/documentation-optimization-plan.md#71-现行规范勘误独立复验) 指出的 `POST .../input-state` 双 `400` 区分（`INVALID_REQUEST` 与 `INPUT_STATE_INVALID`）已同步更新至 [对话演出与过场图规范 §2.1](specs/conversation-performance-and-scene-images.md#21-对话输入状态sse-与语音消费接口) 并在 [p2-05-api-cli.test.ts](../backend/tests/p2-05-api-cli.test.ts) 补齐 HTTP 双错误码断言（[292 §10](archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#10-283-29292-r09doc-r01-邻接契约与-settings-review-fixes-checkcjs-收口自验) 自验通过，待独立复核）。

## 3. 验收基线与命令

- **后端正式测试与离线验收**：
  - `cd backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit`（通过）；
  - `cd backend && npx -y node@24 --import tsx --test tests/*.test.ts`（**442／442** 通过，0 失败，0 跳过；新增 [p20-preset-assistant-pack2.test.ts](../backend/tests/p20-preset-assistant-pack2.test.ts) 6 项包 2 用例）；
  - `cd backend && npx -y node@24 scripts/accept-offline.mjs`（**21／21 步**，`realServiceCalls=0`、`sourceUnchanged=true`、正式测试 442／442；包 2 自验报告 `backend/test-results/p5-2026-11-17T11-53-01-430Z-c8fd96f7/summary.json`）。
- **桌面端离线验证**：
  - `cd desktop/desk-preview/renderer && npm run check`（`tokens:check` 最新 + `lint:styles` 22 个 CSS 零违规／豁免 388 + `tsc --noEmit` 通过）及 `npm run build`（126 模块）；
  - `cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs`（**136／136** 通过，0 失败，0 跳过；含 [conversation-window-model.test.cjs](../desktop/desk-preview/tests/conversation-window-model.test.cjs) `nextMessageSequence` 回归）；
  - Electron E2E（本轮 `309` 改动后重跑）：[startup-flow-fixes-check.cjs](../desktop/desk-preview/tests/startup-flow-fixes-check.cjs)、`settings-workspace-check.cjs`、`settings-review-fixes-check.cjs`、`settings-real-backend-check.cjs`、`workflow-real-backend-chain-check.cjs`、`dialogue-layout-check.cjs`、`settings-auto-reload-check.cjs` 与 `settings-binding-recovery-check.cjs` 均退出 0（本地假后端／假模型／假 TTS 端点范围；详见 [309](archive/06-workflow-simplification/309-308-startup-flow-fixes.md)）。
- **文档巡检**：仓库根目录执行 `node scripts/check-docs.mjs`。

## 4. 分支与历史归档目录

- **分支约定**：
  - `master`：数字生命主线设计、后端原型与主开发基线（已合并历史 `codex/p1-role-storage`）。
  - `dev-front`：当前桌面端重构与前后端联合推进工作分支。
  - `dev`：旧版项目代码与设计历史只读归档。
  - `codex/p0-runtime-spike`：`prototypes/p0/` 技术小样分支。
- **历史阶段归档目录（`devDoc/archive/`）**（完整索引见 [文档总导航](README.md)）：
  - `archive/01-backend-prototype/`（`162`–`199`）：首轮方案、P0～P5 开发与独立复核（P0 见 [167](archive/01-backend-prototype/167-p0-independent-review.md)、P1 见 [172](archive/01-backend-prototype/172-p1-independent-review.md)、P2 见 [184](archive/01-backend-prototype/184-p2-06-acceptance-report.md)、P3 见 [188](archive/01-backend-prototype/188-p3-independent-review.md)、P4 见 [190](archive/01-backend-prototype/190-p4-recovery-acceptance-report.md)）
  - `archive/02-desktop-ui-and-relations/`（`200`–`207`、`214`、`233`–`235`、`237`–`240`）：早期书桌方案、四页重构、关系藏页与布局换光调整
  - `archive/03-appearance-and-performance/`（`208`–`213`、`215`–`232`）：角色外观穿搭、对话演出、TTS／IndexTTS、过场图与桌面对话接入
  - `archive/04-role-settings-and-media/`（`236`、`241`–`267`）：角色配置、全局设置、活动守卫、资源占用删除、ComfyUI 与语音启停
  - `archive/05-model-settings-and-dialogue/`（`268`–`276`）：模型草稿探测、首次启动停止态与对话差分／选择器修复
  - `archive/06-workflow-simplification/`（`277`–`309`）：操作链路简化方案、283～306 复核补修全链与 308/309 首次体验修复
