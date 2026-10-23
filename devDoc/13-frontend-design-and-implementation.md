# Accompany 整体前端设计与实施方案

日期：2026-10-22。状态：设计交付与开发依据，不代表前端改造已经实施。

> 当前结构已按用户新要求修订：取消会话页、任务媒体历史展示和独立模型服务页；账号策略改为模型配置，只提供账号级五类能力配置与测试；全局服务移入设置；角色卡必须逐个群聊/私聊显式绑定，无账号默认卡。细节以 [15 账号模型配置与会话角色修订](15-account-models-and-conversation-roles.md) 为准。旧 12 张图保留作历史风格参考，不再作为当前导航依据。

本方案依据用户已认可的温暖展示主页与 Dock，覆盖 11 的早期深色候选；12-home-showcase-and-workbench-design.md 的职责、资料来源和交互规则继续有效。业务与注入安全要求沿用 10；本次检查发现工作区已有部分手动注入接口，不将它们重新列为纯设想，也不据此宣称真实环境已验收。

## 1. 产品结构：展示与操作各有空间

```text
AppShell：统一窗口边界、顶部导航、路由、连接提示
├─ 主页 Home：当前 QQ 展示图片、名称、号码、个性签名、账号 Dock
├─ 工作台 Workbench：稳定侧栏、明确作用域、业务列表/表单/详情
│  ├─ 总览
│  ├─ 实例与监听
│  ├─ 资料与角色
│  ├─ 插件与 Skill
│  ├─ 模型配置：账号五类能力配置与测试，无任务/媒体历史
│  ├─ 事件诊断
│  └─ 应用设置：包含全局模型服务
└─ 资源 Resources：公用/私有定义、引用与版本部署
```

主页只切换展示，不注入、不暂停、不发消息、不切换 QQ 登录身份。工作台无悬浮账号 Dock、无大面积立绘背景。资源页不将公共资源误当所有账号共同的运行状态。

进入工作台时可用主页账号作为初始上下文，但当前操作账号必须显式展示并在提交时校验。全局模型服务/应用设置使用“全局”，不伪装成账号私有。

## 2. 原 12 页图稿与当前修订

当前为 9 个主页面：主页、总览、实例与监听、资料与角色、插件与 Skill、模型配置、事件诊断、应用设置、资源库。下表是上一轮图稿清单；06 移入设置、07 改为模型配置、08 移除、09 并入模型配置。其余旧图的侧栏也需按当前导航调整，不直接照图开发。

图稿位于 design/ui-suite，全部是假数据静态视觉概念，不是实际运行截图。01 使用已认可的主页图；02～12 按同一暖色工作台基准生成，逐页复核。生图文字与按钮若与本方案冲突，以本方案语义为准。

| 图号/文件 | 页面与目标 | 主要内容 | 关键状态 |
| --- | --- | --- | --- |
| 01-home.png | 主页：温暖留白与个人表达 | 账号图、QQ 名称/号、签名、Dock | 默认头像/自定义图、空签名、离线缓存、无账号 |
| 02-overview.png | 工作台总览：快速掌握情况 | runtime、账号状态、待接入进程、最近任务 | 无实例、部分异常、停止与暂停分开 |
| 03-instances.png | 实例与监听：用户主动接入 | QQ 进程、PID/代际、身份、注入与监听、详情 | 未识别、注入中、等待登录、已加载未监听、失败 |
| 04-profile.png | 资料与角色：身份与人格分开 | 账号展示设置、图片上传/恢复、主页预览、角色卡绑定 | QQ 资料不可得、草稿、未保存、上传失败、角色缺失 |
| 05-extensions.png | 插件与 Skill：配置账号能力 | 定义来源、账号启停、作用域、依赖、配置 | 未安装、禁用、缺能力、私有覆盖、旧宿主兼容 |
| 06-models.png | 模型服务：端点与凭据管理 | 服务列表、适配器、模型能力、地址、凭据状态、测试 | 未配 Key、本地免 Key、鉴权失败、能力不支持 |
| 07-policy.png | 账号策略：继承与授权可解释 | 账号/私聊/群聊/会话覆盖、四能力绑定、生效结果 | 继承、覆盖、硬授权拒绝、回退关闭 |
| 08-conversations.png | 会话：历史与人工发送 | 账号、会话列表、消息、目标标识、人工发送 | 离线、暂停自动处理、历史加载、发送结果未知 |
| 09-tasks.png | 任务与媒体：异步过程可见 | 任务列表、来源、服务、状态、取消、输出 | 等待远端、本地取消、结果未知、未交付 |
| 10-diagnostics.png | 事件诊断：排错而不泄露隐私 | 事件、筛选、详情、脱敏复制、runtime/租约 | 重连、事件缺口、错误、空视图 |
| 11-settings.png | 应用设置：偏好与环境 | 外观/动效、SnowLuma 接入、数据/安全、关于 | 凭据保护不可用、版本不兼容、偏好保存失败 |
| 12-resources.png | 资源库：定义与引用管理 | 公用/私有、角色卡/插件/Skill、版本、引用与部署 | 版本固定/跟随、未有管理接口、部分部署失败 |

