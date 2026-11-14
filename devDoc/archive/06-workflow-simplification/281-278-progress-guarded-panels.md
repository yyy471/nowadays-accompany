# 278 进展二：外观、语音与生图写入接入暂停保存

> **现行规范入口**：本文三个配置面板接入 `guardWrite` 写前暂停守卫的现行规则已整合并入 [角色配置、全局资源与活动守卫规范](../../specs/role-config-and-activity.md)；下文保留第二包实施与自验记录。

2026-11-12。本轮把 [280](280-278-progress-role-workspace-dialogue-receipt.md) 的「暂停并保存」扩展到角色配置内的外观、声音与生图面板，继续实施 [278 第 1 节](278-project-workflow-simplification-fix-plan.md#1-角色配置在原页面完成)。模型依赖维护、资源详情与首次对话入口见 [282](282-278-progress-model-impact-resource-detail.md)。

## 1. 三个面板共用同一条守卫

- 角色编辑器向 `AppearancePanel`、`VoicePanel`、`ImagePanel` 注入 `guardWrite`：写入前先暂停角色并等待后端确认 `stopped`，失败时拒绝本次写入并显示原因。
- 面板不再要求用户先手动停止：传入 `pausedWrite` 用于按钮文案（如「暂停并导入」「暂停并保存配置」「暂停并保存声音配置」），`canWrite` 只要求角色状态已读取。
- 停止请求与确认失败、写入失败都会回到面板原有的错误区，草稿与预览保留；完成后原处仍提供「继续活动」。

## 2. 覆盖的写入

独立复核确认参考录音上传和删除尚未接入暂停流程，批量导入部分失败后也无法在预览中直接重试。见 [283 的 R08、R09](283-278-workflow-simplification-independent-review.md#1-待修问题)。

| 面板 | 纳入守卫的写入 |
| --- | --- |
| 外观 | 批量导入（逐套上传）、单张差分上传、改名、主页立绘补传/替换、删除服饰、删除差分 |
| 语音 | 保存声音配置、启用／停用开关。参考音频上传和删除待接入 |
| 生图 | 保存角色生图配置 |

- 读取、探测、试听与样图仍按原逻辑执行，不触发暂停。
- 批量导入按套结算。失败项保留预览及单独重试待修。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 渲染端类型检查 | `desktop/desk-preview/renderer && npm run typecheck` | 通过 |
| 渲染端构建 | `npm run build` | 通过（`dist` 已重建） |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 109／109 |
| 后端 | 本轮未改后端；沿用 [280](280-278-progress-role-workspace-dialogue-receipt.md) 的 358 项与 21 步离线验收 | 不变 |
| Electron 联调 | 导入、立绘替换、差分删除、语音保存与启停、生图保存的暂停→保存→继续活动需实机核对 | 待联调 |

## 4. 变更清单

| 文件 | 变更 |
| --- | --- |
| `desktop/.../components/appearance/AppearancePanel.tsx` | `guardWrite`／`pausedWrite`；导入、上传与删除接入守卫与按钮文案 |
| `desktop/.../components/voice/VoicePanel.tsx` | 保存、启停、参考音频上传/删除接入守卫；保存按钮文案 |
| `desktop/.../components/image/ImagePanel.tsx` | 保存配置接入守卫与按钮文案 |
| `desktop/.../pages/Settings.tsx` | `guardAction` 注入三个面板；`canWrite` 只要求状态已读取 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/280`、项目工作记忆 |

## 5. 交接边界

- 本轮为实施方自验；Electron 实机与第 6 节视觉对照仍待执行。
- 角色删除对话框、直接创建角色入口、「开始对话」按钮与首次配置引导尚未交付（278 第 1、4 节剩余部分）。
- 278 第 2、3、5 节（按模型依赖的保护范围、MCP／Skill 详情、草稿生图与临时录音、绑定自动合并）仍待后续包。
- 探测、试听、样图与读取不属于受保护写入，不会因本次守卫触发暂停。
