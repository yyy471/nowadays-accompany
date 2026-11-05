# P4 恢复、执行真实性与规则组合验收报告

日期：2026-11-04。性质：独立验收，不是实现方自验或新增产品决定。

最新进展（2026-11-05）：第 13 节保留用户接受现有证据、确认 P4 收口的历史；后续[195 P5 整体独立复核](195-p5-independent-review.md)已重新验证第 12 节最后内部结算补修，原场景及二次启动通过。P5 在首轮本机源码原型范围收口，历史自验与用户接受不回写为历史独立通过；没有新增真实服务调用，未提交、未推送。

**结论：P4 首轮验收未通过。** 类型检查、142 项既有离线测试及 11 个 P3 边界场景全部通过；新增 8 个 P4 场景通过 6 个，失败 2 个，没有样例执行异常。发现 P4-R01、P4-R02 两项阻断问题，修复后需要定向复验，当前不能进入 P5 收口或宣告后端验收完成。

本结论不撤销 [184 第 7 节](184-p2-06-acceptance-report.md)的 P2 通过范围或 [188 第 7 节](188-p3-independent-review.md)的 P3 离线通过范围。本轮补验此前明确留到 P4 的真实强杀及重启组合；P3 仍未提交、未推送。

## 1. 范围和快照

- 对照 DL-30、DL-53、DL-65～DL-67、DL-70～DL-73、DL-100～DL-108、DL-113，验收已有角色、任务、记忆、资源和额度规则；不另建恢复系统，不增加权限审批或逐次确认。
- 分支：`codex/p1-role-storage`，HEAD：`3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a`；实际验收对象包括未提交的 P2／P3 工作树，不能只用 HEAD 代表本次实现。
- Node：项目独立的 `prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe`；依赖使用 `backend/node_modules`。
- 本轮未修改业务源码、正式测试或依赖；新增独立脚本 [20261104-p4-acceptance.ts](../backend/reviews/20261104-p4-acceptance.ts)，并同步报告和阶段导航。91 个既有源码、测试、复核脚本及工程文件前后 SHA-256 均一致。
- 全部使用可控离线模型、本地 SQLite 和真实本地 stdio MCP；付费模型调用 0 次，没有读取或写入用户真实模型密钥。
- 后端强杀使用独立子进程的 `SIGKILL`，四个位置均未调用 `app.close()`；只结束本次创建的测试进程。样例与数据库保留在隔离测试目录。

## 2. 证据与运行结果

运行目录：`backend/test-results/p4-acceptance-20261104-195329/`。该目录是本地证据，受现有忽略规则管理；复现脚本纳入版本管理候选。

| 证据 | 结果／用途 |
| --- | --- |
| `baseline-summary.json`、`typecheck.log`、`tests.log` | 类型检查退出码 0；142 项通过，失败／取消／跳过均为 0 |
| `harness-typecheck.log` | 新增复核脚本单独严格类型检查通过 |
| `complete/p4-report.json`、`complete.log` | 本次有效的完整 8 场景报告：6 通过、2 失败、执行异常 0 |
| `complete/kill-*/fixture.json`、`boundary.json`、`worker.log` | 隔离应用路径、角色身份、强杀位置和子进程输出；角色库与实际效果文件保留 |
| `p3-regression/p3-review-report.json` | 原 7 个场景全部通过 |
| `p3-regression/p3-extended-report.json` | 状态化 MCP 暂停续用、建连期间任务结束取消预留，2 个通过 |
| `p3-regression/reservation-boundary-report.json` | 跨日派发和有限／无限制切换取消，2 个通过 |
| `source-before.json`、`source-after.json` | 91 个既有工程文件未变化；仅新增 P4 验收脚本 |
| `verification-summary.json` | 总结以上结果，结论为 `not_passed_p4` |

脚本完善期间的 `p4-report.json`、`verified/`、`final/`、`acceptance/` 保留排查历史，**不作为本轮最终计数**。其中已经排除复核脚本的列名、资源样例缺少 `env`、对话待输入时误等空闲、标签与正文检索字段混用等问题；最终 `complete/` 报告不存在这些样例异常，不将其列为产品缺陷。

## 3. P4 定向矩阵

| 编号 | 操作和核对内容 | 结果 |
| --- | --- | --- |
| A01 | 正常关闭后，将时钟推进至安排过期；重新打开原数据目录，自动唤醒一次，模型加载最新角色设定和状态；原安排完成，同日额度上限 7 保留、消耗 1 | 通过 |
| A02 | 自主任务在最后一个模型点之后因工具无余额暂停；关闭模型资源、修改额度、正常退出，次日重启；原任务继续，日记仅一篇、两次模型及一次工具计 3 点；随后新任务不能借用该已关闭资源 | 通过 |
| A03 | 自主任务实际追加文件，成功结果已经保存；下一次模型调用开始后强杀后端，再从同一目录重启并显式触发调度 | **失败：原任务未被重新评估，见 P4-R01** |
| A04 | MCP 已向文件写入实际效果，但故意不返回响应；强杀后端及本次工具进程，再从同一目录重启 | **失败：调用保留为 running、无未知结果记录，见 P4-R02；同时命中 R01 的调度缺口** |
| A05 | 用户回复已经输出部分文字时强杀；重启保留原文和 interrupted 状态，再发送新消息，使用最新角色设定形成一条正式回复 | 通过；不据此声称未被替代的决策检查点恢复已通过 |
| A06 | 更正事件正文及地点标签后正常退出；重启模拟旧版本修改到达，返回版本冲突；新正文和标签可联合检索，旧标签不命中，原始消息证据未改 | 通过；这是过期版本交错用例，未代替完整跨进程并发验证 |
| A07 | 预算暂停后明确结束原任务，再关闭并次日重启；预算恢复安排仍取消，原任务保持结束，不产生替代任务或模型调用 | 通过 |
| A08 | 同窗口新消息已替代旧回复，且新回复已提交后强杀；重启保留旧部分原文与中断状态、新正式回复及最新角色状态，不续写旧回复 | 通过 |

重放 11 个 P3 场景继续覆盖内部工具计量、时区安排、关闭模型／MCP 后原链延续、终态不复活、自主活动不增加对话整理轮次、暂停状态清除、状态化 stdio 会话延续、未派发取消退还、跨日及模式切换的扣点结算。

既有 142 项回归覆盖的晚到结果、状态版本、模型配置刷新、记忆形成和维护等结果按其原测试范围保留；不把这些测试计数直接解释为所有 P4 强杀组合都通过。

## 4. 阻断问题

### P4-R01［P1］运行中自主任务重启后成为无后续调度的活动记录

