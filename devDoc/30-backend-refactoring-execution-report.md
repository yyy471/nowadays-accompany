# 后端改造执行报告（B01～B11）

日期：2026-10-23。状态：B01～B11 已按顺序实现并通过自动化与本地 mock 界面核验；改动尚未提交，等待作者复核。基线记录见[28 基线行为契约](28-baseline-behavior-contract.md)，任务依据见[27 任务包](27-backend-refactoring-work-packages.md)与[26 目标架构](26-backend-target-architecture.md)。

## 1. 结论

- 本轮执行以 B00 交付提交 `ac51e0d` 为起点，按 B01 → B02 → B04 → B03 → B05 → B06 → B07 → B08 → B10 → B09 → B11 顺序完成。
- 模块化单体目标保持：桌面／CLI／HTTP → Core 门面与应用服务 → 领域模块 → 公共基础能力。
- `src/core/core.ts` 从 1895 行降到 1089 行；`src/service/server.ts` 从 1312 行降到 187 行。
- 自动化结果：`npm run typecheck` 通过；`npm test` 55 个文件、333 项通过；`npm run desktop:build` 通过。
- 本地 mock UI 核验：主页、总览、实例与监听、资料与角色、模型配置、资源库、事件诊断均可加载，浏览器控制台无报错，SSE 显示为已连接。
- 未执行真实 QQ 注入、真实 SnowLuma 操作或付费模型调用；这些仍属于实机验收，不在本报告内声称通过。

## 2. 任务包落点

| 任务 | 主要落点 | 关键结果 |
| --- | --- | --- |
| B01 信号量交接 | `src/core/concurrency.ts` | 释放者直接把名额交给等待者，等待者被唤醒前 `active` 已计入；`release` 幂等；`run` 抛错仍释放。 |
| B02 串行与提交 | `src/platform/async/`、`src/profiles/display.ts`、`devDoc/29` | `SerialExecutor`／`KeyedSerialExecutor` 提供有界队列、失败恢复、空闲键回收；展示资料完整读改写在同账号串行域内，落盘成功后才返回。 |
| B03 账号路径与展示 | `src/profiles/account-directory.ts`、`src/application/accounts/account-presentation.ts` | 账号根路径只经 `AccountDirectory` 解析；查询不创建目录；`AccountPresentation` 统一本地资料与 QQ 头像回退。 |
| B04 契约与错误 | `src/contracts/accounts.ts`、`src/application/ports/`、`src/platform/security/redaction.ts`、各领域 `errors.ts` | `CoreView`／`AccountSummary` 单一定义；`MediaError`、`JobError` 回到所属模块，旧路径仍兼容导出；脱敏函数集中到平台层。 |
| B05 AccountService | `src/application/accounts/account-service.ts` | 账号列表、展示资料、插件资料、角色绑定迁出 Core；通过窄运行端口读取实例状态与重载，不把 Core 传给服务。 |
| B06 QQ 接入 | `src/application/qq-connections/` | `QqConnectionService` 复用 `ManualInjectionService`／Supervisor；`ProcessReconciler` 接管扫描、映射代际、失联阈值与清理。 |
| B07 模型设置 | `src/application/model-settings/model-settings-service.ts` | 服务维护、简化配置、发现、测试、账号策略与生效能力迁出；复用 `ConfigStore`、`PolicyService`、`ProviderRouter`。 |
| B08 部署 | `src/application/deployments/deployment-service.ts` | 部署／回滚统一入口，复用 `RollingDeployer`；部署链串行，记录上限 20 条。 |
| B09 装配与生命周期 | `src/bootstrap/assemble-runtime.ts`、`src/application/lifecycle/runtime-lifecycle.ts`、`src/core/options.ts` | 装配不导入 Core 实现；Core 接收已装配服务；关闭按 stop → drain → dispose 执行，步骤幂等、单步失败不阻断后续释放。 |
| B10 有界读取 | `src/platform/http/bounded-body.ts` 及适配器接入 | 超限、超时、调用方取消都会停止并取消响应流；保留 HTTP 状态分类与“生成结果未知”语义。 |
| B11 HTTP 拆分 | `src/service/http/`、`src/service/routes/`、`test/architecture.test.ts` | 鉴权、IO、错误、静态资源、SSE 与领域路由分离；架构守卫阻止反向依赖和重复契约定义。 |

