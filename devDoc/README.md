# 开发文档导航

后端改造执行依据：[26 目标架构与调整方案](26-backend-target-architecture.md)、[27 任务包与验收标准](27-backend-refactoring-work-packages.md)。建议先派发B00～B04，再进行业务服务提取；核验依据见[25 收口核验](25-backend-consolidation-review-and-plan.md)。这些是待实施方案，不代表已完成重构。

前端基础控件已统一为共享组件库，见[21 前端控件统一与验收](21-unified-frontend-components.md)。后续页面应使用公共入口及组件样式，不重复实现输入、搜索、按钮和确认弹窗。

当前SnowLuma接入方式见[20 官方手动部署与引导式接入](20-guided-external-snowluma.md)：用户自行下载、初始化并启动，应用仅连接已有服务；覆盖17号文档中的桌面管理服务自启动行为。

项目已更名为 **nowadays** 并接入新标识，见[19 品牌接入与项目改名](19-nowadays-branding.md)。旧数据原位兼容，历史文档名称保留。

最新设置交互见[18 模型设置简化与应用设置弹窗](18-simplified-model-settings.md)：文本、视觉、视频固定列表，生图和语音作为扩展；设置从主页面导航抽出到全局左下角弹窗。主页面由9个减为8个，另有设置弹窗；以下旧图集中的全页设置布局保留为历史参考。

当前设计依据：[15 账号模型与会话角色修订](15-account-models-and-conversation-roles.md)、13前端方案与14验收；[打开当前图集](design/ui-suite-v2/index.html)。结构收敛为9个主页面，模型按账号配置五类能力，群聊/私聊必须逐个绑定角色卡且无默认卡。原12页图集保留为历史风格参考。业务修复与SnowLuma手动注入继续按10及实施报告核对。

后续修订见[17 动态QQ接入与暖浅色修复](17-dynamic-qq-connection-review.md)：管理服务随应用启动、总览直接连接进程、内部实例动态增减、清理全站黑底。该修订覆盖旧文档“仅连接外部SnowLuma”的限制，QQ注入/监听仍由用户点击。上一轮[16 开发独立验收记录](16-independent-development-acceptance.md)保留为历史。

| 文件 | 用途 | 使用方式 |
| --- | --- | --- |
| [01 总体架构参考底稿](01-architecture-direction-draft.md) | 首次总体评估与长期方向 | 参考，不直接作为本阶段全量开发范围 |
| [02 需求与隔离讨论](02-scope-and-isolation-discussion.md) | 用户目标、概念边界与早期讨论 | 保留讨论背景 |
| [03 第一阶段优化方案](03-phase-1-optimization-plan.md) | 实施范围、默认决策、结构与接口要求 | 本阶段设计依据 |
| [04 第一阶段验收标准](04-phase-1-acceptance.md) | 自动化、集成、真实环境验证及发布门槛 | 逐项填写结果与证据 |
| [05 第一阶段工作包](05-phase-1-work-packages.md) | 开发任务、依赖、里程碑与分工 | 用于分配开发 |
| [06 第一阶段实施报告](06-phase-1-implementation-report.md) | 开发实现与自验记录 | 与验收标准对照 |
| [07 第一阶段代码复核](07-phase-1-code-review.md) | 独立代码复核、问题复现与修复建议 | 修复与补充验收依据 |
| [08 第一阶段复核修复](08-phase-1-review-fixes.md) | R1-R7 的修复、行为变化与回归证据 | 与 07 对照复核 |
| [09 再次复核与当前架构](09-phase-1-second-review.md) | 新边界问题、当前运行链路与改造方向 | 后续修复和分阶段规划 |
| [10 修复与手动注入集成](10-fixes-and-manual-snowluma-integration.md) | S1/S2 修复、SnowLuma 手动注入监听、工作包与验收 | 当前开发分配依据 |
| [11 设计语言与页面样板](11-design-language-direction.md) | 简约深色、关键动效、视觉规范与三页样板 | 提前设计阶段，候选方向 |
| [12 账号展示主页与工作台](12-home-showcase-and-workbench-design.md) | 温暖非黑底、QQ 签名、头像来源、Dock 交互与工作台分工 | 最新用户要求与设计依据，覆盖 11 的相关旧候选 |
| [12 第二轮修复与手动注入实施报告](12-phase-2-s1-s2-manual-injection-report.md) | FIX-A/B 与 SL-A/B/C 的实现、回归证据、验收状态与未完成项 | 与 09/10 对照复核 |
| [13 整体前端设计与实施](13-frontend-design-and-implementation.md) | 12 页布局、路由、组件、动效、接口缺口与开发工作包 | 当前前端开发分配依据 |
| [14 前端设计验收](14-frontend-design-acceptance.md) | 页面、账号隔离、操作、动效、窗口适配与 EXE 验收 | 按项记录证据 |
| [15 账号模型与会话角色修订](15-account-models-and-conversation-roles.md) | 五类模型账号级配置、设置全局服务、逐会话角色绑定与迁移 | 最新要求，覆盖旧方案冲突条目 |
| [16 开发独立验收记录](16-independent-development-acceptance.md) | 返修循环、最终222项测试与页面验证、尚未实机验收项 | 本轮开发交付与验收结论 |
| [17 动态QQ接入与暖浅色修复](17-dynamic-qq-connection-review.md) | 服务自启动、无需手动槽位、账号自动配对与视觉修复 | 最新实现与验收记录，含首次配置和实机边界 |
| [当前关键页修订图](design/ui-suite-v2/index.html) | 账号五能力、群聊/私聊角色绑定、设置全局服务 | 配合15使用，静态概念稿 |
| [原12页UI图集](design/ui-suite/index.html) | 历史视觉参考 | 旧导航、任务媒体/会话页和账号单卡结构已失效 |

03～05 是本轮制定的开发计划，不是已经实现或验收通过的声明。配置样例是目标格式，不可直接用于当前版本。

“视频 API”默认指视频理解；云端/本地模型接入已运行服务。用户自行启动 QQ，应用通过 SnowLuma 探测并在用户点击后注入和监听；已有注入仍可直接 attach。自动启动 QQ 已移出计划。世界书与长期记忆另列后续阶段。

控件外观复核见 [22 控件风格复核](22-control-style-review.md)：暖色语义色、复选框、状态标记与头像作用域修复，含实际页面截图。

目录与版本管理见 [23 仓库规范](23-repository-layout-and-version-control.md)：测试源码保留，验收截图归入本地 test-results，release 与构建产物不纳入 Git。

账号卡片识别见 [24 QQ账号与昵称展示](24-qq-account-identity-display.md)：注入前探测、连接后身份核验、PID诊断折叠和未知账号回退。

后端收口核验与后续分工见 [25 后端架构治理计划](25-backend-consolidation-review-and-plan.md)：本轮原子写入/恢复资格收口核验、两项既存并发问题及分阶段改造验收。