**依据：** DL-30、DL-65～DL-67、DL-113，重启后应沿用已有进度和实际结果，对未完成任务结合当前资料重新评估。

**复现：** A03 的原任务 `98acbf9f-3ba6-41fb-beba-0b68d9590564`，原执行 `4ebe85f5-0a8d-4a18-b8c4-1369eb0d2ce9`。本地 `workspace_write` 已实际追加 `effect.md`，工具调用 `34addf34-ef6e-4cf4-80da-666d59b9938c` 的成功结果已保存；进入下一次模型调用后强杀后端进程 49348。

重启后观察：

- 执行被改为 `failed / PROCESS_INTERRUPTED`，原任务仍为 `active`；活动仍为 `running`，原唤醒仍为 `claimed`。
- 成功工具结果和文件中唯一一次效果均保留，但恢复模型调用为 0；显式调用现有调度入口也不能继续原任务。
- 没有待领取唤醒或已恢复的任务延续进入调度。A04 的未完成自主任务也出现同样的停滞。

**实现位置：** [ConversationService.recoverOnStartup](../backend/src/application/conversation-service.ts:383)只调用执行中断处理，再为 pending 唤醒设定时器；[ConversationStore.recoverInterruptedExecutions](../backend/src/storage/conversation-store.ts:1049)将运行中执行记为失败，没有协调原任务、活动、已领取安排与原检查点进度。运行时的 `pendingContinuations` 也未在启动时从这些持久记录恢复。

**影响：** 重启保存了任务名称与效果，却不能让角色继续处理未完成事项；界面还可能长期显示实际上已经不运行的活动。该问题不能靠等待下一次用户发消息或重建新任务替代。

**修复与复验要求：** 基于现有业务档案和检查点协调未结束的原任务，恢复必要的评估入口；新的判断加载最新设定、状态、资源和预算。已保存成功结果应复用，不能重做实际效果；已结束任务与被新消息替代的回复继续排除。不要简单把所有 claimed 安排改成 pending 后另建新任务。修复后重跑 A03，并补同一任务身份、原执行进度、已有成功结果及文件效果次数的断言。

### P4-R02［P1］进程终止后未返回的工具调用仍记为运行中，没有进入未知结果处理

**依据：** DL-53、DL-70、DL-113，无法确认结果应明确记为未知，先核对实际状态；不能直接推断失败或按未执行重试。

**复现：** A04 使用真实本地 MCP 样例 `effect_then_wait`：先写 `effect.log`，再永久等待，不返回协议结果；确认效果发生后强杀后端进程 40436，并结束本次工具进程。

重启后观察：

- 原工具调用 `10742092-f4ce-407e-886b-5f6a595337ec` 仍为 `running`，`tool_results` 中没有对应结果。
- 原执行已是 `failed / PROCESS_INTERRUPTED`，实际工具进程已经退出，但记录仍暗示在运行。
- 文件中实际存在一次 `effect`；没有进入角色核查决策，恢复模型调用为 0。此处无响应确实不等于没有发生操作。

**实现位置：** [ConversationStore.recoverInterruptedExecutions](../backend/src/storage/conversation-store.ts:1049)只恢复执行、部分回复和运行中的模型调用，没有协调这些执行关联的未返回工具调用。P4-R01 修复调度本身也不能替代本项对未知结果的明确记录。

**影响：** 工具账面状态与实际进程不一致，角色后续不能可靠区分“仍在执行”和“结果未知”；如果恢复时直接重试，有重复外部效果的风险。本次未观察到重复操作，因为恢复链尚未启动，不把潜在重复说成已发生。

**修复与复验要求：** 区分尚未派发和已经进入调用流程、但无明确结果的记录；对无法确认的在途调用按现有 unknown 及结果修订机制保存事实，保留原调用身份，不伪造成功或失败。向原任务提供未知事实，由角色利用可用手段先核查，无法核实时继续保留未知，不要求任意工具都提供专用核查接口。复验 A04 的未知记录、实际文件核查和未知→明确结果关联；再补仍不可核实的保留未知用例，确认没有盲目重发或重复扣点。

## 5. 复现入口

在 `backend/` 执行。每次使用新的项目内证据目录，避免混入历史运行；脚本退出码 1 表示业务断言未通过，2 表示样例运行异常。

```powershell
$runRoot = Join-Path (Get-Location) ('test-results/p4-rerun-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path (Join-Path $runRoot 'tmp') -Force | Out-Null
$env:TEMP = Join-Path $runRoot 'tmp'
$env:TMP = $env:TEMP
$env:P1_REVIEW_TMP_ROOT = $env:TEMP
$env:NOWADAYS_REVIEW_OUTPUT = $runRoot
$nodeExe = '../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe'
& $nodeExe node_modules/typescript/bin/tsc --noEmit
& $nodeExe --import ./test-results/p1-review-20261103/fs-guard.mjs --import tsx --test tests/*.test.ts
& $nodeExe --import ./test-results/p1-review-20261103/fs-guard.mjs --import tsx reviews/20261104-p4-acceptance.ts
```

P3 重放入口为 `reviews/20261104-p3-review.ts`、`reviews/20261104-p3-fix-recheck.ts`、`reviews/20261104-p3-reservation-boundary-review.ts`；同样使用上述隔离变量和显式 Node。

## 6. 未通过后的边界

本轮完成首轮独立验收与缺口定位，**未修复 P4-R01／R02、未提交、未推送，不宣告 P4 或正式交付完成**。下一步先修复两项恢复缺口，再用已有脚本加补充断言定向复验。

以下范围仍未验证或需修复后补验：恢复继续时复用成功结果而不重复执行、业务结果领先图检查点的恢复、未知结果的实际核查／无法核实处理、派发前／最终提交附近的额外强杀边界、完整跨进程记忆修改并发与数据库异常组合。已失败的恢复链不能用“当前没重做”替代这些通过证据。

真实 P3／P4 模型场景本轮未调用；此前 DeepSeek Anthropic Messages 的 P2 真实验证结论保留，但不能扩大为上述真实恢复场景已通过。多进程并发运行、其他厂商／协议、远程 MCP、网页与视频能力、桌面前端／打包均不在本轮通过范围。

## 7. 191 修复后的独立定向复验

日期：2026-11-04。**结论：原 A03／A04 已通过，P4-R01／R02 在消息切换与重启组合中仍有遗留，暂不关闭，P4 不通过。** 191 的自验与本节独立结果分别保留。

### 7.1 快照及结果

