# 模型配置工作区实施记录（MC-0～MC-4，MC-5实现方自验）

日期：2026-10-29。对象：[150开发方案](150-model-config-development-plan.md)与[151验收标准](151-model-config-acceptance.md)。状态：**实现方自验完成，独立复核与其余验收项待做**；未提交、未推送、未重新打包发行EXE。

## 1. 交付结果

模型配置已成为正式唯一服务编辑入口，并保留完整账号策略：

- `#/model-config`默认进入“账号使用”，保留原`PolicyPage`的账号选择、Agent开关、服务授权、云端媒体、跨服务回退、图片观察方式、五类能力、有效配置和现有测试/保存逻辑。
- “服务与模型”仅在显式切换或从设置摘要进入时显示；五类能力按文本、视觉、视频、图片生成、语音生成排序。
- 设置中的“模型服务”分类不再挂载第二份`ModelsPage`，改为只读摘要与“打开服务与模型”入口。
- 两视图始终挂载，仅用`hidden`/`inert`隐藏非当前视图；切换能力、视图、主题或设置面板不会卸载服务编辑器或丢失草稿。
- 服务编辑回归到原始业务范围和纸页结构：来源、地址、API Key、协议、模型名、文本工具声明、语音音色、连通性测试、保存与“去分配给账号”；高级服务管理仍保留URL、adapter、模型名和密钥编辑。
- 服务草稿和高级服务编辑均为`owner: 'page'`；主路由切换、设置转接与退出继续走统一`requestTransition`。已经位于模型配置时，视图转接只对实际销毁的设置草稿准入，不再无谓丢弃页面草稿。

## 2. 代码结构与主要改动

| 文件 | 改动 |
| --- | --- |
| `desktop/renderer/src/pages/ModelConfig.tsx`（新） | 双视图工作区、能力索引、纸页区、账号策略区；两视图常驻；向索引回传能力状态与busy |
| `desktop/renderer/src/pages/Models.tsx` | 从设置中的折叠列表迁移为单能力纸页；五能力独立草稿/baseline/busy/错误/通知/测试结果；状态回传、保存反馈、密钥显示切换、过期模型列表失效 |
| `desktop/renderer/src/lib/model-capabilities.ts`（新） | 五类能力标题/描述/primary顺序与`ServiceStatusMap`；避免页面从被mock的`ModelsPage`导入运行时常量 |
| `desktop/renderer/src/styles/model-config.css`（新） | 工作区布局、能力索引、纸页、响应式、账号卡片统一、设置摘要；主表面圆角消费`--nd-semantic-radius-surface`，无自建调色 |
| `desktop/renderer/src/components/SettingsDialog.tsx` | models分类改为只读摘要；移除隐藏的`ModelsPage`；增加打开工作区入口与刷新/错误状态 |
| `desktop/renderer/src/components/ProviderManager.tsx` | 草稿ID改为`models:provider-manager`、owner改为page；切换编辑目标时同时准入`models:services`；标题改为“高级服务管理” |
| `desktop/renderer/src/App.tsx` | 引入`ModelConfigView`；工作区默认account；设置摘要入口与账号入口按实际销毁owner选择scope；视图切换回到顶部；model-config纳入夏澄主题作用域 |
| `desktop/renderer/src/lib/navigation.ts` | 模型配置副标题改为“准备模型服务，并按账号授权能力与绑定” |
| `desktop/renderer/src/main.tsx` | 引入`model-config.css` |

未改后端接口、provider存储格式、凭据存储或账号策略字段；未新增模型调用路径。

## 3. 关键行为

1. **状态与草稿**：`models:services`是一个页面级草稿注册，内部按五类能力分别保存draft、baseline、busy、错误、通知、测试结果和模型候选。状态为“读取中/读取失败/未配置/待保存/已配置”；读取失败不再显示成“未配置”。
2. **过期结果**：模型候选和测试结果带draft指纹；改地址、来源、模型、协议或工具声明后，旧候选/结果不再展示。外部provider更新会保留脏草稿并提示来源已变。
3. **凭据边界**：密钥不回填；换origin且未重填密钥时，获取、测试、保存均被前端拒绝并提示重填；空密钥不会进入保存请求。跨origin提示挂在API Key字段，而不是服务地址字段。
4. **测试与保存分离**：测试使用当前草稿但不保存；HTTP 200且`result.ok=false`显示业务失败，不误报成功；保存成功才显示保存反馈和“去分配给账号”。
5. **视图转接**：服务→账号、账号→服务、设置摘要→服务、设置→账号均不卸载另一视图；从设置转接时只对`settings` owner准入，位于模型配置时不再多余丢弃服务/账号草稿。离开模型配置页仍按page/all scope覆盖两个视图和高级编辑。
6. **布局**：宽窗口为224px能力索引+纸页，纸页内服务接入/模型选择两栏；≤900px指数转为单行横向滚动列表，纸页转单栏；窄屏隐藏索引状态标签但保留能力名称与描述。纸页footer的旧`flex:0 0 100%`被覆盖，测试/保存按钮不再被裁掉。账号区在模型配置作用域改为单列纸页，服务授权与媒体选项行占满宽度。

