# EXT-A 契约与唯一配置执行记录

日期：2026-10-26。状态：EXT-A 已完成并通过定向与全量自动回归；未提交、未打包。依据[79 执行方案](79-agent-extension-execution-plan.md)与[80 验收标准](80-agent-extension-acceptance.md)。本轮没有调用真实付费模型、没有发送真实 QQ 消息；测试全部使用临时目录、FakeProvider、FakeChannel。

本包只交付契约、目录、策略与有效状态底座。插件 Worker、Agent 统一循环、媒体工具迁移、Skill 服务与页面闭环分别留给 EXT-B～EXT-H，因此不能据本包声明“插件闭环已开放”。

## 1. 交付范围

| 项 | 结果 | 内容 |
| --- | --- | --- |
| 单一插件 schema | 完成 | manifest 声明式 `tools/hooks/skills`，严格键、数量/长度/超时/字节上限；导入与目录读取共用 `parseArtifactManifest` |
| 工具身份与协议 | 完成 | `builtin.<id>` 与 `<public\|private>/plugin/<pluginId>/<toolId>`；稳定模型名、碰撞拒绝；`ToolInvocationResult` 含 `ok/error/submitted/unknown`、安全错误码、有限数据、job/media、截断标记 |
| 有界输入 schema | 完成 | object/array/string/number/integer/boolean/null 的子集；拒绝未知关键字；schema 字节、深度、节点、属性、枚举、数组等上限 |
| 目录与执行就绪 | 完成 | 未声明导出不进入目录；声明缺 handler 时保留目录项但 `handlerReady=false`，不进入模型工具集 |
| 唯一账号策略 | 完成 | 硬授权迁移到 `extensions.authorizedTools`；旧顶层 `enabledTools` 仅在解析时迁移并不再输出；旧 `skills.enabled/disabled` 迁移为 `extensions.defaults.skills`；运行时不读旧字段 |
| 作用域解析 | 完成 | 账号默认 → kind(private/group) → `kind/peer` 具体会话；`inherit/on/off`；后层覆盖前层；kind 关闭可由具体会话在硬授权内显式开启 |
| 有效状态 | 完成 | 单一 `resolveEffectiveExtensions` 输出工具/钩子/Skill 的 enabled、来源、不可用原因；与 Router 模型可见工具共用同一闸门 |
| 策略 CAS | 完成 | `expectedRevision` + ConfigStore version CAS；保存事务内重读 profile revision；失败不写入 |
| 兼容整理 | 完成（本轮范围） | 旧工具授权、旧 Skill 开关输入一次性迁移；仓库内无旧插件需保留双协议 |

## 2. 代码位置

| 位置 | 内容 |
| --- | --- |
| `src/extensions/contracts.ts` | 身份/命名空间、模型工具名、声明解析、声明与调用结果类型、限额 |
| `src/extensions/schema.ts` | 有界 JSON Schema 子集校验 |
| `src/extensions/policy.ts` | `inherit/on/off` 解析与账号→kind→会话覆盖；开关诊断 |
| `src/extensions/catalog.ts` | 内置、插件声明、公用/私有/插件 Skill 合成唯一目录；handler 就绪标记 |
| `src/extensions/effective.ts` | 工具/钩子/Skill 有效状态与不可用原因；插件默认关闭、硬授权不因开关扩大 |
| `src/extensions/registry.ts` | 完整身份/重复身份/重复模型名/描述/schema/effect/超时/字节校验；插件工具名派生 |
| `src/extensions/types.ts` | 目录工具定义与 Skill 状态来源扩展 |
| `src/artifacts/manifest.ts`、`src/artifacts/types.ts`、`src/artifacts/local.ts` | 插件声明进入 manifest；非插件不得声明；目录读取拒绝非法声明 |
| `src/providers/types.ts` | 账号扩展子树；旧 `enabledTools`/Skill 开关迁移；扩展输入严格解析；单一授权字段 |
| `src/providers/config-store.ts` | `updateAccountPolicy` version CAS 与事务内 `beforeCommit` 前置检查 |
| `src/providers/router.ts` | 模型可见工具改走 `resolveToolGate`；执行前授权从扩展子树读取 |
| `src/application/extensions/extension-policy-service.ts` | 局部 patch、目录校验、revision/CAS、profile 提交前复核、有效状态读取 |
| `desktop/renderer/src/types.ts`、`src/pages/Policy.tsx` | 现有工具勾选读写 `extensions.authorizedTools`，避免页面在迁移后误清空授权 |
| `test/extension-contracts.test.ts` | 声明解析/默认值/拒绝路径/schema 界限/身份命名/注册冲突 |
| `test/extension-policy.test.ts` | 覆盖优先级、旧字段迁移、Skill 运行、硬授权、有效状态、CAS 与 profile 竞态 |