运行目录：`backend/test-results/p4-independent-recheck-20261104-202253/`。分支及 HEAD 与第 1 节一致，验收对象是 191 修复后的未提交工作树。使用同一独立 Node 24.22.2 与后端依赖；业务源码、正式测试和依赖在本轮前后未修改，新增脚本 [20261104-p4-recovery-recheck.ts](../backend/reviews/20261104-p4-recovery-recheck.ts)。全部使用离线模型和真实本地 stdio MCP，没有真实模型或付费调用。

| 检查 | 独立结果与证据 |
| --- | --- |
| 类型检查及正式回归 | 145／145，失败／取消／跳过均为 0；`baseline-summary.json`、`typecheck.log`、`tests.log` |
| 原 P4 八项 | 8／8，无样例异常；`p4/p4-report.json`、`p4.log` |
| P3 原七项及两组扩展 | 7＋2＋2 全部通过；`p3/p3-review-report.json`、`p3/p3-extended-report.json`、`p3/reservation-boundary-report.json` |
| 新组合四项 | 2 通过、2 失败，无样例异常；`extended/p4-recovery-recheck-report.json`、`extended.log` |
| 四项真实强杀资料 | `extended/<用例名>/before-kill.json`、`boundary.json`、`fixture.json`、`worker.log`，以及隔离角色数据库、实际效果及核查文件 |
| 快照和汇总 | `source-before.json`、`source-after.json`、`verification-summary.json` |

原 A03 现在能使原自主任务进入延续，成功工具结果被提供给后续模型，工具及效果没有再次生成；原 A04 的在途调用变为 `unknown / PROCESS_INTERRUPTED` 并提供给角色。正常过期唤醒、跨日预算及原链资源延续、部分回复／新消息隔离、纠错索引和终态防复活也保持通过。上述通过不能直接覆盖旧执行已经成为 `superseded` 的情况。

### 7.2 新增组合

| 用例 | 真实操作 | 结果 |
| --- | --- | --- |
| `autonomous-superseded` | 自主任务调用 MCP，实际效果已发生且不返回；用户新消息替代旧回复，最新回复提交后强杀；重启核对原任务和工具 | **失败**：原任务 active、旧执行 superseded、工具 running、无结果行；恢复模型调用 0 |
| `user-superseded` | 用户任务调用同一 MCP，在实际效果发生后由同窗口新消息替代旧回复；新回复提交后强杀并重启 | **失败**：用户原任务同样 active、旧执行 superseded、工具 running、无结果行；恢复模型调用 0 |
| `ended` | 自主任务工具在途时明确结束原任务，再强杀重启 | 通过：原调用记录 unknown，保留一次实际效果；原任务仍结束，恢复模型调用 0，不复活任务 |
| `check-unknown` | 普通运行中自主任务在效果发生、结果未返回时强杀；恢复模型先读 unknown 事实，再调用本地 `effect_status` 核查真实效果，之后完成 | 通过：核查工具成功一次、两次模型调用、原效果仍只有一次；原 unknown 事实保留，没有盲目重发原操作 |

`check-unknown` 验证的是角色用可用工具实际核查，不是系统新增通用核查器；没有以该核查自动改写原结果。191 正式回归中同一调用的 unknown→明确结果修订机制另有测试，两者不混为一项证据。

### 7.3 P4-R01 遗留［P1］：旧回复替代后，原有效任务没有恢复

**依据：** DL-69、DL-101、DL-113。新消息只替代未完成回复，原任务和已发出的工具操作独立延续；禁止续写旧回复不等于结束原任务。

第一项的原自主任务为 `235ee24b-cadb-463f-92cb-6d43f62feee0`，旧执行为 `49dbfb08-374f-4f7d-bed1-7e17670bd6b2`。强杀前新用户回复已经 completed，原任务仍 active，旧执行已 superseded；重启后没有任何原任务评估，实际效果仅一次但没有继续处理入口。第二项的用户原任务 `3267ee7f-73c7-46df-bdc2-83c6b252ccde` 复现同样结果。

**原因：** [recoverInterruptedExecutions](../backend/src/storage/conversation-store.ts:1058)只选择 `executions.status = 'running'`，两个旧执行均已是 superseded，不在返回列表中。[recoverOnStartup](../backend/src/application/conversation-service.ts:383)只从这个列表恢复延续，还额外限定 `taskOrigin === 'autonomous'`。该条件无法代表全部仍有效的独立任务。

**修复要求：** 依据任务自身是否结束、已保存进度及未处理工具事实协调恢复，覆盖自主和用户来源；沿用原 taskId，不把被替代回复恢复成旧答案，也不另建替代任务。明确结束的任务继续排除，新消息优先和预算／资源延续规则继续保持。修复后重跑两个 superseded 用例以及 ended／A08，分别证明“继续原任务”和“不续写旧回复／不复活终态”。

### 7.4 P4-R02 遗留［P1］：未知工具恢复范围仍绑定于回复执行的 running 状态

**依据：** DL-53、DL-70、DL-101、DL-103、DL-113。调用实际结果的保存与核查，不应依赖其所属回复是否已经被替代；结束任务也不代表调用必然没有发生。

两项失败中，工具调用分别为 `b2f942cf-a362-45b4-a548-f294c39fde3f`、`3867b503-e414-4091-bfe6-77d39834df94`。MCP 实际文件均有一次 `effect`，强杀重启后仍为 running、tool_results 为空；原工具进程已结束，状态没有归入 unknown。

**原因：** [recoverOnStartup](../backend/src/application/conversation-service.ts:403)只把本次 `running` 执行恢复列表传入 [recoverInterruptedToolCalls](../backend/src/storage/role-store.ts:1162)。RoleStore 对传入调用的状态区分有效，但 superseded 旧执行完全没有传入，因此跳过整个调用。

**修复要求：** 启动时对进程退出后无法继续确认的未返回调用进行独立协调，不能只依赖原回复执行的 running 列表。保留原调用身份、已保存明确结果及既有 unknown 修订记录；不伪造执行失败或重复发出操作。未结束任务收到 unknown 后可结合可用工具核查；已结束任务只保存实际未知事实，不自动派生新任务。两个失败用例与 ended、check-unknown 应一起复验。

### 7.5 范围与下一步

P4-R01／R02 的原始简单重启场景已经改善；本轮保留两项编号作为组合遗留，不把同一缺口重复计为新的 R03／R04。实现记录 191 中“已替代任务不复活”的表述应明确区分被替代的回复执行与未结束的独立任务，不能将该表述解释为取消 DL-101 的原任务延续。

