# 后端重构独立复核

日期：2026-10-23。对象：以`ac51e0d`为基线的当前未提交重构；入口为29、30号文件。未修改生产源码，未执行真实QQ/SnowLuma操作、付费请求或Git提交。

## 结论

结构调整方向正确，独立运行`npm run typecheck`、`npm test`、`npm run desktop:build`全部通过；测试结果与报告一致：55个文件、333项。

但补充反例确认了以下问题。不能以这些自动化结果直接确认“B01～B11全部验收完成”。建议先完成R1～R4返修并补正式回归，再作结项；R5为低优先级的新能力缺陷。

## R1 [P1] 关闭后仍可通过公开写入口修改磁盘

位置：`src/core/core.ts:495`及`src/application/model-settings/model-settings-service.ts:64`。

Core的`#stopped`没有在普通`upsertProvider`等写入口形成统一准入限制，ConfigStore.dispose也只等待当时的队列，不拒绝后续修改。复现：旧Core完成stop → 同一dataRoot创建新Core并取得锁 → 通过旧Core.upsertProvider保存服务 → 磁盘被旧Core修改，新Core内存仍没有该服务。

这已破坏dataRoot“一个写者”的运行约束。基线中已有相似入口缺口，本轮提取应用服务与生命周期后仍未解决；属于B09“关闭后拒绝新修改”的验收缺口，不把它误报成全部由本次新增。

返修：统一运行态/关闭态准入；所有公开修改入口在任何凭据、文件、事件副作用前拒绝closing/closed状态。登记完整在途用例，而不只等待简化模型配置链；先停止准入，再等待已接受用例，最后释放其依赖和dataRoot锁。

回归：关闭后各代表写入口均返回core_stopped且无文件变化；旧Core与新Core交接后旧实例不能写入；关闭前已进入但阻塞在凭据操作的请求，必须被排空或明确取消后才能释放锁。

## R2 [P2] 同步抛错会永久占用SerialExecutor

位置：`src/platform/async/serial-executor.ts:84`。

`next.task()`在Promise链建立前执行。任务若在返回Promise之前同步throw，第一次调用会被run内部Promise构造器转成拒绝，但finally清理没有注册，active持续为true，后续任务和drain/close无法完成。若此类任务在排队后被pump调用，还可能产生未处理的拒绝。

复现：run一个同步throw的合法回调，捕获错误，再run一个正常异步任务；后者持续排队，观察active=true、pending=1。当前失败恢复测试使用async回调，未覆盖此路径。这是本轮新增基础能力的问题。

返修：先进入Promise链再调用任务，或显式捕获同步异常，确保所有退出路径都执行相同的释放与pump。KeyedSerialExecutor需一起验证。

回归：首任务及后续排队任务同步throw后，后继任务均能完成，drain/close结束，键可回收；无未处理拒绝。

## R3 [P2] media清理失败会跳过媒体与配置释放

位置：`src/core/core.ts:265`至`:269`。

`media.cleanup()`、`media.dispose()`和`configV2.dispose()`放在同一个生命周期步骤和try块里。第一项失败时，后两项被跳过；RuntimeLifecycle只能继续后续步骤，不能恢复这个步骤内被跳过的释放。

故障注入复现：令media.cleanup拒绝，跟踪两个dispose方法；Core.stop成功返回，两个dispose均未调用，dataRoot锁却已释放，新Core可以打开相同目录。

基线也有类似组合清理代码；本轮B09的逐步错误隔离没有覆盖这三个独立资源。执行报告“单步失败不阻断后续释放”需要限定范围或在修复后再确认。

返修：将清理、媒体释放、配置排空注册为独立步骤，或通过finally逐个确保执行。检查其他组合步骤；释放锁前必须确保可能写入的依赖已经排空/停止。

回归：任意一个清理动作失败，其余释放仍被调用；后续关闭调用仍能正确等待结束，不只验证RuntimeLifecycle的独立示例。

## R4 [P2] 并发Core.stop没有等待同一次关闭

