# P2-04 模型与本地扩展实施记录

日期：2026-11-03。

最新复验见[178 第 6 节](178-p2-04-independent-review.md)：R01～R06 全部关闭，58 项测试与 27 个复验场景通过，P2-04 本地离线范围通过独立复验。下文保留原实施方结果与当时状态；下一步按 173 进入 P2-05。

原实施方状态：P2-04 实现方自验完成，原 48 项测试通过；后续修正、自验与独立复验见 178、179。当前结论以 178 第 6 节为准。

需求依据：[持续决策记录 161](161-digital-life-direction-decisions.md) DL-74、DL-75、DL-117～DL-120；阶段范围见[执行清单 164](164-backend-prototype-execution-checklist.md)与 [P2 开发文档 173](173-p2-memory-agent-development-guide.md) 第 5 节；工程契约见 [P2-01 契约 174](174-p2-01-memory-agent-contract.md) 第 9、10、11、12 节。

## 1. 运行环境与源码基线

| 项目 | 值 |
| --- | --- |
| 分支 | `codex/p1-role-storage` |
| 源码基线 | Git `3fa50e6d3b9ce70f37f02bdcae506fb4ed41406a` + 本轮未提交工作树 |
| 运行环境 | win32-x64，Node.js 24.22.2，npm 11.19.1 |
| 新增依赖 | `@modelcontextprotocol/sdk` 固定 `1.32.2`（P0 已验证 stdio MCP；本次按 P2 契约加入后端）；R04 修复新增 `yaml` 固定 `2.9.1` |
| 其他依赖 | 沿用 better-sqlite3 12.10.0、zod 4.6.7、TypeScript 5.9.3、tsx 4.23.15 |
| 执行目录 | `backend/` |
| 运行编号 | `p2-04-20261103T121500Z` |
| 证据日志 | `backend/test-results/p2-04-20261103T121500Z.log`（Git 忽略） |

类型检查退出码 0；`node --import tsx --test tests/*.test.ts` 共 48 项通过、0 失败，用时约 3.69 秒。全部模型测试使用本地 HTTP 模拟服务；MCP 测试使用真实 stdio 子进程和临时工作空间，未访问远程服务或付费模型。

## 2. 实际实现

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 模型契约 | `src/domain/model.ts` | 三类协议、服务配置、消息／工具规格、文本／工具／用量／完成事件；完成事件携带原始流响应 |
| 凭据解析 | `src/model/credentials.ts` | `env:` 与 `file:` 引用；文件相对 `appRoot` 并限制在根内；缺失／为空只返回 `MODEL_CREDENTIAL_UNAVAILABLE`，不回显值 |
| 协议适配 | `src/model/protocols.ts` | OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 的列表、SSE 流式文本、工具调用、用量与完成事件；统一 HTTP 错误、流中断和工具参数解析错误 |
| 模型服务 | `src/application/model-service.ts` | 列表与最短连接测试；测试结果写 `app.sqlite.model_test_calls`；测试失败返回 `{ok:false}` 而不抛出到路由 |
| 绑定解析 | `src/application/model-binding-resolver.ts` | 对话模型取启用的 `chat_model`；整理模型优先启用 `memory_model`，否则继承对话模型；绑定或资源停用返回 `MODEL_BINDING_MISSING` |
| 模型 HTTP／CLI | `src/http/schemas.ts`、`src/http/routes.ts`、`src/cli/commands.ts` | `POST /v1/model-services/models`、`POST /v1/model-services/test`；`cli model models/test` |
| Skill 库 | `src/skills/skill-library.ts` | 扫描含 `SKILL.md` 的目录；解析名称／描述；按需读取正文和参考文件；拒绝绝对路径、越界和越界符号链接 |
| 本地 MCP 服务 | `src/mcp/local-server.ts` | stdio 服务；`workspace_read`、`workspace_write`、`workspace_search`、`command_run`；文件根为 `NOWADAYS_WORKSPACE`，命令以工作空间为 cwd 并继承用户环境 |
| 本地 MCP 客户端 | `src/mcp/client.ts` | 按 `{command,args,env}` 连接 stdio 服务；列出工具、调用工具、超时和幂等关闭；返回原始 content／structuredContent |
| 测试 | `tests/p2-04-model.test.ts`、`p2-04-skill.test.ts`、`p2-04-mcp.test.ts` | 6 项 P2-04 用例，见第 4 节 |

