# Nowadays

Nowadays 是一个面向单用户桌面的数字生命项目。每个角色拥有独立身份、角色设定、记忆、日记和工作空间，可以在多个对话窗口中延续经历，也可以按自己的安排使用工具、记录成果并主动分享。

当前代码库已包含可运行的 Node/TypeScript 本地后端（HTTP API、SSE 事件流与 CLI）以及基于 Electron + React 的桌面端（主页、关系藏页、逐句对话演出、角色配置与系统设置）。当前阶段进展、已验证基线与待办事项见 [当前状态看板](./docs/STATUS.md)。

## 主要功能

- **角色与对话**。同一角色可以维护多个独立窗口，并在窗口之间共享长期记忆。更新设定时，角色身份和已有经历会保留；对话按自然句段逐句演出，支持表情差分、语音合成与过场图。
- **事件记忆**。从对话和活动中整理事件与日常摘要，并保留角色写下的日记。角色回复时可以按需检索，并追溯到原始证据。
- **自主活动**。角色可以安排后续行动、到时唤醒、保存成果并主动分享。自主调用使用统一的每日额度。
- **模型与扩展**。提供 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、TTS 统一协议及 ComfyUI 生图适配；工具通过本地 stdio MCP 接入，方法与知识通过 Agent Skills 按需加载。
- **中断与恢复**。持久化消息、任务、工具结果、配置写入守卫及图检查点。进程重启时可恢复符合条件的任务，并记录结果未知的操作以供核查。

## 快速开始

### 1. 启动后端

需要 Git、Node.js 24 或更高版本，以及 npm（Windows x64 下常用 `npx -y node@24` 指定版本）。以下命令使用 PowerShell：

```powershell
Set-Location apps/backend
npm ci
npx -y node@24 --import tsx src/cli.ts --help
npm run dev -- --app-root ./.nowadays --port 3210
```

后端启动后监听 `127.0.0.1:3210`。详细配置、模型绑定、本地 MCP/Skill 接入与 CLI 用法见 [后端使用说明](./apps/backend/README.md)。

### 2. 启动桌面端

```powershell
Set-Location apps/desktop/renderer
npm ci
npm run build
Set-Location ..
npm ci
npm start
```

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `apps/backend/src/` | TypeScript 后端、自有节点执行循环、SQLite 存储、HTTP／SSE 与 CLI |
| `apps/backend/examples/` | 角色设定、模型配置、资源绑定、本地 MCP 和 Skill 样例 |
| `apps/backend/tests/` & `apps/backend/scripts/` | 后端分层测试（`unit/`、`integration/`、`acceptance/`、`fixtures/`）与验证/评测脚本（`verify/`、`eval/`） |
| `apps/desktop/` | Electron 主进程、桌面测试与 `renderer/` React 前端（`src/pages/`、`styles/` 与 `tests/`） |
| `apps/desktop/scripts/` | 设计令牌 CSS 生成与样式规则检查脚本（`lint:styles`） |
| `apps/desktop/tests/` | `unit/` 壳与打包单测（CJS）、`integration/` 跨端联调、`e2e/` Electron 端到端、`live/` 实机脚本 |
| `docs/` | 当前状态、活规范（`specs/`）、产品决策（`161`）与阶段记录 |
| `tools/art-pipeline/` | 美术资产生成流水线（与桌面构建解耦） |
| `scripts/` | 仓库级工程辅助脚本（分层验证 `verify.mjs`、文档巡检、仓库卫生巡检、产物清理） |

## 开发与验证

### 仓库级统一入口（根目录，Node 24）

```powershell
npm run verify:fast   # 按改动域映射的快速自检
npm run verify:unit   # 全量单测、类型检查与前端构建
npm run verify:gate   # 离线全量门禁（21 步验收 + 15 条 Electron E2E）
```

### 后端（在 `apps/backend/` 目录运行）

```powershell
npm run typecheck
npm test
npx -y node@24 scripts/verify/accept-offline.mjs
```

`scripts/verify/accept-offline.mjs` 汇总类型检查、交付回归、全量后端测试、真实进程冒烟及 P2/P3/P4/P5 定向业务场景（使用离线模型与本地工具，报告写入根目录 `test-results/backend-acceptance/`）。

### 桌面端（修改样式、组件或前端逻辑后）

```powershell
# 1. 令牌同步、样式检查、TypeScript 检查与渲染器单测（在 apps/desktop/renderer 运行）
npm run check
npm test
npm run build

# 2. 桌面壳单测与 E2E（在 apps/desktop 运行；全套 E2E 也可用根目录 npm run verify:e2e）
npx -y node@24 --test tests/unit/*.test.cjs
npx -y node@24 --import tsx --test tests/integration/feed-integration.test.ts
```

### 文档与仓库卫生巡检（仓库根目录）

```powershell
node scripts/check-docs.mjs
node scripts/check-repo-hygiene.mjs
```

## 开发进度

- **当前主线**：后端本机原型及操作链路简化、配置守卫已通过离线独立复验；桌面端主页、关系藏页、对话页、角色配置与设置已接入并建立设计令牌样式门禁。
- **待推进**：操作链路简化剩余功能与联调、ComfyUI 图生图与真实服务（模型/语音/生图）联调、Windows 桌面交付，以及桌面端完成后的远程 Streamable HTTP MCP（DL-115）。详细清单见 [docs/STATUS.md](./docs/STATUS.md)。

`master` 包含主线后端原型与设计基线，`dev-front` 为当前桌面端重构推进分支，`dev` 归档旧版项目代码与历史。

## 文档

- 当前状态、待办与验收基线：[当前状态看板](./docs/STATUS.md)
- 现行开发规范总览：[现行规范索引](./docs/specs/README.md) · [前端设计规范](./docs/specs/frontend-design-system.md)
- 后端安装、配置与接口用法：[后端使用说明](./apps/backend/README.md)
- 需求、架构与已确认的产品边界：[持续决策记录](./docs/161-digital-life-direction-decisions.md)
- 全部历史方案与复核记录索引：[开发文档索引](./docs/README.md)
- 仓库协作及开发约定：[协作指南](AGENTS.md)
