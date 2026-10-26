# EXT-A～C 独立复核与修复任务

日期：2026-10-26。结论：**暂不通过EXT-C验收；发现并以离线脚本复现5项P1，应先修复再接入EXT-D。**

范围：79/80号方案中EXT-A契约与策略、EXT-B工具执行底座、EXT-C插件运行时。参考81/82/83号执行记录并实际检查源码、运行回归；不将EXT-D～G尚未开发的Agent工具循环、媒体迁移、Skill服务或页面作为本轮缺陷。

本次没有修改生产代码或正式测试源码，未访问真实QQ/付费模型，未提交、打包或替换EXE。

## 1. 已确认的实现

新增工具完整来源身份、schema验证、扩展策略CAS和有效状态解析；工具执行器具备批次预检、并发限制、动作前意图写入、幂等账本与关闭处理。插件运行时按账号/插件创建Worker，具备声明握手、身份RPC、状态文件、任务串行和同步阻塞时的宿主截止处理。

全量回归通过不代表下面的异步生命周期和实际契约问题已被覆盖。新运行时目前未接入Core/Agent，这符合阶段边界；但这些问题位于A～C已经交付的模块，不能仅留给D在外层绕开。

## 2. R1 / P1：初始化握手缺少宿主截止时间

位置：`src/extensions/runtime/plugin-worker.ts:217`、`:242`；`protocol.ts`中的initialize先import再运行init。

`#startWorker()`等待handshake、init_error或Worker退出，没有宿主timer。Worker内部initTimeoutMs不能覆盖模块顶层import同步阻塞，也不能处理阻塞event loop的init函数。因此插件加载阶段可能永远不结算。

AccountPluginRuntime.sync按插件顺序await start；close又排在同一sync链后。一个初始化卡住的插件不仅自己不ready，还可能阻塞后续插件同步和运行时关闭。

复现：入口模块为`while (true) {}`，配置initTimeoutMs=20、宽限10ms；等待180ms后start仍pending。脚本最后直接调用manager.stop强制清理，不将pending留在系统中。

**EXT-C-FIX1**：在宿主对整个import/初始化/握手设置有界截止并终止代际；停止信号能够中断未完成的start，不能等到sync结束才停止。同步某插件失败后继续处理其余插件。拒绝/退出路径清理监听器、pending及timer。

验收：顶层同步阻塞、顶层永不结束的await、init同步阻塞、无handshake均在确定性宿主截止内失败；同账号其他插件可ready；sync期间close有界，无Worker泄漏。对应W03/L07。

## 3. R2 / P1：Worker内部超时只结束等待，旧handler继续运行

位置：`src/extensions/runtime/protocol.ts:238`的withTimeout；`plugin-worker.ts:457`的error响应处理。

内部timer只reject包装Promise，不abort传给handler的controller，也不终止Worker。宿主收到该error后会清除宿主timer并继续使用同代际。原handler仍运行，而Worker串行queue已可以处理下一条请求，所谓同插件串行执行不再成立。

这也与79号“超时后终止本插件代际，不能只Promise.race后继续运行”不符。83号记录将内部超时视为代际继续可用，并不能替代该执行要求。

复现：工具超时20ms，handler在150ms后增加模块内计数。第一次返回`plugin_handler_failed`，180ms后同Worker读取计数为1，`terminated=false`。说明返回失败之后旧handler确实继续执行，并非仅有一个被忽略的晚响应。

**EXT-C-FIX2**：使用结构化超时状态；宿主对内部超时同样终止代际，撤下handler，丢弃旧状态。传递abort供合作式清理，但不能依赖插件遵守signal实现硬终止。动作工具超时按unknown处理，不把可能已开始的动作记成确定失败；普通业务错误与超时必须区分。

验收：async handler忽略取消、遵守取消、钩子内部超时均覆盖；超时后旧handler无法继续修改本地示例计数或宿主状态，同代际无第二任务执行；其他插件继续；同key不能自动重跑动作。对应W03/W06/L04/L07。

## 4. R3 / P1：工具执行器的取消未传到插件队列，动作在超时后才开始

位置：`src/extensions/runtime/plugin-worker.ts:141`～`:151`的toolBinding，以及`:163`的callTool串行排队。

ToolExecutor为handler提供signal，但toolBinding没有转发；PluginToolInput也没有signal/执行guard。请求在插件自己的队列等待时，执行器可能早已超时并返回unknown，插件稍后仍会正常执行动作并写状态。执行器的调用前校验只发生在进入handler包装器之前，未覆盖插件队列真正出队这一边界。

复现真实ToolExecutor→toolBinding→Worker路径：

1. 同插件先排一个200ms的hold任务。
2. 通过ToolExecutor请求action，执行器本地时限30ms。
3. action仍在插件队列，执行器已返回unknown/tool_timeout。
4. hold结束后action才开始，插件持久状态count变为1。

当超时、退出、撤权或guard失效发生在插件队列中时，动作开始次数应为0，不能用“返回结果不再交付”替代动作前拦截。

