# AGENTS.md — AI 协作上手指南

本文件面向 AI 助手（也可供新协作者参考），目标是读完即可理解项目结构、约定与红线，快速开始有效工作。更深入的设计文档在 `devDoc/`（见文末「文档体系」）。

## 项目是什么

**nowadays** —— QQ 进程注入编排与交互核心 + Windows 桌面端（Electron + React）。目标是把「注入一个 QQ、连上它、收发消息」做成**可多实例、彼此隔离、无单例**的底座；私聊/群聊策略、插件、角色卡、Skill 都是功能层，通过 `AgentHost` 契约接入。

技术栈：TypeScript（ESM，Node ≥ 20.19）、Electron 39、React 19、Vite、esbuild、Vitest。运行时依赖只有 `ws`，其余全是 devDependencies。

**关键概念——引导式外部 SnowLuma 接入**：本项目**不实现 QQ 协议**。外部工具 SnowLuma 负责注入 QQ 并暴露 OneBot 11 兼容接口（HTTP + WebSocket）；nowadays 只做编排。用户自行下载/初始化/启动 SnowLuma 和 QQ，应用**绝不自动部署或启动**（`autoStartSnowLuma: false`、`manualStartOnly: true`，这是行为契约，有 EULA 许可边界原因，见 `devDoc/20`）。

## 常用命令

```bash
npm run build          # tsc 编译 src/ → dist/（注意：不含 test 与 desktop）
npm run typecheck      # 类型检查 = tsconfig.test.json（覆盖 src+test+desktop 主进程）+ 渲染层 tsconfig
npm test               # vitest run，约 118 个文件 / 1100+ 项
npm run dev            # tsx 直接跑 CLI（src/bin/nowadays.ts）
npm run desktop:build  # 完整桌面构建 = build + desktop:renderer(vite) + desktop:main(esbuild)
npm run desktop:start  # desktop:build 后 electron . 本地起桌面端
npm run dist           # Windows 打包（NSIS 安装包 + portable 便携版 → release/）
```

**全量验证 = `npm run typecheck` + `npm test` + `npm run desktop:build`**。只跑 `npm run build` 不代表类型检查通过（主 tsconfig 不覆盖 test/desktop/renderer）。

CI（`.github/workflows/ci.yml`）：master 的 push/PR 触发 Node 20/22 矩阵（build + typecheck + test）、桌面端构建、Windows 打包（产物在 run 的 Artifacts 区）。`release.yml`：推送 `v*` tag 触发，校验 tag 与 `package.json` 版本一致后打包发布 GitHub Release。

## 目录结构

### 顶层

| 目录/文件 | 职责 |
|---|---|
| `src/` | 核心 TypeScript 源码（CLI + 领域模块），文件名 kebab-case |
| `desktop/` | Electron 桌面端：主进程、preload、构建脚本、图标、React 渲染层 |
| `test/` | 回归测试（`*.test.ts(x)`，与 src 模块一一对应）+ fixtures + diagnostics |
| `devDoc/` | 设计与开发文档，101 篇编号文档即开发时间线 |
| `nowadays.config.example.json` | v1 配置样例（进程/实例/容量/API） |
| `nowadays.config.v2.example.json` | v2 配置样例（模型服务/账号策略/Skill） |

不进 Git：`dist/`、`desktop-dist/`、`desktop/renderer/dist/`、`release/`、测试产物。规范见 `devDoc/23`。

### src/ 分层（自外向内）

