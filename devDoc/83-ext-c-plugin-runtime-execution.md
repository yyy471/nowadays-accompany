# EXT-C 插件运行时执行记录

日期：2026-10-26。状态：EXT-C 已完成并通过定向与全量自动回归；未提交、未打包。依据[79 执行方案](79-agent-extension-execution-plan.md)与[80 验收标准](80-agent-extension-acceptance.md)，前置契约为[81 EXT-A](81-ext-a-contracts-execution.md)与[82 EXT-B](82-ext-b-tool-execution-execution.md)。本包交付账号级插件 Worker 运行时与无外网示例插件；运行时尚未接入 Core/Agent 大循环，未调用真实付费模型、未发送真实 QQ 消息。

## 1. 交付范围

| 项 | 结果 | 内容 |
| --- | --- | --- |
| 运行单元 | 完成 | 每账号、每插件（含 public/private 来源）一个 Worker；同一插件的钩子与工具任务在该 Worker 内串行，不同插件互不共享 Worker |
| 声明与 handler 握手 | 完成 | Worker 只为清单已声明且模块确实存在的工具/钩子回报 handler；未声明导出、声明了但没有实现的项均不进入 ready 集合 |
| 身份化 RPC | 完成 | 每个请求携带 id、accountId、完整 pluginKey、runtimeGeneration、scopeToken、timeoutMs、有界 context 与状态快照；回复按四项身份复核，作用域令牌缺失或不一致都按不匹配处理 |
| 运行代际失效 | 完成 | 身份或 scope 不匹配、Worker 错误/退出、宿主截止时间到 → 终止该插件本代际，晚到回复与晚到状态写入全部丢弃，不做仅 `Promise.race` 后放行的处理 |
| 状态命名空间 | 完成 | 宿主生成路径 `plugin-state/<source>/<pluginId>/<kind>_<peer>_<contextEpoch>.json`；插件拿不到任何文件系统路径；信封 `{version:1,stateVersion,updatedAt,value}`，单命名空间 16KiB 上限 |
| 账号共享状态 | 完成 | 仅当清单 `state.accountShared` 为真且账号 `extensions.state.<pluginKey>` 解析为 on 时使用 `account.json`；否则一律会话作用域 |
| 状态版本 | 完成 | 读取到不同 stateVersion → conflict，任务在副作用前拒绝；写入前再读一次，版本变化拒绝；不静默重置或覆盖旧状态 |
| 钩子任务 | 完成 | beforeContext 跨插件并发 fan-out 并逐插件容错；返回有限 additions（≤8 条、单条 ≤4KiB、合计 ≤12KiB、来源字符串有界）；afterTurn 用 allSettled 广播真实 outcome/replyText/errorCode；钩子只由握手结果与插件开关决定 |
| 工具任务桥接 | 完成 | `toolBinding()` 产出 EXT-B `ToolHandlerBinding`，generation 为 `<runtimeGeneration>:<localToolId>`；代际终止后绑定消失，执行器按 `handler_not_ready` 拒绝 |
| 有界输入 | 完成 | 单任务请求整体 ≤64KiB；状态快照 ≤16KiB、插件 config ≤8KiB、history ≤20 条且 ≤16KiB、单条消息 ≤8KiB，三者之和可在请求上限内同时满足；超限在发布任务前拒绝 |
| 示例插件 | 完成 | `test/fixtures/plugins/` 七个离线夹具：正常演示、只声明不实现、导入即失败、await 超自身截止、同步阻塞超宿主截止、伪造回复身份、慢钩子 |

## 2. 代码位置