下一步先补齐两项遗留并定向复验，P4 仍不收口、不进入 P5。第 6 节其余未验证范围继续保留；本轮没有验证原执行检查点恢复、额外提交边界或跨进程数据库异常的完整组合，不能仅凭原 taskId 保持就宣称这些全部通过。未提交、未推送。

## 8. superseded 补正复核及用户链直接补修

日期：2026-11-04。用户要求“复核修改”。本节区分对 191 第 6 节既有修改的独立复核，以及本轮发现问题后直接实施的补修；后者不冒充独立复验。

### 8.1 原修改复核与新增复现

修改前类型检查、150 项正式测试、原 8 个 P4 及第 7 节的 4 个强杀组合通过。被替代回复所属的自主／用户原任务现在能够继续，在途工具保持原身份转为 unknown，ended 不复活、A08 不续写旧回复；R02 在这些已验范围关闭。

补充以下两项实际强杀用例，修改前均失败：

| 问题 | 补修前事实 | 依据 |
| --- | --- | --- |
| P4-R01 遗留［P1］：用户直接重启未接回原任务 | `user-running` 没有新消息替代；效果发生后强杀，重启将工具记为 unknown，但新回复没有关联原 taskId，原任务仍 active，原工具事实未送入该回复 | DL-30、DL-67、DL-113 |
| P4-R03［P1］：用户原链在关闭资源后重启失去资源 | `user-superseded-disabled` 在新消息回复后关闭模型和 MCP，再强杀重启；原任务延续取不到模型，调用 0 次，任务由 active 变成 failed | DL-71、DL-73、DL-113 |

前者的 `beginExecution` 只领取待回复消息，未找回其原执行关联的有效任务；启动也未主动调度该用户任务。后者只为自主任务保存／读取资源延续，用户链依赖进程内缓存，重启后失效；它与 R02 的未知事实归档根因不同，单列 R03。

### 8.2 本轮直接修改

- [ConversationStore](../backend/src/storage/conversation-store.ts)新增 `findInterruptedUserTask`，只为待回复输入找回因 PROCESS_INTERRUPTED 中断、仍 active 且已有工具事实的用户任务。创建回复执行、关联原 taskId 为 continues、领取原输入在同一事务中完成。
- [ConversationService](../backend/src/application/conversation-service.ts)启动时触发上述任务的现有调度，传入原任务和工具事实，提交后原输入只处理一次。普通部分回复、纯文本旧回复和明确结束的任务不进入该恢复路径，新消息与输入状态规则保留。
- 用户任务创建时保存原链资源；用户和自主任务恢复都读取既有的模型／MCP／Skill 延续。关闭资源仍阻止新任务，原链结束后释放延续，没有新增授权或审批。
- 新增 [p4-user-recovery.test.ts](../backend/tests/p4-user-recovery.test.ts)两项正式回归；[复核脚本](../backend/reviews/20261104-p4-recovery-recheck.ts)扩展至六项，关闭资源场景实际调用 MCP 核查，并检查新任务不能借用关闭资源。

### 8.3 验证证据

运行目录：`backend/test-results/p4-review-fix-20261104-204505/`。分支及 HEAD 与此前一致。使用独立 Node 24.22.2、后端依赖、离线模型及真实本地 stdio MCP，付费调用 0。业务源码只改 conversation-service、conversation-store；扩展原复核脚本，新增一份正式测试；未提交、未推送。

| 验证 | 结果／证据 |
| --- | --- |
| 修改前基线 | 类型检查、150 项测试通过；`baseline-summary.json`、`tests-before.log` |
| 补修前六组合 | 原四项通过，新增两项失败，无样例异常；`extended-before/p4-recovery-recheck-report.json` |
| 补修后类型检查 | 工程及复核脚本严格检查均通过；`after-summary.json`、`typecheck-after.log`、`harness-typecheck-after.log` |
| 全量回归 | 152／152，失败／取消／跳过均为 0；`tests-after.log` |
| 原 P4 八项 | 8／8；`p4-final/p4-report.json` |
| 扩展六项强杀 | 6／6，无样例异常；`extended-final/p4-recovery-recheck-report.json` |
| P3 边界 | 7＋2＋2 全部通过；`p3-final/` 三份报告 |
| 快照及汇总 | `source-before.json`、`source-after.json`、`verification-summary.json` |

`user-running` 在显式调度前已自动调用模型一次，原 taskId 完成，原输入提交一次，没有新增工具调用，未扣自主点数；再次打开同一目录不重复处理。

关闭资源场景中原用户任务恢复，实际使用原 MCP 核查一次、调用模型两次，效果仍一次；原链完成后发送新任务，没有模型调用，不能借用已关闭资源。ended、A08 和预算暂停保护保持通过。

### 8.4 结论与范围

R02 的原修改在本轮独立范围关闭；R01 遗留及 R03 已直接修正、自验通过，**补修待后续独立复验**。实现记录见 [191 第 7 节](191-p4-recovery-fix-record.md)。本轮复核修改已完成，没有已复现而未处理的补修失败。

保持原 taskId 不等于恢复原执行检查点。第 6 节所列原执行进度／检查点、额外提交边界、跨进程并发及数据库异常组合仍需完整验收；真实模型恢复、远程 MCP、桌面交付未验证。P4 仍未完整收口，不进入 P5 或宣告整体交付完成。

## 9. 补修独立复验与 P4 剩余重点验收

日期：2026-11-05。用户要求“开始 1 和 2”，即复验第 8 节补修，并执行剩余 P4 重点验收。**步骤 1 通过；步骤 2 已执行但未通过，P4 不能收口。** 本轮保持业务源码、正式测试和依赖不变，只新增独立验收脚本及同步文档。

### 9.1 步骤 1：R01／R03 补修独立通过

核对第 8 节用户直接重启的原任务关联、消息领取事务、用户链持久资源延续和关闭资源后的新任务隔离；重跑类型检查、152 项正式测试、原 8 个 P4、6 个强杀组合及 11 个 P3 场景，全部通过。输入只处理一次，原 taskId 保持、unknown 事实保留、原效果不重做，ended 与 A08 仍不复活／续写。R01／R03 在这些范围关闭，R02 保持关闭。

这一步确认既有任务档案和资源延续修复，不用其通过代替 DL-66／DL-67 要求的原执行检查点恢复。

### 9.2 快照和证据

分支 `codex/p1-role-storage`，HEAD 仍为 `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a`；验收实际包含未提交工作树。运行目录：`backend/test-results/p4-final-acceptance-20261105-090420/`。