位置：`src/core/core.ts:378`至`:382`。

第一次stop立即设置#stopped并等待lifecycle.close，第二次stop因#stopped直接返回。RuntimeLifecycle本身共享close Promise，但Core门面提前返回使这一保证没有传递给调用方。

复现：让host.dispose等待测试栅栏 → 调用第一次stop → 确认已进入host释放 → await第二次stop；第二次已经返回，但第一次仍未完成。依赖await stop来退出进程或交接资源的调用者会误判关闭完成。

基线也有提前返回结构；本轮B09“关闭幂等”的组件测试没有覆盖公开Core入口。

返修：始终返回/等待同一次关闭完成的Promise；已进入closing状态不等于已经closed。保持重复调用不重复释放资源。

回归：两个并发stop在释放栅栏之前都不完成；栅栏解除后全部完成，释放动作只执行一次。

## R5 [P3] resolveExisting没有实际回退默认目录

位置：`src/profiles/account-directory.ts:59`。

存在自定义dataDir时，候选列表第二项调用this.path(accountId)，该方法又自动选择同一个自定义目录，因此两项相同。自定义目录缺失而默认accounts/<QQ>存在时，方法返回undefined。

补充临时目录复现确认这一结果。当前生产路径尚未调用该方法，因此不描述成已经影响所有账号页面；但它是新架构明确承诺的读取入口，接入后会暴露。

返修：第二项显式使用默认dataRoot；补自定义目录缺失/存在、默认目录存在/不存在四种组合，明确优先级且不创建目录。

## 已检查的正向结果与范围

- Semaphore名额交接与幂等release已调整，原确定性反例有回归覆盖。
- 展示资料完整读改写通过AccountDisplayStore串行，字段并发与失败路径有正式测试。
- ProcessReconciler实现了扫描单飞、失败不覆盖快照、代际保护和成功扫描缺失阈值；现有对应测试通过，未在本轮确认新的进程误清理反例。锁约定M→R→Supervisor已记录。
- RuntimeLifecycle的stop/drain/dispose阶段顺序和组件级幂等测试通过；上述R3/R4说明组件通过不等于Core集成行为全部通过。
- 29号文件对DesiredStateStore、ListeningStore等失败后内存领先磁盘的边界已有披露。本轮未将这些已知事项重复报为新增回归；它们仍是后续Store治理范围，不能解释为已解决。
- 普通processes查询当前仍调用reconciler.refresh，会触发收敛清理；这与26/27号文档“普通查询读快照、显式刷新请求收敛”的目标尚有差距。需实现读/刷新区分，或明确修订方案，不能只因移动了方法就确认查询边界已完成。

## 证据与返修顺序

临时复现：`test-results/backend-review-2/repro.mts`，不进入Git，仅使用模拟对象与系统临时目录。输出：

```json
{"scenario":"serial_sync_throw","active":true,"pending":1,"nextResult":"blocked"}
{"scenario":"concurrent_core_stop","secondReturnedBeforeFirstFinished":true}
{"scenario":"cleanup_step_failure","mediaDisposed":false,"configDisposed":false,"dataRootLockReleased":true}
{"scenario":"write_after_stop","stoppedCoreWroteDisk":true,"currentOwnerSawChange":false}
{"scenario":"directory_fallback","defaultExists":true,"resolved":null}
```

建议顺序：R2基础执行器 → R1/R3/R4作为一个生命周期集成返修批次 → R5目录回退 → 新增反例回归 → 全量类型/测试/桌面构建复核 → 更新30号报告结论。不要用真实QQ环境来替代这些可确定复现的自动化检查。

## 返修记录（R1～R5）

日期：2026-10-23。以下记录对应本次工作区返修；保留上述原始复核证据与未解决范围。

