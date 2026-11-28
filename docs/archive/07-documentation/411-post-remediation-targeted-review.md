# 411 · 409、410 修订后定向复核与修订清单

2026-11-28，基线为 `dev-front@f4b1ee4`。本轮复核涵盖两阶段：第一批定向复核桌面角色迁移、同源响应代理、混合记忆检索、笔记浏览及仓库验证入口（`R3-01`～`R3-09`）；第二批补查全仓出站代理、后台回填生命周期、SSE 推送与文档巡检盲区（`R3-10`～`R3-16`）。按现有功能的正确性共列出 **8 项必修、4 项可修、2 项建议加入、2 项优化**。本清单用于排期，修订实现和独立复验均待开展。产品边界以[持续决策记录](../../161-digital-life-direction-decisions.md)为准。前两轮结论见 [409](./409-project-audit-and-remediation-backlog.md) 和 [410](./410-second-round-strict-audit-backlog.md)。

## 一、必修项

### R3-10 · P0 · `PiModelProxy` 漏接流式首包与空闲超时，且非 SSE 响应无体积上限

410 `R2-08` 仅加固了主对话与记忆使用的 `HttpModelAdapter` 四条流式路径，遗漏了 Pi 工程代理 `PiModelProxy.dispatch()`。上游 `fetch()` 与 `for await (const bytes of upstream.body)` 仅绑定长租约 `lease.controller.signal`，既无首包响应头超时、也无 SSE 分片空闲超时；且非 SSE 分支直接 `Buffer.from(await upstream.arrayBuffer())`，没有任何字节上限。公网半开连接或超大响应可长时间卡死 Pi 工程槽位或推高后端内存。[工程模型代理转发](../../../apps/backend/src/mcp/model-proxy.ts#L140-L162)

**验收**：为 `PiModelProxy.dispatch()` 接入与 `HttpModelAdapter` 对齐的首包超时与 SSE chunk 空闲超时（可配置，单测可缩至短阈值），并为非 SSE 分支补齐流式字节上限。覆盖上游不回响应头、发 1 个 SSE 分片后挂死、非 SSE 响应超限三类场景，验证超时/超限能及时中止上游连接、释放 `claim` 与租约且记录失败账本。

### R3-01 · P1 · 导出成功的角色包可能超过同版本导入上限

导出递归收集工作空间和媒体文件，将数据编码为 Base64，再把包含表数据和元数据的完整 JSON 写入临时文件并发布。同步和异步导入均先检查文件大小，默认上限为 256 MiB。写入端缺少相同的最终字节约束，用户可能直到另一台机器预检时才发现迁移包无法使用。[素材采集](../../../apps/backend/src/application/transfer/role-transfer-files.ts#L67) · [包写入与读取](../../../apps/backend/src/application/transfer/role-transfer-package.ts#L117)

**验收**：沿用当前 256 MiB 契约，共享最终 UTF-8 文件字节预算，计入 Base64、非 ASCII 文字和 JSON 结构。用可调小上限覆盖恰好达限和超出一字节。成功导出的包应通过同版本体积预检，超限时给出可识别的错误，清理临时文件并保留已有目标文件。采集阶段也应能提前终止明显超限的输入。

### R3-02 · P1 · 一次 HTTP 迁移操作使用了两次读包结果

预检先异步读包获取显示名和角色活动状态，再由核心按路径同步重读生成预检摘要。应用时也先读包确定角色及连接守卫，再由核心重读、校验和发布。文件稳定时已有重复 I/O 和解析。两次读取之间文件发生变化时，预检展示信息可能与摘要不一致，应用守卫所针对的角色也可能与核心读取的角色不同。[HTTP 服务](../../../apps/backend/src/application/transfer/role-transfer-service.ts#L125) · [核心检查](../../../apps/backend/src/application/transfer/role-transfer.ts#L255)

**令牌的保护范围**：令牌包含迁移包摘要、本机状态及绑定映射；应用时重算，不匹配会在发布前返回 `ROLE_TRANSFER_PREFLIGHT_STALE`。按正常流程，预检后换成另一份包通常会被拒绝。本轮确认的是同一次操作内输入来源不一致，未观察到错误角色实际被覆盖。[令牌生成](../../../apps/backend/src/application/transfer/role-transfer.ts#L281) · [发布前校验](../../../apps/backend/src/application/transfer/role-transfer.ts#L322)

**验收**：每次预检、每次应用各自读取并校验一次。展示、守卫和发布使用当次同一份包对象；两次操作之间仍重新读取文件和校验本机状态。覆盖稳定文件、两次操作间换包、读包后文件变化，以及角色运行中拒绝应用。用读取次数断言覆盖同步重读回归。

### R3-03 · P1 · 桌面代理将上游意外断流传成正常结束

代理的 `end` 与 `aborted` 分支都调用 `controller.close()`。后者先标记流已关闭，随后到来的错误也无法再传给下游。本轮用 Node 24 内存流驱动真实代理函数：模拟上游声明 8 字节、写入 3 字节后触发 `aborted`，得到 HTTP 200，`response.arrayBuffer()` 成功返回 3 字节。既有 SSE 测试针对客户端主动取消，允许正常结束或报错，因而能与该缺陷同时存在。[代理响应处理](../../../apps/desktop/electron/backend-proxy.cjs#L109) · [现有取消用例](../../../apps/desktop/tests/unit/backend-proxy.test.cjs#L90)

**验收**：完整下载应按字节一致地成功。上游响应中断时，消费正文须失败，有无 Content-Length 均覆盖。用户主动取消 SSE 时仍要及时释放上游连接。现有背压与请求体转发测试继续通过。

### R3-04 · P1 · 更换 Embedding 服务后可能复用旧向量空间

生产端从资源配置读取服务地址，缓存键只组合资源 ID 和模型名。文档哈希和缓存自身维度校验通过后，旧向量不再进入待回填队列。若地址变更且相同模型别名实际指向不同向量空间，同维时语义排序可能失真；异维时相似度函数返回零，旧条目却仍可持续命中缓存。地址变更但实际模型相同的情况不会必然产生错排。[端口与缓存键](../../../apps/backend/src/application/memory/memory-embedding-settings.ts#L186) · [缓存复用](../../../apps/backend/src/application/memory/memory-query-service.ts#L254) · [维度检查](../../../apps/backend/src/application/memory/memory-hybrid-search.ts#L354)

**验收**：用两个可控离线端点模拟资源 ID、模型别名不变的切换，分别覆盖同维不同空间和异维。新查询使用新配置对应的缓存，失配文档可重新回填；旧后台任务完成时不能污染新缓存。升级前已有缓存须有明确失效或迁移路径，回填期间保留 FTS 回退。

### R3-11 · P1 · `MemoryQueryService` 后台 Embedding 回填未接入角色停止、删除与资源影响生命周期

`MemoryQueryService.scheduleBackgroundBackfill()` 会在对话召回后异步逐批写入角色业务库 `memory_search_embeddings`，但该后台队列游离于既有生命周期协调之外：`RoleDeletionService.dispose(roleId)` 未取消或等待回填且未传 `isRoleDeleting`，多批回填可能在删除/停机/迁移导出间隙继续打开 SQLite 写入；`activity.attachRuntime.isRunning(roleId)` 与 `externalInflightRoleIds` 也未计入回填；`ResourceService.impact()` 与 `maintenancePlan()` 完全不感知 `memory_embedding_settings`，修改或删除仅用于 Embedding 的模型资源时影响报告显示 0 依赖且留下悬挂配置；此外 `MemoryQueryService.close()` 未用 `AbortController` 中止在途批次，关机时最多空等单批超时。[后台回填](../../../apps/backend/src/application/memory/memory-query-service.ts#L468-L548) · [在途与运行态装配](../../../apps/backend/src/bootstrap/app.ts#L437-L447) · [删除收尾](../../../apps/backend/src/bootstrap/app.ts#L523-L553) · [资源影响分析](../../../apps/backend/src/application/resources/resource-service.ts#L708-L785)

**验收**：为每角色后台回填接入 `AbortController` 取消与 `disposeRole(roleId)` 等待、`isBackfilling(roleId)` 纳入运行态/删除收尾、`close()` 立即中止在途批次；`ResourceService.impact()` 与删除资源逻辑感知并同步处理 `memory_embedding_settings`。单测覆盖「回填中删除角色零残留」「停机后不继续写库」「删除被 Embedding 选中的模型服务给出依赖/清理悬挂配置」「`close()` 立即中断慢回填」。

### R3-12 · P1 · `ManagedPi.notify()` 无异常隔离，单个异常 SSE 连接可中断角色后续工程调度

`GET /v1/engineering/events` 的推送函数直接调用 `response.write(...)` 且未检查 `response.destroyed || response.writableEnded`；`ManagedPi.notify()` 也未对每个订阅者做 `try/catch` 隔离（对照 `FeedEventHub.emit` 与 `ExtensionHost.publishUi` 均有隔离）。当任一已断开或半关闭的 SSE 连接在 `write` 时抛错，异常会从 `finish()` 中的 `this.notify()` 冒泡，直接跳过下一行的 `if (!this.closing) this.schedule(job.roleId)`，导致该角色后续排队的 Pi 工程任务永远停滞，并阻断其他订阅者更新。[工程收尾与通知](../../../apps/backend/src/mcp/managed-pi.ts#L178-L188) · [工程事件流](../../../apps/backend/src/http/routes.ts#L171-L177)

**验收**：`ManagedPi.notify()` 逐监听者隔离异常；`/v1/engineering/events` 在写入前校验流可写并在异常时自动退订。单测注入首监听者抛错，验证其余监听者仍收到通知且 `finish()` 继续执行后续排队任务的 `schedule()`。

### R3-13 · P1 · `IndexTtsClient` 仍漏禁 HTTP 3xx 重定向

同目录 `UnifiedTtsClient`、`ComfyUiClient`、`HttpOpenAiEmbeddingPort` 与 `PiModelProxy` 均已显式设置 `redirect: "manual"` 或 `"error"`，唯独仍在生产路径被 `VoiceService` 调用的 `IndexTtsClient.synthesize()` 未配置 `redirect` 选项，且请求体包含本机音色文件绝对路径 `spk_audio_path`，默认会自动跟随 3xx 重定向。[IndexTTS 客户端](../../../apps/backend/src/tts/indextts-client.ts#L46-L60) · [语音服务调用点](../../../apps/backend/src/application/media/voice-service.ts#L654)

**验收**：为 `IndexTtsClient.synthesize()` 显式设置 `redirect: "manual"` 并在 3xx 时中止上游连接并抛出可识别的 `TtsSynthesisFailedError`。单测用返回 302 的本地假端点验证不跟随跳转且原目标地址零访问。

## 二、可修项

| 编号 | 触发条件与用户可见结果 | 验收 |
| --- | --- | --- |
| R3-05 · P2 | 扫描预算耗尽时可能返回空列表且 `truncated=true`。界面同时显示“还没有 Markdown 笔记”和“仅展示前 0 篇”。[列表空态](../../../apps/desktop/renderer/src/components/config/role/WorkspaceNotesPanel.tsx#L100) | 分别验证完整空列表、截断空列表和截断非空列表。截断空列表只提示当前扫描范围内未找到笔记。 |
| R3-06 · P2 | 已显示笔记 A 后选中 B，详情请求保留 A 的正文。加载提示要求当前没有正文，慢响应时左侧已选 B，右侧仍在展示 A。[详情请求](../../../apps/desktop/renderer/src/components/config/role/WorkspaceNotesPanel.tsx#L65) · [预览分支](../../../apps/desktop/renderer/src/components/config/role/WorkspaceNotesPanel.tsx#L115) | 预览随角色和路径匹配；在 B 请求尚未返回时能看出 B 正在加载，快速切换或请求失败也不会显示错配正文。 |
| R3-14 · P2 | `ComfyUiClient.view()` 先 `await response.arrayBuffer()` 全量读入内存再判 32 MiB 上限，`readJson()` 无字节上限；本地 MCP `workspace_read` 先 `fs.readFileSync()` 读完整文件再截断 1 MB，遇超大响应或超大文件易造成内存峰值/OOM。[ComfyUI 读图](../../../apps/backend/src/scene/comfyui-client.ts#L260-L266) · [ComfyUI 读 JSON](../../../apps/backend/src/scene/comfyui-client.ts#L444-L455) · [本地工作空间读文件](../../../apps/backend/src/mcp/local-server.ts#L47-L51) | `ComfyUiClient` 改为流式字节计数上限（对齐 `UnifiedTtsClient.readResponseBody`）；`workspace_read` 改为 `openSync` + 定长 `readSync(MAX_TEXT_BYTES + 1)`。单测覆盖超限流提前中止与超大文件低内存截断。 |
| R3-15 · P2 | `/v1/engineering/events`、`/v1/feed-events`、`/v1/extension-events` 三条长连接 SSE 缺少定时心跳（对照 `conversation-stream-hub.ts` 有 `: heartbeat`）及写入前 `destroyed`/`writableEnded` 校验，空闲半开连接难以探活回收。[工程与动态事件流](../../../apps/backend/src/http/routes.ts#L171-L187) · [扩展事件流](../../../apps/backend/src/http/routes.ts#L221-L233) | 补齐统一 SSE 写入守卫与 `.unref()` 心跳定时器，连接关闭时清理定时器与监听者；单测覆盖断开后写入不报错且无句柄泄漏。 |

## 三、建议加入项

- **R3-07 · 将 Pi 子包现有串行测试接入根级验证。** 410 曾单独运行 Pi 子包 14 项测试。当前根级 `fast` 没有 Pi 变更映射，`unit` 和 `gate` 的命令清单也未显式运行 Pi 自身测试。建议在单改 `apps/pi-mcp/` 时触发该套件，并在完整门禁中单列结果。验收时检查 Pi 用例失败能使对应根命令返回非零；沿用已验证的串行运行方式。[根级命令选择](../../../scripts/verify.mjs#L297) · [完整门禁](../../../scripts/verify.mjs#L346) · [410 终验](./410-second-round-strict-audit-backlog.md#L402)
- **R3-16 · 为 `scripts/check-docs.mjs` 补齐源码 `#L...` 行号越界巡检。** 当前脚本遇到 `#L123-L456` 直接跳过，410 中 `protocols.ts` 拆缩至 332 行后 3 处越界行号引用仍报 0 警告。建议对非历史豁免文档的源码 `#L` 行号校验文件总行数并输出告警，防止重构后审计文档静默失真。[锚点跳过逻辑](../../../scripts/check-docs.mjs#L146-L175)

## 四、优化项

| 编号 | 已确认的成本来源 | 测量与决策 |
| --- | --- | --- |
| R3-08 | 目录扫描先用同步 `readdirSync` 枚举整层，再检查 5,000 项访问预算。宽目录首层枚举仍会占用后端事件循环。[枚举与计数](../../../apps/backend/src/application/role/role-workspace-service.ts#L105) | 用相同笔记数量、不同单层宽度记录返回耗时、峰值内存和同时发起的健康请求延迟，再评估分批枚举。保留跳过依赖目录、深度限制和截断提示。 |
| R3-09 | 混合检索在线回填批次有界，但查询准备阶段仍会按角色和模型读取缓存，对候选正文求哈希并解码向量。[准备阶段](../../../apps/backend/src/application/memory/memory-query-service.ts#L245) · [缓存查询](../../../apps/backend/src/application/memory/memory-query-service.ts#L1057) | 对不同规模角色库分别测量首次查询和缓存命中查询，记录耗时、内存和召回结果。依据实测决定是否缩小缓存读取范围或分批解码。 |

## 五、复核记录与执行顺序

- **第一批运行（`R3-01`～`R3-09`）**：Node 24 下，迁移包读取超限和未配置 Embedding 回退 FTS 两个既有用例通过（2/2）；另用内存响应样例复现验证了 `R3-03`。前两个用例验证既有保护，尚未覆盖 `R3-01` 的导出边界及 `R3-04` 的地址切换。
- **第二批源码补查（`R3-10`～`R3-16`）**：基于同一 `dev-front@f4b1ee4` 基线逐一核实 `PiModelProxy`、`MemoryQueryService` / `app.ts` / `ResourceService`、`ManagedPi` / `routes.ts`、`IndexTtsClient`、`ComfyUiClient` / `local-server.ts` 与 `check-docs.mjs`，所有位置与行为均为静态源码核实，修订实现与回归验证待开展。
- **前次运行**：同一代码基线的桌面代理现有用例 5/5 通过。本次未重跑全仓门禁、Electron 实窗或真实服务。两项性能优化均待基准测量。
- **排期建议**：先修 P0 `R3-10`（Pi 代理超时与体积上限）；再并行收口 P1：`R3-01` + `R3-02`（迁移专项）、`R3-03`（桌面代理断流）、`R3-04` + `R3-11`（Embedding 缓存失效与生命周期专项）、`R3-12`（Pi SSE 通知隔离）、`R3-13`（IndexTTS 禁重定向）；最后合批处理 P2 可修与门禁项（`R3-05`/`R3-06`、`R3-14`/`R3-15`、`R3-07`/`R3-16`）。后续修复及独立复验逐条追加在本文。
- **交付遗留**：干净 Windows 便携包和真实模型、TTS、ComfyUI 联调沿用 409 的 `DELIV-02` 与 410 的 `R2-12`。410 的新拷贝首个健康响应为 4.632 秒，带缓存常规启动为 0.417 秒。以冷启小于 2 秒为目标时，仍需同条件的首次启动实测。[410 两组测量](./410-second-round-strict-audit-backlog.md#L390-L391)

## 六、修订与定向复验

### 第一阶段 `R3-10` Pi 模型代理出站保护

- Pi 代理以两个独立的 90 秒限时约束响应头和正文分片。非 SSE 正文检查声明长度和实际累计字节，默认上限 16 MiB。超时或超限关闭上游，结算失败账本并释放模型调用占位。已失败租约停止新请求，工程收尾撤销租约。主动取消仍走原有取消路径。
- Claude CLI 实施后，主进程使用 Node 24.22.2 定向复验。覆盖无响应头、首个 SSE 分片后的空闲、声明及分片累计超限、下游断开、租约撤销、失败记账及健康租约复用，并回归 Pi 租约、线协议和工程调度。后端类型检查及 18 项离线测试通过。

### 第二阶段 `R3-01` 和 `R3-02` 角色迁移

- CLI 和 HTTP 导出与读取共用 256 MiB 最终 UTF-8 文件上限。素材采集先估算 Base64 体积，导出发布前核对实际序列化字节。超限返回 `ROLE_TRANSFER_PACKAGE_TOO_LARGE`，并保留已有目标。
- 每次 HTTP 预检和应用各自读取、校验一份包。显示名、令牌、活动守卫和发布均取自该次快照，应用重新检查本机状态及服务映射。仅校验并发布完整的时间线。
- Claude CLI 实施后，主进程通过后端类型检查及 29 项迁移包、迁移恢复和工作空间 HTTP 测试。验收覆盖恰好达限、超出一字节、已有目标保留、读包后换文件、预检后换包令牌失效及运行中拒绝应用。当前 Windows 环境限制创建测试符号链接，该用例执行了目录拒绝分支。

### 第三阶段 `R3-03` 桌面代理异常断流

- 同源代理收到上游异常中止、错误或未完成关闭时将错误传给正文读取端，并释放上游连接。正常收到完整响应时关闭正文流。下游主动中止继续及时清理连接。
- Claude CLI 实施后，主进程通过桌面代理 7 项定向测试，覆盖带 `Content-Length` 或分块传输时的中断、逐字节完整下载、SSE 主动取消、背压及请求体流式转发。

### 第四阶段 `R3-04` 和 `R3-11` Embedding

- 向量缓存使用包含资源、有效地址、协议、服务商和模型的版本化指纹。旧键自动失效，已有正文和 FTS5 索引可继续检索。维度失配的条目重新进入回填，后台批次完成后复核当前指纹再写库。
- 每个角色的后台回填有独立取消信号。停机等待批次结算，删除等待任务退出后驱逐角色库，应用退出中止所有回填。全局启用的 Embedding 服务进入依赖影响和维护计划，删除所选资源时在同一决策事务内清理配置。
- Claude CLI 实施后，主进程通过后端类型检查和 67 项混合检索、角色活动与删除、维护协调及资源测试。另使用两个回环端点复验旧批次在切换配置后返回时不会落盘，新批次只写入新向量键。

### 第五阶段 `R3-12` 和 `R3-15` 事件流

- 工程通知分别执行每个订阅者。单个订阅者抛错时，其余订阅者仍收到通知，工程收尾继续唤醒该角色的调度。
- 工程、动态和扩展三条 SSE 共用写入守卫与 15 秒注释心跳。响应关闭、结束或出错时清理订阅和计时器，写入异常同时关闭连接，遇到背压时暂停心跳。
- Claude CLI 实施后，主进程通过后端类型检查及工程调度、动态、扩展和 SSE 生命周期 42 项定向测试。三条回环 HTTP 路由均实收默认心跳。
