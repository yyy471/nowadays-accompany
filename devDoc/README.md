# 开发文档导航

最新独立复验见[101 EXT-G修复独立复验](101-ext-g-fixes-independent-recheck.md)：99-R1～R4均关闭，未发现新增阻塞问题，EXT-G在本地自动化与代码复核范围内通过。主进程独立全量118文件1101项通过/1项既有跳过，原4项探针与真实Core往返通过，类型检查、桌面构建与空白检查通过。可进入EXT-H的真实服务、原生界面和发行包验收；未提交、推送或打包。

最新修复见[100 EXT-G复核修复](100-ext-g-review-fixes.md)：99号R1～R4（重载覆盖草稿、Skill隐式启用、编辑会话旧草稿配新revision、历史握手误判就绪）已修复；Skill新建/复制默认关闭、私有定义可保留默认关闭，刷新拆分为运行状态/目录且硬刷新保护全部草稿。慢钩子fixture保留生产500ms/2s契约并增加余量与失败证据。定向8文件84项、全量连续三次118文件1101项通过/1项既有跳过，类型检查、桌面构建与空白检查通过。属实现方自验，待独立复验；未提交、打包或替换EXE。

最新独立复核见[99 EXT-G复核与修复要求](99-ext-g-independent-review.md)：暂不通过，发现重载丢弃草稿、编辑停用公用Skill时隐式启用、旧草稿携带刷新后revision覆盖新值三项P1，以及历史握手状态误报当前就绪一项P2。类型检查、桌面构建、定向72项通过；独立全量1088通过/1失败/1既有跳过，保留钩子时限失败待查。99号结论以100号修复与后续复验为准；98号记录保留为实现方自验。

最新执行记录见[98 EXT-G页面闭环](98-ext-g-page-closure-execution.md)：扩展策略HTTP、插件与Skill页面、资源库公用Skill、按会话有效状态、草稿/失败态与旧入口清理已实现，E05真实Core闭环通过；其中私有定义enabled、刷新入口和全量数字以100号为准。

最终独立复验见[97 EXT-E/F修复收口](97-ext-e-f-final-independent-recheck.md)：95-R3异步等待与95-R4超时原因竞争均关闭，原预算/选择状态探针保持通过。主进程全量113文件1078项通过/1项既有跳过，4项独立探针、完整类型检查、桌面构建及空白检查通过；本地自动化范围内EXT-E/F可收口，下一阶段为EXT-G策略路由与页面。未提交、推送或打包，真实服务与原生交互仍待验收。

最新主进程复核见[93 EXT-E/F复核](93-ext-e-f-independent-review.md)、[94 修复记录](94-ext-ef-review-fixes.md)与[95 复验](95-ext-e-f-fixes-independent-recheck.md)/[96 修复](96-ext-ef-recheck-fixes.md)：EXT-E 媒体补证在本地自动化范围内成立；EXT-F 的 R1（非工具模型 Skill 撑破实际请求）、R2（能力接口缺少选择状态）、R3（host 测试等待边界）与 95-R4（超时原因码竞争）已修复，95-R3（异步 wait 未 await）也已关闭。EXT-F 的 Skill 服务实现见[92](92-ext-f-skill-service-execution.md)：多来源解析与私有覆盖、公用/私有CRUD与复制、CAS、删除影响、只读预览、名称/正文/工具/16000预算及统一注入；预览与运行共用同一选择函数，运行时按实际序列化请求收紧。修复后类型检查、定向45项、全量连续两次113文件1078项通过/1项既有跳过、桌面构建均通过。策略开关的HTTP路由与页面仍在EXT-G。

EXT-E 媒体验收补证见[91 EXT-E内置媒体迁移](91-ext-e-builtin-media-execution.md)：媒体工具迁移已在 D-C 落地，本包补齐 M01（submitted+jobId，图像与语音）、M02（宿主调用键幂等与跨消息独立）、M03（语音通道未知、生成中暂停、撤权/角色变化不交付）证据，并为测试假通道增加 `voiceDeliverySupport` 选项。类型检查通过、新用例 4/4、全量 111 文件 1050 项通过 1 跳过。本包只动测试与假通道；独立复核见[93](93-ext-e-f-independent-review.md)，已在本地自动化范围成立。

