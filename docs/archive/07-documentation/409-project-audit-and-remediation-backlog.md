# 项目严苛审计与待处理修复清单（409）

> **创建日期**：2026-11-27 · **性质**：项目级代码漏洞、安全边界、架构债务、交付短板与操作体验严苛审计清单（非已确认需求，涉及修订既有 `DL-xx` 边界的条目已单独标注「需先确认决策」）。  
> **维护约定**：后续逐项排查、方案确认、修复提交与复验结论直接在本文件对应条目下补充记录，不再另起编号文件。  
> **关联入口**：[当前状态看板](../../STATUS.md) · [产品方向与决策 161](../../161-digital-life-direction-decisions.md) · [现行规范总览](../../specs/README.md)

---

## 0. 使用方式与修复总览

本清单将全仓库多轮源码审查中确认的实际问题分为 5 个维度共 **24 项**，按风险与投入产出比分为 `P0`（止血必修）、`P1`（高优先工程/安全/交付修复）与 `P2`（结构拆分与中长期体验重构）。

### 0.1 优先级总表（逐项排查索引）

| 编号 | 类别 | 优先级 | 问题摘要 | 是否涉及修订 `DL-xx` | 状态 |
| --- | --- | :---: | --- | :---: | :---: |
| [BUG-01](#bug-01-windows-退出桌面硬杀后端导致优雅关闭失效与孤儿进程风险) | 运行时 Bug | **P0** | Windows 退出桌面调用 `kill("SIGTERM")` 触发强杀，`app.close()` 永不执行 | 否 | 已修复，独立复验通过 |
| [BUG-02](#bug-02-桌面拉起后端静默吞掉-stderr启动失败无诊断信息) | 运行时 Bug | **P0** | 桌面壳 `child.stderr.resume()` 吞掉全部后端错误输出 | 否 | 已修复，独立复验通过 |
| [SEC-01](#sec-01-pi-工程子代理路径围栏被内置-powershell-bash-直接击穿) | 安全边界 | **P0** | Pi 锁定了 `write/edit` 路径，却无隔离放开 `powershell/bash` | 边界已确认（`DL-195`） | 已修复，独立复验通过 |
| [SEC-02](#sec-02-本地-mcp-命令执行与普通角色脚本执行击穿隔离并继承完整宿主环境) | 安全边界 | **P0** | 工作空间与本机命令曾共用开关，普通角色脚本缺少文件权限约束，子进程环境过宽 | 方案 A 已确认（`DL-59`） | 已修复，针对性独立复验通过 |
| [DELIV-01](#deliv-01-桌面生产包直接打包未编译-ts-源码与-tsx且缺-node-24-构建流水线) | 交付打包 | **P0** | 生产包用 `tsx` 现场转译 TS，缺少干净 Windows 机可验证的发行包 | 否 | 已修复并离线验证，干净机验收待办 |
| [BUG-03](#bug-03-roleaccesswithstore-每次操作现开现关两个-sqlite-库且实例未统一) | 性能/稳定性 | **P1** | 无连接复用；单次查询同步开关双库，且 `RoleService` / `ConversationService` 绕开统一入口 | 否 | `[ ]` 待排查 |
| [BUG-04](#bug-04-维护窗口暂停多角色采用串行轮询最坏线性卡死) | 性能/稳定性 | **P1** | 模型与媒体维护曾逐角色串行等待停机 | 否 | 已修复，R4 精准独立复验通过 |
| [BUG-05](#bug-05-pi-工程模型参数硬编码阉割reasoning-固定关闭且输出上限-8k) | 功能缺陷 | **P1** | Pi 注册模型固定 `reasoning: false` / `maxTokens: 8192` | 否 | `[ ]` 待排查 |
| [BUG-06](#bug-06-对话页默认背景硬编码绑定夏澄资产) | 功能缺陷 | **P1** | 普通角色对话背景直接写死引用 `assets/themes/xiacheng/` | 否 | 已修复，R5 精准复验通过 |
| [BUG-07](#bug-07-扩展-sse-瞬断直接清空列表销毁全部微页且-backendbaseurl-永久缓存) | 运行时 Bug | **P1** | `use-extensions.ts` `onerror` 清空 `items` 销毁全部 iframe；后端换端口后 `backendBaseUrl` 永不刷新 | 否 | 已修复，R5 精准复验通过 |
| [BUG-08](#bug-08-windows-下命令与-skill-脚本超时只杀父进程不回收进程树) | 运行时 Bug | **P1** | `command_run` 与 `skill_run` 超时仅 `child.kill()`，未复用进程树回收，孙进程泄漏为孤儿 | 否 | 已修复，独立复验通过 |
| [SEC-03](#sec-03-热扩展子进程未限制网络访问且-kv-存盘无容量与限频保护) | 安全边界 | **P1** | Node `--permission` 不拦网络；KV 同步全量覆写 `manifest.json` 无上限 | 否 | `[ ]` 待排查 |
| [SEC-04](#sec-04-windows-静态密钥文件权限失效与独立模式-http-鉴权cors-过宽) | 安全边界 | **P1** | `0o600` 在 NTFS 失效且未接系统密钥链；CORS 放行全部 `localhost:*` / `file://` | 需确认（`DL-121`） | `[ ]` 待排查 |
| [UX-01](#ux-01-几乎全部角色配置写入都强制先停机把并发锁转嫁给用户) | 操作体验 | **P1** | 改世界书、传表情图、调额度、给服饰改名均要求角色先 `stopped` | **是**（`DL-148`） | `[ ]` 待排查 |
| [UX-02](#ux-02-首次上手与后台工程能力存在冷启动悬崖) | 操作体验 | **P1** | 无开箱引导；Pi 工程池默认空且隐藏工具，用户根本发现不了核心功能 | 需确认（`DL-201`） | `[ ]` 待排查 |
| [UX-03](#ux-03-后台工程pi缺乏历史记录与失败过程日志) | 功能短板 | **P1** | 任务结束胶囊即消失，失败/超时后无法查看改了什么、死在哪步 | 否（增只读视图） | `[ ]` 待排查 |
| [UX-04](#ux-04-设置页两处操作仍使用阻塞式原生-windowconfirm) | 视觉/交互 | **P1** | `Settings.tsx` 离开草稿拦截与结束任务确认弹出原生 `window.confirm` | 否 | 已修复，R5 精准复验通过 |
| [DELIV-02](#deliv-02-真实云端模型多模态与媒体服务全链路联调长期缺位) | 质量/验证 | **P1** | 624+ 离线测试掩盖真实模型、长上下文、TTS、ComfyUI 实机并发缺陷 | 否 | `[ ]` 待排查 |
| [ARCH-01](#arch-01-后端与前端存在多个两千至三千行级上帝文件) | 架构债务 | **P1** | `conversation-service.ts` 3803 行、`Settings.tsx` 2116 行等触发仓库体积告警 | 否 | `[ ]` 待排查 |
| [ARCH-02](#arch-02-桌面端四条通信通道混用且动态页退化为-15-秒全量轮询) | 架构债务 | **P2** | `desk://`、直连 `127.0.0.1`、`nd-ext://`、`ipcMain` 混用；动态页无推送 | 否 | `[ ]` 待排查 |
| [ARCH-03](#arch-03-记忆检索纯依赖字面-fts5-trigram缺乏语义召回能力) | 核心能力 | **P2** | 换个同义说法即召回失效，制约精细记忆模型的实际效果 | 需确认（`DL-51`） | `[ ]` 待排查 |
| [ARCH-04](#arch-04-启动期同步-ipc-阻塞令牌暴露给渲染层与维护期隐性-on-存储扫描) | 性能/架构 | **P2** | `preload` 同步 `sendSync` 并暴露 `hostHeaders`；`MediaMaintenance` 逐角色开关双库 | 否 | `[ ]` 待排查 |
| [UX-05](#ux-05-单角色迁移与角色工作空间笔记缺少桌面图形入口) | 功能短板 | **P2** | 角色导出/导入停留在 CLI；用户需手工翻数据目录看角色 Markdown 笔记 | 否 | `[ ]` 待排查 |
| [UX-06](#ux-06-多窗口跳转丢失上下文与主角色自改权限割裂) | 操作体验 | **P2** | 对话页跳设置返回后丢子窗口；主角色能管别人却改不了自己任何配置 | 部分需确认（`DL-159`） | `[ ]` 待排查 |

### 0.2 建议修复分期路线

1. **阶段一 · 止血与边界诚实（P0）**：`BUG-01` → `BUG-02` → `SEC-01` / `SEC-02` → `DELIV-01`
2. **阶段二 · 稳定性、性能与核心体验修补（P1）**：`BUG-03` → `BUG-04` → `BUG-07` → `BUG-08` → `BUG-05` → `BUG-06` → `UX-04` → `SEC-03` / `SEC-04` → `UX-01` / `UX-02` / `UX-03` → `DELIV-02`
3. **阶段三 · 结构治理与长期护城河（P2）**：`ARCH-01` → `ARCH-04` → `ARCH-02` → `UX-05` / `UX-06` → `ARCH-03`

---

### 0.3 Round 1 独立复验（2026-11-27）

三名 `gpt-6.2-sol` 分别负责托管退出与主进程、诊断与封面、工具进程树。主代理审查了全部实现、依赖锁与测试，在本地 Windows Node 24.22.2 独立运行门禁。

| 验证项 | 冻结版本结果 |
| --- | --- |
| 后端与 Pi | 后端类型检查通过，正式测试 635/635。离线验收 21/21 步、81 个场景通过，交付测试 5/5，真实服务调用 0。Pi 5/5。 |
| 渲染器与壳 | 渲染器检查通过，37 个 CSS 违规 0，单测 185/185，生产构建通过。桌面壳 21/21。 |
| 串行 Electron | 受限沙箱全量 28/29（原有 27 项 + 新增诊断用例通过）；第 29 项 `managed-backend-shutdown.e2e.cjs` 在宿主 Windows 会话复跑通过（含 `taskkill /T /F` 杀树成功，耗时 5,324ms，父子 PID 归零），29/29 闭环。 |
| 进程核对 | 测试前后逐一比对进程名、PID 和启动时间，均为原有的 3 个 Node 进程、0 个 Electron 进程。新增残留 0。 |

后端报告为 `test-results/backend-acceptance/p5-2026-11-27T09-13-40-920Z-c4278a00/summary.json`，最终 Electron 报告为 `test-results/desktop-e2e/e2e-2026-11-27T09-25-23-212Z-5168c833/gates.json`。各命令输出和基线比对保存在 `test-results/409-round1-lead/`。本轮覆盖 Windows 仓库态和本地离线服务。

---

## 一、运行时 Bug 与性能隐患（`BUG-*`）

### BUG-01 Windows 退出桌面硬杀后端，导致优雅关闭失效与孤儿进程风险

- **优先级**：P0 · **状态**：已修复，独立复验通过
- **Round 1 定稿**：托管后端从 stdin EOF 接收退出请求。桌面先完成窗口退出确认，再结束 stdin 并等待原子进程的 `close` 及日志排空。5 秒后仍存活才在 Windows 上执行有界的 `taskkill /PID <pid> /T /F`。最后通过 `app.quit()` 继续 Electron 退出事件链。独立 CLI 保留信号退出。
- **修复与审查**：1 号独占桌面主进程并实现后端的 `--watch-stdin`。主代理在类型检查中发现 `Promise.withResolvers` 不适配后端 ES2022 类型库，退回改用现有库支持的 Promise 写法。日志文件在启动尝试内同步打开，消除了退出期间仍在异步轮转的窗口。退出等待复用同一子进程的停止 Promise；启动重试须等上一实例完成收尾。若系统拒绝杀树且子进程仍存活，桌面拒绝启动第二个托管实例。
- **已复验**：在真实后端的 `listen` 回调尚未返回时送 EOF，输出一次 `shutdown_complete`，没有发布 `listening`。正常启动后送 EOF 也只关闭一次。实窗同时启用 Cordis 扩展并运行等待离线模型的 Pi 工程，直接退出请求被取消后服务健康，从托盘确认退出后主进程触发 `will-quit`，后端、Pi 和扩展的 PID 全部消失。重启同一数据目录，原工程为 `cancelled`，相应记录没有异常中断误报；模拟拒响应后端并持有活子进程，在宿主 Windows 会话 5 秒后触发 `taskkill.exe /PID <pid> /T /F` 返回 `backend_taskkill_complete`（总耗时 5,324ms），活后端及子进程全部回收。[后端启动期测试](../../../apps/backend/tests/integration/managed-shutdown.test.ts) · [实窗托管退出测试](../../../apps/desktop/tests/e2e/managed-backend-shutdown.e2e.cjs)
- **冻结版本实窗证据**：受限沙箱全量报告 `test-results/desktop-e2e/e2e-2026-11-27T09-25-23-212Z-5168c833/managed-backend-shutdown.e2e.log`（仅因沙箱拒绝 `taskkill` 未过强杀断言）；宿主 Windows 会话复跑 `node apps/desktop/tests/e2e/managed-backend-shutdown.e2e.cjs` 退出码 0（`backend=7464 / pi=35768 / extension=18176` `livePidCount=0`、`status=cancelled`、`interruptedCount=0`、`backend_taskkill_complete pid=52180`、`elapsedMs=5324`）。
- **证据位置**：
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L125-L134)（`stopManagedBackend` 调用 `backendChild.kill("SIGTERM")`）
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L325)（`app.on("will-quit", stopManagedBackend)` 同步返回不等待）
  - [apps/backend/src/main.ts](../../../apps/backend/src/main.ts#L20-L32)（监听 `SIGINT` / `SIGTERM` 调 `app.close()`）
- **根因分析**：
  在 Windows 平台上，Node.js 的 `ChildProcess.kill("SIGTERM")` 底层直接调用 Win32 `TerminateProcess`，**不会**触发子进程的 `SIGTERM` 回调。因此每次 Windows 用户从托盘退出应用，托管后端都被立即强杀，`app.close()`（含 `pi.close()`、`conversation.close()`、`memoryRuntime.close()`、`sceneImages.close()`、`extensions.close()`、`appStore.close()`）均无机会执行。
- **实际后果**：
  1. SQLite WAL 未正常收口，`installation-lock.sqlite` 靠 OS 强制释放；
  2. 正在运行的 `ExtensionHost` 子进程、外部 stdio MCP 进程、Pi 工程进程可能残留为孤儿进程；
  3. 下次启动被迫走崩溃恢复路径，将原本可控收尾的任务统一标为 `PROCESS_INTERRUPTED` / `interrupted_unknown`。
- **修复建议**：
  1. 在后端仅限宿主令牌（`X-Nowadays-Host-Token`）可调的内部路由中增加 `POST /v1/internal/shutdown`（或改 `stdio` 保留 `pipe` 监听 stdin EOF 触发 `app.close()`）；
  2. 在 Electron `before-quit` 中拦截退出，先通知后端优雅关闭并等待子进程 `exit`（设 4～5 秒超时兜底，注意与 `WindowIntent` 关窗确认不冲突）；
  3. 超时仍未退出时，在 Windows 上用 `taskkill /PID <pid> /T /F` 回收整棵进程树，再调用 `app.exit()`。
- **验收标准**：
  - Windows 实机启动桌面并开启至少 1 个热扩展和 1 个活跃任务，从托盘退出后后端日志明确打印优雅关闭完成，残留进程（Node / Pi / Extension）为 0，重启后无异常 `PROCESS_INTERRUPTED` 误报。

---

### BUG-02 桌面拉起后端静默吞掉 `stderr`，启动失败无诊断信息

- **优先级**：P0 · **状态**：已修复，独立复验通过
- **Round 1 定稿**：每次托管启动保留最近三次的双流日志，位置为 `userData/logs/backend-latest.log` 及其编号备份。启动失败摘要使用已脱敏的最近 16 KiB stderr。日志目录可用时，失败封面在「重新连接」之后提供「打开日志目录」。
- **修复与审查**：2 号负责日志、封面、preload 与打包文件白名单，1 号接入主进程。主代理退回会丢弃超长末行的大小限制，要求覆盖跨块 UTF-8、敏感字段、Digest 授权头和无换行尾部。首次实窗验证还发现后端在公布端口后、健康检查中崩溃时会丢失 stderr；修正后封面显示退出码 43 和最后一行。
- **已复验**：四次启动只保留最近三份，写入路径不可用时仍可从内存诊断；真实 SQLite 排他锁与缺入口分别在封面显示占用及模块错误，日志保留堆栈。点击日志按钮经受信 IPC 抵达固定目录，测试替身记录 `shell.openPath` 的入参。释放锁后重连成功，失败日志轮转为 `.1`。原启动封面的五种外接会话均通过，失败时重连保有默认焦点，外接会话没有创建托管日志。[日志单测](../../../apps/desktop/tests/unit/backend-log.test.cjs) · [诊断实窗测试](../../../apps/desktop/tests/e2e/managed-backend-diagnostics.e2e.cjs)
- **证据位置**：
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L82-L91)（`child.stderr.resume()` 直接丢弃错误流）
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L118-L121)（退出时仅报错 `本地服务在启动期间退出（${code}）。`）
- **根因分析**：
  为避免 stderr 管道缓冲满阻塞子进程而直接调用了 `.resume()`，既未保存环形缓冲区，也未落盘到用户日志目录。
- **实际后果**：
  在干净机器或打包态出现 `better-sqlite3` ABI 错配、数据库锁占用（`INSTALLATION_BUSY`）、权限不足或脚本异常时，用户与开发者完全看不到任何堆栈或错误码。
- **修复建议**：
  1. 维护最近 8～16 KiB 的 `stderr` 环形文本缓冲，并将 `stdout/stderr` 同步写入 `<userData>/logs/backend-latest.log`（启动时轮转保留最近 3 份，脱敏敏感头/密钥）；
  2. 启动失败时提取可读错误摘要（如 `INSTALLATION_BUSY` / 缺模块 / 权限错误）显示在 `BootGate` 封面，并提供「打开日志目录」按钮。
- **验收标准**：
  - 人工制造后端启动失败（例如占锁或破坏入口文件），封面能展示具体诊断摘要且日志文件完整记录退出前错误堆栈。

---

### BUG-03 `RoleAccess.withStore` 每次操作现开现关两个 SQLite 库，且实例未统一

- **优先级**：P1 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [apps/backend/src/application/role/role-access.ts](../../../apps/backend/src/application/role/role-access.ts#L35-L69)
  - [apps/backend/src/storage/core/role-storage.ts](../../../apps/backend/src/storage/core/role-storage.ts#L14-L47)
  - [apps/backend/src/application/role/role-service.ts](../../../apps/backend/src/application/role/role-service.ts#L64-L69)（私自 `new RoleAccess(appStore, dataRoot)`，未复用 `app.ts` 注入实例）
  - [apps/backend/src/application/conversation/conversation-service.ts](../../../apps/backend/src/application/conversation/conversation-service.ts#L788-L808)（多处直接持有或绕开 `RoleAccess` 打开 `RoleStorage`）
- **根因分析**：
  1. 每次调用 `withStore` / `withStoreAsync` 都会执行 4 次同步 `fs.statSync`，打开 `business.sqlite` 并运行完整 schema/索引/FTS5 校验，**同时无条件打开大部分读请求根本用不到的 `execution.sqlite`**，回调结束后立即关闭两库；
  2. `RoleService` 与部分模块并未共享同一个 `RoleAccess` 实例，直接引入连接池容易在 Windows 角色删除/迁移时因另一处残留句柄引发 `EBUSY`。
- **实际后果**：
  在多角色 + 动态页 15 秒轮询 + 高频消息读写场景下，产生海量同步文件打开/关闭、WAL 检查点与 Windows Defender 扫描开销，拖垮响应延迟并加剧 `SQLITE_BUSY`。
- **修复建议**：
  1. **先统一注入**：全后端只创建一份 `RoleAccess` 实例并注入 `RoleService`、`ConversationService`、`MemoryRuntime` 等全部服务；
  2. **连接复用与显式驱逐**：在 `RoleAccess` 内按 `roleId` 复用 `RoleStore` 连接（带空闲回收，如 60s～120s），提供 `evict(roleId)` / `closeAll()` 供角色删除、单角色迁移与 `app.close()` 立即关闭句柄；
  3. **懒开 `execution.sqlite`**：将 `checkpoint` 改为按需懒打开，普通读取/配置/动态查询完全不碰检查点库；每个进程周期首次打开角色库时做全量 schema/FTS5 校验，后续直接复用。
- **验收标准**：
  - 压测 5 个角色并发聊天 + 动态页刷新，SQLite 打开次数下降 >95%；Windows 下角色删除（含立即清理目录）与单角色迁移回归测试全部通过，无 `EBUSY` 句柄泄漏。

#### R4 角色连接与检查点独立复验（2026-11-27）

每个后端应用实例拥有一份 `RoleAccess`。角色、对话、记忆和资源服务共享这份实例。角色借用时验证索引是否就绪，冷打开时检查路径、业务库 schema 与 FTS5。首次读取检查点才打开已有的执行库并校验；角色初始化和迁移暂存仍创建双库。最后一个租约释放后开始 60 秒空闲计时。删除角色时先收尾运行工作，再封锁新借用、排空连接，最后移除索引并按保留选项处理目录。

主审核人在 Windows、Node 24.22.2 上对修复前基线 `5c9bc46` 和 R4 使用同一负载。计数点位于隔离源码副本中 SQLite 连接成功打开并设置 PRAGMA 之后。每个阶段从角色连接冷缓存开始，角色与模型配置已就绪。

| 实测负载 | 修复前业务库 / 执行库 | R4 业务库 / 执行库 |
| --- | ---: | ---: |
| 5 个角色各读取 3 个动态接口，共 15 个 HTTP GET | 15 / 15 | 5 / **0** |
| 5 个角色同时聊天，另发 60 个动态 GET | 175 / 175 | 5 / 5 |

聊天分别进入五个窗口的离线模型调用，五个调用都到达后统一放行。每个窗口最终都持久化了 1 条完整回复。动态请求读取唤醒、活动和记忆批次，均读取完整响应体。混合负载的角色 SQLite 打开次数从 **350 降到 10，下降 97.14%**。原始测量脚本与独立复验日志位于本机 `apps/backend/test-results/r4-review/`。

---

### BUG-04 维护窗口暂停多角色采用串行轮询，最坏线性卡死

- **优先级**：P1 · **状态**：已修复，R4 精准独立复验通过。
- **证据位置**：
  - [apps/backend/src/bootstrap/app.ts](../../../apps/backend/src/bootstrap/app.ts#L147-L163)
  - [apps/backend/src/application/media/media-maintenance.ts](../../../apps/backend/src/application/media/media-maintenance.ts#L69-L70)
- **根因分析**：
  `pauseRoles` 在 `for (const roleId of roleIds)` 中逐个调用 `requestStop(roleId)` 并 `while` 睡眠 100ms 等待最多 20 秒，直到当前角色停稳才通知下一个角色停止。
- **实际后果**：
  修改被 5 个活跃角色共同绑定的全局模型服务时，最坏串行卡死 `5 × 20s = 100s`，极易造成前端请求超时与体验假死。
- **修复建议**：
  1. 先对全部目标角色并发发起 `requestStop(roleId)`，记录本次发起名单；
  2. 用单一共享 `deadline` 配合事件通知（`RoleActivityService` 状态变更回调，辅以兜底检测）并行等待全部角色进入 `stopped`；
  3. `MediaMaintenance` 同样以 `claim` 释放回调替代 100ms 轮询等待在途调用归零。
- **验收标准**：
  - 新增集成测试：3 个角色各需 1 秒收尾时，`pauseRoles` 总耗时接近 1 秒（而非 ≥3 秒），超时部分回滚语义保持不变。

#### R4 维护窗口独立复验（2026-11-27）

应用将模型与媒体暂停委托给同一个 `RoleActivityService`。它在一轮中向所有活动目标发出请求，订阅确认事件后复读状态，共用一个默认 20 秒的期限。成功和失败都按输入顺序报告本次发起且已经停稳的角色。管理工具在结束维护后恢复部分暂停名单。媒体更新按服务种类和 ID 等待最后一笔调用释放，并在写入前复查角色依赖。[停机协调实现](../../../apps/backend/src/application/role/role-activity-service.ts) · [媒体维护实现](../../../apps/backend/src/application/media/media-maintenance.ts) · [集成用例](../../../apps/backend/tests/integration/maintenance-coordination.test.ts)

Windows、仓库 Node 24.22.2、离线夹具下，主审核人独立执行以下 23 项，全部通过。

| 项目 | 结果 |
| --- | --- |
| 新增维护协调集成 | 5/5。三个角色各在收到请求 1 秒后确认，实测 **1004.554 ms**。顺序为请求 1、2、3，随后确认 1、2、3。另覆核部分超时详情、单项发起失败后继续并保留原错误、同服务的最后释放与不同服务隔离、虚拟时钟推进 20 秒后的在途名单和重试。 |
| 角色活动与媒体维护 | `role-activity` 9/9，`media-maintenance` 7/7，含运行中角色的可保存节点确认和真实回环语音试听的结算。 |
| 既有多角色超时与管理工具 | `workflow-simplification-fixes` 按名称选择 1/1，`preset-assistant-outfits` 按名称选择 1/1。部分暂停后抛错时，验证了管理工具回执与角色恢复后的实际活动态。 |

---

### BUG-05 Pi 工程模型参数硬编码阉割（`reasoning` 固定关闭且输出上限 8K）

- **优先级**：P1 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [apps/pi-mcp/src/worker.mjs](../../../apps/pi-mcp/src/worker.mjs#L57-L63)
- **根因分析**：
  注册 `nowadays` provider 给 Pi SDK 时写死了 `reasoning: false, contextWindow: 128000, maxTokens: 8192` 以及 `thinkingLevel: "off"`。
- **实际后果**：
  即使用户在工程池中配置了支持长输出/深度思考的顶级模型（如 Gemini 4 / Claude / GPT / DeepSeek），Pi 编写完整热扩展（含前端 HTML/CSS/JS + 后端逻辑 + 单测）时也会因 8K 输出截断或关闭思考而频繁返工、浪费 Token。
- **修复建议**：
  1. 取消 `worker.mjs` 对 `maxTokens: 8192` 与 `reasoning: false` 的一刀切硬编码，改为按厂商/模型能力或工程池成员级可选配置透传 `contextWindow`、`maxTokens` 与 `thinkingLevel`；
  2. 若成员未显式配置，根据协议与模型家族提供更贴合实际编码任务的默认值（如 `maxTokens` 提升至 16384 或 32768）。
- **验收标准**：
  - 集成测试验证工程池成员参数正确透传到 Pi SDK 请求体，单次生成 >8K 字符扩展文件不再被 SDK 侧截断。

---

### BUG-06 对话页默认背景硬编码绑定夏澄资产

- **优先级**：P1 · **状态**：已修复，R5 精准复验通过
- **证据位置**：
  - [apps/desktop/renderer/src/pages/Conversation.tsx](../../../apps/desktop/renderer/src/pages/Conversation.tsx#L19-L20)
- **根因分析**：
  对话舞台底图静态导入了 `../assets/themes/xiacheng/dialogue-day.webp` 与 `dialogue-night.webp`。
- **实际后果**：
  所有用户新建的普通角色在未生成过场图前，全部强制绑定夏澄主题目录下的背景资产；一旦用户自定义了主角色外壳或维护多名角色，资产归属与角色身份割裂。
- **修复建议**：
  1. 将默认通用书房底图抽离为角色无关的平台基础资产目录（如 `assets/themes/study/`）；
  2. 后续支持按角色可选配置自定义默认对话背景（缺省回退通用书房底图）。
- **验收标准**：
  - 移除 `Conversation.tsx` 对 `xiacheng` 目录的直接硬编码依赖，所有现有 E2E 与主题切屏截图回归通过。
- **R5 实施与复验（2026-11-27）**：将 `dialogue-day.webp` 与 `dialogue-night.webp` 迁至 `apps/desktop/renderer/src/assets/themes/study/` 并更新 `Conversation.tsx` 导入；渲染器 `check`（37 CSS 0 违规）与生产构建通过。

---

### BUG-07 扩展 SSE 瞬断直接清空列表销毁全部微页，且 `backendBaseUrl` 永久缓存

- **优先级**：P1 · **状态**：已修复，R5 精准复验通过
- **证据位置**：
  - [apps/desktop/renderer/src/extensions/use-extensions.ts](../../../apps/desktop/renderer/src/extensions/use-extensions.ts#L22-L40)（第 39 行 `source.onerror = () => { setItems([]); setNotices({}); setConnection('reconnecting'); }`）
  - [apps/desktop/renderer/src/conversation/backend-base.ts](../../../apps/desktop/renderer/src/conversation/backend-base.ts#L2-L22)（首次非空结果永久缓存，无失效机制）
  - 对照设计规范 [frontend-refinement-v2-plan.md](../../design/character-studio/frontend-refinement-v2-plan.md#L74)（明确要求“绝不因 `onerror` 清空数组”）
- **根因分析**：
  1. 虽然 `catalogStatus` 依赖 `connection === 'reconnecting'` 避免了把重连误显示为空态邀请笺，但 `onerror` 仍调用了 `setItems([])`，直接把当前挂载的所有扩展微页、挂件、浮层 `<iframe>` 全部卸载，导致用户玩到一半的微页状态瞬间清零；
  2. `backendBaseUrl()` 一旦拿到非空地址就永远缓存该 Promise，如果未来支持后端崩溃自动拉起（`--port 0` 动态换端口），所有依赖它的 SSE 会永远重连死端口。
- **修复建议**：
  1. `use-extensions.ts` 在 `onerror` 时仅设 `setConnection('reconnecting')` 与禁用派发提示，**保留已有 `items` 快照**直到下次 `snapshot` 到达再做最小差异更新（仅卸载真正下线或换版的槽位）；
  2. 为 `backendBaseUrl` 增加缓存失效入口（或在收口至 `ARCH-02` 单一 `desk://` 同源流后直接淘汰直连地址缓存）。
- **验收标准**：
  - 模拟扩展 SSE 瞬断重连，正在打开的扩展微页 `<iframe>` 保持挂载且内部状态不丢失；断连期间显示重连状态并在恢复后自动同步最新快照。
- **R5 实施与复验（2026-11-27）**：`use-extensions.ts` 在 `onerror` 仅失效地址缓存并置 `reconnecting`（保留已有 `items`/`notices`，`CLOSED` 时 1s 后带 `{ refresh: true }` 重建流并校验旧流守卫）；`backend-base.ts` 新增 `invalidateBackendBaseUrl()` 与 `{ refresh?: boolean }`，`use-window-session.ts` 流关闭时同步失效缓存。精准复验：`backend-base.test.ts` 2/2 通过，Electron 39 定点 `extension-ui-slots.e2e.cjs` 实证微页挂载后真实断流重连全程复用同一 `<iframe>` 引用且 DOM 标记未丢。

---

### BUG-08 Windows 下命令与 Skill 脚本超时只杀父进程，不回收进程树

- **优先级**：P1 · **状态**：已修复，独立复验通过
- **Round 1 定稿**：后端锁定 `koffi@3.3.8`，在包内维护 Win32 Job Object 原语和纯 ESM launcher。宿主先绑定空 launcher，再通过 IPC 派发目标命令。超时和正常结束都关闭 Job 句柄，覆盖父进程先结束的情况。Pi 继续使用自己的实现。
- **修复与审查**：3 号将两个工具接入同一启动逻辑，保留各自的输出限制、诊断码与 Skill 目标进程参数。主代理退回了固定 100 毫秒的排空窗口。正常路径现在等目标 `close` 并确认已转发输出，持有管道的进程树始终受原任务超时约束。
- **已复验**：在 Windows 上对两个入口分别运行两种孙进程。持有输出管道的长任务超时，返回各自原有的超时结果；父进程正常退出、孙进程忽略管道时，返回成功。四组均验证真实孙进程 PID 消失，正常退出用例还验证了 900,000 字节以上 stdout 的尾部及 stderr 的截断上限。模拟 Job 初始化失败时，目标脚本没有执行。Pi 原有 5 项测试通过。本机从已安装的 Pi 副本补齐后端依赖，核对了两个锁文件中全部 21 条 koffi 相关记录，未进行联网净安装。[进程树回归](../../../apps/backend/tests/integration/process-tree.test.ts)
- **证据位置**：
  - [apps/backend/src/mcp/local-server.ts](../../../apps/backend/src/mcp/local-server.ts#L298-L301)（超时仅 `child.kill()`）
  - [apps/backend/src/application/conversation/agent-tools.ts](../../../apps/backend/src/application/conversation/agent-tools.ts#L1191-L1194)（超时仅 `child.kill("SIGKILL")`）
- **根因分析**：
  你在 `apps/pi-mcp/src/process-tree.mjs` 里专门解决了 Windows 下“短命父进程派生长期孙进程”的残留问题，但 `local-server.ts` 的 `command_run` 和 `agent-tools.ts` 的 `skill_run` 都没有接入进程树回收，超时只杀直接子进程 PID。
- **实际后果**：
  角色通过脚本或命令拉起的子任务（如子脚本、本地服务、命令行工具）在超时后会变成后台孤儿进程，持续占用 CPU/内存或锁住工作空间文件。
- **修复建议**：
  将 `process-tree` 回收逻辑抽成共享工具模块，统一接入 `command_run`、`skill_run`（以及 `BUG-01` 桌面退出兜底），超时或关闭时确保整棵进程树清零。
- **验收标准**：
  - 复刻 Pi 进程树测试用例到 `command_run` 与 `skill_run`：短命父进程派生长期孙进程并触发超时后，存活孙进程数为 0。

---

## 二、安全漏洞与权限边界问题（`SEC-*`）

### SEC-01 Pi 工程子代理路径围栏被内置 `powershell` / `bash` 直接击穿

- **优先级**：P0 · **状态**：已修复，独立复验通过 · **决策影响**：安全模型已确认（关联 [DL-195](../../161-digital-life-direction-decisions.md#dl-195-受托管工程-mcp-与后台开发子代理)）
- **证据位置**：
  - [apps/pi-mcp/src/worker.mjs](../../../apps/pi-mcp/src/worker.mjs#L5-L31)（严格限制 `write`/`edit` 工具在 `cwd`）
  - [apps/pi-mcp/src/worker.mjs](../../../apps/pi-mcp/src/worker.mjs#L61-L63)（授予 `+powershell` / `bash` 完整壳执行权）
  - [apps/pi-mcp/src/server.mjs](../../../apps/pi-mcp/src/server.mjs#L32-L38)（无 OS 沙箱、透传 `USERPROFILE` / `APPDATA`）
- **根因分析**：
  `workspaceTools` 和 [tool-proxy.ts](../../../apps/backend/src/mcp/tool-proxy.ts#L42-L51) 营造了“Pi 被严格限制在草稿目录且无法接触凭据”的架构假象，但无限制的 `powershell` / `bash` 工具让 Pi 拥有与当前 Windows 用户等价的完整文件系统与进程访问权——直接可读走 `<appRoot>/secrets/master.key`、`app.sqlite` 及用户任意个人文件。
- **修复建议（二选一，须先决策确认）**：
  - **方案 A（真收敛，推荐）**：将 Pi 默认可执行的命令收口为受控验证工具（仅允许在草稿目录内用 Node 24 `--permission --allow-fs-read=<cwd>,<node_modules> --allow-fs-write=<cwd>` 跑测试脚本），默认不暴露通用 `powershell/bash`；若确需完整 Shell，须显式设为高风险开关并提示用户；
  - **方案 B（诚实边界）**：若业务明确需要 Pi 具备任意 Shell 能力，则在 UI「设置 → 工程」中用醒目安全提示告知用户“开启工程子代理即授予其当前账户级本机命令执行权限”，并同步将 `master.key` 迁出明文可读区（见 `SEC-04`），避免给用户虚假安全感。
- **验收标准**：
  - 确认边界写入 `161` 与 `specs/role-config-and-activity.md`；若采用方案 A，补充负向安全集成测试：Pi 尝试读取 `<appRoot>/secrets/master.key` 或越界写文件被拒绝。

---

#### SEC-01 实施与针对性复验记录（2026-11-27）

按 DL-195 修订落地：默认关闭完整本机 Shell（`allow_shell = 0`，`app.sqlite` V15→V16），Pi 默认工具白名单收敛为草稿围栏的 `read`/`write`/`edit` 与受控 `draft_test`（Node `--permission` + 干净环境 + 30s 超时 + 64 KiB 上限，拒绝 `!`/`{`/`}`/`*`/`?` 等 glob 元字符），默认 worker 环境不再透传 `USERPROFILE`/`APPDATA`/`PATH`；「设置 → 工程」新增默认关闭的 `allowShell` 高风险开关直接保存且仅影响新工程（在途工程保留启动快照）。共享 Skill 与常规外部 MCP 契约保持不变。

- **精准复验（Node 24.22.2）**：
  - `node --test apps/pi-mcp/test/workspace.test.mjs apps/pi-mcp/test/lifecycle.test.mjs`：**8/8 通过**（验证 `allowShell=undefined/false/true` 工具集合、真实 SDK `read`/`write`/`edit` 拒绝外部 `secrets/master.key` / junction / 硬链接、`draft_test` 正常执行与 `--permission` 拒绝读外部密钥及派生子进程、超时回收与输出上限、完整进程树回收 `survivors=0`）；
  - 后端 `npm run typecheck` + `engineering-settings.test.ts` / `managed-pi.test.ts` / `pi-shared-tools.test.ts` + `storage-schema.test.ts`：**全部通过**（含 V15→V16 迁移保旧池、同父任务新工程读取最新 `allowShell`）；
  - 渲染器 `npm run check`（37 CSS 0 违规）+ `engineering-settings.test.ts`（**5/5 通过**，含默认关闭、风险文案与局部 `PUT { allowShell }`）+ `npm run build` 通过；
  - `node scripts/check-docs.mjs` **0 错误 0 警告**，`git diff --check` 通过。
- **范围说明**：本轮按精准测试纪律执行，未跑无关全量后端单测或全量 Electron E2E。

### SEC-02 本地 MCP 命令执行与普通角色脚本执行击穿隔离并继承完整宿主环境

**P0 · 方案 A 已实施。** 审计时，开启工作空间读写也会取得本机命令能力。普通 MCP 连接与命令进程继承完整宿主环境。普通角色执行 Skill 时省略可选包目录，跳过 Pi 已使用的 Node 权限标志。用户于 2026-11-27 确认按独立资源开关处理这三处边界。[DL-59](../../161-digital-life-direction-decisions.md#dl-59-资源使用控制仅提供开关不增加额外授权)

#### 2026-11-27 实施与精准复验

- 同一 stdio 入口保留握手名，按启动模式只注册工作空间三个工具或单个 `command_run`。桌面导入命令资源默认停用，全局与角色开关均标明本机用户权限及工作空间外访问风险。导入后由用户绑定角色。[本地服务](../../../apps/backend/src/mcp/local-server.ts) · [后端使用说明](../../../apps/backend/README.md#4-本地-mcp-和通用-skill)
- 普通 MCP 连接使用 SDK 平台默认环境及显式资源配置，角色调用与连接探测分别写入实际目录。命令按平台白名单运行，以当前 Node 目录开头查找程序。首次子进程观测发现 Windows 会额外补入 `PATH` 和用户目录等键；修订后，一次性启动器在派生命令或 Skill 前清除目标白名单以外的自身环境键，保留原有 Job Object 回收流程。[连接端](../../../apps/backend/src/mcp/client.ts) · [Windows 启动器](../../../apps/backend/src/infra/process-launcher.mjs)
- 普通角色与 Pi 共用必填包目录的 `skill_run`。真实路径重叠时返回 `SKILL_WORKSPACE_PATH_CONFLICT`，避免工作区写权限连带覆盖包目录。正常布局只读包、读写本次工作空间，禁止派生子进程。[执行入口](../../../apps/backend/src/application/conversation/agent-tools.ts) · [存储与自主执行规范](../../specs/storage-memory-and-autonomy.md)

三名 `gpt-6.1-terra` 按文件分工编码，主代理逐行审核并在 Windows、仓库 Node 24.22.2 上独立复验。

| 复验入口 | 实测结果 |
| --- | --- |
| 后端 `typecheck` 与 6 个指定单测文件 | 类型检查通过，`mcp-local`、`extension-import`、`mcp-execution`、`skill-run`、`process-tree`、`pi-shared-tools` 共 36/36。收紧输入 PATH 后，`mcp-local` 单文件复验 5/5。 |
| MCP 与普通角色负向断言 | 两模式握手和精确目录、非法模式拒绝、两跳环境过滤、按名启动 `node` 与 `cmd`、角色与探测目录覆盖均通过。普通角色可读取包及读写工作区，写包、读取外部假 `master.key`、派生子进程均返回 `ERR_ACCESS_DENIED`。自身超时与 Windows 命令后代回收通过。 |
| 指定对话专项 | 仓库实际入口为 `conversation-review.acceptance.ts`（10/10）及 `conversation-fixes.acceptance.ts`（5/5）。 |
| 渲染器 | `npm run check` 通过（37 个 CSS，0 违规），`extension-import.test.ts` 4/4，生产构建成功。Vite 提示主包超过 500 kB。 |
| 收尾 | 文档巡检 0 错误、0 警告，`git diff --check` 通过。与启动前 PID 和启动时间对照，Node、Electron、esbuild、cmd 无新增残留。 |

后端复验日志与两份逐场景回执保存在本机 `test-results/sec-02-1795778710282/`。本轮范围为上述 Windows 精准验证。

---

### SEC-03 热扩展子进程未限制网络访问，且 KV 存盘无容量与限频保护

- **优先级**：P1 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [apps/backend/src/application/extensions/extension-process.ts](../../../apps/backend/src/application/extensions/extension-process.ts#L46-L51)
  - [apps/backend/src/application/extensions/extension-host.ts](../../../apps/backend/src/application/extensions/extension-host.ts#L238-L246)
  - [apps/backend/src/application/extensions/extension-files.ts](../../../apps/backend/src/application/extensions/extension-files.ts#L140-L146)
- **根因分析**：
  1. Node 24 `--permission` 仅限制 fs/child_process/worker，**不限制网络**，扩展后端进程可以主动外连公网或访问本机其他端口（绕过前端 iframe 的 `connect-src 'none'` CSP）；
  2. `api.kv.set` 既无键名黑名单（如 `__proto__` / `constructor` / `prototype`）与单值/总容量上限，也无写入节流，每次调用在主进程同步执行 `fs.writeFileSync` + `fs.renameSync` 写整份 `manifest.json`。
- **修复建议**：
  1. **KV 加固与解耦**：将 KV 从 `manifest.json` 拆出独立存储（如独立 `kv.json` 或 SQLite 表），限定单扩展 KV 键数量（如 ≤256）、单值体积（如 ≤64 KiB）、总容量（如 ≤1 MiB）、用 `Object.create(null)` + 拒绝原型键、改为合并防抖异步落盘；
  2. **网络安全边界**：明确在规范中记录 Node `--permission` 不阻断网络的边界，或评估在扩展 manifest 中加入显式网络访问声明（默认阻断外连）。
- **验收标准**：
  - 集成测试验证超大 KV 写入、原型键写入、高频写入返回明确错误码且不阻塞主进程；`manifest.json` 与业务 KV 变更解耦。

---

### SEC-04 Windows 静态密钥文件权限失效与独立模式 HTTP 鉴权/CORS 过宽

- **优先级**：P1 · **状态**：`[ ]` 待排查 · **决策影响**：涉及独立 CLI/API 使用方式（关联 [DL-121](../../161-digital-life-direction-decisions.md#dl-121-本地客户端通信http-api-与-ssecli-和桌面共用入口)）
- **证据位置**：
  - [apps/backend/src/security/secret-cipher.ts](../../../apps/backend/src/security/secret-cipher.ts#L72-L85)
  - [apps/backend/src/http/router.ts](../../../apps/backend/src/http/router.ts#L91-L120)
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L186) · [settings-preload.cjs](../../../apps/desktop/electron/settings-preload.cjs#L11) · [api.ts](../../../apps/desktop/renderer/src/api.ts#L42-L44)
- **根因分析**：
  1. `SecretCipher` 的 `0o700` / `0o600` 在 Windows NTFS 下不起作用，`master.key` 裸存于 `<appRoot>/secrets/`，任意同账户进程一键即可解出全部厂商 API Key；
  2. `router.ts` 允许所有 `http://localhost:*`、`http://127.0.0.1:*`、`file://` 的 CORS Origin，独立运行后端时若未传 `--host-token` 则完全无鉴权；
  3. 桌面态 `main.cjs:186` 仅对 `GET` 请求自动补签 `X-Nowadays-Host-Token`，迫使 `settings-preload.cjs` 把明文 `hostHeaders` 暴露给渲染层 `window.nowadaysDesk` 供 `api.ts` 手动拼头。
- **修复建议**：
  1. 桌面托管态优先使用 Electron `safeStorage`（Windows 底层走 DPAPI）封装 `master.key`，仅在无桌面环境的独立 CLI 模式回退本地密钥盒并明确提示；
  2. 桌面 `main.cjs` 的 `desk://bundle/v1/*` 代理对**全部 HTTP 方法**（保留 `/v1/internal/*` 与 `/v1/extensions/*/ui/*` 阻断）统一由主进程补签 `X-Nowadays-Host-Token`，彻底移除向渲染层暴露明文 `hostToken`；
  3. 收紧 `router.ts` CORS 白名单，拒绝泛匹配 `file://` 与任意端口 `localhost:*`；独立后端默认自动生成本地短期会话令牌写入受保护运行文件供同机 CLI 自动读取。
- **验收标准**：
  - 未授权 `http://localhost:9999` 或 `file://` 跨域请求返回 `403 ORIGIN_DENIED`；渲染层 `window.nowadaysDesk` 不再包含 `hostHeaders`；桌面态密钥经 DPAPI 保护且跨重启可正常解密。

---

## 三、架构设计与工程债（`ARCH-*`）

### ARCH-01 后端与前端存在多个两千至三千行级“上帝文件”

- **优先级**：P1 · **状态**：`[ ]` 待排查
- **证据位置（实测总行数与体积，其中前两项已触发 `check-repo-hygiene.mjs` 的 `hygiene/file-size-budget` >100 KB 告警）**：
  - [apps/backend/src/application/conversation/conversation-service.ts](../../../apps/backend/src/application/conversation/conversation-service.ts)（3803 行，144.3 KB）
  - [apps/backend/src/storage/memory/memory-store.ts](../../../apps/backend/src/storage/memory/memory-store.ts)（2886 行）
  - [apps/backend/src/storage/conversation/conversation-store.ts](../../../apps/backend/src/storage/conversation/conversation-store.ts)（2612 行）
  - [apps/backend/src/storage/core/schema.ts](../../../apps/backend/src/storage/core/schema.ts)（2571 行，`app` V15 + `business` V31）
  - [apps/backend/src/storage/role/role-store.ts](../../../apps/backend/src/storage/role/role-store.ts)（2326 行）
  - [apps/desktop/renderer/src/pages/Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx)（2116 行，165.6 KB）
  - [apps/backend/src/application/conversation/agent-tools.ts](../../../apps/backend/src/application/conversation/agent-tools.ts)（1881 行）
  - [apps/backend/src/application/media/voice-service.ts](../../../apps/backend/src/application/media/voice-service.ts)（1708 行）
  - [apps/backend/src/application/conversation/agent-graph.ts](../../../apps/backend/src/application/conversation/agent-graph.ts)（1451 行）
  - [apps/backend/src/bootstrap/app.ts](../../../apps/backend/src/bootstrap/app.ts#L130-L136)（多处延迟赋值 `let` 回调胶水掩盖循环依赖）
- **根因分析**：
  业务高速叠加期间持续向既有巨型类/组件追加逻辑，缺乏按子域的职责切分。`ConversationService` 同时持有调度队列、SSE 连接表、执行上下文组装、自主活动驱动、角色互聊编排与启动恢复；`Settings.tsx` 把角色 6 分区和全局 7 分区揉在一个组件中（50+ 个 `useState`/`useRef`）。
- **修复建议（渐进式拆解，不改变对外契约）**：
  1. **先拆 `ConversationService`**：拆为 `ExecutionScheduler`（排队与抢占）、`ConversationStreamHub`（SSE 订阅与广播）、`StartupRecoveryCoordinator`（崩溃恢复）、`ConversationOrchestrator`（单次执行驱动）；
  2. **再拆 `Settings.tsx`**：拆出独立的 `RoleConfigWorkspace`、`GlobalSettingsWorkspace` 及各全局资源子区（`ModelServicesSection`、`ExtensionResourcesSection`、`RoleActivitySection`），用轻量 Context 替代深层 props 透传；
  3. **再拆 `schema.ts` 与巨型 Store**：按 `app` / `business` / `memory` / `media` 拆分 DDL 迁移文件与仓储模块；
  4. **收口 `app.ts` 循环依赖**：用显式类型化事件总线替换分散的延迟回填 `let` 回调。
- **验收标准**：
  - 首轮拆解后 `conversation-service.ts` 与 `Settings.tsx` 均降至 800 行以内，全量单测与 E2E 零退化。

---

### ARCH-02 桌面端四条通信通道混用，且动态页退化为 15 秒全量轮询

- **优先级**：P2 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L172-L195)（`desk://bundle/v1/*` 代理）
  - [apps/desktop/electron/main.cjs](../../../apps/desktop/electron/main.cjs#L228-L235)（`EventSource` 直连 `http://127.0.0.1` + `webRequest` 补头）
  - [apps/desktop/renderer/src/pages/Feed.tsx](../../../apps/desktop/renderer/src/pages/Feed.tsx#L85)（`setInterval(..., 15000)` 全量轮询）
- **根因分析**：
  因为 `EventSource` 无法自定义请求头，桌面端形成了普通请求走 `desk://`、SSE 走直连 `127.0.0.1` + `webRequest` 偷插头、扩展走 `nd-ext://`、系统交互走 `ipcMain` 的四轨架构；同时动态页未订阅统一事件流，靠定时全量拉取全部角色数据。
- **修复建议**：
  1. 在 `desk://bundle/v1/*` 协议代理中完整透传 `text/event-stream` 流式响应（Electron `protocol.registerSchemesAsPrivileged` 已声明 `stream: true`），收口所有业务 HTTP 与 SSE 到单一 `desk://` 同源通道，彻底去掉 `webRequest` 补头与前端直连地址依赖；
  2. 后端增加轻量全局动态 SSE（推送活动、往来、安排变更摘要），`Feed.tsx` 改为事件驱动局部刷新，取消 15 秒全量轮询。
- **验收标准**：
  - 断线重连、后端换端口重启后渲染层保持单一通道无失步；动态页静止时后台零周期性磁盘读取。

---

### ARCH-03 记忆检索纯依赖字面 `FTS5 trigram`，缺乏语义召回能力

- **优先级**：P2 · **状态**：`[ ]` 待排查 · **决策影响**：需先讨论确认检索架构（关联 [DL-51](../../161-digital-life-direction-decisions.md#dl-51-第一版召回基线多维条件过滤与全文检索)）
- **证据位置**：
  - [docs/specs/storage-memory-and-autonomy.md](../../specs/storage-memory-and-autonomy.md#L15)
  - [apps/backend/src/application/memory/memory-query-service.ts](../../../apps/backend/src/application/memory/memory-query-service.ts)
- **根因分析**：
  项目投入了极高设计密度做多层精细记忆建模（事件、证据、日常摘要、珍惜细节、实践经验、印象与原话分离等），但底层召回完全依赖字面 `FTS5 trigram + LIKE`。中文日常对话中同义词、委婉表达与指代极多（如“上次胃疼” vs “之前身体不舒服”），字面匹配极易漏召回。
- **修复建议**：
  1. 为记忆查询设计可选的「混合检索（FTS5 + Embedding 向量相似度 RRF 融合）」：未配置 Embedding 服务时无感退回当前 FTS5，配置了本地或云端 Embedding 服务后自动增强语义召回；
  2. 建立一套固定中文长期对话召回基准集，量化对比纯 FTS5 与混合检索的召回率与误召回率。
- **验收标准**：
  - 同义改写查询测试集召回率显著提升，且未配置 Embedding 服务时零额外依赖、离线测试全过。

---

### ARCH-04 启动期同步 IPC 阻塞、令牌暴露给渲染层与维护期隐性 O(N) 存储扫描

- **优先级**：P2 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [apps/desktop/electron/settings-preload.cjs](../../../apps/desktop/electron/settings-preload.cjs#L11)（`ipcRenderer.sendSync("desk:config")`）
  - [apps/backend/src/application/media/media-maintenance.ts](../../../apps/backend/src/application/media/media-maintenance.ts#L39-L58)（每次 `assertResumeAllowed` / `update` / `remove` 全量遍历全部角色并开关双库）
- **根因分析**：
  1. 预加载脚本同步 `sendSync` 会阻塞渲染进程首帧初始化，并把明文 `hostHeaders` 暴露在 `window.nowadaysDesk`；
  2. `MediaMaintenance.dependencies` 为了找绑定某语音/生图服务的角色，每次都要遍历 `appStore.listRoleIndexes()` 并逐个打开角色业务库，角色数增长后形成隐性 $O(N)$ 磁盘风暴。
- **修复建议**：
  1. 在 `app.sqlite` 维护角色资源/媒体服务依赖投影索引（写入绑定时同事务或决策提交更新），让影响范围查询变为单库 $O(1)$ 查表；
  2. 配合 `SEC-04` 收口 `desk://` 代理后，移除 `sendSync("desk:config")`，所需非敏感启动参数统一由异步 `desk:boot` 返回。
- **验收标准**：
  - 模拟 30 个角色时，全局服务影响分析与 `assertResumeAllowed` 耗时稳定在 <10ms；预加载脚本零 `sendSync` 调用。

---

## 四、操作不合理之处与功能短板（`UX-*`）

### UX-01 几乎全部角色配置写入都强制先停机，把并发锁转嫁给用户

- **优先级**：P1 · **状态**：`[ ]` 待排查 · **决策影响**：**需先修订** [DL-148](../../161-digital-life-direction-decisions.md#dl-148-配置修改直接删除与运行限制)
- **证据位置**：
  - [apps/backend/src/http/config-writes.ts](../../../apps/backend/src/http/config-writes.ts#L10-L31)
  - [apps/backend/src/http/write-guard.ts](../../../apps/backend/src/http/write-guard.ts#L7-L23)
  - [apps/backend/src/application/role/role-service.ts](../../../apps/backend/src/application/role/role-service.ts#L71-L77)（新建角色默认 `stopped`）
- **根因分析**：
  `ROLE_CONFIG_WRITES` 把 20 个接口全部一刀切锁死为“角色必须先 `stopped`”。修改对话模型服务连接确实涉及在途调用协调，但**补一条世界书词条、给服饰改名、传一张新立绘/差分、调一下自主额度、开关语音**都强迫角色先停机，打断体验极其生硬；且新建角色默认停机，极易让新手配完模型直接去聊天却碰壁。
- **修复建议（需先确认决策分级）**：
  1. 将角色配置按**实际并发影响**分为两类：
     - **热生效配置（无需停机，下轮决策自然读取最新修订）**：世界书、外观新增/改名/传图、自主额度、角色简介/显示名、非拆毁型开关；
     - **受保护变更（需协调停机/排空）**：删除角色、删除正在被引用的关键资源、切换存在协议冲突的服务连接；
  2. 新建角色完成对话模型绑定并点击保存后，提供默认勾选的“保存并立即启用角色”，消除“配好了却还是停机状态”的挫败感。
- **验收标准**：
  - 角色运行中新增世界书、上传新表情、调整自主额度零停机成功，下一轮对话/自主决策自动生效，且不破坏正在执行的当前轮次快照一致性。

---

### UX-02 首次上手与后台工程能力存在“冷启动悬崖”

- **优先级**：P1 · **状态**：`[ ]` 待排查 · **决策影响**：涉及空工程池展示策略（关联 [DL-201](../../161-digital-life-direction-decisions.md#dl-201-pi-使用独立工程模型消耗池)）
- **证据位置**：
  - [apps/backend/src/mcp/managed-pi.ts](../../../apps/backend/src/mcp/managed-pi.ts#L47-L50)（工程池为空时直接隐藏全部 `pi_task_*` 工具）
  - [apps/desktop/renderer/src/pages/Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx)（配置项分散在角色 6 分区 + 全局 7 分区）
- **根因分析**：
  1. 新用户首次打开软件缺少一条 2 分钟跑通的最小引导路径（配 1 个对话模型 → 立刻和夏澄开聊）；
  2. 项目最具爆点的“主角色后台写扩展”功能因为 `DL-201` 默认空池且对模型完全隐藏工具，新用户在扩展页看到邀请笺点去对话提想法，夏澄却因为工程池未配而根本没有写码工具，用户完全不知道要进「设置 → 工程」另配一套模型池。
- **修复建议**：
  1. 在首次无可用模型服务时提供轻量「3 步起手卡片」（添加模型服务 → 测试连通 → 回到夏澄开始对话），不强行弹窗阻断但清晰指路；
  2. 在扩展页空台邀请笺中，检测工程池是否为空：为空时明确提示「尚未配置工程模型池」并提供一键直达「设置 → 工程」按钮；同时在「设置 → 工程」支持“一键复用已有对话模型加入工程池”。
- **验收标准**：
  - 新用户从空白数据目录启动，不看文档即可在 2 分钟内完成首聊，并在扩展页能明确知晓如何一键开启后台工程能力。

---

### UX-03 后台工程（Pi）缺乏历史记录与失败过程日志

- **优先级**：P1 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [apps/backend/src/mcp/managed-pi.ts](../../../apps/backend/src/mcp/managed-pi.ts#L118-L121)（`running()` 仅返回运行中作业）
  - [apps/backend/src/http/routes.ts](../../../apps/backend/src/http/routes.ts#L145)（`GET /v1/engineering/jobs` 无历史查询）
  - [docs/design/character-studio/frontend-refinement-v2-plan.md](../../design/character-studio/frontend-refinement-v2-plan.md#L32)（已指出因后端无历史投影，任务结束瞬间胶囊消失）
- **根因分析**：
  后端 `engineering_jobs` 表里明明已经持久化了已结束的工程记录与摘要，但接口只暴露了 `listRunning()`，且没有记录执行过程关键事件或文件变更清单。
- **修复建议**：
  1. 扩展 `GET /v1/engineering/jobs?includeRecent=1&limit=20` 返回近期已完成/失败/取消的工程记录（含耗时、所用模型、失败码、摘要、关联 `extId` 与目标窗口）；
  2. 在 `pi-mcp` 运行期间按受控上限记录精简步骤日志（改了哪些文件、跑了哪条测试命令、退出码与错误尾部）落盘到任务草稿区元数据，供只读查看；
  3. 在桌面扩展页或工签展开面板增加「最近工程记录」折叠区，支持查看失败诊断与一键跳转对应对话窗口。
- **验收标准**：
  - 模拟一个工程失败或超时后，用户仍能在界面查到该次记录的耗时、模型、错误码与测试失败原因，不再“死无对证”。

---

### UX-04 设置页两处操作仍使用阻塞式原生 `window.confirm`

- **优先级**：P1 · **状态**：已修复，R5 精准复验通过
- **R5 实施与复验（2026-11-27）**：直接复用 `main.tsx` 根节点已挂载的设计系统 `useConfirm()`（底层 `Modal`、`role="alertdialog"`、默认安全焦点在取消按钮、`Esc` 关闭与焦点归还），替换 `Settings.tsx` 离开脏草稿拦截与结束运行中任务两处原生 `window.confirm`；全仓 `apps/desktop/renderer/src/` 扫描 `window.confirm` / `alert` / `prompt` 为 0；同步更新 `cross-page-share.e2e.cjs` 为真实 `[role="alertdialog"]` 交互断言（默认焦点在「继续编辑」、取消保留草稿、确认「放弃修改」正常离开）并实窗通过。
- **证据位置**：
  - [apps/desktop/renderer/src/pages/Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L194)（离开配置页脏草稿确认）
  - [apps/desktop/renderer/src/pages/Settings.tsx](../../../apps/desktop/renderer/src/pages/Settings.tsx#L1896)（手动结束运行中任务确认）
- **根因分析**：
  整个桌面壳层已经统一了 Tone B 纸感美学、组件库 `Modal` 与关窗/托盘退出的页内确认纸笺（`WindowIntent`），但 `Settings.tsx` 中仍有两处残留同步阻塞的原生 `window.confirm(...)`，既破坏视觉一致性，也与可访问性/键盘焦点体系割裂。
- **修复建议**：
  将这两处 `window.confirm` 统一替换为设计系统的页内 `Modal` 确认纸笺（默认安全焦点在取消/继续编辑，支持 `Esc` 关闭与读屏播报）。
- **验收标准**：
  - 全仓渲染器源码 `window.confirm` / `window.alert` / `window.prompt` 扫描为 0；现有草稿守卫与任务结束 E2E 切换为纸笺交互断言并通过。

---

### UX-05 单角色迁移与角色工作空间笔记缺少桌面图形入口

- **优先级**：P2 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [apps/backend/README.md](../../../apps/backend/README.md#L167-L193)（单角色迁移仅提供 5 条 PowerShell CLI 命令）
  - [docs/specs/storage-memory-and-autonomy.md](../../specs/storage-memory-and-autonomy.md#L52)（角色工作空间 `workspace/` 无 UI 文件浏览器）
- **根因分析**：
  “每个角色独立可携带迁移（含时间线分化选择）”和“角色在工作空间写 Markdown 笔记”是项目极有竞争力的核心卖点，但普通桌面用户根本看不到入口：想看角色写的笔记只能去翻隐藏数据目录，想迁移角色只能敲 CLI 和手写 `mapping.json`。
- **修复建议**：
  1. 在「关系」页或「角色配置」增加只读/轻编辑的「书案笔记（工作空间）」面板（列出角色 `workspace/` 下的 Markdown 文件并支持预览及「在资源管理器中打开目录」）；
  2. 在「设置 → 角色状态」或角色详情中提供图形化「导出角色包 / 导入角色包」向导，把 `preflight` 的绑定映射与 `diverged` 时间线选择做成表单弹窗。
- **验收标准**：
  - 用户无需打开终端即可在桌面端浏览角色写的 Markdown 笔记，并能完成一次单角色导出与导入（含时间线选择交互）。

---

### UX-06 多窗口跳转丢失上下文与主角色自改权限割裂

- **优先级**：P2 · **状态**：`[ ]` 待排查 · **决策影响**：主角色自改涉及 [DL-159](../../161-digital-life-direction-decisions.md#dl-159-夏澄首版管理-nowadays外部操作通过-mcp)
- **证据位置**：
  - [docs/specs/storage-memory-and-autonomy.md](../../specs/storage-memory-and-autonomy.md#L137)（从对话页进设置再点「开始对话」丢失原自定义子窗口 ID）
  - [docs/161-digital-life-direction-decisions.md](../../161-digital-life-direction-decisions.md#dl-159-夏澄首版管理-nowadays外部操作通过-mcp)（主角色运行中拒绝自改自身任意受保护配置）
- **根因分析**：
  1. 切页卸载 `ConversationPage` 时未在 `App` 壳层记忆 `(roleId -> lastWindowId)`，导致从子窗口跳设置再返回强行被踢回默认主窗口；
  2. 若 `UX-01` 将非停机型配置（如开关语音、调额度、加世界书）放开热生效，主角色仍拒绝为自己执行这些轻量调整，会让用户在自然对话中感到明显割裂。
- **修复建议**：
  1. 在 `App.tsx` 按 `roleId` 记住最近活跃的 `windowId`，从设置页返回或点击「开始对话」时优先回到该窗口（窗口已删再回退默认主窗口）；
  2. 在 `UX-01` 分级确认后，评估放开主角色对自身**无需停机**的轻量偏好（如语音开关、自主额度、外观切换）的受控自改能力，仅继续禁止会引发自身断联/停机的模型连接与停机操作。
- **验收标准**：
  - 自定义子窗口跳设置并返回后仍停留在原窗口；主角色管理边界与 UI 引导文案一致无误导。

---

## 五、交付、打包与真实联调短板（`DELIV-*`）

### DELIV-01 桌面生产包直接打包未编译 TS 源码与 `tsx`，且缺 Node 24 构建流水线

- **优先级**：P0 · **状态**：修复及独立离线复验通过，干净机便携包验收待办
- **审计时证据位置**（下述根因与建议保留原始审计背景；现状以实施记录为准）：
  - [apps/desktop/package.json](../../../apps/desktop/package.json#L24-L52)
  - [apps/desktop/electron/backend-paths.cjs](../../../apps/desktop/electron/backend-paths.cjs#L17-L47)
  - [docs/STATUS.md](../../STATUS.md)（当时记录运行时目录被忽略、干净机器 `package:win` 启动未验证）
- **根因分析**：
  生产打包直接拷贝了未编译的 `apps/backend/src/**/*` 与整套含开发依赖的 `node_modules`（因为运行时靠 `node --import tsx src/main.ts`），导致冷启动编译开销大、体积膨胀、对未入库的 `.tools/node-v24` 隐式依赖，至今无法向外部用户交付可直接运行的安装包。
- **修复建议**：
  1. 为 `apps/backend` 增加正式生产构建命令（`esbuild` / `tsup` 输出 `dist/main.mjs` + `dist/mcp/local-server.mjs` + `dist/extensions/runner.mjs`，`better-sqlite3` 等原生模块置为 external），运行时直接 `node dist/main.mjs`，彻底移除生产态对 `tsx` 的依赖；
  2. 编写可重复执行的打包前置脚本（自动校验/下载固定版本并核验 SHA-256 的 Node 24 Windows x64 运行时、精简 `npm prune --omit=dev` 生产依赖、验证原生模块 ABI 一致性）；
  3. 制定“干净 Windows 虚拟机 / 无 Node 环境”实机冒烟清单，覆盖首次启动、数据目录迁移（`userData/data`）、托盘退出、重启恢复与 Pi 扩展发布。
- **验收标准**：
  - 在未安装 Node.js 的干净 Windows x64 环境中，双击便携版 EXE 冷启动时间显著缩短（目标 <2 秒至健康检查就绪），核心对话与热扩展功能可运行且退出后残留进程为 0。

#### DELIV-01 实施与离线验证（2026-11-27）

桌面生产入口改为编译后 `backend/dist/main.js`，本地 MCP 使用编译产物，扩展 runner 与进程启动器的两个 `.mjs` 则原样复制进 `dist`。`prepare:win` 在独立 staging 准备生产依赖、Pi 子包、素材和固定版本、校验 SHA 的 Windows x64 Node 运行时，并检查原生模块；不对开发目录运行 prune。桌面壳开发态继续使用源码入口。具体打包及校验以 [准备脚本](../../../apps/desktop/scripts/prepare-package-resources.mjs) 和 [桌面配置](../../../apps/desktop/package.json) 为准。

冻结 staging 准备使用 Node v24.22.2 win32 x64，SHA-256 为 `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9`；SQLite、sharp 和后端及 Pi 两份 koffi 原生模块实际运行通过。桌面打包布局单测 8/8、渲染器指定单测 4/4、渲染器 check/build、后端 typecheck/build 通过。此轮使用已有运行时和依赖，联网下载与干净 CI 安装路径未触发。

指定 [脱仓冒烟](../../../apps/desktop/tests/unit/packaged-backend-smoke.test.cjs) 在仓外含空格临时路径实体复制整个 staging，仅继承系统必需环境，排除宿主 Node、npm 与 Node 覆盖；从包内 Node 启动编译后端，读取实际预置介绍与图像、建角，并经本地离线模型完成一轮对话、热发布扩展与调用其工具。另以复制内 Pi SDK 的真实 worker 请求检查工具集，并调用编译版本地 MCP 读写。关闭 stdin 后检查 `shutdown_complete` 的来源、退出码，以及活体阶段确认可枚举的复制版 Node 进程在退出后归零。冻结 staging 自验 1/1，spawn 至首次 health 200 为 **4630 ms**；最终版本独立复验 1/1、无跳过，首个 health **4267 ms**、整测 32.757 秒。这些本机单次测量均未达到原定 <2 秒目标。

干净 Windows x64、未安装 Node 的便携 EXE 仍需人工检查：

1. 在构建宿主生成便携 EXE，仅复制 EXE 到干净机器；双击冷启动并记录 health 时间。
2. 确认内置角色、图片和一轮对话，验证 Pi 工程与热扩展发布调用。
3. 从托盘退出并确认子进程归零；重启后确认角色数据恢复，并确认旧安装数据迁移策略。

真实远程服务、实际便携 EXE 及数据迁移均不由上述 staging 离线测试证明。

---

### DELIV-02 真实云端模型、多模态与媒体服务全链路联调长期缺位

- **优先级**：P1 · **状态**：`[ ]` 待排查
- **证据位置**：
  - [docs/STATUS.md](../../STATUS.md#L9-L13) · [STATUS.md#L120](../../STATUS.md#L120) · [STATUS.md#L125-L127](../../STATUS.md#L125-L127)
  - [docs/archive/09-role-runtime-and-transfer/402-long-dialogue-quality.md](../09-role-runtime-and-transfer/402-long-dialogue-quality.md)
- **根因分析**：
  当前 624 项后端测试、27 项桌面 E2E 几乎全部基于离线模拟端点（`realServiceCalls=0`）。真实大模型在工具调用参数漂移、流式截断、长对话重复动作、时间错位、缓存字段差异，以及真实 ComfyUI 队列拥塞/取消清理和真实 TTS 多语种长句方面仍存在大量未充分压测的边界。
- **修复建议**：
  1. 固化一份「发版前真实服务联调矩阵」（不进每次自动回归，按发版里程碑手动执行并归档证据）：
     - 至少覆盖 3 家真实模型协议（OpenAI Chat/Responses、Anthropic Messages、Google Gemini/Vertex）的工具续轮、Token 账本实测、记忆整理与 Pi 真实生成并热发布 1 个完整微页扩展；
     - 覆盖本机真实 ComfyUI 并发/取消清队列/大图上限（8 MiB 参考图 / 32 MiB 成图）；
     - 覆盖本机真实 TTS（CosyVoice3 / IndexTTS）长句流式推进、切窗防竞态与停用同步；
  2. 针对 [402](../09-role-runtime-and-transfer/402-long-dialogue-quality.md) 已复现的 DeepSeek 连续动作与时间错位问题，整理提示词与上下文结构回归样例，形成可复测的真实模型质量基线。
- **验收标准**：
  - 发版前完成一轮完整真实服务联调并留档，所有阻塞级兼容问题清零后再对外发布预览版。

---

## 六、审查与修订记录

### 第 1 轮源码复核（2026-11-27）
- 复核 `agent-tools.ts`、`use-extensions.ts`、`backend-base.ts`、`Settings.tsx` 与 `local-server.ts`：
  1. 补充 **`BUG-07`**：核实 `use-extensions.ts:39` 在 SSE `onerror` 时仍执行 `setItems([])`，会卸载所有活跃扩展 iframe 并与二期规范冲突；同步补入 `backend-base.ts` 永久缓存问题；
  2. 补充 **`BUG-08`**：核实 `local-server.ts:300` 与 `agent-tools.ts:1193` 超时仅杀直接子进程，Windows 下未回收进程树；
  3. 扩充 **`SEC-02`**：核实普通角色 `skill_run` 未传 `controlledPackage`，跳过 `--permission` 并继承完整 `process.env`，与 Pi 侧隔离倒挂；
  4. 扩充 **`UX-04`**：补全遗漏的第二处原生弹窗 `Settings.tsx:1896`（结束任务确认）；
  5. 细化 **`SEC-04` / `ARCH-04`**：定位 `hostToken` 暴露给渲染层的精确根因为 `main.cjs:186` 仅对 `GET` 请求补签。

### 第 2 轮架构与依赖链路复核（2026-11-27）
- 复核 `app.ts:565-580`、`role-service.ts:64-69`、`conversation-service.ts` 与 `docs/161` 锚点：
  1. 排除误报：确认 `conversation.close()` 第 1312 行已调用 `memoryRuntime.close()`，未纳入缺陷项；
  2. 细化 **`BUG-03`**：指出 `RoleService` 内部另建了独立 `RoleAccess` 实例且 `ConversationService` 多处直接操作 `RoleStorage`，修复连接缓存前必须先统一注入避免 Windows 文件句柄泄漏；
  3. 校准 **`ARCH-01`** 精确文件行数，补齐 `DL-51`、`DL-59` 等 `161` 标题锚点。

### 第 3 轮自动化巡检与链接/指标精校（2026-11-27）
- 运行 `node scripts/check-docs.mjs`、`node scripts/check-repo-hygiene.mjs` 及全页内部锚点与源码行号区间脚本：
  1. 修正总表中 `SEC-01`、`SEC-02`、`BUG-08`、`SEC-03` 的 4 处锚点不一致，并消除标题中下划线与数学公式符号在 GitHub 与 `check-docs.mjs` 间的 slug 差异；
  2. 按实测行数校准 `ARCH-01` 全部 9 个巨石文件行数，并补入 `check-repo-hygiene.mjs` 已触发的 `conversation-service.ts`（144.3 KB）与 `Settings.tsx`（165.6 KB）超限告警；
  3. 确认全部站内文件链接、行号范围与跨文档 `DL-xx` 锚点 0 失效，文档巡检 0 错误 0 警告。
