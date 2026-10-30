# 模型配置删除准入与来源恢复修复记录

2026-10-29。修复对象：[156独立复验](156-model-config-fixes-independent-recheck.md)的F1、F2；前序为[154复核](154-model-config-workspace-independent-review.md)与[155修复](155-model-config-review-fixes.md)。本记录为实现方修复与自验，不代替独立复验；156原结论保留。

## 1. 结论

- F1：删除与清除密钥已纳入页面级共享写入准入。删除／清密钥从读取影响、等待确认、实际写入到目录刷新期间占用同provider；简易保存不能在该窗口插入，反向简易写入在途时删除／清密钥也不能开始。取消、请求失败、刷新失败与卸载中止都会释放占用。
- F2：最后一个来源被删除后，脏草稿页仍保留输入，并出现可达的“转为新建服务”。该操作清除旧providerId与来源失效标记，保留地址、模型名、已填密钥和协议；保存时按新建服务提交，不静默恢复已删除服务，也不自动提交。来源恢复时仍可通过“使用最新服务信息”沿用原服务。

未新增后端契约，删除仍沿用现有`DELETE /providers/:id`语义；修复点在页面同资源写入协调。

## 2. F1：删除／清密钥纳入共享写入

位置：[ProviderManager.tsx](../desktop/renderer/src/components/ProviderManager.tsx)第92～125行。

- 新增`beginExclusive`/`runExclusive`：先检查简易编辑是否持有该provider，再调用`writeGuard.begin(providerId, 'advanced')`；占用成功后执行操作，`finally`统一`end`。
- 删除第119行在`previewAndDeleteProvider`之前占用，因此影响读取、确认框等待、DELETE和随后的`refresh()`全程属于同一写入窗口。确认取消、影响读取失败、DELETE失败或刷新异常都由`finally`释放。
- 清密钥第110行同样在确认前占用，确认等待和凭据DELETE期间不可被简易保存插入。
- 简易保存继续在第429～496行占用`models`写入并保持到刷新结束。两个方向均由协调器的在途写入与意图锁判定，按钮disabled只是界面提示，不是唯一防线。
- 不同provider仍按id独立；删除未引用的其他服务不会被简易草稿阻塞，除非协调器显示同一资源正在写入。

复验（真实React，受控响应顺序）：删除在途时编辑简易模型，保存按钮禁用、写入窗口内`/providers/simple`请求数为0；释放DELETE后服务被删除，随后转为新建并保存，新服务包含`chat-during-delete`且请求发生在删除之后。取消删除、DELETE失败、刷新失败（单元）与清密钥窗口均验证释放；简易保存在途时删除／清密钥按钮禁用且没有DELETE请求。

## 3. F2：缺失来源的“转为新建服务”

位置：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)第527～542行、第620～628行。

- 新增`convertToNewProvider()`：把当前能力草稿的`providerId`置空并清除`sourceStale`，保留`baseUrl`、`modelId`、`secret`、`adapterId`、`supportsTools`、`voice`等输入；同时清空旧来源的模型候选、测试结果和请求通知。
- 来源警告在`activeProvider`存在时继续提供“使用最新服务信息”；不存在时提供“转为新建服务”。不再出现提示可新建但页面没有入口的状态。
- 保存时草稿无`providerId`，走新建服务请求；保存响应返回新id后才写入基线与界面。不会自动选择其他现有服务，也不会把旧providerId带到请求中。
- 来源目录恢复时，`activeProvider`重新存在，警告切回“使用最新服务信息”；采用后沿用原服务保存。带密钥草稿在删除后转换时密钥仍保留在草稿中，保存请求可继续携带。

复验：0个剩余服务时转换并保存成功；1个和2个其他服务时均只新建`custom-*`，其他服务保持不变；来源删除后重新出现时可采用原服务保存；带`sk-kept`密钥草稿的转换保存请求保留密钥且不带旧providerId。

## 4. 验证与证据

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 132文件、1244项通过、1项既有跳过 |
| `npm run desktop:build` | 通过 |
| `npm run ui:tokens:check` / `git diff --check` | 通过 |
| 定向4文件 | 46项通过：协调器4、服务纸页17、高级管理11、设置导航14 |
| F1/F2真实React专项 | 8组场景、0错误 |
| 154原R1～R3专项 | 6组通过、0错误 |
| 开发版／生产dist既有探针 | 各13/13通过 |
| 隔离Electron 100%／125% | 各3/3通过，无横向溢出 |

F1/F2专项脚本为`test-results/model-config-delete-fixes/browser-delete-review.mjs`，结果`browser-delete-review.json`；截图包括`shots/delete-pending-converted.png`、`delete-cancel-save.png`、`delete-failure-save.png`、`clear-key-pending.png`、`simple-write-blocks-delete.png`、`deleted-source-remaining-1.png`、`deleted-source-remaining-2.png`、`deleted-source-restored.png`。全部使用隔离Vite、内存HTTP夹具与临时确认框，未连接真实模型/QQ，未改运行态配置；预览服务已停止。

删除/清密钥确认在测试中由探针显式点击，仅影响内存夹具；没有真实Core或后端删除重放，156的真实Core删除结论保留为问题背景。

## 5. 边界与后续

- 本记录不关闭156，仍需独立复验F1、F2及受控交错；也不代表151全部条目或真实服务、原生草稿/退出、屏幕阅读器、发行EXE通过。
- “转为新建服务”只解除来源失效并保留输入，不自动保存；用户仍需核对地址、协议与模型名。
- 同provider两端同时脏时沿用155的先登记先持有策略；删除／清密钥与保存共用同一在途写入名额。
- 未提交、推送、打包或替换EXE。

## 6. 后续修复（2026-10-30）

[158独立复验](158-model-config-delete-fixes-independent-recheck.md)确认F1、F2可关闭，另发现合法服务ID与Object原型属性同名时被协调器误锁（P2）。该问题已由[159修复记录](159-model-config-prototype-id-fixes.md)处理并重跑本记录F1/F2专项；本记录原结论保留。
