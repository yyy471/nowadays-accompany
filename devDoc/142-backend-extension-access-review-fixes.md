# 141 后端扩展接入复核修复记录

日期：2026-10-28。状态：141-R1～R4 实现修复与实现方回归完成，待独立复验。未提交、推送、打包或替换发行 EXE；未连接真实 QQ、启动 SnowLuma 或调用付费模型。

问题来源：[141 独立复核](141-backend-extension-access-and-testing-independent-review.md)。原独立复核结论保留；本文是实现方修复记录。

## 1. 结论

四项均已按最小范围收口：

- 手动测试先从保存的启停/授权策略判定，再只启动本次需要的插件；无关闭或未授权时不加载目标及无关插件。
- 测试工具执行复用正式 `ToolConcurrencyLimiter`；测试 Worker 环境另有有界准入，关闭单个测试服务不会关闭共享额度。
- Skill 测试结果消费 Agent 最终请求观测，不再把候选快照当成实际注入 Skill 或实际提供工具。
- Skill 配置字典按自有键读取并使用无原型配置表，`constructor` 等合法 id 不再触发 500，也不影响同账号其他 Skill。

本轮未修改前端，没有增加源码分析、导入试运行、配置 schema 或第三方服务探测。

## 2. 修复

### 141-R1：测试前先判定策略，只加载本次需要的插件

| 修复 | 代码 | 行为 |
| --- | --- | --- |
| 直接工具先做策略门禁 | [extension-test-service.ts:155](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L155)、[:494](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L494) | 先从完整档案解析目标身份；内置工具不带任何插件档案，插件工具只保留所属插件条目；随后用同一策略解析启用/授权状态。关闭、未授权或缺失在 Worker 创建前结束 |
| Skill 测试只启动实际需要的插件 | [extension-test-service.ts:256](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L256)、[:513](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L513) | 先确认目标存在、启用并满足静态正文预算，再按目标插件 Skill、当前启用工具与 Hook 收集所需插件键；测试运行时仅同步这些插件 |
| 运行时状态仍由真实握手判定 | [extension-test-service.ts:476](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L476) | 预检使用声明式就绪，只用于策略门禁；环境打开后仍按本次握手结果重新解析，缺 handler 照常报告 |

这不是导入检查，获准主动测试时仍会实际加载目标插件入口与 init。无关关闭插件不会启动。

### 141-R2：复用共享工具额度并给测试 Worker 环境设上界