完整世界书和长期记忆本轮不制作假装可用的编辑页面，仅在资料页显示“规划中”。后续确认业务字段与运行语义后另行补图。

## 3. 设计语言

关键词：温暖、安静、轻盈、清楚、有呼吸感。主页允许大留白；工作台保留合理信息密度，通过结构而非大插画建立质感。

### 色彩与材质

| 语义 | 值 | 使用约束 |
| --- | --- | --- |
| 应用背景 | #F2EDE3 | 主面，无纯黑大面积底 |
| 侧栏/次级面 | #E8E0D3 | 与正文区有稳定分区 |
| 编辑/浮层面 | #FBF8F2 | 少量层次，避免所有面板都发光 |
| 主文字 | #433B34 | 正文、标题 |
| 次文字 | #746756 | 辅助文字仍验证 4.5:1 对比度 |
| 分隔 | #D5CAB9 | 弱分隔，不承担唯一焦点/错误标识 |
| 品牌强调 | #C08F4A | 装饰、选中、焦点辅助；不默认作为小文字颜色 |
| 实心主按钮 | #C08F4A / #2D241A | 背景/文字，参考对比度 5.27:1 |
| 成功 | #42664C | 文字/图标，配柔和底色 |
| 提醒 | #805B24 | 文字/图标，不能只靠黄色表达 |
| 错误 | #A13D32 | 错误文案/危险操作 |

配套 CSS 参考 design/ui-suite/design-tokens.css。遵循 primitive → semantic → component 三层，正式实现不在每页硬编码一套近似值。仅对有意义浮层使用磨砂；不要让透明面与立绘降低表单对比度。

### 字体、几何与密度

- 正文/控件用系统中文 UI 无衬线字体；主页昵称与签名可用宋体，工作台只有小部分展示标题允许宋体，不把整个数据表变成展示字体。
- 正文 14px，辅助 12px，工作台页标题 24–28px；主页昵称 40–56px，按窗口变化。ID/端口使用等宽数字。
- 基础间距 4/8/12/16/24/32；控件高 36/40px；行高在密度与触达性间验证。
- 控件圆角 8–10px，面板 16px，Dock 22–26px。列表优先细分隔，避免卡片套卡片。
- 常规操作、危险操作、状态说明分别表达；“停止监听”不与“注入并监听”同时抢占主按钮权重。

## 4. AppShell 与路由

沿用 React + TypeScript + Vite + Electron，不为本轮设计重写宿主、替换构建工具或引入 Next.js。保留现有 API 客户端和 preload 的最小桥接边界。

可继续 hash 路由，推荐层次：

```text
#/home?account=10001
#/workbench/overview
#/workbench/instances?slot=a
#/workbench/accounts/10001/profile?tab=display
#/workbench/accounts/10001/extensions?tab=skills
#/workbench/accounts/10001/models?tab=capabilities
#/workbench/accounts/10001/profile?tab=roles&kind=group&peer=67890
#/workbench/settings?tab=model-services&provider=local-chat
#/workbench/diagnostics
#/workbench/settings?tab=appearance
#/resources?source=public&kind=role-card
```

