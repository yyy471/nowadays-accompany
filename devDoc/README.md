# 新主线文档导航

2026-11-09。对话演出第一包通过独立离线复验，见 [216 第 6 节](216-conversation-performance-independent-review.md#6-217-第-7-节补修独立复验)。旧 IndexTTS 接口的补修在 [219](219-indextts-integration-spec.md#补修独立复验) 通过复验。DL-140 统一 TTS 后端的 v12 回填在 [222 独立复验](222-tts-unified-independent-review.md#221-第-11-节-v12-回填独立复验) 通过 v10 和旧 v11 两条升级路径，TTS 的 R01～R04 在已验范围关闭。真实服务联调待验。

角色外观与每日穿搭在 [212](212-appearance-review-fixes.md) 补修后完成[独立复验](211-appearance-independent-review.md#r01-全帧校验补修独立复验)。过场图 CG-01／CG-02 经 [227 第 7 节](227-scene-image-independent-review.md#7-228-第-10-节-r06-独立复验) 独立复验通过，R01～R06 在已验范围关闭。关系藏页按 [233](233-relations-exlibris-migration-fixes.md) 迁移后，[234](234-relations-exlibris-independent-review.md) 复核未通过的三项已按 [235](235-relations-exlibris-review-fixes.md) 修复并自验，[234 第 3 节](234-relations-exlibris-independent-review.md#3-235-修复独立复验) 原场景通过；扩展场景 EX-R04、EX-R05 已在 [235 第 7 节](235-relations-exlibris-review-fixes.md#7-234-第-3-节补充修复ex-r04ex-r05) 补修，[234 第 4 节](234-relations-exlibris-independent-review.md#4-235-第-7-节补修独立复验) 确认 EX-R01～EX-R05 在离线范围关闭。对话页的明暗切换已按 `dialogue-demo-v4` 重做为「日落刻度」，实现方自验见 [237](237-dialogue-theme-transition.md)；关系页的「明暗推进」方案效果未获认可，已整块回滚到原折页刻度。角色配置与全局设置的后端缺口按 [236](236-role-settings-backend-gap-review.md) 复核，第一包 RS-01（密钥直填、按资源探测、地址与请求边界、参考音频列表／删除、音色下架映射）已按 [241](241-role-settings-backend-rs-01.md) 完成实现方自验，[244 第 7 节](244-role-settings-independent-review.md#7-245-第-12-节补修独立复验) 确认 RS-R01～RS-R08 在各自已验离线范围关闭；外观目录导入已按 [242](242-role-appearance-folder-import.md) 在桌面端实现，声音配置页已按 [243](243-voice-settings-desktop.md) 接入连接测试、试听与参考音频管理，生图锚点与删除规则待实施。CG-03、残留文件自动清扫、真实服务和桌面对话按工作包推进。桌面前端完成后按 DL-115 恢复远程 Streamable HTTP MCP。

| 文档 | 定位与状态 |
| --- | --- |
| [244 角色配置开发进展独立复核](244-role-settings-independent-review.md) | 第 7 节复验关闭 RS-R08，RS-R01～RS-R08 在各自已验离线范围关闭 |
| [241 角色配置后端第一包（RS-01）](241-role-settings-backend-rs-01.md) | 密钥只写存储与统一解析、按资源探测与结果过期、地址与请求边界、参考音频列表／删除、音色下架映射；实现方自验见 241，独立发现见 244 |
| [242 角色外观目录导入（AI-01）](242-role-appearance-folder-import.md) | `standees`／`expressions` 识别、导入预览、跨目录手动归并与结果汇总，`outfits` 锚点与说明文件跳过；桌面端 67 项测试与类型检查、构建通过 |
| [243 声音配置页接入（VS-01）](243-voice-settings-desktop.md) | 连接测试、试听、参考音频上传／列表／删除、预置音色下架提示与按能力校验；桌面端 81 项测试与类型检查、构建通过 |
| [245 244 复核问题修复记录](245-role-settings-review-fixes.md) | 第 1～8 节为 RS-R01～RS-R05 首轮修复，第 9 节补修扩展场景（引用凭据、音色随服务失效、卸载后作废、忙碌状态归属），第 10 节补修换服务时参考模式失效，第 11 节补修能力来源顺序与不支持来源拒绝，第 12 节让请求与校验共用同一份能力声明；后端 301 项、桌面 89 项与 21 步离线验收通过 |
| [240 关系页顶部栏精简](240-relations-header-removal.md) | 移除关系页顶部标题栏，按用户澄清将日夜装饰条移入书页右上方；实现方自验，待独立复核 |
| [239 对话页 Dock 显示设置](239-dialogue-dock-visibility.md) | 对话页可隐藏底部导航、其他页面保留导航及本地偏好；实现方自验，待独立复核 |
| [238 对话页顶部精简与布局调整](238-dialogue-layout-refinement.md) | 对话框内工具图标、舞台上移和移除全局顶部设置入口；实现方自验，待独立复核 |
| [237 对话页明暗切换（关系页推进方案已回滚）](237-dialogue-theme-transition.md) | 对话页照 v4 参考实现舞台光线 + 纸面 14 档逐行推进；关系页快照推进方案经用户判定效果不对，已回滚到原折页刻度并复验无残留；实现方自验，独立复核待执行 |
| [236 角色配置与全局设置后端缺口复核](236-role-settings-backend-gap-review.md) | 对照现有接口核对附件，区分首版接入项、补齐项和后续能力；第一包实施进展见第 7 节与 241 |
| [235 关系藏页复核修复记录](235-relations-exlibris-review-fixes.md) | EX-R01～EX-R03 的修复与实现方自验，第 7 节补修 EX-R04／EX-R05；独立结论见 234 第 3～4 节 |
| [234 关系藏页迁移独立复核](234-relations-exlibris-independent-review.md) | 第 4 节确认 EX-R01～EX-R05 在离线范围关闭，真实数据联调待验 |
| [233 关系藏页原型对照与迁移修复](233-relations-exlibris-migration-fixes.md) | 对照用户提供的关系页原型，修复布局、主题、交互和资料读取，独立结论见 234 |
| [232 桌面对话 231 复核修复记录](232-conversation-desktop-review-fixes.md) | FE-R01～FE-R04 修复与离线自验，独立结论见 231 第 4 节 |
| [231 桌面对话页独立复核](231-conversation-desktop-independent-review.md) | 53 项桌面测试、10 组浏览器场景通过，FE-R01～FE-R04 在离线范围关闭 |
| [229 桌面对话页第一包实施记录](229-conversation-desktop-fe-01-record.md) | FE-01 页面装配、演出状态、演示语音与历史面板的实现方自验；当前接入与复核见 230、231 |
| [228 过场图复核修复记录](228-scene-image-review-fixes.md) | R01～R06 的实现方修复与自验，独立结论见 227 第 7 节 |
| [227 过场图后端独立复核](227-scene-image-independent-review.md) | CG-01／CG-02 离线范围通过，R01～R06 关闭 |
| [226 生成过场图第二包实施记录](226-scene-image-cg-02-record.md) | CG-02 模型规划、上下文与服饰参考素材、生成超时与重试的实现方自验；独立结论见 227 |
| [225 桌面对话页开发文档](225-conversation-desktop-development-guide.md) | v5 交互原型、正式前端分期、消息与媒体契约、验收清单 |
| [224 生成过场图第一包实施记录](224-scene-image-cg-01-record.md) | CG-01 任务与读取契约、v13 存储、假规划与假生成器、失败重试与重连的实现方自验；独立结论见 227 |
| [223 对话演出开发文档](223-conversation-performance-development-guide.md) | 213 的实现现状、过场图后端工作包与契约草案、待决策项、桌面与真实联调排期 |
| [222 TTS 统一接入独立复核](222-tts-unified-independent-review.md) | R01～R04 在已验范围关闭，v10 和旧 v11 升级到 v12 通过，真实语音服务待联调 |
| [221 TTS 统一接入首轮实施记录](221-tts-unified-implementation.md) | 能力探测、克隆／预置音色、multipart 合成、v10→v12 迁移与旧配置兼容；第 7～11 节记录 222 修复 |
| [220 TTS 统一接入说明](220-tts-unified-integration.md) | 音色克隆与预置音色共用的配置流程、服务接口、后端迁移和验收，已按 221 完成首轮后端实施 |
| [219 首版 IndexTTS 接入规范与独立复核](219-indextts-integration-spec.md) | R01～R03 及补修通过独立离线复验，真实桥接待联调 |
| [218 TTS 与角色音色首轮实施记录](218-tts-implementation-record.md) | IndexTTS 本地 HTTP、参考音频导入、试听与按句合成、v9 存储；第 7 节记录 219 R01～R03 修复与自验 |
| [217 对话演出第一包复核修复记录](217-conversation-performance-review-fixes.md) | R01～R04 的修复与实现方自验，最终独立结论见 216 第 6 节 |
| [216 对话演出第一包独立复核](216-conversation-performance-independent-review.md) | 离线回归和 v7 样例迁移通过，R01～R04 在已验范围关闭 |
| [215 对话演出第一包实施记录](215-conversation-segments-implementation.md) | 回复句段、快照、晚到表情标注与 v8 存储的实现方自验；历史结论见 216、217 |
| [214 关系藏页接入记录](214-relationship-exlibris-page.md) | 关系页改为人物藏书票与经历、日记、介绍；资料维护留在设置 |
| [213 对话演出后端方案](213-conversation-performance-backend-plan.md) | DL-137／DL-138 的回复消息设计、三条演出链路、句段契约和后端接口提案 |
| [212 211 外观复核 R01～R03 修复记录](212-appearance-review-fixes.md) | 图片全帧解码、状态版本门和图片与服饰名同步的实现方证据；独立结论见 211 |
| [211 角色外观与每日穿搭独立复核](211-appearance-independent-review.md) | 统一离线验收、真实原图与 Agent 链路通过。R01～R03 在已复验范围关闭 |
| [210 角色外观导入与每日穿搭首轮实施记录](210-appearance-implementation-record.md) | 衣柜存储、图片导入读图、Agent 穿搭状态、桌面入口与主页立绘的实现方自验；对话演出待实施 |
| [209 Agent 每日穿搭开发文档](209-agent-daily-outfit-development-guide.md) | DL-136 的穿搭决策时机、角色状态提交、主页与对话刷新及验收；首轮实施见 210，对话同步待实施 |
| [208 角色外观导入与对话立绘接入](208-character-appearance-import-and-dialogue.md) | DL-136 的用户图片规范、素材登记接口、桌面接入与验收；首轮实施见 210，对话立绘待实施 |
| [207 桌面前端四页重做记录](207-desktop-four-page-rebuild.md) | DL-135 的四页范围、主页与关系页实现及本机自验记录 |
| [230 桌面对话 FE-02 接入进展](230-conversation-desktop-fe-02-progress.md) | 窗口接入、历史分页定位、舞台与语音补修及离线自验；独立复核见 231 |
| [206 桌面主页精简、环境流转与角色外观入口](206-desktop-home-scene-and-role-visual-plan.md) | DL-132～DL-134 的历史前端方案与实现方自验，当前页面范围按 DL-135 |
| [205 光影书房与器物剧场前端重构计划](205-luminary-study-theater-frontend-plan.md) | `dev-front` 分支重构方案：单舞台双焦距、全屏五层光影流转与信笺／手账／胶片／推演四大器物转场 |
| [204 书桌 v0.1.2 原生窗口与天气细化](204-desktop-desk-window-weather-refinement.md) | 原生窗口、独立受光玩偶、画室拍立得、分层雨雪和室内外风动 |
| [203 书桌 v0.1.1 窗口与场景细化](203-desktop-desk-window-and-art-refinement.md) | dev 品牌图标、满幅窗口、书脊和场景重渲染及本机验证 |
| [202 书桌 Windows 前端初版](202-desktop-desk-windows-v1.md) | Windows x64 便携 EXE、物件交互、本地时间和四季天气，含本机实现方验证 |
| [201 桌面书桌首版样机实施记录](201-desktop-desk-preview-record.md) | FE-01、FE-02 的可运行离线样机、光照资产与实现方自验，待画面评审和独立复核 |
| [200 桌面前端开发与视觉优化计划](200-desktop-frontend-development-plan.md) | DL-131 的实施计划草案，覆盖书桌美术基准、环境分层、对话与角色切换、本地 API 联调和桌面交付 |
| [199 首轮后端功能缺口复核修复记录](199-p5-gaps-review-fix-record.md) | R01～R06 实现方修复、自验及 R01 两轮补修。后续独立结论见 198 |
| [198 首轮后端功能缺口独立复核](198-p5-capability-gaps-independent-review.md) | 统一离线验收 21 步通过，R01 提交前与提交后恢复均通过，R01～R06 在本机离线范围关闭 |
| [197 首轮后端功能缺口实施与自验记录](197-p5-capability-gaps-implementation-record.md) | GAP-01～GAP-06 实现、接管修复与自验证据；192 项测试及统一离线验收 21 步通过；其后 198 复核未通过，修复见 199 |
| [196 首轮后端功能缺口与补齐计划](196-backend-capability-gap-plan.md) | 六项首轮缺口、角色清单准备，以及待确认的管理与体验候选和同类功能排查；六项已实施并通过本机离线独立复核 |
| [195 P5 后端原型整体独立复核](195-p5-independent-review.md) | 整体复核通过，15 步、59 个业务场景与 4 项验收故障契约通过，首轮本机后端源码原型收口 |
| [194 P5 后端原型交付与自验记录](194-p5-prototype-delivery-record.md) | 保留 15 步实现方自验；后续整体独立复核已由 195 通过，P5 首轮原型范围收口 |
| [193 P5 后端原型复核与交付开发文档](193-p5-prototype-delivery-guide.md) | P5 范围、交付与证据规则；P5-01～P5-05 已由自验及 195 后续独立复核完成 |
| [192 产品介绍：视觉风格与设计语言探索](192-product-introduction-for-visual-direction.md) | 面向外部 AI 的简要产品背景，概括主体、功能与设计探索目标；不固定视觉方向或页面原型 |
| [191 P4 恢复缺口修复记录](191-p4-recovery-fix-record.md) | 第 10 节最终补修自验及第 11 节用户接受收口保留；最后补修已获 195 后续独立复验 |
| [190 P4 恢复、执行真实性与规则组合验收报告](190-p4-recovery-acceptance-report.md) | 第 13 节用户确认 P4 收口，进入 P5；最终补修为自验，历史独立结论和未验证范围保留 |
| [189 P3 独立复核修复记录](189-p3-independent-review-fix-record.md) | 历史修复与自验保留；188 第 7 节已独立复验通过，P3-R01～R06 关闭，142 项回归及 11 个边界场景通过 |
| [188 P3 自主安排、唤醒与额度独立复核](188-p3-independent-review.md) | 第 7 节最终通过：142 项回归、11 个边界场景，P3 六项关闭；离线复核通过，未提交、未推送，真实 P3 与后续阶段另验 |
| [187 P3 自主安排、唤醒与额度实施记录](187-p3-autonomy-implementation-record.md) | 首轮 119 项回归与 14 项 P3 专项自验保留；复核缺口与修复见 188、189 |
| [186 P3 自主推进开发文档](186-p3-autonomy-development-guide.md) | P3 范围、工作包、存储／额度／唤醒／工具／API 工程契约与验收矩阵；工程稿不构成新增用户决定 |
| [185 P2-06 R05／R09 阻断修复记录](185-p2-06-r05-r09-fix-record.md) | 实现方修复与 105 项自验保留；R05／R09 已由 184 第 7 节独立复验关闭，真实形成／召回已补齐 |
| [184 P2-06 阶段验收报告](184-p2-06-acceptance-report.md) | 第 7 节最终通过：105 项回归、20 个离线及 4 项真实复验，R01～R09 关闭；P2 首轮后端范围收口，可进入 P3；首轮失败证据保留 |
| [183 P2-05 复核问题修复记录](183-p2-05-review-fix-record.md) | 历史修复自验保留；第 12 节模型停用续行补正已通过 182 第 6 节复验；新真实验收阻断见 184 |
| [182 P2-05 独立开发复核](182-p2-05-independent-review.md) | 历次问题与复验记录；R01～R09 最终关闭，R05／R09 真实复验与 P2 收口见 184 第 7 节 |
| [161 数字生命方向与持续决策](161-digital-life-direction-decisions.md) | 用户逐项确认的需求与修订，当前记录至 DL-136，含角色自主选择服饰与素材导入 |
| [162 首轮后端原型实施方案](162-backend-prototype-implementation-plan.md) | R1～R64 已确认，首轮实施基线已定；P0 已实施并自验，后续工程契约按阶段落实 |
| [163 设计与方案一致性核对](163-design-consistency-review.md) | 本轮文档核对，记录已修正遗漏、需求覆盖、未采用底稿条款和剩余待讨论问题；非运行验收或独立复核 |
| [164 首轮后端原型执行清单](164-backend-prototype-execution-checklist.md) | R64／DL-129 确认的阶段入口；P0、P1 已通过，P2-01 契约已建立 |
| [165 后端开发文档：P0 技术小样](165-backend-development-guide.md) | 面向实施的工作包、最小职责、验收用例与证据模板；已补充实际运行命令与自验状态 |
| [166 P0 技术小样实施记录](166-p0-implementation-record.md) | P0-01～P0-04 实现、实际版本、运行证据、自验结论与限制；已追加 R01～R04 及 168 的 L01／L03／L06 修正与复验记录 |
| [167 P0 独立复核记录](167-p0-independent-review.md) | 保留首轮问题及修正后独立证据；37 项检查、5 个原场景及 4 个真实强杀场景通过，R01～R04 已关闭 |
| [168 P0 复验遗留修复清单](168-p0-followup-fix-list.md) | 第 2～6 节保留 9 项原始意见，第 7 节为逐项核对；L01、L03、L06 已修正并通过独立复核，L02／L04／L05／L07／L08／L09 不修改实现或留待 P1／P4 |
| [169 P1 开发文档：角色、存储与资源配置](169-p1-role-storage-development-guide.md) | P1 范围、数据／API 契约草案、6 个工作包与离线验收；契约已由 170 固定，P1-02～P1-05 已自验，工程草案不作为新增用户决定 |
| [170 P1-01 角色与存储工程契约](170-p1-01-contract.md) | 固定目录、appRoot、schema、初始化、HTTP／CLI、错误、凭据策略及验收边界；P1-02～P1-05 已按此实现 |
| [171 P1 实施记录](171-p1-implementation-record.md) | 实现方证据及历史轮次分别保留；P1-01～P1-06 完成，最新独立结论见 172 第 12 节 |
| [172 P1 独立开发复核](172-p1-independent-review.md) | 历次问题及修正、独立证据；第 12 节最终通过，13 个测试及三组共 13 个场景通过 |
| [173 P2 开发文档](173-p2-memory-agent-development-guide.md) | 完整记忆、检索维护、Agent 对话、模型和本地扩展的范围与工作包；P2-01 契约已由 174 固定 |
| [174 P2-01 事件记忆与对话执行契约](174-p2-01-memory-agent-contract.md) | 固定业务库 v2／迁移、证据与批次、事件／摘要／日记、检索召回、SSE、模型端口、API／CLI、中文样例与验收 |
| [175 P2-02 记忆形成与保存实施记录](175-p2-02-memory-formation-record.md) | 迁移、证据、触发、分批分段、离线整理、事件索引、defer、失败退避与 18 项用例；实现方自验，待独立复核 |
| [176 P2-03 检索、维护与主观记忆实施记录](176-p2-03-memory-query-record.md) | 中文检索、证据追溯、召回统计、100 轮精炼、事件／摘要纠错、日记 Markdown、HTTP／CLI 与 11 项用例；实现方自验，待独立复核 |
| [177 P2-04 模型与本地扩展实施记录](177-p2-04-model-extension-record.md) | 原实现方证据保留；本地离线范围已通过 178 第 6 节独立复验 |
| [178 P2-04 及前置工作包独立复核](178-p2-04-independent-review.md) | 首轮失败及补修证据保留；第 6 节最终通过，R01～R06 关闭，58 项回归与 27 个复验场景通过 |
| [179 P2-04 复核问题修复记录](179-p2-04-review-fix-record.md) | 实施方六项修正、完整续轮和空终态回退的自验；已通过 178 第 6 节独立复验 |
| [180 P2-05 Agent 对话联动实施记录](180-p2-05-agent-conversation-record.md) | 历史 77 项实施方自验保留；独立复验问题已关闭，完整 P2 最终证据见 184 第 7 节 |
| [181 P2-06 全量验收自验矩阵（草案）](181-p2-06-self-acceptance-matrix.md) | 历史实施方测试映射保留；P2 最终独立复验与真实联调通过范围见 184 第 7 节，后续阶段继续另验 |
| [用户参考底稿](design/digital-life/langgraph-roleplay-engine-v2.reference.md) | 原样保存的参考材料，未整体采纳 |

旧项目的完整设计时间线、代码和验收记录保留在 `dev` 分支。它们可以作为参考，不直接构成新主线的兼容要求或验收证据。

新旧分支布局保持：`dev` 保留旧代码与历史，`master` 保存既有设计基线。P0、P1 在各自本地开发分支完成独立复验；本轮将 P1 源码、记录及 P2 准备稿纳入用户要求的本地提交，不推送或合并。具体源码版本以包含本记录的 Git 提交为准。
