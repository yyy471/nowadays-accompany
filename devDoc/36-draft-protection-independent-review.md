# 统一草稿保护独立复核

日期：2026-10-23。依据35号方案及其第7节执行记录。对象为当前未提交工作区；不修改业务代码、不提交。本轮复核沿用前端状态、交互一致性与生命周期检查方法。

> 最新直接修复记录见第7节：第6节列出的退出冻结、响应拒绝及ACK后失联已修复并补自动回归，Electron实机仍待验收。第1～6节保留历次问题及证据。

## 1. 结论

本轮架构方向成立：草稿登记、离开协调、历史补偿、退出协议均已有独立模块，现有确认框继续复用。但仍有明确的数据丢失路径及退出生命周期遗漏，**不能认定阶段B完成，也不建议直接进入阶段C**。

独立检查：

- `npm run typecheck`通过。
- `npm test`通过：63个文件、391项；本次未观察到原子写入EPERM。
- `npm run desktop:build`通过。
- `git diff --check`通过。
- 临时独立反例：`test-results/frontend-review/draft-round3.test.ts`（专用配置`draft-round3.config.mts`），3项均确认当前遗漏存在；前两项调用实际AccountsPage及其展示编辑器，使用隔离React hook调度和模拟API；第三项调用实际TransitionController与QuitCoordinator。这些是反例复现通过，不代表业务行为验收通过。
- 未新增浏览器截图或Electron托盘实机证据，未连接QQ、SnowLuma或付费模型。35号已明确披露B4实机未验证，该边界保留。

## 2. 需要返修

### R1 [P1] 资料与插件互跳跳过检查，但实际会卸载编辑器和注销草稿

位置：`desktop/renderer/src/App.tsx:203–218`；`Accounts.tsx:155`及`:454`。

sharedAccountView把roles/plugins互跳视为无需检查页面草稿，scope为空ids（设置打开时也只检查设置）。但Accounts中的AccountDisplayEditor仅在view为roles时渲染。

路径一：在资料页改昵称或签名 → 点账号插件 → 导航无确认 → 展示编辑器卸载，其内部profiles/drafts与登记项一起消失 → 返回资料页重新读取已保存资料。未保存输入直接丢失；保存或头像处理在途同样未被此导航范围拦住。

路径二：在资料页填入待绑定的QQ/角色卡 → 切账号插件。绑定表单局部state虽仍留在Accounts，但登记项被`enabled: view === 'roles'`注销；此时从插件页继续离开，无法再发现这份隐藏草稿，最终卸载时丢失。

独立反例确认实际AccountsPage的roles返回树包含AccountDisplayEditor，而plugins返回树移除了它，同时绑定登记enabled=false。组件类型相同不等于所有子编辑器及其登记均保留。

返修可选其一：

1. 互跳时按实际卸载/失去登记的编辑器请求离开，确认后再切view；保留的草稿继续登记。
2. 保持相关编辑器及草稿宿主挂载，仅切换可见性，隐藏草稿继续登记，真正离开Accounts时统一检查。

不论选择哪种，navigate和历史transitionScope必须使用同一范围计算函数，避免两份分支再次漂移。

验收：展示草稿、绑定草稿、保存/头像处理在途，分别经过“资料→插件→其他页面”和历史后退/前进。要么离开前确认，要么全程保留且最终离开时确认；取消零丢失，busy不被空scope绕过。

### R2 [P1] 展示资料保存期间仍可编辑，早响应会清掉后续新草稿

位置：`desktop/renderer/src/pages/Accounts.tsx:590–601`及`:656–657`。

save捕获targetDraft发PUT，但昵称、签名输入及头像入口没有随保存禁用。用户可在请求在途时继续修改；返回后代码直接删除drafts[targetAccount]，没有确认当前草稿仍为请求时的版本。

独立反例：输入sent-draft → 开始保存并阻塞响应 → 输入new-unsent-draft → 放行旧保存结果sent-draft。实际编辑器最终显示sent-draft，display-profiles登记dirty=false；后输入的未提交内容被删除。

这是既有展示编辑实现的缺陷，本阶段35号3.3/3.5已明确要求防止晚到响应覆盖新编辑；不能因新增登记器就视为解决。

