# P2-04 及前置工作包独立复核

日期：2026-11-03。

最新状态（2026-11-04）：**第 6 节最终复验通过，R01～R06 全部关闭。** 类型检查、58 项测试、20 个既有场景和 7 个 R01 专项场景通过。P2-04 的本地离线范围通过独立复验；P2-05、完整 P2 联动与真实模型仍按阶段另验。首轮失败与第 5 节补修证据保留。

首轮结论：**首轮复核未通过，R01～R06 待修复。** 类型检查与现有 48 项测试通过；独立边界探针 18 个场景中，4 个正常对照通过，14 个场景复现 6 类缺陷。现有测试通过不能覆盖这些缺口，P2-04 暂不能按已独立验收收口。

本轮检查 P2-04 模型／Skill／本地 MCP，回归 P1、P2-02、P2-03，并检查精炼与模型端口等前置衔接。未验收尚未实现的 P2-05 Agent、SSE、调度与任务链开关联动，不将这些既定后续范围列为缺陷；也不据此宣布 P2-02／P2-03 已全面通过独立验收。需求依据为 161、173、174；177 的实现方自验与本记录分列。

## 1. 源码与环境

| 项目 | 本轮证据 |
| --- | --- |
| 分支／基线 | `codex/p1-role-storage`，`3fa50e6` + 当前未提交 P2 工作树 |
| 环境 | Windows x64，仓库 P0 专用 Node.js 24.22.2，`backend/node_modules` |
| 业务源码 | 本轮未修改；新增复核脚本及记录，不提交、不推送 |
| 自动化回归 | `tsc --noEmit` 退出码 0；48 项测试通过、0 失败 |
| 独立探针 | `backend/reviews/20261103-p2-04-review.ts`；18 个场景，4 个对照通过、14 个场景不符合契约 |
| 日志与报告 | `backend/test-results/p2-04-independent-20261103/`，Git 忽略 |
| 验证范围 | 模拟模型流、本机 HTTP、真实本地 MCP stdio 子进程、SQLite 和专用文件目录；无真实模型、付费服务、QQ 或远程 MCP |

第一次受限运行的 14 项失败均为本机网络 `EACCES`，不归为产品缺陷；允许本机连接后原 48 项全部通过，日志为 `tests-local-network.log`。独立探针的模拟模型通过注入 `fetch` 返回固定响应，不访问 `offline.invalid`；HTTP 接口只连接 `127.0.0.1`。

回归时 TEMP／TMP 指向本轮专用目录，并加载既有删除守卫，递归清理前校验绝对目标仍在指定临时根内。独立探针不递归删除目录，目录链接两端均位于本轮专用报告目录；越界写入只发生在该样例的 workspace 外，不触碰用户文件。

## 2. 问题

### R01 [P1] 模型端口无法表达并回传助手工具调用，阻断工具后继续决策

位置：`backend/src/domain/model.ts:31`；`backend/src/model/protocols.ts:476`、487、506。

`ModelMessage` 的 assistant 只含字符串 `content`，没有调用编号、工具名和参数的表示。三个转换函数仅把 assistant 转成文字；虽然支持发送 tool 结果，但没有与结果对应的助手调用。适配器也不保存可供下次请求使用的 response／conversation 身份。

探针使用当前正式类型构造 user → assistant → tool 历史，捕获三类实际请求体：Chat 没有 assistant `tool_calls`；Responses 只有 `function_call_output`，没有对应 `function_call`；Anthropic 只有 `tool_result`，没有对应 assistant `tool_use`。这是端口和适配层的缺口，P2-05 即使补上循环也无法通过当前端口提交完整工具往返。

修复验收：扩充统一历史类型与各协议转换，保留同一模型轮的文字和全部工具调用／结果，维持正确调用关联；Responses 等还应保留继续请求所需的其他输出项或明确采用受支持的会话方式。以本地服务验证“模型提出工具 → 执行工具 → 第二轮接受完整历史并回复”，覆盖一次多个调用；不能仅在第一轮解析出 tool_call 就判通过。业务 tool_call_id 与供应商编号仍按 174 分开。