最新主进程验收见[90 EXT-D独立复核](90-ext-d-independent-review.md)，实现见[89 D-D/D-E执行](89-ext-d-hooks-execution.md)，原始端到端失败及修复见[89a E2E证据](89a-ext-d-e2e-evidence.md)。已接通带来源 beforeContext、真实发送结果 afterTurn、500ms/2s钩子预算与会话扩展快照；补修同会话媒体误去重、原子重试撤权、挂起档案关闭、配置换代和Worker迟到执行。冻结后主进程定向138项、全量110文件1046项通过/1项既有跳过，类型检查、桌面构建与diff检查通过。范围限本地自动化，未提交、未打包、未替换EXE；EXT-E/F/G/H及真实服务验收仍按79/80推进。

上一轮[87 D-A～D-C执行](87-ext-d-agent-composition-execution.md)保留单一回复宿主、assistant/tool协议与统一执行器的原始证据；其“D-D/D-E未做”以及按provider callId/会话去重、关闭等待账号同步链的表述由89/90中的实现和复验取代。原子写重试提交guard的补修另见[88](88-atomic-retry-guard-fix.md)。

上一次主进程独立复核见[86 EXT-C修复独立复核](86-ext-c-fixes-independent-review.md)，子代理实现见[85 修复记录](85-ext-a-c-remediation.md)：原5项及复核追加的submitted、完整工具授权、在途unknown、软覆盖边界已关闭；主进程反向脚本全部通过、定向98/98通过、类型与构建通过。原始全量1000通过、1跳过、1记忆提取E2E等待超时，不能宣称项目整体全绿；需保留稳定性待查。

历史执行记录见[85 EXT-A～C复核修复](85-ext-a-c-remediation.md)：FIX1～5及授权边界修复完成；定向78项、类型检查、桌面构建通过。主进程最终全量105/106文件通过，1000项通过、1项跳过，唯一失败为memory runtime E2E的waitFor超时；EXT runtime 37项全通过。记忆链路失败保留且有单文件复跑证据，本轮未实施EXT-D，未提交、打包或替换EXE。

问题来源见[84 EXT-A～C独立复核](84-ext-a-c-independent-review.md)：修复前离线复现5项P1并给出FIX1～5要求；实际实现与验证以85号记录为准。

下一阶段执行依据：[79 Agent主体、统一工具与扩展作用域方案](79-agent-extension-execution-plan.md)、[80 验收标准](80-agent-extension-acceptance.md)。落实阶段回顾第2/3/4项；用户明确无旧插件，采用单一协议和Agent编排，清理互斥回复模式；按EXT-A～H实施，覆盖统一执行、插件Worker、群私聊授权、Skill管理及页面闭环。记忆管理页面明确后置，具体浏览工具不在本轮范围。当前为待实施方案。

最新独立复验见[78 MEM03修复独立复验](78-memory-extraction-fixes-independent-review.md)：76号R1/R2两项P1通过，相同完整链路复现确认长文本水位推进、提取单次调用后冷却；最终原始全量916项通过、1项既有跳过，类型检查及桌面构建通过。但本次前两次全量分别出现O09/E2E水位等待超时，后续未再现，保留M3-VERIFY1稳定性/诊断待查；77号无保留收口结论需收窄，不能忽略之前失败。未改生产代码、未提交或打包。

最新修复与复验见[77 MEM03复核修复](77-memory-extraction-review-fixes.md)：76号R1（字符预算与六条门槛冲突导致长文本永久停滞）与R2（提取继承Provider自动重试/回退）已修复；准入计数与批次分离、有界续扫不重读旧前缀、提取固定单次调用且无fallback。102文件、916项通过、1项既有跳过，类型检查、桌面构建和diff检查通过。MEM03自动提取可收口；摘要、MEM04管理页面、真实QQ/付费服务仍待实施或验收，未提交/打包/更新发行包。

最近独立复核见[76 MEM03复核与修复计划](76-memory-extraction-independent-review.md)：曾以完整链路复现上述两项P1并暂缓收口；R1/R2已由77号关闭。76号未改生产代码、未提交或打包。

