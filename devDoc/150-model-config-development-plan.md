# 模型配置工作区开发文档：昼夜手账接入方案

2026-10-29。状态：**已实施，实现方自验见[153执行记录](153-model-config-workspace-execution.md)**。本方案保留为开发目标与边界依据；以[HTML样例](design/character-studio/model-config/index.html)作为视觉与交互参考，不将HTML候选当作正式实现证据。验收清单见[151](151-model-config-acceptance.md)，文档独立复核见[152](152-model-config-development-docs-independent-review.md)。

## 1. 目标与交付边界

把模型服务设置与账号使用配置组织为统一的「模型配置」工作区，沿用夏澄手账的两套主题。用户能明确完成两件不同的事：准备可调用的模型服务；为指定账号授权服务、选择模型和开放能力。

| 层次 | 当前事实 | 本方案目标 |
| --- | --- | --- |
| HTML候选 | [148自验](148-model-config-html-execution.md)/[149复核](149-model-config-html-independent-review.md)已覆盖离线布局与模拟交互 | 保留为参考和截图证据，不复制其模拟业务逻辑 |
| 正式服务编辑 | `SettingsDialog`的models分类挂载`ModelsPage`，包含五类能力及`ProviderManager` | 迁移到工作区“服务与模型”，复用现有服务逻辑和高级管理能力 |
| 正式账号配置 | `#/model-config`挂载`PolicyPage`，具有授权、能力、回退、媒体及有效配置 | 迁移视觉并组织为“账号使用”，保留完整语义 |
| 后端 | 已有服务发现、草稿验证、服务保存、账号策略及有效能力接口 | 优先复用；本方案不要求新增DTO、路由或存储格式 |
| 设置与旧入口 | `#/settings`、`#/models`等兼容入口会打开设置的模型服务分类 | 保留入口可达，明确转接到统一服务编辑工作区 |

本轮开发范围：模型工作区、关联入口、必要公共组件组合、布局样式与验证。账号关系页、主页构图、QQ注入流程、插件测试页面和Mac适配不在本包。原生窗口、顶部主题控件与Dock沿用正式壳。

## 2. 依据与证据等级

依据导航链：根[DESIGN](../DESIGN.md)说明方向与入口；[105共用标准](105-frontend-design-system.md)/[110夜间标准](110-nightwave-ui-standard.md)/[117动效](117-frontend-motion-standard.md)/[120 Dock](120-dock-notebook-standard.md)规定相应规格；[token源](design/character-studio/tokens.json)提供数值；[公共UI契约](../desktop/renderer/src/ui/README.md)规定实际组件能力。数值冲突按105及token的正式约定处理，并同步修订相应规范，不由根DESIGN的概述或页面样例覆盖。

样例的双栏纸页、能力索引和服务／账号两视图属于本次设计目标；它们不是新增的全局组件标准。若正式实现需要新增尺寸或材质数值，先在token及相应规范登记，再生成CSS；不得在页面自行挑色、手改生成token或套用其他站点模板。

样例[白昼](design/character-studio/model-config/daylight.png)、[晚风](design/character-studio/model-config/nightwave.png)与窄屏证据只证明候选HTML；正式迁移必须重新验证真实React、鉴权、草稿和生产dist。

## 3. 信息架构与入口决策

### 3.1 统一工作区

保留主路由`#/model-config`、Dock“模型”及原有页面身份。新增页内视图：

- **账号使用**：保持原主路由的默认任务，优先现有有效账号；不在刷新或主题切换时擅自换账号。
- **服务与模型**：显式打开时显示服务配置，能力索引顺序为文本、视觉、视频、图片生成、语音生成。

HTML默认展示服务视图，方便评审表单；正式路由默认账号视图是兼容现有使用习惯的设计决策。明确指定视图的导航优先于默认值；同页切视图不产生新的顶层页面、不重播整页动效，也不因隐藏面板而丢弃草稿。

页内视图、能力选择均为本机UI状态，不写账号配置。现有hash解析保持兼容；首包不引入未经全局导航器支持的`#/model-config/services`等新路由。需要跨入口指定视图时，通过现有App导航控制器传入明确的视图意图，清理消费后的意图，避免旧值覆盖用户后续选择。

### 3.2 一个可编辑来源

**正式迁移后，模型服务只在统一工作区编辑。** 设置中的“模型服务”分类保留只读摘要和“打开服务与模型”入口；不再在隐藏的设置面板中挂载第二个`ModelsPage`编辑器。该入口切换必须经过设置关闭／全局草稿准入。