## 3. 关键语义

- 工具硬授权只有 `extensions.authorizedTools` 一个来源。`extensions.defaults/byKind/byConversation.tools` 只是软运行开关，不能把未授权工具打开；撤销授权立即压过任何 `on`。
- 插件工具、插件钩子、插件 Skill 默认关闭；内置工具与用户定义的公用/私有 Skill 保持历史默认开启（用户 Skill 仍可用显式 `off` 关闭）。新安装插件或新版本新增声明不会自动获得运行开关。
- 插件安装/停用仍由 profile 决定；profile 只解析出已启用的插件。软开关不能重新启用未安装或账号停用的插件。
- 钩子由所属插件开关控制，并额外要求 Worker 握手就绪；不在配置中维护第二套按钩子名共享的开关，避免同名钩子互相串权。
- Skill 可用性要求：开关开启、定义 kinds/peers 匹配、所需能力可用、引用的全部工具已授权且就绪；启用 Skill 本身不授予工具权限。
- 模型工具名在注册时确定并检测碰撞；插件名超长时使用可读前缀 + 身份哈希后缀。模型返回的名称只在本轮映射内查找，不按任意字符串动态加载。
- 账号策略 revision 覆盖扩展子树（含硬授权）与 profile 插件清单；保存事务内再次读取 profile，防止读取后、提交前换版本。两个文件仍不声称物理原子。
- 旧配置输入 `enabledTools` 与显式 `extensions.authorizedTools` 同时出现时拒绝，避免静默选择授权源；只接受旧字段时完成等价迁移。
- 有效状态原因采用有界代码（如 `plugin_switch_off/unauthorized/handler_not_ready/capability_unavailable/skill_tool_unavailable/kind_scope/peer_scope`），不含路径、密钥或正文。
- `ExtensionPolicyService.effective` 已按完整目录（含插件 Skill）解析；能力类工具/依赖需由调用方注入实时能力判定。现有 `Router.effective` 的 Skill 列表仍走历史 `SkillRuntime`（只含用户定义），插件 Skill 与统一 Skill 服务在 EXT-F 合并，避免本包提前改动 Agent 上下文注入。

## 4. 验收映射

| ID | 状态 | 证据/说明 |
| --- | --- | --- |
| C01 | 通过（契约层） | 导入与目录读取同一 manifest 解析；声明、版本、输入 schema 共用校验；`extension-contracts` + `artifact-import` |
| C02 | 通过 | 未声明不注册；缺 handler 目录项 `handlerReady=false` 且模型不可见；重复完整身份/模型名拒绝；`extension-contracts`、`extension-policy` |
| C03 | 部分通过 | 旧 `enabledTools`、旧 Skill 开关已一次性迁移且落盘不再写旧字段；`replyMode` 与旧插件回复协议仍在，按计划由 EXT-D/C、EXT-G/H 删除 |
| P01 | 通过（解析层） | 同一 peer 的 private/group 分别解析；`extension-policy` 有效状态与 Router 测试 |
| P02 | 通过（解析层） | kind 关闭、具体会话 on 可覆盖（硬授权内）；插件停用后会话 on 仍拒绝；`extension-policy` |
| P03 | 通过（契约层） | 新插件默认无授权、工具/钩子/Skill 默认 off；发布目录不等于账号启用；新版本运行时行为待 EXT-C |
| P04 | 通过 | ConfigStore version CAS；profile revision 在提交事务内复核；冲突不写入；`extension-policy` |
| P05 | 未完成 | `persisted/applied` 分离属于 Worker 重载，随 EXT-C/G 交付 |
| P06 | 部分通过 | 页面/模型/执行使用同一解析器的基础已建立；执行前重验与页面展示待 EXT-B/D/G |

