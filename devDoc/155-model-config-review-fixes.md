# 模型配置工作区154复核修复记录

2026-10-29。修复对象：[154独立复核](154-model-config-workspace-independent-review.md)的R1～R3；实现范围沿用[150开发方案](150-model-config-development-plan.md)/[151验收标准](151-model-config-acceptance.md)。本记录为实现方修复与自验，不代替独立复验；154原结论保留为复核当时状态。

## 1. 结论

R1～R3已在本地代码与受控异步场景中修复：

- R1：无provider数据时不再反复提交状态，延迟、失败、空列表与失败后恢复均不再出现更新深度告警。
- R2：同一provider的简易／高级编辑共享页面级写入准入；高级保存提交前核对源快照，简易保存遇到来源变化时要求显式采用最新信息。受控延迟PUT与真实React点击顺序下，已保存的`chat-added`不再被旧完整payload删除。
- R3：测试、获取模型与保存的迟到响应绑定请求序号和草稿／来源指纹；失效请求不再为当前配置写成功或失败提示，只显示中性的作废说明。

未新增后端契约、未引入revision/CAS字段；协调器为页面实例，无模块级可变状态。

## 2. R1：无provider数据时的更新循环

位置：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)第32、97行。

修复：模块级稳定的`EMPTY_PROVIDERS`替代每次渲染新建的`[]`。`statuses`仍按加载／失败／未配置三态派生，`onStatusChange`的通知含义不变；只消除无数据时集合引用变化导致的父子状态往复。

复验：真实挂载`ModelConfigPage`/`App`，覆盖providers延迟、持续503、空列表、首次失败后重试恢复。四组场景的状态标签分别为读取中、读取失败、未配置、恢复后已配置，浏览器未捕获`Maximum update depth exceeded`。失败场景的2条控制台错误为探针主动返回的503资源错误，不作为循环证据。

## 3. R2：同provider写入准入与旧快照覆盖

新增[service-write-coordinator.ts](../desktop/renderer/src/lib/service-write-coordinator.ts)：由`ModelConfig`每次挂载创建一个协调器实例，供两个编辑面共享。

- 意图锁：简易页为所有存在脏草稿的provider登记`models`意图；高级管理为正在编辑且有修改的provider登记`advanced`意图。同一provider由先登记的编辑面持有，另一侧仍可查看和编辑，但不能提交、清除密钥或删除该服务。
- 写入准入：`begin(providerId, owner)`在无他人写入且锁归属允许时占用；写入一直持有到随后的目录刷新完成，`finally`释放。两个编辑面不能同时提交同一provider。
- 高级快照核对：[ProviderManager.tsx](../desktop/renderer/src/components/ProviderManager.tsx)第72～90行在占用写入后、构造PUT前比较当前provider与打开编辑时的基线；不一致则保留草稿并提示重新读取，不发送旧完整payload。
- 简易来源失效：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)第122～165行在provider目录变化时，为来源已变化的脏草稿标记`sourceStale`，保留草稿与模型名，但不自动覆盖；用户通过“使用最新服务信息”采用当前地址和协议后才可继续测试或保存。来源被删除时清空服务选择并要求重新选择。
- 简易保存第429～496行在提交前检查高级锁／写入，占用写入后保持到刷新结束；保存成功才清除来源失效标记。

两个编辑面同时脏时采用“先登记先持有”，另一侧需先保存或撤销；协调器不提供强制抢占，因此不会互相等待。不同provider互不阻塞。

复验（真实React，受控响应顺序）：

1. 高级管理编辑同一服务并暂缓PUT；简易“保存模型服务”被禁用，页面出现1条高级占用提示。
2. 高级写入在途时简易保存仍被禁用；放行旧PUT后目录保留原五个模型。
3. 简易草稿显示来源变化提示与“使用最新服务信息”；采用后保存恢复可用。
4. 简易保存`chat-added`成功，最终目录为原五个模型加`chat-added`，`noLostModel: true`。

## 4. R3：迟到请求的结果与通知归属

位置：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)第119、267～291行及各请求函数。

- 每个能力维护单调递增的请求序号；请求开始时捕获草稿JSON与来源provider JSON。返回后序号已变化则完全忽略；序号仍当前但草稿或来源已变化，则结果、样本、错误、成功反馈均不写入，只在`requestNotices`中写中性说明（测试／列表／保存分别提示已作废、需重新执行）。
- `busy`只在当前序号上清理，旧请求不能解除新请求的忙碌状态。
- 请求通知与持久成功通知分表存储；provider目录变化时清空旧请求通知与错误，脏草稿来源变化时清除该行旧成功通知。
- “获取模型”使用同一序号与指纹规则，迟到列表不会写入当前草稿的候选。

复验：对`/v1`发起测试并暂缓返回，测试在途期间将服务改为`/v2`并刷新目录，再放行旧`/v1`成功响应。当前表单显示`/v2`，请求记录仍为`/v1`，页面未出现“测试成功”，只显示配置变化后的作废提示。

## 5. 验证与证据

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 132文件、1235项通过、1项既有跳过 |
| `npm run desktop:build` | 通过 |
| `npm run ui:tokens:check` / `git diff --check` | 通过 |
| 定向4文件 | 37项通过：协调器4、服务纸页13、高级管理6、设置导航14 |
| 开发版真实React探针 | 13/13通过 |
| 生产dist真实React探针 | 13/13通过 |
| 隔离Electron 100%／125% | 各3/3通过，无横向溢出 |
| 154场景专项探针 | 6组场景、0错误 |

专项探针为`test-results/model-config-fixes/browser-review.mjs`，使用隔离Vite与内存HTTP夹具，覆盖加载循环、失败循环、空列表、失败恢复、共享provider协调与迟到测试结果；结果在`browser-review.json`，截图在`test-results/model-config-fixes/shots/`（含`shared-provider-after.png`、`stale-test-result.png`）。既有开发版／生产版探针与隔离Electron探针均在修复后重跑；所有预览服务已停止。

一次全量并行运行出现`test/memory-extraction-coordinator.test.ts`等时序断言失败（该文件单跑通过、随后全量132文件全通过）；本批未修改记忆提取模块，不将这次负载抖动计为模型配置回归，也不据此修改无关测试。

## 6. 边界与后续

- 本记录不关闭154，仍需独立复验R1～R3及受控异步回归；也不代表151全部条目通过。
- 保存响应未知、原生草稿与退出组合、真实模型服务、真实凭据库故障、屏幕阅读器与发行EXE验收仍未执行。
- 同provider两端同时脏时由先登记方持有；另一侧必须保存或撤销后再继续，这是本轮选定的协调策略，不是后端并发校验。
- 未提交、推送、打包或替换EXE；未改动运行态业务配置，探针只使用内存夹具与临时目录。

## 7. 后续修复（2026-10-29）

[156独立复验](156-model-config-fixes-independent-recheck.md)确认R1、R3可关闭，R2的旧完整PUT场景通过，但发现删除／清密钥未进入共享写入准入（F1）及最后一个来源删除后缺少恢复入口（F2）。两项已由[157修复记录](157-model-config-delete-and-recovery-fixes.md)处理，并重跑本记录所述154专项与既有探针；本记录原结论保留，R2整体是否关闭以独立复验为准。
