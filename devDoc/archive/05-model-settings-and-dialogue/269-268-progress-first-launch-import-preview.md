# 268 进展一：首次活动状态与外观预览修复

2026-11-11。本轮处理 [268](268-model-settings-and-dialogue-fix-plan.md) 第 4 节（首次启动与角色初始状态），并修复用户反馈的「导入立绘文件包后界面不显示图片，保存后才出现」。268 其余章节（第 1、2、3、5、6 节）仍待实施。

## 1. 导入预览不显示立绘

**成因。** 导入预览用 `URL.createObjectURL(file)` 显示所选文件里的主页立绘，`renderer/index.html` 的 CSP 只允许 `img-src 'self' data:`，`blob:` 被拦截；确认导入后图片改由后端素材接口提供，所以只在保存后才能看到。

**修法。**

- CSP 改为 `img-src 'self' data: blob:`。`media-src` 原本已允许 `blob:`。
- 重新构建 `renderer/dist`（Electron 加载的是构建产物）。
- `desktop/desk-preview/tests/appearance-import.test.cjs` 增加断言：CSP 必须允许 `blob:` 图片，避免回退。

**验证。** 桌面逻辑测试 101／101、渲染端类型检查与构建通过。

## 2. 新建角色默认已停止

**成因与规则。** 268 §4：新数据根只要建立一个角色就可能挡住全局配置写入；预置角色与新建角色应先完成配置，再由用户显式开始活动。已有库升级保留现有活动与绑定，不按新规则回填。

**修法。**

- `RoleActivityStore.markCreatedStopped()`：插入 `stopped` 活动记录，已有记录保持原状态（初始化重试不覆盖）。
- `RoleService.createRole()`／`initializeRole()` 在创建索引后、初始化角色库前写入该记录；API、CLI 与初始化重试共用同一路径。
- 夹具与既有用例显式开始活动后继续对话：`tests/p2-05-fixture.ts`、`p1-03`、`p1-05`、`p10-scene-image`、`p12-role-settings`、`p16-role-deletion`。
- `scripts/process-smoke.ts` 的创建后断言改为 `stopped`；配置写入作用域结束后仍断言 `active`。
- `p14` 的「全局写入读体期间新建角色」场景按新语义调整：新角色默认 `stopped`，不再形成绕过全局停止条件的路径，提交按新语义放行；全局租约期间拒绝恢复的断言保留。

**边界。**

- 无活动记录的老角色仍按 `active` 解释，迁移不改写；只有新创建或初始化完成的角色写入 `stopped`。
- 新建角色的模型绑定为空；配置完成后由用户显式「恢复活动」才进入调度与对话。
- 前端需要在角色创建后展示「已停止」，并提供开始活动入口（268 §4、253 页面接入）。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 后端全量测试 | `--test-concurrency=8 tests/*.test.ts` | 355／355 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0`、`sourceUnchanged=true` |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 101／101 |
| 渲染端类型检查与构建 | `desktop/desk-preview/renderer && npm run typecheck && npm run build` | 通过；`dist/index.html` 的 CSP 已包含 `blob:` |

验收报告：`backend/test-results/p5-2026-11-11T16-02-33-029Z-27a6cfd3/summary.json`。

## 4. 变更清单

| 文件 | 变更 |
| --- | --- |
| `backend/src/storage/role-activity-store.ts` | 新增 `markCreatedStopped()` |
| `backend/src/application/role-service.ts` | 创建与初始化完成时写入 `stopped` 活动记录 |
| `backend/scripts/process-smoke.ts` | 创建后活动状态断言改为 `stopped` |
| `backend/tests/p2-05-fixture.ts`、`p1-03`、`p1-05`、`p10`、`p12`、`p16` | 需要对话的用例显式恢复活动；p14 按新语义调整 |
| `desktop/desk-preview/renderer/index.html` | CSP 的 `img-src` 允许 `blob:` |
| `desktop/desk-preview/tests/appearance-import.test.cjs` | 新增 CSP 回归断言 |
| `desktop/desk-preview/renderer/dist/**` | 重新构建（构建产物，不纳入版本控制） |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/268`、项目工作记忆 |

## 5. 交接边界

- 本轮是实施方自验；268 的整体验收（对话差分全链路、模型草稿探测、供应商与模型选择、点击推进）仍待后续实施与独立复核。
- 后端行为变化会影响前端：创建角色后状态为 `stopped`，需要显式「恢复活动」才能对话；已配置的老角色不受影响。
- 导入预览的 CSP 修复只影响桌面渲染进程；用户需要重新构建或以新包运行才能生效。
