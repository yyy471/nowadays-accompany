# 278 进展三：模型依赖维护、资源详情与首次对话入口

> **现行规范入口**：本文模型依赖影响范围、MCP/Skill 详情停用放行与绑定并发自动合并的现行规则已整合并入 [角色配置、全局资源与活动守卫规范](../../specs/role-config-and-activity.md)；下文保留阶段进展与自验记录。

2026-11-12。本轮继续实施 [278](278-project-workflow-simplification-fix-plan.md)：按实际依赖暂停模型服务、MCP／Skill 的停用与详情维护、首次对话入口和绑定自动合并。前两包见 [280](280-278-progress-role-workspace-dialogue-receipt.md)、[281](281-278-progress-guarded-panels.md)。

独立复核发现模型维护并发、对话恢复与绑定合并等缺口，整条链路未通过。复现结果与修复后的验收条件见 [283 独立复核](283-278-workflow-simplification-independent-review.md)。R01～R09 的修复与自验见 [284](284-278-review-fixes.md)。

## 1. 模型维护只暂停实际依赖（278 §2）

- 新增 `GET /v1/resources/:resourceId/impact`：按实际模型解析列出依赖该服务的角色、用途（对话／记忆／未结束任务）、任务与活动状态。记忆未单独绑定时跟随对话模型；同一角色只计一次。
- `PATCH /v1/resources/:resourceId` 不再要求所有角色停止：只改名称或启用状态直接保存；连接参数、协议或密钥变化时只暂停**启用中且实际依赖**该服务的角色，等待后端确认停止后写入，响应返回 `maintenance.pausedRoleIds`。无关角色保持活动并继续处理自己的任务。
- 桌面资源详情展示影响范围；有启用中的依赖时保存按钮显示「暂停相关角色并保存」，成功后可在原处「继续本次活动暂停的角色」。
- 角色删除/维护的既有边界不变；暂停确认失败返回结构化 409，草稿保留。

**边界。** 本轮按角色暂停依赖，尚未实现「任务单独依赖目标服务时只暂缓该任务」的调度级编排，也尚未在维护窗口内统一拦截后台记忆／标注／过场规划的新调用；这些调用在角色停止后仍可能结算已发出的请求，后续包按 278 §2.1 补齐。

## 2. MCP／Skill 停用与详情维护（278 §3）

- 全局停用不再要求关闭角色绑定或清空任务链：单独切换 `enabled` 立即保存，新任务不再选择该资源，旧任务与已发调用按原任务继续；同时修改配置或名称时仍按占用检查整笔处理。
- 引用报告 `canDisable` 恒为可停用；`canUpdate`／`canDelete` 维持占用判断。
- 模型与扩展的资源详情新增：
  - 引用列表显示角色／任务；未结束任务提供「结束任务」（走既有任务终结接口，已发调用按原任务结算）。
  - 「关闭该角色绑定」「关闭全部启用绑定」：需要时先在当前页面暂停该角色，写入后恢复本次暂停；部分失败逐项提示。
- 设置页资源详情不再要求「所有角色已停止」才能进入编辑，后端按实际占用与依赖给出最终判定。

## 3. 首次配置与对话入口（278 §4 部分）

- 主页无角色时提供「创建角色」；对话页无角色空态同样提供「创建角色」，直接打开角色创建表单并定位到角色配置。
- 角色配置的模型区在对话绑定可用时提供「开始对话」：角色停止时先恢复活动，再切换到该角色的对话页；「配置对话模型」仍返回发起角色与模型分区。
- 消息接收结果与等待原因沿用 [280](280-278-progress-role-workspace-dialogue-receipt.md) 的契约与入口。

## 4. 绑定字段级自动合并（278 §5 部分）

- 保存绑定遇到 `BINDING_REVISION_CONFLICT` 时重新读取最新绑定，按能力逐个比较基线、草稿与服务端：只有互不重叠的修改自动合并并重试一次；同一能力被两边同时修改时提示具体字段并保留草稿。

## 5. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p14-role-activity.test.ts`、`tests/p15-resource-management.test.ts` | 通过（模型依赖暂停、停用放行、引用与删除场景已更新） |
| 后端全量测试 | `--test-concurrency=8 tests/*.test.ts` | 358／358 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0`、`sourceUnchanged=true` |
| 渲染端类型检查与构建 | `desktop/desk-preview/renderer && npm run typecheck && npm run build` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 109／109 |
| Electron 联调 | 模型影响范围、暂停并保存、资源详情批量关闭与结束任务、开始对话、绑定自动合并 | 待联调 |

验收报告：`backend/test-results/p5-2026-11-12T06-28-25-420Z-26b10052/summary.json`。

## 6. 变更清单

| 文件 | 变更 |
| --- | --- |
| `backend/src/application/resource-service.ts` | `impact()`、`maintenancePlan()`、停用快速路径、`canDisable` 放行、维护协调端口 |
| `backend/src/http/routes.ts` | `GET /impact`；模型 PATCH 只暂停依赖角色并返回 `maintenance`；资源写入交给处理器 |
| `backend/src/application/role-activity-service.ts` | 配置写入按角色串行（AD-R06 延续） |
| `backend/src/bootstrap/app.ts` | 维护协调：按依赖暂停角色并等待确认 |
| `backend/tests/p14-role-activity.test.ts`、`p15-resource-management.test.ts`、`config-write.ts` | 模型依赖暂停、停用放行、夹具不再全局停止 |
| `desktop/.../pages/Settings.tsx` | 影响范围与继续活动、任务终结、绑定关闭、创建/开始对话入口、绑定自动合并 |
| `desktop/.../pages/Home.tsx`、`Conversation.tsx`、`App.tsx` | 无角色空态创建入口与导航请求 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/278`、`devDoc/281`、项目工作记忆 |

## 7. 交接边界

- 本轮为实施方自验；Electron 实机与第 6 节视觉对照待执行。
- 278 第 2 节剩余：任务单独依赖时的调度级暂缓、维护窗口内后台模型调用的统一拦截、绑定 A→B 双侧协调的完整并发场景。
- 278 第 5 节剩余：草稿生图连接探测与草稿样图、未保存录音试听（临时输入）、设置导航收敛。
- 第 3 节的部分交互（全局停用后的任务列表、批量关闭的多角色失败重试）与真实服务联调仍待补验。
