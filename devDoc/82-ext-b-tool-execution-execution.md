# EXT-B 统一工具执行底座执行记录

日期：2026-10-26。状态：EXT-B 已完成并通过定向与全量自动回归；未提交、未打包。依据[79 执行方案](79-agent-extension-execution-plan.md)与[80 验收标准](80-agent-extension-acceptance.md)，前置契约为[81 EXT-A](81-ext-a-contracts-execution.md)。本包只用内部 handler 验收，没有把执行器接入 Agent 大循环；没有调用真实付费模型、没有发送真实 QQ 消息。

## 1. 交付范围

| 项 | 结果 | 内容 |
| --- | --- | --- |
| 整批预检 | 完成 | 名称→完整工具身份映射、重复 callId、已解析参数、输入 schema、参数字节、账号授权、handler 就绪、本轮调用数与剩余预算；任一项失败整批零副作用，逐项返回拒绝 |
| 顺序执行 | 完成 | 预检通过后按原顺序执行；每一项在排队后、写意图后、动作前重新检查授权、handler generation 和 guard；失败项如实返回，不伪称回滚 |
| 结果协议 | 完成 | 每项返回调用 ID、`ok/error/submitted/unknown`、安全错误码、有限 text/data、可选 jobId/media、截断标记 |
| 大小与时间上限 | 完成 | 参数≤16KiB/调用；结果≤min(tool 声明,8KiB)；累计≤24KiB/轮；执行≤min(tool 声明,30s)；拒绝也计入调用预算 |
| 调用账本 | 完成 | 账号私有 `state/tool-invocations.json`；键由账号、kind/peer、稳定消息标识、模型回合、位置/callId、完整工具身份生成；只记录参数摘要与有限结果预览 |
| 幂等与动作意图 | 完成 | `effect=action` 先把 started 落盘后才调用 handler；写失败执行 0 次；重启把残留 started 恢复为 unknown；重复同键同摘要返回原结果，异摘要或 generation/epoch 变化拒绝，不重跑 |
| 有界账本 | 完成 | 终态最多 256 条、7 天保留；started/unknown 不因腾空间删除；文件超过 2MiB 拒绝新动作；损坏/不可写账本 fail-closed |
| 并发与队列 | 完成 | 默认全局 4、每账号 2、排队 32；排队不算运行；队列满、关闭和取消都有明确拒绝 |
| 退出 | 完成 | 关闭停止新准入并取消本地等待；有限等待 handler；迟到的动作结果不得写成成功或交付；账本残留恢复 unknown |

## 2. 代码位置

| 位置 | 内容 |
| --- | --- |
| `src/extensions/schema.ts:217` | `validateToolArguments`：按 EXT-A 有界子集校验解析后的参数；拒绝保留键、超深、超节点、范围与枚举；错误不回显参数值 |
| `src/extensions/execution/ledger.ts:98` | 稳定 invocation key、无 callId 时的确定性配对 ID、参数摘要 |
| `src/extensions/execution/ledger.ts:129` | `ToolInvocationStore`：串行变更、动作 started 前置落盘、终态预览、恢复、保留与 2MiB fail-closed |
| `src/extensions/execution/limiter.ts:28` | 全局/账号两级有界并发与取消安全的排队 |
| `src/extensions/execution/executor.ts:21` | 默认调用、参数、结果、轮次、超时和排空上限 |
| `src/extensions/execution/executor.ts:149` | `ToolExecutor`：整批预检、顺序执行、执行前重验、结果归一化、账本、guard 和关闭 |
| `test/tool-executor.test.ts` | 参数校验、预检零副作用、顺序配对、幂等/重启、崩溃恢复、容量、越权、generation/epoch、超时、关闭和并发证据 |

## 3. 执行语义