## 3. 关键语义

- **协议隔离**：业务层只依赖 `ModelPort` 事件；三类协议的请求体、SSE 事件和工具调用格式封装在适配器内，不泄漏厂商 SDK 类型。适配器在流结束时提供原始事件数组，供后续 `model_calls.raw_response_json` 保存。
- **列表与测试**：列表失败直接返回实际错误，不修改资源或绑定；连接测试只发送简短文本请求，不携带角色、记忆或工具，不使用角色额度，结果写全局 `model_test_calls`。保存模型配置不自动触发测试。
- **绑定**：每个角色最多一个对话模型和一个整理模型（P1 约束）；整理模型停用时回退对话模型；绑定或资源停用不参与新任务。模型 ID 来自绑定，不写死在资源条目。
- **Skill**：只读取元数据、正文和用户指定的参考文件；不预检、不审查、不试运行，脚本执行交给命令工具。目录和符号链接越界被拒绝。
- **本地 MCP**：文件类工具默认以角色工作空间为根并拒绝越界；命令工具以工作空间为 cwd、保留用户环境权限、不额外沙箱化；stdout／stderr 有长度上限，超时终止。工具原始 JSON 文本结果由客户端返回，后续按 P1 `tool_calls`／`tool_results` 保存。
- **凭据**：只解析 `env:`／`file:` 引用；错误和日志不包含凭据值或完整请求上下文。

## 4. 自验用例

| 用例 | 核对结果 |
| --- | --- |
| 三类协议流式文本／工具／用量 | 本地模拟服务分别返回三种 SSE 格式；文本、工具名与参数、用量、完成原因、原始事件数组均正确 |
| 模型列表与凭据 | OpenAI Chat 与 Anthropic 列表通过；`env:` 与 `file:` 凭据分别进入正确请求头；文件引用按 appRoot 解析 |
| 连接测试记录 | 三类协议测试均成功；缺失环境变量测试返回 `MODEL_CREDENTIAL_UNAVAILABLE`；`model_test_calls` 记录 4 条状态与协议 |
| 模型 HTTP／CLI | 两个模型路由和 `cli model models/test` 使用同一适配器并返回一致结果 |
| 模型绑定 | 仅对话绑定可用；整理模型启用时优先使用，停用或缺失时回退；资源停用后缺少绑定错误 |
| Skill 按需读取 | 列表只返回含 `SKILL.md` 的目录；正文与参考文件可读；缺失 Skill、绝对路径和 `..` 越界被拒绝 |
| 本地 MCP | 真实 stdio 子进程列出四个工具；写入／读取／检索／命令执行成功；越界路径返回工具错误 |

## 5. 已知限制与未覆盖

- 未调用真实模型服务；OpenAI Responses 与 Anthropic 的请求／SSE 字段按当前公开格式实现，真实兼容性须在 P2-06 按 DL-116 用用户配置验证。
- 工具调用事件在流结束时统一发出；对话循环中的稳定 `step_key`／业务 `tool_call_id` 分配、工具结果保存和原始响应落库属 P2-05。
- `completed.rawResponse` 已提供原始事件数组，但尚未写入 `model_calls`；P2-05 接入对话执行时保存。
- Skill 库尚未接入 Agent 上下文构建和工具开关；P2-05 按角色绑定加载元数据／正文。
- 内置本地 MCP 服务尚未作为默认资源自动注册；P2-05 按 mcp 资源和开关接入，避免模块级单例。
- 未验证外部 MCP 服务、远程 MCP、Skill 脚本依赖或用户环境差异；P5 后按 DL-115、DL-116 扩展。
- 未实现模型列表缓存、前端按钮或自动测试；保存配置不会自动调用服务。
- 本记录中的通过结论只代表当时实现方自验；后续独立复核及 R01～R06 修复见[178](178-p2-04-independent-review.md)与[179](179-p2-04-review-fix-record.md)，不得以本节历史限制列表替代最新结论。