| 编号 | 返修内容 | 正式回归 |
| --- | --- | --- |
| R1 | Core 门面写用例统一经关闭准入与在途登记。`stop()`先关闭准入，等待已接受用例完成，再关闭依赖并释放 dataRoot 锁；`injectionProcesses()`也登记，因为进程刷新可能触发收敛清理。`listJobs()`/`getJob()`会在首次读取时迁移遗留非终态任务，`readMessages()`会在首次读取时创建会话目录，因此也纳入准入与在途登记。启动使用独立 Promise 与停止协调，避免自等待。 | `test/core-lifecycle.test.ts` 用凭据库栅栏阻塞 `setInjectionSettings`，确认锁在用例完成前仍持有；交接后旧 Core 的模型、凭据、账号、角色、槽位、部署、任务、媒体、发送和 QQ 连接入口都返回 `core_stopped`，新 Core 看不到迟到写入。另以真实落盘路径 `accounts/10001/jobs/jobs.json` 中的遗留任务和缺失的 `accounts/10001/messages/private/peer` 会话目录，确认旧 Core 的任务/消息查询拒绝且既不改写任务文件也不创建目录或缺失账号的任务文件；随后由新 Core 首次查询证实该遗留任务被加载并恢复为 `interrupted`，证明 fixture 有效。 |
| R2 | `SerialExecutor` 在 Promise 链中调用任务，同步 throw 与异步拒绝共用释放、队列泵送路径；`KeyedSerialExecutor` 接受同步返回值并验证键回收。 | `test/serial-executor.test.ts` 覆盖首任务与排队任务同步 throw、后继执行、drain/close 完成及键重用。 |
| R3 | Core lifecycle 将媒体清理、媒体释放和配置释放注册为独立步骤；动态槽位 desired-state 清理逐项隔离失败。装配失败清理中以 `finally` 确保 runtime registry、supervisor 和 dataRoot 锁依次释放。 | `test/core-lifecycle.test.ts` 注入媒体清理失败，确认媒体、配置仍释放且新 Core 可取得同一 dataRoot。 |
| R4 | Core 保存共享的 stop Promise；关闭中的后续调用等待同一生命周期完成，资源释放只执行一次。 | `test/core-lifecycle.test.ts` 在 host.dispose 栅栏前并发调用两次 stop，确认两次都等待、锁未提前释放且释放调用次数为一。 |
| R5 | `resolveExisting()` 第二候选显式使用默认 dataRoot，保留已有自定义目录优先级。 | `test/account-directory.test.ts` 覆盖自定义存在/缺失与默认存在/缺失的四种组合，并确认解析不创建目录。 |

Core 门面保证只覆盖通过 Core 方法进入的用例。`Core` 仍公开 `configV2`、`media`、`jobs`、`supervisor` 等组件对象；持有这些对象并直接调用其 Store/service 方法会绕过 Core 门面准入与在途跟踪。本次没有把这些独立组件改成 Core 代理对象，也没有扩大到 `devDoc/29` 列出的其他 Store 失败事务语义。控制面路由使用 `CoreView` 门面。

返修后验证：`npm run typecheck` 通过；`npm test` 通过（55 个文件、340 项）；`npm run desktop:build` 通过；`git diff --check` 通过。父代理在修正后的代码上复跑独立 `test-results/backend-fix-acceptance/verify.mts`，全部6组验收通过（R1两组及R2～R5），包括 `listJobs()`/`getJob()`/`readMessages()` 的关闭拒绝检查。Windows 沙箱内 Vitest/Vite 的 `realpath` 操作返回 EPERM，测试和桌面构建在获准的提升执行中通过。没有运行真实 QQ、SnowLuma 或付费 API。

在途用例排空没有超时取消；若已接受的操作永久不返回，`stop()` 会持续等待并保留 dataRoot 锁。这样不会让仍可能写入的旧 Core 在新 owner 获锁后继续运行。

仍保留范围外事项：普通 `injectionProcesses()` 查询会触发 reconcile 清理，与26/27号文档提出的“普通查询只读快照、显式刷新才收敛”不同；本返修为其关闭期间副作用加了 Core 门面准入和排空，但没有改变查询语义。29号记录的其他 Store 内存/磁盘失败语义也未处理。
