# 修复计划与 SnowLuma 手动注入监听集成

日期：2026-10-22

状态：已实施；实现、测试与逐项验收状态见 [12 第二轮实施报告](12-phase-2-s1-s2-manual-injection-report.md)。M 级真实 QQ / SnowLuma / 打包 EXE 项仍未验收。结合 09 再次复核和用户最新确认；与历史文档中“自动启动 QQ / 受管 launch”建议冲突时，以本文为准。

## 1. 本轮范围与目标

本轮交付两项正确性修复，以及应用内的 SnowLuma 探测、手动注入和监听控制。

用户自行启动 QQ。应用检测并展示现有进程；只有用户点击对应进程的“注入并监听”后，才请求 SnowLuma 执行注入并建立账号消息通道。应用不自动启动 QQ，不因发现新进程、恢复配置或健康检查而自动注入。

上一轮 R1–R7 原复现场景已经修复，最近验证为 29 个测试文件、173 项测试、类型检查与 desktop:build 通过；本轮仍须解决 S1、S2 的新增边界。此前通过不替代本轮验收。

### 必须交付

- S1：服务配置与实际执行目标一致，阻止旧路由继续向已撤销端点外发。
- S2：所有受支持宿主遵守暂停、恢复和会话作用域策略。
- SnowLuma 管理连接、鉴权、进程列表、用户主动触发注入、监听、停止与错误展示。
- 按进程管理注入，按 QQ 身份管理账号数据；保持多实例隔离。
- 旧 attach 接入模式保留，用于用户已在外部完成注入的场景。
- 自动化、假管理服务集成测试，以及真实双 QQ 手动流程验收。

### 本轮不交付

- 自动启动/重启/关闭用户 QQ、随安装包携带 QQ。
- 自写注入器、直接从 Electron 加载 SnowLuma 原生模块、修改 SnowLuma 注入算法。
- 未获授权的 SnowLuma 二进制再分发或自动下载部署。
- 完整世界书、长期记忆、情绪、浏览器自主活动与跨实例通信。
- “内置 Agent + 插件工具统一运行时”的全面重构；另立后续阶段，当前保留兼容宿主。

## 2. 修复 S1：校验和执行使用同一个服务版本

### 现象与位置

位置：src/providers/router.ts 的 #assertStillAuthorized、#invoke 和适配器调用闭包；src/agent/engine.ts 的异步媒体任务。

复现：先取得云端识图服务的 resolution，随后将同 id 服务改成本地地址，并撤销云端上传。旧调用校验当前本地配置通过，却把旧云端 provider 交给适配器，继续向旧地址发送图片。

复核证据见 09 文档及 test/diagnostics/phase1-second-review-repro.mts。

### 实施决策

本轮优先采用“执行计划版本变化就拒绝”的方式，避免排队任务自动改用另一服务或凭据：

1. 解析时创建不可变 ExecutionPlan，携带 accountId、conversationId、capability、providerId、modelId、adapterId、providerRevision 和必要的媒体要求。
2. providerRevision 覆盖 baseUrl、location、模型能力/输入、适配器、媒体传输方式及影响请求的参数。凭据通过 credentialRevision 单独标识，计划里不包含原始密钥。
3. 进入端点队列前检查一次，取得并发许可后、每次真正提交前再检查一次；fallback 和 retry 也必须重复检查。
4. 当前授权、能力、媒体外发许可、服务版本或凭据版本不满足时，返回稳定错误（如 execution_plan_stale / authorization_revoked），不静默重解析到其他端点。
5. 版本校验通过后，执行上下文、实际地址、模型、适配器和凭据必须来自同一份受控快照，不继续读取旧闭包里的另一个 target。
6. 新请求使用最新计划；旧计划失败后是否重新发起由用户操作或明确的无副作用重规划策略决定，不自动重提付费请求。

凭据读取、版本校验、执行上下文创建之间的异步边界同样需要防护；在真正提交前确认所持凭据版本。已经发出的网络请求不能被追溯撤回，应记录执行版本和结果未知状态。

### 已提交远端任务