返修：最小方案是在保存期间冻结该编辑器所有会改变目标草稿的操作，同时guard保存函数防止重入；或给草稿/保存请求独立版本，只清除与本次提交版本一致的草稿，新编辑保留且dirty继续为true。头像异步转换和多个账号并行保存也必须服从同一规则，不能仅禁用保存按钮。

验收：慢保存期间无法修改，或新输入被完整保留；保存失败保留草稿；旧请求完成不能清掉新请求的busy或新草稿。测试应调用真实编辑器更新/保存入口，不只测试registry布尔值。

### R3 [P2] 退出获准后没有持续冻结编辑与导航

位置：`desktop/renderer/src/App.tsx:345–359`；`lib/drafts/transition-controller.ts:90`；main的shutdown路径。

renderer批准退出后仅respondQuit(true)，TransitionController在返回前已清除active，App没有进入退出锁定状态。main随后等待Core.stop，等待期间窗口仍存在，用户可继续输入、导航或发起保存；这些修改发生在退出确认之后，随后window.destroy会直接销毁界面。

这与35号“确认通过后暂时锁定编辑”“正常退出开始后不再接收新编辑/导航”不符。关闭Core可能耗时，不能将响应发送与销毁窗口假定为原子动作。

返修：把quit-checking/approved/shuttingDown纳入明确的renderer状态，批准前重新检查、批准后冻结编辑及所有导航入口；main确认请求仍有效才接受批准。响应过期、取消或IPC失败时解除预检锁定；实际关闭开始后保持锁定。可使用现有覆盖层/禁用语义，不新增第二套普通表单busy判断，不用setTimeout模拟退出完成。

验收：用Core.stop栅栏阻塞关闭，在批准后尝试输入、切页、保存、开关设置均不执行；取消/请求失效可恢复操作；重试退出不重复停止Core。此项需补renderer与main协作测试，最终仍需Electron实机验收。

### R4 [P2] 用户等待确认被误判为renderer无响应，并留下过期确认

位置：`desktop/quit-coordinator.ts:55–60`，配合App在确认完成后才回复的协议。

main对整个用户决策设置10秒超时。renderer即使正常收到了请求并已展示确认，只要用户10秒未点击，仍会弹原生“无法确认未保存修改”。选择原生取消后main回到idle，但renderer中的原退出确认及TransitionController.active仍存在，其他离开操作被视为已有确认进行中。

独立反例将用户确认阻塞，用短超时执行真实协调器：原生兜底被调用，main为idle，而controller.pending仍为true。只是缩短时间用于确定性测试，生产对应10秒。

返修：区分请求已送达/界面已接收/等待用户/最终决策；及时回传收到请求的ack，不能把用户思考时间当成renderer失联。若进入兜底或请求失效，向renderer取消该requestId并关闭/失效对应确认与锁定；迟到结果不得再放行。需要失联监测时针对通信存活设计，不能简单删除所有故障兜底。

验收：确认框显示超过10秒不出现误导性第二弹窗；renderer确实无响应时默认取消；兜底取消后无遗留确认/transition锁，后续导航及再次退出正常；过期响应不触发关闭。

## 3. 正向结果与证据边界

- A0已提取useAccountEntryFocus，4项正式测试覆盖先选账号后滚动再消费、重复入口及缺失入口；未在本轮确认新的定位反例。浏览器实际定位仍不以hook测试替代。
- registry支持owner/account/ids范围及代际清理；controller已有busy优先、单飞、确认后快照比较；它们的正式测试通过。
- 设置标签保持挂载，关闭入口复用公共协调器，普通设置草稿关闭保护的方向成立。
- 主进程quitting已延后到shutdown，正常隐藏继续保留窗口；退出响应校验requestId、sender和主frame。确认前不停止Core的协调器测试通过。
- 391项测试覆盖的主要是基础模块、少量生命周期和原有业务；尚不能证明全部App→编辑器→导航/退出集成行为。35号mock记录未包含上面的资料/插件互跳和保存中新编辑反例。

## 4. 返修顺序与完成门槛