| 位置 | 内容 |
| --- | --- |
| `src/extensions/runtime/protocol.ts:8` | 插件运行协议上限（请求、状态、配置、消息、history、additions、错误文本），三者按可在单请求内同时满足取值 |
| `src/extensions/runtime/protocol.ts:131` | 带 accountId/pluginKey/runtimeGeneration/scopeToken 的请求与回复类型 |
| `src/extensions/runtime/protocol.ts:194` | `pluginWorkerSource()`：内嵌 Worker 引导脚本，加载 ESM 入口、只挑选声明过的 handler（保留名不能被顶层导出冒充为工具）、串行执行任务、init/dispose 有界超时 |
| `src/extensions/contracts.ts:73` | `PluginStateDeclaration`（stateVersion + 是否允许账号共享） |
| `src/artifacts/manifest.ts:31` | 清单声明字段 `tools/hooks/skills/state` 只允许插件制品；`src/artifacts/manifest.ts:61` 用 `parsePluginDeclarations` 严格解析后进入 `ResolvedPlugin.manifest` |
| `src/extensions/runtime/state.ts:36` | `PluginStateService`：宿主生成路径、信封校验、16KiB 上限、按文件串行、写前复核版本 |
| `src/extensions/runtime/state.ts:123` | 队列缓存有界：只在队列空闲时逐出命名空间，保证同文件写序不被打断 |
| `src/extensions/runtime/plugin-worker.ts:86` | `PluginWorkerManager`：单插件单账号 Worker、握手身份校验、任务串行链 |
| `src/extensions/runtime/plugin-worker.ts:291` | 回复身份与作用域令牌复核；缺失或不匹配即拒绝该请求并终止代际 |
| `src/extensions/runtime/plugin-worker.ts:316` | 请求大小上限、宿主截止时间（声明超时 + 宽限）与终止 |
| `src/extensions/runtime/plugin-worker.ts:480` | `#prepare`：解析作用域、读取状态快照、stateVersion 冲突与不可用拒绝 |
| `src/extensions/runtime/plugin-worker.ts:512` | 状态回写：终止后不写、无变化不写、写失败对上返回失败 |
| `src/extensions/runtime/account-runtime.ts:40` | `AccountPluginRuntime`：按 source/plugin/revision 启停 Worker，失效代际重建；健康条目的 handler 归属在同步期间不清空 |
| `src/extensions/runtime/account-runtime.ts:65` | `readyTools()` 排除已终止管理器，供目录 `handlerReady` 与执行器使用 |
| `src/extensions/runtime/account-runtime.ts:77` | beforeContext 并发 fan-out 且逐插件容错；afterTurn 用 allSettled 广播 |
| `test/extension-runtime.test.ts` | 28 项运行时证据（见第 7 节分组） |

## 3. 运行语义

- 插件模块导出本身不是工具。只有清单声明的工具 id 且在模块中确有函数才会进入握手结果；未声明导出（示例里的 `undeclaredHandler`）与声明了却没有实现的工具（示例里的 `missing`）都不会被暴露，`toolBinding()` 返回 undefined。
- 目录与有效策略读取的是账号运行时的 `readyTools()`，不是进程级注册表：同一 source/id 在两个账号里的握手结果可以不同，`handlerReady` 因此按账号取。
- 每条回复必须同时匹配 accountId、完整 pluginKey、runtimeGeneration，并且对非 stop 请求原样带回 scopeToken——令牌缺失也按不匹配处理，不做"缺省当作同作用域"的宽松假设。任一不匹配：该请求以 `plugin_protocol_mismatch` 拒绝，整个代际终止，且不会写状态、不会返回结果。未知 requestId 直接丢弃，不影响同代际内正在等待的真实回复。
- 两级超时职责不同。插件自身声明的 `timeoutMs` 由 Worker 内部计时并回报错误，代际继续可用；宿主 `timeoutMs + timeoutGraceMs` 只在 Worker 失联（同步阻塞、崩溃）时触发，终止代际。工具任务因此返回 `unknown`（可能已执行），钩子返回失败；两者的晚到状态写入都被丢弃。
- 代际终止不影响其他插件与账号：`AccountPluginRuntime` 保留其余管理器继续服务，下一次 `sync()` 为失效插件重建新 runtimeGeneration；工具账本里的动作条目仍是 unknown，不会自动重跑（EXT-B 语义）。
- 插件看到的是有界只读上下文：accountId、kind/peer、scope、turnId/invocationId、截断后的 message/history、清单 config 和自己的状态副本。协议里没有 send、没有回复模式、没有角色或权限句柄，插件无法直接投递消息或提权。
- 状态回写只接受纯对象且有 16KiB 上限；快照未变化则不落盘；动作工具成功但状态写失败时返回 `unknown`，不声称成功。
- 钩子在同一插件内串行（该插件的状态快照不会被并发覆盖），跨插件并发 fan-out；beforeContext 的 additions 由宿主重新校验数量、单条与总字节，超限即本轮该插件失败，其他插件继续。
- 单个插件任务在宿主侧抛错（例如状态作用域标识非法）只让该插件本轮返回 failed，`AccountPluginRuntime.beforeContext` 继续遍历其余插件，Agent 不会因为插件异常拿不到其他 additions 或直接中断本轮。