- 使用项目独立 Node 24.22.2、后端锁定依赖、可控离线模型、真实 stdio MCP、隔离 SQLite；没有真实模型或付费调用。
- 新脚本：[20261105-p4-remaining-acceptance.ts](../backend/reviews/20261105-p4-remaining-acceptance.ts)，单独严格类型检查通过。95 个既有源码、测试、复核脚本及工程文件前后 SHA-256 一致，没有业务改动。
- 正式基线：`baseline-summary.json`、`typecheck.log`、`tests.log`；152 项通过，失败／取消／跳过均为 0。
- 步骤 1 的五份报告位于 `step1/`：`p4-report.json`（8）、`p4-recovery-recheck-report.json`（6）、`p3-review-report.json`（7）、`p3-extended-report.json`（2）、`reservation-boundary-report.json`（2），全部通过。
- 步骤 2 最终报告为 `remaining-verified/p4-remaining-report.json`，日志 `remaining-verified.log`；8 项中 4 通过、4 失败、执行异常 0。强杀前后的业务记录、原执行检查点、真实效果、进程编号及调用材料均在报告中；各用例目录保留 `fixture.json`、`boundary.json`、工具效果、子进程日志和隔离数据库。
- `source-before.json`、`source-after.json`、`verification-summary.json` 保存快照及汇总，结论为 `step1_passed_step2_not_passed`。

`remaining/` 是尚未加入预留额度断言的初步运行；`remaining-final/` 有一项测试子进程保活不足导致退出 13，属于样例异常，已修正并重跑，不列为产品缺陷。两者均不作为本节最终计数；最终以 `remaining-verified/` 为准。

### 9.3 步骤 2 矩阵

强杀钩子仅包装测试子进程内已有方法，不向业务代码加入故障开关。父进程只结束本次创建的后端／工具进程；正式业务库和图检查点分别实际落盘，不能视为同一事务。

| 用例 | 实际边界及观察 | 结论 |
| --- | --- | --- |
| before-dispatch | 工具登记、额度预留后，进入运行标记与实际派发前强杀；没有实际效果，恢复后记录未派发失败正确，但两次模型调用消耗 3 点 | 失败，R06 |
| result-before-checkpoint | MCP 已追加一次效果，成功结果已保存，工具节点检查点尚未提交时强杀；结果保留且效果未重复，但原 executionId 被记失败，另建执行，未恢复原图进度 | 失败，R04 |
| checkpoint-before-commit | 原图已生成最终答复及 statePatch，正式提交前强杀；重启另建执行、多调用模型一次，原答复只留为 interrupted，已保存的待提交状态没有继续提交 | 失败，R04 |
| commit-before-task-finish | 正式回复及角色状态已提交，原任务收尾前强杀；重启不再调用模型，但任务 active、活动 running、唤醒 claimed、资源延续未释放 | 失败，R05 |
| result-db-failure | 实际效果已发生，SQLite 触发器阻止结果写入；终止进程、移除故障再重启，保留原工具 unknown，不重发效果，不复活已失败任务 | 通过 |
| commit-write-failure-rollback | SQLite 触发器阻止正式状态提交；角色版本和输入处理标记不部分保存，无伪完成答复；解除故障后可处理输入且只产生一条正式答复 | 通过 |
| memory-index-write-failure-rollback | 纠错时索引写入故障，正文、版本、标签、修订及索引保持原值，没有半成功的纠错 | 通过 |
| two-process-memory-correction | 两个独立后端进程经文件屏障同时更正同一 version=1 事件；一项成功、一项 MEMORY_VERSION_CONFLICT，最终 version=2，正文／地点／检索一致，原文未改 | 通过 |

双进程用例只证明该记忆纠错事务竞争，不代表多后端同时运行的全部调度行为已获支持；数据库故障结果只覆盖本节实际注入点，不宣称任意损坏均能自动修复。

### 9.4 P4-R04［P1］：原执行检查点未参与正式恢复

依据 DL-65～DL-67、DL-113。`result-before-checkpoint` 的原执行为 `c2739941-6c69-4f0b-a25f-c503f71331a9`；业务成功结果领先检查点，图中仍有 round=1 的工具请求。恢复保留效果和工具结果，但原执行记为 failed，创建新的 tool_result 执行，而非继续原执行。

更明确的 `checkpoint-before-commit` 原执行为 `89f313c8-fc2e-4ab5-a0d2-782095f50c4c`。强杀前的真实 SQLite 图检查点已有 round=3、完整文字“原检查点中的最终回复”、statePatch `mood=检查点内的状态`，没有待调用工具。重启没有提交这些结果，反而再调用一次模型，新正式答复为“恢复后新执行另写的回复”，角色 mood 仍为“平静”。原文字保留为中断记录，不能将此称为原文丢失；丢失的是继续原进度并提交有效待提交结果的能力。

位置：[AgentGraphRunner.run](../backend/src/application/agent-graph.ts:150)始终创建 initialState 并调用 `graph.invoke(initialState)`；[启动恢复](../backend/src/application/conversation-service.ts:383)与 `beginTaskContinuation` 创建新的执行编号，没有按原 thread_id 加载和继续图状态。此前原 taskId 保持的修复不能覆盖这个契约。

修复要求：未被新消息替代且应恢复的同次决策使用原 executionId／thread_id，读取真实检查点及业务实际结果；成功步骤不重做，结果未知先核查。已形成有效最终结果但尚未提交时，不能无故丢弃并重新调用模型。新的判断应刷新最新设定、状态、资源、预算和相关记忆，旧检查点不能回滚已提交业务；状态版本或新消息导致材料失效时按既有规则重新判断，不盲目提交旧状态。不把 superseded 的旧回复恢复为旧答案，不另建恢复系统。

复验至少覆盖本节两个位置、恢复时资料更新、成功结果领先检查点、最终提交幂等及旧回复替代。原执行进度与原任务身份分别断言。

### 9.5 P4-R05［P1］：答复提交与任务收尾之间退出，终态不能收敛

依据 DL-71、DL-72、DL-113。`commit-before-task-finish` 原执行 `ce182015-4129-4270-b441-2cbf8018ef8b`、原任务 `8ffe2efb-25e0-4d66-9cf9-15cced62ede0`。正式答复、角色状态和 execution=completed 都已保存，任务仍 active；重启后任务、活动及已领取安排没有收尾，两个资源延续的 ended_at 仍为空。此处恢复不应重复调用模型或重做效果。

位置：[runExecution 正式提交与收尾](../backend/src/application/conversation-service.ts:1175)分步调用 commitConversation、finishTaskAfterExecution、活动更新及 completeWake；启动恢复只处理运行中或 superseded 的执行，没有协调这个已完成执行留下的收尾间隙。