已被远端接受的任务单独保存执行时的服务身份、远端任务 ID 和凭据版本引用。后续查询/取消继续针对原服务，不因用户修改 baseUrl 而把同一个远端 ID 发给新服务。

本轮至少保证配置变化后安全中断/提示，不能错误迁移任务。完整的远端 ID 持久化与重启查询另有实现任务；尚未实现时明确标为 interrupted/unknown，不重复生成，不宣称已经恢复查询。

## 3. 修复 S2：暂停覆盖整个自动处理路径

### 现象与位置

位置：src/instances/instance.ts 的宿主分发/发送上下文、src/core/core.ts 的策略变更与宿主切换、src/host/worker.ts 的回调和发送。

复现：plugins 模式下保存 agentEnabled=false，再收到消息，旧 Worker 插件仍然回复。

### 实施决策

将现有 UI 的暂停含义统一为“暂停当前作用域的自动处理与自动发送”，Agent、旧插件以及纳入支持范围的自定义宿主均遵守。

- 入站身份校验、去重与历史保存继续进行；策略允许后才进入自动回调。
- 在公共入口检查账号/私聊/群聊/具体会话策略，不只在 AgentEngine 内检查。
- 所有自动出口携带 origin=automatic、accountId、conversationId、turnId/jobId、sessionEpoch 和策略代际。
- 旧插件 ctx.send、返回 reply、延迟任务 deliver 都需在实际发送前复核；排队出站消息也要在执行发送时检查，不能只在 enqueue 时检查。
- 人工发送使用显式 origin=manual 的受控入口；普通插件不得自行选择 manual 绕过暂停。
- 暂停使当前作用域的自动 turn 失效/取消；恢复后处理新消息，不默认回放暂停期间积压的消息和旧回复。
- 对已发往 QQ 的动作只能报告事实，不承诺回收已经发送的消息。
- 暂停期间不写入自动生成记忆或继续旧策略下的插件状态；旧回调状态写入用代际保护。
- 自定义宿主只能通过受控上下文执行自动动作；绕开接口的受信任 Node 代码不在安全沙箱保证内。

## 4. SnowLuma 集成依据与边界

已检查本地发行目录：D:/app/QQAgent/QQ Agent/resources/app/snowluma，版本 1.14.19。

本地 server-D1_OR83N.js 中存在：

| SnowLuma 管理接口 | 用途 |
| --- | --- |
| GET /api/processes | 获取 QQ 进程及状态 |
| POST /api/processes/:pid/load | 请求对指定进程加载/注入 |
| POST /api/processes/:pid/unload | 请求卸载/释放，实际行为与结果需要验证 |
| POST /api/processes/:pid/refresh | 请求刷新或重连该进程 |
| GET /api/processes/:pid/probe-login | 主动探测账号身份，作为可选手动动作 |

这些是已检查版本的管理实现，不是承诺永久兼容的公共协议。实现前为 1.14.19 固定请求、响应、鉴权和错误样例；未来版本使用适配器明确声明兼容范围。

管理接口登录/会话鉴权与 OneBot accessToken 是两套凭据，不可混用。必须实际验证登录、凭据过期和首次引导流程；不得绕过或静默代用户接受许可/隐私协议。

已确认实现入口，但尚未执行真实注入；本轮必须补真实环境证据。

## 5. 目标结构

```text
React 实例管理页面
  → Accompany 本地控制 API（鉴权）
    → SnowLumaManager / 版本化管理客户端
      → 独立 SnowLuma 运行时进程
        → 已由用户启动的 QQ 进程（按选择的 PID 注入）
    → InstanceSupervisor / AccountSession
      → OneBot 通道（核对 selfId 后绑定账号）
      → Agent 或兼容插件宿主
      → 统一策略与自动发送出口
```

建议目录：

```text
src/injection/snowluma/manager.ts     管理运行时连接、认证、版本、进程操作
src/injection/snowluma/api-client.ts  管理 HTTP 请求和 DTO 适配
src/injection/snowluma/backend.ts     保留已有 OneBot 端点发现与 attach
src/injection/process-binding.ts     进程代际、操作串行、账号绑定
```

