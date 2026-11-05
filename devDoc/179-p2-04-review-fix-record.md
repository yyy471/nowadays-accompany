# P2-04 独立复核问题修复记录

日期：2026-11-03。

状态（2026-11-04）：**R01～R06 已全部通过独立复验，见[178 第 6 节](178-p2-04-independent-review.md)。** 58 项测试、20 个既有场景和 7 个 R01 专项场景通过，P2-04 本地离线范围收口；不表示完整 P2 联动或真实模型已验收。本记录保留实施方各轮自验证据，原失败报告未覆盖。

历史修复过程见[178 第 5 节](178-p2-04-independent-review.md)：完整续轮材料由复核方补入，实施方复核并补修 Responses 终态 output 为空时的回退；当时 58 项测试与 20 个场景自验通过。该补修现已按第 6 节独立复验通过。下文 55 项结果与范围限制保留为原实现方证据。

需求依据：[持续决策记录 161](161-digital-life-direction-decisions.md) DL-19、DL-74、DL-75、DL-87、DL-99、DL-117～DL-120；工程契约见 [174 P2-01 契约](174-p2-01-memory-agent-contract.md)；阶段范围见 [173 P2 开发文档](173-p2-memory-agent-development-guide.md)。

## 1. 环境与证据

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a` + 当前未提交工作树 |
| 运行环境 | win32-x64，Node.js 24.22.2，npm 11.19.1 |
| 新增依赖 | `yaml` 固定 `2.9.1`（读取 Skill frontmatter） |
| 执行目录 | `backend/` |
| 运行编号 | `p2-04-fix-20261103`（原六项修复）；`p2-04-r01-20261103`（R01 续轮复核补修） |
| 证据日志 | `backend/test-results/p2-04-fix-20261103/typecheck.log`、`tests.log`；`backend/test-results/p2-04-r01-20261103/typecheck.log`、`tests.log`、`recheck.log`、`report.json`（Git 忽略） |

复核探针脚本固定写入 `backend/test-results/p2-04-recheck-20261103/`。实现方最终复跑将该目录的 `report.json` 更新为 `probe-72c03a…`；复核方 20:56 的 `probes.log` 与 `probe-711d…` 运行目录保持原样，实现方结果副本另存于 `p2-04-r01-20261103/report.json`。

类型检查退出码 0；原实现方阶段 `node --import tsx --test tests/*.test.ts` 共 55 项通过、0 失败，用时约 3.7 秒（P1 回归 13 项、P2-02 18 项、P2-03 13 项、P2-04 11 项）。R01 续轮补修后当前为 58 项通过、0 失败（新增两类协议续转用例与 Responses `output_item.done` 回退用例）；最终证据运行 `p2-04-r01-20261103` 的类型检查、58 项测试和 20/20 复验场景全部通过。全部模型验证使用本地模拟服务或注入 `fetch`；MCP 使用真实 stdio 子进程和临时目录；未访问真实模型、付费服务、QQ 或远程 MCP。

## 2. R01 模型端口工具调用往返

修改：

- [src/domain/model.ts:31](../backend/src/domain/model.ts#L31) 增加 `ModelToolCall`，助手消息可携带同一轮的文字与全部工具调用；工具结果继续用 `toolCallId` 关联。
- [src/model/protocols.ts:520](../backend/src/model/protocols.ts#L520) 起按协议转换完整历史：OpenAI Chat 发送 assistant `tool_calls`；OpenAI Responses 使用无状态完整 `input` 重放 `function_call` 与 `function_call_output`；Anthropic 发送 assistant `tool_use`，并把连续工具结果合并为一条 user 消息中的多个 `tool_result` 块。
- 工具参数统一序列化为 JSON 字符串；Anthropic 的 `input` 归一化为对象。响应式适配器不依赖厂商 SDK 类型，也不用厂商调用编号作为业务身份。

自验：`tests/p2-04-model.test.ts` 的“tool results continue the same model turn for all protocols”让三类协议先返回两个工具调用，再按业务侧重新分配的调用编号执行工具并携带完整历史发起第二轮；断言请求体包含两个助手调用及其对应结果、第二轮返回文字，Anthropic 的工具结果合并在同一条 user 消息。该用例走归一化历史，供应商编号只用于第一轮识别；带续轮材料时保持供应商 wire 编号，见下。

续轮材料补修（178 第 5 节由复核方补入，本轮实施方复核）：

- [src/domain/model.ts:38](../backend/src/domain/model.ts#L38) 增加可序列化 `ModelContinuation`，记录原协议、模型名、baseUrl 与厂商输出项；`completed` 事件和助手消息均可携带。
- Responses 优先使用终态 `response.output` 的完整输出项；若终态 output 为空但流中已收到 `response.output_item.done`，回退使用已完成 item，避免丢失续轮材料（本次复核补修）。请求同时要求返回加密 reasoning 内容。
- Anthropic 按索引累积文字、thinking、signature 与工具输入，续轮回传完整有序内容块；有续轮材料时不再追加归一化文字和调用。
- 续轮材料中的供应商调用编号保持原样，不做改写；业务调用编号与供应商 wire 编号的映射由 P2-05 独立保存和回传。协议、baseUrl 或模型名变化时改用归一化历史，不向新服务发送旧服务的加密／签名材料。

自验：`tests/p2-04-continuation.test.ts` 的两类协议用例验证完整内容块经 JSON 保存／读取后原样重放、无重复助手块、服务变更不发送旧不透明内容；`tests/p2-04-model.test.ts` 的“responses continuation falls back to completed output items”验证终态 output 为空时使用 `response.output_item.done`。全量 58 项测试通过；`reviews/20261103-p2-04-recheck.ts` 20/20 `contractPassed`。未调用真实供应商；Responses 仍使用无状态 `input` 重放，`previous_response_id` 不在 P2-04 范围。

## 3. R02 流终态与空响应

修改：

- [src/model/protocols.ts:49](../backend/src/model/protocols.ts#L49)（Chat）、[170](../backend/src/model/protocols.ts#L170)（Responses）、[323](../backend/src/model/protocols.ts#L323)（Anthropic）分别校验完整终态：Chat 要求 `finish_reason` 与 `[DONE]`；Responses 要求 `response.completed` 或 `response.incomplete`；Anthropic 要求 `message_delta.stop_reason` 与 `message_stop`。
- 提前 EOF、空流和显式失败抛出 `MODEL_REQUEST_FAILED`，不发出 `completed`；工具调用只在终态确认后发出，避免基于未确认完成的响应执行工具。已收到的文字增量仍先交付上层。
- 显式不完整（Chat `length`／`content_filter`、Responses `response.incomplete`、Anthropic `max_tokens`／`pause_turn`）在 `completed.incomplete` 标记，正常结束不设置。
- [src/application/model-service.ts:46](../backend/src/application/model-service.ts#L46) 连接测试要求完整终态且至少一段文字或工具调用；空响应不写成功记录。

自验：`tests/p2-04-model.test.ts` 的“streams require a complete protocol terminal and mark explicit incompletes”覆盖三类协议的正常结束、文字后 EOF、空流、显式不完整和无终态工具调用；“connection tests reject empty streams and upstream errors leak no body”覆盖空流连接测试落为失败。

## 4. R03 MCP 工作空间目录链接

修改：[src/mcp/local-server.ts:202](../backend/src/mcp/local-server.ts#L202) 的 `safePath` 在目标不存在时向上查找最近存在的祖先并校验其真实路径；写入在 `mkdirSync(..., {recursive:true})` 后再次校验目录真实路径（[:66](../backend/src/mcp/local-server.ts#L66)），防止经 junction／符号链接逃逸。已存在目标仍按真实路径校验。

自验：`tests/p2-04-mcp.test.ts` 的“workspace writes reject existing and missing-parent directory links”建立指向工作空间外的 junction，分别验证直接父目录和多层缺失父目录写入被拒绝且外部无文件；同一用例验证普通多层目录可创建。

## 5. R04 Skill YAML frontmatter

修改：[src/skills/skill-library.ts:114](../backend/src/skills/skill-library.ts#L114) 使用 `yaml` 标准解析替换逐行冒号截断，支持单／双引号、折叠 `>-` 和保留换行 `|`；无效 YAML 仍回退到正文首行，不新增内容审查、依赖预检或试运行。依赖在 `backend/package.json` 固定为 `2.9.1`。

自验：`tests/p2-04-skill.test.ts` 的“skill frontmatter accepts YAML quoted and block scalar values”覆盖四种写法，并验证引号内的名称可直接用于 `read()`。

## 6. R05 精炼摘要聚合

契约修改（[174](174-p2-01-memory-agent-contract.md) 第 5.2、5.3、6.3 节）：

- `refine_event` 改为 `events: [{eventId, expectedVersion}]` 加必填 `summary`，可带 `targetSummaryId`、`expectedSummaryVersion`、`topic`；一次可精炼同一经历日期的一个或多个事件。
- 整理模型输入增加 `summaryCandidates`（候选日期下已有摘要的编号、日期、主题、正文、版本），供模型决定新建或补充；候选外事件／摘要不能作为目标。
- 只能聚合同一经历日期的事件；已有摘要日期必须一致，主题非空时不得冲突；补充使用摘要版本做乐观并发控制；事件、摘要、来源、修订和检索文档在同一事务更新，原始证据保留。

实现：

- [src/storage/memory-store.ts:1006](../backend/src/storage/memory-store.ts#L1006) 提供 `listSummaryCandidates`；[:1039](../backend/src/storage/memory-store.ts#L1039) 的 `refineEvent` 支持多事件聚合、创建或补充摘要、来源去重、版本递增、事件与摘要修订及索引更新。
- [src/application/memory-service.ts:343](../backend/src/application/memory-service.ts#L343) 构建候选；[:447](../backend/src/application/memory-service.ts#L447) 校验目标事件、候选归属和摘要目标，[:523](../backend/src/application/memory-service.ts#L523) 提交精炼。
- 模型给出的 `reason` 写入事件与摘要修订内容，作为聚合依据留痕；批次失败时，版本冲突保留 `MEMORY_VERSION_CONFLICT` 作为诊断码。

自验：

- `tests/p2-03-memory-query.test.ts` 的“refinement aggregates same-date events and supplements an existing summary”覆盖同日两事件合并、后续补充、来源与修订追加、旧摘要版本冲突回滚、不同经历日期拒绝合并。
- 同文件“memory batches supply summary candidates for supplementing an existing summary”覆盖整理模型输入中的 `summaryCandidates` 和经服务接线的摘要补充。
- 原“refinement turns a low-recall event into a searchable daily summary”已按新协议更新，继续验证事件退出独立检索、摘要可检索和摘要纠错。

## 7. R06 上游错误正文

修改：[src/model/protocols.ts:490](../backend/src/model/protocols.ts#L490) 起，非 2xx 上游响应只读取用于解析安全原因的 JSON，不再把正文写入 `AppError.details`；公共错误仅包含状态码和白名单化的 `error.code`／`error.type`（[:681](../backend/src/model/protocols.ts#L681)），未命中白名单时使用 `http_<status>`，不转发任意上游文本。列表与连接测试共用该出口；连接测试日志只记录错误码，不记录上游正文。

自验：`tests/p2-04-model.test.ts` 的“connection tests reject empty streams and upstream errors leak no body”让模拟 401 正文回显虚构凭据和请求片段，并覆盖错误码字段回显凭据、普通文本错误与连接测试空流；断言直接调用、HTTP 响应和 `model_test_calls` 均不含这些内容，同时保留状态码与安全原因。

## 8. 文档与后续

- 174 已同步工具历史、完整续轮材料、流终态、连接测试、Skill YAML、MCP 路径、精炼聚合和上游错误约束；176／177 状态与精炼说明追加本轮修复入口。
- 178 的失败证据与验收条件保持不变；本轮不修改独立复核结论。
- R01 续轮补修已通过 178 第 6 节独立复验；下一步按 173 推进 P2-05，不以本次 58 项测试代替整个 P2 验收。