最新执行与验收见[75 MEM03自动提取](75-memory-extraction-execution.md)：显式激活、删除暂停/重激活边界、有界输入与续扫、协调器/配额/单次调用/冷却/退出、严格输出、同文件原子提交与会话队列顺序已完成；首轮复核的并发裁剪切页与空文本积压、76号R1/R2均已修复。102文件、916项通过、1项既有跳过，类型检查、桌面构建和diff检查通过。摘要生成、MEM04管理页面、真实QQ/付费服务仍待实施或验收，未提交/打包/更新发行包。

MEM03方案与验收依据为[73 可选自动提取方案](73-memory-extraction-implementation-plan.md)、[74 详细验收](74-memory-extraction-acceptance.md)：旧autoExtract=true不静默付费，首轮仅fact，不含summary/页面/遗忘曲线。

最新独立复验见[72 MEM02修复复核](72-memory-runtime-fixes-independent-review.md)：70号R1/R2通过，旧轮工具准入与OR缓存遍历已修复；93文件、833项通过、1项既有跳过，类型检查及构建通过。MEM02可收口。

最新修复与复验见[71 MEM02复核修复](71-memory-runtime-review-fixes.md)：70号R1（工具执行前未携带本轮memory guard）与R2（耗尽后提前break遗漏OR缓存命中）已修复；新增旧响应工具调用、排队job、Provider已开始、其他scope/回执重放及缓存遍历回归。93文件、833项通过、1项既有跳过，类型检查和桌面构建通过。MEM02可收口；自动提取、摘要、记忆页面与真实QQ/付费服务仍待实施，未提交/打包/更新发行包。

上一轮独立复核见[70 MEM02复核与修复要求](70-memory-runtime-independent-review.md)：曾复现P1旧记忆轮次仍可执行生图、P2计算耗尽后漏掉后续OR缓存命中；R1/R2已由71号关闭，70号“暂不完全通过”结论以71号复验为准。

上一阶段执行与验收见[69 MEM02检索、预览与Agent运行链路](69-memory-retrieval-runtime-execution.md)：纯选择器、只读预览、不可变记忆快照、上下文预算与最终发送guard已完成，R01～R09/P01～P08/C01～C09/G01～G07通过；70号复核项以71号修复结果为准。

上一阶段方案与验收为[67 检索、预览与Agent运行链路](67-memory-retrieval-runtime-implementation-plan.md)、[68 详细验收](68-memory-retrieval-runtime-acceptance.md)。

最新独立复验见[66 MEM01修复复核](66-memory-management-fixes-independent-review.md)：64号R1/R2通过，R3按65号逻辑提交点约定通过，781项通过、1项既有跳过，类型检查和构建通过；MEM01管理存储可收口，下一步MEM02-A/B检索预览与Agent快照/发送guard。跨文件物理原子性未承诺，记忆页面与自动提取仍待实施。

最新独立复核见[64 MEM01复核与修复要求](64-memory-management-independent-review.md)：776项基线通过、1项既有跳过，类型检查和构建通过；但已复现原请求重试被CAS提前拒绝、合法字段组合写出超过读取上限的文件、等待中角色变化后仍提交旧scope三项P1。MEM01暂未通过，先执行MEM-FIX1～3，再进入MEM02；63号全部通过结论以64号收窄。

最新独立复验见[60 加载修复复核](60-worldbook-loading-fix-independent-review.md)：58号P2已关闭，758项通过、1项既有跳过，类型检查与构建通过，本轮未发现新的阻塞项。下一阶段MEM00设计见[61 长期记忆实现方案](61-memory-foundation-implementation-plan.md)、[62 详细验收标准](62-memory-foundation-acceptance.md)，下一可派发包为MEM01-A/B手工记忆Store/API；原生/视觉/真实QQ仍独立待验收。

最新修复见[65 MEM01复核修复](65-memory-management-review-fixes.md)：64号R1～R3（回执先于CAS、实际落盘字节上限、提交前角色作用域复验）已修复；87文件、781项通过、1项既有跳过，类型检查与构建通过。MEM01管理存储可重新收口，但记忆仍未注入Agent、未检索/提取、无管理界面，MEM02～MEM04待实施；未提交或更新发行包。

