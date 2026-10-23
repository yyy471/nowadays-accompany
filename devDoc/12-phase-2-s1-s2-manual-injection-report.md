# 第二轮修复与 SnowLuma 手动注入实施报告

对应文档：[09 再次复核](../devDoc/09-phase-1-second-review.md)、[10 修复与手动注入集成](10-fixes-and-manual-snowluma-integration.md)。

本轮完成 FIX-A/FIX-B 两项正确性修复，以及 SL-A/SL-B/SL-C 的管理客户端、手动注入操作状态机与桌面界面。真实 QQ、真实 SnowLuma 发行包和打包 EXE 的 M 级验收尚未执行，状态保持未验收。

## 1. 实现摘要

### 1.1 FIX-A：执行计划与服务/凭据版本一致

- `ResolvedTarget` 增加 `providerRevision` 与可选 `credentialRevision`；provider revision 覆盖 baseUrl、location、模型能力/输入、适配器、媒体传输方式和其他影响请求的配置。
- `ProviderRouter.#currentTarget()` 每次提交前重新读取当前配置与策略，依次校验能力开关、绑定、授权、模型、适配器、provider revision、凭据 revision 和 fallback 绑定；任一变化返回稳定的 `execution_plan_stale` / `credential_stale` 原因，不再用新配置校验旧 target。
- `#invoke` 在取得并发许可后、每次 retry/fallback 前、异步读取凭据后都重新校验，执行上下文、地址、模型、适配器与凭据均来自同一份最新受控快照。
- 排队任务在配置撤销后不会把请求发往旧端点；日志与任务投递把 `auto_reply_paused` 视为跳过，不误报为发送失败。
- 已接受的远端任务当前不会被迁移到新服务；但远端任务 ID 未持久化，重启后只能标记 `interrupted`，不能恢复查询/取消（见第 4 节）。

关键位置：[src/providers/router.ts](../src/providers/router.ts) 的 `#currentTarget`、`#invoke`、`providerRevision`。

### 1.2 FIX-B：暂停覆盖全部自动宿主与自动出口

- `QqInstance` 增加统一的 `automaticReplyAllowed` 判定；内置 Agent、旧插件 Worker、自定义宿主共用同一入口。
- 暂停在四个位置生效：宿主分发前、宿主上下文 `send`、宿主返回后的回复发送、媒体/任务投递 `#deliver`。暂停期间消息继续落盘、入站去重与历史保存继续执行。
- 人工发送仍走 `Core.send`，不经过自动暂停门禁；普通插件没有选择 `origin=manual` 的入口。
- 配置变化导致宿主重载时推进 `hostEpoch`，暂停前在途插件的旧状态写入与旧回复失效；恢复后不回放暂停期间积压的自动回复。
- `Core.status()` 增加 `automaticPaused`，桌面端可区分“账号级自动处理暂停”和“入站背压暂停”。

关键位置：[src/instances/instance.ts](../src/instances/instance.ts) 的 `#dispatchHost`、`#deliver`、`#automaticAllowed`；[src/core/core.ts](../src/core/core.ts) 的宿主装配与策略状态。

### 1.3 SL-A：SnowLuma 1.14.x 管理客户端

- 新增 `SnowLumaManager`：管理登录、Bearer token、401 后单次重登录、进程列表、load/unload/refresh/probe-login。
- 管理地址只允许回环地址；拒绝 URL 内凭据、query、hash；管理密码只从系统凭据库读取，不进入配置、日志、SSE、错误或诊断。
- 版本严格限定 `1.14.x`；`hookAutoLoad=true` 时允许只读进程列表，但拒绝所有注入/卸载类变更，并给出明确原因。
- 稳定错误码：`snowluma_runtime_unavailable`、`snowluma_password_missing`、`snowluma_version_incompatible`、`snowluma_autoload_enabled`、`snowluma_auth_failed`、`snowluma_consent_required`、`snowluma_totp_required`、`snowluma_password_change_required`、`snowluma_unreachable`、`snowluma_protocol` 等。
- 新增 `InjectionSettingsStore`，持久化 runtimeDir / baseUrl（不含密码）；控制 API 提供运行时状态、进程列表与只写密码设置。

关键位置：[src/injection/snowluma/manager.ts](../src/injection/snowluma/manager.ts)、[src/injection/settings.ts](../src/injection/settings.ts)。

### 1.4 SL-B：ProcessIdentity、显式注入与账号绑定

- `ManualInjectionService` 实现四个操作：`inject-and-listen`、`listen`、`refresh`、`unload`。
- 每次操作重新读取进程列表并校验 ProcessIdentity：PID 不存在、路径变化返回 `injection_process_stale`；QQ 号与预期不符返回 `injection_identity_mismatch`。
- 仅对用户选中的 PID 调用 load；外部已注入目标提供 listen，不重复 load。
- 注入后轮询进程/probe-login，直到取得 QQ 号；登录超时返回 `injection_login_timeout`，期间不写账号数据。
- 槽位未绑定账号时，取得 QQ 号并通过账号租约检查后重绑槽位、持久化 slots，再启动实例；账号已被其他槽位持有时返回 `injection_account_in_use`，不重复启动宿主。
- 操作按 PID 串行；相同请求仅在操作进行中合并，返回同一 operationId。完成后允许再次发起：已注入进程会跳过 load，卸载后再次注入会重新 load；操作结果按 operationId 短期保留可查。
- “开始监听/停止监听/请求卸载”分离：停止监听只停止实例并释放租约；卸载先停监听，再显式调用 SnowLuma unload，并在 UI 提示会影响共享该进程的其他应用。
- 桌面端默认 `manualStartOnly`：重启只恢复槽位展示，不自动注入或监听；健康检查不调用 load。

