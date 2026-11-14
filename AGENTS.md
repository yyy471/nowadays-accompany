# Nowadays 新主线协作指南

> 本文件只保留**长期不变的协作规范、环境命令与架构红线**（严禁在此堆积阶段进度、修复流水或测试计数，以免超长截断）。

## 1. 开始前必读

1. **当前进度与待办**：[devDoc/STATUS.md](devDoc/STATUS.md)（每次接手先看这里，了解最新通过范围与未决事项）。
2. **持续决策记录**：[devDoc/161-digital-life-direction-decisions.md](devDoc/161-digital-life-direction-decisions.md)（`DL-xx` 已确认需求与边界的唯一权威记录）。
3. **现行规范总览**：[devDoc/specs/README.md](devDoc/specs/README.md)（涉及桌面前端改动**必读** [前端设计规范](devDoc/specs/frontend-design-system.md)）。
4. **文档总索引**：[devDoc/README.md](devDoc/README.md)；原型入口参见 [首轮执行清单](devDoc/archive/01-backend-prototype/164-backend-prototype-execution-checklist.md) 与 [参考底稿](devDoc/design/digital-life/langgraph-roleplay-engine-v2.reference.md)（原稿不自动构成项目决定）。

## 2. 分支、环境与验证命令

- **分支布局**：`master` 为主开发分支；当前桌面前端推进在 `dev-front`；`dev` 归档旧版项目与历史（按需用 `git show dev:<path>` 参考，不批量复制旧结构或兼容层）；`codex/p0-runtime-spike` 保留 `prototypes/p0/` 技术小样。新功能分支默认使用 `codex/` 前缀。
- **依赖隔离**：根目录旧 `node_modules`、构建产物和日志属于旧工作区残留，不得与 `backend/node_modules`（Node 24 ABI 编译的 `better-sqlite3`）或 `desktop/` 依赖混用。
- **常用验证命令**：
  - **后端**（`backend/`，必须使用 Node 24）：`npx -y node@24 --import tsx ...`、`npm run typecheck`、`npm test`、`npx -y node@24 scripts/accept-offline.mjs`（说明见 [backend/README.md](backend/README.md)）。
  - **桌面端**：
    - 渲染器自检（修改 CSS/TSX/令牌后必跑）：`cd desktop/desk-preview/renderer && npm run check`（`tokens:check` + `lint:styles` + `typecheck`）与 `npm run build`；
    - 修改 [`tokens.json`](devDoc/design/character-studio/tokens.json) 后先运行 `npm run tokens`，禁止手改 `ui/character-tokens.css`；
    - 桌面测试：`cd desktop/desk-preview && npx -y node@24 --test tests/*.test.cjs`。
  - **文档巡检**：`node scripts/check-docs.mjs`。

## 3. 与用户协作

- 一次讨论一个决定，用户确认后再推进下一项，避免一次展开过多内容。
- 新确认决定追加到 [161](devDoc/161-digital-life-direction-decisions.md) 并使用稳定的 `DL-xx` 编号；修订既有决定先讨论确认，再改正文并追加变更记录。
- 明确区分**已确认需求、候选方案、已有实现、自验与独立复核、离线范围与真实服务**，不将建议写成已同意需求，不以自验替代独立结论，不以离线通过外推真实联调。

## 4. 已确认的核心架构边界

- 每个角色实例是一个独立数字生命；修订设定保留身份与经历，多窗口独立保存，长期记忆跨窗口共享，数据以 Nowadays 为中心。
- 核心采用 LangGraph TypeScript 编排；业务数据使用 SQLite，每个角色独立分库；角色工作空间位于 Nowadays 专用目录下，笔记采用 Markdown。
- 外部工具统一 MCP，方法与知识采用通用 Agent Skills（按需加载，不保留旧私有插件协议）；提供本地 MCP 基础读写、目录检索与脚本执行工具，Skill 内容与环境由用户负责。
- 模型、MCP、Skill 等只提供启用／停用开关，不加额外授权审批；停用立即阻止新任务使用，已执行的原任务链保留使用权至整条链结束（DL-71）。
- 对话结合正在输入状态启动回复，停止输入 1 秒后退出（不配开关）；仅实际发送新消息才中断未完成回复（DL-80～DL-82）。
- 记忆形成、索引、自动召回、深入证据检索、自主活动、成长、日记、预算与桌面接管按 `DL-xx` 决策执行，不擅自简化或删改；第一版限单用户桌面端，QQ／SnowLuma 与远程 MCP（DL-115）后置。

## 5. 实施、验收与文档维护规则

- **代码与测试**：保持职责清晰、依赖显式，不引入模块级可变业务单例；中文注释配清晰的英文错误码；自动化测试使用离线模型与本地工具样例，真实服务配置另行联调留证；独立复核未通过前不宣称完成。
- **Git 提交**：使用 `feat:`、`fix:`、`docs:`、`chore:` 等前缀及中文说明。
- **文档写入规范**：
  1. **不膨胀入口**：严禁向 `AGENTS.md` 写入阶段总结、每轮修补细节或测试计数；当前状态只更新 [devDoc/STATUS.md](devDoc/STATUS.md)。
  2. **按专项聚合**：同一专项/工作包的后续多轮复核发现、补修与复验，**在同一份复核/修复文档内按小节追加**，不要每轮新建独立编号文件。
  3. **现行规范单源维护**：涉及长期前端或后端通用规则，直接更新 [devDoc/specs/](devDoc/specs/README.md) 对应活规范；阶段实施与复核记录归入 `devDoc/archive/`（禁止在 `devDoc/` 根目录平铺 `NNN-*.md`），并在 [devDoc/README.md](devDoc/README.md) 登记，改动后运行 `node scripts/check-docs.mjs`。
  4. **禁止混入运行日志**：测试与构建 `.log` 统一落到被忽略的 `test-results/`，不得放入 `devDoc/`。