此决策消除两个表单争用同一服务、重复注册`settings:models`、两个加载器相互回填等问题。它是待实施的入口调整，不是当前代码事实。切换入口时同步更新旧hash行为测试：`#/settings`、`#/models`仍提供模型服务入口；保留现有history返回、取消、焦点及安全退出语义，不用直接`location.hash=`绕过控制器。

来自账号页的“配置模型服务”指向同一工作区服务视图；服务保存后的“去分配给账号”回到账号视图，并保留合法的原账号选择。必要时经账号草稿准入，不默认批准或丢弃草稿。

## 4. 页面布局、主题与可访问性

### 4.1 骨架

正式App提供唯一页标题、主题切换和Dock；工作区不能再复制样例的全局header/footer，避免双标题和双Dock。服务视图由能力索引及配置纸页组成，纸页内以细分隔组织“服务接入”与“模型／测试”。账号视图由账号选择、授权／模型绑定及有效配置组成。

| 场景 | 布局要求 |
| --- | --- |
| 宽窗口 | 左侧能力索引，右侧纸页；纸页内服务与模型两栏，必要字段完整 |
| 中等宽度 | 先将纸页降为单栏；再将能力索引转为可滚动横向列表，不靠挤小字体维持双栏 |
| 窄屏与短窗口 | 表单纵向布局，必要动作自然换组；能力标签、保存和错误完整可达 |
| 滚动 | 使用正式业务内容滚动区；顶部、Dock区域和业务滚动区职责分开，窗口根不额外滚动 |
| 保存位置 | 随编辑纸页滚动，保持清晰可达；首包不采用曾在HTML中遮挡窄屏标题的吸附保存栏 |

样例960/800/520px断点是候选实现参考，正式断点以内容实际可用宽度、105及现有壳为准。不能把1440×1160样例截图当作1280×800或1024×720已经适配。

### 4.2 视觉与状态

- 字体、字重、行高、44px常规字段与按钮、圆角和间距消费现有semantic/component token；页标题32/40、区块20/28、正文14/22、辅助12/18。必要内容不使用10px装饰字规格。
- 白昼为奶油桌面、纸白编辑面、深蓝提交、手账红次级测试；晚风为墨蓝桌面／纸面、暖白正文、浅蓝提交及琥珀强调，采用110的完整映射。
- 保存使用提交语义；错误／未知／成功分别使用danger/warning/success，不以入口色冒充成功。普通正文目标4.5:1，必要边界、图标、焦点目标3:1，检查实际叠色和各种状态。
- 必要输入框和选择器边界用lineControl，分区线可用lineDecorative。禁用使用专属前景和底面，不把整个区域统一降低透明度。
- 折信Logo、主题切换和昼夜Dock由全局共享实现负责。没有新的人物图、主题材质或天气特效需求。
- 标签与字段通过`Field`关联；API Key显隐有可访问名称和状态；tablist完整实现方向键/Home/End及tabIndex，若暂时无此公共模式则以普通命名导航实现，不能只添加role冒充完整键盘模式。
- 模型选择浮层、费用确认、服务删除确认使用公共Modal/menu/useConfirm；保留Esc、初始焦点、返回焦点、嵌套隔离和预置传播。

### 4.3 动效

使用公共动效策略及117：按压1px，控件160ms，浮层220/160ms，页面280ms；具体值读token。纸页和索引只做受控轻微反馈，不给每个字段重复入场。切主题不卸载编辑器、不导航、不发请求；首包沿用模型页面默认主题过渡，不照搬关系页专属纸线效果。

保存落款由服务器明确成功后触发，准确文字为“模型服务已保存”或“账号配置已保存”；不能在点击、计时结束或HTTP传输完成但业务失败时盖章。使用公共`feedbackKey/resultLabel`等已有能力，局部与系统reduced均为下限，焦点不等待动画。

## 5. 业务视图与字段

### 5.1 服务与模型