## 4. 验收映射

| ID | 状态 | 证据/说明 |
| --- | --- | --- |
| W01 | 通过 | 同 id 公用/私有插件在一账号内各自 Worker 与状态目录互不可见；同一制品在账号 A/B 的 handler generation 与状态文件均独立（`plugin runtime isolation and lifecycle`） |
| W02 | 通过 | 默认状态按 kind/peer/contextEpoch 隔离；账号共享必须清单声明且账号开关为 on，开关 off 或仅声明时仍为会话作用域（`plugin state namespaces`） |
| W03 | 通过 | 阻塞插件被宿主截止时间终止，晚到状态被丢弃且不再接受新任务；同账号另一插件继续成功；停止有界（`terminates a generation that blocks past the host deadline`） |
| W04 | 通过 | 伪造 accountId/pluginKey/generation、伪造 scopeToken、以及省略 scopeToken 的回复均拒绝且无任何状态写入；未知 requestId 被丢弃而真实回复仍生效（`plugin reply identity` 4 项） |
| W05 | 留给 EXT-D/E | 工具回调宿主能力端口与媒体任务排回会话队列需要单一 Agent 循环与媒体注册，本包未接入 |
| W06 | 通过 | 同插件并发任务串行且两次写入都不丢；stateVersion 不兼容在副作用前明确拒绝并保留旧文件；写前二次校验版本 |
| C02 | 通过 | 未声明、缺 handler、代际终止后的工具都不暴露绑定，执行器按 `handler_not_ready` 拒绝；重复模型名与完整身份冲突由 EXT-A 注册表覆盖 |
| A04 | 部分通过 | 单插件钩子失败/超时/结果越界只影响本轮该插件，其他插件与账号不受阻；宿主侧任务抛错（作用域标识非法）也被收敛为该插件 failed，其余插件 additions 仍返回（`keeps one plugin task failure from removing another plugin additions`）；"Agent 可继续" 的最终编排证据属于 EXT-D |
| A05 | 通过 | 协议不存在 reply/sends 字段与发送句柄；插件只能返回 additions、状态变更和工具结果，无法改变角色或权限 |
| L07 | 部分通过 | 插件 Worker 侧"晚结果不得写新状态/不得交付"已验证；执行器关闭侧的账本保持 unknown 见 EXT-B |
| P03 | 通过 | 新版本换 Worker 并重新握手（generation 变化），已持久化状态命名空间保留；未实现的新增声明项不会自动 ready |
| P05 | 留给 EXT-D/G | `persisted/applied` 分离展示属于配置服务与页面闭环；本包提供 `sync()` 的逐项 ready/reason 状态作为数据来源 |

## 5. 独立复核与修复

复核方式：对 79/80/81/82/83 与运行时全部源码、七个离线夹具做独立通读，重点查跨账号/跨来源/跨作用域泄漏、晚到工作、内嵌 Worker 脚本、文档与代码一致性和生命周期泄漏。复核确认账号/来源/作用域隔离与"晚到不写状态"路径成立，同时给出 6 项可落地问题；逐条回到代码复核后处理如下。