**EXT-C-FIX3**：把执行signal及当前执行资格检查贯通toolBinding、插件队列和RPC。排队取消后移除或跳过任务；真正出队、状态读取后、postMessage之前再次检查。运行中的取消应撤销该代际，不能只让执行器放弃等待；状态写入前也须核验取消/代际。截止时间覆盖排队时间，不在出队后重开完整窗口。

验收：排队期间执行器超时、外部abort、执行器close和guard撤销，各自动作0次/状态不变；运行中取消按unknown且晚状态不落盘；恢复/重载不重放原动作。对应T08/L07/W05。

## 5. R4 / P1：账号运行时没有执行插件作用域开关

位置：`src/extensions/runtime/account-runtime.ts:77`、`:90`；关联`src/extensions/effective.ts`对插件默认开关使用on。

beforeContext只检查hasHook和terminated，afterTurn对所有管理器广播，没有使用accountPolicy中的插件有效开关。manager.#prepare只使用策略决定账号共享状态，也没有检查插件是否已在当前群/私聊关闭。

复现通过AccountPluginRuntime入口：策略明确`defaults.plugins['public/plugin/hooks']='off'`，同步插件后调用beforeContext，仍得到`status=ok`和`hook executed`补充数据，插件实际收到上下文。不是只调用内部manager才能出现的问题。

此外，effective解析器把插件开关默认设为on，与79号新安装插件群私聊默认off不一致。即使以后D按当前effective结果过滤，缺省启用仍会存在。

**EXT-C-FIX4**：钩子使用同一有效作用域解析器；新插件默认off，显式开启才分发消息/历史和afterTurn内容。执行前与排队出队后重验，按账号默认→kind→具体对象覆盖；账号硬停用不能被细scope恢复。目录展示、模型可见工具和实际钩子执行保持一致，不能在D另写一份规则。

验收：缺省、账号off、group off/private on、同peer群私聊、排队期间off、账号A/B差异均断言真实handler调用数与状态写入数；关闭时均为0。对应P01/P02/P03/P06。

## 6. R5 / P1：插件epoch契约与实际角色历史epoch不一致

位置：`src/extensions/runtime/protocol.ts:26`、`plugin-worker.ts:45`、`:570`、`state.ts`及工具执行/账本接口的contextEpoch字段。

新模块把contextEpoch定义为number，并用Number.isSafeInteger验证；toolBinding缺失时回退0。现有`AccountService.historyEpoch()`返回string，实际形式含角色绑定revision、制品来源/id/revision及catalogEpoch；MemoryScope同样使用string。

复现：向已声明且ready的beforeContext传入实际形态字符串，得到`unavailable/plugin_hook_context_too_large`；没有真正执行钩子，错误原因也不准确。按现有类型直接接D无法正确传递角色scope，使用0或临时数字映射会造成角色隔离语义漂移。

**EXT-C-FIX5**：复用现有角色历史epoch契约，移除number假设和缺省0；缺失epoch明确拒绝。opaque字符串不能直接拼接Windows文件名，须使用稳定摘要/安全编码作为文件名并校验信封scope，不新建一套可碰撞数字代际。区分输入scope错误与请求超大。

验收：使用实际AccountService产出的epoch贯通钩子、工具账本和插件状态；切角色、制品版本变化后状态隔离，世界书策略变更不误换历史scope；包含冒号等字符的合法epoch在Windows可落盘，同peer群私聊不串。对应W02/A06，属于D接线前应修正的契约。

## 7. 本次验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | 106文件通过，991项通过、1项既有跳过，退出码0 |
| `npm run typecheck` | 退出码0 |
| `npm run desktop:build` | 服务端、renderer、Electron main/preload构建通过，退出码0；没有打包EXE |
| `git diff --check` | 通过 |
| 独立复现 | 5项缺陷均复现；脚本断言当前缺陷行为成立 |

脚本位于被Git忽略的`test-results/review84/reproduce.ts`，执行：

```powershell
.\node_modules\.bin\tsx test-results/review84/reproduce.ts
```

只使用离线临时模块、Worker、系统隔离目录，结束关闭执行器/Worker并检查绝对路径后清理。该脚本用于复现当前缺陷，不是修复通过标准；正式修复需要将反向断言纳入版本管理内回归源码。

本次全量没有再次出现83号披露的轮询取消分类或78号水位等待失败；一次通过不能证明这些历史稳定性观察已定位或关闭。本报告未将它们重复列为本轮已证实的新缺陷。

## 8. 执行顺序与阶段结论

建议先FIX5统一epoch契约，同时完成FIX1/2/3生命周期与取消收口，再做FIX4统一作用域，最后执行正式回归和独立复验。各修复可在同轮交付，但不要先把现有运行时接入用户真实账号。

原有契约、账本和Worker框架可以保留，不要求推倒重做。修复后更新81～83号实际证据及范围，再推进EXT-D；D/E/F/G未实施部分继续保持后续任务，不提前宣告插件对用户闭环已完成。