| UI字段 | 现有字段／来源 | 行为 |
| --- | --- | --- |
| 能力索引 | `CapabilityId` | 固定五类；每类草稿、baseline、busy和结果独立；状态区分未配置、已配置、待保存、来源失效 |
| 服务来源 | `ProviderDto.id`或新建 | 由真实providers列表生成，显示足够的ID／地址以区分；多候选不能默认挑第一个 |
| 协议 | `adapterId` | 沿用能力可用适配器规则；未知现值保留并解释，保存前要求支持，不静默改协议 |
| 服务地址 | `baseUrl` | URL校验、trim；保留当前服务的真实地址，不强制补`/v1`或套厂商预设 |
| API Key | `secret`输入＋`credential.configured` | 已存值不回填；同origin留空保持，origin变化时按现有边界重填；保存成功后清空输入 |
| 模型 | `modelId`及候选列表 | 可手动输入；候选为空、失败或接口不支持不阻止手动配置；展示结果不等于声明具备全部能力 |
| 工具支持 | `supportsTools` | 仅文本能力的模型声明；不等于工具已授权或本轮必然执行 |
| 默认音色 | `parameters.voice` | 仅语音生成；保留其他模型参数，不用新对象覆盖未显示字段 |
| 获取模型 | `/providers/models` | 显式读取，不调用时不自动扫描；保留当前输入，按请求指纹应用列表 |
| 测试连接 | `/providers/validate` | 测试当前草稿，显式费用提示；不保存、不授权、不向QQ发送 |
| 保存模型服务 | `/providers/simple` | 保留服务其他模型、标记、参数和已有关联；只清除成功提交的草稿baseline |

沿用`resolveInitial`的选择语义与`options.settingsModels`标记。Provider被删除／修改或凭据状态变化时，保持脏草稿并给出来源提示；不能因providers刷新自动把旧草稿拼到新provider版本。

保留现有`ProviderManager`的服务清单、URL／adapter／模型名编辑、密钥更新／清除和删除影响确认，可放入“高级服务管理”Disclosure。其[编辑payload](../desktop/renderer/src/lib/provider-management.ts)保留limits/timeouts/retry/mediaTransports/options等未编辑字段，但当前UI没有这些字段的编辑器，也没有已保存provider测试按钮；不能将后端支持误写成现成UI。首包要求保留隐藏数据，不要求新增这些编辑入口；如另行增加，须补充范围与验收。HTML没有画出已有管理项不表示允许移除，服务删除仍先取impact再确认。

### 5.2 账号使用

账号列表继续由现有accounts与slots合并、去重及状态逻辑获得，不把主题角色或白昼／晚风名称当真实账号身份。空账号、加载失败、旧数据过期和不存在的选中账号分别处理。

保留`PolicyPage`全部能力：

- 账号`allowedProviders`硬授权、多服务与每能力模型选择。
- `capabilities`开启／关闭、`bindings`及已有fallback；关闭能力与删除绑定是不同操作。
- `agentEnabled`暂停／恢复、`crossProviderFallback`、`media.allowCloudUpload`、`visionMode`。
- 五类模型绑定及能力开关仍仅在账号级生效；旧byKind/byConversation模型字段只保留供迁移检查，不重新启用。scope中现行的agentEnabled／visionMode语义、提示及未显示字段按现有策略解析保留，不扩展为新的会话模型覆盖编辑器。
- effective中的实际生效来源、不可用原因、媒体／取消能力信息，以及账号能力测试。

HTML的“不启用”是简化表达。正式表单将关闭映射为`policy.capabilities[capabilityId] = false`，保留既有绑定以便恢复；“未绑定”另有选项和说明。五类模型的账号级开关／绑定不从旧kind/conversation条目继承，不能让空值重新激活旧模型覆盖。保存基于完整的当前策略对象更新已编辑路径，不由可见字段重新构造一份默认policy，尤其不能清空extensions/skills/byKind/byConversation。

实际有效配置由effective接口获得，不能由页面根据选择框推算为“可用”。账号测试只使用已保存策略；账号草稿未保存时解释先保存，费用确认沿用现有cloud／生成能力条件。

## 6. HTTP与数据映射

本表基于[现有模型路由](../src/service/routes/models.ts)，所有请求沿用公共api鉴权和错误封装。URL中的ID继续使用现有标识验证与编码。