修复要求：基于同一业务库事务或可幂等重入的收尾协调，使已提交答复对应的任务、活动、唤醒与资源延续最终一致；启动可识别历史间隙，不能重生成答复或重复扣点。只能收尾确实应结束的原链，不能把仅被引用的其他任务一律结束。复验提交前／后强杀、重复重启、收尾失败回滚／重入以及资源最终释放。

### 9.6 P4-R06［P1］：未派发工具的预留额度跨退出无法结算

依据 DL-105～DL-108、DL-113。`before-dispatch` 原执行 `50b9bf93-dcbe-45b1-a054-13c76849e7f3`。在原模型返回后，工具已登记并预留 1 点，尚未进入运行标记或真实调用就强杀；实际效果为空。重启正确将其记为“尚未派发”失败，随后新增一次恢复模型调用。当天总共两次模型调用、零次工具调用，计量账本两点，余额却已用三点。

位置：[reserveTool](../backend/src/application/conversation-service.ts:954)先持久扣除预留点数，再仅用内存中的 settled／committed 和取消闭包管理；[reservePoint](../backend/src/application/autonomy-service.ts:285)没有与原调用绑定的持久预留结算材料。进程消失后没有取消闭包退还该次未派发预留。

修复要求：为预留与原调用保存可恢复的关联及结算状态，在已知未派发时幂等退还，在实际派发／结果未知时按真实阶段处理，不能盲目退还在途调用。保持原日期、有限／无限制、跨日实际派发和取消口径，不能把旧日预留退成新日额外余额，不重复记账或重复释放。具体字段由实施方在现有架构内确定，不增加用户配置或审批。复验本例、重复重启、跨日及模式切换，并重放已有 P3 预留边界。

### 9.7 当前结论及后续修复顺序

步骤 1 已完成，R01～R03 在已验范围关闭；步骤 2 的八项重点验收已执行，四个失败对应 R04／R05／R06 三项未实现完整的恢复保障。**本轮没有修改业务实现，也未将三项新阻断记为修复完成；P4 未通过、不进入 P5。**

后续开发先补原执行检查点恢复，再联合补齐提交收尾和预留结算，并以本节脚本复验；改动需自验和独立复核分别留证。完整多进程运行、其他数据库损坏组合、真实模型恢复、远程 MCP 和桌面交付仍未验证。未提交、未推送，无付费调用。

## 10. R04～R06 修复复核与恢复边界补修

日期：2026-11-05。用户要求“复核修复”。验收对象为 191 第 8 节的未提交修改；分支、HEAD 与第 9 节相同。本节区分原修改的独立复核和本轮直接补修的自验，不以后一项代替独立复验。

### 10.1 原修改的复核结果

修改前类型检查及 157 项测试通过；第 9 节八项异常验收独立通过。原执行 ID 保持、检查点已生成文字／状态继续提交、成功 MCP 效果不重做、未派发预留退还均在原场景成立；R05 的答复后收尾间隙能够在重启后收敛，零模型重调、资源结束，R05 在已验范围关闭。R01～R03 已关闭范围保留。

补充检查内部操作与模型中断后复现以下遗留，分别属于 R04／R06 的完整性，不重复新建 R07～R09：

| 场景 | 补修前观察 | 所属 |
| --- | --- | --- |
| internal-diary | 同一模型工具回合先写日记，再调用 MCP；MCP 成功结果入库、图节点尚未保存时强杀，恢复重做日记，产生两篇，使用 5 点而账本仅 4 点 | R04／R06 |
| committed-crossday | 工具已在 11 月 5 日派发并保存成功结果，计量写入前强杀；11 月 6 日重启补记却用重启时间，次日只有一次模型调用、用 1 点，次日账本却含两点 | R06 |
| partial-after-tool | 已完成一个工具回合后，下一模型只输出半句话便强杀；恢复原执行产生新答复时旧片段被覆盖，没有独立 interrupted 消息 | R04 |

前两项证据在 `extended-before/`，第三项在 `partial-before/`；第三项是在前两项补修后继续核验原文保留时复现，该目录不是最初 157 项快照。不能将这些直接补修结果称为原实施方外的独立通过。

### 10.2 直接补修

- [AgentGraphRunner](../backend/src/application/agent-graph.ts)为内部工具按执行／回合／索引／工具名生成稳定步骤键，复用 [ConversationStore](../backend/src/storage/conversation-store.ts)已有业务事件保存执行意图与结果凭据。成功结果重用、不重复执行或扣点；意图存在但结果未确认时保存 unknown，先核查实际记录，不盲目重做。状态工具的已确认补丁仍参与图结果。
- 内部工具的完成凭据和计量使用同一业务事务；中断后只能确认意图的步骤，也按原调用时间补齐一次计量。继续使用既有任务／事件体系，没有新增恢复系统、schema、依赖、授权或用户配置。
- 外部工具正常结果计量和启动补记统一采用持久预留的派发时间，不采用结果返回或重启时间；跨日补记不改变实际消费日期，不向新一天补发旧日点数。
- 恢复仍在运行的模型调用时，在同一事务内保存已输出文字为 interrupted、登记原始证据及中断事件；原 executionId 保持。新一段输出单独保存，后续中断只收集最近中断标记后的新片段，不把旧片段重复拼接或覆盖。
- 新增 [p4-internal-recovery.test.ts](../backend/tests/p4-internal-recovery.test.ts)六项正式回归：成功内部结果复用、不明内部操作不重做、抛错后不伪造明确失败、正常晚到／启动补记的派发日期、恢复时中断文字分段保留。

### 10.3 验证与证据

运行目录：`backend/test-results/p4-r04-r06-review-20261105-102057/`。使用独立 Node 24.22.2、后端锁定依赖、离线模型、本地 SQLite／stdio MCP 和本次强杀进程，付费调用 0。未提交、未推送。

| 证据 | 结果 |
| --- | --- |
| `baseline-summary.json`、`typecheck-before.log`、`tests-before.log` | 修改前类型检查、157 项测试通过 |
| `baseline-probes/p4-remaining-report.json` | 原八项异常验收独立通过 |
| `extended-before/p4-remaining-report.json` | 扩展十项中内部日记及跨日补记失败；原八项保持通过 |
| `partial-before/p4-remaining-report.json`、`partial-after/p4-remaining-report.json` | 中断文字场景补修前失败，补修后通过 |
| `final-summary.json`、`typecheck-final.log`、`harness-typecheck-final.log` | 工程及复核脚本严格类型检查通过 |
| `tests-final.log` | 163／163，失败／取消／跳过均为 0 |
| `final163-probes/p4-report.json` | 原 P4 八项通过 |
| `final163-probes/p4-recovery-recheck-report.json` | 六项用户／自主／资源开关组合通过 |
| `final163-probes/p4-remaining-report.json` | 原八项加三项补充，共 11／11 通过，执行异常 0 |
| `final163-probes/` 的三份 P3 报告 | 7＋2＋2 全部通过 |
| `before-fix/`、`source-before.json`、`source-after.json`、`verification-summary.json` | 补修前实现、前后哈希及验证汇总；业务改动限 agent-graph、conversation-store、autonomy-store，另扩展两份复核脚本并新增一份正式测试 |

