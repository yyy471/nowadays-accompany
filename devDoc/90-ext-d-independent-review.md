# EXT-D 主进程独立复核与接管记录

日期：2026-10-26。状态：D-D/D-E 完成，主进程独立验收通过；范围限本地自动化装配，不代表全部扩展计划完成。

## 范围

复核 [87 执行记录](87-ext-d-agent-composition-execution.md)，接管 D-D 钩子接线及 D-E 真实装配验证。采用 GPT-6 Luna（max）子代理开发、主进程独立检查及复现的流程。单一插件标准；不扩展到 EXT-F/G 页面和 Skill 管理，也不包含真实 QQ、付费模型、发布包验证。

保留现有工作树，未经请求不提交、打包或替换 EXE。

## 接管基线及新增发现

主进程在本轮新增修复前执行全量：107 文件通过，1011 项通过、1 项既有跳过。日志为本地忽略目录 `test-results/ext-d-parent-initial.log`。这证明现有测试通过，不能代替边界复核。

| 项目 | 独立证据 | 处置 |
| --- | --- | --- |
| 原子写重试期间失效的写入 guard 未被重验 | 首次 rename 注入 EPERM 并撤权；修复前第二次 rename 仍提交新内容，实际 attempts=2 | 每次 rename 前重验 guard；只在 Windows 对冲突码作有限重试。修复后主进程复现 attempts=1、旧内容不变、错误码 write_guard_changed。见 [88](88-atomic-retry-guard-fix.md) |
| 同一会话不同消息复用 provider callId 时，内置媒体动作误去重 | 两条不同 messageId、相同 peer、均返回 call_1；修复前实际生成数和任务数均为 1，预期均为 2 | 改用宿主稳定 invocationKey；同一原探针修复后 generated=2、jobs=2。正式 E2E 同时确认同 messageId 重投不重复动作 |
| 关闭等待账号同步链，无法及时中断挂起的档案读取或插件初始化 | 主进程门控 profiles Promise：没有 Worker 需要退出时，close 在 300ms 内仍不返回，释放档案门后才结束；旧链路必须先等 sync 才能关闭运行时 | 修复后独立探针通过：close 不等挂起读取；账号重开、旧读取晚 reject 时新 port 不变。正式回归与全量通过 |
| 工具续答与补充上下文预算尚未闭合 | 结果预算按 executeBatch 重置；assistant 中间文本/参数与后续 tool 消息缺少统一剩余额度 | 主进程接管预算收尾，按最终请求序列化大小与全轮 24KiB 约束，包含 Provider 参数与工具定义；5 项 Provider 边界回归通过，原始 13000 字输入继续保留 |

独立复现脚本与日志存于本地忽略目录 `test-results/review90/`；正式回归源码由子代理及主进程加入 `test/`。

实现期间继续按代码检查并修复了以下边界，冻结版本均已复验：

- 钩子必须使用各自插件在账号档案中的配置，不能始终收到空配置；相同插件版本修改配置也要换代。
- 当前会话有效的账号共享状态授权、插件版本及配置摘要应进入扩展 guard；不能只检查工具名字和 Worker 是否仍在线。
- 故障插件本轮排除后，依赖其工具的 Skill 同步排除；普通 Agent 回复继续。
- 尚在队列中的钩子超时应过期跳过，不能杀掉另一个会话正在正常执行的长工具；已派发的挂死钩子仍要终止代际。
- 发送幂等命中、撤权阻止交付、真实通道异常、物理发送后持久化异常分别核对，不能都报告 sent 或 send_failed。
- 上下文截断要计入包装及协议序列化开销，明确标记截断，不得在剩余预算比标记更小时反而超额。

中途实现未编译就绪时，媒体复现探针曾出现首轮等待超时（当时 `isTurnCurrent` 调用已替换而 helper 尚未补入）；这不作为冻结版本的通过或失败结论，最终须重跑原探针，保留开发过程中的失败记录。

## 开发与复核循环中保留的失败

1. D-E 首轮为 18/20：beforeContext 内撤权后仍调用一次 Provider；关闭 Core 后释放门控仍执行 Worker 完成标记。原断言未放宽。
2. 第一项根因是把撤权造成的 hook 失败当成普通插件故障排除，刷新快照时抹掉了撤权差异。现在排除故障插件前先核验当前作用域策略与插件配置摘要，只有自身运行故障允许降级。
3. 第二项在初次补等待 terminate 后仍复现：取消路径另有未跟踪的 25ms 延迟终止，stop 见 terminated 后提前返回。现在所有终止路径共用真实 termination Promise，等待 grace 和线程退出。原关闭用例及全量均通过。
4. 主进程协议预算测试曾捕获实际请求 12015 字符、预期不超过 12000。额外 15 来自 ProviderRouter 自动补入空 parameters。现在按主目标及 fallback 的最大参数开销预留；中文、引号、反斜杠、跨批次结果及工具定义均纳入实际边界计算。
5. 主进程首次 4 文件回归为 83/84，唯一失败是旧用例要求不同模型回合的 call_1 共享动作。79 的宿主键包含 message/round/index，故修正该旧预期为不同宿主调用独立，保留同一宿主调用重投幂等验证；没有删除重复动作验证。