旧 #/slots、#/accounts 保留映射；原模型服务入口映射到设置的模型服务标签，原账号策略与任务媒体入口映射到该账号模型配置，不开放历史列表。原会话页入口显示已移除说明并返回工作台，不再提供人工发送。路由中没有账号或角色绑定目标时要求用户选择，不自动猜测第一个账号。

路由保存筛选、选中项与必要作用域；表单草稿不放 URL，密钥/令牌不放 URL。返回页面恢复位置与筛选；未保存草稿离开需保留或明确处理。

原生 Windows 标题栏与 HTML 标题栏不可重复。图稿为示意；先沿用现有原生窗口边框，若采用自绘标题栏，再完成拖拽区域、双击最大化、窗口按钮和可访问性验证。

## 5. 前端模块与状态

```text
renderer/src/
  app/                 Shell、路由、全局错误与桥接
  design/              Token、排版、布局与动效
  components/          ScopeBar、AccountPicker、Status、表格、表单、抽屉、空/错状态
  features/home/       展示资料、主图、签名、AccountDock
  features/instances/  进程与注入操作、账号绑定
  features/accounts/   资料、图片、角色卡
  features/extensions/ 启用集、Skill/插件配置与来源
  features/providers/  设置中的全局模型服务与探测
  features/models/     账号五类能力选择与本次测试反馈，不包含历史任务/媒体浏览
  features/role-bindings/ 群聊/私聊角色绑定与实际生效角色
  features/resources/  制品、引用、部署
  features/settings/   外观与运行环境
  services/            现有 API 封装、查询键、SSE 与请求取消
```

逐步从现有 pages 迁移，不要求先搬文件再改 UI。优先按功能收敛状态，避免新的 App.tsx 再成为所有页面的数据容器。

### 必须独立的状态

| 状态 | 归属 |
| --- | --- |
| displayedAccountId | 主页只读展示选择 |
| operationScope | 当前工作台账号；角色绑定操作额外带 kind+peerId，模型配置不带会话范围 |
| selectedSlot / ProcessIdentity | 实例管理，不由角色昵称推断 |
| hover/focus/dockMotion | 纯前端瞬态，不进入业务存储 |
| account/profile/provider/jobs | 服务端事实，按查询键隔离 |
| draft/dirty/pendingSave | 表单本地草稿，不能被 SSE 刷新覆盖 |
| motion/theme/density | 应用偏好，版本化本地持久化 |

查询键至少包含完整作用域，例如 accountId/kind/peerId、accountId/jobId、source/kind/id/revision。缓存和上传不能只按 peerId 或插件裸 id 存储。

异步账号切换使用 AbortController 或请求代际，晚到结果不可覆盖新账号。Dock 点击原子更新主图、昵称、号码和签名；悬停不请求业务操作。

## 6. 组件规范

| 组件 | 必须具备的状态/行为 |
| --- | --- |
| AccountDock | 小/选中/悬停/焦点、邻近放大、更多账号、空数据、图片失败；底点与尺寸共同标识当前展示 |
| AccountScopeBar | 设置为全局，模型配置为账号；仅角色绑定显示目标群聊/私聊，改变账号时处理草稿 |
| RuntimeStatus | 管理连接、QQ 注入、监听、Agent 配置分别展示；不能把识图失败报成 QQ 离线 |
| OperationButton | idle/pending/success/error/unknown，重复点击保护；未知结果不能直接变成“重试” |
| DataTable/List | skeleton/empty/error/partial/stale，稳定行 key，长昵称/路径截断有完整查看 |
| FormField | 持久 label、说明、校验、只读/禁用区别、保存反馈，错误不只 Toast |
| Inspector/Drawer | Esc 关闭、焦点返回、正在编辑退出提示；不无条件阻塞主列表 |
| CapabilityBinding | 账号五类能力的当前服务、模型、授权、可用原因、未配置/禁用语义；无会话覆盖 |
| SecretField | 读取仅 configured/掩码，输入用于替换，保存后清空；不把原始密钥进全局状态 |
| MediaPreview | 鉴权取 Blob、按需加载、离开 revoke URL、账号隔离、大小限制 |
| ResourceReference | 公用/私有、固定/跟随版本、引用账号、部署与回滚状态 |