最终日记只有一篇，余额和账本均为 4 点；跨日例的工具计量仍在 11 月 5 日，11 月 6 日只用 1 点、账本当天也仅 1 点。原模型片段保留为 interrupted，新完整答复是另一条 completed 消息，二者属于同一恢复执行。

原六组合第一次并行复跑中，`user-running` 的固定 200ms 采样早于工具发现完成，形成假阴性；业务原执行其实已完成。脚本现等待模型真正开始后采样启动状态，没有靠额外手动调度满足断言。最终六项通过，不把该采样问题列为产品缺陷。

### 10.4 当前结论

R05 原修复在独立范围关闭；R04／R06 的本轮三处补修自验通过，**仍待后续独立复验，不宣告 P4 正式通过或进入 P5**。本轮请求的复核修复已完成，没有已复现而未处理的补修失败；实施记录见 [191 第 9 节](191-p4-recovery-fix-record.md)。

通过范围限离线模型、本地工具及本节实际进程／数据库边界；完整多后端并发、更多数据库损坏、真实模型恢复与服务端续传材料、远程 MCP、桌面交付仍未验证，不扩大其兼容性或交付结论。

## 11. 内部步骤补修的独立复验

日期：2026-11-05。用户要求“继续复核”。**结论：原补修场景通过，但内部未完成步骤的启动协调仍有遗漏，R04／R06 不关闭。** 本轮仅扩展复核脚本与文档，业务源码、正式测试、依赖均未修改。

### 11.1 已通过范围与证据

运行目录：`backend/test-results/p4-supplement-independent-20261105-104517/`。仍在 `codex/p1-role-storage`，HEAD 为 `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a`，实际包含未提交工作树；使用项目独立 Node 24.22.2、后端依赖、离线模型及真实本地 stdio MCP。没有真实模型或付费调用，未提交、未推送。

| 检查 | 结果／证据 |
| --- | --- |
| 类型检查、正式测试 | 163／163，失败／取消／跳过为 0；`baseline-summary.json`、`typecheck.log`、`tests.log` |
| 原有定向矩阵 | 8 个原 P4、6 个消息／资源组合、11 个上轮异常场景、P3 的 7＋2＋2 均通过；`baseline-probes/` 六份报告 |
| 本轮扩展矩阵 | 13 项中 11 通过、2 失败，无样例异常；以 `verified/p4-remaining-report.json`、`verified.log` 为准 |
| 脚本检查及快照 | `harness-typecheck.log`、`source-before.json`、`source-after.json`；只有复核脚本变化，没有业务改动 |
| 汇总 | `verification-summary.json`，结论 `not_passed_supplement_review` |

上轮的日记重做、跨日计量日期、中断片段保留三项复现均已通过。这证明重新进入原工具节点时凭据能复用，不代表所有启动路径都会重新进入该节点。

### 11.2 两个新增场景

两项均使用真实日记创建和原有业务库；钩子仅存在于测试子进程，实际确认日记文件／记录已经保存。

| 用例 | 操作与持久结果 | 失败依据 |
| --- | --- | --- |
| internal-intent | 日记保存后、内部工具尚未返回／写入完成凭据时强杀。最新图检查点仍为 round=0，启动进入原任务延续并完成任务；日记只有一篇 | 内部凭据仍只有 tool_started，没有 unknown 完成事实；已用 3 点，账本仅两次模型调用、2 点，漏掉一次已调用日记工具 |
| internal-receipt-db-failure | SQLite 触发器使内部工具计量插入失败，完成凭据和计量按事务一并回滚；日记已经保存，执行／任务因错误变为 failed。移除测试故障后重启 | 日记仍只有一篇、没有新模型调用，但凭据仍只有 tool_started；已用 2 点，账本只有一次模型调用、1 点，内部操作未结算 |

`internal-intent` 原执行为 `c6287d46-e71c-48a9-bc71-91ea8373bc24`，任务为 `3a177799-e945-41d6-a5f9-0d5df383dcc7`；`internal-receipt-db-failure` 原执行为 `a12114a2-3a22-4f98-8295-377b978df192`，任务为 `d1c35edb-8ae4-46c1-ab7d-10f202a78ec7`。最终报告同时保存内部凭据、模型输入、预算、账本、任务终态、原检查点和实际日记。

第一项不以初始检查点转为任务延续或执行编号变化判失败；其断言只核对未知事实、真实日记及计量收敛。第二项也不要求复活失败任务或重调模型。两项没有重写日记，本次观察的是凭据及计量未恢复，不能称为重复副作用或余额多扣：余额对应实际调用，漏的是账本及未知事实。

### 11.3 共用原因与修复要求［P1，R04／R06 遗留］

[executeInternal](../backend/src/application/agent-graph.ts:716)只有再次访问同一执行／回合／索引时，才将 started-only 凭据转换为 unknown 并补记计量。第 10 节正式回归中的未知步骤直接再次调用了该节点，因此覆盖不到以下实际启动路径：

- 检查点未达到恢复条件，原任务进入新的延续执行，原内部步骤不会重放。
- 完成凭据／计量写入失败后，原任务已是终态，启动不能也不应重新运行它。

[启动协调](../backend/src/application/conversation-service.ts:447)目前只显式处理外部工具预留及 `tool_calls`；[延续上下文](../backend/src/application/conversation-service.ts:1756)也只遍历外部工具调用，没有纳入这些内部步骤凭据。因此内部操作事实和计量的恢复仍依赖执行路径，不能覆盖以上两例。

修复应在启动阶段独立协调本次进程中断遗留的内部开始／完成凭据，与是否能回到原节点分开：

1. 有开始凭据但无明确结果时，保留原步骤身份并明确归档 unknown，不伪造成功／失败，不重写日记或重做其他副作用。
2. 按原 counted、派发时间及调用归属幂等补齐账本，不再 consumePoint，不把旧日补记移到新日，不重复补账；保持用户任务豁免及有限／无限制口径。
3. 有效任务继续判断时能够看到内部未知事实及已有结果，不只提供 MCP 结果；原任务已结束时只协调档案，不启动模型、工具或替代任务，不续写被替代回复。
4. 复验两例及重复启动，再重跑原日记幂等、跨日补记、预算暂停、ended 和 A08；检查没有额外日记、模型调用、点数或重复凭据。