## 4. 验证与证据

### 4.1 门控

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 本轮命令 |
| `npm test` | **131文件、1228项通过、1项既有跳过** | `test-results/model-config/final-vitest.log`（如未单独留存，以本轮终端输出为准） |
| `npm run desktop:build` | 通过 | `test-results/model-config/final-build.log`（同上） |
| `npm run ui:tokens:check` | 通过 | Character tokens: up to date |
| `git diff --check` | 通过 | 无空白错误 |

### 4.2 自动化测试

新增`test/models-page.test.tsx`（11项通过）：

- 页面级`models:services`注册与五能力状态；loading/failure与未配置区分。
- 每能力草稿独立，切换能力后保留，discard恢复baseline。
- 文本工具声明/语音音色字段归属；歧义初始化不自动选择。
- 跨origin且未重填密钥时获取/测试/保存被拒绝；重填后可测试。
- 空密钥不进入保存请求；provider刷新保留脏草稿并提示来源变化。
- 保存失败保留输入、错误反馈与脏草稿；保存成功清空secret并标记feedback。
- HTTP 200 + `result.ok=false`不保存、不清空草稿；旧模型候选在draft变化后失效。

补充`test/settings-navigation.test.tsx`（14项通过）：旧`#/settings`、`#/models`入口；从摘要打开服务视图；已在模型配置时视图转接只准入设置草稿；其他页面进入账号使用时覆盖page/all草稿。`test/provider-manager.test.tsx`（5项通过）确认高级编辑page owner、共享切换准入及原有保存/删除/凭据逻辑。

### 4.3 隔离浏览器探针

`test-results/model-config/probe.mjs`以内存fixture拦截`/providers`、`/accounts/10001/policy`、`/accounts/10001/effective`，不启动Core、QQ或真实模型。

- 开发版（Vite 50320）：**13/13通过**；1440×900、599×812；白昼/晚风；普通/减少动效。
- 生产dist（50322静态服务器）：**13/13通过**；同一fixture。
- 截图：`test-results/model-config/shots/01-account-daylight-1440.png`、`02-services-daylight-1440.png`、`02b-services-footer-daylight-1440.png`、`03-account-policy-daylight-1440.png`、`03b-account-rows-daylight-1440.png`、`04-settings-summary-daylight-1440.png`、`05-services-narrow-599.png`、`06-services-nightwave-1440.png`、`07-account-narrow-599.png`、`08-account-nightwave-1440.png`、`09-settings-summary-nightwave-1440.png`；生产副本在`test-results/model-config/prod/shots/`。

探针覆盖：默认account与唯一页标题/唯一Dock；服务视图五能力与两栏纸页；索引换能力不换路由；服务草稿跨能力、跨视图、跨主题保留；账号策略五类行与完整卡片；设置只读摘要及打开服务；高级服务可编辑表面；599px横向能力列表与单栏纸页；窄屏账号策略；两主题可读性；减少动效抑制workspace transition。

### 4.4 原生Electron

`test-results/model-config/electron-check.cjs`使用隔离userData、生产dist、内存provider/policy/effective，不加载preload/Core/QQ。

| 缩放 | 结果 | 关键测量 |
| --- | --- | --- |
| 100% | **3/3通过** | dpr=1，1440×900，唯一h1与Dock；服务纸页1076px、两栏、无纸页/文档横向溢出；账号策略5行 |
| 125% | **3/3通过** | dpr=1.25，1443×902，同一布局约束；服务纸页1076px、两栏、无溢出 |

截图：`test-results/model-config/shots/electron-1-model-account.png`、`electron-1-model-services.png`、`electron-1-model-nightwave.png`及对应的`electron-1.25-*`。

## 5. 与MC-0～MC-5的对照