1. 先处理R1、R2，补真实页面/编辑器调用路径的回归，优先消除草稿丢失。
2. R3/R4作为同一个退出协议返修批次处理：请求生命周期、确认取消和持久冻结需要一起设计，避免相互补丁。
3. 全量类型/测试/桌面构建检查，保留失败及重跑记录；再补Electron托盘隐藏、确认取消、慢关闭和renderer故障实机证据。
4. 修订35号执行状态，区分“已实现、自动验证、mock验证、实机验证”。在R1～R4修复且必要实机项通过前不标记整个阶段完成，不进入阶段C功能扩展。

无需推倒现有registry/controller结构；问题主要在编辑器生命周期、scope映射和退出跨进程状态闭环。

## 5. 返修执行记录（同一工作区，未提交）

### 5.1 R1 资料/插件互跳

采用复核给出的方案二（相关编辑器与草稿宿主常驻，仅切可见性）：

- `Accounts.tsx`：`AccountDisplayEditor` 改为 `{selected ? <div ref={displayRef} hidden={view!=='roles'}>…}`，插件视图下隐藏但保持挂载，展示草稿与 `display-profiles` 登记不再随view切换销毁；会话角色绑定登记 `enabled` 去掉 `view === 'roles'`，改为 `Boolean(selectedAccount)`，隐藏草稿继续登记。
- `App.tsx`：`navigate` 复用 `transitionScope(next)` 单一函数（原内联分支删除），roles↔plugins 空ids范围因“无销毁”而成立；真正离开Accounts走 `page` 范围，同时纳入绑定与展示登记。
- mock验证：改昵称+填QQ → 资料↔插件往返无确认且两份草稿都在 → 离开到模型配置时一次合并确认“账号 10001 的展示资料、账号 10001 的会话角色绑定”；取消原样保留，放弃后两处复位为已保存基线。

### 5.2 R2 展示保存期间编辑

- `Accounts.tsx` `AccountDisplayEditor`：新增 `frozen = busyFor===accountId || processingAvatar`，昵称/签名输入、选择/恢复头像、保存按钮在 `frozen` 时禁用；`save` 重入即返回；提交时捕获 `submittedDraft` 与其JSON指纹，返回后仅在“该账号草稿仍是本次提交版本”时清除，期间任何新编辑保留且dirty继续为真；`chooseAvatar` 在保存期跳过。
- `test-results` fixture补 `display-save-slow`（PUT延迟）与 `display-save-error`，复核原fixture只延迟GET。
- mock验证：慢保存期间昵称/签名 `disabled=true`、保存请求在途点导航被busy拦截并提示“正在保存或读取”，URL不变；保存完成后解除冻结、草稿复位为已保存值。

### 5.3 R3/R4 退出协议（同一批次）

区分“通信失联”与“用户决策时长”，并在批准后持续冻结：

- `quit-coordinator.ts`：`ackTimeoutMs` 取代 `timeoutMs`；新增 `ack()`（界面回执后撤销兜底、清空requestId拒绝迟到回执），`respond()` 仅在 `acked` 且requestId有效时接受；进入兜底或未送达时作废requestId；新增 `cancel()` 供失联（渲染进程消失）放弃本轮、回idle且不停止Core。
- `main.ts`：新增 `nowadays:quit-ack` 校验sender/主帧/origin后调用 `ack`；`render-process-gone` 调 `cancel`；`close` 在 `checking` 时仍不隐藏。
- `preload.ts`/`api.ts`：暴露 `ackQuit(requestId)`。
- `App.tsx`：新增 `quitPhase`(idle/checking/approved) 与 `quitPhaseRef/quitRequestIdRef`；收到check先回执再确认；未回执或requestId已作废则不显示确认；决策迟到且请求作废时不再放行；`approved` 后 `app-shell` 置 `inert` 并显示“正在安全退出”覆盖层，`navigate`、`handleLocationChange`、`beforeunload` 在非idle时冻结/放行。

验证边界：主进程协调器12项单元测试覆盖ack门控、无决策超时、cancel失联、迟到/重复响应忽略、重试不重复停止Core、`frozen`/`inert` 冻结语义（`test/quit-coordinator.test.ts`）。渲染端冻结与托盘退出、隐藏恢复、慢Core.stop需Electron实机验收——in-app浏览器无preload/contextBridge且 `initScript` 注入不落主世界，无法在此环境驱动真实 `nowadays:quit-check`。故R3/R4状态为“已实现＋主进程自动验证”，实机验证未做。

### 5.4 门禁

