# 后端扩展接入与手动测试执行记录

日期：2026-10-28。状态：BE-1～BE-6 实现及 141-R1～R4 修复自验完成，待独立复验。未提交、未推送、未打包或替换发行 EXE；未使用真实 QQ、SnowLuma 注入或付费模型。

依据：[139 实现方案](139-backend-extension-access-and-testing-implementation-plan.md)。本文只覆盖该方案的后端范围；前端扩展管理页与次级测试页面仍后置。

> [141 独立复核](141-backend-extension-access-and-testing-independent-review.md) 发现的 R1～R4 已由 [142 修复记录](142-backend-extension-access-review-fixes.md) 处理。本文原“1177 项”和手动测试描述以 142 的最新结果为准：126 文件、1182 项通过、1 项既有跳过；141 的原始结论保留，待独立复验。

## 1. 结论

后端接入链路已完成：

- 本地目录扫描、预览与导入：插件复用既有 artifacts 目录导入，独立 Skill 将 `SKILL.md` 转为现有定义；扫描、预览和导入都不加载插件、不执行顶层代码、不解析依赖。
- 账号级 JSON 配置：插件配置写 `profile.plugins[].config`，Skill 参数写 `AccountSkillPolicy.skills.configs`；两者都有独立 revision、CAS 与串行写入。
- 共用 Skill 渲染：预览、正式 Agent 和手动测试使用同一个“正文 + 用户配置 JSON”函数，注入预算按渲染后文本计算。
- 手动测试：真实 Core、真实插件 Worker/统一 ToolExecutor、真实 Agent 工具循环和 ProviderRouter；先按已保存策略门禁并只启动本次需要的插件，工具执行共享正式限流额度；不连接 QQ，不读取真实历史/世界书/记忆，不写账号生产插件状态或调用账本。
- 内置生图/语音测试继续复用现有媒体任务，返回 `submitted` + `jobId`，delivery 记录为 `skipped`（“手动测试，不投递 QQ”）。

本地自动化结果（141 修复后）：`npm test` 126 个文件通过，1182 项通过、1 项既有跳过；`npm run typecheck` 与 `npm run desktop:build` 通过。真实第三方插件、网络服务、真实模型与 QQ 兼容性仍需用户手动验收。

## 2. 交付