| 修复 | 代码 | 行为 |
| --- | --- | --- |
| 执行器可选注入 limiter | [extension-tool-service.ts:71](file:///D:/app/nowadays/accompany/src/application/extensions/extension-tool-service.ts#L71)、[:94](file:///D:/app/nowadays/accompany/src/application/extensions/extension-tool-service.ts#L94)、[:321](file:///D:/app/nowadays/accompany/src/application/extensions/extension-tool-service.ts#L321) | 未注入时继续拥有并关闭自身 limiter；注入时只使用，不因单次测试服务关闭而关闭共享额度 |
| 测试环境取得正式预算 | [extension-test-service.ts:50](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L50)、[:572](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L572)、[core.ts:282](file:///D:/app/nowadays/accompany/src/core/core.ts#L282) | Core 把生产 `ExtensionToolService` 的 limiter 传给测试服务；工具 handler 实际运行继续受全局 4/账号 2 约束 |
| Worker 启动有界准入 | [extension-test-service.ts:97](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L97)、[:542](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L542)、[:111](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L111) | 测试服务使用独立的有界 admission limiter；只覆盖 Worker/环境打开，不贯穿模型与工具执行，避免嵌套占用同一额度造成死锁；Core 关闭会中止排队请求 |

### 141-R3：报告最终模型请求中的实际 Skill 与工具

| 修复 | 代码 | 行为 |
| --- | --- | --- |
| 宿主观测点 | [contract.ts:38](file:///D:/app/nowadays/accompany/src/host/contract.ts#L38)、[:85](file:///D:/app/nowadays/accompany/src/host/contract.ts#L85) | `AgentMessageContext` 可选记录第一次真实 provider 请求，正式 QQ 宿主无需实现 |
| Agent 最终构建处记录 | [engine.ts:683](file:///D:/app/nowadays/accompany/src/agent/engine.ts#L683) | 在角色/历史/工具协议预算及 `supportsTools` 判定完成后，记录最终入选 skills 与真正发出的 tool IDs；不另造测试上下文算法 |
| 测试消费实际观测 | [extension-test-service.ts:325](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L325)、[:341](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L341)、[:391](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L391) | `captureTurn` 只负责候选过滤，不再宣称注入；`test.status/tools/calls` 使用第一次真实请求观测。目标被当轮预算排除返回 `skill_not_injected`；不支持工具协议返回实际 `tools: []` |

Skill preview 仍明确是“候选/已保存策略预览”，插件 handler 为 `unverified`；只有 `tests/skill` 才报告实际请求内容。

### 141-R4：合法 Skill id 按自有键读取

| 修复 | 代码 | 行为 |
| --- | --- | --- |
| 配置读取 | [extension-config-service.ts:38](file:///D:/app/nowadays/accompany/src/application/extensions/extension-config-service.ts#L38)、[:75](file:///D:/app/nowadays/accompany/src/application/extensions/extension-config-service.ts#L75) | `Object.hasOwn` 判断，避免 `constructor`、`toString` 命中原型方法 |
| 配置写入 | [extension-config-service.ts:79](file:///D:/app/nowadays/accompany/src/application/extensions/extension-config-service.ts#L79)、[providers/types.ts:736](file:///D:/app/nowadays/accompany/src/providers/types.ts#L736) | 新建无原型配置表后复制/设置/删除自有键 |
| 有效状态 | [effective.ts:198](file:///D:/app/nowadays/accompany/src/extensions/effective.ts#L198) | 只附着自有键配置，不再克隆原型函数 |

未禁止合法 id，也未增加业务 schema。

## 3. 新增回归

| 场景 | 代码 | 实际断言 |
| --- | --- | --- |
| R1 目标与无关插件均未启动 | [extension-manual-tests.test.ts:359](file:///D:/app/nowadays/accompany/test/extension-manual-tests.test.ts#L359) | 未授权调用返回 error/load；两个顶层 marker 均不存在；授权目标后仅目标 marker 存在 |
| R2 同账号并发直接工具 | [extension-manual-tests.test.ts:408](file:///D:/app/nowadays/accompany/test/extension-manual-tests.test.ts#L408) | 5 个并发 handler 区间最大重叠不超过既有账号上限 2；结束后 `test-runs` 清空 |
| R3 目标被最终上下文预算排除 | [extension-manual-tests.test.ts:628](file:///D:/app/nowadays/accompany/test/extension-manual-tests.test.ts#L628) | 有真实模型调用，但 requestText 不含目标 Skill；测试返回 `skill_not_injected` |
| R3 模型不支持工具协议 | [extension-manual-tests.test.ts:653](file:///D:/app/nowadays/accompany/test/extension-manual-tests.test.ts#L653) | 最后一次 FakeProvider 请求 `toolNames` 为空，测试 `tools: []`；正文仍实际进入模型请求 |
| R4 原型同名 Skill | [extension-access.test.ts:585](file:///D:/app/nowadays/accompany/test/extension-access.test.ts#L585) | `constructor/toString` 配置读取、保存、清空均 200；`toString` 与 sibling 不继承原型值 |

## 4. 实现方验证

| 验证 | 本次结果 |
| --- | --- |
| `npx vitest run test/extension-access.test.ts test/extension-manual-tests.test.ts` | 2 个文件、27 项通过 |
| `npm test` | 126 个文件通过；1182 项通过、1 项既有跳过 |
| `npm run typecheck` | 通过（含 test/desktop 主进程与 renderer） |
| `npm run desktop:build` | Core、renderer、Electron main/preload 构建通过 |
| `npx tsx test/diagnostics/independent-extension-access-review.mts` | 探针结果：无授权时目标/无关 marker 均为 false；5 个同账号直接工具最大同时执行 2；预算排除时实际 request 不含 sentinel 且返回 `skill_not_injected`；`supportsTools:false` 实际/响应 tools 均为空；`constructor` 配置与无关 Skill preview 均 HTTP 200 |

诊断观测写入 `test-results/independent-extension-review/probes.json`（本地忽略目录）。

## 5. 边界

- R1 的“只启动需要插件”是测试环境装配范围；获准的主动测试仍会执行目标插件入口与 init。
- R2 的 admission limiter 只约束短生命周期测试 Worker/环境打开，不是新的调度平台；真实 handler 工具执行仍由既有共享 ToolConcurrencyLimiter 控制。
- R3 只观测第一次模型请求的实际 Skill/tools；多轮续答中后续请求可因协议预算不再提供 tools，这属于原 Agent 行为。
- 未验证真实第三方插件、真实外部服务、付费模型、真实 QQ/SnowLuma 或发行包。
- 本轮未改前端；141 的独立结论仍保留，待独立复验后才能把 139 后端范围收口。
- 按用户长期要求未 `git add`、提交、推送、打包或替换 EXE。