上一轮执行见[63 长期记忆管理存储](63-memory-foundation-execution.md)：MEM01-A/B已完成，S01～S12通过；87文件、776项通过、1项既有跳过，类型检查与构建通过。受64/65号影响的条目以65号为准。

上一轮复验见[59 详情加载状态修复](59-worldbook-detail-loading-execution.md)：58号P2已修复，详情请求在锁定/隐藏/身份变化作废时立即结束加载，恢复时按当前来源启动新ticket，旧响应不能清除新请求；补4项正式回归后85文件、758项通过、1项既有跳过，类型检查与构建通过。原生/视觉/真实QQ仍待验收，未提交或更新发行包。

上一轮独立复核见[58 修复复核](58-worldbook-ui-fixes-independent-review.md)：56号R1～R4已修复并通过复核；其中记录的P2按59号关闭。

最新独立复核见[56 世界书页面复核与修复计划](56-worldbook-ui-independent-review.md)：744项基线通过、1项既有跳过，类型检查/构建通过；但复现编辑器卸载旧回调仍保存、异步来源覆盖后续选择，另有分页和副本身份问题。本轮暂不完全通过，先执行UI-FIX1～3再复验；55号相关自验结论以56号收窄。

WB04/WB05世界书编辑器、草稿试算与逐会话来源已完成；56号独立复核发现的R1～R4（卸载旧回调、来源意图竞态、选书分页、副本语义）已在[57 修复与复验记录](57-worldbook-ui-review-fixes.md)关闭：85文件、754项通过、1项既有跳过，类型检查与桌面构建通过；真实浏览器结构链路复核通过，Electron原生/视觉缩放/真实QQ与付费服务待验收。下一步按[53 实现计划](53-remaining-development-implementation-plan.md)进入长期记忆（MEM00起），验收继续对照[54 标准](54-remaining-development-acceptance.md)。本轮未提交、未打包、未更新发行包。

WB03会话来源与实际Agent链路已接通，见[52 执行与验收记录](52-worldbook-conversation-runtime-execution.md)：来源/参数一次CAS保存，固定版本与本轮书快照，guard拦截版本切换/外部改写/缺失的旧回复，保留同角色历史，禁用可恢复。726项通过、1项既有跳过，类型检查及构建通过；下一步WB04编辑器、WB05会话选书，再做WB06完整验收，未提交/更新发行包。

WB02资源服务已实现，见[51 执行与验收记录](51-worldbook-resource-service-execution.md)：固定版本列表/详情、不可变创建/派生、跨重试请求绑定、受控JSON导入与桌面桥接，共用发布原语，不改catalog或会话。717项通过、1项既有跳过，类型检查及桌面构建通过。页面编辑器和Agent独立来源尚未接通；下一步WB03，原生选择器待实机验收，未提交/更新发行包。

最新边界修复与接管记录见[50 修复复核](50-worldbook-boundary-fixes-review.md)：来源假成功已改为明确拒绝，新kind展示、原生manifest校验与固定版本入口已修正；补修目录名、有界读取/链接检查、输入对象副作用，并增加回归。706项通过、1项既有跳过，类型检查与构建通过。FIX-WB1/WB2已收口；独立世界书整体尚未完成，下一步按49号执行WB02资源服务。

独立世界书首轮代码复核见[48 复核结果](48-independent-worldbook-code-review.md)：当前主要完成领域契约，693项通过、1项既有跳过，类型检查和构建通过，但资源服务、独立来源运行时和编辑器尚未接通，阶段未验收。下一轮按[49 修复与剩余实现任务](49-independent-worldbook-remediation-plan.md)先修来源提交假成功及新kind误展示，再补齐WB02～WB06；暂不推进长期记忆。

下一阶段完整派发依据已整理：[46 独立世界书与条目管理实现方案](46-independent-worldbook-implementation-plan.md)、[47 完整验收标准](47-independent-worldbook-acceptance.md)。覆盖资源版本、导入编辑、逐会话来源、运行时边界、失败恢复、WB01～WB06任务包与逐项验收；当前为待实施方案，不包含长期记忆开发。