### 11.4 当前阶段

R01～R03／R05 保持各自已关闭范围；R04／R06 的原补修复现通过，但以上共用启动缺口尚未修复，仍不关闭。本轮没有业务补修或自验替代独立结论，P4 未通过、不进入 P5。真实服务、完整多后端并发及其他未覆盖范围继续单列，不扩大通过结论。

## 12. 内部步骤启动协调的直接补修与自验

日期：2026-11-05。用户要求“复核修改”。第 11 节两项失败在补修前再次复现；本轮直接修改业务实现，因此本节及 [191 第 10 节](191-p4-recovery-fix-record.md)记录的是补修自验，不能作为独立通过。**两项缺口已修复且自验通过，R04／R06 保持待独立复验；P4 不收口、不进入 P5。**

### 12.1 修改与边界

- [ConversationStore](../backend/src/storage/conversation-store.ts:1193)在启动阶段统一读取每个内部步骤的最新凭据，不再依赖图重新进入原工具节点。只有开始凭据时，保留原 executionId／stepKey，原子保存 `unknown / PROCESS_INTERRUPTED` 和应有计量；不重做业务操作、不再消耗点数。已有完成凭据时幂等补齐缺失计量，已有账本直接返回。
- 使用原派发时间、counted 及原任务归属；兼容此前未保存 purpose／taskId 的凭据。用户任务不进入自主计量，无限制自主操作保留 counted=0；跨日补记仍属原日，重复启动不重复凭据或账本。预算暂停执行保持暂停、不提前结算尚可正常续行的步骤。
- [ConversationService 启动协调](../backend/src/application/conversation-service.ts:441)在任务恢复前结算这些凭据。失败或结束的任务只补档案，不创建替代任务、不运行模型；写入失败时事务回滚，保留开始凭据供后续启动重试。
- [任务延续上下文](../backend/src/application/conversation-service.ts:1794)加入原任务内部操作的结果、原执行及状态、派发时间和步骤身份。未知操作明确呈现 unknown；使用普通历史消息，不伪造提供方工具调用编号／参数。实际验收断言模型读到了步骤键和 unknown，而非只检查数据库。
- 业务变更仅两份 conversation 文件；复用既有事件、任务、账本，没有 schema、依赖、授权或用户配置变动。

### 12.2 验证与证据

运行目录：`backend/test-results/p4-internal-startup-fix-20261105-111543/`。使用项目独立 Node 24.22.2、后端锁定依赖、离线模型、本地 SQLite／stdio MCP 和强杀子进程。分支仍为 `codex/p1-role-storage`，HEAD 仍为 `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a`，包含未提交工作树。没有真实模型或付费调用，未提交、未推送。

| 检查 | 结果／证据 |
| --- | --- |
| 补修前复现 | 13 项中 11 通过、2 失败；`before-probes/p4-remaining-report.json`、`before-probes.log` |
| 工程及验收脚本严格类型检查 | 通过；`checks-summary.json`、`typecheck.log`、`harness-typecheck.log` |
| 正式测试 | 168／168，失败／取消／跳过为 0；`tests.log` |
| 原 P4 场景 | 8／8；`final-probes/p4-report.json` |
| 用户／自主／关闭资源的恢复组合 | 6／6；`final-probes/p4-recovery-recheck-report.json` |
| 扩展异常验收 | 14／14，无样例异常；`final-probes/p4-remaining-report.json` |
| P3 回归 | 7＋2＋2 均通过；`final-probes/p3-review-report.json`、`p3-extended-report.json`、`reservation-boundary-report.json` |
| 实现快照与汇总 | `before-fix/`、`source-before.json`、`source-after.json`、`verification-summary.json` |

新增 [p4-internal-startup.test.ts](../backend/tests/p4-internal-startup.test.ts)五项正式回归，覆盖终态旧凭据跨日与二次启动、用户任务豁免、无限制计量、事务故障回滚及幂等重试、预算暂停保护。异常矩阵新增 `internal-intent-crossday`，并强化两项原失败用例的续行上下文与二次启动断言。

`internal-intent` 恢复后日记一篇，已用与账本均三点，续行模型看见原内部 unknown 事实；跨日变体旧工具仍记原日，次日模型消费及当日账本均一点。`internal-receipt-db-failure` 重启后任务仍 failed，无新模型，日记一篇，已用及账本均两点。三例再次启动均零模型调用，日记、账本和内部凭据数量不变。

### 12.3 当前阶段

第 11 节已复现的启动缺口已补修，无本轮已知未处理失败；本轮直接修改的实现仍需后续独立复验，不能以自验覆盖第 11 节独立结论。R01～R03／R05 保持已关闭范围，R04／R06 暂不关闭。实际覆盖限本节离线及本地数据库／进程边界；完整多后端并发、真实模型恢复、远程 MCP、桌面交付等未覆盖范围继续后置，不扩大通过结论。

## 13. 用户确认 P4 阶段收口与后续入口

日期：2026-11-05。用户在获知第 12 节修复、自验结果及证据限制后明确表示：“可以收口了，后续的步骤是什么”。据此接受当前证据，**P4 阶段收口，R04／R06 按用户确认收口，转入 P5 原型整体复核与交付整理。**

收口依据仍为第 12 节实际证据：类型检查、168 项正式测试、8 个 P4、6 个恢复组合、14 个异常场景及 11 个 P3 场景通过。本次只更新阶段状态，没有新增测试、真实服务调用或独立复验；最终补修的证据性质仍为自验，不改写第 11 节历史独立结论，也不将用户接受标为独立通过。

下一阶段按 DL-114 汇总 P0～P4 的可运行后端、启动与配置说明、不含密钥的配置样例、可重复离线验收入口和业务证据索引；整体自验及独立复核分别记录，通过／未通过／未验证和离线／真实服务覆盖分别列明。最新补修仍可纳入 P5 整体独立复核，不再作为 P4 阶段推进的阻挡。

P5 后按 DL-115 先完成远程 Streamable HTTP MCP 后端补充及对应验证，再讨论桌面前端接入、框架与旧前端是否复用。网页浏览、视频、电脑控制及 QQ／SnowLuma 继续按各自后续工作包推进，不因 P4 收口自动纳入已交付范围。提交、合并、推送与阶段收口分别处理，本次未进行 Git 提交或推送。