关键位置：[src/injection/manual.ts](../src/injection/manual.ts)、[src/core/core.ts](../src/core/core.ts) 的 `#rebindSlotAccount` 与注入方法。

### 1.5 SL-C：桌面界面

- 运行槽位页新增 SnowLuma 进程卡片：PID、路径、QQ 身份/身份待识别、注入/连接状态、原始 status/error、Slot 选择、注入并监听、开始监听、刷新、请求卸载。
- 槽位卡片区分：
  - 开始监听：只 attach 当前 runtime/账号端点，不注入；
  - 停止监听：只断开本应用连接、队列、宿主并释放账号租约；
  - 暂停自动处理：保留连接与历史接收，允许人工发送；
  - 请求卸载：显式调用 SnowLuma unload。
- 设置页新增 SnowLuma 管理卡片：runtimeDir、管理地址、管理密码（只写）、清除密码、检查连接、版本/兼容/鉴权/密码/hookAutoLoad/协议同意状态。
- 修复静态 UI 托管时 `API_PREFIXES` 未包含 `injection` 导致接口被 SPA fallback 吞掉的问题，并加入带 `uiDir` 的回归测试。

关键位置：[desktop/renderer/src/pages/Slots.tsx](../desktop/renderer/src/pages/Slots.tsx)、[desktop/renderer/src/pages/Settings.tsx](../desktop/renderer/src/pages/Settings.tsx)、[src/service/server.ts](../src/service/server.ts)。

## 2. 验证结果

### 2.1 自动化

- `npm run typecheck`：通过（核心、测试、渲染进程）。
- `npm test`：32 个测试文件、203 项全部通过。
- `npm run desktop:build`：renderer、main、preload 构建通过。

新增/扩展的测试：

| 文件 | 覆盖 |
| --- | --- |
| `test/phase2-fixes.test.ts` | FIX-01/02：旧云端计划在改配置/撤销上传后 stale 且 0 调用；模型参数变化、凭据替换、retry 前配置变化均被拦截；FIX-05/06/07：插件与群作用域暂停、消息保存、人工发送、在途回复丢弃与不回放 |
| `test/phase2-snowluma.test.ts` | 管理登录/重登录、进程列表 0 load、鉴权/同意/TOTP/版本/hookAutoLoad 错误、显式 load/refresh/unload、运行时不可用、控制 API 只写密码、带 UI 时 injection 路由不被 SPA 吞掉、Core 注入→绑定→online→停止不卸载→listen 不重复 load→unload |
| `test/phase2-manual-injection.test.ts` | 注入一次并绑定、并发合并、完成后重复点击不重复 load、卸载后再次注入重新 load、仅加载选中 PID、PID/路径变化、账号不符、账号已租用、未登录等待与超时、外部注入只 listen、绑定槽位保护、卸载前停监听、未知槽位不产生副作用、在线槽位也重验身份 |

### 2.2 复现脚本

`test/diagnostics/phase1-second-review-repro.mts` 已改为修复后断言：

- S1：旧云端计划调用被拒绝，`reason=execution_plan_stale`，适配器调用数 0。
- S2：暂停后旧插件不回复，消息仍保存 1 条，回复数 0。

输出示例：

```json
{"name":"validate_current_but_execute_old_endpoint","data":{"current":"http://127.0.0.1:8000/v1","allowCloudUpload":false,"staleCode":"capability_unavailable","staleReason":"execution_plan_stale","calls":[]}}
{"name":"paused_legacy_plugin","data":{"configuredAgentEnabled":false,"storedMessages":1,"replies":0}}
```

`staleCode` 是对外错误类别，具体稳定原因在 `reason=execution_plan_stale`；旧端点调用为 0。

### 2.3 桌面 UI 假服务冒烟

使用临时 `uiDir=desktop/renderer/dist`、假 SnowLuma 管理服务、回环 backend 与 FakeChannel 在浏览器中实际操作：

1. 打开运行槽位页：只读进程列表显示 PID 4242、路径、QQ 10001、未注入；管理版本 1.14.19、hookAutoLoad 关闭。
2. 点击“注入并监听”：load 1 次，槽位自动绑定 10001，实例 online，角色卡加载，操作显示成功与 operationId。
3. 点击“暂停自动处理”：槽位显示已暂停，连接与实例保持在线。
4. 点击“停止监听”：实例 stopped，进程仍“已注入/协议已连接”，load 次数不变。
5. 点击“开始监听”：实例重新 online，load 次数仍为 1。
6. 点击“请求卸载”并确认：实例停止，进程变为未注入/未连接。
7. 设置页保存管理设置：密码输入框类型为 password，保存后不回填；状态显示版本、鉴权、密码已保存。