世界书基础阶段已完成，见[45 实现与验收记录](45-worldbook-foundation-review.md)，方案见[44 基础方案](44-worldbook-foundation-plan.md)：角色卡世界书转换、逐群聊/私聊独立启用、受预算约束的上下文注入与只读关键词测试。663项通过、1项既有权限相关跳过，类型检查及桌面构建通过；独立世界书编辑与长期记忆未实现，未提交或更新发行包。

酒馆角色卡基础转换见[43 酒馆JSON/PNG导入](43-tavern-card-import.md)：V1/V2、PNG chara、原文件归档、纯文本预览与兼容性提示，沿用不自动部署/逐会话绑定。该轮559项通过、1项权限跳过；世界书后续实现以45号记录为准。V3、开场白自动发送与完整宏运行时未实现；原生选择器待实机验收。

阶段E首轮收口见[42 布局与可访问性](42-stage-e-layout-and-accessibility.md)：Dock键盘/稳定放大、公共弹窗焦点、主页矮窗口裁切与缩放适配已修复；有真实隔离浏览器的窗口/键盘/滚动验证。477项通过、1项权限跳过，类型检查与桌面构建通过。Electron原生选择器、托盘及Windows实际缩放仍待实机验收，未更新发行包。

最新实现与自动验收见[41 并发写入修复与阶段D集成验收](41-storage-fix-and-stage-d-review.md)：此前Windows并发rename失败已修复，资源目录选择/预览/导入已接通；最终473项通过、1项权限相关跳过，类型检查与桌面构建通过。资源格式与使用样例见[40 资源导入执行记录](40-stage-d-artifact-import.md)。未提交、未更新发行包，原生窗口与布局实机验收待完成。

阶段 C 设置与模型服务管理已实现，集成复核见[39 阶段C集成复核](39-stage-c-integration-review.md)，分任务记录见[37 设置壳](37-stage-c-settings-execution.md)、[38 模型管理](38-stage-c-models-execution.md)。类型检查、桌面构建及26项定向回归通过；全量424项中423通过，既有Windows原子写入并发测试EPERM待独立修复。未更新发行包，实机验收待完成。历史条目中的“待实施”以39号最新状态为准。

草稿保护实现及返修记录见[36 草稿保护独立复核](36-draft-protection-independent-review.md)：最新第7节记录退出Portal冻结、响应拒绝与ACK后失联的直接修复，404项测试通过；Electron实机验收仍待完成。

下一阶段实施依据见[35 入口收尾与统一草稿保护](35-navigation-draft-protection-plan.md)：限定A收尾与B草稿保护，包含统一登记/导航准入、各编辑器接入、托盘隐藏与真实退出的区别、任务包和验收标准；这是待实施方案。

前端首批调整的独立复核与后续派发计划见[34 前端独立复核与后续计划](34-frontend-independent-review-and-next-plan.md)：列出账号上下文、请求状态与重新读取反馈的返修项，以及草稿保护、设置管理和资源导入的分阶段验收。阶段A及第二轮F4返修已完成，执行记录见33号第10节。

后端改造执行依据：[26 目标架构与调整方案](26-backend-target-architecture.md)、[27 任务包与验收标准](27-backend-refactoring-work-packages.md)；核验依据见[25 收口核验](25-backend-consolidation-review-and-plan.md)。B01～B11 已按顺序实现，执行记录与验证证据见[30 后端改造执行报告](30-backend-refactoring-execution-report.md)；独立复核与返修结果见31号记录，真实环境验收未包含在内。

