# 后端扩展接入与手动测试独立复核

日期：2026-10-28。状态：**暂不通过，发现 2 项 P1、2 项 P2，均有离线运行证据**。

依据：[139 实现方案](139-backend-extension-access-and-testing-implementation-plan.md)。被复核实现及自验记录见[140 执行记录](140-backend-extension-access-and-testing-execution.md)。复核基线为提交 `2e13299` 之后当前工作区的后端修改，包括尚未跟踪的新模块、样例和两个测试文件。

本次没有修改业务实现，没有提交或推送。新增本复核文档、导航和[独立诊断脚本](../test/diagnostics/independent-extension-access-review.mts)。没有连接真实 QQ、启动 SnowLuma 或调用付费模型。

## 1. 结论

导入、账号 JSON 配置、Skill 共用渲染及手动测试主体已实现；没有发现导入时动态执行插件的行为，也没有新增前端改动。既有自动化、类型检查和桌面构建本次独立运行均通过。

但手动测试仍有加载范围、并发额度和结果真实性问题，Skill 配置还有合法标识读取错误，不能以 140 的自验结果作为最终收口。修复下面四项并补复验后，再更新后端完成口径。

本复核要求的修复均可落在当前契约和执行链内：移动已保存策略的判断位置、复用一个并发额度、报告实际模型请求、正确读取 JSON 配置键。**不要求新增源码分析、导入试运行、配置业务校验或第三方服务探测。**

## 2. 实际验证

| 验证 | 本次结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npx vitest run test/extension-access.test.ts test/extension-manual-tests.test.ts` | 2 文件，22 项通过 |
| `npm test` | 126 文件通过，1177 项通过、1 项既有跳过 |
| `npm run desktop:build` | Core、renderer、Electron main/preload 构建通过 |
| `git diff --check` | 通过 |
| `npx tsx test/diagnostics/independent-extension-access-review.mts` | 脚本执行成功，输出五组观测，复现下列四项缺陷；脚本退出码不是验收通过标志 |

最初定向测试在受限沙箱中出现 20 项失败，原因为导入器 `lstat C:\Users\24349` 被拒绝。放开这一环境权限后，同样 22 项全部通过；本次不把该环境限制算作产品缺陷，也没有通过修改导入器规避测试。

诊断脚本使用真实 Core、本地 HTTP、真实 Worker、统一工具执行器和 FakeProvider；插件只写临时标记、等待并返回时间戳。临时 dataRoot 通过系统临时目录 realpath 创建，退出时停止 Core 并清理。原始观测写入 `test-results/independent-extension-review/probes.json`，该目录按仓库约定不进 Git，可由脚本重建。

## 3. 复核发现与最小修复要求

### 141-R1 / P1：关闭或未授权时，测试仍先执行插件加载与初始化

位置：[extension-test-service.ts](../src/application/extensions/extension-test-service.ts)，`testTool()` 的 157～163 行、`#openEnvironment()` 的 485～507 行；Skill 测试有同样的先启动再判断顺序。

当前 `testTool()` 先执行 `#openEnvironment(profile)`，其中 `runtime.sync(profile.plugins)` 会加载档案中的所有插件，之后才调用 `#toolStatus()` 检查目标插件开关和工具授权。它不仅加载目标，还加载与本次工具无关的插件；`testSkill()` 也在检查目标 Skill 前启动整个档案。

复现：

1. 为同一账号选择 good、disabled 两个插件，两个模块的顶层各写一个临时标记。
2. 账号扩展策略为空，两个插件均没有运行授权，工具也没有授权。
3. 仅请求测试 `public/plugin/good/run`。
4. 响应为 `test.status:error`、`code:plugin_switch_off`、`calls:[]`，但 **good 和 unrelated disabled 两个模块的标记都已生成**。

影响：接口虽然最终返回“关闭”，插件代码已经运行；用户仅测试某工具，也会额外启动其他插件的代码和 init。对会访问外部服务的初始化逻辑，这不是只多一次无害的状态查询。

最小修复：先用 manifest 和已保存策略确认本次资源是否存在、启用、获准调用，再正常加载本次需要的插件。直接工具测试只启动工具所属插件；内置工具无需启动无关插件。Skill 测试按当前启用的工具/Hook 所需插件组织运行时。handler 是否存在仍在正常加载阶段检查，**不做入口源码分析**。

复验：关闭/未授权请求不得生成任何插件顶层或 init 标记；测试 A 时，关闭的 B 不启动；获准测试 A 时仍能实际执行其入口和 handler。

### 141-R2 / P1：每个测试请求创建自己的限流器，绕过账号与全局工具并发上限

位置：[extension-test-service.ts](../src/application/extensions/extension-test-service.ts) 500～507 行；参照 [ExtensionToolService](../src/application/extensions/extension-tool-service.ts) 91～100 行及 [ToolConcurrencyLimiter](../src/extensions/execution/limiter.ts) 的默认上限。

每次测试新建 ExtensionToolService，该服务构造时又新建 ToolConcurrencyLimiter。于是每个请求都有独立的“全局 4 / 账号 2”额度，彼此及正式工具执行都不共享。测试 Worker 的创建也没有经过一个共享测试准入额度。

复现：同账号并行发起 5 次工具测试，handler 各等待 1000ms 并返回实际开始/结束时间。对五个时间区间计算重叠数，**最大同时执行数为 5**，超过既有每账号 2，也超过全局 4。连续重跑观测一致。

影响：重复点击或并行调用测试接口可以突破既有资源限制；Skill 对话调度器只能限制模型轮次，不能约束本入口的直接工具测试和前置 Worker 启动。

最小修复：让测试执行共享同一工具并发额度，并与正式执行保持约定的一致性；可注入现有限流器，区分共享对象和单次测试对象的关闭归属。Worker 创建前复用一个有界准入点即可，不必引入新的队列/调度平台。

