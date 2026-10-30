# 模型配置工作区独立复核与修复要求

2026-10-29。复核对象：[153实现记录](153-model-config-workspace-execution.md)对应的当前工作树；依据[150开发方案](150-model-config-development-plan.md)及[151验收标准](151-model-config-acceptance.md)。本方为当前主代理，以独立检查方式复核本轮实现；此前152只复核开发文档，不作为此次实现验收。

## 1. 结论

**暂不通过，不能按完整开发收口。** 当前页面结构、单一设置入口和基础昼夜布局已接入，独立重跑类型检查、全量测试、桌面构建及token同步均通过；但实际React浏览器故障／并发检查复现**2项P1、1项P2**。其中同服务并发保存导致的模型丢失，已另用真实Core与ConfigStore重放确认。

本轮只复核并留证，未修改正式实现、测试断言或业务配置。153的实现方自验保留为历史记录，其未执行的151条目不能据此视为通过。

## 2. 实际范围与证据

检查`App.tsx`、`ModelConfig.tsx`、`Models.tsx`、`ProviderManager.tsx`、`SettingsDialog.tsx`、新增样式及相关测试；核对原始页面职责、草稿注册、请求路径和共享provider保存行为。

| 本次实际执行 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，日志`test-results/model-config-independent/typecheck.log` |
| `npm test` | **131文件、1228项通过，1项既有跳过**，日志`test-results/model-config-independent/vitest.log` |
| `npm run desktop:build` | 正常权限环境通过，日志`test-results/model-config-independent/build-normal.log` |
| token同步／空白检查 | `npm run ui:tokens:check`与`git diff --check`通过 |
| 实际React布局 | 两主题×1440×900、1280×800、1024×720、768×900、375×812、320×740×服务／账号视图，共24个状态，未发现根横向溢出或常规状态pageerror |
| 目录加载与失败 | 实际挂载App，延迟providers及持续503，复现反复Maximum update depth exceeded |
| 同服务并发保存 | 实际点击两个编辑器，受控投递PUT/POST，复现已确认保存模型被覆盖 |
| 真实Core重放 | 临时dataRoot＋MemoryCredentialVault，configureSimpleModel成功后再upsert旧完整provider，确认新增模型消失 |
| 测试迟到 | 测试未返回时刷新provider目录，随后旧测试返回，复现新地址下显示旧测试成功提示 |

初次桌面构建在受限环境出现Vite `EPERM realpath desktop/renderer/index.html`，不将其判作代码问题；改用正常权限环境后通过。未以这次环境失败替代后续正常构建结果。

浏览器均运行真实Vite React页面，以内存HTTP拦截提供账号、服务和策略数据。正常业务数据从未读取；测试未调用真实模型、QQ或SnowLuma。Core重放仅执行本地配置保存，临时目录已按目标前缀及绝对父路径校验后清理。

归档证据：

- [浏览器故障与并发记录](design/character-studio/model-config/implementation-review/browser-review.json)
- [真实Core模型丢失记录](design/character-studio/model-config/implementation-review/core-lost-update.json)
- [24状态布局记录](design/character-studio/model-config/implementation-review/layout-review.json)
- [并发保存后的页面](design/character-studio/model-config/implementation-review/shared-provider-after.png)
- [新地址显示旧测试成功提示](design/character-studio/model-config/implementation-review/stale-test-notice.png)

本次诊断脚本位于`test-results/model-config-independent/browser-review.mjs`、`core-review.mts`及`layout-review.mjs`；构建日志和截图也在该隔离目录。成品源码指纹见[复核快照](design/character-studio/model-config/implementation-review/source-snapshot.json)。

## 3. R1：无provider数据时父子状态回传无限循环（P1）

位置：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)92、158–180行；[ModelConfig.tsx](../desktop/renderer/src/pages/ModelConfig.tsx)将`setStatuses`作为回调传入。

触发：冷打开`#/model-config`，让`GET /providers`延迟，或一直返回503。即便当前显示默认“账号使用”，隐藏服务视图也已挂载，因此同样触发。

根因：`const providers = data?.providers ?? []`在无data时每次创建新数组。statuses的useMemo依赖providers，因此每次父子更新都产出新对象；effect回调`onStatusChange(statuses)`又更新父组件状态，引发下一轮。读取状态从未静止，失败后会持续循环。

实际复现：延迟1500ms一轮捕获22条Maximum update depth exceeded；持续失败800ms捕获8条同类循环告警及2条503资源错误。数量与调度有关，不作为固定断言；关键是无数据期间反复触发同一更新循环，成功加载后才可停下。这不是单纯显示一条错误提示。

影响：模型工作区加载慢／失败时持续消耗渲染资源，默认账号视图也受影响。现有hook模拟测试单独调用ModelsPage并记录回传对象，没有真实父组件setState，因而未捕获此循环。

修复要求：稳定无数据集合的引用或稳定状态派生及通知，避免相同含义的状态不断向父组件写入。保留加载／失败与未配置的区别，不能通过不挂载错误状态或隐藏控制台来规避。

复验：真实挂载ModelConfigPage／App，providers延迟、首次失败、重试、恢复成功、空列表均覆盖；断言无更新深度告警、无重复状态提交循环，两个视图仍可操作。对应MC-S01及MC-N07。

## 4. R2：简易与高级编辑未共享写入准入，成功模型可被旧payload删除（P1）