部分子代理沙箱内 Vitest 命令在收集前因 `node_modules/vitest/dist/spy.js` realpath EPERM 退出；获批沙箱外执行相同命令后才取得真实测试结果。这与 87/88 中运行时原子复名共享冲突是不同问题，不能混为“环境噪声”。

## 最终运行链路与验收映射

`Instance 入站与角色/记忆门 → Agent 捕获当前会话扩展快照 → beforeContext → 角色/世界书/记忆/Skill 与带来源数据组装 → Provider + 统一工具续答 → Instance 出站再次核验并实际发送/持久化 → afterTurn`

媒体仍经原 MediaJob、账本及受控交付链。没有新增第二个消息回复主体；旧插件 onMessage/reply/sends 不作为回复入口。

| 验收项 | 证据与结论 |
| --- | --- |
| A01 | 真实 Core/Worker 组合请求同时包含角色、世界书、手工事实、普通及插件 Skill；Agent 仍拥有唯一最终回复 |
| A02 | `profiles` 未绑定会话静默、`phase1-agent` 暂停、`phase1-identity` 解绑后旧回复失效的既有回归通过；新 E2E 补关闭时 hook 不晚执行 |
| A03 | 主进程独立 hook 探针三种 outcome 与真实通道一致；正式 E2E 包含发送成功而历史持久化失败，仍报告 sent |
| A04 | 故障/慢 hook 退出本轮、依赖工具和 Skill 一起退出，普通回复保留；排队超时不误杀另一个正常长工具；500ms/2s 和慢模型对照通过 |
| A05 | 旧插件回复导出不被调用；插件数据只进非 system，工具返回的指令样文本只进 tool；没有直接发送或提升权限 |
| A06 | 当前私聊撤权、角色/记忆变化、同版本配置变化使旧结果失效；无关账号、群或未参与插件配置不影响当前轮；扩展 guard 不更改角色/记忆 epoch |
| T04/T05/T07/T09 | 实际 Provider assistant/tool 协议配对、一条最终文字回复、预算收口及非工具模型正常回复，通过工具循环和组合测试 |
| L07/M02/R01/R02 | Worker 真实终止、晚结果不写、媒体宿主键幂等、原媒体与 MEM03 回归通过；插件数据/工具轮不提取事实，无 addition 的纯文本控制组仍产生候选 |

## 主进程最终验证

源码及测试冻结后执行，下表全由主进程运行：

| 命令/证据 | 结果 | 本地忽略日志 |
| --- | --- | --- |
| `npm run typecheck` | 通过，含测试源码与 renderer | `test-results/ext-d-parent-final-typecheck.log` |
| 9 文件定向 `npm test -- ...` | 138/138 通过 | `test-results/ext-d-parent-final-targeted.log` |
| `npm test` | 110 文件通过；1046 项通过、1 项既有跳过，无新增 skip | `test-results/ext-d-parent-final-full.log` |
| `npm run desktop:build` | Core、renderer、Electron main/preload 均构建通过 | `test-results/ext-d-parent-final-build.log` |
| `git diff --check` | 通过 | 命令无输出；顺带移除既有并发测试末尾多余空行，仅空白变化 |
| 冻结版原子写反向探针 | 只尝试 1 次 rename，保留旧内容，write_guard_changed | `test-results/review90/final-atomic.log` |
| 冻结版关闭/重开探针 | 不等待挂起 profile；旧 profile 晚失败不关闭新 port | `test-results/review90/final-close.log` |
| 冻结版真实 hook 探针 | sent=1、failed/suppressed=0 次实际发送；before=1，MEM03 候选均 0 | `test-results/review90/final-hooks.log` |

9 文件为 `agent-plugin-composition`、`agent-tool-loop`、`extension-runtime`、`extension-tool-service`、`tool-executor`、`extension-policy`、`atomic-write`、`bounded-text`、`memory-tools`，均为 `test/*.test.ts`。新增正式源码入版本管理范围，日志和探针产物保持忽略。

## 放行范围与后续

D-D/D-E 在上述本地自动化范围内通过。实现说明见 [89](89-ext-d-hooks-execution.md)，E2E 原始失败与修复见 [89a](89a-ext-d-e2e-evidence.md)。没有阻断本轮的遗留失败。

这不代表 79/80 全部完成：EXT-E 的媒体迁移独立验收、EXT-F 的 Skill CRUD/CAS/复制/影响分析与统一解析、EXT-G 的管理页面及真实交互、EXT-H 的整体收口仍按原计划推进。已有媒体 handler 迁移和部分 Skill 解析证据可复用，但不能据此声明整套管理功能完成。记忆管理界面继续后置。

未进行原生界面交互、真实 QQ/SnowLuma、真实网页/视频操作或付费 Provider 验收。本轮未提交、未生成发布包、未替换 EXE。
