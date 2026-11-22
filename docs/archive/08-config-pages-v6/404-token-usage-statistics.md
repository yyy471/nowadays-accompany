# 全局 Token 消耗统计（DL-183）实施与复核记录

> **状态**：实施、离线自验与两轮复核补修已完成（**真实上游模型服务联调仍待进行**）  
> **维护约定**：后续针对 `DL-183` 的独立复核意见、缺陷修复与复验结果均按小节追加于本文档，不另开新编号文档。  
> **上游决策与现行规范**：[161 DL-183](../../161-digital-life-direction-decisions.md#dl-183-全局设置页提供持久-token-消耗统计) · [存储、记忆与自主执行规范](../../specs/storage-memory-and-autonomy.md) · [角色配置、全局资源与活动守卫规范](../../specs/role-config-and-activity.md) · [前端设计规范](../../specs/frontend-design-system.md) · [当前状态看板](../../STATUS.md)

---

## 1. 已确认需求与设计边界（DL-183）

1. **存储与删除留存**：在全局索引库 `app.sqlite`（升级至 `APP_SCHEMA_VERSION = 12`）新增 `token_usage_records` 与 `token_usage_meta` 持久台账。删除角色（含 `keepHistory=false`）或删除全局模型服务后，历史消耗记录与显示名称快照保持保留（查询与界面标注 `deleted: true` / `已删除`）。
2. **统计范围与 7 类细分**：仅统计语言模型（LLM）调用，不计本地 TTS 与 ComfyUI 生图。按独立发起的模型请求拆分为 7 类：`dialogue`（对话回复）、`autonomy`（自主生活）、`memory`（记忆整理）、`annotation`（表情与情绪标注）、`scene_plan`（过场图规划）、`anchor_prompt`（生图锚点提炼）与 `connection_test`（连接测试）。
3. **口径与缺失处理**：按本机自然日统计，支持 `today` / `7d` / `30d` / `all`；完整保存并汇总 `inputTokens`、`cachedTokens`、`cacheCreationTokens`、`outputTokens`、`totalTokens`、`cacheHitRate`、`callCount`、`reportedCallCount`、`missingUsageCount` 与 `failedCallCount`。上游未回报 `usage` 的调用单独计入 `missingUsageCount`，不混为 `0` 计入 Token。
4. **一次性回填与单角色迁移隔离**：应用升级启动时对存活本地角色执行一次性幂等回填（读取角色 `business.sqlite` 中的 `model_calls` 与 `app.sqlite` 中的 `model_test_calls`）；导入单角色迁移包不把外部历史叠入本机账单，且保持 `BUSINESS_SCHEMA_VERSION = 27` 不破坏单角色迁移时间线指纹。
5. **只读设置页入口**：全局设置新增「用量」宽版分区（`settingsSection === 'usage'`），按 `GET /v1/usage/tokens` 只读展示总览、每日趋势与用途/角色/模型三向筛选和下钻，首版不提供手动清零或重置按钮。
6. **大数防溢出与自适应单位**：单次调用数值钳位在 SQLite 有符号 64 位上限 `MAX_SQLITE_INT64`；查询聚合禁止使用 SQL `SUM()`，统一启用 `stmt.safeIntegers(true)` 后在服务端用 `BigInt` 精确累加；HTTP 接口以十进制整数字符串输出；前端全程使用 `BigInt` 换算并自适应展示精确整数、`K`、`M`、`B`、`T`（悬停提示千分位精确数值）。

---

## 2. 改动清单

| 分层 | 文件 | 核心变更 |
| --- | --- | --- |
| 后端领域 / 存储 / 服务 | [token-usage.ts](../../../apps/backend/src/domain/token-usage.ts) · [token-usage-store.ts](../../../apps/backend/src/storage/token-usage-store.ts) · [token-usage-service.ts](../../../apps/backend/src/application/token-usage-service.ts) · [schema.ts](../../../apps/backend/src/storage/schema.ts) | 定义 7 类枚举与 `BigInt` 钳位/解析、`APP_SCHEMA_VERSION = 12` 表结构与 `V11 -> V12` 迁移、`safeIntegers(true)` + `BigInt` 聚合查询、一次性幂等回填、单次记账与筛选视图 |
| 后端采集接入与路由 | [memory.ts](../../../apps/backend/src/domain/memory.ts) · [memory-runtime.ts](../../../apps/backend/src/application/memory-runtime.ts) · [memory-service.ts](../../../apps/backend/src/application/memory-service.ts) · [agent-graph.ts](../../../apps/backend/src/application/agent-graph.ts) · [conversation-service.ts](../../../apps/backend/src/application/conversation-service.ts) · [segment-annotation-service.ts](../../../apps/backend/src/application/segment-annotation-service.ts) · [model-planner.ts](../../../apps/backend/src/scene/model-planner.ts) · [scene-image-settings.ts](../../../apps/backend/src/application/scene-image-settings.ts) · [model-service.ts](../../../apps/backend/src/application/model-service.ts) · [app.ts](../../../apps/backend/src/bootstrap/app.ts) · [routes.ts](../../../apps/backend/src/http/routes.ts) | 补齐记忆模型 `usage` 与 `resourceId` 采集并保留 4 字段缓存用量；7 类调用经 `onModelCallFinished` 写入全局账本；启动执行 `backfillOnce()`；暴露 `GET /v1/usage/tokens` |
| 后端测试 | [p26-token-usage.test.ts](../../../apps/backend/tests/p26-token-usage.test.ts) · [p1-02-storage.test.ts](../../../apps/backend/tests/p1-02-storage.test.ts) · [p12-role-settings.test.ts](../../../apps/backend/tests/p12-role-settings.test.ts) · [p19-preset-assistant-pack1.test.ts](../../../apps/backend/tests/p19-preset-assistant-pack1.test.ts) · [p2-04-google-gemini.test.ts](../../../apps/backend/tests/p2-04-google-gemini.test.ts) | 新增 7 类全链路记账、超 53 位／近 64 位防溢出、回填幂等、单角色迁移隔离与删除后晚到结算留存测试，并同步既有 V12 Schema 断言 |
| 桌面端展示与样式 | [token-usage.js](../../../apps/desktop/renderer/src/token-usage.js) · [token-usage.d.ts](../../../apps/desktop/renderer/src/token-usage.d.ts) · [TokenUsageSection.tsx](../../../apps/desktop/renderer/src/components/config/TokenUsageSection.tsx) · [token-usage.css](../../../apps/desktop/renderer/src/styles/token-usage.css) · [Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx) · [main.tsx](../../../apps/desktop/renderer/src/main.tsx) | 纯 `BigInt` 单位格式化与查询构造；全局设置「用量」只读分区（时间切换、角色/用途/模型筛选、每日趋势、三向分项、零手动清零入口、宽版过渡优化） |
| 桌面端单测与 E2E | [token-usage.test.cjs](../../../apps/desktop/tests/unit/token-usage.test.cjs) · [token-usage-check.cjs](../../../apps/desktop/tests/e2e/token-usage.e2e.cjs) | `BigInt` 单位与查询边界单测；真实后端 + 离线 OpenAI HTTP 桩 + 真实 Electron 渲染器 E2E 验证 |

---

## 3. 实现方离线自验记录（2026-11-21）

> **边界声明**：以下验证均使用确定性离线模型桩或本机模拟 OpenAI HTTP 端点执行（`realServiceCalls=0`），**尚未经过独立复核，也未在真实上游厂商端点上实测 `usage` 与缓存字段返回**。

- **后端类型检查与全量单测（Node 24）**：
  - `cd apps/backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit`：通过（退出码 `0`）。
  - `cd apps/backend && npx -y node@24 --import tsx --test tests/*.test.ts`：**548 / 548** 通过（0 失败，0 跳过；含 [p26-token-usage.test.ts](../../../apps/backend/tests/p26-token-usage.test.ts) 与全部存储、迁移、记忆、对话、语音、生图测试）。
- **后端 21 步离线整体验收（Node 24）**：
  - `cd apps/backend && npx -y node@24 scripts/accept-offline.mjs`：**21 / 21 步**通过（`delivery-tests` 2/2、`tests` 548/548、`realServiceCalls: 0`、`sourceUnchanged: true`；验收报告：`apps/backend/test-results/p5-2026-11-21T06-46-17-194Z-d3b7c196/summary.json`）。
- **桌面端检查、构建与单测（Node 24）**：
  - `cd apps/desktop/renderer && npm run check && npm run build`：`tokens:check` 最新、`lint:styles` 检查 28 个 CSS 文件违规 **0**（豁免命中 387，[token-usage.css](../../../apps/desktop/renderer/src/styles/token-usage.css) 无新增豁免）、`tsc --noEmit` 与 `vite build`（160 模块）通过。
  - `cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs`：**164 / 164** 通过（0 失败，0 跳过；含 [token-usage.test.cjs](../../../apps/desktop/tests/unit/token-usage.test.cjs)）。
- **Electron 端到端回归（真实后端 + 离线模型／媒体桩）**：
  - [token-usage-check.cjs](../../../apps/desktop/tests/e2e/token-usage.e2e.cjs)：退出码 `0`（通过本地 OpenAI 桩记录连接测试、首次自主与对话共 3 次调用、总计 `4,500`，删除角色后保留账单并标 `已删除`，确认界面无清零按钮，核验 `今日`/`全部` 切换、`connection_test` 筛选与清除，并在 `白昼来信`/`晚风电台` × `1280×800`/`900×720` 下均实现 `bookOverflow: 0`、`leafOverflow: 0`、`errors: []`）。
  - [settings-v6-behavior-check.cjs](../../../apps/desktop/tests/e2e/settings-v6-behavior.e2e.cjs)、[settings-workspace-check.cjs](../../../apps/desktop/tests/e2e/settings-workspace.e2e.cjs)、[workflow-real-backend-chain-check.cjs](../../../apps/desktop/tests/e2e/workflow-real-backend-chain.e2e.cjs)：均退出 `0` 通过，新增第 6 个「用量」页签未引入回归。
- **文档巡检**：`node scripts/check-docs.mjs` 通过（错误 0，警告 0）。

---

## 4. 独立复核检查清单（首轮已核查，真实上游项待联调）

1. **7 类归属与不漏记／不重记**：逐一核查对话回复（含中断、失败与多批工具续轮）、自主活动、记忆整理（`HttpMemoryModel` 与 `MemoryService`）、句段表情／语音标注（含 4 字段缓存合并）、过场图规划、生图锚点提炼与连接测试的成功、失败和未回报 `usage` 路径。
2. **大整数全链路防溢出**：验证 SQLite `token_usage_records` 写入超大值（超过 `Number.MAX_SAFE_INTEGER`、接近 `MAX_SQLITE_INT64`）与多行累加后，`safeIntegers(true)` + `BigInt` 聚合、十进制字符串接口、及前端 `formatTokenCount` / `formatExactTokenCount` / `sharePercent` 无 `Number` 精度丢失或溢出。
3. **历史回填与单角色迁移隔离**：核对 `token_usage_meta` 幂等标记（重复启动不重复记账）、角色删除与模型服务删除后的快照展示（`deleted: true`）、以及单角色迁移导入不会把迁移包携带的历史消费叠入本机全局账本且不改变既有时间线指纹。
4. **只读设置页与交互规范**：核对全局设置「用量」分区无手动清零入口、`today/7d/30d/all` 本机自然日边界、并发切换筛选时的竞态丢弃（`AbortController` + 请求序号），以及窄窗口 / `daylight` & `nightwave` / 减少动效下的样式令牌合规与可读性。
5. **真实上游边界（需在具备真实密钥时单列联调）**：核对 OpenAI Chat / Responses、Anthropic Messages、Google AI Studio / Vertex 等真实厂商响应中的 `usage`、`cachedTokens`、`cacheCreationTokens` 在流式与非流式工具续轮下的一致性。

---

## 5. 独立复核与补修记录

### 5.1 首轮独立复核（2026-11-21）：删除后晚到结算被丢弃（已修复）

- **问题**：`TokenUsageService.recordCall()` 通过 `resolveResourceInfo()` 读取模型服务名称与厂商快照，而 `AppStore.getResource()` 在服务已删除时抛出 `ResourceNotFoundError`。`recordCall()` 外层的记账异常隔离会吞掉该异常，导致整条消耗记录被静默丢弃。若一次模型调用在角色或模型服务删除之后才完成结算（删除与在途调用并发），该次调用不会进入账本，与 DL-183「删除角色／模型服务后历史消耗继续保留」及「不漏记」冲突。
- **修复**：`resolveResourceInfo()` 将「服务不存在」收敛为 `null`，记账继续使用调用方传入的 `resourceName` / `provider`；角色名称解析原本已有索引回退，无需改动。实现见 [token-usage-service.ts](../../../apps/backend/src/application/token-usage-service.ts)。
- **回归测试**：在 [p26-token-usage.test.ts](../../../apps/backend/tests/p26-token-usage.test.ts) 新增「调用结束时角色或模型服务已被删除，账本仍保留该次调用」，断言 `callCount = 1`、`totalTokens = 150`，且角色分项与模型分项均 `deleted: true`、模型分项回退显示「已删除服务」。
- **复验（2026-11-21）**：`cd apps/backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit` 通过；`npx -y node@24 --import tsx --test tests/*.test.ts` **549 / 549** 通过（0 失败，0 跳过）；`p26` **4 / 4** 通过；`npx -y node@24 scripts/accept-offline.mjs` **21 / 21 步**通过（`tests` 549／549、`realServiceCalls: 0`、`sourceUnchanged: true`，报告：`apps/backend/test-results/p5-2026-11-21T12-13-56-290Z-e7a713bf/summary.json`）。桌面端本轮未改动，先前的 164／164 单测与 `token-usage-check.cjs` E2E（`bookOverflow: 0`、`leafOverflow: 0`、`errors: []`）结果继续有效。
- **仍待**：§4.5 的真实上游 `usage`／缓存字段联调（OpenAI Chat／Responses、Anthropic Messages、Google AI Studio／Vertex）。

### 5.2 二次复核与补修（2026-11-21，已修复）

- **问题与补修**：
  1. **角色库写失败隔离与防二次误报**：[agent-graph.ts](../../../apps/backend/src/application/agent-graph.ts) 与 [memory-service.ts](../../../apps/backend/src/application/memory-service.ts) 先前均把全局 `onModelCallFinished` 放在角色库 `finishModelCall` / `UPDATE model_calls` 之后并共处同一异常分支；若角色库并发删除或写失败，会跳过全局记账或在成功流后落入异常分支二次上报 `failed`。现已拆离流／模型异常与角色库写库，并将 `onModelCallFinished` 置入 `try/finally`，确保已发生的调用消耗只上报一次终态。
  2. **记忆容量预检与前置构造边界**：[memory-service.ts](../../../apps/backend/src/application/memory-service.ts) 新增 `modelInvoked` 标记，仅在实际进入 `model.form(...)` 后才于 `finishModelCall` 上报全局账单，避免本地 `MEMORY_CAPACITY_EXCEEDED` 或请求前置构造错误计为外部模型失败调用。
  3. **已删除实体最新快照同步与 `range=all` 全量口径**：[token-usage-store.ts](../../../apps/backend/src/storage/token-usage-store.ts) 按时间升序遍历时把已删除角色／服务的最新非空 `role_name`、`resource_name` 与非空 `provider` 同步刷新到 `availableFilters` 和 `byRole` / `byModel`，消除首行为空占位或改名后再删造成的下拉／卡片文案不一致；同时移除 `range === "all"` 时的 `local_date <= ?` 上限，避免跨时区西移或时钟回拨遗漏记录。
  4. **三视口 E2E 对齐**：[token-usage-check.cjs](../../../apps/desktop/tests/e2e/token-usage.e2e.cjs) 补齐 `720×540` 视口横向溢出与 KPI 可见性校验，与 `400` 三视口门禁齐平。
- **回归测试**：在 [p26-token-usage.test.ts](../../../apps/backend/tests/p26-token-usage.test.ts) 新增「已删除角色与服务的快照名称同步更新至筛选项，且 `range=all` 不截断未来本地日期」与「`AgentGraphRunner` 与 `MemoryService` 隔离角色库写失败，且容量超限本地拦截不计入全局失败」。
- **最终复验（2026-11-21，离线模型桩／本地模拟端点范围）**：
  - 后端（Node 24）：`cd apps/backend && npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit` 通过；`npx -y node@24 --import tsx --test tests/*.test.ts` **551 / 551** 通过（0 失败，0 跳过；`p26` **6 / 6** 通过）；`npx -y node@24 scripts/accept-offline.mjs` **21 / 21 步**通过（`delivery-tests` 2/2、`tests` 551/551、`realServiceCalls: 0`、`sourceUnchanged: true`，报告：`apps/backend/test-results/p5-2026-11-21T13-11-21-968Z-cfbceea9/summary.json`）。
  - 桌面端（Node 24）：`apps/desktop/renderer` `npm run check`（`tokens:check`、`lint:styles` 28 个 CSS 违规 0 / 豁免 387、`tsc --noEmit`）与 `npm run build`（160 模块）通过；`desktop/desk-preview` `npx -y node@24 --test tests/*.test.cjs` **164 / 164** 通过（0 失败，0 跳过）。
  - Electron E2E（顺序执行）：`token-usage-check.cjs`（`白昼来信`/`晚风电台` × `1280×800`/`900×720`/`720×540` 全部 `bookOverflow: 0`、`leafOverflow: 0`、`errors: []`）、`settings-v6-behavior-check.cjs`、`settings-workspace-check.cjs`、`workflow-real-backend-chain-check.cjs` 均退出 `0` 通过。
- **仍待**：§4.5 的真实上游模型服务 `usage`／缓存字段联调（OpenAI Chat／Responses、Anthropic Messages、Google AI Studio／Vertex）。