| 目录 | 职责 |
|---|---|
| `src/bin/` | CLI 入口。`nowadays.ts`：`probe`（只读探测 SnowLuma runtime）、`start --config <file>`（无 UI 启动 Core）；`accompany.ts` 是兼容别名 |
| `src/bootstrap/` | 进程启动时的依赖装配（`assemble-runtime.ts` 手工 new 所有服务注入端口，无 IoC 容器） |
| `src/service/` | 本地控制面：HTTP + SSE（默认 127.0.0.1:7280），14 个路由模块，桌面 UI 静态托管 |
| `src/application/` | 应用服务层（用例编排）：`accounts/`、`artifacts/`、`deployments/`、`extensions/`、`lifecycle/`、`memory/`（含 `extraction/`）、`worldbooks/` 等。**新应用逻辑放这里** |
| `src/contracts/` | 纯类型的传输 DTO/事件契约。**新 DTO 放这里** |
| `src/core/` | Core 装配与横切设施：`core.ts`（`createCore()` 门面）、`errors.ts`、`logger.ts`、`bus.ts`（TypedEventBus）、`state.ts`（实例状态机）、`concurrency.ts`（Semaphore/withTimeout）、`limits.ts`、`data-root-lock.ts` |
| `src/injection/` | 注入后端抽象（`InjectionBackend`）+ SnowLuma 实现 + `manual.ts`（手动注入操作状态机）+ `fake.ts` |
| `src/channels/` | 通道层：OneBot 事件规范化/动作调用/心跳/重连代际（`onebot/client.ts`、`onebot/normalize.ts`）、`contract.ts`（OutboundChannel）、`fake.ts`（FakeChannel） |
| `src/instances/` | 实例会话与编排：`instance.ts`（QqInstance：一个 QQ 号的生命周期/队列/限流/回环）、`supervisor.ts`（desired/observed 收敛）、`runtime-registry.ts`（runtime 共享/引用计数/熔断） |
| `src/agent/` | 内置 Agent（唯一自动回复宿主）：`engine.ts`（上下文构建 + 工具循环）、`context.ts`、`scheduler.ts`（每会话串行） |
| `src/host/` | `AgentHost` / `AgentMessageContext` 契约与插件状态 |
| `src/providers/` | 模型服务配置与能力路由：`router.ts`、`config-store.ts`（config.v2.json 原子写）、`adapters/`（openai / video-polling / fake 三种 adapterId） |
| `src/policy/` | 能力策略：账号硬授权 + byKind/byConversation 作用域覆盖 |
| `src/secrets/` | 凭据库：只按 `credentialRef` 读写，不落明文 |
| `src/media/`、`src/jobs/` | 账号媒体制品与受限异步媒体任务 |
| `src/artifacts/` | 制品分发：manifest/catalog/滚动部署/回滚、酒馆角色卡导入（`tavern-card.ts`） |
| `src/profiles/` | 账号档案：`profile.json`、角色绑定（每会话显式绑角色卡）、展示资料 |
| `src/worldbook/` | 世界书匹配器/schema/酒馆格式导入 |
| `src/memory/` | 事实记忆 schema/store/selector |
| `src/extensions/` | 扩展体系：`registry.ts`、`execution/`（工具执行器/账本/限流）、`runtime/`（每账号每插件一个 Worker、握手协议、状态） |
| `src/storage/` | 存储：`jsonl-store.ts`（分段 JSONL）、`atomic-write.ts`（**唯一写文件底层**）、desired-state、slot-store |
| `src/work/` | 会话队列与令牌桶限速 |
| `src/routing/` | 身份/会话引用、回环判定（`loopback.ts`）、消息段 |
| `src/config/` | 分层配置合并：global → account → kind → account:kind → conversation |
| `src/platform/` | 小而明确的基础能力：async、http、security/redaction（脱敏）、text/truncate |

### desktop/

| 文件/目录 | 职责 |
|---|---|
| `desktop/main.ts` | Electron 主进程：内嵌 Core（`import { createCore } from '../src/index.js'`）、托盘、单实例锁、随机 token、IPC handlers。源码在 desktop 根，不在 src/ |
| `desktop/preload.ts` | contextBridge 暴露 `window.nowadays`；apiBaseUrl/token 经 `--nowadays-info=` 参数注入 |
| `desktop/renderer/` | React 渲染层（Vite 独立 tsconfig）：`src/main.tsx` 入口、`pages/`、`components/`、`ui/`（统一组件库）、`lib/drafts/`（草稿保护） |
| `desktop/scripts/build.mjs` | esbuild 打包主进程 → `desktop-dist/main.mjs`、preload → `desktop-dist/preload.cjs` |
| `desktop/scripts/package.mjs` | 组装 win-unpacked + electron-builder（NSIS + portable，显式 `--publish never`） |
| `desktop/scripts/build-icon.cjs` | 用 Electron offscreen 渲染 SVG → PNG/ICO |

