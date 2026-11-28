# 第二轮全仓严苛复查与待处理修复清单（410）

> **创建日期**：2026-11-28 · **审计基线**：`dev-front` `11b624d`（409 首轮 23/24 离线项收口后）  
> **性质**：第二轮严苛源码审计待处理清单，覆盖 409 R6～R14 新代码引入的新缺陷与安全退步，以及此前未触及的底层核心模块隐患与交付闭环缺口（非已确认需求；涉及调整既有 `DL-xx` 边界或策略的条目已显式标注「需先确认决策」）。  
> **维护约定**：本轮全部排查、方案确认、修复提交与复验记录均按条目追加在本文件内，不再另起编号文件。  
> **关联入口**：[首轮审计清单 409](./409-project-audit-and-remediation-backlog.md) · [当前状态看板](../../STATUS.md) · [产品方向与决策 161](../../161-digital-life-direction-decisions.md) · [现行规范总览](../../specs/README.md)

---

## 0. 审计背景与优先级总表

409 首轮审计的 19 笔提交（`0e496c4`～`11b624d`）已将原清单 24 项中的 23 项离线闭环（`RoleAccess` 已统一注入、桌面托管态已接入 DPAPI 主密钥、`desk://` 已去除 `sendSync` 并收口明文令牌、Pi 默认收紧为无 Shell、`conversation-service.ts` 与 `Settings.tsx` 已消除 100 KB 告警）。

本轮按同样严苛标准对 **R6～R14 新增代码**与**未充分审计的底层核心模块**重新源码深查，共确认 **13 项**新待处理问题：其中 **7 项**为 R6～R14 新引入问题（`R2-01`～`R2-07`），**6 项**为底层核心模块隐患、剩余架构债务与真实交付盲区（`R2-08`～`R2-13`）。

### 0.1 优先级总表（逐项排查索引）