- 模型可见名称到完整工具身份的映射由本轮编排固定并传入执行器；未知名称、未授权工具、无 handler 或声明 schema 不支持都只产生拒绝结果，绝不按任意字符串加载或执行。
- 整批任一项预检失败时所有项均不进入 handler。预检通过后的单项 guard/handler 变化只拒绝对应项；已经发生的动作如实保留，不声称批次回滚。
- action 在副作用前必须有已落盘的 started 意图。意图写失败、账本损坏、账本满或账本不可用时 handler 调用数为 0。
- 动作开始后的超时、取消或关闭返回 `unknown`，不自动重试；只读工具同样有本轮幂等、预算和终态回执。
- 同键同参数且同 handler generation/上下文代际返回已有有限结果；参数不同、插件/角色代际不同返回冲突且不执行。
- handler 可返回 `ok/error/submitted`。执行器只接受有界 JSON 结果；业务错误可带安全 code/message，未知异常统一为 `tool_failed` 并去除消息正文。handler 契约要求不得返回宿主机路径、密钥或跨账号对象。
- 结果先按调用上限截断，再按剩余轮次预算截断；被丢弃的 data 设置 `truncated`，不通过扩容绕过总上下文预算。
- 账本只保存状态、摘要和最多 2KiB 的结果预览。首次完成返回模型的是执行时截断后的有限结果，重启后的重放返回账本预览，二者都可截断但不会无限增长。
- 关闭顺序为：拒绝新批次 → 取消排队/本地等待 → 给正在运行的 handler 有界时间 → 关闭账本。迟到的 handler 结算被丢弃，动作条目保持 unknown，不能进入新轮或 QQ。

## 4. 验收映射

| ID | 状态 | 证据/说明 |
| --- | --- | --- |
| T01 | 通过 | 无 capability 工具仍需显式授权；未授权批次数为 0（`tool batch preflight`） |
| T02 | 通过 | 未知工具、重复 callId、字符串参数、schema/大小/预算越界整批拒绝且 handler 0 |
| T03 | 通过 | 同批两条调用按原顺序执行，结果调用 ID 一一对应 |
| T04 | 留给 EXT-D | assistant/tool 协议消息由模型编排层产生；执行器只返回配对结果 |
| T05 | 留给 EXT-D | 中间文本不提前发送、tool 数据不改变 system/角色权限由单一 Agent 循环验证 |
| T06 | 通过 | 业务异常、未知异常、超时和超长结果均返回有界安全状态；不泄漏原始消息或栈 |
| T07 | 部分通过 | 每批最多 4 个调用、拒绝消耗预算、无 callId 确定性 ID 已实现；3 工具回合与 4 模型调用由 EXT-D 控制 |
| T08 | 通过 | guard 在意图前后变化、handler generation 变化、角色 contextEpoch 变化均阻止动作或拒绝重放 |
| T09 | 留给 EXT-D | 不支持工具的模型由编排层不描述工具，执行器不产生调用 |
| T10 | 通过 | 第一项成功、第二项 handler 失败时两项结果均真实，不伪称回滚 |
| L01 | 通过 | 同键重复通知重放；重启从磁盘重放；started/unknown 不重跑 |
| L02 | 通过 | 同键异参、异 generation、异 epoch 冲突且 handler 不执行；账号不同使用独立账本 |
| L03 | 通过 | 注入写入失败的账本，action handler 调用数为 0 |
| L04 | 通过 | 磁盘残留 started 加载为 unknown；重复调用不重跑，不承诺外部 exactly-once |
| L05 | 通过 | 256 条终态上限、7 天清理、unknown 保留、缩小文件上限后新动作拒绝 |
| L06 | 通过 | 全局 2/账号 1/队列 1 的排队、跨账号让位、取消和关闭直接验证 |
| L07 | 通过 | close 停止准入；迟到的 action ok 不写成功，磁盘条目保持 unknown |

## 5. 明确边界与后续

- `ToolExecutor` 尚未由 Core/AgentEngine 使用；接入与 assistant/tool 续答属于 EXT-D，不能用本包宣称 Agent 工具闭环已完成。
- 钩子单次 500ms、单轮 2s、插件 Worker 代际握手属于 EXT-C。
- jobId/media 引用目前只校验结构和长度；跨账号引用必须由宿主在生图/语音统一注册时绑定账号，属于 EXT-E。
- 3 次工具回合与 4 次模型调用的总预算、多调用文本和 tool 消息的上下文注入属于 EXT-D。
- 账本保留 256 条/7 天只保证保留窗口内的幂等；不承诺外部服务 exactly-once，也不在重启后自动补跑。

## 6. 自动验证

- `npm run typecheck`：通过（主工程 + desktop renderer）。
- `npx vitest run test/tool-executor.test.ts`：26 通过。
- `npx vitest run test/extension-contracts.test.ts test/extension-policy.test.ts test/tool-executor.test.ts`：47 通过。
- `npm test`：105 文件，963 通过、1 既有跳过。首轮全量中 `memory-extraction-runtime` 的 R1 在并发负载下出现一次 2 秒 `waitFor` 超时；单文件复跑和随后全量复跑均通过，继续作为[78号](78-memory-extraction-fixes-independent-review.md)记录的间歇性等待观察项，本包未修改该链路。
- 未执行：桌面打包、浏览器验收、真实 QQ/付费服务验证。