| 编号 | 复核发现 | 处理 | 证据 |
| --- | --- | --- | --- |
| C3-1 | `AccountPluginRuntime.beforeContext` 实为串行 await，与"不阻塞其他插件"的意图相反：一个插件耗尽钩子超时或该 Worker 队列繁忙时，后面插件的 additions 被叠加延迟 | 改为并发 fan-out 并保留逐插件容错（`account-runtime.ts:77`） | `runs plugin hooks concurrently so a slow plugin does not add up across the turn`（慢钩子 400ms 与另一插件并发，总耗时远小于串行和） |
| C3-2 | `#onMessage` 的作用域守卫写作 `pending.scopeToken && 'scopeToken' in response && ...`，Worker 省略 scopeToken 时会被当作匹配放行 | 改为缺失即不匹配，fail-closed（`plugin-worker.ts:304`） | `rejects a reply that omits the scope token instead of assuming the request scope` |
| C3-3 | 上限互相冲突：状态快照随每个请求下发（≤16KiB 请求），但状态文件上限 128KiB、config 上限 32KiB。结果是状态涨到 16KiB 以上的插件每一次任务都 `plugin_request_too_large`，而文档写的是"32KiB config 有界" | 三个常量改为可同时满足：请求 64KiB、状态 16KiB、config 8KiB（`protocol.ts:8`） | `refuses tasks whose namespace has grown past the bounded size`；`bounds hook context and request size before posting work to a plugin` |
| C3-4 | `PluginStateService.#chains` 以文件路径为键且只在 close 时清空，长生命周期账号下 peer×epoch×插件的队列对象无界堆积 | 缓存上限 128，仅在队列空闲（未运行且无排队）时逐出，保证同文件写序不被打断（`state.ts:123`） | 既有串行写证据仍成立：`serializes concurrent plugin tasks and state writes without losing updates` |
| C3-5 | `#sync` 对健康且同 revision 的条目也会先 `#removeToolOwners` 再 await start，给在途批次留下 `handler_not_ready` 竞态窗口 | 移除这次多余的空置（旧条目的归属在删除分支已按管理器身份清掉），仅在启动失败时清理（`account-runtime.ts:109`） | `replays a ledger hit and refuses work once the plugin generation is gone`（终止后才应无 handler） |
| C3-6 | 内嵌脚本 `toolHandler` 回退到 `value[toolId]`，若插件把工具声明为 `beforeContext`/`afterTurn`/`init`/`dispose` 同名 id，会把钩子函数当工具 handler 执行 | 保留顶层导出的便捷路径，但保留名不再冒充工具（`protocol.ts:223`） | `exposes only declared handlers under namespaced tool ids` |

复核中一条不成立：认为 requestId 可能在 stop 复用而串号。`#requestSeq` 每个管理器单调递增且代际终止后不可复用，未做额外改动；上面的 C3-2 已把该路径的残余宽松处收紧。

## 6. 明确边界与后续

- `AccountPluginRuntime` 还没有被 Core/QqInstance/AgentEngine 构造使用；旧 `src/host/worker.ts` 回复通路和 `replyMode` 仍在，按计划由 EXT-D 删除单一宿主选择与独占回复分支，EXT-H 完成清理。因此本包不能宣告插件闭环已对用户生效。
- Worker 是生命周期与故障隔离，不是权限沙箱。示例插件运行在本地可信代码前提下，未阻止模块自行访问文件/网络；对外发布的签名与权限模型不在本轮范围（79 号已明确这一点，不能宣称已阻止恶意模块）。
- 插件 Skill 声明只进入目录与清单解析，多来源 Skill 服务、注入预算与只读预览属于 EXT-F。
- beforeContext 数据进入真实模型请求、afterTurn 收到真实发送状态、钩子单轮 2s 与 3 工具回合预算属于 EXT-D。
- 状态命名空间按 contextEpoch 分文件，长会话多 epoch 的回收策略与账号共享状态的迁移工具尚未实现；当前语义是"不兼容即拒绝，不静默丢状态"。

## 7. 自动验证

- `npm run typecheck`：通过（主工程 + desktop renderer）。
- `npx vitest run test/extension-runtime.test.ts`：28 通过，分组为 handshake 4、state namespaces 5、hooks and bounded inputs 6、unified executor 4、reply identity 4、isolation and lifecycle 5。
- `npx vitest run test/extension-contracts.test.ts test/extension-policy.test.ts test/tool-executor.test.ts test/extension-runtime.test.ts test/artifact-import.test.ts`：106 通过、1 既有跳过。
- `npm test`：106 文件，991 通过、1 既有跳过（EXT-B 后基线 963，本包新增 28）。
- 全量复跑观察：本包共跑 6 次全量。修复合入前的 4 次中有 2 次出现 `test/phase1-adapters.test.ts > video polling adapter over local HTTP > sends a best-effort remote cancel when the local signal aborts during polling` 失败（期望 `job_cancelled`，实际 `provider_submit_unknown`，本地 abort 与轮询失败分类竞态）；同一文件单跑 3 次与和本包测试并跑均通过，本包未改动适配器、轮询或 Provider 代码路径。修复合入后的全量 1 次通过、0 失败。该负载敏感竞态记为后续观察项，与[78号](78-memory-extraction-fixes-independent-review.md)记录的间歇性 `waitFor` 超时并列。
- 测试全部使用临时目录与离线夹具，未发起外网请求、未读取真实账号数据、未调用付费 Provider（phase1 使用本地回环假服务器，属既有测试）。
- 未执行：桌面打包、浏览器验收、真实 QQ/付费服务验证。