### BE-1 DTO 与样例

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 导入/配置/测试 DTO | [extension-access.ts:9](file:///D:/app/nowadays/accompany/src/contracts/extension-access.ts#L9) | 扫描项、插件/Skill 预览、导入目标与结果、配置视图与更新、测试 scope/输入/调用/结果/preview 全部集中为纯类型 |
| Skill 预览字段 | [skills.ts:94](file:///D:/app/nowadays/accompany/src/contracts/skills.ts#L94) | 增加 `renderedInstructions` 与可选 `config`；`instructionsChars` 改为渲染后长度 |
| 最小插件样例 | [weather/manifest.json](file:///D:/app/nowadays/accompany/examples/extensions/weather/manifest.json) | 声明 `query` 工具、账号配置默认城市，并声明插件 Skill `forecast` |
| 独立 Skill 样例 | [travel-planning/SKILL.md](file:///D:/app/nowadays/accompany/examples/extensions/travel-planning/SKILL.md) | `SKILL.md` 正文 + `skill.json` 元数据，引用 `public/plugin/weather/query` |
| 用户说明 | [examples/extensions/README.md](file:///D:/app/nowadays/accompany/examples/extensions/README.md) | 放入 imports、导入、配置、手动测试的实际请求格式与副作用边界 |

导入阶段只检查：manifest 可解析、身份字段、支持的 `apiVersion`、入口普通文件存在、声明结构；Skill 只检查 `SKILL.md` 必要文本、可选 `skill.json` 字段、标识格式和现有内容上限。语法错误、缺依赖、缺 handler、init 异常与外部服务失败留到正常加载或主动测试。

### BE-2 扫描、预览与导入

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 扫描 | [extension-import-service.ts:57](file:///D:/app/nowadays/accompany/src/application/extensions/extension-import-service.ts#L57) | 枚举 `<dataRoot>/imports/plugins` 与 `skills`，最多 200 项；逐项校验，一个坏包不影响其他候选 |
| 预览/导入 | [extension-import-service.ts:84](file:///D:/app/nowadays/accompany/src/application/extensions/extension-import-service.ts#L84)、[:91](file:///D:/app/nowadays/accompany/src/application/extensions/extension-import-service.ts#L91) | 插件包装既有 `ArtifactImportService`；公用或账号私有目标；Skill 复用 `savePublic`/`savePrivate` 的 revision 检查 |
| 插件预览不检查目标冲突 | [artifact-import-service.ts:34](file:///D:/app/nowadays/accompany/src/application/artifacts/artifact-import-service.ts#L34) | 新增 `checkDestination` 选项；预览只算指纹与目标相对路径，重复/冲突留到正式导入 |
| SKILL.md 转换 | [extension-import-service.ts:149](file:///D:/app/nowadays/accompany/src/application/extensions/extension-import-service.ts#L149) | 正文去 BOM 后作为 instructions；无 `skill.json` 时 id 取目录名、name 取首个一级标题；导入定义默认 `enabled:false`，不授权工具 |
| 私有目标账号校验 | [extension-import-service.ts:244](file:///D:/app/nowadays/accompany/src/application/extensions/extension-import-service.ts#L244) | 账号不存在返回 `extension_account_not_found`（404）；符号链接与特殊文件拒绝 |

### BE-3 配置、共用渲染与预算

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 配置用例 | [extension-config-service.ts:29](file:///D:/app/nowadays/accompany/src/application/extensions/extension-config-service.ts#L29)、[:41](file:///D:/app/nowadays/accompany/src/application/extensions/extension-config-service.ts#L41) | 插件委托 `AccountService`；Skill 读写账号策略 `skills.configs`；空配置删除 key，其他 Skill 配置保留 |
| 插件配置读改写 | [account-service.ts:186](file:///D:/app/nowadays/accompany/src/application/accounts/account-service.ts#L186)、[:198](file:///D:/app/nowadays/accompany/src/application/accounts/account-service.ts#L198) | 按 `public/private/plugin/<id>` 定位条目；revision 由条目内容计算；保存只替换该条目，保留其他插件、revision、enabled 与 roleCard |
| 同账号写入串行 | [account-service.ts:237](file:///D:/app/nowadays/accompany/src/application/accounts/account-service.ts#L237) | 插件配置与整档案保存共用 `#profileWrites`，底层仍走 atomic-write |
| 配置值边界 | [config-value.ts:6](file:///D:/app/nowadays/accompany/src/extensions/config-value.ts#L6) | 只接受可序列化 JSON 对象，单条最多 8 KiB；不做业务字段类型推断 |
| 配置上限 | [config-limits.ts:2](file:///D:/app/nowadays/accompany/src/extensions/config-limits.ts#L2) | 与 Worker 协议共享 `maxConfigBytes`；Skill 配置最多 128 项 |
| Skill configs 持久化 | [providers/types.ts:663](file:///D:/app/nowadays/accompany/src/providers/types.ts#L663) | `AccountSkillPolicy.skills.configs` 解析/序列化；旧配置无需迁移，空值裁剪 |
| 有效配置附着 | [effective.ts:198](file:///D:/app/nowadays/accompany/src/extensions/effective.ts#L198)、[extension-policy-service.ts:111](file:///D:/app/nowadays/accompany/src/application/extensions/extension-policy-service.ts#L111) | 按解析后的有效 Skill id 附上配置；公用/私有同 id 共用一个账号配置 |
| 共用渲染 | [skill-render.ts:5](file:///D:/app/nowadays/accompany/src/extensions/skill-render.ts#L5) | 固定“正文 + `用户配置（JSON）：` + JSON 序列化”，不做模板替换；预览、Agent 快照、手动测试共用 |
| 预算 | [skill-service.ts:155](file:///D:/app/nowadays/accompany/src/application/extensions/skill-service.ts#L155) | 预览选择与 `instructionsChars` 使用渲染后文本；配置过长按既有 `instructions_too_long` 排除 |
| 快照摘要 | [extension-tool-service.ts:250](file:///D:/app/nowadays/accompany/src/application/extensions/extension-tool-service.ts#L250) | 扩展快照里的 Skill instructions 使用同一渲染结果，配置变化进入后续轮次 |

插件配置保存后沿用现有重载用例；有实例时返回 `reload` 结果，没有实例时不虚构重载成功。空配置 `{}` 删除条目 config；Skill 配置 `{}` 删除对应 key。

### BE-4 独立测试上下文与直接工具测试

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| 测试服务 | [extension-test-service.ts:91](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L91) | 每个请求创建 `<dataRoot>/test-runs/<uuid>` 独立状态目录；跟踪 runtime 与活动请求，Core 关闭时 abort 并等待释放 |
| 策略前置与最小加载 | [extension-test-service.ts:155](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L155)、[:494](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L494)、[:513](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L513) | 工具/Skill 先按已保存开关和硬授权判定；关闭或未授权不启动 Worker。插件直接测试只加载目标插件，Skill 测试只加载目标插件 Skill 及当前启用的工具/Hook 所需插件 |
| 共享执行额度与 Worker 准入 | [extension-tool-service.ts:94](file:///D:/app/nowadays/accompany/src/application/extensions/extension-tool-service.ts#L94)、[extension-test-service.ts:542](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L542)、[core.ts:282](file:///D:/app/nowadays/accompany/src/core/core.ts#L282) | 测试执行器注入正式 `ToolConcurrencyLimiter`，关闭单次测试服务不关闭共享额度；测试 Worker 打开另有有界 admission |
| 直接工具测试 | [extension-test-service.ts:155](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L155) | 在策略门禁后启动本次所需 Worker 握手，通过统一 `ExtensionToolService.executeBatch` 执行一次调用；不调用对话模型 |
| 失败阶段 | [extension-test-service.ts:461](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L461)、[:784](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L784) | 策略关闭/未授权在启动前返回；运行时同步失败映射 `load/init`；handler 缺失返回 `handler_not_ready`；调用返回 error 时带 `invoke` 与安全 code/message |
| 内置工具复用 | [media-tool-host.ts:57](file:///D:/app/nowadays/accompany/src/agent/media-tool-host.ts#L57) | 从 Agent 抽出的统一媒体工具 host；测试使用 `deliveryMode:'skip'`，参数与生产一致 |
| 生产状态隔离 | [extension-test-service.ts:542](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L542) | 测试不写账号 `plugin-state`、`state/tool-invocations.json` 或 `messages`；不读取真实历史/世界书/记忆 |

### BE-5 Skill preview、模型测试与媒体异步结果

| 交付 | 代码 | 说明 |
| --- | --- | --- |
| Skill preview | [extension-test-service.ts:114](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L114) | 按已保存策略展示启用状态、原因、渲染后说明与工具候选；未启动测试 Worker 时插件 handler 标为 `unverified`；不调用模型、不启动 runtime、不写配置 |
| Agent 测试模式与最终观测 | [engine.ts:120](file:///D:/app/nowadays/accompany/src/agent/engine.ts#L120)、[:258](file:///D:/app/nowadays/accompany/src/agent/engine.ts#L258)、[:683](file:///D:/app/nowadays/accompany/src/agent/engine.ts#L683)、[contract.ts:38](file:///D:/app/nowadays/accompany/src/host/contract.ts#L38) | 复用真实上下文、工具协议、媒体 handler 与预算；测试模式跳过自动回复暂停与命令解析；第一次真实请求构建后记录入选 Skill 与实际 tools |
| Skill 实际测试 | [extension-test-service.ts:256](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L256)、[:316](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L316)、[:513](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L513) | 先确认目标策略与静态预算，只启动所需插件；运行时只注入目标 Skill，其他独立 Skill 过滤；history 为空；send/deliver 是收集端口；无 QQ 投递 |
| 测试结果 | [extension-test-service.ts:325](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L325)、[:433](file:///D:/app/nowadays/accompany/src/application/extensions/extension-test-service.ts#L433) | `ok/error/submitted/unknown`；模型失败 `stage:'model'`；工具调用失败 `stage` 按 invoke/load/init 映射；目标被最终上下文排除返回 `skill_not_injected`；`tools` 报告实际提供集合 |
| 媒体 submitted | [media-tool-host.ts:241](file:///D:/app/nowadays/accompany/src/agent/media-tool-host.ts#L241) | 复用 MediaJobService/MediaService；返回 jobId；delivery `skipped`，任务可继续查询终态 |
| 关闭顺序 | [core.ts:430](file:///D:/app/nowadays/accompany/src/core/core.ts#L430) | `extension-tests` 在 `extension-tools` 前关闭，先中止测试请求再释放共享工具端口 |

### 接口

| 方法与路径 | 行为 |
| --- | --- |
| `POST /extensions/imports/scan` | 枚举固定 imports 目录，返回候选与逐项校验结果 |
| `POST /extensions/imports/preview` | `{kind, sourceDirectory}`，只读文件与格式 |
| `POST /extensions/imports` | `{kind, sourceDirectory, target, expectedRevision?}`；插件私有目标必填 accountId；Skill 必填 expectedRevision |
| `GET /accounts/:accountId/extensions/config?kind=&id=` | 返回 `{ok:true, config, revision}`；插件 id 用完整插件 key，Skill id 用有效 id |
| `PUT /accounts/:accountId/extensions/config?kind=&id=` | `{config, expectedRevision}` 整项替换；插件额外返回可选 reload |
| `POST /accounts/:accountId/extensions/tests/tool` | 实际执行一个内置或插件工具，不调用模型 |
| `POST /accounts/:accountId/extensions/tests/skill-preview` | 只读预览，不启动 Worker/模型 |
| `POST /accounts/:accountId/extensions/tests/skill` | 实际模型调用与工具续答，不发 QQ |

路由实现见 [extension-access.ts:28](file:///D:/app/nowadays/accompany/src/service/routes/extension-access.ts#L28)，Core 委托见 [core.ts:944](file:///D:/app/nowadays/accompany/src/core/core.ts#L944)。导入、配置和实际测试写入审计；预览不写审计。错误映射见 [errors.ts:56](file:///D:/app/nowadays/accompany/src/service/http/errors.ts#L56)：配置冲突 409，插件未安装/账号不存在/工具不存在 404。

## 3. 验收对照

### 文件接入

| 编号 | 证据 | 状态 |
| --- | --- | --- |
| I01 最小 manifest + 入口 | `extension-access.test.ts` 第 1、2 项；`extension-manual-tests.test.ts` 第 1 项；扫描/预览/导入并按账号选择 | 通过 |
| I02 语法错误、缺依赖、缺 handler | 语法错误与缺依赖均可导入，测试返回 `load/init`；缺 handler 返回 `load` + `handler_not_ready`（`extension-manual-tests.test.ts` 失败阶段第 5 项） | 通过 |
| I03 顶层可观察动作 | 扫描/预览/导入后 marker 不存在，只有显式测试才执行（`extension-access.test.ts:96`、失败阶段用例） | 通过 |
| I04 无 manifest/缺入口/不支持 apiVersion/错误声明 | `extension-access.test.ts:251`；其他候选仍列出 | 通过 |
| I05 裸 SKILL.md 与 skill.json | `extension-access.test.ts:198`；已有 JSON Skill CRUD 回归由既有 Skill 测试继续通过 | 通过 |
| I06 引用不存在工具 | `extension-access.test.ts:273`；导入成功，预览报 `skill_tool_unavailable`，授权仍为空 | 通过 |
| I07 公用/私有与重复 | `extension-access.test.ts:153`（私有路径、重复 409、账号不存在 404）、`:198`（公用/私有 Skill 与 CAS）；插件预览不预判目标冲突 | 通过 |

### 配置与调用

| 编号 | 证据 | 状态 |
| --- | --- | --- |
| C01 账号 A/B 不同城市、重启保持 | `extension-manual-tests.test.ts:240` 分别读杭州/上海，停止并用同一 dataRoot 重建 Core 后再测仍读杭州；`extension-access.test.ts:384` 验证配置重启回读 | 通过 |
| C02 合法对象、错误业务字段 | `extension-manual-tests.test.ts:283` 保存 `{city:42}` 成功，插件按作者实现返回 `42`；宿主不预判 | 通过 |
| C03 单插件配置不丢其他内容 | `extension-access.test.ts:410` 同时安装 weather/clock，分别保存配置后 roleCard、enabled、另一插件配置均保留 | 通过 |
| C04 Skill 配置、私有覆盖、公用/插件 Skill、共用渲染 | 私有覆盖 `extension-access.test.ts:526`；原型同名 key `:585`；公用 Skill 预览/实际请求 `extension-manual-tests.test.ts:450`；插件命名空间 Skill `:502`；渲染函数唯一 | 通过 |
| C05 定义/策略更新保留 configs | `extension-access.test.ts:465` 编辑与删除定义后配置保留，可显式清空；旧数据按空对象读取 | 通过 |
| C06 正文+配置超预算 | `extension-access.test.ts:561` 7.9 KB 配置使渲染正文超过 8000 字符，返回 `instructions_too_long` 并从 included 排除 | 通过 |
| C07 并发配置 | `extension-access.test.ts:335` 独立 revision 冲突可见；`:465` 两个并发 PUT 仅一个成功；配置与整档案保存共用账号串行链 | 通过（本地自动化） |

### 手动测试

| 编号 | 证据 | 状态 |
| --- | --- | --- |
| T01 无 QQ/SnowLuma | 所有测试 Core 均 `instances: []`；测试服务不创建 QqInstance | 通过 |
| T02 load/init/invoke 失败 | `extension-manual-tests.test.ts:675` 覆盖 init、语法、缺依赖、缺 handler、invoke；阶段与 code 对应实际实现 | 通过 |
| T03 直接工具 vs Skill 模型 | 直接工具测试断言 chat 调用数不增加；Skill 测试使用 FakeProvider 工具续答（`:450`） | 通过 |
| T04 preview 无副作用 | `:502` 断言 preview 后模型调用为 0、`test-runs` 为空；preview 不创建 runtime | 通过 |
| T05 未授权/关闭 | `:336` 直接返回既有原因，授权列表保持为空；`:359` 进一步证明目标与无关插件顶层 marker 均未生成 | 通过 |
| T06 与正式运行隔离 | `:240` 断言无生产 `plugin-state`、工具账本、`messages`；`:408` 同账号并发实际执行数受共享账号上限 2；测试使用独立 state 根 | 通过 |
| T07 媒体 submitted | `:606` 返回 jobId，`/jobs/:id?accountId=` 查询到 succeeded、delivery skipped、媒体存在 | 通过 |
| T08 未选工具/工具失败 | `:593` calls 为空；`:540` 工具失败返回 `error` + `stage:'invoke'` + 原 reply 与失败 call；`:653` 非工具模型实际 tools 为空 | 通过 |
| T09 释放/关闭 | `:240` 同步测试结束后 test-runs 为空；`:292` Core 在测试进行中停止，5 秒内有界返回并清空 test-runs | 通过 |
| T10 正式 QQ 回归 | 既有 Agent/插件/消息链路全量回归通过；本轮未连接真实 QQ，真实环境行为未验收 | 本地自动化通过，实机未验 |

## 4. 实际验证

| 验证 | 结果 |
| --- | --- |
| `npx vitest run test/extension-access.test.ts test/extension-manual-tests.test.ts` | 2 个文件、27 项通过 |
| `npm test` | 126 个文件通过；1182 项通过、1 项既有跳过 |
| `npm run typecheck` | 通过（含 test/desktop 主进程与 renderer） |
| `npm run desktop:build` | Core、renderer、Electron main/preload 构建通过 |
| 141 独立诊断探针 | R1 未授权 marker false/false；R2 最大同时执行 2；R3 预算排除与无工具模型如实报告；R4 constructor 配置与无关 preview 均 200 |

自动化使用临时 dataRoot、FakeProvider/FakeChannel、确定性本地插件；没有真实 QQ 消息、注入、网络第三方服务或付费模型。

## 5. 用户如何放置与测试

1. 将插件目录放到 `<dataRoot>/imports/plugins/<name>`，将 Skill 目录放到 `<dataRoot>/imports/skills/<name>`。
2. 调用 `POST /extensions/imports/scan` 查看候选，再对具体目录调用 `POST /extensions/imports/preview`。
3. 调用 `POST /extensions/imports` 导入。插件导入后仍需在账号 `profile.plugins` 选择；Skill 导入后默认关闭，需通过现有账号 Skill 开关启用。
4. 用 `GET/PUT /accounts/:accountId/extensions/config` 保存普通 JSON 配置。插件 id 使用 `public/plugin/<id>` 或 `private/plugin/<id>`；插件 Skill 配置使用 `public/plugin/<id>/skill/<skillId>`。
5. 用 `POST /accounts/:accountId/extensions/tests/tool` 直接测试插件工具，或用 `tests/skill-preview`/`tests/skill` 预览/实际测试 Skill。测试会真实执行插件代码；内置媒体结果通过现有 `/jobs` 查询。

完整请求示例见 [examples/extensions/README.md](file:///D:/app/nowadays/accompany/examples/extensions/README.md)。

## 6. 边界与后续

- 本轮没有修改 `desktop/renderer/`；扩展管理页和“扩展详情 → 测试”次级页面仍待前端接入。
- 141 的 R1～R4 已修复并补离线回归，但 141 原独立结论保留，仍待独立复验后才能把 139 后端范围标记收口。
- 测试隔离只覆盖宿主管理的插件 state、调用账本和消息历史；获准测试仍会执行所需插件代码，插件自行写文件或访问外部服务无法被本地 fake 证明为无副作用。
- 真实第三方插件、真实模型服务、真实 QQ/SnowLuma 与发行包验收不在本轮；示例和 fake 结果不能作为长期健康认证。
- 未新增插件市场、依赖安装、代码分析、配置 schema、Skill 模板表达式、MCP 或通用长任务平台。
- 按用户要求未 `git add`、提交、推送、打包或替换 EXE；工作树保留供复核。