## 3. 关键不变量

### 3.1 QQ 进程映射（B06）

- 锁顺序固定为 **M（ManualInjection 每 PID 链）→ R（ProcessReconciler 串行域）→ Supervisor**；不建立 R → M 的反向获取。`ProcessReconciler.runExclusive` 的注释明确规定任务内不得调用 `refresh()`。
- 扫描单飞：并发刷新共享同一次 `listProcesses`；网络失败只让本次刷新失败，不写入空快照、不清空映射。
- 映射代际：`refresh()` 在发起网络请求前记录 `scanEpoch`；本轮开始后新建立的映射不会被旧快照否定。
- 失联阈值默认 2 次成功快照；账号变化（PID 复用换号）立即清理，不等待阈值。
- 清理完成后仅在 `mappedEpoch` 未变化时删除映射，避免误删并发建立的新连接。
- 恢复候选与恢复执行继续使用同一套资格规则；恢复只重建展示槽位，不启动、不注入、不创建账号租约。
- 用户显式停止／卸载后不进入自动恢复；后台轮询只在已有映射时运行。

### 3.2 装配与关闭（B09）

- `assembleRuntime` 只负责加载持久化状态、构造对象、注入端口；不启动实例，不触发 QQ/SnowLuma 操作，不导入 Core 类。
- Core 通过 `RuntimeHooks` 取回创建实例、部署目标、Agent 重载、任务撤销、运行时租约释放和停止状态，避免装配层反向依赖门面。
- 创建失败时：Core 构造成功则调用 `core.stop()`；尚未构造则调用 `RuntimeAssembly.dispose()`，释放已加载的 Store、运行注册表和 dataRoot 锁。
- 正常关闭顺序：stop（模型设置排空、QQ 接入停止、健康定时器、API、部署排空）→ drain（实例停止，带 `shutdownTimeoutMs`）→ dispose（host、任务、媒体与配置、Store、实例、租约、注册表、SnowLuma 运行时、动态 desired、监听记录、槽位、账号租约、可观测对象、dataRoot 锁）。
- `RuntimeLifecycle.close()` 幂等；单步失败只记录警告，后续步骤继续执行。

### 3.3 有界响应读取（B10）

| 调用点 | 上限 | 超时/取消 | 超限或中断后的语义 |
| --- | --- | --- | --- |
| OpenAI 兼容 JSON | 16 MiB | 调用方信号 | 协议错误；不完整 JSON 不进入解析 |
| OpenAI 音频 | 成功正文 64 MiB；错误正文 16 MiB | 调用方信号 | `provider_protocol` |
| 视频轮询 JSON | 8 MiB | 调用方信号 | 先按 HTTP 状态分类，再读正文 |
| SnowLuma 管理接口 | 2 MiB | 管理请求超时 + 调用方信号 | 超限 `snowluma_protocol`；中断 `snowluma_unreachable`（可重试） |
| SnowLuma 登录 | 64 KiB | 管理请求超时 | 同上 |
| 模型发现 | 1 MiB | 10 秒信号 | 超限 `ConfigError`；读取失败可重试 |
| QQ 头像 | 256 KiB | 3 秒 | 失败按原有规则回退，不阻塞账号列表 |

`readResponseBytes` 在 `content-length` 已超限时先取消流；流式读取中累计超限立即 `reader.cancel()`，不会先完整缓冲。错误对象只携带标签、字节数和可选上限。

### 3.4 HTTP 拆分与架构守卫（B11）

- `server.ts` 只保留：请求 ID／版本头、`/v1` 路径归一化、静态 UI、鉴权、路由表遍历、统一错误映射、审计包装、SSE Hub 生命周期和关闭。
- `service/http/` 提供 auth、io、errors、static、sse；`service/routes/` 按 system、instances、conversations、accounts、models、media、jobs、artifacts、connections 分组。
- `test/architecture.test.ts` 覆盖 9 项边界：应用服务不依赖 Core 门面／HTTP／UI；bootstrap 不依赖 Core 实现；HTTP 基础设施与路由不依赖 Core 实现；platform 不依赖领域与应用模块；领域模块不依赖 HTTP／UI；contracts 浏览器安全；renderer 不导入 Node／服务端；`CoreView`／`AccountSummary` 单一定义；server 必须经路由表并包含静态／SSE 基础设施。