协议依据：[OpenAI 工具往返示例](https://developers.openai.com/api/docs/guides/function-calling)、[Anthropic 工具调用处理](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。真实供应商请求本轮未调用，线上的具体拒绝消息未验证。

### R02 [P1] 缺失流结束事件仍发出 completed，连接测试把空响应记为成功

位置：`backend/src/model/protocols.ts:149`、282、423；`backend/src/application/model-service.ts:71`。

三个流实现均在读取循环结束后无条件发出 `completed`。Responses 虽有 `completed` 标记，最终却在标记为 false 时仍回退 `"completed"`；Chat 和 Anthropic 也没有检查完整的结束序列。

探针分别给三类协议返回“只有文字增量后正常 EOF”和“HTTP 200 空正文”：6 个异常输入均无错误并发出 completed。调用连接测试再给空响应，得到 `{ok:true}`，数据库 `model_test_calls.status='succeeded'`。后续 Agent 会把未完成结果当成功；若工具参数已拼接完成但终态缺失，还可能基于未确认完成的响应发起工具。

修复验收：按协议识别完整终态，区分正常完成、显式不完整、失败和提前 EOF；提前 EOF 应报错且不发出正常完成事件。已有文字仍交给 P2-05 保存，不能因错误抹除。连接测试须确认有效响应，空正文不能落成功记录；正常流对照仍通过。Anthropic 的标准结束序列可核对[官方流式文档](https://platform.claude.com/docs/en/build-with-claude/streaming)。

### R03 [P1] 新建多层文件路径时，MCP 工作空间校验漏过目录链接

位置：`backend/src/mcp/local-server.ts:218`。

`safePath` 在目标不存在时只检查直接父目录；父目录也不存在就把 `existingParent` 当成 root，没有向上检查最近存在的祖先。`mkdirSync(..., {recursive:true})` 随后跟随更上层的 junction，在工作空间外创建目录并写入文件。

复现：在 workspace 下建立 `linked` junction 指向样例的 `outside-workspace`，调用 `workspace_write("linked/new-directory/note.txt")`。返回 `ok:true`，文件实际出现在 workspace 外；对照 `linked/direct.txt` 因直接父目录已存在而被正确拒绝。问题不涉及用户已允许的命令工具权限，而是违反 174 对文件类工具“拒绝越界路径”的已定边界。

修复验收：检查最近存在的祖先真实路径后再创建缺失目录，创建／写入边界保持在实际工作空间内；补已存在目标、单层和多层缺失父目录、junction／符号链接的对照用例。无需增加授权或审批流程。

### R04 [P2] Skill 的逐行字符串解析不兼容通用 YAML frontmatter

位置：`backend/src/skills/skill-library.ts:113`。

解析器按冒号逐行截断，未按 YAML 解码。合法的 `name: "quoted"` 被暴露为带引号的名字，调用 `read(metadata.name)` 找不到目录；`description: >-` 的多行描述被解析成字面量 `>-`，实际用途简介丢失。现有测试只有未加引号的单行字段，没有覆盖这些通用写法。

修复验收：在实际读取时使用能正确处理 YAML 字符串、引号和块标量的解析方式，保证列表提供的身份能用于读取；覆盖单引号、双引号、折叠／保留换行的描述。这里只要求格式读取兼容，不新增内容审查、依赖预检或试运行。格式依据：[Agent Skills 规范](https://agentskills.io/specification)。

### R05 [P2] 精炼只是逐事件复制成摘要，缺少已确认的简短聚合

位置：`backend/src/storage/memory-store.ts:1030`；`backend/src/domain/memory.ts:61`。

每次 refineEvent 都新建随机 summaryId，正文固定为 `${event.title}：${event.summary}`。输出协议的 refine_event 也不能提供概括后的文字或指定已有摘要，因此没有按经历日期／主题合并、补充已有摘要或由模型精炼文字的路径。

探针对同日同主题的两条事件精炼后得到两条各 1005 字摘要，正文分别保留完整事件摘要；仅更换类型和删除事件索引，记录数量与冗长度未缩减。两条摘要本身并不必然错误，问题是当前实现对任何输入都只能一对一复制，无法实现 DL-19、DL-99 已要求的聚合与后续补充。

修复验收：在现有决定内补全整理输出与保存契约，由模型给出日常概括及聚合目标／依据；同日同主题可合并与补充，不强制整天只有一条。摘要正文、来源范围、版本、修订及索引原子更新，原始证据保留；验证多事件合并、后续补充、不同经历日期不误合并和旧版本冲突。

### R06 [P2] 模型列表 API 把未处理的上游错误正文返回客户端

位置：`backend/src/model/protocols.ts:459`；`backend/src/http/errors.ts:35`。

非 2xx 响应的前 500 字直接写入 AppError.details.body，公共 HTTP 错误处理器再原样序列化。截断长度不等于移除凭据或完整上下文，违背 174 第 10 节的错误正文约束。

探针配置一条只用于测试的虚构凭据，并让模拟服务的 401 正文回显该标记。`POST /v1/model-services/models` 返回 502，响应仍包含同一标记。报告只记录暴露布尔值，未使用任何真实密钥。

修复验收：公共错误采用安全字段或脱敏后的原因，不直接转发任意上游正文；保留状态与可诊断错误原因。覆盖上游回显凭据、请求片段和普通错误的情况；模型测试与列表 API 错误出口保持一致，无需增加权限控制。

## 3. 复现命令与报告

在 `backend/` 下，用仓库专用 Node 执行：

```powershell
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test tests/*.test.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261103-p2-04-review.ts
```

本轮原测试的清理守卫和 TEMP／TMP 设置见 `tests-local-network.log` 对应执行记录。探针的汇总报告为 `backend/test-results/p2-04-independent-20261103/report.json`，详细日志为 `probes.log`。脚本退出 0 只表示收集完成，判定应读取每项 `contractPassed`，不能把退出码当验收通过。

| 探针组 | 本轮结果 |
| --- | --- |
| 三类正常结束流 | 3／3 对照通过 |
| 三类缺失终态与空流 | 6／6 复现 R02 |
| 三类工具结果续轮请求体 | 3／3 复现 R01 |
| 空响应连接测试 | 1／1 复现 R02 |
| 上游错误回显 | 1／1 复现 R06 |
| 合法 YAML Skill 元数据 | 1／1 复现 R04 |
| 已存在的 junction 直接父目录 | 1／1 对照通过 |
| junction 下缺失多层父目录 | 1／1 复现 R03 |
| 同日同主题事件精炼 | 1／1 复现 R05 的逐事件复制行为 |

完整响应、样例数据库和目录均保留在报告的 runRoot 中；业务源码与测试的 SHA-256 清单为同目录 `source-manifest.json`。后续修复应保留本轮失败证据，另起记录复验，不能覆盖为本轮已通过。

## 4. 后续入口

先修复 R01～R06 并完成实现方自验，再进行独立复验。R01／R02 应在 P2-05 工具循环接线前解决；R05 同时修订 174 的工程契约以落实原已确认需求，不新增产品决定。P2-05 尚未实现的联动项继续按 173 推进，不能以本轮 48 项回归通过代替整个 P2 验收。

## 5. 修复后复验与完整续轮材料补修

2026-11-03，用户要求“请复核修改”。以 179 的修改工作树为输入，独立重跑类型检查及原有 55 项测试，全部通过；R02～R06 的实现与验收条件一致。R01 的三类普通工具往返通过，但 179 第 2 节将 reasoning 等输出项后置，未满足本记录原 R01 的完整续轮条件。

补充的两个用例在修改前均失败：Responses 没有可重放完整 output 的入口；Anthropic 没有保留 thinking／signature／redacted_thinking 的入口。本次按用户“修改”的授权补齐 `ModelContinuation` 与三处边界：

- Responses 读取完整终态 output，兼容已完成 output item 的收集；返回可序列化续轮材料，下次请求原样重放，包括 reasoning 加密内容、消息 phase、调用编号与顺序，并请求返回加密 reasoning 内容。
- Anthropic 按索引累积内容块、thinking 与 signature 增量、解析工具 input；续轮回传完整有序内容块。归一化文字与调用不再重复追加。
- 材料带原协议、baseUrl 和模型名；切换到不同服务／模型时使用归一化历史，不把原服务的加密或签名内容交给新服务。供应商编号和业务调用身份的区分保持不变。

依据：[OpenAI 工具调用说明](https://developers.openai.com/api/docs/guides/function-calling)要求工具往返保留 reasoning items；[OpenAI 无状态推理说明](https://platform.openai.com/docs/guides/reasoning)说明加密材料与完整输出重放；[Anthropic thinking 说明](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)关联 thinking 内容块与工具续轮。只补全协议传输，不新增模型思考配置、内容审查或用户操作。

### 5.1 运行证据

| 检查 | 结果与日志 |
| --- | --- |
| 修改前类型检查和原回归 | 通过；55／55；`typecheck-before.log`、`tests-before.log` |
| 新增续轮用例修改前 | 0／2，均因缺少可重放材料失败；`continuation-before.log` |
| 最终类型检查和全量回归 | 通过；57／57；`typecheck-after.log`、`tests-after.log` |
| 按新正式接口复验原问题 | 20／20；`probes.log`、`report.json`；原 18 场景加摘要旧版本回滚与后续补充 |
| 续轮补修用例 | 两类协议完整内容块经 JSON 保存／读取后原样重放，无重复助手块；服务变更不发送旧不透明内容 |

本次日志根为 `backend/test-results/p2-04-recheck-20261103/`；原失败报告目录和原脚本不覆盖。新探针为 `backend/reviews/20261103-p2-04-recheck.ts`，任一 `contractPassed=false` 返回非零退出码。源码与测试归属保存于本次目录 `source-manifest.json`。

环境仍为 Node 24.22.2、独立 backend 依赖、本机 HTTP／真实本地 MCP 子进程及专用临时目录。测试不访问真实模型或付费服务；完整 JSON 续轮只证明端口能无损保存／回传，P2-05 的业务落库、Agent 循环、SSE 和真实供应商兼容性仍未验收。

### 5.2 证据归属与后续

R02～R06 的修复来自 179 的实施方，本次为独立复验，通过并关闭；R01 的普通工具历史同样已独立复验通过。本次发现并亲自完成的续轮材料补修，测试记录按自验归属，不冒充另一实施方的独立验收。**R01 新增补修仍需独立复核后关闭，P2-04 暂不标记全面通过。** 已定 P2-05 范围保持不变，未开始本工作包；未本地提交或推送。

## 6. 2026-11-04 最终独立复验

用户再次要求“复核修改”。实施方已在 179 复核第 5 节的续轮材料补丁，并修复终态 `response.output=[]` 时遗漏 `output_item.done` 的回退。本次检查该版本与新增回退测试，未发现需要继续修改的业务问题，不再改动业务源码。

### 6.1 证据与结果

| 项目 | 实测结果 |
| --- | --- |
| 源码 | `codex/p1-role-storage`，Git `3fa50e6` + 当前未提交工作树；SHA-256 归属见本次 `source-manifest.json` |
| 环境 | Windows x64，P0 专用 Node.js 24.22.2，独立 `backend/node_modules` |
| 类型检查 | `tsc --noEmit` 退出码 0，`typecheck.log` |
| 原回归 | 58／58，通过；`tests.log` |
| 六类问题复验 | 20／20，通过；`recheck.log`、`report.json` |
| R01 专项 | 7／7，通过；`r01.log`、`r01-report.json` |
| 证据目录 | `backend/test-results/p2-04-final-20261104/`（Git 忽略） |

专项脚本为 `backend/reviews/20261104-p2-04-r01-review.ts`，验证：

1. Responses 完整终态 output 优先重放。
2. Responses 终态 output 为空时从完成项回退。
3. Responses 终态 output 缺失时从完成项回退。
4. Anthropic 多段 thinking、signature、工具 JSON 与 redacted 内容块完整续轮。
5. 协议变化后改用归一化历史。
6. 模型名变化后改用归一化历史。
7. 服务 baseUrl 变化后改用归一化历史。

前三项还验证多个工具调用编号、`output_index` 排序、磁盘文件保存／重新读取与无重复助手块。专项输出和既有场景均在失败时返回非零退出码。

为避免再次覆盖旧报告，既有 `20261103-p2-04-recheck.ts` 增加可选 `NOWADAYS_REVIEW_OUTPUT`，未设置时保持原路径。本次明确设为新的证据目录；不覆写 11-03 的报告或清理其样例目录。回归沿用专用 TEMP／TMP 和递归删除守卫，本地 MCP 的目录链接两端均位于测试目录。没有调用真实模型、QQ、远程 MCP 或付费服务。

复现命令（在 `backend/` 执行）：

```powershell
$env:NOWADAYS_REVIEW_OUTPUT = Join-Path (Get-Location) 'test-results/p2-04-final-20261104'
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261103-p2-04-recheck.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-04-r01-review.ts
```

### 6.2 收口范围

R01 的普通工具历史、完整续轮材料和空终态 output 回退通过本次复验，关闭；R02～R06 的修复保持通过。P2-04 的模型适配、列表／连接测试、Skill 读取与本地 MCP 在本地离线范围通过独立复验。P2-02／P2-03 在本次回归中通过，不把这次针对问题的复验扩写为全部记忆行为已全面独立验收。

下一步按 173 进入 **P2-05 Agent 对话联动**，将供应商 wire 编号映射、续轮材料落库、模型／工具循环、输入中断、SSE 等接入执行链，再按 P2-06 验收完整闭环与真实配置。本次没有启动 P2-05 编码，没有新增产品决定，没有本地提交或推送。