| 用途 | 方法与路径 | 请求／响应重点 |
| --- | --- | --- |
| 服务目录／凭据状态 | `GET /providers` | `{ok,providers,credentialStore}`，不含密钥明文 |
| 模型发现 | `POST /providers/models` | `{providerId?,baseUrl,secret?}` → `{ok,models:string[]}` |
| 草稿测试 | `POST /providers/validate` | `SimpleModelSetup`＋明确`confirmCost` → `{ok,result}` |
| 保存简易模型 | `POST /providers/simple` | `SimpleModelSetup` → `{ok,provider}`；不等于账号保存 |
| 高级服务维护 | `POST /providers`、`PUT /providers/:id` | 沿用完整provider payload及可选secret |
| 删除影响／删除 | `GET /providers/:id/impact`、`DELETE /providers/:id` | 先展示受影响账号；不擅自删除仍引用的凭据 |
| 独立凭据维护 | `PUT/DELETE /providers/:id/credential` | 沿用凭据库；删除密钥与删除服务区分 |
| 已保存服务测试接口 | `POST /providers/:id/test` | `{capability,modelId?,confirmCost}`；后端已存在，与草稿测试分开；当前ProviderManager没有该按钮，首包不要求新增 |
| 账号策略读写 | `GET/PUT /accounts/:id/policy` | PUT使用`{policy}`；响应`{ok,policy}` |
| 实际生效查询 | `GET /accounts/:id/effective?kind=…&peerId=…` | 展示给定会话的来源和原因；private/0仅是缺省检查样本，不代表全部会话 |
| 账号能力测试 | `POST /accounts/:id/capabilities/test` | `{capability,confirmCost}`，使用已保存账号配置 |
| Agent暂停／恢复 | `POST /accounts/:id/agent` | 顶层`{enabled,kind?,peerId?}`，不是嵌套scope DTO；保留现行scope语义，不与表单本地修改隐式混写 |
| 账号能力开关 | `POST /accounts/:id/capabilities/:capability` | 仅账号级`{enabled}`；虽然HTTP解析scope，后端patchCapability会拒绝kind或peerId，不提供会话级模型开关 |

`SimpleModelSetup`现有字段为`providerId? / capability / baseUrl / modelId / secret? / adapterId? / supportsTools? / parameters? / confirmCost?`，来源[setup.ts](../src/providers/setup.ts)。本方案不新增服务displayName、服务revision、账号policy revision或CAS字段；前端请求序号只能隔离UI迟到，不冒称服务器并发控制。

HTTP 200只表示传输成功，测试还须检查`result.ok`及detail/sample；错误与未知按真实返回分类。图片／语音测试结果沿用现有受限sample展示，不用伪造耗时、固定成功或setTimeout替代服务结果。

## 7. 草稿、异步与凭据

### 7.1 状态所有权

建议服务控制器稳定挂载于工作区容器，管理所有五类草稿；隐藏当前能力或切到账号视图时不重建控制器。账号控制器继续保留当前账号策略baseline和generation，账号切换走既有准入，不直接照搬HTML“所有账号草稿常驻”的模拟方法。

服务草稿迁移后注册为页面owner，不再注册成仅设置可见的`settings:models`；注册ID在同一App内唯一。账号仍按`policy:<accountId>`注册。使用`useDraftRegistration`及`requestTransition`，将busy、dirty、discard、revision接入既有导航／刷新／退出控制；不另造浏览器confirm或独立草稿库。

`ProviderManager`当前也使用settings owner与`settings:provider-manager`固定ID。随迁移同步改为页面owner及唯一的新ID（建议`models:provider-manager`），修改其内部按ID请求准入的调用和回归，不能只迁移简易表单的owner。五类简易草稿建议用`models:service:<capability>`分别注册，便于高级编辑针对同provider的相关草稿准入；注册控制器稳定挂载，不能只注册当前可见能力。

高级与简易入口共用当前服务快照和按provider的操作协调。打开同provider的高级编辑前，处理相关简易草稿／busy；高级草稿未完成前不允许另一入口提交同provider的陈旧表单。不同provider的草稿可保留。所谓唯一编辑来源包括这些冲突规则，并不意味着移除高级管理。

同页只隐藏而不丢草稿的视图切换可直接完成；会销毁控制器的离页、换账号、关闭编辑容器及旧入口转接均先准入。切主题、外观偏好、轮询和SSE不得触发discard、save或编辑器卸载。

### 7.2 请求归属与刷新

每次请求捕获：目标能力或账号、对象ID、请求序号、草稿指纹、源provider快照。仅最新且来源一致的响应可以更新对应结果；即使组件未卸载，也不能将A账号结果写到B账号、将旧模型列表挂给新地址。

服务保存至少要保留已提交快照与后续编辑的区分。首包保持现有行级busy锁定相关可编辑字段；成功只更新提交对象的baseline。其他能力仍可查看或编辑，但共享同一个provider时要串行保存或锁定冲突操作，不能以“能力不同”推断资源不同。后端`configureSimpleModel`已有串行链，前端仍须避免陈旧payload覆盖同服务的新值。

在途字段锁定是正式页的首包策略；HTML允许等待中继续输入只是用于演示迟到结果隔离。正式竞态验证既要证明相关字段锁定，也要用外部目录变化、换视图／目标、刷新等路径验证失效判断，不要求为了重现HTML而解除字段锁。

读取、测试可以取消或丢弃旧结果；对提交后的写入不能把AbortController当事务回滚。发生保存响应丢失时保留草稿并告知“结果待确认”，提供显式读取与比对；不得自动重提写入、自动标为未保存成功或丢掉当前输入。生成测试结果未知时不自动重试。

