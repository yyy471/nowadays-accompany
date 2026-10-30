# 模型配置工作区修复独立复验

2026-10-29。对象为[155实现方修复](155-model-config-review-fixes.md)后的当前工作树，追踪[154独立复核](154-model-config-workspace-independent-review.md)的R1～R3，依据[150方案](150-model-config-development-plan.md)/[151验收标准](151-model-config-acceptance.md)。本次独立执行源码检查、实际React受控交错和真实Core重放，不以155的自验数字代替本方证据。

## 1. 结论

**暂不收口：R1、R3可关闭；R2的旧完整PUT覆盖场景已修复，但同服务删除尚未纳入共享写入准入，R2仍保留。另发现1项P2草稿恢复问题。**

独立重跑类型检查、全量132文件1235项通过/1项既有跳过、完整桌面构建、token同步与空白检查均通过。自动化通过不能覆盖下述实际React与Core复现结果。

本轮只新增复验文档、证据与导航记录，未修改正式实现或现有测试断言，未提交、推送、打包或替换EXE。

## 2. 上轮问题复验

| 154条目 | 本次实际证据 | 判断 |
| --- | --- | --- |
| R1（P1）无provider更新循环 | 延迟1500ms、持续503、空列表、失败后重试恢复；真实挂载App，均无Maximum update depth exceeded；失败/未配置/恢复标签正确 | 本发现关闭 |
| R2（P1）简易/高级旧快照覆盖 | 高级脏草稿及延迟PUT时，简易提交禁用；高级成功后简易保留输入并要求采用最新来源；随后保存chat-added，旧五模型与新模型均保留 | 原PUT场景通过，但删除写入遗漏，见下节；整体不关闭 |
| R3（P2）旧测试通知迟到 | /v1测试在途，刷新为/v2再返回旧成功；无成功误报，显示作废。另补旧失败与旧模型列表：不显示旧错误/选项，busy正常结束 | 本发现关闭 |

R1的503资源错误为夹具主动制造，不是更新循环；捕获的更新深度告警为0。R3本次关闭的是154已发现的请求归属缺口，不宣称所有凭据版本、原生退出或151全矩阵都已验收。

代码修复方向有效：稳定空集合、页面实例协调器、源快照比较与请求票据均已接入。问题在于协调器只包围高级保存，不能由此推导所有高级写入已协调。

## 3. F1 / 154-R2未关闭：删除在途可与同服务简易保存交错（P1）

位置：[ProviderManager.tsx](../desktop/renderer/src/components/ProviderManager.tsx)101–111行；对照72–90行高级保存，以及[Models.tsx](../desktop/renderer/src/pages/Models.tsx)429–496行简易保存。

`save()`通过`writeGuard.begin/end`占用服务，而`remove()`只设置ProviderManager自己的busy，再经impact和确认调用DELETE；它没有登记共享写入。119行按钮上的`lockedBySimpleFor`只能阻止已有简易草稿时发起删除，不能阻止删除在途后新增简易草稿与提交。同类遗漏也存在于92–100行`clearKey()`；本次动态证据针对删除，不将清密钥的具体交错冒称已执行。

实际React复现（1440×900、白昼、隔离Vite、内存HTTP夹具）：

1. 服务含原五模型，简易页初始无脏草稿。展开高级管理，点击删除；影响预览成功，用户明确确认。
2. 暂缓DELETE的网络投递/完成，等待确认框退出。简易模型名改成`chat-during-delete`，输入值稳定后，“保存模型服务”仍可用。
3. 点击简易保存，POST成功，页面显示“模型服务已保存”；模型目录含`chat-during-delete`。
4. 放行先前DELETE。服务被删除，新保存模型随服务消失。浏览器无pageerror。

独立真实Core重放捕获的简易请求：临时dataRoot、MemoryCredentialVault、无实例、禁用HTTP服务；`configureSimpleModel`确认返回含`chat-during-delete`的六模型目录，再执行迟到的`deleteProvider`返回`removed:true`；后续同来源保存明确报“该服务已被删除，请重新选择”。这证实丢失结果符合真实Core语义，不是fixture自行发明的后端行为。没有给后端现有删除语义另记缺陷，修复点是页面同资源写入协调。

**修复要求：** 删除、清密钥等同provider写操作也要进入同一共享写入准入；等待影响读取/确认、实际写入和目录刷新期间须有明确占用/再校验策略，取消和异常都释放。删除先取得准入时，简易保存不能成功插入其间；简易先取得准入时，删除不能绕过。不同provider仍应独立，不能只以整个页面全锁掩盖资源归属。