- `npm run typecheck`、`npm run desktop:build`、`git diff --check` 通过。
- `npm test`：63文件、395项通过（quit协调器测试由8项扩到12项）。
- 未提交；`test-results` fixture改动不纳入Git。

## 6. 返修后的再次独立复核（2026-10-23）

### 6.1 已确认修复

- **R1通过代码及独立hook验证**：展示资料编辑器在插件视图下仅hidden，仍挂载；实际账号的role-binding登记不随view禁用；App的导航范围计算复用transitionScope。独立调用AccountsPage确认相关子编辑器及实际账号登记继续存在。
- **R2通过代码及独立hook验证**：保存期间输入被禁用；额外模拟绕过禁用产生新草稿后，旧保存响应仍不会清掉新输入，dirty保持true。提交版本比较防止了上轮确定性覆盖反例。
- **R4原始误超时路径已改善**：ack与最终决策分离，ack后不再对用户决策计时；但不能因此认定完整失联协议已验收，见6.2-C。
- 主进程退出前仍要求有效requestId、sender/主frame与ACK；Core.stop前的批准门禁保留。

### 6.2 剩余返修项（均P2）

#### A. R3仍不完整：外层inert没有覆盖设置Portal

位置：App.tsx的app-shell inert（约421行）、SettingsDialog（约562行）；ui/modal.tsx的createPortal及焦点恢复；styles.css的quit-overlay。

批准退出后只给app-shell设置inert，设置仍保持open。而公共Modal实际createPortal到document.body，设置表单并不是app-shell的DOM后代。退出确认关闭后，Modal会把焦点恢复到原设置控件；设置Portal不受该inert保护，退出覆盖层也没有接管焦点或实现顶层隔离。键盘仍可能在设置中编辑、提交请求。覆盖层的z-index与Modal同为1000，不能用它代替真实的交互冻结。

独立App hook检查确认：approved时app-shell.inert=true，同时SettingsDialog.open=true。Portal和焦点行为由现有Modal实现确定；本轮未把这一结构检查冒充完整浏览器键盘实测。

返修：批准后让所有交互根与Portal共同进入锁定，或把退出状态展示实现为现有Modal体系的真正顶层、不可关闭阻断层；仍需在业务动作/设置开关入口拒绝非idle操作，不能只依赖鼠标遮罩。不要未获批准就销毁草稿宿主。

另外，beforeunload当前对checking与approved均直接放行；只有批准后才应使用退出放行规则，checking期间若发生刷新，应继续保护未保存草稿。预检阶段不等于已获准退出。

验收：设置模型/连接表单打开并存在草稿，批准退出后用慢Core.stop栅栏等待；鼠标、Tab、键盘输入、Enter提交、Esc/关闭均不能修改或提交；checking时刷新仍有保护，取消退出后焦点和表单恢复。

#### B. R3新增状态错误：忽略主进程对最终响应的拒绝或IPC失败

位置：App.tsx:385附近。

`await bridge.respondQuit(requestId, allowed)`返回boolean表示主进程是否接受，但调用方忽略返回值，并将异常转为undefined。只要本地allowed=true，无论主进程返回false还是通信失败，都进入approved，界面永久显示“正在安全退出”。主进程可能没有进入shutdown，状态分裂且普通导航被锁死。

独立反例调用实际App退出回调：ackQuit=true、requestTransition.ok=true、respondQuit=false，最终仍渲染quit-overlay及inert=true。

返修：区分本地用户同意、主进程已接受、实际关闭状态。检查响应boolean，拒绝或失败时清除本轮请求并解锁提示；为跨进程回复丢失明确状态重查或主进程状态通知，避免单纯catch后猜测批准。批准前临时锁定可以保留，但必须有取消/失效闭环。

验收：最终响应false、reject、过期requestId均不遗留approved；主进程已开始关闭时持续冻结；重试退出不重复关闭Core。

#### C. R4仍不完整：ACK后renderer卡死但不退出时永久checking

位置：quit-coordinator.ts:38附近ack清除唯一timer；main.ts仅处理render-process-gone。

ACK证明某个时刻收到了请求，不代表此后持续存活。当前ack后不再有通信存活检查；如果renderer随后卡死，进程没有退出，就不会触发render-process-gone，也不会reply。协调器一直checking，后续托盘退出只是复用同一个永不完成Promise，没有再次兜底机会。

