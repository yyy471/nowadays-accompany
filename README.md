# Nowadays

Nowadays 是一个面向单用户桌面的数字生命项目。每个角色拥有独立身份、角色设定、记忆、日记和工作空间，可以在多个对话窗口中延续经历，也可以按自己的安排使用工具、记录成果并主动分享。

当前代码库已包含可运行的 Node/TypeScript 本地后端（HTTP API、SSE 事件流与 CLI）以及基于 Electron + React 的桌面端（主页、关系藏页、逐句对话演出、角色配置与系统设置）。当前阶段进展、已验证基线与待办事项见 [当前状态看板](devDoc/STATUS.md)。

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
Set-Location backend
npm ci
npx -y node@24 --import tsx src/cli.ts --help
npm run dev -- --app-root ./.nowadays --port 3210
```

后端启动后监听 `127.0.0.1:3210`。详细配置、模型绑定、本地 MCP/Skill 接入与 CLI 用法见 [后端使用说明](backend/README.md)。

### 2. 启动桌面端

```powershell
Set-Location desktop/desk-preview/renderer
npm ci
npm run build
Set-Location ..
npm ci
npm start
```

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `backend/src/` | TypeScript 后端、LangGraph 执行、SQLite 存储、HTTP／SSE 与 CLI |
| `backend/examples/` | 角色设定、模型配置、资源绑定、本地 MCP 和 Skill 样例 |
| `backend/tests/` & `backend/reviews/` | 后端自动化测试与阶段专项验收脚本 |
| `desktop/desk-preview/` | Electron 主进程、桌面测试与 `renderer/` React 前端 |
| `desktop/scripts/` | 设计令牌 CSS 生成与样式规则检查脚本（`lint:styles`） |
| `prototypes/` | `p0/` 运行时技术小样与 `dialogue-v5/` 对话交互原型 |
| `devDoc/` | 当前状态、活规范（`specs/`）、产品决策（`161`）与阶段记录 |
| `scripts/` | 仓库级工程辅助脚本（如文档巡检 `check-docs.mjs`） |

## 开发与验证

### 后端（在 `backend/` 目录运行）

```powershell
npm run typecheck
npm test
npx -y node@24 scripts/accept-offline.mjs
```

`accept-offline.mjs` 汇总类型检查、交付回归、全量后端测试、真实进程冒烟及 P2/P3/P4 定向业务场景（使用离线模型与本地工具，报告写入 `backend/test-results/`）。

### 桌面端（修改样式、组件或前端逻辑后）

```powershell
# 1. 令牌同步、样式规则检查与 TypeScript 检查（desktop/desk-preview/renderer）
npm run check
npm run build

# 2. 桌面测试（desktop/desk-preview）
npx -y node@24 --test tests/*.test.cjs
```

### 文档巡检（仓库根目录）

```powershell
node scripts/check-docs.mjs
```

## 开发进度

- **当前主线**：后端本机原型及操作链路简化、配置守卫已通过离线独立复验；桌面端主页、关系藏页、对话页、角色配置与设置已接入并建立设计令牌样式门禁。
- **待推进**：操作链路简化剩余功能与联调、ComfyUI 图生图与真实服务（模型/语音/生图）联调、Windows 桌面交付，以及桌面端完成后的远程 Streamable HTTP MCP（DL-115）。详细清单见 [devDoc/STATUS.md](devDoc/STATUS.md)。

`master` 包含主线后端原型与设计基线，`dev-front` 为当前桌面端重构推进分支，`dev` 归档旧版项目代码与历史。

## 文档

- 当前状态、待办与验收基线：[当前状态看板](devDoc/STATUS.md)
- 现行开发规范总览：[现行规范索引](devDoc/specs/README.md) · [前端设计规范](devDoc/specs/frontend-design-system.md)
- 后端安装、配置与接口用法：[后端使用说明](backend/README.md)
- 需求、架构与已确认的产品边界：[持续决策记录](devDoc/161-digital-life-direction-decisions.md)
- 全部历史方案与复核记录索引：[开发文档索引](devDoc/README.md)
- 仓库协作及开发约定：[协作指南](AGENTS.md)