| 编号 | 来源维度 | 类别 | 优先级 | 问题摘要 | 是否涉及修订 `DL-xx` | 状态 |
| --- | --- | --- | :---: | --- | :---: | :---: |
| [R2-01](#r2-01-桌面代理在请求取消时-promise-永久挂起且缺少流式背压) | 409 新引入（R8b） | 运行时 Bug / 泄漏 | **P0** | `main.cjs` 取消代理调无参 `destroy()` 不触发 `error`，Promise 永不结算；流响应无背压 | 否 | `[x]` 已修复 |
| [R2-02](#r2-02-混合检索-embedding-存在漏防重定向缺账本绕维护与首聊阻塞四重硬伤) | 409 新引入（R14） | 安全 / 账本 / 性能 | **P0** | 缺 `redirect: "error"`、跨协议乱配不拦、未入 Token 账本与维护守卫、海量未向量化记忆阻塞首聊且超时丢已算结果 | 关联 `DL-51` / `DL-183` | `[x]` 已修复 |
| [R2-03](#r2-03-运行态单角色迁移接口存在主线程硬阻塞无体积上限与写路径过宽问题) | 409 新引入（R11） | 安全 / DoS | **P0** | `Atomics.wait` 同步冻住主线程 200ms、`readFileSync` 无上限易 OOM、导出路径只拦两子目录、`/workspace/path` 仍向渲染层暴露 | 否 | `[x]` 已修复 |
| [R2-08](#r2-08-模型流式生成请求完全缺少首包超时与流空闲超时) | 底层核心 | 稳定性 / 死锁 | **P0** | 四条流式协议入口均未设首包或 chunk 空闲超时，上游半开连接可永久锁死角色执行槽位 | 否 | `[x]` 已修复 |
| [R2-04](#r2-04-工作空间笔记扫描未跳过依赖目录且无遍历数上限) | 409 新引入（R11） | 性能 / DoS | **P1** | `RoleWorkspaceService.listNotes` 不跳过 `node_modules` 且无总访问数上限，易同步卡死主线程 | 否 | `[x]` 已修复 |
| [R2-05](#r2-05-pi-步骤日志并发无序写盘竞态且硬依赖-sdk-私有内部路径) | 409 新引入（R6） | 并发 Bug / 脆性 | **P1** | `worker.mjs` 并发 `writeSteps()` 无串行队列与原子改名易 `EBUSY`/错序；硬导入 SDK 未导出内部路径 `./utils/paths.js` | 否 | `[x]` 已修复 |
| [R2-06](#r2-06-热生效配置把删除图生图服饰参考图误划入免停机区) | 409 新引入（R9b） | 并发竞态 | **P1** | `DELETE .../scene-image/outfits/:outfitId/reference` 免停机且立刻删盘，与在途自动 `img2img` 任务竞态报错 | 关联 `DL-148` | `[ ]` 待排查 |
| [R2-07](#r2-07-roleaccess-连接池缺少坏句柄校验与异常驱逐自愈) | 409 新引入（R4） | 稳定性 / 容错 | **P1** | `borrow()` 不验 `db.open`，遇到 `SQLITE_IOERR`/`SQLITE_CORRUPT` 不驱逐脏连接，坏句柄滞留 60s | 否 | `[x]` 已修复 |
| [R2-09](#r2-09-google-服务账号凭据-token-地址允许任意明文-http-触发-ssrf) | 底层核心 | 安全边界 | **P1** | `parseServiceAccountCredential` 放行明文 `http:` 且不限域名，篡改 JSON 可将签名 JWT 发往恶意或内网地址 | 否 | `[x]` 已修复 |
| [R2-10](#r2-10-未配置生图服务时手动点击过场图仍静默生成假占位图落盘) | 底层核心 | 产品缺陷 | **P1** | `ConfiguredSceneImageGenerator` 仍回退 `FakeSceneImageGenerator`，向真实角色库写入假占位 PNG | 需确认边界（`DL-142` / `DL-150`） | `[ ]` 待排查 |
| [R2-11](#r2-11-仓储层与核心执行层仍残存-11-个千行至近三千行巨石文件) | 架构遗留 | 架构债务 | **P1** | R12 仅拆掉 2 个 >100 KB 告警文件；`memory-store`、`schema.ts`（V32）等 11 个核心文件仍超千行 | 否 | `[ ]` 待排查 |
| [R2-12](#r2-12-离线验证与真实交付最后一公里仍未闭环) | 交付遗留 | 交付 / 质量 | **P1** | 脱仓冷启 health 仍 4.27s（未达 `<2s`）、干净机便携 EXE 未实机验收、`DELIV-02` 真实云端/媒体联调仍为 0 | 否 | `[ ]` 待排查 |
| [R2-13](#r2-13-409-文档状态残留与并发-e2e-像素帧抖动) | 文档与测试 | 一致性 / 稳定性 | **P2** | `409` 正文 `BUG-03` 仍标 `[ ]`、`STATUS.md` 标题日期滞后、3 并发 E2E `settings-media-sheet` 像素帧抖动 | 否 | `[ ]` 待排查 |

### 0.2 建议修复分期路线

1. **阶段一 · 线上止血与安全收口（P0）**：`R2-01` → `R2-08` → `R2-02` → `R2-03`
2. **阶段二 · 并发竞态、容错与安全加固（P1）**：`R2-04` → `R2-05` → `R2-06` → `R2-07` → `R2-09` → `R2-10`
3. **阶段三 · 真实交付闭环与深层拆解（P1/P2）**：`R2-12` → `R2-11` → `R2-13`

---

## 一、409 R6～R14 新代码引入的新 Bug 与安全退步（`R2-01`～`R2-07`）

### R2-01 桌面代理在请求取消时 Promise 永久挂起且缺少流式背压

- **优先级**：P0 · **来源**：409 R8b · **状态**：`[x]` 已修复（R1，2026-11-28）
- **证据位置**：
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L317-L325)（`onAbort` 与预中止分支调用无参 `upstreamReq.destroy()`）
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L286-L313)（`ReadableStream` 缺少背压控制）
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L366-L368)（非 GET 请求整包 `arrayBuffer()` + `Buffer.from()` 双份缓冲）
- **根因分析**：
  1. 在 Node.js `http.ClientRequest` 中，调用无参 `upstreamReq.destroy()` 只触发 `close` 事件、**不会触发 `error` 事件**。且第 319 行 `if (request.signal.aborted) { upstreamReq.destroy(); return; }` 既在注册 `error` 监听器之前，又直接 `return` 未调用 `rejectResponse`，导致在收到响应头之前触发中止时，`proxyBackendRequest` 返回的 `Promise` **永久挂起不结算**；
  2. `ReadableStream` 的 `start()` 直接在 `upstreamRes.on("data")` 中无条件 `controller.enqueue(chunk)`，未检查 `controller.desiredSize` 或结合 `pull()` 调 `upstreamRes.pause()/resume()`，慢消费端读取大图片（32 MiB）或音频（16 MiB）时会在 Electron 主进程无界积压内存；
  3. 上传文件（最高 128 MiB）先 `await request.arrayBuffer()` 再 `Buffer.from(body)`，在主进程形成大块峰值内存占用。
- **修复建议**：
  1. 封装统一 `fail(err)` 结算函数：在 `request.signal.aborted` 分支、 `onAbort` 回调及 `upstreamReq.once("close")`（当 `!settled` 时）均保证以明确的 `AbortError` 调 `rejectResponse`，并传入 `upstreamReq.destroy(abortError)`；
  2. 在 `ReadableStream` 中加入背压：`enqueue` 后若 `(controller.desiredSize ?? 0) <= 0` 调用 `upstreamRes.pause()`，在 `pull()` 回调中调用 `upstreamRes.resume()`；
  3. 非 GET/HEAD 带流请求改为使用 `Readable.fromWeb(request.body).pipe(upstreamReq)` 流式转发（仅对短 JSON 或需要重试场景缓冲），避免主进程 128 MiB 整包拷贝。
- **验收标准**：
  - 桌面壳单测覆盖：已中止 `AbortSignal` 传入、响应头返回前中途 `abort()` 两种场景，Promise 均在 <50ms 内稳定 reject 并关闭上游连接；慢消费流读取大响应时触发 `pause/resume` 背压。

---

### R2-02 混合检索 Embedding 存在漏防重定向、缺账本、绕维护与首聊阻塞四重硬伤

- **优先级**：P0 · **来源**：409 R14（`ARCH-03`） · **状态**：`[x]` 已修复（R3，2026-11-28） · **决策关联**：[DL-51](../../161-digital-life-direction-decisions.md#dl-51-第一版召回基线多维条件过滤与全文检索) · [DL-183](../../161-digital-life-direction-decisions.md#dl-183-全局设置页提供持久-token-消耗统计)
- **证据位置**：
  - [apps/backend/src/application/memory/memory-hybrid-search.ts](../../../apps/backend/src/application/memory/memory-hybrid-search.ts#L65-L82)（`fetch` 未禁重定向、`response.json()` 无响应大小上限）
  - [apps/backend/src/application/memory/memory-embedding-settings.ts](../../../apps/backend/src/application/memory/memory-embedding-settings.ts#L86-L138)（仅校验 `kind === "model"`，未校验协议兼容与服务维护态）
  - [apps/backend/src/application/memory/memory-query-service.ts](../../../apps/backend/src/application/memory/memory-query-service.ts#L188-L256)（`prepared.pending` 无上限且超时直接丢弃前序已算向量）
- **根因分析**：
  1. **凭据泄漏/SSRF 风险**：`HttpOpenAiEmbeddingPort.embed()` 发送带 `Authorization: Bearer` 头的 `fetch` 时漏了 `redirect: "error"`（或 `"manual"` 拦截 3xx），与全仓其余出站客户端安全口径不一致；且未限制响应字节上限；
  2. **跨协议误配不拦**：保存配置仅检查资源是 `model` 类型，允许选择 Anthropic Messages 或 Google Vertex 资源，运行时硬拼 `/embeddings` 与 `Bearer` 头；
  3. **账本黑洞与维护穿透**：Embedding 外部调用完全没有写入 `TokenUsageService`（违反 `DL-183` 本机全部模型调用入账原则），也没有通过 `ResourceService.claimModelCall()` 协调模型服务维护窗口；
  4. **老角色首聊阻塞与白烧钱死循环**：`searchHybrid` 在对话自动召回路径上同步循环向量化 `prepared.pending` 的**全部**未缓存文档，无单次上限；一旦老角色有数百条记忆，首轮聊天会被拖慢数十秒直至某批超时——而 `persistVectors` 放在 `try` 之后，只要中途任一批超时进入 `catch`，前面已花钱算完的 N-1 批向量全部丢失不落盘，下一轮继续重算重超时。
- **修复建议**：
  1. `HttpOpenAiEmbeddingPort` 强制 `redirect: "manual"` 拦截 3xx，校验 `baseUrl` 为合法 `http/https`，并限制响应体上限（如 16 MiB）；
  2. `MemoryEmbeddingSettingsService` 校验所选模型服务协议支持 OpenAI 兼容 `/embeddings`（或在 UI 仅列出兼容服务，并提供「测试 Embedding 连接」探测）；
  3. 将 Embedding 调用接入 `ResourceService.claimModelCall()` 维护守卫，并把 `usage.prompt_tokens`/`total_tokens` 记入 `TokenUsageService`（归入记忆整理或独立统计口径，按 `DL-183` 明确登记）；
  4. `searchHybrid` 限制单次在线检索补算上限（如每次最多补算 1～2 批 / 总预算 ≤3 秒），**每批算完立即增量落盘 `persistVectors`**；其余存量未向量化记忆交由后台低优先级队列逐步回填，绝不在实时对话路径全量阻塞。
- **验收标准**：
  - 模拟 302 重定向、维护中模型服务、200 条未缓存记忆超时三种场景：重定向被拒、维护期静默退回 FTS5 不发请求、部分批次成功结果已持久化落盘且调用量进入 `GET /v1/usage/tokens`。

---

### R2-03 运行态单角色迁移接口存在主线程硬阻塞、无体积上限与写路径过宽问题

- **优先级**：P0 · **来源**：409 R11（`UX-05`） · **状态**：`[x]` 已修复（R1，2026-11-28）
- **证据位置**：
  - [apps/backend/src/application/transfer/role-transfer-package.ts](../../../apps/backend/src/application/transfer/role-transfer-package.ts#L133-L152)（第 142 行 `Atomics.wait` 同步阻塞 20×10ms；第 147 行 `fs.readFileSync` 无体积上限）
  - [apps/backend/src/application/transfer/role-transfer.ts](../../../apps/backend/src/application/transfer/role-transfer.ts#L157-L168)（导出路径只拦截 `data/roles` 与 `data/.role-transfer`）
  - [apps/backend/src/http/role-transfer-workspace-routes.ts](../../../apps/backend/src/http/role-transfer-workspace-routes.ts#L64-L71)（`GET /v1/roles/:roleId/workspace/path` 经 `desk://bundle/v1/*` 可被渲染层直接读取）
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L355-L374) 与 [main.cjs#L500-L516](../../../apps/desktop/electron/main.cjs#L500-L516)（注释承诺绝对路径不回传渲染层）
- **根因分析**：
  1. `readRoleTransferPackage` 原为离线 CLI 编写，内部使用 `Atomics.wait` 同步睡眠重试 `ROLE_TRANSFER_UNSAFE_PATH`。挂入常驻 HTTP 后端后，任何符号链接或非法路径请求都会把整个 Node 事件循环同步冻住 200ms；
  2. `fs.readFileSync(resolved, "utf8")` 未先检查 `stat.size` 上限，误选大文件可直接造成主进程 OOM 崩溃；
  3. `assertPackageFileOutsideManagedDirs` 只排除了 `data/roles` 和 `data/.role-transfer`，放行了 `<appRoot>/secrets`、`<appRoot>/data`、`<appRoot>/runtime`、`<appRoot>/extensions` 等敏感目录，且不校验文件扩展名；
  4. `GET /v1/roles/:roleId/workspace/path` 未放入 `/v1/internal/` 或在 `desk://` 代理中拦截，渲染层直接发 `fetch('/v1/roles/<id>/workspace/path')` 即可拿到绝对路径，破坏隔离承诺。
- **修复建议**：
  1. 将 HTTP 侧读取改为异步重试（`setTimeout` / `delay`，且仅对刚存在的普通文件短暂重试，符号链接/目录直接立即失败不重试）；
  2. `readRoleTransferPackage` 读取前强制检查文件大小上限（如 ≤256 MiB，超限返回明确 `413 ROLE_TRANSFER_PACKAGE_TOO_LARGE`）；
  3. 收紧 `assertPackageFileOutsideManagedDirs`：禁止将迁移包导出到整个 `<appRoot>`（含 `data/`、`secrets/`、`runtime/`、`extensions/`、`extensions-work/`）内部，并要求 `.json` 后缀；
  4. 在 `main.cjs` 的 `desk://bundle/v1/*` 代理中显式拦截 `/v1/roles/*/workspace/path` 返回 404，仅允许 Electron 主进程 `desk:open-role-workspace` IPC 内部访问。
- **验收标准**：
  - 向 `/preflight` 传入符号链接路径时事件循环阻塞 <5ms 且立即返回 400；传入超大文件返回 413 不触发 OOM；尝试导出至 `<appRoot>/secrets/x.json` 返回 400；渲染层直接 `fetch('/v1/roles/.../workspace/path')` 返回 404。

---

### R2-04 工作空间笔记扫描未跳过依赖目录且无遍历数上限

- **优先级**：P1 · **来源**：409 R11（`UX-05`） · **状态**：`[x]` 已修复（R4，2026-11-28）
- **证据位置**：
  - [apps/backend/src/application/role/role-workspace-service.ts](../../../apps/backend/src/application/role/role-workspace-service.ts#L82-L118)
  - 对照已有安全写法：[apps/backend/src/mcp/local-server.ts](../../../apps/backend/src/mcp/local-server.ts#L103-L114)（跳过 `node_modules`、限制 `visited > 2000`）
- **根因分析**：
  `listNotes` 仅限制了已命中的 Markdown 笔记数（`MAX_NOTE_ENTRIES = 500`）与目录深度（6 层），但**既不跳过 `node_modules` 等依赖目录，也不限制总遍历文件系统节点数**。若工作空间内存在大量非 Markdown 文件（如脚本依赖目录、缓存资产），每次打开角色配置页都会在主线程同步执行数万次 `lstatSync`，造成界面与后端整体卡顿。
- **修复建议**：
  1. 在 `walk()` 中跳过常见巨型非笔记目录（`node_modules`、`__pycache__`、`dist`、`build`、`target`）与符号链接；
  2. 增加总访问节点上限（如 `MAX_VISITED_ENTRIES = 5000`），触顶时停止遍历并在接口响应中返回 `truncated: true` 供 UI 轻提示。
- **验收标准**：
  - 单测在工作空间中放置 `node_modules/`（数千文件）及超限目录，调用 `listNotes` 耗时 <50ms 且准确返回 `truncated` 标志。

---

### R2-05 Pi 步骤日志并发无序写盘竞态，且硬依赖 SDK 私有内部路径

- **优先级**：P1 · **来源**：409 R6（`BUG-05` / `UX-03`） · **状态**：`[x]` 已修复（R4，2026-11-28）
- **证据位置**：
  - [apps/pi-mcp/src/worker.mjs](../../../apps/pi-mcp/src/worker.mjs#L132-L137) 与 [worker.mjs#L185-L194](../../../apps/pi-mcp/src/worker.mjs#L185-L194)
  - [apps/pi-mcp/src/worker.mjs](../../../apps/pi-mcp/src/worker.mjs#L65)（`import(new URL("./utils/paths.js", import.meta.resolve("@earendil-works/pi-coding-agent")))`）
- **根因分析**：
  1. 每次 `tool_execution_end` 都触发未串行化的 `void writeSteps()`，直接 `fs.writeFile(stepLogPath, ...)`，在任务结束 `finally` 块又再次并发 `await writeSteps()`。在 Windows NTFS 上高频连续工具调用极易触发并发写 `EBUSY`（被 `catch` 静默吞掉）、旧快照覆盖新快照，或在读侧恰好读到半截损坏 JSON；
  2. 第 65 行通过相对路径强行读取第三方包 `@earendil-works/pi-coding-agent` 的未导出私有文件 `./utils/paths.js`，未来升级或打包变更目录结构时将直接运行时报错。
- **修复建议**：
  1. 为 `writeSteps` 增加单链路串行合并写（`writing` + `dirty` 标志）与原子落盘（写 `.tmp` 后 `rename`），`finally` 负责等待队列彻底排空；
  2. 将简单的路径归一化（剥离 `@` 前缀、处理 Unicode 空格、`path.resolve(root, p)`）内聚到 `worker.mjs` 自身 10 行工具函数中，消除对 SDK 私有内部路径的脆性耦合。
- **验收标准**：
  - Pi 单元测试模拟 30 次连续并行 `tool_execution_end` + 立即退出，`steps.json` 始终为合法完整 JSON 且包含最后一步；移除对 `./utils/paths.js` 的私有导入后 Pi 全部测试通过。

---

### R2-06 热生效配置把「删除图生图服饰参考图」误划入免停机区

- **优先级**：P1 · **来源**：409 R9b（`UX-01`） · **状态**：`[ ]` 待排查 · **决策关联**：[DL-148](../../161-digital-life-direction-decisions.md#dl-148-配置修改直接删除与运行限制)
- **证据位置**：
  - [apps/backend/src/http/config-writes.ts](../../../apps/backend/src/http/config-writes.ts#L15-L44)（第 39 行 `DELETE /v1/roles/:roleId/scene-image/outfits/:outfitId/reference` 位于 `ROLE_HOT_CONFIG_WRITES`）
  - [apps/backend/src/storage/media/scene-reference.ts](../../../apps/backend/src/storage/media/scene-reference.ts#L45-L73)（删除与覆盖替换时立即 `fs.unlinkSync` 旧文件）
- **根因分析**：
  `config-writes.ts` 将删除语音参考音频、删除服饰/立绘/差分全部留在停机保护的 `ROLE_CONFIG_WRITES` 中，却将删除图生图服饰参考图归入了热生效区，且底层立即物理删除文件。当角色处于活跃态且已有自动/手动 `img2img` 过场图任务排队等待读取该服饰参考图时，热删或热覆盖会导致在途生图任务报错 `SCENE_REFERENCE_MISSING` / `SCENE_REFERENCE_UNAVAILABLE`。
- **修复建议（二选一）**：
  - **方案 A（推荐，与删除语音/外观口径一致）**：将 `DELETE /v1/roles/:roleId/scene-image/outfits/:outfitId/reference` 移回 `ROLE_CONFIG_WRITES`（与其余删除素材接口统一），同时对于 `PUT` 替换旧参考图文件，在存在该角色在途 `scene_image` 任务时延迟清理旧文件（或由任务创建时在 `config_json` 锁定 `assetId` 并加引用保护）；
  - **方案 B**：保持热删，但给 `scene_image_tasks` 锁定参考图 `assetId`，仅在无在途任务引用时物理删盘。
- **验收标准**：
  - 集成测试复现“自动 `img2img` 过场图已入队 + 并发替换/删除服饰参考图”，在途任务稳定完成或删除操作按规范受保护，不出现随机磁盘文件消失报错。

---

### R2-07 `RoleAccess` 连接池缺少坏句柄校验与异常驱逐自愈

- **优先级**：P1 · **来源**：409 R4（`BUG-03`） · **状态**：`[x]` 已修复（R4，2026-11-28）
- **证据位置**：
  - [apps/backend/src/application/role/role-access.ts](../../../apps/backend/src/application/role/role-access.ts#L47-L81)
- **根因分析**：
  `borrow()` 复用缓存的 `PoolEntry` 时只判断 `entries.get(roleId)` 是否存在，不检查 `entry.storage.business.db.open`；且当 `withStore` / `withStoreAsync` 回调因底层 SQLite 句柄损坏或 I/O 异常失败时，池不会立即驱逐该条目，导致损坏句柄在缓存中停留 60 秒并污染后续全部请求。
- **修复建议**：
  1. `borrow()` 命中缓存前校验 `!entry.storage.isClosed && entry.storage.business.db.open`，若已异常关闭则先销毁旧条目再重开；
  2. 在 `withStore` / `withStoreAsync` 捕获到致命 SQLite 驱动错误（`SQLITE_IOERR`、`SQLITE_CORRUPT`、`SQLITE_NOTADB` 或 `database connection is not open`）时，释放租约后主动触发 `evict(roleId)` 清理脏条目。
- **验收标准**：
  - 单测模拟缓存句柄被外部强制关闭或抛出 `SQLITE_IOERR` 后，下一次 `withStore` 自动重建有效连接而非持续失败 60 秒。

---

## 二、底层核心模块隐患与剩余架构/交付债务（`R2-08`～`R2-13`）

### R2-08 模型流式生成请求完全缺少首包超时与流空闲超时

- **优先级**：P0 · **来源**：底层核心 · **状态**：`[x]` 已修复（R2，2026-11-28）
- **证据位置**：
  - [apps/backend/src/model/protocols.ts](../../../apps/backend/src/model/protocols.ts#L139-L164)（`streamOpenAiChat` 未传 `timeoutMs` 且 `rawResponse.push(data)` 无上限）
  - [apps/backend/src/model/protocols.ts](../../../apps/backend/src/model/protocols.ts#L275-L290)（`streamOpenAiResponses` 未传 `timeoutMs`）
  - [apps/backend/src/model/protocols.ts](../../../apps/backend/src/model/protocols.ts#L472-L490)（`streamAnthropic` 未传 `timeoutMs`）
  - [apps/backend/src/model/google-gemini.ts](../../../apps/backend/src/model/google-gemini.ts#L278-L295)（`streamGoogleGemini` 未传 `timeoutMs`）
  - [apps/backend/src/model/protocols.ts](../../../apps/backend/src/model/protocols.ts#L728-L753) 与 [protocols.ts#L1246-L1290](../../../apps/backend/src/model/protocols.ts#L1246-L1290)（`readSse` 中 `reader.read()` 无 chunk 空闲超时）
- **根因分析**：
  `listModels` 设置了 `timeoutMs: 20_000`，但全部四条流式生成路径在建立连接与读取 SSE 分片期间**没有任何超时保护**。离线本地假服务器永远即时返回，因此现有 672 项测试无法暴露该问题；但在真实公网/代理调用中，TCP 半开、厂商网关假死不吐字不关连接极为常见，一旦发生即永久卡死整个角色的串行调度队列。此外每条流式协议都把全部原始分片塞进 `rawResponse` 数组，超长推理/输出时徒增内存占用。
- **修复建议**：
  1. 为全部四条流式生成链路增加可配置的两段超时：
     - **首包响应头超时**（如默认 60s～90s，兼容慢思考模型首字前排队）；
     - **流式分片空闲超时（idle chunk timeout）**（如默认 60s～90s，每收到任意字节/心跳注释重置计时器；超时主动 `abort` 并映射为 `ModelRequestTimeoutError`）；
  2. 限制 `rawResponse` 仅保留首尾摘要或受控上限（如仅在调试开关开启或总量 ≤256 KiB 时保留），避免长流式回复造成无界内存驻留。
- **验收标准**：
  - 新增模拟测试：本地假端点接受 TCP 后永不发响应头、以及发完 2 个 SSE 分片后挂死不发 `[DONE]`，均在预期超时阈值内抛出 `ModelRequestTimeoutError` 并释放角色执行槽位（不锁死后续消息）。

---

### R2-09 Google 服务账号凭据 token 地址允许任意明文 HTTP 触发 SSRF

- **优先级**：P1 · **来源**：底层核心 · **状态**：`[x]` 已修复（R2，2026-11-28）
- **证据位置**：
  - [apps/backend/src/model/google-gemini.ts](../../../apps/backend/src/model/google-gemini.ts#L763-L790)（第 781 行放行 `http:` 且不校验主机名）
  - [apps/backend/src/model/google-gemini.ts](../../../apps/backend/src/model/google-gemini.ts#L814-L825)（直接向 `account.tokenUri` POST 签名后的 JWT）
- **根因分析**：
  `parseServiceAccountCredential` 从用户输入的凭据 JSON 中读取 `token_uri`，同时允许 `https:` 与明文 `http:`，且没有任何域名限制。若用户误导入被篡改的第三方 JSON，后端会直接把签名后的 OAuth2 JWT 发往恶意外部地址或探测本机内网服务。
- **修复建议**：
  1. 生产默认仅允许 `https:` 且主机名属于受信任 Google OAuth 白名单（如 `oauth2.googleapis.com`、`accounts.google.com`）；
  2. 离线单测如需本地模拟 OAuth 端点，通过显式测试注入选项（如 `allowCustomTokenUriForTest` / 自定义 `transport`）实现，不在生产解析逻辑中放行任意 `http:` 地址。
- **验收标准**：
  - 单测验证 `token_uri` 为 `http://127.0.0.1:8080/token` 或 `https://evil.example/token` 时在签发前即被拒绝并返回 `invalid_api_key`；合法 `https://oauth2.googleapis.com/token` 正常签发。

---

### R2-10 未配置生图服务时，手动点击过场图仍静默生成假占位图落盘

- **优先级**：P1 · **来源**：底层核心 · **状态**：`[ ]` 待排查 · **决策关联**：[DL-142](../../161-digital-life-direction-decisions.md) · [DL-150](../../161-digital-life-direction-decisions.md#dl-150-生图首版适配-comfyui先测-moss-image)
- **证据位置**：
  - [apps/backend/src/scene/comfyui-generator.ts](../../../apps/backend/src/scene/comfyui-generator.ts#L182-L185)（注释明写「正式版应改为未配置即失败」）
  - [apps/backend/src/scene/comfyui-generator.ts](../../../apps/backend/src/scene/comfyui-generator.ts#L216-L220)（`runtime === null` 时直接调用 `this.options.fallback.generate(input)`）
  - [apps/backend/src/bootstrap/app.ts](../../../apps/backend/src/bootstrap/app.ts#L47-L48)（默认装配 `FakeSceneImageGenerator` 作为回退）
- **根因分析**：
  早期原型阶段为了离线演示保留了 `FakeSceneImageGenerator` 回退。但在正式桌面应用中，未配置生图服务的普通用户若误点对话末尾的「生成过场图」，系统不会提示去配置生图服务，而是静默生成一张假占位 PNG 永久存入真实角色业务库与磁盘。
- **修复建议**：
  1. 确认产品策略：正式运行时未配置生图服务应返回明确可操作错误（如 `409 SCENE_IMAGE_NOT_CONFIGURED` / 提示前往「角色配置 → 模型 → 生图」），仅在测试进程通过显式选项（`options.sceneImageGenerator`）注入假生成器；
  2. 前端未配置生图服务时在过场图按钮提示或弹窗中给出直达生图配置的入口。
- **验收标准**：
  - 正常启动后端且未配生图服务时，手动触发过场图返回明确未配置提示且不产生假 PNG 落盘；离线自动化测试继续通过显式注入覆盖过场图链路。

---

### R2-11 仓储层与核心执行层仍残存 11 个千行至近三千行巨石文件

- **优先级**：P1 · **来源**：架构遗留（409 `ARCH-01` 二期深化） · **状态**：`[ ]` 待排查
- **证据位置（2026-11-28 最新实测行数）**：
  - 后端存储层：[memory-store.ts](../../../apps/backend/src/storage/memory/memory-store.ts)（2776 行）、[conversation-store.ts](../../../apps/backend/src/storage/conversation/conversation-store.ts)（2497 行）、[schema.ts](../../../apps/backend/src/storage/core/schema.ts)（2373 行，`app` V17 / `business` V32）、[role-store.ts](../../../apps/backend/src/storage/role/role-store.ts)（2207 行）、[autonomy-store.ts](../../../apps/backend/src/storage/conversation/autonomy-store.ts)（1261 行）
  - 后端业务/协议层：[agent-tools.ts](../../../apps/backend/src/application/conversation/agent-tools.ts)（1820 行）、[voice-service.ts](../../../apps/backend/src/application/media/voice-service.ts)（1642 行）、[agent-graph.ts](../../../apps/backend/src/application/conversation/agent-graph.ts)（1386 行）、[protocols.ts](../../../apps/backend/src/model/protocols.ts)（1293 行）、[conversation-execution-runner.ts](../../../apps/backend/src/application/conversation/conversation-execution-runner.ts)（1266 行，R12 新拆分产物仍超 1200 行）、[admin-tools.ts](../../../apps/backend/src/application/role/admin-tools.ts)（1231 行）、[routes.ts](../../../apps/backend/src/http/routes.ts)（1229 行）
  - 桌面渲染层：[VoicePanel.tsx](../../../apps/desktop/renderer/src/components/voice/VoicePanel.tsx)（1102 行）、[use-window-session.ts](../../../apps/desktop/renderer/src/conversation/use-window-session.ts)（1099 行）
- **根因分析**：
  409 R12 仅消除了 `check-repo-hygiene.mjs` 的两个 >100 KB 告警文件，底层 5 个超长 SQLite 仓储文件与 32 个版本挤在一起的 `schema.ts` 尚未拆解，新增业务仍在往大文件尾部叠加（如 V32 向量缓存、R13 管理员工具、R14 混合检索查询）。
- **修复建议**：
  1. 优先拆分 `schema.ts`：拆为 `schema-app.ts`（含分段迁移）、`schema-business-base.ts`、`schema-business-migrations.ts`、`schema-verify.ts`；
  2. 按子域拆解 `memory-store.ts`（事件/证据、日摘要/日记、检索索引与向量缓存三块）与 `protocols.ts`（拆出 `openai-chat.ts`、`openai-responses.ts`、`anthropic.ts`、`sse-reader.ts`）；
  3. 拆解 `use-window-session.ts`（分离 SSE 订阅/重连、快照合并、历史翻页与提交草稿状态）。
- **验收标准**：
  - 拆解目标文件单文件均降至 800 行以内，纯结构重构不改外部契约，全量门禁零退化。

---

### R2-12 离线验证与真实交付“最后一公里”仍未闭环

- **优先级**：P1 · **来源**：409 `DELIV-01` 遗留 + `DELIV-02` 未启动 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [docs/STATUS.md](../../STATUS.md#L7)（23/24 离线闭环，真实服务与干净机便携 EXE 仍待办）
  - [docs/STATUS.md](../../STATUS.md#L37)（脱仓冷启首个 `/v1/health` 实测 `4267 ms`，未达到原 `<2s` 目标）
  - [docs/archive/07-documentation/409-project-audit-and-remediation-backlog.md](./409-project-audit-and-remediation-backlog.md#deliv-02-真实云端模型多模态与媒体服务全链路联调长期缺位)
- **根因分析**：
  目前 672 项后端测试、29 项 Electron E2E 全为 `realServiceCalls=0`。本轮新增的 R14 混合检索 Embedding、R13 主角色热自改、R11 图形迁移、R8b 同源 SSE 代理以及 DPAPI 主密钥迁移，均尚未在真实云端模型 + 真实 ComfyUI + 真实 TTS + 干净无 Node 的 Windows 机器便携 EXE 上跑过端到端联调。
- **修复建议**：
  1. **定位 4.27s 冷启动瓶颈**：对打包态后端启动做分阶段打点（Node 进程拉起 → 模块加载 → `better-sqlite3` 打开与迁移 → `ensurePresetAssistant` → `extensions.restore`），把非关键预热推迟到 `listening` 之后，将冷启压进 `<2s`；
  2. **完成干净 Windows 虚拟机便携 EXE 冒烟**：覆盖首次安装、DPAPI 密钥创建、托盘退出零残留、重开恢复与热扩展发布；
  3. **执行发版前真实服务联调矩阵**（建议在 `R2-02`、`R2-08` 修完后立即执行）：覆盖 OpenAI / Anthropic / Gemini（Vertex）真实流式与工具续轮、真实 Embedding 混合召回与账本、真实 ComfyUI 并发/取消清队列、真实 TTS 长句推进并归档实测报告。
- **验收标准**：
  - 形成干净 Windows 机便携 EXE 实机验收记录与真实服务联调留证，冷启动耗时有明确实测优化数据。

---

### R2-13 409 文档状态残留与并发 E2E 像素帧抖动

- **优先级**：P2 · **来源**：文档与测试一致性 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [docs/archive/07-documentation/409-project-audit-and-remediation-backlog.md](./409-project-audit-and-remediation-backlog.md#L116)（顶层总表已标 `BUG-03` 已修复，正文第 116 行仍残留 `[ ] 待排查`）
  - [docs/STATUS.md](../../STATUS.md#L1)（标题日期仍为 `2026-11-27`，正文已是 `2026-11-28`）
  - [docs/STATUS.md](../../STATUS.md#L7)（3 并发 Electron E2E 仍报 `settings-media-sheet` 像素帧抖动 28/29）
- **根因分析**：
  多轮快速推进后出现少量文档状态字段未同步；同时 `settings-media-sheet` 在高负载并发渲染下采样帧存在时序竞态，仅靠串行复跑通过掩盖了真实测试脆弱性。
- **修复建议**：
  1. 同步修正 `409` 第 116 行状态与 `STATUS.md` 顶部标题日期；
  2. 排查 `settings-media-sheet.e2e.cjs` 的立绘像素断言等待条件，改为等待图片解码与过渡动画落定事件，消除 3 并发下的偶发抖动。
- **验收标准**：
  - `node scripts/verify.mjs e2e` 默认 3 并发连续跑通 29/29（零偶发像素抖动）；文档状态与日期完全一致。

---

## 三、审查与修订记录

### 第 1 轮成稿校验（2026-11-28）
- 对照 `HEAD (11b624d)` 逐项复核 13 条问题的源码文件路径、精确行号范围、函数行为与跨文档 `DL-xx` 锚点；
- 运行 `node scripts/check-docs.mjs`、`node scripts/check-repo-hygiene.mjs` 及全篇内部/外部锚点与行号区间脚本，确保 0 断链、0 警告、0 越界行号。

### 第 2 轮实施与复验记录（2026-11-28）

#### R1：`R2-01`（桌面代理取消结算、流式背压与请求体流式转发）+ `R2-03`（运行态角色迁移防阻塞、体积上限与路径/代理收紧）
- **桌面代理（`R2-01` + `R2-03`）**：
  - 将代理逻辑独立至 `apps/desktop/electron/backend-proxy.cjs`（同步加入 `apps/desktop/package.json` `build.files` 打包清单），`main.cjs` 保留 `maxSockets: 64` 独立 HTTP/HTTPS 连接池并透传 `request.signal`；
  - 预中止与响应头前中止经统一 `fail(err)` 稳定结算并向 `upstreamReq.destroy(err)` 传入明确 `AbortError`，消除无参 `destroy()` 不触发 `error` 导致的永久挂起 Promise；`main.cjs` 对主动中止不再伪装成 503 `BACKEND_OFFLINE`；
  - 响应 `ReadableStream` 增加背压控制：`(controller.desiredSize ?? 0) <= 0` 时调用 `upstreamRes.pause()`，`pull()` 时 `upstreamRes.resume()`；
  - 非 GET/HEAD 带 Web `ReadableStream` 请求体改为 `Readable.fromWeb(request.body).pipe(upstreamReq)` 流式转发，消除主进程整包 `arrayBuffer()` + `Buffer.from()` 双份缓冲；
  - `isBlockedProxyPath` 在 `desk://bundle/v1/*` 中显式拦截 `/v1/roles/*/workspace/path`（返回 404），仅 Electron 主进程 `desk:open-role-workspace` IPC 内部访问。
- **后端迁移（`R2-03`）**：
  - `role-transfer-package.ts` 彻底移除 `Atomics.wait` 同步睡眠阻塞，缺失/目录/符号链接直接快速失败，读取前校验 `stat.size <= MAX_ROLE_TRANSFER_PACKAGE_BYTES`（256 MiB，超限抛 `ROLE_TRANSFER_PACKAGE_TOO_LARGE`），并新增非阻塞 `readRoleTransferPackageAsync` 供运行态 `RoleTransferHttpService` 使用（映射为 `413`）；
  - `role-transfer.ts` 收紧 `assertPackageFileOutsideManagedDirs`：禁止导出/预检/导入包落入整个 `appRoot` 或 `dataRoot`（Windows 大小写不敏感比对），并强制要求 `.json` 扩展名（`400 ROLE_TRANSFER_PACKAGE_EXTENSION_INVALID`）。
- **精准离线复验（仓库 Node `v24.22.2`）**：
  - 后端 `tsc --noEmit` 0 错误；`role-transfer-package` + `role-transfer` + `workspace-and-transfer-http` **22/22** 全通过（含 256 MiB 超限 413、缺失文件 `<50ms` 快速失败、目录拒绝、`appRoot`/`data`/`secrets`/`extensions` 与非 `.json` 拦截）；
  - 桌面壳全量单测 **38/38** 全通过（含新增 `backend-proxy.test.cjs` 5/5：预中止 `<50ms`、响应头前中止 `<100ms`、SSE 中途取消关闭上游、4 MiB 慢消费背压、分片流式上传防整包缓冲，`preload-boundary` 4/4 与脱仓生产包冒烟）；
  - Electron 39 实窗 E2E `extension-ui-slots.e2e.cjs` 通过。

#### R2：`R2-08`（四协议流式首包/空闲超时与有界 `rawResponse`）+ `R2-09`（Google 服务账号 `token_uri` SSRF 白名单）
- **流式超时与内存收敛（`R2-08`）**：
  - `apps/backend/src/model/protocols.ts` 新增并导出 `DEFAULT_STREAM_HEADER_TIMEOUT_MS = 90_000`、`DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000`、`DEFAULT_MAX_RAW_RESPONSE_BYTES = 256 * 1024` 与 `RawResponseCollector`；
  - 重构 `HttpModelAdapter.request()`：采用独立 `AbortController` + `.unref()` 计时器并在 `fetch()` 解析响应头后的 `finally` 中立即 `clearTimeout`，确保首包超时在响应头抵达后彻底解除，不误杀长时间正常吐字的流式回复；`listGoogleModels` 仍严格使用短列表超时 `listTimeoutMs`；
  - `readSse()` 为每次 `reader.read()` 增加空闲超时竞态，超时先置标记并拒绝 `Promise.race` 再 `reader.cancel()` 关闭底层 TCP 连接（修复 `reader.cancel()` 先把 pending read 结算为 `done: true` 导致误报 `STREAM_TRUNCATED` 的微任务竞态），原样抛出 `ModelRequestTimeoutError`；
  - `streamOpenAiChat`、`streamOpenAiResponses`、`streamAnthropic`、`streamGoogleGemini` 全部接入首包超时、空闲超时与 `RawResponseCollector`（超限后停止堆积并追加 `{ _truncated: true, maxBytes }`，正文流不截断）。
- **Google 服务账号 OAuth SSRF 防护（`R2-09`）**：
  - `apps/backend/src/model/google-gemini.ts` 将 `parseServiceAccountCredential` 默认收紧为仅允许 `https:`、默认端口且主机名在 `TRUSTED_GOOGLE_OAUTH_HOSTS`（`oauth2.googleapis.com`、`accounts.google.com`）内，同时拒绝含内嵌凭据的 URL；离线测试通过显式 `HttpModelAdapterOptions.allowCustomGoogleTokenUri: true` 注入回环 mock OAuth 端点。
- **精准离线复验（仓库 Node `v24.22.2`）**：
  - 后端 `tsc --noEmit` 0 错误；
  - `model-protocols` + `google-gemini` + `model-continuation` + `model-providers` **43/43** 全通过（覆盖四协议首包挂死超时、流中途挂死超时关连接、长流超过 headerTimeout 正常完成、1024 B 有界 `rawResponse` 截断、及 4 类恶意 `token_uri` 零出站拦截）。

#### R3：`R2-02`（混合检索 Embedding 禁重定向、跨协议校验、维护守卫与账本、有界增量回填）
- **出站安全与协议校验**：
  - `apps/backend/src/application/memory/memory-hybrid-search.ts` 新增 `MAX_EMBEDDING_RESPONSE_BYTES`（16 MiB）、`isEmbeddingCompatibleProtocol`（仅 `openai-chat` / `openai-responses`）与 `validateEmbeddingBaseUrl`（仅 `http/https` 且禁内嵌凭据）；`HttpOpenAiEmbeddingPort` 强制 `redirect: "manual"` 拦截 3xx（`EMBEDDING_REDIRECT_BLOCKED`）、通过 `content-length` 与流式字节计数在 `JSON.parse` 前拒绝超限响应（`EMBEDDING_RESPONSE_TOO_LARGE`），并解析 `usage`；
  - `apps/backend/src/application/memory/memory-embedding-settings.ts` 拒绝保存非 OpenAI 兼容协议或非法地址；新增 `testConnection` 及 `POST /v1/memory/embedding-settings/test` 探测接口（安全脱敏错误映射）。
- **维护窗口、Token 账本与增量回填**：
  - `MemoryEmbeddingSettingsService` 接入 `ResourceService.claimModelCall()` / `isUnderMaintenance()`（维护期零出站请求静默回退 FTS5）与 `TokenUsageService` 记账（检索归 `memory`、连接测试归 `connection_test`，遵循 `DL-183`）；
  - `MemoryQueryService.searchHybrid` 限制在线补算为默认最多 2 批 / 3 秒总预算，**每批完成后立即增量落盘 `memory_search_embeddings`**，不因后续批次失败丢失已算向量；其余未向量化文档交给按 `roleId` 去重的实例级后台低优先级队列逐步回填，并在 `app.close()` 中于 `roleAccess.closeAll()` 前先收尾。
- **桌面端适配**：
  - `apps/desktop/renderer/src/components/config/memory-embedding.ts`、`MemoryEmbeddingGroup.tsx` 与 `Settings.tsx` 过滤仅展示 OpenAI 兼容模型服务，并新增「测试连接」按钮与即时维度反馈（完全复用设计系统组件与令牌）。
- **精准离线复验（仓库 Node `v24.22.2`）**：
  - 后端 `tsc --noEmit` 0 错误；`memory-hybrid-search` **11/11** 全通过（覆盖 302 拦截、声明与流式超限拒绝、跨协议 400、测试连接与混合检索用量入账、维护期零请求回退、中途失败前序向量持久化、200 条文档有界在线 + 后台补全与优雅关闭）；
  - 渲染器 `npm run check`（38 CSS 0 违规）+ `memory-embedding-settings` **7/7** + Vite 生产构建全通过。

#### R4：`R2-04`（工作空间笔记扫描跳过依赖目录与上限）+ `R2-05`（Pi 步骤日志原子串行落盘与去私有路径）+ `R2-07`（`RoleAccess` 连接池坏句柄自愈）
- **工作空间扫描保护（`R2-04`）**：
  - `apps/backend/src/application/role/role-workspace-service.ts` 跳过 `node_modules`、`__pycache__`、`dist`、`build`、`target`、`.git`、`.venv`、`venv`（大小写不敏感），增加 `MAX_VISITED_ENTRIES = 5000` 遍历上限与 `listNotesWithMeta()` 返回 `{ items, truncated }`；
  - `role-transfer-workspace-routes.ts` 透出 `truncated`，`WorkspaceNotesPanel.tsx` 复用 `.workspace-notes-notice` 在截断时展示轻提示（零新增样式）。
- **Pi 步骤日志与去私有 SDK 依赖（`R2-05`）**：
  - `apps/pi-mcp/src/worker-helpers.mjs` 内聚 `normalizeWorkspacePath`（剥离 `@`、兼容 `file://` URL 与 Unicode 空格归一化）及 `createStepWriter`（`writing`/`dirty` 串行合并写 + 唯一 `.tmp` 临时文件 `rename` 原子落盘 + `finally` `flush()` 收尾）；`worker.mjs` 彻底移除对 `@earendil-works/pi-coding-agent` `./utils/paths.js` 的私有导入。
- **连接池自愈（`R2-07`）**：
  - `apps/backend/src/storage/core/role-storage.ts` 新增 `isClosed` 与 `isHealthy`（同时检查 `business.db.open` 与已打开的 `checkpointStore.db.open`）；
  - `apps/backend/src/application/role/role-access.ts` 在 `borrow()` 命中异常关闭句柄时立即替换重开，在 `withStore`/`withStoreAsync` 捕获 `SQLITE_IOERR`/`SQLITE_CORRUPT`/`SQLITE_NOTADB`/`database connection is not open` 等致命错误后释放租约并立即 `evict(roleId)`。
- **精准离线复验（仓库 Node `v24.22.2`）**：
  - 后端 `tsc --noEmit` 0 错误；`role-access` + `workspace-and-transfer-http` **11/11** 全通过；
  - Pi 子包全量串行测试 **14/14** 全通过（含新增 `worker-helpers` 3/3 与真实 Pi SDK 进程回收 `survivors=0`）；
  - 渲染器 `npm run check`（38 CSS 0 违规）+ Vite 生产构建全通过。