位置：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)326–365、470–476行；[ProviderManager.tsx](../desktop/renderer/src/components/ProviderManager.tsx)42–60行。

当前高级edit入口只在打开编辑时检查一次`models:services`；后续高级busy只锁定ProviderManager自己的控件。简易保存只检查自己的rowBusy，未感知同provider的高级请求。两个编辑面仍可并行提交，不能由“同一页面”或ConfigStore串行落盘推断不会覆盖。

实际复现步骤：

1. 同一服务包含`chat-old`等五类模型。展开高级管理并编辑同一服务，将URL改为同origin的`/advanced`。
2. 点击“保存服务修改”，暂缓该完整provider PUT的网络投递；此时简易“保存模型服务”仍可用。
3. 简易模型名改为`chat-added`并保存，POST `/providers/simple`成功返回；服务目录包含旧五模型＋`chat-added`，界面已报告保存成功。
4. 放行旧高级PUT。它携带打开高级编辑时的五模型完整快照；最终目录只剩旧五模型，`chat-added`被删除，settingsModels标记也回到旧值。

真实Core重放同一顺序：`configureSimpleModel`返回的provider含`chat-added`；之后`upsertProvider`收到捕获的旧完整payload，返回的provider不再含此模型。后端现有配置替换行为没有CAS；这证实浏览器fixture的结果不是凭空模拟出来的删除。

影响：两个操作都成功，先成功保存的模型及其引用基础却可能被后到快照覆盖。旧HTTP请求在网络中延迟是正常可发生的情况，配置写入串行队列不能修复其陈旧payload。该问题违反150§7的共享provider协调及MC-R04，也是153注明未新增并发探针的缺口。

修复要求：为同provider的简易／高级编辑和在途写入建立共享准入或协调；在构造和提交payload前核对源快照。高级草稿未处理完时，不能允许同资源的简易提交，反向同理。不能只在进入高级编辑时清除一次简易草稿，也不能仅禁用能力索引。若选择后端并发校验，须先明确新增契约，不得伪装已有revision。

复验：两方向受控响应／投递顺序、同provider不同能力、不同provider互不误锁、保存后刷新和来源失效均覆盖；已确认成功的数据不得被另一份旧完整payload删除。保留现有凭据与隐藏字段往返。

## 5. R3：请求指纹只约束媒体结果，没有约束成功／失败通知（P2）

位置：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)300–323、454–458行，尤其318行直接`setNotices`。

触发：对`https://api.example.com/v1`点击测试，暂缓返回；测试在途期间由外部修改服务为`/v2`，通过设置只读摘要刷新目录；当前表单已显示`/v2`，再放行旧`/v1`测试的成功响应。

实际结果：当前`/v2`表单下出现“测试请求成功；配置尚未保存。”。请求记录确认测试body的URL仍是`/v1`，本次没有测试`/v2`。这一路径不需要绕过busy字段锁，正常目录刷新即可触发。

根因：resultsFingerprint用于过滤activeResult/sample，但notices和errors仍无条件按能力写入；provider刷新虽然清掉旧结果，迟到回调仍能把旧通知放回来。当前显示为测试成功，而实际成功属于另一份配置。此为既有测试路径迁移后未落实150请求归属要求的验收缺口，不将其冒称本包新增后端错误。

修复要求：结果、通知、错误、busy清理均绑定请求序号、目标、草稿指纹及源provider快照；失效请求不能为当前配置写成功／失败提示。可以明确提示“配置已变化，请重新测试”，不能只隐藏返回媒体后继续显示旧成功。

复验：旧成功、旧失败、模型列表通知、源目录变化／凭据变化、离开后重新进入均覆盖；验证期间相关字段锁定也不能替代来源有效性校验。对应MC-R01/R02/R05。

## 6. 工作包与收口判断

| 工作包 | 本次判断 |
| --- | --- |
| MC-0 | 现状记录和接口／存储范围已核对 |
| MC-1 | 唯一设置摘要和工作区结构已接入；R1导致无数据挂载不稳定，不能整体关闭 |
| MC-2 | 五类纸页基础实现可见；R2共享provider写入协调及R3迟到反馈未通过 |
| MC-3 | PolicyPage业务代码保留；本次检查了两主题基础呈现，未把未重做的完整策略故障矩阵写成通过 |
| MC-4 | 本次24个视图／主题／尺寸状态根无横向溢出；不等同所有控件状态、屏幕阅读器或原生缩放复验 |
| MC-5 | 已形成实现方153及独立方154，但存在未关闭阻塞项，不能收口 |

后续先修R1～R3并补真实组件／受控异步回归，再重新执行适当门控和独立复验。保存响应未知、原生草稿／退出组合、真实服务、屏幕阅读器和发行EXE等151未完成项目仍需单独登记，不能用本次全量单测通过代替。

本轮未提交、推送或重打包EXE；生产源码保持复核开始时的实现内容，仅新增此复核记录、归档证据和导航状态。

## 7. 后续修复（2026-10-29）

R1～R3已由实现方在[155修复记录](155-model-config-review-fixes.md)中处理：稳定空服务集合、页面级简易／高级写入协调与源快照核对、请求序号绑定的结果／通知归属。155另附真实React受控异步探针、开发版／生产dist 13/13、隔离Electron 100%/125%各3/3及全量门控结果。本节不改变上文复核结论；是否关闭各项以新的独立复验为准。