## 4. 验证证据

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（后端与 renderer 两个 tsconfig） |
| 全量测试 | `npm test` | 55 个文件、333 项通过 |
| 桌面构建 | `npm run desktop:build` | 通过（`tsc`、Vite renderer、desktop main/preload） |
| mock UI | `node test-results/refactor-ui-check.mjs` + 浏览器 | 主页／总览／实例／资料／模型／资源库／诊断均正常；无控制台报错；SSE 已连接 |

新增测试 42 项：

- `test/semaphore.test.ts` 4 项（名额交接、上限、幂等释放、抛错释放）。
- `test/serial-executor.test.ts` 6 项（顺序、失败恢复、容量、close、键回收、跨键并行）。
- `test/account-directory.test.ts` 4 项。
- `test/account-presentation.test.ts` 1 项。
- `test/process-reconciler.test.ts` 5 项（单飞、失败不清空、代际、阈值、清理）。
- `test/runtime-lifecycle.test.ts` 3 项（顺序、幂等、错误隔离）。
- `test/bounded-body.test.ts` 6 项（超限、超时、取消、超限前取消流、声明长度、无流回退）。
- `test/http-body-adapters.test.ts` 4 项（适配器超限与中断语义）。
- `test/architecture.test.ts` 9 项。

原 289 项基线测试未删除；`test/display-profile.test.ts`、`test/profiles.test.ts` 随 Store 方法化做了等价调整，并新增 2 项并发/失败用例，合计 333 项。

## 5. 未验证与已知边界

- **真实环境**：未启动 QQ、未连接真实 SnowLuma 1.14.22、未调用真实付费模型；手动注入、恢复监听、通道收发、真实头像抓取仍待实机验收。
- **UI 核验**：使用本地 mock 数据与静态构建产物，验证的是接口形状和页面渲染，不代表真实控制面进程生命周期。
- **Store 失败语义**：`devDoc/29-store-commit-failure-audit.md` 中列出的内存/磁盘不一致边界仍然存在；本轮只把展示资料接入串行域，没有把它们包装成跨文件事务。
- **并发结论范围**：B01/B02/B06 的结论来自确定性单元测试与现有集成测试，不构成形式化证明；极端调度下仍需实机压力验证。
- **持久性**：`writeFileAtomic` 不提供 fsync 级断电保证。
- **许可与启动**：未内置、下载或再分发 SnowLuma；未新增系统自启；QQ/SnowLuma 仍由用户自行启动。
- **未提交**：所有 B01～B11 改动仍在工作区，未执行 `git add`／`commit`；`test-results` 下的 mock 脚本与构建产物不进入 Git。

## 6. 复核入口

建议按以下顺序复核：

1. `src/core/concurrency.ts`、`src/platform/async/`、`src/platform/http/bounded-body.ts`：基础能力与失败行为。
2. `src/application/qq-connections/process-reconciler.ts`、`qq-connection-service.ts`：锁顺序、代际、失联阈值、恢复资格。
3. `src/application/accounts/`、`model-settings/`、`deployments/`：业务规则是否仍只有一份。
4. `src/bootstrap/assemble-runtime.ts`、`src/core/core.ts`：装配边界、启动/关闭顺序、创建失败释放。
5. `src/service/server.ts`、`src/service/http/`、`src/service/routes/`：HTTP 契约、SSE、静态资源与错误映射。
6. `test/architecture.test.ts`：守卫是否覆盖本轮新增的依赖方向。

## 7. 下一步

- 由作者复核工作区改动并按任务或批次提交；本报告不代替提交记录。
- 在真实 QQ + SnowLuma 环境完成注入、监听、恢复、停止/卸载、通道收发的实机验收，并单独记录证据。
- 对 `devDoc/29` 中仍未统一的 Store 失败语义，后续按小提交逐个决定回滚或补偿，不套用“原子写入即事务”的假设。