可按规模合并小文件，但不能把管理 API、QQ 身份和对话逻辑全部混进 QqInstance。

现有 launch boolean 同时描述“启动 QQ/注入运行时”，语义过粗。新增明确能力：processDiscovery、manualInjection、runtimeStart、runtimeStop、unload；保留 attach。launch 不应因支持手动注入而被解释为自动启动 QQ。

## 6. 运行时来源与生命周期

### 首批方案

优先连接用户已有、已运行的完整 SnowLuma 发行包，在设置里配置 runtimeDir 和管理地址。应用负责版本检查和管理接口连接；用户无需离开 Accompany 页面去选择注入目标。

如需在 Accompany 内启动 SnowLuma 后台服务，提供独立的“启动运行时”按钮；使用用户指定的完整发行包与兼容 Node 运行环境。不是启动 QQ。该子功能不得妨碍首批外部运行时方案交付。

- 本地目录的 check-node-version.cjs 要求 ^22.13.0 或 >=23.4.0；不要直接用本项目最低 Node 20，或假设 Electron 内置 Node 与其原生绑定兼容。
- 独立进程启动，显式参数、工作目录、隐藏后台窗口、日志与超时；不直接在 Electron 主进程加载原生 .node/.dll。
- 外部已运行的 runtime 标记 owned=false；应用启动的标记 owned=true。关闭或删除一个账号实例不能结束其他账号共用的 runtime。
- 不关闭/重启用户 QQ；不按 QQ.exe 进程名批量清理。
- 校验并关闭 SnowLuma 的自动发现即注入行为（如该版本的 autoLoadOnDiscovery），必要时拒绝进入手动模式并说明原因；不能只保证 Accompany 不调用 load，却放任后台自动注入。

管理地址首批限定本机回环；管理凭据保存在受保护凭据库，不进入 Renderer、日志或诊断导出。Renderer 通过自己的控制 API 访问，不直接拿 SnowLuma 登录会话。

## 7. 用户操作与状态机

```text
打开 Accompany
→ 连接/检查 SnowLuma 管理服务
→ 展示已运行 QQ 的进程及可用状态
→ 用户选择进程，点击“注入并监听”
→ 校验进程身份、去重操作，调用 load
→ 等待 SnowLuma 接入就绪/账号登录
→ 读取可用账号端点，连接 OneBot，校验 selfId
→ 取得账号租约，加载该账号档案
→ 按策略开始监听和自动处理
```

本地 UI 统一状态：runtime_unavailable、discovered、injecting、awaiting_login、connecting、listening、stopped、error。保留 SnowLuma 原始状态与错误供诊断；角色卡缺失单独显示 Agent 待配置，不误报为注入失败。

- PID 只标识当前进程，结合 executablePath、creationTime/等价代际形成 ProcessIdentity。用户点击前重新确认，防止 PID 复用。
- 一个主进程可能有多个 QQ 子进程；以 SnowLuma 可加载目标为准，不把所有 QQ.exe 都当成独立账号。
- 注入前 QQ 号可能未知，显示“身份待识别”；不得用上次缓存 QQ 号提前写入账号历史。
- 账号归属通过 SnowLuma 状态与 OneBot selfId 一致性校验后确认。不能把目录里第一个 onebot 配置当作当前选中 PID 的身份。
- 同进程注入串行并幂等，按钮重复点击不重复 load；账号已被其他槽位持有时不重复启动宿主。
- PID 与账号映射不明确时明确提示并要求选择/核实；不能自动绑定猜测账号。
- 检测到用户在外部已注入的进程，提供“开始监听”，复用已连接 runtime，不再次注入。
- 健康检查只报告/恢复当前授权的消息连接；不因失败调用 load，也不自动重新注入。

### 启动恢复与用户意图

默认 manualOnly=true。应用重启后恢复配置和显示，但不自动执行注入或开始监听。原有 desired=running 和 Supervisor 自动启动路径需要迁移/拦截，不能保留旧行为造成开机自动监听。