## 核心架构流转

### 消息链路（QQ → 回复）

1. SnowLuma(OneBot) 事件 → `OneBotChannel` 规范化为 `InboundEvent` → 回调进 `QqInstance`
2. 回环判定按**实例归属**（`src/routing/loopback.ts`）：非本实例 self_id 丢弃；自身回声丢弃
3. 入站：有界队列 + 每会话串行 + messageId 去重；**先落盘（JSONL）再发事件**
4. `AgentHost`（契约 `src/host/contract.ts`）是唯一回复出口；内置实现 `src/agent/engine.ts`：构建上下文（角色卡 + 世界书 + 记忆 + Skill + 有界历史 + 插件 beforeContext 数据）→ `ProviderRouter` 按能力路由 → adapter 调模型 → 工具调用循环（预算：3 工具回合/4 调用/4 续答）→ 单条最终回复
5. 回复经 `QqInstance.send()` → 出站 FIFO + 每账号令牌桶 + idempotencyKey 去重 → channel → QQ。**插件没有 send/回复出口**，只提供 tools/hooks/skills
6. 代际隔离：`sessionEpoch`/`hostEpoch`/`profileFingerprint`，旧宿主晚到的写入被拒

实例状态机：`stopped → provisioning → starting → awaiting_login → awaiting_profile → online`。角色卡是账号上线硬前置，缺则停在 `awaiting_profile`。

### artifacts（制品）体系

三类制品：`role-card`（角色卡）、`plugin`（manifest 声明 tools/hooks/skills/state，每账号每插件一个 Worker）、worldbook（世界书）。公用层 `<dataRoot>/public/`（catalog.json + artifacts/），账号私有层 `<dataRoot>/accounts/<accountId>/`。`profile.json` 引用制品（source: public/private + id，可选固定 revision）；热部署**按账号滚动**：先验新档案再原子切宿主，失败账号保留旧 revision；`/artifacts/rollback` 恢复 previous catalog。

### 配置：v1 与 v2（互不覆盖）

- **v1**（`nowadays.config.example.json`，CLI `start --config` 读）：`dataRoot`、`logLevel`、`limits`（各容量上限）、`api`（本地控制面）、`instances[]`（InstanceSpec：id、backend、runtimeDir、accountId、restart 退避）
- **v2**（`<dataRoot>/config.v2.json`，`providers/config-store.ts` 管理）：`providers[]`（adapterId：openai-compatible-v1 / video-polling-v1 / fake-v1；models 带能力枚举 chat / image.understand / video.understand / image.generate）、`accountPolicies`（账号硬授权 + 能力 bindings）、`skills[]`、媒体保留期
- **密钥绝不进配置文件**，只走 `credentialRef` 凭据库（桌面端 Electron safeStorage/DPAPI）

## 测试约定

