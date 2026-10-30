# 模型配置删除与来源恢复修复独立复验

2026-10-30。对象为[157修复记录](157-model-config-delete-and-recovery-fixes.md)对应的当前工作树，追踪[156独立复验](156-model-config-fixes-independent-recheck.md)F1/F2，并继续核对[154](154-model-config-workspace-independent-review.md)R1～R3。依据仍为[150方案](150-model-config-development-plan.md)/[151验收标准](151-model-config-acceptance.md)。本方独立检查实现、执行门控和受控React场景，不将157的自验数字作为本次结论。

## 1. 结论

**156-F1、F2可关闭；整体仍待修复1项新发现P2：合法服务ID与Object原型属性同名时被共享协调器误锁。** 原154的加载循环、旧PUT覆盖和旧通知迟到场景本次均通过；同服务删除遗漏也已修复。

类型检查、完整桌面构建、token同步与空白检查通过；最终独立全量为**132文件、1244项通过、1项既有跳过**。首轮出现1项插件组合时序超时，单文件复跑及随后全量均通过，原失败日志保留，详见第4节。

本轮只复核与留证，未修改正式实现或现有测试断言，未提交、推送、打包或替换EXE；151中的真实服务、原生组合与发行包未执行项仍保留。

## 2. 上轮问题关闭依据

| 问题 | 本次独立证据 | 判断 |
| --- | --- | --- |
| 156-F1 / 154-R2删除遗漏（P1） | 删除与清密钥在途时简易提交禁用，无插入的POST；反向简易写入在途时删除/清密钥禁用；影响读取、确认等待、刷新等待期间均持有准入；取消、影响失败、清密钥失败、DELETE失败与刷新失败后释放 | 本发现关闭 |
| 156-F2来源缺失恢复（P2） | 最后一个来源删除后“转为新建服务”可达；保留地址、模型名与已填夹具密钥，提交不带旧providerId，确认响应后得到新id；另测剩余1/2个服务及原来源重新出现 | 本发现关闭 |
| 154-R1加载循环 | 延迟、503、空列表、失败后恢复的真实App场景无更新深度告警 | 维持关闭 |
| 154-R2旧完整PUT覆盖 | 高级脏草稿/写入先占用时简易不能提交，采用最新来源后新增模型与旧模型均保留 | 原覆盖与删除交错发现关闭；协调器另有第3节边界问题 |
| 154-R3旧成功通知 | /v1测试等待时刷新为/v2，旧成功返回仅显示作废，不为新地址报成功 | 维持关闭 |

源码核对：`ProviderManager`的`runExclusive`在影响读取或确认之前调用共享`begin`，在操作、目录刷新之后通过`finally`释放；实际GET刷新失败时`usePoll`以错误状态完成，真实页面同样能结束占用。`convertToNewProvider`只清除旧来源id与失效标记，不自动保存，成功后才建立新来源基线。

独立新增交错还验证了不同服务互不误锁：暂缓other-service的清密钥写入，同页面review-service仍可保存。昼夜两套预置均实际检查了影响读取、确认等待和取消恢复；不把这两组局部主题证据扩写成完整视觉矩阵通过。

## 3. R1：合法原型同名服务ID被协调器误判为占用（P2）

位置：[service-write-coordinator.ts](../desktop/renderer/src/lib/service-write-coordinator.ts)28、48、61–73行；消费处包括[Models.tsx](../desktop/renderer/src/pages/Models.tsx)433–435、522–525行和[ProviderManager.tsx](../desktop/renderer/src/components/ProviderManager.tsx)46–49行。

协调器初始`locks/writes`为普通`{}`，后续`Object.fromEntries`也产出带Object原型的普通对象。`begin()`和页面用`record[providerId]`判断占用，没有限定自有键。当providerId为`constructor`或`toString`且该服务没有锁/写入时，读取到的是继承的函数，truthy且不等于`models`/`advanced`，于是把空闲服务误判为另一编辑器持有。`#writes`内部Map本身没有此问题，但导出的快照与`#buildLocks()`查找存在问题。

实际复现（真实App、Vite、1440×900、白昼，内存HTTP夹具）：

1. 仅提供一个已配置服务，分别用`ordinary-service`、`constructor`、`toString`作为id，其他字段完全同形。
2. 打开“服务与模型”并展开高级管理；不编辑、不发保存/删除、不制造任何在途操作。
3. 普通id的保存、删除、清密钥均可用且没有占用提示；两个原型同名id的三项操作均禁用，简易页显示“该服务在高级管理中有未保存修改或正在写入”。三组均无pageerror。

真实Core + MemoryCredentialVault + 临时dataRoot另行接受并保存这三个id，证明夹具没有引入后端禁止的标识。随后为每个id新建空协调器：三组自有锁/写入键均不存在；普通id的读取为undefined、`begin`成功，两个同名id读取为function、`begin`失败。没有真实服务调用或正常业务配置改动。