用户点击后生成本次会话的操作授权；“停止监听”立即撤销。连接短暂中断可在用户已开启监听期间重连 OneBot；QQ 进程退出或代际变化后撤销授权，重新注入必须再点击。

## 8. 三种停止语义

| 操作 | 结果 |
| --- | --- |
| 暂停自动处理 | 保留连接和历史接收，所有自动宿主停止响应；允许授权的人工发送 |
| 停止监听 | 取消该实例消息连接、队列、宿主和任务，释放账号租约；不隐式卸载或关闭 QQ |
| 请求卸载 | 显式调用指定 PID 的 unload，先停止本应用对该进程的监听；确认/展示实际状态，不声称一定能完全移除进程内模块 |

外部 runtime 或其他应用可能也在使用同一注入进程；请求卸载应显示会影响该进程协议连接。普通停止/退出不自动卸载外部共享资源。应用自有 runtime 的退出策略需检查活跃引用，不能因某个实例停止而杀全局服务。

## 9. 控制 API 与桌面界面

新增 API 为目标设计，不是当前已实现接口：

| Accompany API | 行为 |
| --- | --- |
| GET /injection/runtime | 管理连接、版本、鉴权和所有权状态 |
| GET /injection/processes | 经过归一化、脱敏的目标列表；只读，不触发注入 |
| POST /injection/processes/:pid/inject-and-listen | 用户显式操作；body 带 ProcessIdentity、目标槽位和预期账号（可选） |
| POST /injection/processes/:pid/listen | 对外部已注入目标开始监听 |
| POST /injection/processes/:pid/refresh | 用户主动刷新；不混入自动 load |
| POST /injection/processes/:pid/unload | 显式卸载请求；校验进程代际 |
| POST /slots/:id/stop | 沿用停止实例入口，明确其仅停止监听 |

所有写操作使用现有控制面鉴权；用户触发来源与请求 ID 可审计。耗时操作返回 operationId，UI 订阅状态而不是重复 POST。客户端超时后查询已有 operation 状态，不自动重发注入。

页面至少展示：PID、路径/版本（可得时）、账号/身份待识别、SnowLuma 状态、监听状态、Agent 状态、最近错误。按状态提供注入并监听、开始监听、停止监听、暂停/恢复、刷新、请求卸载。

设置页展示 runtimeDir、管理地址、兼容版本、凭据状态与连接测试；原生二进制不从 UI 任意路径直接执行。

## 10. 验收标准

类型：A=自动化；I=本地集成/假服务；M=真实 QQ 或真实发行包。