| 工作包 | 状态 | 说明 |
| --- | --- | --- |
| MC-0 冻结现状 | 完成 | 服务/账号接口与存储未改；全量既有测试通过 |
| MC-1 工作区与入口 | 完成实现方自验 | 双视图、设置只读摘要、旧入口、页面owner、视图常驻 |
| MC-2 服务纸页 | 完成实现方自验 | 五能力、状态、测试/保存、密钥、高级管理 |
| MC-3 账号纸页 | 完成实现方自验 | 完整策略保留，纸页视觉与单列布局 |
| MC-4 视觉/响应式/动效 | 完成实现方自验 | 两主题、599px、减少动效、100%/125%原生 |
| MC-5 测试与记录 | 本文完成实现方部分 | 独立复核未做 |

### 5.1 151清单逐项状态

只记录本轮实际执行到的证据，未执行项不得视为通过。

**已执行并有直接证据**

- MC-N03、MC-N04、MC-N05（入口与摘要转接）、MC-S01、MC-S02、MC-S04、MC-S05、MC-S09、MC-S10、MC-S15（可编辑表面与既有payload保留测试）；MC-V中的双主题、599px、减少动效、唯一标题/Dock、纸页与账号布局、原生100%/125%。
- MC-S16沿用既有`provider-manager.test.tsx`的impact/凭据确认测试，本轮未新增多账号真实后端影响样本。

**部分执行**

- MC-N01：直接路由、默认account、唯一标题/Dock已验；Dock/MoreMenu进入模型的独立点击未在本轮探针中重做。
- MC-N02：视图切换与ARIA/路由已验；未对每次切换做网络写入计数。
- MC-N06：设置摘要与账号转接的owner scope已测；其他业务页构造草稿的组合未逐一重跑。
- MC-N07：主题/减少动效/provider刷新已验；SSE与外部目录并发更新未新增专项探针。
- MC-N08：完整草稿/退出协议沿用既有套件；未新增模型配置专属退出丢失响应样本。
- MC-S03：五能力草稿独立、chat/audio字段归属已测；视频协议切换未单独断言。
- MC-S06：新地址+新密钥保存、空密钥不进入请求已测；保存后复用同一地址真实凭据未连接真实服务，只按现有边界保留。
- MC-S07：保存失败保留草稿已测；凭据库不可用仅以error注入，未连接桌面safeStorage/DPAPI真实故障。
- MC-S08：候选失效与手动输入保留已测；空数组/鉴权失败/超大响应的既有专门用例未新增。
- MC-S11～MC-S13：费用提示、sample展示和未知结果沿用既有代码/全量测试，未新增专项探针。
- MC-S14：其他能力保留依赖既有后端与provider编辑payload测试；未做单能力保存后的完整provider目录快照。
- MC-A01～MC-A10：账号策略逻辑未改，本轮只验证渲染/五类行/账号默认选择；未新增policy竞态、旧作用域、effective失败专项。
- MC-R01、R04～R08：未新增可控制响应顺序的竞态探针；现有代码未改这些归属与幂等路径。R02/R03/R09已有“字段锁定/旧列表失效/provider刷新保留脏草稿”的部分自动化证据。
- MC-V：布局、主题、减少动效和原生缩放已验；hover/focus-visible/pressed/disabled/loading/error/success的逐组合截图未全部重做，继续依赖公共组件既有测试与上一轮共享层回归。

**未执行**

- 真实QQ、SnowLuma、真实模型/付费服务、真实凭据库故障。
- 发行EXE重打包与安装包验收。

## 6. 边界与后续

- 本记录为实现方自验，不等于151清单整体通过，也不等于独立复核收口。
- 服务视图没有独立hash；从设置摘要显式进入时不新增历史记录，符合“显式打开”的入口设计。返回/前进仍走现有App历史纪律。
- 高级服务管理中的删除/清除密钥沿用各自确认；若同时存在简易服务草稿，刷新后该草稿会保留并提示来源变化，不以静默丢弃处理。
- 设置摘要继续使用设置弹窗既有的旧外观变量，未扩成第二套主题组件；两主题截图已检查可读性。
- 未提交、未推送、未重新打包EXE；运行态数据与截图留在`test-results/`。

## 7. 后续修复（2026-10-29）

[154独立复核](154-model-config-workspace-independent-review.md)提出的R1无数据更新循环、R2同provider并发保存与R3迟到通知归属，已由[155修复记录](155-model-config-review-fixes.md)处理并完成实现方复验。本记录保持实现方自验范围，不因155改写原有未执行项；MC-2的写入协调与迟到反馈以待独立复验为准。