当前前端的逐页用户操作体验分析见[32 前端用户操作体验分析](32-frontend-ux-review.md)：包含页面评级、首次使用路径、横向文案／状态／布局问题与优先级建议；仅分析，未修改代码。对应的修复工作包、依赖与验收标准见[33 前端体验修复方案](33-frontend-ux-remediation-plan.md)，其中记录了 2026-10-23 的首批实现（U0、U1、U3.1–U3.3 与部分 U5）及阶段A返修（F1～F3、展示资料首载保护、插件合并纯函数）；资源导入、设置拆分、模型服务管理、统一导航dirty保护和视觉收口仍延后，改动未提交且未包含真实环境验收。后端重构的独立复核记录见[31 后端重构独立复核](31-backend-refactoring-independent-review.md)。

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
| [79 Agent与扩展执行方案](79-agent-extension-execution-plan.md) | 单一插件标准、统一工具、作用域策略与EXT任务包 | 后续实施依据 |
| [80 Agent与扩展验收](80-agent-extension-acceptance.md) | EXT-A～H验收场景和放行门槛 | 逐项验收依据 |
| [81 EXT-A契约执行](81-ext-a-contracts-execution.md) | 扩展契约、策略与目录解析 | EXT-A记录 |
| [82 EXT-B工具执行底座](82-ext-b-tool-execution-execution.md) | 工具预检、执行、幂等账本与并发控制 | EXT-B记录 |
| [83 EXT-C插件运行时执行](83-ext-c-plugin-runtime-execution.md) | 插件Worker、RPC与状态命名空间 | 修复前记录，以85号为准 |
| [84 EXT-A～C独立复核](84-ext-a-c-independent-review.md) | 修复前P1复现与FIX1～5要求 | 问题来源 |
| [85 EXT-A～C复核修复](85-ext-a-c-remediation.md) | FIX1～5、执行授权边界与验证证据 | 本轮执行记录 |
| [86 EXT-C修复独立复核](86-ext-c-fixes-independent-review.md) | 修复项复核与submitted/授权边界追加要求 | 复核结论 |
| [87 EXT-D Agent组合与工具循环执行](87-ext-d-agent-composition-execution.md) | 单一宿主、assistant/tool协议、预算循环与执行器接入 | D-A～D-C历史记录，当前以90为准 |
| [88 原子写重试guard补修](88-atomic-retry-guard-fix.md) | 每次rename前撤权复验、Windows冲突重试边界 | 已复验 |
| [89 D-D/D-E执行](89-ext-d-hooks-execution.md) | 钩子、真实outcome、预算、配置换代与快照 | 本轮实现说明 |
| [89a 端到端证据](89a-ext-d-e2e-evidence.md) | 真实Core/Worker装配、首轮失败与20项复验 | 保留原始失败 |
| [90 EXT-D主进程独立验收](90-ext-d-independent-review.md) | 独立反向探针、A01～A06、最终138项/1046项及构建 | 当前放行范围与后续边界 |
| [91 EXT-E内置媒体迁移](91-ext-e-builtin-media-execution.md) | M01～M04证据、宿主键幂等语义、语音通道边界 | 待独立复核 |
| [92 EXT-F Skill服务](92-ext-f-skill-service-execution.md) | 多来源、CRUD/CAS/复制/影响、预算选择、只读预览与统一注入 | S01～S06后端证据；R1/R2见94 |
| [93 EXT-E/F主进程复核](93-ext-e-f-independent-review.md) | EXT-E 放行；EXT-F R1非工具预算、R2 DTO状态、R3测试边界 | 复核原始结果与门槛 |
| [94 EXT-E/F复核修复](94-ext-ef-review-fixes.md) | R1/R2/R3修复、非工具预算回归、能力选择状态、host门控用例 | 定向67项、全量1077项、构建通过 |
| [95 EXT-E/F修复复验](95-ext-e-f-fixes-independent-recheck.md) | R1/R2通过；95-R3异步等待、95-R4超时原因竞争 | 独立复验原始结果 |
| [96 EXT-E/F复验修复](96-ext-ef-recheck-fixes.md) | await异步谓词、门控反向检查、双超时原因契约 | 定向45项、连续两次全量1078项、构建通过 |
| [46 独立世界书与条目管理实现方案](46-independent-worldbook-implementation-plan.md) | 资源版本、导入编辑、逐会话来源、运行时边界与验收 | WB01～WB06实施依据 |
| [47 独立世界书完整验收](47-independent-worldbook-acceptance.md) | D/S/B/M/A/U 全项验收与人工清单 | 逐项证据与WB06收口 |
| [53 后续实现计划](53-remaining-development-implementation-plan.md) | WB04～WB06、长期记忆、插件/Skill、多模态与桌面发行 | 后续派发顺序 |
| [54 后续验收标准](54-remaining-development-acceptance.md) | W/M/E/V/D 验收ID与统一命令 | 各阶段放行门槛 |
| [55 世界书编辑器与来源执行](55-worldbook-editor-and-source-execution.md) | WB04/WB05实现、W01～W12映射、浏览器与待人工项 | 本轮交付记录 |
| [56 世界书UI独立复核](56-worldbook-ui-independent-review.md) | R1～R4问题、复现与放行条件 | 复核问题来源 |
| [57 WBU复核修复与复验](57-worldbook-ui-review-fixes.md) | R1～R4修复、正式回归、754项与浏览器复验 | 修复关闭记录 |
| [58 世界书UI修复独立复核](58-worldbook-ui-fixes-independent-review.md) | R1～R4复核通过、详情加载P2复现 | 问题来源，P2已由59关闭 |
| [59 详情加载状态修复](59-worldbook-detail-loading-execution.md) | P2所有权与恢复、4项正式回归、758项 | 修复关闭记录 |
| [60 世界书加载修复独立复核](60-worldbook-loading-fix-independent-review.md) | 59修复复核、4项回归核验 | 修复关闭核验 |
| [61 MEM00长期记忆方案](61-memory-foundation-implementation-plan.md) | MEM01～MEM04边界、作用域/Store/API/提取设计 | 实施依据 |
| [62 长期记忆验收](62-memory-foundation-acceptance.md) | S/C/T/U验收ID与放行条件 | 阶段放行门槛 |
| [63 MEM01执行记录](63-memory-foundation-execution.md) | Store/服务/API、S01～S12、776项 | 管理存储交付记录 |
| [64 MEM01独立复核](64-memory-management-independent-review.md) | R1～R3问题、复现与放行条件 | 复核问题来源 |
| [65 MEM01复核修复](65-memory-management-review-fixes.md) | R1～R3修复、5项正式回归、781项 | 修复关闭记录 |
| [当前关键页修订图](design/ui-suite-v2/index.html) | 账号五能力、群聊/私聊角色绑定、设置全局服务 | 配合15使用，静态概念稿 |
| [原12页UI图集](design/ui-suite/index.html) | 历史视觉参考 | 旧导航、任务媒体/会话页和账号单卡结构已失效 |

