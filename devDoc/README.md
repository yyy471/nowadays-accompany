# 新主线文档导航

> **阅读原则**：**产品需求**看 [`161`](161-digital-life-direction-decisions.md)，**当前状态与待办**看 [`STATUS.md`](STATUS.md)，**现行规范与契约**看 [`specs/`](specs/README.md)，**过程与复核记录**按专项归入 [`archive/`](#归档专项索引devdocarchive)。
> **维护约定**：同专项的后续多轮复核与补修在同一文档内按小节追加，不再每轮新建编号文件；长期规范并入 `specs/`，历史记录登记至 `archive/`，改动后运行 `node scripts/check-docs.mjs`。

## 按场景直达入口

| 入口分类 | 关心的问题 | 先看哪里 | 说明 |
| --- | --- | --- | --- |
| **项目** | 做什么、边界是什么、现在做到哪、下一步做什么 | [161 持续决策记录](161-digital-life-direction-decisions.md) · [当前状态看板](STATUS.md) | `161` 是已确认需求（`DL-01`～`DL-151`）唯一权威来源；`STATUS.md` 维护当前总表、待办与通过基线 |
| **开发** | 环境怎么起、接口/状态/报错怎么写、设计规范是什么 | [现行规范总览](specs/README.md) · [前端设计规范](specs/frontend-design-system.md) · [后端使用说明](../backend/README.md) · [美术资产生成指南](../desktop/desk-preview/ART-GENERATION-GUIDE.md) | 汇总 `specs/` 活规范、[`tokens.json`](design/character-studio/tokens.json) 与当前仍生效的契约章节；桌面端开发必读前端设计规范 |
| **修复与验收** | 怎么复现、影响什么、改了什么、独立复验到了哪 | [当前待推进事项（Backlog）](STATUS.md#2-当前待推进事项backlog) · [验收基线与命令](STATUS.md#3-验收基线与命令) · [常用专项](#常用专项) | 复现、实施、自验与独立复验按专项追加在同一组文档内；查更早记录请展开下方[归档专项索引](#归档专项索引devdocarchive) |

## 目录结构

```text
devDoc/
  README.md                               # 本文件：三类入口导航、常用专项与归档索引
  STATUS.md                               # 当前状态看板、待办事项（Backlog）与验收基线
  161-digital-life-direction-decisions.md # 产品方向与持续决策记录（DL-01 ~ DL-151）
  specs/                                  # 现行长期开发规范与契约入口
  design/                                 # 设计令牌源文件（tokens.json）与原始参考底稿
  archive/                                # 历史阶段与专项记录（01～06 业务专项，07 文档治理）
```

> **设计资产与参考底稿**：[`design/character-studio/tokens.json`](design/character-studio/tokens.json) 是桌面 `--nd-*` 令牌唯一源文件（由 `desktop/scripts/generate-character-theme.mjs` 生成 CSS，勿移动路径）；[用户参考底稿](design/digital-life/langgraph-roleplay-engine-v2.reference.md) 为历史参考材料，原样归档，未整体采纳。

## 常用专项

> 下表把当前最常用的模块按「现行契约入口」「主要实施记录」「独立复核结论」拆开对照，避免把早期草案、实现自验和最新复核混在一起。

| 专项 | 当前开发 / 现行契约入口 | 主要实施记录 | 独立复核结论 |
| --- | --- | --- | --- |
| 角色配置、全局设置与活动守卫 | [角色配置、全局资源与活动守卫规范](specs/role-config-and-activity.md) | [252 方案总纲](archive/04-role-settings-and-media/252-role-config-settings-development-plan.md) · [278 §1～§3](archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md#1-角色配置在原页面完成) · [292 §6～§9](archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) | [266 设置复核](archive/04-role-settings-and-media/266-role-settings-frontend-independent-review.md#267-补修-cf-r05-独立复验) · [283 §27～§28](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)（实时状态见 [STATUS.md](STATUS.md)） |
| 对话演出与过场图 | [对话演出、输入状态、SSE 与过场图规范](specs/conversation-performance-and-scene-images.md) · [生图接入规范](specs/tts-and-image-services.md) | [215 句段](archive/03-appearance-and-performance/215-conversation-segments-implementation.md) · [226 CG-02](archive/03-appearance-and-performance/226-scene-image-cg-02-record.md) · [230 桌面联调](archive/03-appearance-and-performance/230-conversation-desktop-fe-02-progress.md) · [237～239](archive/02-desktop-ui-and-relations/237-dialogue-theme-transition.md) | [227 过场图](archive/03-appearance-and-performance/227-scene-image-independent-review.md#7-228-第-10-节-r06-独立复验) · [250 ComfyUI](archive/04-role-settings-and-media/250-comfyui-independent-review.md#251-第-5-节补修独立复验) · [283 §27～§28](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)（实时状态见 [STATUS.md](STATUS.md)） |
| TTS 与生图服务接入 | [TTS 与生图服务接入规范](specs/tts-and-image-services.md) | [221 统一语音](archive/03-appearance-and-performance/221-tts-unified-implementation.md) · [243](archive/04-role-settings-and-media/243-voice-settings-desktop.md) · [246](archive/04-role-settings-and-media/246-role-voice-toggle.md) · [248 ComfyUI](archive/04-role-settings-and-media/248-comfyui-adaptation.md) · [292 §6～§9](archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) | [222](archive/03-appearance-and-performance/222-tts-unified-independent-review.md#221-第-11-节-v12-回填独立复验) · [247](archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md#4-249-补修独立复验) · [250](archive/04-role-settings-and-media/250-comfyui-independent-review.md#251-第-5-节补修独立复验) · [283 §27～§28](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)（实时状态见 [STATUS.md](STATUS.md)） |
| 角色存储、记忆与自主执行 | [存储、记忆与自主执行规范](specs/storage-memory-and-autonomy.md) · [后端 README](../backend/README.md) | [180 回复链](archive/01-backend-prototype/180-p2-05-agent-conversation-record.md) · [187 自主活动](archive/01-backend-prototype/187-p3-autonomy-implementation-record.md) · [197 能力补齐](archive/01-backend-prototype/197-p5-capability-gaps-implementation-record.md) · [278 §4 首次配置](archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md#4-第一次配置与对话恢复) | [195 P5](archive/01-backend-prototype/195-p5-independent-review.md#5-收口及未验证范围) · [198 GAP](archive/01-backend-prototype/198-p5-capability-gaps-independent-review.md#r01-第三次补修的独立复验) · [283 §26](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#26-306-补修独立复验) |
| 桌面设计系统与外观素材 | [前端设计规范](specs/frontend-design-system.md) · [美术资产生成指南](../desktop/desk-preview/ART-GENERATION-GUIDE.md) · [208 导入规范](archive/03-appearance-and-performance/208-character-appearance-import-and-dialogue.md#开发契约) | [207 四页重建](archive/02-desktop-ui-and-relations/207-desktop-four-page-rebuild.md) · [210 外观](archive/03-appearance-and-performance/210-appearance-implementation-record.md) · [242 文件夹导入](archive/04-role-settings-and-media/242-role-appearance-folder-import.md) · [237 主题流转](archive/02-desktop-ui-and-relations/237-dialogue-theme-transition.md) | [211 外观](archive/03-appearance-and-performance/211-appearance-independent-review.md#r01-全帧校验补修独立复验) · [234 藏书票页](archive/02-desktop-ui-and-relations/234-relations-exlibris-independent-review.md#4-235-第-7-节补修独立复验) · [验收基线与命令](STATUS.md#3-验收基线与命令) |

---

## 归档专项索引（`devDoc/archive/`）

### 07 · 文档组织与维护

| 文档 | 定位 |
| --- | --- |
| [项目文档、开发规范与修复验收组织优化方案](archive/07-documentation/documentation-optimization-plan.md) | 三类阅读入口、现行契约与验收清单；[第 7 节](archive/07-documentation/documentation-optimization-plan.md#7-导航与现行契约独立复核)记录导航验收与契约差异，[第 7.1 节](archive/07-documentation/documentation-optimization-plan.md#71-现行规范勘误独立复验)记录勘误复验 |

### 06 · 项目操作链路简化与闭环复验（`archive/06-workflow-simplification/`，`277`–`306`）

<details>
<summary>展开 06 专项 30 份文档索引（`277`–`306`）</summary>

| 文档 | 定位与状态 |
| --- | --- |
| [277 项目操作链路复核与待修改项](archive/06-workflow-simplification/277-project-workflow-simplification-audit.md) | 首用、角色活动、全局服务、资源占用、删除和失败恢复的走查建议；主体已由 278 与 280～306 完成实施与离线复验 |
| [278 项目操作链路简化修复文档](archive/06-workflow-simplification/278-project-workflow-simplification-fix-plan.md) | 模型按实际依赖暂停、同页配置与资源维护、首次对话、草稿测试方案（`§6` 视觉规范已由 `specs/frontend-design-system.md` 取代；`§5` 已于 [292 §6](archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) 完成离线自验，独立复核与 `§4` 联调见 `STATUS.md`） |
| [279 操作链路修复方案复核](archive/06-workflow-simplification/279-workflow-simplification-two-pass-review.md) | 三轮复核覆盖页面操作、前后端关联、并发与失败恢复，含端到端验收用例 |
| [280 278 进展一：角色同页暂停保存与消息接收结果](archive/06-workflow-simplification/280-278-progress-role-workspace-dialogue-receipt.md) | 人设／绑定／额度保存时自动暂停并可在原处继续活动；消息接收结果与等待原因、恢复／配置／重试入口 |
| [281 278 进展二：外观语音生图接入暂停保存](archive/06-workflow-simplification/281-278-progress-guarded-panels.md) | 外观、语音配置保存与启停、生图保存接入暂停流程（R08 缺口及全链最终于 283～306 复验关闭） |
| [282 278 进展三：模型依赖维护与资源详情](archive/06-workflow-simplification/282-278-progress-model-impact-resource-detail.md) | 模型影响报告、扩展停用（`canDisable`）、批量关闭绑定、首次对话与绑定合并；后续独立复核与闭环见 283～306 |
| [283 操作链路简化实施独立复核](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md) | 第 26 节记录 306 与任务结束记忆整理独立复验；[第 27 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核) 与 [第 28 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验) 记录文档迁移、`292 §6～§8` 复核结论与剩余跟进项 |
| [284 操作链路复核问题修复](archive/06-workflow-simplification/284-278-review-fixes.md) | R01～R09 修复与实施方自验；独立结论见 [283 第 4 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#4-284-修复独立复验) |
| [285 283 第 4 节复验问题修复](archive/06-workflow-simplification/285-283-reverification-fixes.md) | 六项补修与实施方自验；独立结论见 [283 第 5 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#5-285-补修独立复验) |
| [286 283 第 5 节复验问题修复](archive/06-workflow-simplification/286-283-reverification-fixes.md) | 四项补修与实施方自验；独立结论见 [283 第 6 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#6-286-补修独立复验) |
| [287 283 第 6 节复验问题修复](archive/06-workflow-simplification/287-283-reverification-fixes.md) | 两项补修与实施方自验；独立结论见 [283 第 7 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#7-287-补修独立复验) |
| [288 283 第 7 节复验问题修复](archive/06-workflow-simplification/288-283-reverification-fixes.md) | 两项补修与实施方自验；独立结论见 [283 第 8 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#8-288-补修独立复验) |
| [289 283 第 8 节复验问题修复](archive/06-workflow-simplification/289-283-reverification-fixes.md) | 两项补修与实施方自验；独立结论见 [283 第 9 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#9-289-补修独立复验) |
| [290 283 第 9 节复验问题修复](archive/06-workflow-simplification/290-283-reverification-fixes.md) | 两项补修与实施方自验；独立结论见 [283 第 10 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#10-290-补修独立复验) |
| [291 283 第 10 节复验问题修复](archive/06-workflow-simplification/291-283-reverification-fixes.md) | 两项补修与实施方自验；独立复验通过，见 [283 第 11 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#11-291-补修独立复验) |
| [292 278 剩余项：删除同页暂停与后台调用维护协调](archive/06-workflow-simplification/292-278-remaining-deletion-maintenance.md) | 第 1～5 节的独立结论见 [283 第 12 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#12-292-独立复核)；第 6～8 节的复核见 [283 第 27～28 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)，第 9 节的复验见 [283 第 29 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#29-292-第-9-节独立复验) |
| [293 292 独立复核问题修复](archive/06-workflow-simplification/293-292-review-fixes.md) | 四项修复与实施方自验；独立结论见 [283 第 13 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#13-293-补修独立复验) |
| [294 293 补修独立复验问题修复](archive/06-workflow-simplification/294-293-reverification-fixes.md) | 三项补修与实施方自验；独立结论见 [283 第 14 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#14-294-补修独立复验) |
| [295 294 补修独立复验问题修复](archive/06-workflow-simplification/295-294-reverification-fixes.md) | 删除收尾期间拒绝同角色新过场图任务、失败后恢复可用；独立结论见 [283 第 15 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#15-295-补修独立复验) |
| [296 295 补修独立复验问题修复](archive/06-workflow-simplification/296-295-reverification-fixes.md) | 删除等待已领取的规划结算、删除期拒绝同角色手动整理；独立结论见 [283 第 16 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#16-296-补修独立复验) |
| [297 296 补修独立复验问题修复](archive/06-workflow-simplification/297-296-reverification-fixes.md) | 在途记忆整理纳入统一删除期限、超时保留角色并释放删除队列；独立结论见 [283 第 17 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#17-297-补修独立复验) |
| [298 297 补修独立复验问题修复](archive/06-workflow-simplification/298-297-reverification-fixes.md) | 删除失败后补发删除期被拒绝的维护唤醒；独立结论见 [283 第 18 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#18-298-补修独立复验) |
| [299 298 补修独立复验问题修复](archive/06-workflow-simplification/299-298-reverification-fixes.md) | 删除期暂存任务结束通知并在失败后补发整理；独立结论见 [283 第 19 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#19-299-补修独立复验) |
| [300 299 补修独立复验问题修复](archive/06-workflow-simplification/300-299-reverification-fixes.md) | 暂存任务通知保留到可运行批次，记忆服务晚恢复后仍形成整理；独立结论见 [283 第 20 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#20-300-补修独立复验) |
| [301 300 补修独立复验问题修复](archive/06-workflow-simplification/301-300-reverification-fixes.md) | 任务结束整理意图持久化并在重启后自动恢复；独立结论见 [283 第 21 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#21-301-补修独立复验) |
| [302 301 补修独立复验问题修复](archive/06-workflow-simplification/302-301-reverification-fixes.md) | 从持久化任务与待整理工具证据补写 `task_end` 触发并跨重启恢复；独立结论见 [283 第 22 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#22-302-补修独立复验) |
| [303 302 补修独立复验问题修复](archive/06-workflow-simplification/303-302-reverification-fixes.md) | 按任务隔离 `task_end` 补写失败并保留可重试状态；独立结论见 [283 第 23 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#23-303-补修独立复验) |
| [304 303 补修独立复验问题修复](archive/06-workflow-simplification/304-303-reverification-fixes.md) | 维护／删除／无绑定期间停止安排零延迟定时器并刷新退避时间戳；独立结论见 [283 第 24 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#24-304-补修独立复验) |
| [305 304 补修独立复验问题修复](archive/06-workflow-simplification/305-304-reverification-fixes.md) | 把调度绑定读取纳入异常保护，并在临时读库失败后继续处理已持久化触发；独立结论见 [283 第 25 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#25-305-补修独立复验) |
| [306 305 补修独立复验问题修复](archive/06-workflow-simplification/306-305-reverification-fixes.md) | 启动读库失败后的批次恢复实施记录；独立复核及补修见 [283 第 26 节](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#26-306-补修独立复验) |

</details>

### 05 · 模型配置、首次启动与对话演出修复（`archive/05-model-settings-and-dialogue/`，`268`–`276`）

<details>
<summary>展开 05 专项 9 份文档索引（`268`–`276`）</summary>

| 文档 | 定位与状态 |
| --- | --- |
| [268 模型配置、首次启动与对话演出修复计划](archive/05-model-settings-and-dialogue/268-model-settings-and-dialogue-fix-plan.md) | 271～276 关闭 MR-01～MR-05；MCP／Skill 按 270 §4 不伪造探测；第 6 节生图草稿由 292 实施，[283 §27](archive/06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核) 独立验证与记录待修项 |
| [269 268 进展一：首次活动状态与外观预览](archive/05-model-settings-and-dialogue/269-268-progress-first-launch-import-preview.md) | 新建角色默认停止（API／CLI／初始化重试），导入预览 CSP 允许 blob 图片；后端 355 项、桌面 101 项与 21 步离线验收通过 |
| [270 268 进展二：对话演出与模型选择](archive/05-model-settings-and-dialogue/270-268-progress-dialogue-model-picker.md) | 舞台差分回退、等待与点击推进、模型草稿探测与统一选择控件；后端 355 项、桌面 105 项与 21 步离线验收通过；生图草稿探测后续已补齐（见 292 §6），MCP／Skill 无探测协议保持现状 |
| [271 模型配置与对话演出独立复核](archive/05-model-settings-and-dialogue/271-model-settings-and-dialogue-independent-review.md) | 第 8 节完成 276 独立复验，MR-01～MR-05 在已验范围关闭 |
| [272 271 复核问题修复记录](archive/05-model-settings-and-dialogue/272-271-review-fixes.md) | 桌面 107 项测试通过；独立复验关闭 MR-01、MR-02、MR-05，MR-03、MR-04 剩余缺口见 273 |
| [273 272 复验问题修复记录](archive/05-model-settings-and-dialogue/273-272-reverification-fixes.md) | 独立复验关闭 MR-04，草稿候选转存与常规换密钥通过；在途旧候选写回复验见 271 第 6 节 |
| [274 273 补修复验问题修复记录](archive/05-model-settings-and-dialogue/274-273-reverification-fixes.md) | 旧候选写回的两种返回顺序独立复验通过；旧列表错误和旧连接测试提示复验见 271 第 7 节 |
| [275 274 补修复验问题修复记录](archive/05-model-settings-and-dialogue/275-274-reverification-fixes.md) | 迟到的旧列表失败和旧测试成功独立复验通过；旧提示最终复验见 271 第 8 节 |
| [276 275 补修复验问题修复记录](archive/05-model-settings-and-dialogue/276-275-reverification-fixes.md) | 换密钥和清除密钥后旧提示消失，同一密钥刷新保留有效结果；桌面 109 项测试通过，MR-03 独立复验关闭 |

</details>

### 04 · 角色配置、全局设置、活动护栏与媒体适配（`archive/04-role-settings-and-media/`，`236`、`241`–`267`）

<details>
<summary>展开 04 专项 28 份文档索引（`236`、`241`–`267`）</summary>

| 文档 | 定位与状态 |
| --- | --- |
| [236 角色配置与全局设置后端缺口复核](archive/04-role-settings-and-media/236-role-settings-backend-gap-review.md) | 对照早期接口核对附件，区分首版接入项、补齐项和后续能力；第一包实施见 241，后续分包见 252 |
| [241 角色配置后端第一包（RS-01）](archive/04-role-settings-and-media/241-role-settings-backend-rs-01.md) | 密钥只写存储与统一解析、按资源探测与结果过期、地址与请求边界、参考音频列表／删除、音色下架映射；独立复核与关闭见 244、245 |
| [242 角色外观目录导入（AI-01）](archive/04-role-settings-and-media/242-role-appearance-folder-import.md) | `standees`／`expressions` 识别、导入预览、跨目录手动归并与结果汇总；后续复核修复见 244、245 |
| [243 声音配置页接入（VS-01）](archive/04-role-settings-and-media/243-voice-settings-desktop.md) | 连接测试、试听、参考音频上传／列表／删除、预置音色下架提示与按能力校验；后续复核修复见 244、245 |
| [244 角色配置开发进展独立复核](archive/04-role-settings-and-media/244-role-settings-independent-review.md) | 第 7 节复验关闭 RS-R08，RS-R01～RS-R08 在各自已验离线范围关闭 |
| [245 244 复核问题修复记录](archive/04-role-settings-and-media/245-role-settings-review-fixes.md) | 第 1～12 节记录 RS-R01～RS-R08 及扩展场景修复与自验；后端 301 项、桌面 89 项与 21 步离线验收通过 |
| [246 角色语音启用与停用（DL-149）](archive/04-role-settings-and-media/246-role-voice-toggle.md) | V14 加 `enabled`、启停接口与句段合成 409 `VOICE_DISABLED`，桌面开关及静默跳过；独立结论见 247 |
| [247 角色语音启停独立复核](archive/04-role-settings-and-media/247-role-voice-toggle-independent-review.md) | 后端契约在已验范围通过，第 4 节关闭桌面端 VT-R01、VT-R02 |
| [248 ComfyUI 生图适配（CG-03）](archive/04-role-settings-and-media/248-comfyui-adaptation.md) | 全局生图服务与凭据、V15 角色配置、节点能力探测、按类型打补丁的 MOSS-Image 工作流、测试生图与过场图接入；独立结论见 250 |
| [249 角色语音启停复核问题修复](archive/04-role-settings-and-media/249-role-voice-toggle-review-fixes.md) | VT-R01 停用响应按代际丢弃、VT-R02 保存与启停双向互斥并加写序号；独立复验见 247 第 4 节 |
| [250 ComfyUI 生图适配独立复核](archive/04-role-settings-and-media/250-comfyui-independent-review.md) | CG-R01～CG-R05 在已验离线范围关闭，真实服务联调待验 |
| [251 ComfyUI 复核问题修复](archive/04-role-settings-and-media/251-comfyui-review-fixes.md) | CG-R01～CG-R05 的修复与自验（含 V16 任务配置快照）；独立复验见 250 |
| [252 角色配置与设置后端开发计划](archive/04-role-settings-and-media/252-role-config-settings-development-plan.md) | 三包均已通过独立离线复验（255／258／263），桌面整体验收见 266 |
| [253 角色配置与设置前端接入计划](archive/04-role-settings-and-media/253-role-config-settings-frontend-plan.md) | 双页与跨页草稿按原型接入，已于 266／267 通过离线独立复验（样式约定后续已并入 `specs/frontend-design-system.md`） |
| [254 252 第一包角色活动与配置写入保护实施记录](archive/04-role-settings-and-media/254-role-activity-config-guard.md) | 实施方自验与接口记录，独立结论见 255，修复见 256、259 |
| [255 角色活动与配置写入保护独立复核](archive/04-role-settings-and-media/255-role-activity-independent-review.md) | RA-R01～RA-R05 已在离线范围通过独立复验 |
| [256 255 复核问题修复记录](archive/04-role-settings-and-media/256-role-activity-review-fixes.md) | RA-R01～RA-R04 的修复与自验；后端 325 项与 21 步离线验收通过，独立复验见 255 |
| [257 252 第二包模型与扩展资源管理实施记录](archive/04-role-settings-and-media/257-resource-management.md) | 资源引用报告与删除、MCP／Skill 修改与全局关闭的占用检查、绑定 revision 冲突保护、MCP 环境变量脱敏；独立结论见 258，修复见 259 |
| [258 模型与扩展资源管理独立复核](archive/04-role-settings-and-media/258-resource-management-independent-review.md) | RP-R01～RP-R07 均在已验离线范围关闭，第二包通过独立复验 |
| [259 255／258 复核问题修复记录](archive/04-role-settings-and-media/259-role-activity-resource-review-fixes.md) | RA-R05 与 RP-R01～RP-R07 的修复与自验；后端 343 项与 21 步离线验收通过，均已通过独立复验 |
| [260 角色配置与设置前端首轮记录](archive/04-role-settings-and-media/260-role-settings-frontend-first-pass.md) | 首轮双页草稿与活动状态接口接入自验（历史过渡稿；后续整包完成与复验见 265～267） |
| [261 角色配置与设置原型迁移记录](archive/04-role-settings-and-media/261-role-settings-prototype-migration.md) | 两页原型结构、交互、资源管理及离线自验；第三包前端接入见 265，独立结论见 266 |
| [262 252 第三包外观、删除与历史数据实施记录](archive/04-role-settings-and-media/262-role-appearance-deletion-history.md) | 服饰改名、主页立绘补传／替换、服饰与差分删除、句段立绘快照回填、角色删除两条路径；独立结论见 263，修复见 264 |
| [263 252 第三包外观、删除与历史数据独立复核](archive/04-role-settings-and-media/263-role-appearance-deletion-independent-review.md) | AD-R01～AD-R06 已在离线范围关闭，第三包通过独立复验 |
| [264 263 复核问题修复记录](archive/04-role-settings-and-media/264-role-appearance-deletion-review-fixes.md) | AD-R01～AD-R06 的修复与自验；后端 355 项与 21 步离线验收通过，已通过独立离线复验 |
| [265 角色配置与设置前端第三包接入记录](archive/04-role-settings-and-media/265-role-settings-frontend-third-package.md) | 外观、角色删除、历史素材与资源同步接入；独立结论见 266 |
| [266 253 角色配置与设置前端独立复核](archive/04-role-settings-and-media/266-role-settings-frontend-independent-review.md) | CF-R01～CF-R05 在已验本机范围关闭，真实服务待联调 |
| [267 角色配置与设置前端复核修复](archive/04-role-settings-and-media/267-role-settings-frontend-review-fixes.md) | CF-R01～CF-R05 均通过独立复验 |

</details>

### 03 · 角色外观、对话演出、TTS 与桌面对话接入（`archive/03-appearance-and-performance/`，`208`–`213`、`215`–`232`）

<details>
<summary>展开 03 专项 24 份文档索引（`208`–`213`、`215`–`232`）</summary>

| 文档 | 定位与状态 |
| --- | --- |
| [208 角色外观导入与对话立绘接入](archive/03-appearance-and-performance/208-character-appearance-import-and-dialogue.md) | DL-136 的用户图片规范、素材登记接口、桌面接入与验收（对话立绘后续已于 229～231 与 269～271 接入并复验） |
| [209 Agent 每日穿搭开发文档](archive/03-appearance-and-performance/209-agent-daily-outfit-development-guide.md) | DL-136 的穿搭决策时机、角色状态提交、主页与对话刷新及验收（后续对话同步见 215／229／270） |
| [210 角色外观导入与每日穿搭首轮实施记录](archive/03-appearance-and-performance/210-appearance-implementation-record.md) | 衣柜存储、图片导入读图、Agent 穿搭状态、桌面入口与主页立绘自验（后续复核见 211，对话演出见 229～231、270） |
| [211 角色外观与每日穿搭独立复核](archive/03-appearance-and-performance/211-appearance-independent-review.md) | 统一离线验收、真实原图与 Agent 链路通过，R01～R03 在已复验范围关闭 |
| [212 211 外观复核 R01～R03 修复记录](archive/03-appearance-and-performance/212-appearance-review-fixes.md) | 图片全帧解码、状态版本门和图片与服饰名同步的实现方证据；独立结论见 211 |
| [213 对话演出后端方案](archive/03-appearance-and-performance/213-conversation-performance-backend-plan.md) | DL-137／DL-138 的回复消息设计、三条演出链路、句段契约和后端接口方案 |
| [215 对话演出第一包实施记录](archive/03-appearance-and-performance/215-conversation-segments-implementation.md) | 回复句段、快照、晚到表情标注与 v8 存储的实现方自验；独立结论见 216、217 |
| [216 对话演出第一包独立复核](archive/03-appearance-and-performance/216-conversation-performance-independent-review.md) | 离线回归和 v7 样例迁移通过，R01～R04 在已验范围关闭 |
| [217 对话演出第一包复核修复记录](archive/03-appearance-and-performance/217-conversation-performance-review-fixes.md) | R01～R04 的修复与实现方自验，最终独立结论见 216 第 6 节 |
| [218 TTS 与角色音色首轮实施记录](archive/03-appearance-and-performance/218-tts-implementation-record.md) | IndexTTS 本地 HTTP、参考音频导入、试听与按句合成、v9 存储；第 7 节记录 219 R01～R03 修复与自验 |
| [219 首版 IndexTTS 接入规范与独立复核](archive/03-appearance-and-performance/219-indextts-integration-spec.md) | R01～R03 及补修通过独立离线复验，真实桥接待联调 |
| [220 TTS 统一接入说明](archive/03-appearance-and-performance/220-tts-unified-integration.md) | 音色克隆与预置音色共用的配置流程、服务接口、后端迁移和验收，已按 221 完成首轮后端实施 |
| [221 TTS 统一接入首轮实施记录](archive/03-appearance-and-performance/221-tts-unified-implementation.md) | 能力探测、克隆／预置音色、multipart 合成、v10→v12 迁移与旧配置兼容；第 7～11 节记录 222 修复 |
| [222 TTS 统一接入独立复核](archive/03-appearance-and-performance/222-tts-unified-independent-review.md) | R01～R04 在已验范围关闭，v10 和旧 v11 升级到 v12 通过，真实语音服务待联调 |
| [223 对话演出开发文档](archive/03-appearance-and-performance/223-conversation-performance-development-guide.md) | 213 的实现现状、过场图后端工作包与契约草案、待决策项、桌面与真实联调排期 |
| [224 生成过场图第一包实施记录](archive/03-appearance-and-performance/224-scene-image-cg-01-record.md) | CG-01 任务与读取契约、v13 存储、假规划与假生成器、失败重试与重连的实现方自验；独立结论见 227 |
| [226 生成过场图第二包实施记录](archive/03-appearance-and-performance/226-scene-image-cg-02-record.md) | CG-02 模型规划、上下文与服饰参考素材、生成超时与重试的实现方自验；独立结论见 227 |
| [227 过场图后端独立复核](archive/03-appearance-and-performance/227-scene-image-independent-review.md) | CG-01／CG-02 离线范围通过，R01～R06 关闭 |
| [228 过场图复核修复记录](archive/03-appearance-and-performance/228-scene-image-review-fixes.md) | R01～R06 的实现方修复与自验，独立结论见 227 第 7 节 |
| [225 桌面对话页开发文档](archive/03-appearance-and-performance/225-conversation-desktop-development-guide.md) | v5 交互原型、正式前端分期、消息与媒体契约、验收清单（样式规范后续已并入 `specs/frontend-design-system.md`） |
| [229 桌面对话页第一包实施记录](archive/03-appearance-and-performance/229-conversation-desktop-fe-01-record.md) | FE-01 页面装配、演出状态、演示语音与历史面板的实现方自验；后续接入与复核见 230、231 |
| [230 桌面对话 FE-02 接入进展](archive/03-appearance-and-performance/230-conversation-desktop-fe-02-progress.md) | 窗口接入、历史分页定位、舞台与语音补修及离线自验；独立复核见 231 |
| [231 桌面对话页独立复核](archive/03-appearance-and-performance/231-conversation-desktop-independent-review.md) | 53 项桌面测试、10 组浏览器场景通过，FE-R01～FE-R04 在离线范围关闭 |
| [232 桌面对话 231 复核修复记录](archive/03-appearance-and-performance/232-conversation-desktop-review-fixes.md) | FE-R01～FE-R04 修复与离线自验，独立结论见 231 第 4 节 |

</details>

### 02 · 桌面基础重构、关系藏页与界面精简（`archive/02-desktop-ui-and-relations/`，`200`–`207`、`214`、`233`–`235`、`237`–`240`）

<details>
<summary>展开 02 专项 16 份文档索引（`200`–`207`、`214`、`233`–`235`、`237`–`240`）</summary>

| 文档 | 定位与状态 |
| --- | --- |
| [200 桌面前端开发与视觉优化计划](archive/02-desktop-ui-and-relations/200-desktop-frontend-development-plan.md) | DL-131 初版 3D 书桌计划（已由 205／207 及 `specs/frontend-design-system.md` 取代，作历史留档） |
| [201 桌面书桌首版样机实施记录](archive/02-desktop-ui-and-relations/201-desktop-desk-preview-record.md) | FE-01、FE-02 首版 3D 书桌离线样机历史记录（对应脚本已于 205 重构移除） |
| [202 书桌 Windows 前端初版](archive/02-desktop-ui-and-relations/202-desktop-desk-windows-v1.md) | Windows x64 便携 EXE、物件交互、本地时间和四季天气历史记录 |
| [203 书桌 v0.1.1 窗口与场景细化](archive/02-desktop-ui-and-relations/203-desktop-desk-window-and-art-refinement.md) | dev 品牌图标、满幅窗口、书脊和场景重渲染及本机验证历史记录 |
| [204 书桌 v0.1.2 原生窗口与天气细化](archive/02-desktop-ui-and-relations/204-desktop-desk-window-weather-refinement.md) | 原生窗口、独立受光玩偶、画室拍立得、分层雨雪和室内外风动历史记录 |
| [205 光影书房与器物剧场前端重构计划](archive/02-desktop-ui-and-relations/205-luminary-study-theater-frontend-plan.md) | `dev-front` 分支重构方案：单舞台双焦距、全屏五层光影流转（页面范围与样式分别由 206／207 与 `specs/frontend-design-system.md` 取代） |
| [206 桌面主页精简、环境流转与角色外观入口](archive/02-desktop-ui-and-relations/206-desktop-home-scene-and-role-visual-plan.md) | DL-132～DL-134 的历史前端方案与实现方自验，页面范围与样式分别按 DL-135 与 `specs/frontend-design-system.md` |
| [207 桌面前端四页重做记录](archive/02-desktop-ui-and-relations/207-desktop-four-page-rebuild.md) | DL-135 的四页范围、主页与关系页实现及本机自验记录（后续样式约束见 `specs/frontend-design-system.md`） |
| [214 关系藏页接入记录](archive/02-desktop-ui-and-relations/214-relationship-exlibris-page.md) | 关系页改为人物藏书票与经历、日记、介绍；后续迁移对照、独立复核与顶部精简见 233～235、240 |
| [233 关系藏页原型对照与迁移修复](archive/02-desktop-ui-and-relations/233-relations-exlibris-migration-fixes.md) | 对照用户提供的关系页原型，修复布局、主题、交互和资料读取，独立结论见 234 |
| [234 关系藏页迁移独立复核](archive/02-desktop-ui-and-relations/234-relations-exlibris-independent-review.md) | 第 4 节确认 EX-R01～EX-R05 在离线范围关闭，真实数据联调待验 |
| [235 关系藏页复核修复记录](archive/02-desktop-ui-and-relations/235-relations-exlibris-review-fixes.md) | EX-R01～EX-R05 修复与实现方自验，独立结论见 234 第 3～4 节 |
| [237 对话页明暗切换（关系页推进方案已回滚）](archive/02-desktop-ui-and-relations/237-dialogue-theme-transition.md) | 对话页照 v4 参考实现舞台光线 + 纸面 14 档逐行推进；关系页推进方案已回滚；实现方自验，**独立复核待执行** |
| [238 对话页顶部精简与布局调整](archive/02-desktop-ui-and-relations/238-dialogue-layout-refinement.md) | 对话框内工具图标、舞台上移和移除全局顶部设置入口（DL-144）；实现方自验，**独立复核待执行** |
| [239 对话页 Dock 显示设置](archive/02-desktop-ui-and-relations/239-dialogue-dock-visibility.md) | 对话页可隐藏底部导航、其他页面保留导航及本地偏好（DL-145）；实现方自验，**独立复核待执行** |
| [240 关系页顶部栏精简](archive/02-desktop-ui-and-relations/240-relations-header-removal.md) | 移除关系页顶部标题栏并将日夜装饰条移入书页右上方（DL-146）；2026-11-10 经用户确认通过 |

</details>

### 01 · 首轮后端原型 P0～P5 与缺口补齐（`archive/01-backend-prototype/`，`162`–`199`）

<details>
<summary>展开 01 专项 38 份文档索引（`162`–`199`）</summary>

| 文档 | 定位与状态 |
| --- | --- |
| [162 首轮后端原型实施方案](archive/01-backend-prototype/162-backend-prototype-implementation-plan.md) | R1～R64 总体实施基线方案；首轮 P0～P5 已按本方案落成并通过 [195 复核](archive/01-backend-prototype/195-p5-independent-review.md) 收口 |
| [163 设计与方案一致性核对](archive/01-backend-prototype/163-design-consistency-review.md) | 首轮文档一致性核对，记录遗漏修正、需求覆盖、未采用底稿条款与早期历史待讨论清单 |
| [164 首轮后端原型执行清单](archive/01-backend-prototype/164-backend-prototype-execution-checklist.md) | R64／DL-129 确认的首轮阶段入口：P0～P5 与 GAP-01～06 均已按 195／198 离线收口；§4 未决产品项随后续专项逐项推进 |
| [165 后端开发文档：P0 技术小样](archive/01-backend-prototype/165-backend-development-guide.md) | P0-01～P0-05 工作包与验收模板 |
| [166 P0 技术小样实施记录](archive/01-backend-prototype/166-p0-implementation-record.md) | P0 实现、版本、自验及 L01／L03／L06 修正记录 |
| [167 P0 独立复核记录](archive/01-backend-prototype/167-p0-independent-review.md) | R01～R04 关闭，37 项检查、5 个原场景及 4 个真实强杀场景独立复验通过 |
| [168 P0 复验遗留修复清单](archive/01-backend-prototype/168-p0-followup-fix-list.md) | L01、L03、L06 通过独立复核；其余按第 7 节不修改或归入 P1／P4 |
| [169 P1 开发文档：角色、存储与资源配置](archive/01-backend-prototype/169-p1-role-storage-development-guide.md) | P1 范围、工作包与离线验收 |
| [170 P1-01 角色与存储工程契约](archive/01-backend-prototype/170-p1-01-contract.md) | 固定目录、appRoot、schema、初始化、HTTP／CLI 与凭据策略契约 |
| [171 P1 实施记录](archive/01-backend-prototype/171-p1-implementation-record.md) | P1-01～P1-06 实现方证据，最终独立结论见 172 第 12 节 |
| [172 P1 独立开发复核](archive/01-backend-prototype/172-p1-independent-review.md) | 第 12 节最终通过，13 个测试及三组共 13 个场景通过 |
| [173 P2 开发文档](archive/01-backend-prototype/173-p2-memory-agent-development-guide.md) | 完整记忆、检索维护、Agent 对话、模型和本地扩展的范围与工作包 |
| [174 P2-01 事件记忆与对话执行契约](archive/01-backend-prototype/174-p2-01-memory-agent-contract.md) | 固定业务库、证据与批次、事件／摘要／日记、检索召回、SSE、模型端口与 API／CLI 契约 |
| [175 P2-02 记忆形成与保存实施记录](archive/01-backend-prototype/175-p2-02-memory-formation-record.md) | 迁移、证据、触发、分批分段与事件索引（当年实现方自验；完整 P2 后续已通过 178／184 最终独立验收） |
| [176 P2-03 检索、维护与主观记忆实施记录](archive/01-backend-prototype/176-p2-03-memory-query-record.md) | 中文检索、证据追溯、精炼、纠错与日记 Markdown（当年实现方自验；R05 及完整 P2 后续已通过 178／184 最终独立验收） |
| [177 P2-04 模型与本地扩展实施记录](archive/01-backend-prototype/177-p2-04-model-extension-record.md) | 原实现方证据保留；本地离线范围已通过 178 第 6 节独立复验 |
| [178 P2-04 及前置工作包独立复核](archive/01-backend-prototype/178-p2-04-independent-review.md) | 第 6 节最终通过，R01～R06 关闭，58 项回归与 27 个复验场景通过 |
| [179 P2-04 复核问题修复记录](archive/01-backend-prototype/179-p2-04-review-fix-record.md) | 实施方六项修正自验；已通过 178 第 6 节独立复验 |
| [180 P2-05 Agent 对话联动实施记录](archive/01-backend-prototype/180-p2-05-agent-conversation-record.md) | 历史 77 项实施方自验；完整 P2 最终证据见 184 第 7 节 |
| [181 P2-06 全量验收自验矩阵（草案）](archive/01-backend-prototype/181-p2-06-self-acceptance-matrix.md) | 历史实施方测试映射；P2 最终独立复验与真实联调通过范围见 184 第 7 节 |
| [182 P2-05 独立开发复核](archive/01-backend-prototype/182-p2-05-independent-review.md) | R01～R09 最终关闭，R05／R09 真实复验与 P2 收口见 184 第 7 节 |
| [183 P2-05 复核问题修复记录](archive/01-backend-prototype/183-p2-05-review-fix-record.md) | 历史修复与第 12 节补正通过 182 第 6 节复验，后续见 184 |
| [184 P2-06 阶段验收报告](archive/01-backend-prototype/184-p2-06-acceptance-report.md) | 第 7 节最终通过：105 项回归、20 个离线及 4 项真实复验，R01～R09 关闭，P2 首轮后端范围收口 |
| [185 P2-06 R05／R09 阻断修复记录](archive/01-backend-prototype/185-p2-06-r05-r09-fix-record.md) | R05／R09 修复自验，已由 184 第 7 节独立复验关闭 |
| [186 P3 自主推进开发文档](archive/01-backend-prototype/186-p3-autonomy-development-guide.md) | P3 范围、工作包与存储／额度／唤醒／工具／API 工程契约 |
| [187 P3 自主安排、唤醒与额度实施记录](archive/01-backend-prototype/187-p3-autonomy-implementation-record.md) | 首轮自验保留；复核缺口与修复见 188、189 |
| [188 P3 自主安排、唤醒与额度独立复核](archive/01-backend-prototype/188-p3-independent-review.md) | 第 7 节最终通过：142 项回归、11 个边界场景，P3-R01～R06 关闭（离线范围） |
| [189 P3 独立复核修复记录](archive/01-backend-prototype/189-p3-independent-review-fix-record.md) | 历史修复自验；188 第 7 节已独立复验通过，P3-R01～R06 关闭 |
| [190 P4 恢复、执行真实性与规则组合验收报告](archive/01-backend-prototype/190-p4-recovery-acceptance-report.md) | 第 13 节用户确认 P4 收口，最终补修由 195 后续独立复验 |
| [191 P4 恢复缺口修复记录](archive/01-backend-prototype/191-p4-recovery-fix-record.md) | 第 10 节最终补修自验及第 11 节用户接受收口，后获 195 独立复验 |
| [192 产品介绍：视觉风格与设计语言探索](archive/01-backend-prototype/192-product-introduction-for-visual-direction.md) | 面向早期视觉探索的简要产品背景介绍（不固定页面原型） |
| [193 P5 后端原型复核与交付开发文档](archive/01-backend-prototype/193-p5-prototype-delivery-guide.md) | P5 范围、交付与证据规则；P5-01～P5-05 已由 194 自验及 195 独立复核完成 |
| [194 P5 后端原型交付与自验记录](archive/01-backend-prototype/194-p5-prototype-delivery-record.md) | 15 步实现方自验记录；后续整体独立复核见 195 |
| [195 P5 后端原型整体独立复核](archive/01-backend-prototype/195-p5-independent-review.md) | 整体复核通过，15 步、59 个业务场景与 4 项验收故障契约通过，首轮本机后端源码原型收口 |
| [196 首轮后端功能缺口与补齐计划](archive/01-backend-prototype/196-backend-capability-gap-plan.md) | GAP-01～GAP-06 及体验候选清单；六项缺口已实施并通过 198 离线独立复核 |
| [197 首轮后端功能缺口实施与自验记录](archive/01-backend-prototype/197-p5-capability-gaps-implementation-record.md) | GAP-01～GAP-06 首轮实现与自验；198 首轮复核发现的 R01～R06 修复见 199 |
| [198 首轮后端功能缺口独立复核](archive/01-backend-prototype/198-p5-capability-gaps-independent-review.md) | 统一离线验收 21 步通过，R01～R06 在本机离线范围关闭 |
| [199 首轮后端功能缺口复核修复记录](archive/01-backend-prototype/199-p5-gaps-review-fix-record.md) | R01～R06 实现方修复、自验及 R01 两轮补修；独立结论见 198 |

</details>

---

## 分支约定与旧版参考

- `master`：数字生命新主线主开发分支（已合入 P5 及早期开发基线）。
- `dev-front`：当前桌面前端重构与前后端联合推进工作分支。
- `dev`：旧版项目代码、设计时间线与历史验收记录只读归档（不直接构成新主线的兼容要求或验收证据）。
- `codex/p0-runtime-spike`：`prototypes/p0/` 技术小样分支。