| 编号 | 类型 | 场景与通过标准 |
| --- | --- | --- |
| FIX-01 | A/I | 云端 resolution 排队后改成本地并撤销上传：旧云端调用为 0，明确 stale/revoked |
| FIX-02 | A/I | 排队后更换 baseUrl/adapter/model/credential：不得用新配置校验旧配置执行 |
| FIX-03 | A/I | retry/fallback 前修改版本或授权：后续提交被拦截；未知付费结果不再提交 |
| FIX-04 | I | 已接受的远端任务遇服务修改：查询/取消不发给新服务，不盲目重复生成 |
| FIX-05 | A/I | Agent 和旧插件分别暂停账号及某个群：消息继续保存，但无自动调用/发送 |
| FIX-06 | I | 插件回调/媒体任务/出站排队期间暂停：旧回包不发送、旧状态不覆盖，恢复不回放 |
| FIX-07 | I | 暂停后人工发送正常；插件不能伪造人工来源绕过检查 |
| SN-01 | I/M | QQ 未启动或 runtime 不可用：状态明确，无自动启动 QQ、注入或假在线 |
| SN-02 | I | 反复 GET 进程列表、SSE 重连、定时探测：load 调用为 0 |
| SN-03 | I/M | 发现两个 QQ 目标：只对用户选中的进程调用 load，另一个无变化 |
| SN-04 | I | 同 PID 连点/并发/HTTP 超时重试：操作只启动一次，可按 operationId 查询 |
| SN-05 | I | PID 已退出或复用：旧 ProcessIdentity 被拒绝，不注入新进程 |
| SN-06 | I/M | 注入成功但未登录：保持等待，登录并校验账号后才加载对应数据 |
| SN-07 | I | 身份不符、重复账号、PID 映射不明确：拒绝误绑定，不写其他账号目录 |
| SN-08 | I/M | 外部已注入目标：只开始监听，不重复 load、不接管外部 runtime 所有权 |
| SN-09 | I/M | 停 A 实例：A 的连接和任务释放；B 正常；两个 QQ 都不被应用关闭 |
| SN-10 | I | 应用重启且旧 desired=running：只恢复展示，不自动注入/监听 |
| SN-11 | I/M | QQ 退出、runtime 断开或权限不足：错误可诊断；无自动重新注入和无限重试 |
| SN-12 | I/M | 管理鉴权失败/过期、首次引导未完成、版本不兼容：明确阻断，凭据不外泄 |
| SN-13 | I/M | 启用手动模式：SnowLuma 自动发现注入行为关闭；发现新 QQ 不自动 load |
| SN-14 | I/M | 停止监听、暂停、卸载三个动作分别验证，不混淆；卸载失败真实显示 |
| SN-15 | I/M | 同 runtime 多账号、应用退出/删除单实例：不终止外部 runtime 或其他账号 |
| SN-16 | M | 两个真实 QQ 各自手动注入和监听、交错私聊/群聊：身份、发送目标、历史隔离正确 |
| SN-17 | M | 打包后的 EXE 连接用户现有 SnowLuma，完成发现→注入→监听→停止全流程 |

若选做“启动运行时”按钮，额外验证 Node/原生模块兼容、首次许可流程、进程所有权、日志脱敏与退出；不得将其成功算作自动启动 QQ 的实现。

本轮完成门槛：上述必选项逐项有通过证据，既有 173 项测试不回归，类型检查与桌面构建通过；真实 M 项未执行时保持未验收。第一阶段其他真实模型与并行状态验收缺口仍按 04/08/09 文档补齐，不因本轮完成自动关闭。

## 11. 开发分配与顺序

| 工作包 | 内容 | 依赖 | 交付 |
| --- | --- | --- | --- |
| FIX-A | 服务执行计划/凭据版本一致性，S1 | 无 | 实现、FIX-01～04 回归 |
| FIX-B | 公共暂停/作用域入口与自动出口，S2 | 无 | 实现、FIX-05～07 回归 |
| SL-A | 版本化管理客户端、鉴权和只读进程探测 | 固化 1.14.19 DTO/认证样例 | 假服务测试、连接与进程 API |
| SL-B | ProcessIdentity、显式注入操作、账号绑定、手动恢复 | SL-A | 操作状态机、租约和防重复集成 |
| SL-C | 实例页面、按钮与停止语义 | SL-A/B、FIX-B | 可操作 UI、有效状态和错误展示 |
| SL-D | 真实双 QQ、版本兼容、桌面包验证 | 全部 | 本表验收记录、脱敏日志与问题清单 |

先完成两项修复与管理协议验证，再打通一个真实手动注入闭环，随后验证双实例与异常场景。公共 Core/instance/server 文件指定集成人，避免相互覆盖。

## 12. 分发方式与参考

默认使用用户自行取得的完整 SnowLuma 发行目录，不将其原生组件复制进 Accompany 安装包。该版本 EULA 5.4 对并入第三方安装包、自动部署和商业使用有事先书面授权要求；取得相应授权后，再单独安排随包分发与升级方案。连接现有服务也必须遵守实际许可和首次使用流程。

- 本机实现证据：snowluma/package.json、server-D1_OR83N.js（约 13961～14002 行）、index.mjs 的 HookSession/HookManager、check-node-version.cjs。
- 官方说明：https://github.com/SnowLuma/SnowLuma
- 官方 EULA：https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md
- 原复核与复现：09-phase-1-second-review.md、test/diagnostics/phase1-second-review-repro.mts。