## 5. 废弃字段消费者清单（供 EXT-C/D/G/H 收口）

| 旧字段/协议 | 当前消费者 | 处理包 |
| --- | --- | --- |
| `replyMode` | `src/providers/types.ts`（类型/解析）、`src/policy/policy.ts`（`replyModeFor`/有效策略）、`src/core/core.ts`（宿主选择/状态）、`src/agent/engine.ts`（工具与媒体分支）、`src/providers/router.ts`（DTO）、`desktop/renderer/src/types.ts`、`lib/labels.ts`、`pages/Policy.tsx`、`test/phase1-identity.test.ts`、`test/phase2-fixes.test.ts` | EXT-D 删除运行时分支；EXT-G 删除页面；EXT-H 清理测试/文案 |
| 旧插件 `onMessage`/`reply`/`sends` | `src/host/worker.ts`、`src/host/contract.ts`、`src/core/core.ts`（`createWorkerHost`）、`src/instances/instance.ts:743`、`src/index.ts` 导出、`test/phase2-fixes.test.ts` | EXT-C 换单一 Worker 协议；EXT-D 去宿主互斥；EXT-H 清理 |
| 旧 `skills.enabled/disabled` | 仅 `src/providers/types.ts` 解析迁移；运行时已无读取 | EXT-H 可删除输入兼容 |
| 旧顶层 `enabledTools` | 仅 `src/providers/types.ts` 解析迁移；运行时、页面、Router 已改用 `extensions.authorizedTools` | EXT-H 可删除输入兼容 |
| 旧 `image.generate` Skill 工具别名 | `src/providers/types.ts` 解析时映射到 `builtin.image.generate` | EXT-H 清理 |

## 6. 未完成与下一包边界

- EXT-B：ToolExecutor、整批预检、参数/结果验证与截断、调用账本、幂等键、effect=action 的 started 意图、并发/预算/退出。
- EXT-C：单一 Worker RPC、声明与 handler 握手、状态作用域、超时/代际失效、无外网示例插件；P05 的 persisted/applied 在此闭环。
- EXT-D：移除 `replyMode` 与旧宿主选择、钩子数据接入、`assistant.tool_calls`/tool 消息协议、多调用与续答预算。
- EXT-E：生图/语音注册为统一工具，复用现有 job/actionId/延迟交付，删除硬编码分支。
- EXT-F：Skill 多来源服务、CRUD/CAS/复制/影响、提示词预算与只读预览。
- EXT-G：插件与 Skill 页面、有效状态 API/DTO、旧回复模式 UI 删除；本轮仅对现有工具勾选做了兼容读写调整，未做浏览器验收。
- EXT-H：旧字段/旧协议清理、开发数据整理、端到端与完整回归。

## 7. 自动验证

- `npm run typecheck`：通过（主工程 + desktop renderer）。
- `npx vitest run test/extension-contracts.test.ts test/extension-policy.test.ts`：2 文件，21 通过。
- 定向回归（`phase1-policy/config/review-fixes/agent/api/router/identity`、`artifact-import`、`memory-tools`、`memory-extraction-trigger`、`phase2-fixes`、`frontend-state-copy`）：12 文件，121 通过、1 既有跳过。
- `npm test`：104 文件，937 通过、1 既有跳过。
- 全量首轮曾出现 `memory-extraction-runtime` O09 的 `waitFor` 超时；单文件复跑与后续两轮全量均通过。该现象与[78号](78-memory-extraction-fixes-independent-review.md)记录的间歇性水位等待项一致，本轮未改动该链路。

未执行：桌面打包、浏览器页面验收、真实 QQ/付费服务验证。