## 7. 动效规范

### Dock 与主页

- 普通头像约 44–48px，选中约 56–60px，悬停可至 64–72px，相邻头像按距离影响；具体值按窗口宽度收敛。
- 只使用选中状态决定展示内容；pointermove 仅驱动连续 motion value，不用每帧 setState 重渲染整个页面。
- 位移与缩放同源计算，先预留最大放大空间，不允许邻居相互覆盖。图片占位/焦点也不撑高页面。
- 切换主体 220–320ms 交叉淡入，预加载下一张后再提交，不能因大图下载把签名与账号拆开显示。
- 大于约 5–7 个账号时使用横向浏览/选择器；不缩到不可点。

### 工作台

- 悬停/按压 100–160ms；页内内容替换 160–220ms；抽屉 220–280ms；状态成功一次短高光。
- 轮询与 SSE 不触发整页重播入场；表格更新尽量只变对应行。
- prefers-reduced-motion + 应用完整/轻量/关闭装饰动效；隐藏/托盘状态停装饰动画。
- 任何动画可被新输入打断；不等待成功动画才完成真实操作，不画虚假注入百分比。

现有 CSS 与小范围 rAF 已可支撑原型；若后续选用 Motion，单独核查并安装依赖后局部引入，不在此交付中假设 package.json 已有该库。

## 8. 数据接口与缺口

本表基于当前源码路由存在性检查，不等于相应行为已通过真实集成。

| 页面 | 可复用当前接口/服务 | 仍需补齐或确认 |
| --- | --- | --- |
| 总览 | GET /slots、/accounts、/jobs、/injection/runtime、/events | 汇总由查询结果派生，禁止伪造统计 |
| 实例 | GET /injection/processes；POST /injection/processes/:pid/inject-and-listen/listen/refresh/unload；GET /injection/operations/:id；/slots | 复用 ProcessIdentity、operationId；以当前 DTO 为准，不只传 PID |
| 角色卡 | 现有 profile/artifacts 仅可参考，尚不是会话绑定接口 | 新增 accountId+kind+peerId 绑定 CRUD 与运行时解析；无账号默认卡 |
| 主页/账号展示 | 现有 /accounts 仅有档案/账号摘要，不能假设含 nickname/signature/avatar | 显式新增展示资料读取、图片上传/重置与偏好持久化，校验 QQ 资料获取能力 |
| 插件/Skill | 账号 profile.plugins、policy.skills、effective；公用 artifacts | 完整插件工具注册链与独立 Skill 制品 CRUD 非现成能力，缺失入口不假保存 |
| 设置中的模型服务 | /providers、/providers/:id/credential、/providers/:id/test | 扩展第五项语音生成；测试按能力，收费探测显式触发 |
| 账号模型配置 | 现有 policy/effective/agent/capabilities 可作为改造基础 | 固定账号级，迁移旧会话模型覆盖；新增语音能力完整链路 |
| 角色目标目录 | 现有 /conversations 可参考复用 | 仅用于目标选择/绑定，不开放聊天历史或人工发送页面 |
| 内部任务媒体 | /jobs、/jobs/:id/cancel、账号 media | 后端保留内部职责，UI仅本次能力测试反馈，不提供历史浏览 |
| 资源 | /artifacts、/deployments、deploy/rollback | Skill/私有 fork/导入接口按实际能力分阶段开放 |
| 诊断 | /events、/diagnostics、/metrics | 本地过滤、脱敏、事件缺口与暂停滚动；清空视图不删除审计 |
| 设置 | /injection/settings、/injection/password；运行诊断 | 外观偏好存储、数据保留/限额写接口未明确前只读展示 |

### 账号展示的目标 DTO（待实现）

AccountDisplayProfile：accountId、nickname、signature、avatarMediaId、showcaseMediaId、imageFit、focalPoint、source、updatedAt、revision。

图片优先使用本账号自定义图，否则 QQ 头像，否则中性占位。上传实际复制到受控账号媒体目录，不仅保存外部路径。QQ 资料与本地展示覆盖分别标识；保存展示不修改 QQ 昵称/签名本身，除非后续明确设计并授权真实资料编辑。

