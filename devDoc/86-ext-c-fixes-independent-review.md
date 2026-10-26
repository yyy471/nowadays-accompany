# EXT-C 修复的主进程独立复核

日期：2026-10-26。状态：**原5项及追加边界修复通过主进程独立复核；项目全量门槛仍有1项记忆链路等待失败，不能宣称整体全绿。** 对应[84 独立复核](84-ext-a-c-independent-review.md)及[85 子代理修复记录](85-ext-a-c-remediation.md)，实现范围仍为EXT-A～C，不包含EXT-D的Agent工具循环或后续页面。

## 1. 分工及范围

按用户要求，由GPT-6 Luna、max推理强度子代理修改代码和正式回归，主进程独立检查代码、编写反向复现脚本并验收。没有旧插件兼容分支；未提交、打包或替换EXE，未访问真实QQ或付费模型。

主要修改位于`src/extensions/runtime/`、`extensions/effective.ts`、`extensions/policy.ts`、工具执行器及账本；原子写原语增加可选提交guard。现有Core/Agent旧插件选择清理由EXT-D承担，本轮没有提前接入新运行时。

## 2. 原5项问题的复验

| 项目 | 主进程结果 | 独立证据 |
| --- | --- | --- |
| FIX1 初始化截止与关闭 | 通过 | 模块顶层同步阻塞在宿主截止后settled且terminated；初始化截止设10秒时，close仍可立即打断正在等待的sync，而非等满10秒 |
| FIX2 内部超时与旧代际 | 通过 | 超时返回unknown、代际终止，延迟本地副作用标记不存在；正式测试分开覆盖内部handler超时与宿主失联截止 |
| FIX3 队列取消 | 通过 | ToolExecutor先超时返回后，同插件hold任务结束，后续action计数仍0、没有状态文件；账本重开保留unknown |
| FIX4 作用域 | 通过 | AccountPluginRuntime入口默认/显式关闭时无钩子调用、无状态写入；指定会话on可覆盖账号运行默认off；从sync清单移除后无法被会话on恢复 |
| FIX5 真实epoch | 通过 | 从真实Core/AccountService取得字符串epoch贯通运行时；安全摘要文件名、跨peer复制信封拒绝、显式账号共享跨会话正常、账本重开仍为字符串 |

状态提交额外检查：第一次已保存count=1，下一次写入在原子提交guard变为false时被拒绝，旧文件count仍为1。不是仅检查Worker返回值，而是读取持久化文件确认。

## 3. 主进程发现后追加的收口

本轮不是子代理自验通过后直接放行。主进程在代码复核和独立脚本中继续检查了以下边界，修正后再复验：

1. **submitted与状态写失败**：动作已返回submitted/jobId，但状态提交因guard撤销失败时，原分支只处理ok，仍会暴露正常job结果。已改为unknown且不带原jobId。主进程实际注入提交中撤权验证通过。
2. **运行默认off的软覆盖**：首版修复把defaults.plugins.off当成硬停用，破坏账号默认→kind→会话的三态覆盖。已恢复统一软解析，硬停用由安装/profile清单控制。指定会话开启与从sync清单移除两项独立断言通过。
3. **插件队列中的真实工具撤权**：首版只转发调用者的role guard，未把ToolExecutor完整准入检查传给插件。主进程保持role guard=true、插件开启，在hold期间只撤销ToolView.authorized，实际复现action仍执行。已改成完整执行器gate闭包，包含当前工具目录、授权、handler代际、原guard和取消状态；重新验证action计数0。
4. **在途动作的unknown语义**：首版在RPC进行中因guard撤销而中断时返回error。主进程确认动作已写started标记后撤权，复现返回error；已增加真正dispatch边界追踪，已派发action中断按unknown记账，未开始的拒绝仍可返回error。独立脚本和正式回归均检查该场景。

这些是原FIX2/FIX3/FIX4要求的边界收口，没有扩展为网页工具或通用任务系统。

## 4. 独立验证资料

主进程脚本：`test-results/review86/verify.ts`，Git忽略目录。它与84号用于证明缺陷存在的脚本相反，断言修复后的实际行为。运行：

```powershell
.\node_modules\.bin\tsx test-results/review86/verify.ts
```

使用隔离临时目录和离线插件，通过真实Core取得epoch、真实ToolExecutor及Worker执行；结束关闭Core、执行器、Worker，并验证绝对路径后清理。复验中没有调用付费服务、没有操作真实QQ。

最新一次独立输出：

```text
startup: settled=true, terminated=true
close-during-sync: elapsedMs=1
internal-timeout: unknown, terminated=true, lateMarker=false
queued-cancel: unknown, count=0
queued-tool-grant-revoked: error, count=0
submitted-commit-revoked: unknown
inflight-guard-revoked: unknown
actual-epoch-and-off: epochType=string, safeFilenames=true, disabled=[]
soft-override-and-hard-removal: scopedCount=1, removedCount=0
```

毫秒数只记录本次观察，不作为普遍性能承诺。Worker只能终止本地执行和阻止晚状态写入，不能据此承诺已发到远端的动作被撤销或费用退还。

## 5. 最终命令与稳定性边界

子代理冻结代码后，主进程独立执行：

| 命令/检查 | 最终结果 |
| --- | --- |
| 原始`npm test` | 105文件通过、1文件失败；1000项通过、1项既有跳过、1项失败（1002项），退出码1 |
| 定向六文件回归 | 98/98通过，退出码0；extension-contracts 7、extension-policy 15、tool-executor 26、extension-runtime 37、atomic-write 5、memory-extraction-runtime 8 |
| `npm run typecheck` | 退出码0 |
| `npm run desktop:build` | 服务端、renderer、Electron main/preload构建通过，退出码0；未打包 |
| `git diff --check` | 通过 |
| 独立反向脚本 | 所有场景通过，包括完整授权撤销、在途unknown与软覆盖追加检查 |

原始全量唯一失败：`test/memory-extraction-runtime.test.ts`的`E2E: delete pauses extraction and re-activation only processes messages after the new boundary`，在第405行等待状态时超时（`condition not met in time`）。同文件随后在上述定向组合中8/8通过。运行时本轮37项在两组命令均通过。

完整输出保存在Git忽略目录的`test-results/review86/final-full.log`与`final-targeted.log`。定向成功不能覆盖原始全量失败，本次不再无限重复全量以取得绿色结果，也没有扩大范围修改记忆生产代码或放宽其断言。

子代理阶段曾在原始全量中观察到记忆提取相关用例等待超时，单独运行通过。该链路不在本轮修改范围，但不能仅据此把失败归因于负载，也不能用后续重跑通过抹去失败；本轮不宣称78号已有记忆稳定性观察已定位或关闭。

## 6. 放行范围

原5项及追加边界的EXT-A～C修复可以关闭；**项目整体验收仍保留记忆提取稳定性待查，不能无保留放行或宣称全量通过。** 下一步先定位全量失败的实际状态/水位与guard原因，保留现场，再决定是否进入EXT-D的完整集成验收。

本轮结论不代表Agent插件工具对用户已完整可用；EXT-D～H仍按79/80号继续，记忆管理页面仍后置。代码已保留在本地工作区，未经请求未提交、未打包或替换EXE。
