# P2-06 R05／R09 阻断修复记录

日期：2026-11-04。

最新状态：**R05／R09 已通过[184 第 7 节](184-p2-06-acceptance-report.md)独立复验并关闭，P2 在首轮单角色后端及本次真实 DeepSeek 配置范围内通过验收。** 独立重跑类型检查、105 项回归与 20 个离线场景通过，并补齐 4 项真实模型复验：连接测试、Skill／MCP、事件与索引、重启后新窗口检索／证据／回复及状态保存。下文保留实现方自验，不代替独立证据。未提交、未推送。

需求依据：[184 P2-06 阶段验收报告](184-p2-06-acceptance-report.md) 第 5 节；[173 P2 开发文档](173-p2-memory-agent-development-guide.md)；[174 P2-01 契约](174-p2-01-memory-agent-contract.md)；持续决策记录中的 DL-71、DL-87、DL-102、DL-119、DL-128。

## 1. 环境与证据

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6` + 当前未提交 P2 工作树（含 183 第 12 节补正） |
| 运行环境 | win32-x64，P0 专用 Node.js 24.22.2，独立 `backend/` 依赖 |
| 执行目录 | `backend/` |
| 运行编号 | `p2-06-r05-r09-fix-20261104` |
| 证据目录 | `backend/test-results/p2-06-r05-r09-fix-20261104/`（Git 忽略） |
| 证据文件 | `typecheck.log`、`tests-sequential.log`、`tests-parallel.log`、`original-probes.log`、`report.json`、`extended-probes.log`、`extended-report.json`、`model-continuation.log`、`model-continuation-report.json`、`acceptance-probes.log`、`acceptance-report.json`、`acceptance-scripts-typecheck.log` |

实际运行：

```powershell
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test --test-concurrency=1 tests/*.test.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx --test tests/*.test.ts
$env:NOWADAYS_REVIEW_OUTPUT="test-results/p2-06-r05-r09-fix-20261104"
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-05-review.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-05-fix-recheck.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-05-model-continuation.ts
& ../prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe --import tsx reviews/20261104-p2-06-acceptance.ts
```

| 检查 | 结果 |
| --- | --- |
| 后端类型检查 | 退出码 0 |
| 全量顺序回归 | 105／105 通过，0 失败、0 取消 |
| 全量并行回归 | 105／105 通过，0 失败、0 取消 |
| 原 P2-05 探针 | 10／10 `contractPassed=true`，无 `probeError` |
| 第一轮扩展场景 | 5／5 `contractPassed=true`，无 `probeError` |
| 模型停用后续行 | 1／1 `contractPassed=true` |
| P2-06 离线组合场景 | 4／4 `passed=true` |
| 新增验收脚本严格类型检查 | 退出码 0 |

184 的全量基线为 103 项；本轮新增 2 项正式回归，共 105 项。全部模型为离线端口或注入模型，MCP 使用真实本地 stdio 服务与临时工作空间；本轮没有调用真实模型、QQ、远程 MCP 或付费服务，也没有修改真实模型配置。

## 2. R05 记忆标签键与保存契约一致

修改：

- [memory-runtime.ts:432](../backend/src/application/memory-runtime.ts#L432) 的 `create_event` 协议把标签维度改为契约单数名 `person`、`topic`、`place`、`emotion`、`source`。
- [memory-runtime.ts:442](../backend/src/application/memory-runtime.ts#L442) 增加字段解释：标签键只能使用上述单数名，值为字符串数组。
- [memory-runtime.ts:443](../backend/src/application/memory-runtime.ts#L443) 的完整示例改为包含全部五个单数键，避免模型从省略 tags 的示例推断复数名。
- 未修改 [memory.ts:15](../backend/src/domain/memory.ts#L15) 的固定契约；174 的标签维度保持单数，错误字段仍按严格 schema 拒绝。

自验：

- [p2-05-memory-chain.test.ts:311](../backend/tests/p2-05-memory-chain.test.ts#L311) 的默认 `HttpMemoryModel` 用例更新为带完整标签的真实返回形状：断言请求包含五个单数键且不包含 `people`／`topics`／`places`／`emotions`／`sources`；模型返回五类标签后经 `MemoryService` 保存，断言 `getTags` 读回全部维度且 `memory_search_documents` 已有对应事件索引。
- [p2-05-memory-chain.test.ts:422](../backend/tests/p2-05-memory-chain.test.ts#L422) 新增复数标签失败用例：模型仍返回旧复数键时，批次失败且错误码为 `MEMORY_OPERATION_INVALID`，事件数为 0、证据均未标记 `processed`、处理进度不推进；失败尝试次数按既有规则登记为 1，批次保持 `failed`。

限制：本轮未重跑真实 DeepSeek M06／M07。真实模型形成事件、按需召回与原始来源读取仍需在独立复验后使用同一配置补齐，不能以离线 JSON 预设替代。

## 3. R09 连接测试输出预算与显式截断

修改：

- [model-service.ts:22](../backend/src/application/model-service.ts#L22) 增加连接测试内部输出预算 `CONNECTION_TEST_MAX_OUTPUT_TOKENS = 1024`；[model-service.ts:58](../backend/src/application/model-service.ts#L58) 用它替代原来的 16。该值是测试内部实现预算，不是用户配置项，也不改变正常工作请求的额度。
- [model-service.ts:78](../backend/src/application/model-service.ts#L78) 读取终态的显式截断标记；[model-service.ts:87](../backend/src/application/model-service.ts#L87) 仅在“已完成、无正文且未被显式截断”时返回 `EMPTY_RESPONSE`。思考模型或正文被测试预算截断时视为服务可达，不把测试自身限额报成服务配置不可用。
- 空流仍按 `STREAM_TRUNCATED` 失败；上游 HTTP 错误仍按 `MODEL_REQUEST_FAILED` 失败；连接测试仍不携带角色上下文、不发送工具、不写业务消息，只保存既有 `model_test_calls` 记录。

自验：[p2-04-model.test.ts:845](../backend/tests/p2-04-model.test.ts#L845) 新增用例，按顺序覆盖正常正文、仅思考后 `max_tokens`、正文部分截断、已完成但无正文、空流和上游 503。断言前三项成功、后三项失败；请求 `max_tokens` 不小于 256、system／user 固定为连接测试内容且不包含工具；六次测试结果按 `succeeded`／`succeeded`／`succeeded`／`failed`／`failed`／`failed` 写入 `model_test_calls`。

限制：本轮未重跑真实 DeepSeek 连接测试按钮。1024 是本轮实现选择；184 的 1024 对照条件不自动成为用户确认的固定参数。

## 4. 回归范围与限制

- 105 项回归包含 184 基线的 103 项与本轮 2 项新增；原 101 项、183 第 12 节补正的 2 项及全部既有 P1／P2 用例均保留并通过。
- 原 10 个探针、5 个扩展场景、模型停用续行和 4 个 P2-06 离线组合场景全部通过；没有 `probeError`。
- 未验证真实模型 M06／M07、真实连接测试、QQ／SnowLuma、桌面页面、P3 自主活动、P4 强杀组合与 P5 后远程资源。
- 184 的验收结论在独立复验前继续有效；本轮自验不替代独立复核。下一步先复验 R05／R09，再用用户配置补齐真实事件形成与新窗口召回，之后决定 P2 收口与进入 P3。
- 本轮未提交、未推送。