- 命名 `<topic>.test.ts`（渲染层 `.test.tsx`），与 src 模块一一对应；`phase1-*`/`phase2-*` 是历史阶段回归测试；`independent-*` 是独立复核产物
- `test/helpers.ts`：`seedRoleCard(dataRoot)`、`seedProfile`、`createTestCore(options, extraAccounts)`、`bindTestConversation`
- `test/phase1-helpers.ts`：`TINY_PNG`/`TINY_MP4` 字节 fixture、`fakeProvider()`
- `test/fixtures/plugins/`：blocking/broken/forged/hanging/slow-hook/offline-demo 等故障注入插件 fixture
- **写新测试的标准模式**：`fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'accompany-xxx-'))` 建临时 dataRoot（realpath 是必须的——macOS 的 `/var`、`/tmp` 是符号链接，制品导入的链接检查会拒绝）；`silentLogger()` 静音日志；channel 用 `FakeChannel`；provider 用 `fake-v1`；模块级 `roots: string[]` / `cores: Core[]` + `afterEach` 里 `Promise.allSettled` 全部 `core.stop()` 和 `fs.rm` 清理；自写 `waitFor(predicate, timeoutMs)` 轮询。**真实 QQ/付费模型从不出现在测试里**
- `test/diagnostics/*.mts` 是独立诊断脚本，不进 vitest，用 tsx 手动跑

## 代码风格

- **注释中文为主**：公共接口用 `/** ... */` JSDoc，正文中文；错误消息偏英文小写（`cannot transition from X to Y`），面向用户的字符串偏中文
- 统一错误基类 `AccompanyError`（带 `code` 字段），派生 `InvalidSpecError`、`InvalidStateTransitionError`、`BackendError`/`ChannelError`（带 `retryable`）等，全部在 `src/core/errors.ts`，从 `src/index.ts` re-export；HTTP 错误响应统一 `{ ok:false, error, code, retryable? }` + `x-request-id` header
- 文件 kebab-case（src）、React 组件 PascalCase（desktop）；私有成员用 `#field`；偏好类型 + 工厂函数（`createCore`、`createLogger`）而非 class；导出接口不加 `I` 前缀；显式 `readonly`
- 大量使用 `import type`
- git 提交：`feat:`/`fix:`/`docs:`/`chore:`/`ci:`/`refactor:` 前缀，中文正文，正文说明改了什么、为什么

## 红线（改代码前必读）

来自 README「关键不变量」与 `devDoc/28`（B00 基线行为契约），**改动行为前先对照契约**：

1. 模块顶层不放可变状态，无单例
2. 不绕过 `QqInstance.send()` 直接调通道
3. 配置写入走串行队列；文件写入走 `src/storage/atomic-write.ts`
4. 新注入后端实现 `InjectionBackend`，新宿主实现 `AgentHost`；宿主只能经 `AgentMessageContext` 工作
5. 所有队列/缓冲有显式上限
6. 显式注入：应用绝不自动部署/启动 SnowLuma 或 QQ
7. 账号数据隔离：不跨账号读写；凭据只走 `credentialRef`
8. 会话角色卡必须显式绑定；生成结果未知时不自动重提
9. 接口与数据兼容：改契约/存储格式前看 `devDoc/28` 的兼容条目
10. 验收纪律：**没有实际环境证据前不宣称完成**

## 文档体系（devDoc/）

编号文档 = 开发时间线，成对出现：`NN-xxx-implementation-plan.md`（方案）→ `NN-xxx-execution.md`（执行记录）→ `NN-xxx-independent-review.md` / `fixes-independent-recheck.md`（独立复核链）。**每个工作包要求实现方自验 + 独立复核两方各留文档**。新增文档按编号续，并在 `devDoc/README.md` 顶部导航登记。

重点篇目：

- `devDoc/28-baseline-behavior-contract.md` — B00 基线与 10 条行为契约（改行为前必读）
- `devDoc/26-backend-target-architecture.md` — 目标架构与分层边界（解释 application/contracts/bootstrap 的由来）
- `devDoc/23-repository-layout-and-version-control.md` — 仓库与 Git 规范
- `devDoc/20-guided-external-snowluma.md` — SnowLuma 接入契约与许可边界
- `devDoc/README.md` — 最新状态导航

## 当前状态（写文档时）

`v0.2.4-dev.2` 开发快照。EXT-E/F/G 已完成本地自动化复核；EXT-H（真实 QQ / 真实模型服务 / 原生界面 / 发行包验收）未完成。开工前先看 `devDoc/README.md` 顶部导航确认最新进展。