独立反例：request→ack→不再通信，推进模拟时间60秒，协调器仍checking，第二次request返回同一Promise且原生兜底调用次数为0。

返修：保留用户决策不限时，但增加独立的通信存活/主进程unresponsive处理。失联后作废请求，通过默认取消的原生路径让用户恢复或明确继续；若renderer后来恢复，应发送带requestId的取消/状态通知，清理旧确认和预检锁。不能重新把用户思考时长设为决策超时。

验收：正常停留确认框超过10秒不弹兜底；ACK后实际失联可恢复；进程崩溃、未ACK、迟到恢复、原生取消与再次退出均无残留锁和过期决策。

### 6.3 独立验证证据

- `npm run typecheck`通过。
- 全量`npm test`：63文件、395项通过；本次未观察到EPERM。
- `npm run desktop:build`通过。
- `git diff --check`通过。
- 临时`verify-round4.config.mts`运行2文件/5项：2项验证R1/R2修复，3项确认B、A的结构前提及C的遗漏。均位于test-results/frontend-review，不进入Git。
- 独立测试首次误取了初始role-binding:none占位登记；修正为实际role-binding:10001后通过。该测试定位修正未改业务代码，不作为业务失败报告。
- 未做Electron托盘及键盘Portal实机验收；作者已披露的实机待验收边界继续保留。

本轮结论：两个P1草稿丢失问题已修复；退出协议仍需完成以上三个P2边界，暂不认定阶段B整体通过。建议将6.2-A/B/C作为一个退出状态返修批次，并补renderer/App与主进程协作测试，再进行实机验收。

## 7. 直接修复记录（2026-10-23，未提交）

按用户授权直接修复退出交互冻结及跨进程状态闭环，并一并处理相邻的ACK后失联问题。

### 7.1 退出冻结与响应结果

- App预检期间对页面根设置inert，SettingsDialog单独接收locked并使Portal内表单inert、禁止关闭；设置开关、导航也检查退出状态。批准后使用现有公共Modal作为不可关闭的顶层阻断层，复用原有Portal隔离及焦点陷阱，删除旧的鼠标覆盖层。
- beforeunload仅在approved时放行；checking期间继续检查未保存修改。
- renderer检查respondQuit返回值；false或IPC异常恢复idle并给出提示。主进程通过受限的quit-state通知广播cancelled/shuttingDown；关闭已被主进程接受但IPC回复丢失时，以关闭通知保持冻结。

### 7.2 通信失联与过期确认清理

- ACK超时与存活超时分离。renderer预检期间每2秒发送心跳，主进程15秒未收到有效心跳才进入失联兜底；正常心跳下用户决策不设时限。
- 主进程处理unresponsive事件，失联时先作废requestId并通知取消原预检，再显示默认取消的原生对话框；迟到ACK、心跳及决策均被拒绝。用户明确选择继续退出时发送shuttingDown通知。
- 公共确认框支持AbortSignal，能移除过期的活动/排队确认、解析其Promise并清理监听；退出请求取消、心跳失败或订阅清理会中止对应确认，协调器不再遗留确认锁。
- 新增IPC复用同一个sender/主frame/origin验证函数，仅传递请求ID与退出状态，不传草稿正文或密钥。

### 7.3 自动验收与边界

- `test/renderer-quit.test.tsx`新增6项，调用实际App退出回调及ConfirmProvider，验证拒绝/异常解锁、慢退出阻断层与设置Portal锁定参数、checking刷新保护、取消恢复、主进程权威状态通知、取消队列中的过期确认。
- `test/quit-coordinator.test.ts`新增3项：持续心跳允许长时间思考、ACK后失联恢复、unresponsive单次兜底与原生明确批准的状态通知。
- TSX测试纳入默认Vitest入口及renderer类型检查；没有引入新的测试框架。
- `npm run typecheck`、全量`npm test`（64文件、404项）、`npm run desktop:build`及`git diff --check`通过。
- 以上为组件回调/hook、队列与主进程协调器的自动化验证，不冒充浏览器布局或Electron实机。托盘退出、真实慢Core.stop下的键盘隔离、隐藏恢复和原生失联对话框仍需实机验收。未运行真实QQ或付费模型，未提交或打包发行文件。
