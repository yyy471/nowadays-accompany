# 项目文档、开发规范与修复验收组织优化方案

2026-11-14。本文是本次文档优化的实施方案与验收清单。当前入口见[文档总导航](../../README.md)，修复任务及验证范围见[状态页](../../STATUS.md)。

## 1. 要解决的问题

现在已有 `STATUS.md`、`specs/`、`design/` 和六个专项归档目录。总索引同时承担日常导航和 145 份历史文档的查询，接手一个任务时仍需要从长表里分辨哪份是现行规范、哪份是旧方案、哪份是独立结论。部分现行后端和联调契约还位于编号方案中，包括角色与存储、对话与记忆、对话演出、TTS 和设置。修复专项已有连续复核记录，但历史编号、自验与独立复核容易被当作当前状态的多个来源。 [现行规范总览](../../specs/README.md) · [操作链路简化独立复核](../06-workflow-simplification/283-278-workflow-simplification-independent-review.md)

优化目标是让使用者先选阅读目的，再按模块进入正确文档。产品规则在决策记录维护，工程契约在现行规范维护，当前任务和验收结论从状态页进入。按专项保留方案、实施和复核的完整过程，原文档路径、编号和已有标题锚点继续用于回查。

## 2. 三类入口和文档归属

| 阅读入口 | 用户要找的内容 | 权威位置 | 更新时机 |
| --- | --- | --- | --- |
| 项目 | 产品方向、已确认规则、路线与当前进度 | [161 持续决策](../../161-digital-life-direction-decisions.md)记录 `DL-xx`；[状态页](../../STATUS.md)记录当前状态、待办和验证范围 | 有新确认决定时更新 161；任务状态或验收范围变化时更新状态页 |
| 开发 | 环境、运行命令、接口、状态机、错误与交互、设计规范 | [现行规范总览](../../specs/README.md)进入各模块契约；启动与接口使用说明链接至[后端 README](../../../backend/README.md)等随模块维护的原文 | 已确认契约或实际支持范围变化时更新对应规范 |
| 修复与验收 | 问题如何复现、实际影响、实施方修了什么、独立复验覆盖哪些边界 | [状态页待办](../../STATUS.md#2-当前待推进事项backlog)连接当前专项复核；[归档专项索引](../../README.md)用于找历史记录 | 发现、实施、自验和独立复验分别在对应专项内追加；当前状态变化时同步状态页 |

`devDoc/README.md` 同时作为三个入口的总导航和完整归档索引。`design/` 内的原始参考底稿和工程资产维持现有位置，设计令牌继续以 [tokens.json](../../design/character-studio/tokens.json) 为源文件。`AGENTS.md` 继续维护长期协作规则、环境命令和入口链接。

## 3. 总索引重排

1. 页首设置「项目」「开发」「修复与验收」三个清晰入口。项目入口直达 161 和状态页，开发入口直达 `specs/README.md`，修复入口直达状态页待办及专项索引。路径映射留在导航，状态和规范正文各自维护。
2. 在完整归档表之前新增「常用专项」表。每行给出现行契约、实施记录、独立复核三个位置。契约按节链接，复核链接优先跳到对应结论所在小节。跨多个历史目录的同一专项仍在这里合并呈现。
3. 完整归档索引保留已有六个专项标题与每份历史文档链接。六个专项的表各自折叠，专项标题放在折叠块外，保持原标题锚点可访问。GitHub 渲染中检查折叠与表格，原始 Markdown 中仍可用文件名和编号检索。
4. 状态页继续显示当前结论、待办和验收基线。专项导航只用短说明和链接。历史轮次、复现过程、测试计数的推导和日志定位放在对应专项记录。

首批专项采用下列入口，具体链接可随着新的现行规范落地更新。

| 专项 | 当前开发入口 | 主要实施与复核入口 |
| --- | --- | --- |
| 角色配置、设置与活动保护 | [252 后端计划](../04-role-settings-and-media/252-role-config-settings-development-plan.md) · [253 前端接入](../04-role-settings-and-media/253-role-config-settings-frontend-plan.md) · [278 操作链路](../06-workflow-simplification/278-project-workflow-simplification-fix-plan.md) | [266 桌面独立复核](../04-role-settings-and-media/266-role-settings-frontend-independent-review.md) · [283 操作链路复核](../06-workflow-simplification/283-278-workflow-simplification-independent-review.md) |
| 对话演出与过场图 | [223 过场图工作包](../03-appearance-and-performance/223-conversation-performance-development-guide.md) · [ComfyUI 文生图](../04-role-settings-and-media/248-comfyui-adaptation.md) | [226 手动过场图实施](../03-appearance-and-performance/226-scene-image-cg-02-record.md) · [227 过场图复核](../03-appearance-and-performance/227-scene-image-independent-review.md) · [231 桌面对话复核](../03-appearance-and-performance/231-conversation-desktop-independent-review.md) |
| TTS 与角色语音 | [220 统一接入](../03-appearance-and-performance/220-tts-unified-integration.md) · [292 草稿语音与设置](../06-workflow-simplification/292-278-remaining-deletion-maintenance.md#6-生图草稿探测语音暂存试听与设置导航收敛) | [222 接入复核](../03-appearance-and-performance/222-tts-unified-independent-review.md) · [247 启停复核](../04-role-settings-and-media/247-role-voice-toggle-independent-review.md) |
| 角色存储、记忆与回复执行 | [170 角色存储](../01-backend-prototype/170-p1-01-contract.md) · [174 记忆与对话](../01-backend-prototype/174-p2-01-memory-agent-contract.md) | [195 P5 复核](../01-backend-prototype/195-p5-independent-review.md) · [283 第 26 节记忆整理复验](../06-workflow-simplification/283-278-workflow-simplification-independent-review.md#26-306-补修独立复验) |

## 4. 现行开发契约的提炼方法

每次选择一个模块，从 161 的已确认决策开始，对照仍生效的方案章节、实现入口、覆盖该规则的测试及最近一次独立复核。按规则逐条处理来源：已确认且有实现证据的规则写入现行规范；已确认但尚未实现的部分标明规划状态，并将当前进度链接到状态页；来源存在冲突的规则注明待决议或待补修，保留代码现状与确认依据的链接。

现行规范建议按以下顺序组织，按模块需要保留相关小节即可。

1. 适用范围、上游 `DL-xx` 和依赖规范。
2. 正常入口、输入输出和数据归属。API 写清方法、路径、关键字段、状态码和错误码。
3. 状态变化、对象切换、写入边界、并发约束与失败恢复。涉及前后端协作时写清谁判定状态、谁提交和谁收到结果。
4. 验收场景与可运行命令。清楚标注离线服务、真实服务和打包分别需要哪类证据。
5. 源文档、实现与独立复核链接。提炼完成后从 `specs/README.md` 和常用专项导航指向新规范，在被替代的历史章节旁留一个指向现行规范的引用。

优先提炼角色配置和活动保护，再梳理对话演出与过场图、TTS 与生图接入。存储和记忆按实际维护任务逐步整理。首批导航允许直接指向仍有效的原契约章节，每次提炼只切换已核对的链接。遇到确认规则与已实现行为冲突时，分别保留两类证据，将落差按同专项问题记录。现行标准的变化按 161 的既有流程办理。

## 5. 修复与复验如何记录

同一专项延续现有复核文档，已有编号的历史修补记录可以作为证据链接。每项新发现沿用稳定问题号，记录触发前提、操作或请求、现状、期望、影响和实现位置。实施方完成修改时补上改动位置、自验命令、结果和未覆盖范围。独立复验继续引用原问题号，分别汇报复现步骤、正常与失败分支、环境和结论。对重复触发的同一缺陷，沿原问题号补充路径。只有发现成因与验收条件独立的问题时才另起问题号。

| 当前结果 | 专项记录 | 状态页 |
| --- | --- | --- |
| 已确认待修 | 记原问题号、实际行为与验收条件 | 必要时新增一条指向问题的待办 |
| 已补修待独立复验 | 追加实现与自验证据 | 更新该专项的待推进动作 |
| 已通过独立复验 | 记录通过的范围、边界和证据位置 | 在对应范围标记通过，仍待真实联调的部分保留在待办 |

脚本随项目代码维护，报告、运行日志和截图记录到对应 `test-results/` 路径。文档保留必要的命令、证据路径和结果摘要。现有 292-R05～R08 的发现和验收条件沿用 [283 第 27 节](../06-workflow-simplification/283-278-workflow-simplification-independent-review.md#27-文档迁移与-292-第-67-节独立复核)。

## 6. 实施顺序与验收

| 顺序 | 工作 | 可交付结果 |
| --- | --- | --- |
| 本次 | 编写优化方案，在总索引登记 | 方案可由总索引直达，明确目录分工、迁移顺序与验收方法 |
| 第一批文档优化 | 重排总索引，补常用专项直达，检查 `specs/README.md`、状态页和关键锚点 | 三类入口可用，当前专项能从入口直达契约与复核，原归档链接可访问 |
| 当前问题补修 | 本方案完成后，按后续修复安排处理 292-R05～R08 | 复用 283 的编号与验收条件，在原专项追加补修和复验结果 |
| 持续维护 | 按模块提炼现行契约，将导航切到核对后的规范 | 每次只迁移已验证的规则，保留历史出处和开放问题 |

第一批文档优化按以下场景验收。

- 从总索引找当前待修项，能到达状态页中 292-R05～R08 的链接，并定位到 283 第 27 节。查已确认的角色语音配置规则，能通过项目入口找到 161 的 DL-149。
- 查生图、TTS、角色配置或对话契约，能从开发入口定位到现行来源，识别已实现、已独立复验与待真实服务验证的范围。设计系统及令牌源文件路径仍可访问。
- 用 `278`、`283`、`292` 等既有编号从归档索引回查历史，核对六个专项表可展开，已有专项标题和本次新增的代表性段落锚点可跳转。
- 在仓库根运行 `node scripts/check-docs.mjs` 与 `git diff --check`。巡检已覆盖目录、索引及核心文档的跨文件标题链接。归档内标题锚点和新加的同页跳转按本次改动逐一抽查。

当前交付为本文与索引登记。三类导航可按第一批方案独立实施，业务修复可以继续使用现有状态页与复核文档。测试脚本修补和实际服务联调按各自待办推进。

## 7. 导航与现行契约独立复核

2026-11-14。三类入口、常用专项表、六组折叠归档与四份现行契约已落地。文档巡检覆盖 13 份核心文档和 146 份归档，0 错误、0 警告。与提交前总索引比较，原编号入口均可回查，原 `307` 由现行前端设计规范承接。检查了 Markdown 中折叠块配对及代表性锚点，GitHub 页面渲染未实测。

| 编号 | 复核发现 | 修订与复验条件 |
| --- | --- | --- |
| DOC-R01 · P2 | 对话现行规范把 `DELETE …/input-state` 的成功响应写为 `204`，缺 `clientId` 写成 `INVALID_QUERY`。HTTP 路由实际返回 `200 { cleared: true }`，缺参数时报 `400 INPUT_STATE_INVALID`。另有手动记忆整理接口将内部 `MEMORY_BATCH_CONFLICT` 当成同步 HTTP 结果，路由实际登记触发后返回 `202`，删除期间拒绝为 `409 ROLE_DELETING`。 [对话契约](../../specs/conversation-performance-and-scene-images.md#21-对话输入状态sse-与语音消费接口) · [后端路由](../../../backend/src/http/routes.ts#L358-L375) · [输入态测试](../../../backend/tests/p2-05-api-cli.test.ts#L155-L160) · [手动整理路由](../../../backend/src/http/routes.ts#L914-L932) | 对照入口分别列出 HTTP 返回与后台处理结果。输入态 HTTP／CLI 测试本轮重跑通过。 |
| DOC-R02 · P2 | 对话与媒体两份现行规范把 `CG-04` 定义为图生图与锚点上传。223 将 `CG-04` 用于独立复核与真实适配，状态页也将真实适配和图生图分别列出。 [对话规范](../../specs/conversation-performance-and-scene-images.md#43-未实现能力与真实联调缺口) · [223 工作包](../03-appearance-and-performance/223-conversation-performance-development-guide.md) · [状态页](../../STATUS.md#2-当前待推进事项backlog) | 按 223 保留工作包含义。图生图与锚点上传单独列为后续能力。 |
| DOC-R03 · P2 | 媒体规范用 `app.db` 和 `business.db` 指代物理库，实际文件是 `app.sqlite` 和 `business.sqlite`。按媒体表查库会用错路径。 [媒体规范](../../specs/tts-and-image-services.md#23-数据存储与受管文件) · [路径定义](../../../backend/src/bootstrap/config.ts#L68-L84) | 媒体规范使用实际文件名或指向存储规范的路径定义。 |
| DOC-R04 · P3 | 总索引常用专项表把 292-R05～R08 标为「待修」，状态页与 292 §8 已记录实现方补修，当前处于独立复核阶段。 [常用专项](../../README.md#常用专项) · [状态页](../../STATUS.md#2-当前待推进事项backlog) | 用稳定的证据链接描述专项，当前状态引用状态页。 |

三类导航与归档结构通过。现行规范仍需核对以上契约与状态差异。生图与 E2E 补修的独立复核见 [283 第 28 节](../06-workflow-simplification/283-278-workflow-simplification-independent-review.md#28-292-第-8-节独立复验)。

### 7.1 现行规范勘误独立复验

2026-11-14。`DOC-R01` 的原发现已修正，确认删除输入态返回 `200 { cleared: true }`，缺 `clientId` 返回 `400 INPUT_STATE_INVALID`，手动整理接口返回 `202 { triggerId, duplicate }`。`DOC-R02`～`DOC-R04` 通过复验，`CG-04` 已恢复为独立复核与真实适配，媒体库使用 `.sqlite`，常用专项以中性证据链接配合状态页维护。 [输入态 HTTP 验证](../../../backend/tests/p2-05-api-cli.test.ts#L142-L182) · [手动整理入口](../../../backend/src/http/routes.ts#L914-L932)

**DOC-R01 邻接契约差异 · P3。** 同一张表仍把 `POST …/input-state` 参数失败统一写成 `INPUT_STATE_INVALID`。本机 HTTP 实测，缺 `clientId` 返回 `400 INPUT_STATE_INVALID`，已传空 `clientId` 或 `typing` 非布尔值则返回 `400 INVALID_REQUEST`。两类失败分别来自输入态业务校验和请求体结构校验。修订时按来源列明两个错误码，保留 `DELETE` 行本次修补。 [现行契约](../../specs/conversation-performance-and-scene-images.md#21-对话输入状态sse-与语音消费接口) · [结构校验](../../../backend/src/http/validation.ts#L4-L12)