失败：保留字段和值；成功：更新对应baseline、清空secret、读取最新provider/policy及effective；刷新失败不得把脏草稿覆盖为默认空配置。列表为空、读取失败、凭据库不可用分别展示。

### 7.3 凭据与调用

不回填已保存密钥，不写localStorage／URL／日志／SSE，不复制HTML的hasKey模拟字段作为真实凭据证明；以`credential.configured`、`credentialStore.available`和服务端校验为准。地址origin变化时复用现有重填规则，后端继续控制credentialRef与来源绑定。

模型发现、测试、保存必须显式点击；加载页面、切主题、切能力、切账号、获取列表成功均不自动测试或保存。服务草稿测试保留原有按钮旁费用提示与confirmCost约定；账号测试保留原useConfirm条件，不新增无依据的每步确认。任何测试均不调用QQ发送或自动注入。

## 8. 文件与组件分工

以下为实施目标清单，新增名称是建议命名，不宣称已存在。

| 位置 | 目标职责 |
| --- | --- |
| `desktop/renderer/src/App.tsx` | 接入工作区、视图意图、正确主题scope和旧入口转接；继续由原控制器处理导航和退出 |
| 新`pages/ModelConfig.tsx` | 唯一工作区容器，页内视图、默认账号与能力选择；避免与App重复页标题 |
| `pages/Models.tsx`及新`components/model-config/` | 将现有服务业务控制与纸页展示分离；抽取能力索引、服务编辑、测试结果等组合 |
| `pages/Policy.tsx` | 在原业务逻辑上迁移账号页展示与高级区域，不省略隐藏策略 |
| `components/ProviderManager.tsx` | 保留高级维护能力，按同一手账视觉逐项适配 |
| `components/SettingsDialog.tsx` | 模型分类只读摘要与受控跳转；移除第二个服务编辑挂载，保留其他分类 |
| `ui/`与稳定入口`ui.tsx` | 新增必需的共享状态／布局外观扩展；基础控件从现有入口导入 |
| `styles/`或页面CSS | 仅布局、列宽、滚动和响应式；不写另一套基础控件外观 |
| token与规范文件 | 仅确有新参数时更新JSON、规范并运行生成器；旧HTML生成器不充当生产构建步骤 |
| `test/`与诊断脚本 | 复用相关回归并补充必要竞态、准入、范围和实际浏览器探针 |

不直接移动HTML的内联SVG、原生input/dialog、document选择器和setTimeout进正式页面；图标、Logo、Field/Input/Select/Switch/Button/Disclosure/Modal都组合现有公共能力。

## 9. 工作包与实施顺序

| 工作包 | 交付 | 退出条件 |
| --- | --- | --- |
| MC-0 现状冻结 | 核对150/151、现有Models/Policy/ProviderManager字段与入口；记录实施前行为和测试 | 高级项、旧入口、错误／未知分支都有可追溯对应 |
| MC-1 状态与入口收口 | 单一工作区容器；服务草稿控制抽取；设置只读入口；旧hash兼容 | 无双编辑器／重复注册；设置关闭、返回、换账号及退出准入通过 |
| MC-2 服务纸页 | 五类索引、配置／发现／测试／保存、密钥与高级服务管理 | 两主题、空错状态、共用provider及请求归属通过 |
| MC-3 账号纸页 | 授权、多能力绑定、媒体／回退／作用域、effective和测试 | 完整策略往返不丢字段；账号隔离与变更来源通过 |
| MC-4 视觉与公共动效 | 响应式、内容独立滚动、焦点、减少动效、成功落款 | 实际React与生产dist同时覆盖两主题，主要控件可达 |
| MC-5 自验与独立复核 | 按151留实现记录、独立记录和必要修复复验 | 自动化与实际页面证据齐全；明确真实服务／原生／发行边界 |

每包完成后再扩大范围；不在同一包重设计主页、关系页或其他业务页。删除旧布局、旧编辑挂载仅在新入口完整接通且必要回归通过后进行，不在页面留下两份互不一致的配置实现。

## 10. 完成定义

完成标准由[151验收清单](151-model-config-acceptance.md)逐条判定。正式实施至少执行token同步检查、类型检查、定向必要回归、全量测试和完整桌面构建，并保留真实React/生产dist双主题证据；不能借用148/149的HTML测试数字。

真实QQ、真实付费服务、Windows原生缩放与发行包分别登记。若未做，只能声明对应本地自动化／浏览器范围完成，不能声明完整EXE验收。本文发布仅表示开发方案已落库，不表示开始或完成这些实施工作。