影响：已有合法配置可正常加载，却不能从工作区保存、删除或清密钥；直接调用协调器准入同样会失败，因此不只是错误的按钮提示。该问题来自155新增协调器的键查找边界，本次157关闭删除遗漏时补充发现，不将其误归因为157的来源转换函数引入。

**修复要求：** 快照初始值、`#buildLocks`、`writes`导出及所有消费端须保持自有键语义。可以统一使用无原型字典，或在全部读取路径显式检查`Object.hasOwn`；只修`begin()`而保留页面的继承属性读取仍会禁用按钮。不得临时禁止这些原本合法的id来绕过兼容要求。新增回归应覆盖普通id、原型同名id在空闲/意图锁/在途写入/释放后的行为，以及两个编辑面的真实按钮和提交。

证据：[真实React三组记录](design/character-studio/model-config/delete-fixes-independent-recheck/ids.json)、[真实Core与空协调器记录](design/character-studio/model-config/delete-fixes-independent-recheck/id-core.json)、[constructor误锁页面](design/character-studio/model-config/delete-fixes-independent-recheck/legal-id-constructor.png)。

## 4. 本次验证与异常记录

| 本次独立执行 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test`首轮 | 131文件通过/1文件失败；1243项通过/1失败/1跳过。失败为agent-plugin-composition中无工具模型运行hook的等待超时 |
| 失败文件单独复跑 | 1文件20项通过 |
| 辅助构建和浏览器结束后再次全量 | 132文件1244项通过/1项既有跳过 |
| `npm run desktop:build` | 通过，包含核心、renderer、main、preload；非发行包构建 |
| `npm run ui:tokens:check` / `git diff --check` | 通过 |
| 原六组React场景 | 加载延迟/失败/空列表/恢复、旧PUT冲突、旧成功通知，均通过 |
| 157八组React场景独立重跑 | 删除、取消/失败、清密钥、反向写入与0/1/2剩余来源、目录恢复，均通过 |
| 本次新写七组交错 | 昼夜影响/确认等待、取消、影响失败、清密钥取消/失败、刷新等待/失败、不同服务独立，均通过 |
| 三组合法id对照 | 普通id正常，constructor/toString复现第3节误锁 |
| 真实Core与协调器 | 合法id均可持久化；空协调器对原型同名id拒绝准入，确认根因 |

首轮全量与构建并行，插件组合文件发生等待超时；后续单文件及全量都未稳定复现。不能据此断言根因必然是资源争用，也没有证据把它归入本批前端改动；本轮未修改无关测试、放宽超时或删除失败记录。

补充探针第一版复用了另一个探针端口，启动冲突后已改独立端口；随后在确认框打开时用默认可访问树定位背景按钮而超时，改为读取包含隐藏背景的DOM状态后七组均通过。这两类为探针问题，不计产品缺陷。归档`extra-fixed.json`为校正后结果；`ids.json`的`errors:[]`表示探针执行正常，不表示被观察的三个产品状态全部通过。

## 5. 证据与范围

证据、日志和SHA-256见[158证据目录](design/character-studio/model-config/delete-fixes-independent-recheck/README.md)。脚本在仓库`test-results/model-config-final-recheck/`：`baseline.mjs`复用原六组HTTP夹具与步骤，`delete-recheck.mjs`复用157八组夹具与步骤后独立运行；`extra-fixed.mjs`、`ids.mjs`、`id-core.mts`为本次另写的补充检查。所有结论来自本次运行。

实际浏览器均为Vite真实App + 内存HTTP夹具；真实Core仅用无实例、禁HTTP服务的临时配置与MemoryVault。未调用真实QQ/模型/SnowLuma，未读取或改动正常业务配置。临时Core目录按绝对父路径与专用前缀校验后清理，所有探针浏览器与预览服务器已关闭。

本次未独立重做完整生产dist、Electron原生缩放、154的24状态布局、保存结果未知、原生草稿/退出组合、屏幕阅读器或发行EXE验收；既有自验/历史证据保留原身份，151未执行项不自动变为通过。修复第3节并补相应回归后再独立复验。

## 6. 后续修复（2026-10-30）

第3节原型同名服务ID误锁已由实现方在[159修复记录](159-model-config-prototype-id-fixes.md)中处理：协调器快照、锁构建与写入导出改为无原型字典，`begin()`及两个编辑面的占用读取使用自有键判断；同页`previousProviderById`改为`Map`，避免来源变化对同名id失效。159另附普通/`constructor`/`toString`的简易保存、高级保存、清密钥、删除与来源变化真实React探针4组，154专项6组、157专项8组、开发版／生产dist 13/13、Electron 100%/125%及全量132文件1248项结果。本节不改变上文复验结论，该P2是否关闭以新的独立复验为准。