该冒烟只证明 UI 与假服务链路，不代表真实 QQ、真实 SnowLuma 或打包 EXE 验收。

## 3. 验收状态

| 编号 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| FIX-01 | 通过（A/I） | `phase2-fixes`：旧云端调用 0；新复现脚本 `reason=execution_plan_stale` |
| FIX-02 | 通过（A/I） | baseUrl/location、模型参数、凭据变化均被 revision 拦截 |
| FIX-03 | 通过（A/I） | retry 前配置变化只发生 1 次调用并被 stale 拦截；未知结果不再 fallback（既有 R2 覆盖） |
| FIX-04 | 部分 | 配置变化不会迁移远端任务、不会盲目重提；远端任务 ID 未持久化，重启后标记 interrupted，无法恢复查询/取消 |
| FIX-05 | 通过（A/I） | Agent 与旧插件账号/群作用域暂停，消息保存，无自动调用 |
| FIX-06 | 通过（A/I） | 在途插件回复不发送、旧状态因 hostEpoch 失效、恢复不回放 |
| FIX-07 | 通过（I） | 暂停后 `Core.send` 正常；插件上下文无 manual origin 入口 |
| SN-01 | 通过（I） | 运行时不可用明确报错；manual-only 不启动、不注入；进程列表只读 |
| SN-02 | 通过（I） | 反复 GET 进程列表 load=0；SSE/健康检查无 load 调用 |
| SN-03 | 通过（I） | 两个目标仅选中 PID load；另一个保持未注入 |
| SN-04 | 通过（I） | 同请求并发合并为同一 operation；完成后重复点击不重复 load；可按 operationId 查询；客户端超时后用 operationId 查询而不自动重发 |
| SN-05 | 通过（I） | PID 不存在或路径变化被 `injection_process_stale` 拒绝 |
| SN-06 | 通过（I） | 未取得 QQ 号时保持等待并超时失败，不绑定/不启动；取得账号后才重绑与加载 |
| SN-07 | 通过（I） | 预期账号不符、槽位预留账号不符、账号已被其他槽位租用均拒绝，不写其他账号目录 |
| SN-08 | 通过（I） | 外部已注入目标只 listen，load=0；外部 runtime 所有权保持 external |
| SN-09 | 部分 | 停止监听不 unload、不关闭外部进程；两个真实实例同时停止/释放的 M 级证据未执行 |
| SN-10 | 通过（I） | manual-only 重启恢复槽位、desired 不触发 startAll；不自动注入/监听 |
| SN-11 | 部分 | 进程退出/登录超时/管理鉴权失败可诊断；代码无自动重新注入路径；缺少真实断线故障注入 |
| SN-12 | 通过（I） | 密码缺失/错误、TOTP、协议同意、必须改密、版本不兼容均阻断且不泄露密码 |
| SN-13 | 通过（I） | hookAutoLoad=true 时只读列表可用、所有变更被拒绝；不修改 SnowLuma 外部配置 |
| SN-14 | 通过（I） | 测试与 UI 冒烟分别验证暂停、停止监听、卸载；卸载结果真实回显 |
| SN-15 | 部分 | 应用不拥有/不终止外部 runtime；同 runtime 多账号与退出/删除单实例的 M 级证据未执行 |
| SN-16 | 未验收（M） | 需要两个真实 QQ 交错私聊/群聊证据 |
| SN-17 | 未验收（M） | 需要打包 EXE 连接真实 SnowLuma 的完整流程证据 |

第一阶段遗留：ISO-09、API-14、API-15 仍为未验收（M），本轮不改变其状态。

## 4. 已知限制与后续

1. **FIX-04 远端任务恢复**：当前只保证不迁移、不重提；需要持久化执行时的 provider/adapter/baseUrl/credential revision 与远端任务 ID，重启后继续向原服务查询/取消。
2. **ProcessIdentity 代际**：SnowLuma 1.14.19 进程 DTO 不提供 creationTime，本轮使用 PID + executablePath + uin 重新校验。若 PID 被复用且路径与账号完全相同，无法区分新旧进程；后续若 DTO 提供启动时间应纳入身份。
3. **操作状态粒度**：UI 展示 running/succeeded/failed 与实例状态（awaiting_login/online 等），未逐帧展示 injecting/connecting；成功后以实例状态与进程列表为准。
4. **SN-09/SN-15 多实例**：已有单实例停止/卸载与外部所有权证据，缺双实例真实 QQ 与同 runtime 多账号的 M 级验证。
5. **M 级验收**：SN-16、SN-17、ISO-09、API-14、API-15 以及真实模型/QQ 验收仍未执行；不因本轮 A/I 通过而关闭。
6. **启动恢复语义**：manual-only 保留 desired=running 的展示但不自动监听；如果希望重启后完全清空旧期望状态，需要额外的迁移策略，本轮未改。
