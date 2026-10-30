# 模型配置原型同名ID修复独立复验

2026-10-30。对象为[159实现方修复](159-model-config-prototype-id-fixes.md)后的当前工作树，追踪[158独立复验](158-model-config-delete-fixes-independent-recheck.md)R1（P2），并检查[154](154-model-config-workspace-independent-review.md)、[156](156-model-config-fixes-independent-recheck.md)已发现问题的回归。依据仍为[150方案](150-model-config-development-plan.md)/[151验收标准](151-model-config-acceptance.md)。本次独立执行检查，不以159的自验数字代替本方证据。

## 1. 结论

**本轮修复复验通过：158-R1可关闭，未发现新增阻塞问题。** 154、156、158已发现的问题链在本地代码与本次自动化范围内均已收口；这不等同151全部条目或发行EXE验收完成。

独立全量为**132文件、1248项通过、1项既有跳过**，类型检查、完整桌面构建、token同步与空白检查均通过。本次20组真实React场景、7组协调器检查均通过。

本轮只新增独立复验记录、证据与导航，未修改正式实现或现有测试断言，未提交、推送、打包或替换EXE。

## 2. 修复核对与关闭依据

核对[service-write-coordinator.ts](../desktop/renderer/src/lib/service-write-coordinator.ts)、[Models.tsx](../desktop/renderer/src/pages/Models.tsx)、[ProviderManager.tsx](../desktop/renderer/src/components/ProviderManager.tsx)及相关回归测试。

- 初始快照、锁构建与写入导出均通过`ownRecord`生成无原型字典；`begin`和两个编辑面的占用读取都检查`Object.hasOwn`，不存在只修协调器而遗漏页面按钮的情况。
- 来源快照跟踪由`Map<string,string>`保存，目录变更使用`get`比较，来源缺失与恢复沿用原失效/采用流程。
- 未禁用、改写原本合法的服务id，未改变后端接口、持久化格式、凭据边界或页面级写入归属规则。

| 本次实际场景 | 结果 |
| --- | --- |
| 真实React：ordinary-service、constructor、toString、hasOwnProperty、valueOf | 五种id初始保存/删除/清密钥均可用，无虚假占用提示；每组实际执行简易POST、高级PUT、凭据DELETE、服务DELETE，均成功 |
| 同名id高级脏草稿/在途写入 | 简易提交正确禁用；高级完成后后续操作可继续，没有释放后残留误锁 |
| constructor来源变更 | 脏模型名保留，要求采用最新来源；采用后保存请求仍带constructor且使用新地址，无静默换服务 |
| 独立协调器：上述五种id + isPrototypeOf、toLocaleString | 空闲可准入；同服务第二个写入被拒；错误owner不能释放；意图先到先持有与释放后移交正确；不同服务独立；最终锁/写入自有键移除，快照仍无原型，可再次准入 |

以上实际页面六组、协调器七组均通过。158的真实Core接受合法id证据保持有效；本批后端未变，本次没有重复Core持久化重放，不将协调器直测冒称Core测试。

## 3. 既有问题回归

另独立重跑原六组和删除/恢复八组真实React场景：

| 问题链 | 本次结果 |
| --- | --- |
| 154-R1：无provider更新循环 | 延迟1500ms、持续503、空列表、失败后恢复，无Maximum update depth exceeded；失败/空态/恢复标签正确 |
| 154-R2：简易与高级旧PUT覆盖 | 高级脏草稿及PUT在途时简易保存禁用；采用最新来源后chat-added与旧五模型均保留 |
| 154-R3：旧成功通知迟到 | /v1测试在途刷新至/v2，旧成功返回不为新地址报成功，显示作废 |
| 156-F1：删除/清密钥遗漏共享准入 | 删除或清密钥在途时简易不能插入POST，反向简易写入在途时删除/清密钥禁用；删除取消/失败后可继续保存 |
| 156-F2：最后一个来源删除后无法恢复 | 转为新建保留地址、模型名与已填夹具密钥，请求不带旧providerId；0/1/2个剩余来源及原来源重新出现的恢复均通过 |

原六组与八组均无探针错误；主动503的资源错误为夹具预期，不作为更新循环。158的旧失败/旧模型列表、昼夜确认等待/取消、刷新失败释放等额外交错保留为历史独立证据，本轮未全部重复，不计入本次20组。

## 4. 本次独立门控

| 命令/检查 | 结果 |
| --- | --- |
| `npm test` | 首轮即通过：132文件、1248项通过、1项既有跳过 |
| `npm run typecheck` | 通过 |
| `npm run desktop:build` | 通过，含核心、renderer、main、preload；非发行包构建 |
| `npm run ui:tokens:check` | 通过 |
| `git diff --check` | 通过 |
| 六组id实际React + 六组原故障 + 八组删除/恢复 | 合计20组通过 |
| 协调器直测 | 7种id的空闲/意图锁/写入/释放与独立性均通过 |

本次全量先单独运行，通过后才开始构建与浏览器检查；没有复现158首轮的插件组合等待超时，也没有调整测试超时或修改无关实现。核对命令退出码与新日志，不沿用159结果。

## 5. 证据、环境与边界

证据归档见[160证据目录](design/character-studio/model-config/prototype-id-independent-recheck/README.md)：实际React结果、协调器结果、截图、完整门控日志与源码SHA-256。

脚本在仓库`test-results/model-config-id-independent/`。`browser-ids.mjs`复用159的真实App/HTTP夹具和动作，并扩展hasOwnProperty、valueOf；`coordinator-recheck.mts`为本次独立编写。`baseline.mjs`、`delete-recheck.mjs`复用此前已核对的六组/八组夹具后独立重跑，输出目录和端口独立。当前环境为Windows、Node 20.19.4、Vite开发版、Chromium headless、1440×900；本次浏览器场景为白昼，全部业务接口数据为内存夹具，外部网络请求被阻止。

所有保存、清密钥和删除只影响内存夹具；未读取或修改正常业务配置，未调用真实QQ/模型/SnowLuma；所有探针浏览器与Vite服务已关闭。

本轮没有独立重做完整双主题布局/控件状态矩阵、生产dist、Electron原生缩放、保存响应未知、原生草稿/退出组合、屏幕阅读器或发行包验收。159的生产dist和Electron自验保留为实现方证据，不改写成本次独立结论；151未执行条目仍需单独补证。