复验：同账号 5 个长工具实际同时运行不超过 2，多账号总数不超过 4；测试与正式调用重叠时也不突破共享上限，结束一个测试不得关闭其他测试或正式调用使用的共享额度。

### 141-R3 / P2：把候选快照当作最终模型请求，Skill 与工具测试结果会误报

位置：[extension-test-service.ts](../src/application/extensions/extension-test-service.ts) 341～345 行、394～405 行；真实 Skill 裁剪与工具提供判断在 [engine.ts](../src/agent/engine.ts) 的上下文构建和模型请求阶段。

`captureTurn()` 看到目标 Skill 存在就设置 `injected=true`，看到候选工具就记录 offeredTools。此时还没有经过角色/当前输入/配置/工具协议共同占用的上下文预算，也没有根据模型 supportsTools 决定实际 tools 字段，因此这两个值不能代表最终请求。

复现 A：

- 目标 Skill 正文约 4 KB，单条标准预算检查通过。
- 测试 roleText 为 11000 字符，真实 Agent 根据 12000 总预算排除了目标 Skill。
- FakeProvider 实际收到一个 chat 请求，requestText **不包含目标 Skill 的唯一标记**，HTTP 仍返回 `test.status:ok`。

复现 B：

- 将同一对话模型改为 `supportsTools:false`，保留账号工具授权。
- 实际模型请求没有 tools，FakeProvider 记录的工具列表为空。
- 测试响应 `tools` 仍列出 `public/plugin/good/run`；DTO 注释却声称它是“实际提供给模型的工具”。

影响：后续测试页可能显示目标 Skill 测试成功，但模型根本没有阅读该 Skill；或显示模型获得了实际上未提供的工具。普通模型回答成功不能代表目标扩展实际进入本轮。

最小修复：在共用 Agent 最终上下文/请求构建位置记录实际选中的 Skill 和真正提供的工具，测试结果消费这一信息。目标 Skill 被预算排除时返回明确原因；区分候选与实际提供，不再在 captureTurn 阶段宣称已注入。可用一个轻量观测回调，无需另建一套测试上下文算法。

复验：以 FakeProvider 实际 messages/tools 对照测试结果；标准 Skill 预算通过但被本轮预算排除、模型不支持工具、协议预算导致不提供工具等情况必须如实反映。

### 141-R4 / P2：合法 Skill ID 命中对象原型属性，配置与其他 Skill 预览返回 500

位置：[extension-config-service.ts](../src/application/extensions/extension-config-service.ts) 37～38、106～107 行；[effective.ts](../src/extensions/effective.ts) 198～205 行；同时检查配置字典的写入/解析位置。

配置字典使用普通 `{}`，读取通过 `[id]` 而不判断自有键。`constructor`、`toString` 等字符串满足当前 Skill id 格式，却也存在于 Object.prototype 上。不存在该项用户配置时，读取 constructor 得到 Object 函数而非空配置，structuredClone 随即报错。

复现：

1. 使用正常 Skill 保存接口创建 id 为 `constructor` 的定义，保存成功。
2. `GET /accounts/10001/extensions/config?kind=skill&id=constructor` 返回 HTTP 500、`internal_error`，消息为 `function Object() { [native code] } could not be cloned.`。
3. 为另一个普通 Skill 保存配置，使 configs 成为非空字典。
4. 请求另一个 Skill 的 `tests/skill-preview`，同样返回 500；原因是有效状态解析遍历全部 Skill 时，对 constructor 读取了原型函数。

影响：一个契约允许的普通 id 就能让配置读取失败，并影响同账号其他 Skill 的有效预览。无需恶意源码或异常 JSON。

最小修复：将 JSON 字典按自有键读取，或使用无原型字典/Map；所有读取和写入位置保持一致。不需要禁止正常 id 或增加业务配置 schema。

复验：constructor、toString 与普通 id 均能读取、保存、清空配置；增加其中一个 Skill 不影响其他 Skill 的预览或正式上下文解析。

## 4. 已确认的范围与证据边界

| 范围 | 本次结论 |
| --- | --- |
| 导入基础格式、不试运行 | 当前实现符合；原新增测试也覆盖坏 JS/缺依赖能导入及顶层不执行 |
| 插件 config、Skill configs 持久化 | 主路径已有实现，普通 id 的原新增用例通过；合法原型同名 id 见 R4 |
| 内置/插件统一工具调用 | 已复用现有执行器；共享额度问题见 R2 |
| Skill 预览与实际对话 | 可运行；本轮实际注入和工具展示准确性见 R3 |
| 测试不写正式历史/宿主插件状态 | 有独立临时状态目录，既有用例通过；这不证明插件自身外部动作可回滚 |
| 生图/语音测试 | 复用现有任务和媒体，既有 submitted/跳过 QQ 交付用例通过 |
| 前端 | 当前没有修改；次级测试页面仍待后续接入 |
| 真实服务/QQ/发行包 | 本次未验收，不能用 fake 结果替代 |

140 的 T06 用例主要证明没有写入生产目录；不应将其扩大解释为所有测试/正式运行并发行为已验证。R2 的共享额度缺口就是原用例未覆盖的实际场景。

## 5. 后续复验要求

先处理 R1、R2，再处理 R3、R4；将上述触发条件加入有意义的回归。修复应保持导入简单、运行时错误可见，继续复用已有契约。

实现方更新 140 或另写修复记录，并保留本次独立发现的原始结论。独立复验至少重跑诊断脚本、修复回归、类型检查、全量测试和桌面构建。只有实际观测收口后，才能把 139 后端范围标为通过；本次没有替实现方修改或提交业务代码。
