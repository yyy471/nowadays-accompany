# P2-06 阶段验收报告

日期：2026-11-04。执行者：本轮验收方。依据：[173 第 8 节](173-p2-memory-agent-development-guide.md)、[174 P2-01 契约](174-p2-01-memory-agent-contract.md)、[182 第 5 节](182-p2-05-independent-review.md)、[183 第 12 节](183-p2-05-review-fix-record.md)。

**最新结论：第 7 节复验通过，R05／R09 已关闭，P2 在首轮单角色后端及本次真实 DeepSeek 配置范围内验收通过，可以进入 P3。** 类型检查、105 项回归、20 个离线场景及 4 项真实复验通过，已补齐真实事件形成、索引、重启后新窗口按需检索与原始证据、回复和状态保存。第 1～6 节保留首轮失败记录，修复自验见[185](185-p2-06-r05-r09-fix-record.md)。本轮只新增复验脚本与文档，未修改业务源码、未提交或推送。

## 1. 环境、快照与证据

| 项目 | 本轮结果 |
| --- | --- |
| 分支／基线 | `codex/p1-role-storage`，Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a`＋未提交 P2 工作树 |
| 环境 | Windows x64，P0 专用 Node.js 24.22.2、独立 backend 依赖 |
| 运行编号 | `p2-06-acceptance-20261104-165104` |
| 证据目录 | `backend/test-results/p2-06-acceptance-20261104-165104/`（Git 忽略） |
| 快照 | `source-manifest-before.json`、`source-manifest.json`；开始时已存在的源码／测试／依赖及复核脚本逐一比较，后续仅新增本轮 3 个验收脚本 |
| 归属 | `git-head.txt`、`git-status.txt`；`executed-review-sources/` 保存真实联调时执行的脚本版本 |
| 隔离 | TEMP／TMP 指向本轮 `tmp/`，使用既有 `p1-review-20261103/fs-guard.mjs` 和 `P1_REVIEW_TMP_ROOT` 约束递归删除 |

离线运行不访问真实模型；真实联调为用户明确提供专用密钥文件、服务地址及模型后单独手动执行，未加入 `npm test`。读取密钥只用于认证，没有复制密钥文件、写入报告或保存到模型配置；配置保存的是进程内环境变量引用，测试结束清除。样例应用与工作空间关闭后清理，业务断言与人工内容保存在 JSON 报告中。

### 1.1 运行与结果

| 检查 | 结果与文件 |
| --- | --- |
| 后端类型检查 | `tsc --noEmit`，退出码 0；`typecheck.log` |
| 全量回归 | 103／103，0 失败、0 取消；`tests.log` |
| 原 P2-05 探针 | 10／10；`report.json`、`original-probes.log` |
| 第一轮扩展 | 5／5；`extended-report.json`、`extended-probes.log` |
| 模型停用后续行 | 1／1；`model-continuation-report.json`、`model-continuation.log` |
| P2-06 新组合场景 | 4／4；`acceptance-report.json`、`acceptance-probes-final.log` |
| 新增验收脚本严格类型检查 | 退出码 0；`acceptance-scripts-typecheck.log` |
| 真实联调 | 共执行 M01～M06 六项，3 通过、3 未通过；M07 真实事件召回因 M06 失败未执行。M01 为供应商列表端点差异，M03、M06 为产品阻断；`real-model-report.json` |
| 真实原因对照 | 同请求两档输出额度及实际记忆结果格式诊断；`real-diagnostics-report.json` |
| 真实调用范围 | 主联调 6 次生成请求，原因对照 2 次，共 8 次生成请求；模型列表 GET 另计，无自动换模型 |

实际使用专用 Node，在 `backend/` 执行 `node_modules/typescript/bin/tsc --noEmit`，以及 `--import tsx --import ./test-results/p1-review-20261103/fs-guard.mjs --test tests/*.test.ts`。原三组探针按 182／183 原脚本执行，设置新的 `NOWADAYS_REVIEW_OUTPUT`，没有覆盖旧自验及失败报告。

新增脚本：

- [离线组合验收](../backend/reviews/20261104-p2-06-acceptance.ts)：同一隔离目录与删除守卫下执行。
- [真实联调](../backend/reviews/20261104-p2-06-real-model.ts)：显式要求 `NOWADAYS_ACCEPTANCE_CREDENTIAL_FILE` 和 `NOWADAYS_REVIEW_OUTPUT`，仅允许 `api.deepseek.com` 上游，生成请求设上限与超时；实际只发出 6 次。
- [真实原因诊断](../backend/reviews/20261104-p2-06-real-diagnostics.ts)：只追加两次受限连接请求并分析已保存记忆输出；字段改名仅在内存中作格式对照，没有修补业务数据。

新脚本最初存在 SQL 诊断列名、工具结果封装读取和“自动召回必须命中”的样例假设错误，最终按实际契约修正：字段读取 `execution_stream_events.stream_event_id`、工具结果读取 `result`，自动召回未命中后让 Agent 主动改写查询。首次与诊断报告保留，不将这些脚本错误归为产品问题。严格类型检查的可选字段声明也已修正；真实脚本仅改类型标注和可省略空字段，没有改变已执行的请求内容，不为该调整重复收费请求。

## 2. R01／R02 最后补正的复验

代码核对任务缓存中的 `modelBinding`、新任务的开关检查、续行时 `bindings.refresh` 和任务终态清理；本轮没有再修改这些实现。

- 两项正式回归分别关闭模型资源及角色绑定，原任务仍保存成果；调用采用修改后的 baseUrl，关闭后新消息的 `processed_by_execution_id` 仍为空。
- 原补充探针调用 5 次、成果已保存、原任务 `completed`；执行为 `superseded`／`completed`／`completed(tool_result)`，链结束后的新消息被阻止。
- A02 另测从模型 A 改绑 B 并关闭 A：新消息使用 B，原任务续行仍使用 A 的最新配置，结束后的新消息继续使用 B。A 共 4 次、B 共 2 次，仅同一原任务，成果文件已保存。

**R01、R02 通过关闭；R03、R04、R06、R07、R08 维持关闭。R05 原有输出协议场景通过，但真实带标签结果暴露同一协议问题的新遗漏，按下节重新打开。**

## 3. P2-06 验收矩阵

| 173 验收项 | 本轮证据 | 结论 |
| --- | --- | --- |
| 实际记忆闭环 | 正式回归的实际对话→形成事件→下轮自动召回及原文；A01 Skill→参考文件→真实 MCP 保存→实际消息与工具证据形成事件→第二窗口主动检索／事件／原始证据→日记与状态 | 离线通过；真实形成受 R05 阻断 |
| 阈值与批次 | 正式回归 49／50、29／30 与注入时钟 59／60 秒；分段、分批、任务结束、新记录保留及单批限制 | 离线通过；未等待真实 60 秒，以可控时钟和短间隔定时器验证 |
| 失败与并发 | 既有失败退避、版本冲突、批次重试；A03 提交时状态版本冲突保留部分回复及用户最新状态；A04 整理模型门控期间聊天先完成 | 离线通过 |
| 精炼与召回 | 100 轮／召回不超过 1 次、同决策去重、摘要聚合、候选自动维护、跨批失败计数 | 离线通过 |
| 主观记录 | 事实／感受保存、原始记录不改、日记 Markdown 权威；A01 由 Agent 调用 diary_write，文件、事件关联及状态补丁均落地 | 离线通过；定时自行书写归 P3 |
| 对话与流式 | 输入、重复提交、中断、串行窗口、状态提交、SSE 重连；A03 提交冲突不计有效轮次且保留文字；M04 真实流式对话 | 离线及所选真实服务通过 |
| 调用真实性 | 实际工具记录与结果、unknown 补录、续接材料、异步建连后检查、同任务续行；M05 真实模型选 Skill／MCP 并实际写出带唯一标记的 Markdown | 离线及本轮真实写入通过；强杀组合仍归 P4 |
| 断线与资源开关 | SSE 原执行延续／游标补读；模型／MCP 关闭后原链延续及新任务隔离，A02 模型改绑 | 离线通过 |
| 模型与扩展 | 三协议离线／本地模拟、Skill 加载及本地 MCP；真实 DeepSeek Anthropic 对话／工具，根地址 OpenAI 模型列表 | 部分通过；连接测试 R09 阻断，Anthropic 列表 404 单列差异 |
| 原有数据 | 全量含 P1 13 项；v1→v2 升级、异常结构拒绝、角色隔离、窗口／绑定／消息去重与 CLI | 离线通过；A01 另查其他角色不可读同一事件 |

## 4. 真实服务的配置与边界

用户提供 `E:/tmp/testWorkSpace/testModel.txt`、`https://api.deepseek.com/anthropic`，指定 DeepSeek V4.1 Flash，允许选择 OpenAI 或 Anthropic 协议。本轮选 Anthropic Messages，实际模型 ID `deepseek-flash`，由同一服务根地址的列表确认。

DeepSeek 官方资料说明 Flash 别名对应 V4.1 Flash，Anthropic 地址支持该模型；直接 HTTP 可使用 `/anthropic/messages`，本轮适配器实际调用该路径并收到 200。参考：[模型 ID 与地址](https://api-docs.deepseek.com/quick_start/agent_integrations/)、[Messages 路径](https://api-docs.deepseek.com/api/create-message/)。这里仅作为配置依据，验收结果仍以实际请求、输出与持久化断言为准。

`GET /anthropic/models` 返回 404，而 `GET /models` 返回 200，列表含 `deepseek-flash`／`deepseek-v4-pro`。这属于同一服务不同协议端点能力差异，按 DL-119 保留手填模型能力；不视为断开连接、不自动切服务，也未为获取列表更换业务绑定。后续可以评估模型列表端点配置，但当前不新增决定或把自动探测其他地址列为验收要求。

M04 正常完成真实中文回复；M05 在已启用 Skill 和 MCP 的环境中，经真实本地 MCP 写出 `notes/acceptance.md`，唯一验收标记在文件中存在，外部调用为 `success`。本次真实摘要没有单列内部 `skill_read` 调用轨迹，因此 M05 只证明真实 Agent→MCP 写入，不单独证明真实模型读取了 Skill 正文；Skill 正文／参考文件→MCP 的完整顺序有 A01 离线组合证据。M06 真实模型产生了含事实、感受、索引和实际来源 ID 的事件 JSON，但整批被格式契约拒绝，未形成事件。**没有预置事件或修改真实结果来绕过失败，因此 M07 真实长期事件召回保持未验证。**

## 5. 阻断项与复验条件

### R05 [P1] 重新打开：记忆提示词的标签键与保存契约不一致

位置：[memory-runtime.ts:432](../backend/src/application/memory-runtime.ts#L432)、[示例 :442](../backend/src/application/memory-runtime.ts#L442)；对应 [memory.ts:15](../backend/src/domain/memory.ts#L15)、174 第 612 行的固定标签维度。

提示词及例子要求 `people/topics/places/emotions/sources`，而 `memoryFormationResponseSchema` 严格接收 `person/topic/place/emotion/source`。真实模型遵照提示词输出复数键，保存时得到 `MEMORY_OPERATION_INVALID`，批次 failed、5 条证据 failed、事件数 0。

对实际返回 JSON 重跑相同 schema，错误精确定位 `operations.0.tags` 的 5 个未识别键。仅在诊断内存中将键改为契约单数名后，原事件其他字段不变即可通过 schema；没有把改名结果写入业务库。由此可区分模型不遵守要求和系统自己给出不一致要求，当前属于后者。

修复与复验：使默认整理提示词、完整操作示例、字段解释与固定契约一致；用带完整标签的真实返回形状覆盖默认 HttpMemoryModel→MemoryService→索引链路，保留错误字段导致失败且不推进进度的用例。再用同一真实配置形成事件，并进行新一轮按需检索、原始来源读取与回复；不能只用省略 tags 的预设 JSON 宣称协议已验证。

### R09 [P2] 新增：连接测试额度 16 导致可用的思考模型误报失败

位置：[model-service.ts:53](../backend/src/application/model-service.ts#L53)。

连接测试固定 `maxOutputTokens:16`。同一地址、密钥和模型下，按钮返回 `MODEL_REQUEST_FAILED`／“模型连接测试未收到有效输出”，而实际对话和工具调用均成功。

使用生产 HttpModelAdapter、相同 system=`Reply with the single word pong.`、user=`ping` 直接对照：

| 输出上限 | 正文 | 终态 | 用量 |
| --- | --- | --- | --- |
| 16 | 空 | `max_tokens`、`incomplete=true` | 输入 39，输出 16 |
| 1024 | `pong` | `end_turn`、`incomplete=false` | 输入 39，输出 22 |

修复与复验：为最短连接请求提供足以完成的内部输出空间，正确处理显式截断，不把测试自身限额误报成服务配置不可用；不要求新增用户配置或关闭供应商思考。覆盖受限时仅有思考／无正文的流、正常正文完成、不完整正文、空流及上游错误；保留测试不携带角色上下文、不自动保存后测试、不影响自主额度的既有规则。1024 是本轮对照条件，不自动成为用户确认的固定参数。

## 6. 结论与下一步

原 R01／R02 补正已通过本轮复验，不再保留“模型关闭后原任务不能续行”的待验状态。原 16 个复核场景与新增 4 个离线组合场景全部通过，不能据此覆盖真实服务暴露的问题。

**当前只需先处理 R05 和 R09，再定向复验并补齐 M06／M07，之后决定 P2 收口与进入 P3。** 本轮是验收执行与问题定位，没有现场修改产品源码或改变固定契约，不将诊断内存改名当作修复完成。

OpenAI Chat／Responses 与其他厂商的真实生成尚未验证；当前只真实执行 DeepSeek Anthropic Messages，OpenAI 仅使用同服务模型列表。P3 自主规划／额度、P4 强杀组合、P5 远程 MCP、正式前端及桌面打包继续按原阶段验证。本轮未提交、未推送。

## 7. 185 修复后的独立复验与 P2 收口

2026-11-04，用户要求“复核修改”。先核对 185 的实现、测试及固定契约，再重跑离线验收，并沿用用户已提供的专用配置补齐真实链路；未再修改业务源码或正式测试。**R05、R09 通过并关闭，P2-06 在本次约定范围内通过。**

### 7.1 快照与运行证据

| 项目 | 本次证据 |
| --- | --- |
| 基线 | `codex/p1-role-storage`，Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a`＋185 修复后的未提交工作树 |
| 环境 | Windows x64、P0 专用 Node.js 24.22.2、独立 backend 依赖 |
| 运行编号 | `p2-06-independent-20261104-172311` |
| 证据目录 | `backend/test-results/p2-06-independent-20261104-172311/`（Git 忽略） |
| 源码归属 | `source-manifest-before.json`、`source-manifest.json`；开始时的全部文件哈希保持不变，仅新增本轮真实复验脚本 |
| 后端类型检查 | `tsc --noEmit`，退出码 0；`typecheck.log` |
| 全量回归 | 105／105，0 失败、0 取消；`tests.log` |
| 原 10 个探针 | 10／10，通过；`report.json`、`20261104-p2-05-review.log` |
| 5 个扩展场景 | 5／5，通过；`extended-report.json`、`20261104-p2-05-fix-recheck.log` |
| 模型关闭后续行 | 1／1，通过；`model-continuation-report.json` |
| P2-06 离线组合 | 4／4，通过；`acceptance-report.json` |
| 新复验脚本类型检查 | 严格模式与项目相同可选字段规则，退出码 0；`real-review-typecheck.log` |
| 真实复验 | 4／4，通过；`real-fix-review-report.json`、`real-fix-review.log` |

离线命令与第 1 节一致，原探针均设置独立 `NOWADAYS_REVIEW_OUTPUT`；TEMP／TMP 与递归删除守卫仍定向本轮目录。真实联调继续与自动化回归分开，使用相同 DeepSeek Anthropic 地址、`deepseek-flash` 和用户指定密钥文件，不再询问或更换配置。密钥仅进程内读取及认证，报告和配置中不保存密钥值；复验完关闭应用并清理临时工作空间。

新增复验脚本：[20261104-p2-06-fix-review.ts](../backend/reviews/20261104-p2-06-fix-review.ts)。手动执行时显式提供 `NOWADAYS_ACCEPTANCE_CREDENTIAL_FILE` 与 `NOWADAYS_REVIEW_OUTPUT`，调用专用 Node 加载 `tsx` 和既有 `fs-guard.mjs`。脚本限定同一 DeepSeek 上游，设超时与生成调用上限；实际发出 **12 次**生成请求，均为 HTTP 200。未改变模型输出、返回标签或默认后台记忆模型实现，没有预置事件。

### 7.2 R05 真实事件形成、索引与跨窗口召回

提示词的操作说明、字段解释和完整示例均使用 `person/topic/place/emotion/source`，与 174 及实际 schema 一致。正式回归已验证五类标签可保存和建立索引，旧复数键仍被拒绝且不推进证据处理进度。

本轮真实模型先实际调用 `skill_read` 读取 `review-note`，再调用真实 stdio MCP 的 `workspace_write` 保存带唯一标记的 `notes/review.md`，模型调用轨迹与文件内容都纳入断言，补齐首轮只记录 MCP 写入、未单列 Skill 正文读取轨迹的证据缺口。

默认后台整理模型据真实消息和工具结果生成 **1 个事件**，标签包含人物、主题、地点、情绪、来源五类，关联 **3 个实际来源**；事件检索索引存在，批次 `completed`，失败证据数为 0。没有对返回 JSON 改名，也没有手工插入事件或重置批次状态。

随后正常关闭后端并从同一数据目录重新打开，确认原事件 ID 保留；新建空对话窗口，只询问“星河观测计划持续多久、预算多少”，没有在问题中给出答案，也不读取笔记文件。真实模型实际调用：

1. `memory_search`；
2. `memory_event`；
3. 两次 `memory_evidence`；
4. `state_update`。

最终回复正确包含“三年”和“1200 元”，角色 `mood` 保存为“期待”、状态版本为 3；两次有效对话执行均为 `completed` 且状态提交版本存在。此次新窗口执行对同一事件只保存 1 条召回记录，符合搜索、详情及证据多次读取不重复计同一事件的既定规则。没有调用 `workspace_read` 或从旧窗口搬入聊天记录。

### 7.3 R09 连接测试与截断处理

内部连接测试预算提高为 1024，且按连接可达性处理服务完整终态中的显式预算截断；没有把同样的规则用于聊天或记忆正式提交，后两者仍拒绝不完整响应。空流、未收到终态、正常完成却无输出和上游错误仍会失败。该处理与“测试自身限额不误报服务配置不可用”的修复条件一致，不增加用户配置、审批或自动试调用。

本轮直接通过生产 `ModelService.test` 执行同一 DeepSeek 请求，返回 `ok=true`，`model_test_calls` 保存 1 条 `succeeded` 记录。正式回归同时覆盖正文完成、仅思考预算截断、部分正文截断、完成但空输出、空流和 503；请求不带角色上下文或工具，未混入自主额度。**R09 通过关闭。**

### 7.4 收口范围与下一阶段

本轮没有发现新的阻断项，R01～R09 均已关闭；第 3 节矩阵的离线证据保留，并已补齐首轮 M06／M07 所缺的真实事件形成、按需检索、原始证据、回复和状态保存。**P2-01～P2-06 可以按首轮单角色后端范围收口，下一阶段为 P3 自主安排、唤醒与额度管理。**

真实服务结论限定本次 DeepSeek Anthropic Messages 配置；OpenAI Chat／Responses 与其他厂商只有既有离线／本地模拟证据，不宣称真实生成兼容性均已验证。`/anthropic/models` 的已知列表端点差异保持第 4 节结论，手填模型不受影响。P3／P4／P5、强杀组合、远程 MCP、正式前端、桌面打包及多平台测试仍按原阶段执行，正常关闭重开不代替强杀恢复验收。

185 保留实现方自验，本节为独立复验证据，未将两者合并。未提交、未推送；本次验收通过不自动创建 P3 实现或 Git 提交。