建议新增 GET/PUT /accounts/:id/display-profile、POST /accounts/:id/showcase-image、DELETE /accounts/:id/showcase-image；这些是目标接口，当前不可直接调用。认证、媒体类型/大小、图片解码、归属、清理与 reset 均需实现。

## 9. 安全、可用性与性能

- API 请求沿用现有授权客户端；SnowLuma 管理登录态/服务端密钥不传普通页面；用户输入替换 Key 仅短暂保留，错误与日志脱敏。
- QQ 名称、签名、角色文本都是不可信数据，默认 React 文本转义；不使用 dangerouslySetInnerHTML 展示签名。
- 上传图片验证格式/大小/解码，避免任意 SVG/HTML 执行；本地路径不直接暴露给渲染进程当公共 URL。
- 全部主要操作有键盘入口、焦点、图标文字标签；焦点轮廓与正文对比度分别验收。
- 列表媒体按需加载，不一次性下载所有任务视频；关闭预览与账号切换释放 Blob URL。
- SSE 更新局部查询；断线使用保留数据+陈旧标识，不清空整个页面。需要时低频轮询兜底，不每页重复开启同一 SSE。
- 事件列表超过可视容量使用截断/虚拟化；千条消息与多个账号下测试滚动和输入响应。
- 默认图只为样本内容，普通小头像也必须好看可用；素材缺失不能把主页变成空白。

## 10. 状态与文案契约

暂停自动处理：连接与历史接收继续，自动宿主/发送受控；停止监听：断开本应用该实例；请求卸载：向 SnowLuma 显式请求，不能混作删除资料。

本地取消 ≠ 远端已取消；运行时已连接 ≠ QQ 已注入 ≠ 账号已校验 ≠ Agent 已就绪。每个状态应能解释，不使用一个绿色“在线”覆盖全部事实。

表单保存中保留输入、阻止重复提交；失败显示原因和重试边界。注入/付费生成/未知发送只查询 operation 状态，不在请求超时后自动重复 POST。

资源选择不立即部署；部署前明确版本和目标账号，部分成功逐账号展示。公用更新不改写账号历史和私有记忆。

## 11. 开发工作包

| 工作包 | 内容 | 验收产物 |
| --- | --- | --- |
| FE-01 | Token、AppShell、顶部导航、作用域与旧路由映射 | 三种顶层页面统一风格、旧入口可达 |
| FE-02 | HomeShowcase、Dock、头像失败/长签名、减少动效 | 不调用业务写操作、选中/悬停分开 |
| API-Display | 账号展示 DTO、资料来源、图片上传/缓存/重置 | 按账号持久化与访问校验 |
| FE-03 | 总览、实例管理、operation 状态与停止语义 | 单实例手动闭环和双账号隔离 |
| FE-04 | 资料/会话角色、插件Skill | 群/私聊逐个绑定，无默认卡；未绑定不自动回复，缺接口明确 |
| FE-05 | 设置全局服务、账号模型配置与测试 | 五能力独立且账号级；无任务媒体历史，语音生成与QQ交付分别验收 |
| FE-06 | 资源、事件诊断、设置 | 部署/回滚可解释、脱敏、偏好恢复 |
| FE-07 | 视觉/交互/端到端验收、打包窗口验证 | 验收报告、问题清单、真实截图 |

顺序：先 FE-01/02 和 API-Display，再 FE-03，随后按接口推进其他工作包。禁止为完成设计外观而将现有安全隔离和业务流程挪回前端。

## 12. 设计交付边界

历史交付为12页图；当前结构为9个主页面，三张关键修订图见 design/ui-suite-v2。其余历史图仅参考视觉，不沿用旧侧栏。设计 Token、页面规范、接口缺口与FE验收清单共同使用；图集不连接QQ或模型。

图片里的密集小字、示例版本、权限说明与个别生成瑕疵不是业务真值；详见 ui-suite/REVIEW.md。正式实现以本方案、现有契约及后续确认的 DTO 为准。设计通过也不替代真实 QQ/模型功能验收。