复验至少覆盖：删除在途→简易保存、简易保存→删除、确认等待期间产生新草稿、取消/失败/刷新异常释放，以及清密钥对应路径。仅检查按钮在点击前的disabled或协调器单元测试不够。

证据：[实际React交错记录](design/character-studio/model-config/implementation-recheck/extended.json)、[真实Core重放](design/character-studio/model-config/implementation-recheck/core-delete-replay.json)、[删除完成后页面](design/character-studio/model-config/implementation-recheck/delete-versus-save.png)。

## 4. F2：最后一个来源被删除后，脏草稿缺少恢复入口（P2）

位置：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)565行及620–623行；关联527–544行`applyLatestProvider()`。

触发：只有一个provider；简易模型名改为`chat-unsaved`形成脏草稿；外部删除该provider，再通过设置中的“刷新摘要”读取新目录。

实际结果：输入保留且正确提示“此服务已不存在；当前草稿保留，请重新选择来源或新建服务”，但`providers.length > 0`为false，整个服务来源选择框被隐藏；`activeProvider`为false，采用最新信息按钮也不渲染。旧providerId及sourceStale仍保留，测试/获取/保存均禁用，当前能力页没有“切为新建并保留草稿”的操作。单纯继续修改URL/模型不能解除失效状态。

当前可通过导航放弃草稿或先在另一能力创建服务再回来选择绕行，但这不能算提示所称的当前页恢复能力；不应迫使用户放弃已保留的编辑才能新建。155写到的来源删除后清空选择没有在这条渲染路径实际发生，虽然`applyLatestProvider`中有处理缺失来源的分支，该分支没有可点击入口。

**修复要求：** 缺失来源且目录为空时仍提供可达的“新建服务/转换为新建”操作，明确处理旧providerId和sourceStale并保留可复用输入；不能通过静默恢复已删除服务或自动提交解决。补0/1/多剩余服务、目录恢复、带密钥草稿的真实组件回归。

证据：[场景记录](design/character-studio/model-config/implementation-recheck/extended.json)中的`dirty-last-provider-removed`：模型名仍为`chat-unsaved`，来源选择框数量0、采用按钮0、保存禁用；[实际截图](design/character-studio/model-config/implementation-recheck/deleted-dirty-source.png)。对应MC-S07/MC-R09的来源失效恢复。

## 5. 验证与范围

| 本次独立执行 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 132文件、1235项通过、1项既有跳过 |
| `npm run desktop:build` | 通过，含核心、renderer、main、preload；不是发行包构建 |
| `npm run ui:tokens:check` | 通过 |
| `git diff --check` | 通过 |
| 原六组受控React场景 | 延迟/失败/空目录/恢复、原PUT冲突、旧成功响应均通过 |
| 新增四组受控React场景 | 旧模型列表和旧失败隔离通过；删除交错、来源删除恢复复现F1/F2 |
| 真实Core重放 | 确认先成功简易保存可被迟到删除移除；临时目录已校验父路径与前缀后清理 |

实际浏览器为当前Vite开发页面、无头Chromium、内存HTTP夹具，未连接真实模型/QQ/SnowLuma，未读取或修改正常业务配置。删除确认由探针明确点击，仅影响夹具；Core重放仅操作隔离临时配置。页面与预览服务器均已关闭。

本次没有重跑154的24状态布局矩阵，也没有独立重做155所述生产dist/Electron缩放探针；它们分别保留为历史独立证据和实现方证据，不冒称本次独立通过。真实模型、真实凭据库故障、原生草稿/退出组合、屏幕阅读器和发行EXE仍待验收，不据此关闭151所有条目。

归档日志、源码SHA-256与证据说明见[复验目录](design/character-studio/model-config/implementation-recheck/README.md)。诊断脚本在`test-results/model-config-recheck/`，六组基础场景复用155的HTTP夹具并独立重跑；新增四组交错与Core重放由本次复验另写。第一版删除探针误用了`dialog`而正式确认框为`alertdialog`，定位超时后已校正并重跑；本文仅使用校正后无探针错误的记录。

## 6. 后续修复（2026-10-29）

F1删除／清密钥的共享写入准入与F2缺失来源恢复已由实现方在[157修复记录](157-model-config-delete-and-recovery-fixes.md)中处理：删除和清密钥从影响读取、确认等待到写入、刷新全程占用同provider，取消／失败／刷新异常均释放；“转为新建服务”在来源缺失时保留地址、模型名和已填密钥，清除旧providerId与失效标记后再保存。157另附8组真实React受控交错、154原6组、开发版／生产dist 13/13、Electron 100%/125%及全量132文件1244项结果。本节不改变上文复验结论，F1/F2是否关闭以新的独立复验为准。