03～05 是本轮制定的开发计划，不是已经实现或验收通过的声明。配置样例是目标格式，不可直接用于当前版本。

“视频 API”默认指视频理解；云端/本地模型接入已运行服务。用户自行启动 QQ，应用通过 SnowLuma 探测并在用户点击后注入和监听；已有注入仍可直接 attach。自动启动 QQ 已移出计划。世界书与长期记忆另列后续阶段。

控件外观复核见 [22 控件风格复核](22-control-style-review.md)：暖色语义色、复选框、状态标记与头像作用域修复，含实际页面截图。

目录与版本管理见 [23 仓库规范](23-repository-layout-and-version-control.md)：测试源码保留，验收截图归入本地 test-results，release 与构建产物不纳入 Git。

账号卡片识别见 [24 QQ账号与昵称展示](24-qq-account-identity-display.md)：注入前探测、连接后身份核验、PID诊断折叠和未知账号回退。

后端收口核验与后续分工见 [25 后端架构治理计划](25-backend-consolidation-review-and-plan.md)：本轮原子写入/恢复资格收口核验、两项既存并发问题及分阶段改造验收。

B00 基线记录见 [28 基线行为契约](28-baseline-behavior-contract.md)：治理起点提交、不可改变的产品行为、基线核验结果与已知问题。各 Store 的提交/失败语义见 [29 Store 提交失败审计](29-store-commit-failure-audit.md)。B01～B11 的落点、关键不变量、验证结果与未验证边界见 [30 后端改造执行报告](30-backend-refactoring-execution-report.md)。

重构独立复核见 [31 后端重构独立复核](31-backend-refactoring-independent-review.md)：保留原始复核问题与确定性复现，记录R1～R5返修、340项回归及6组独立验收通过的结果。
