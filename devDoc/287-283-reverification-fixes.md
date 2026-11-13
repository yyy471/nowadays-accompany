# 287 283 第 6 节复验问题修复

2026-11-12。按 [283 第 6 节复验](283-278-workflow-simplification-independent-review.md#6-286-补修独立复验) 修复两处扩展场景缺口。R05、R09 在该轮复验中通过，本轮未改动。本文为实现方自验记录，复验仍由独立复核确认。283 第 7 节复验后的补修见 [288](288-283-reverification-fixes.md)。

## 1. 修复内容

| 编号 | 修复 |
| --- | --- |
| R01 已停止角色的在途记忆调用 | 记忆运行时记录每批实际使用的模型服务，并按目标服务提供在途角色。维护计划新增只等待、不恢复的 `waitRoleIds`：已停止角色若仍在目标服务上整理记忆，维护会在写入前等它结算（20 秒上限，超时返回 409）；这些角色不进入 `maintenance.pausedRoleIds`，活动状态保持 `stopped`。维护窗口期间新发起的整理仍在入口暂缓。 |
| R02 正常恢复后的同文本重发 | 原消息的执行被 SSE 确认时，除清除等待提示外，同时删除这一内容对应的重试记录；之后输入相同文本发送会生成新的 `submissionId`，不再被后端当作旧消息去重。尚未被确认的提交仍保留原标识，继续提供响应丢失后的去重保护。 |

## 2. 变更文件

- 后端：`memory-runtime.ts`（记录在途服务与 `inflightRoleIds`）、`resource-service.ts`（`waitRoleIds`、`waitForInflightIdle`）、`routes.ts`（等待已停止角色的在途调用）、`app.ts`（注入在途查询）。
- 桌面：`use-window-session.ts`（执行确认时结束对应重试记录）。
- 测试：`backend/tests/p18-278-review-fixes.test.ts` 新增「已停止角色的在途记忆调用」用例。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `npx -y node@24 node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 定向用例 | `tests/p18-278-review-fixes.test.ts`、`p14-role-activity.test.ts`、`p15-resource-management.test.ts` | 37／37 |
| 后端全量测试 | `--import tsx --test --test-concurrency=8 tests/*.test.ts` | 369／369 |
| 后端离线验收 | `npx -y node@24 scripts/accept-offline.mjs` | 21／21 步全绿，`realServiceCalls=0` |
| 渲染端类型检查／构建 | `desktop/desk-preview/renderer` | 通过 |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 113／113 |

验收报告：`backend/test-results/p5-2026-11-12T09-34-02-887Z-15b36a06/summary.json`。

新增用例覆盖：

1. 角色确认停止后，通过记忆整理接口发起挂起的整理；模型维护进入等待，地址在结算前保持不变，活动接口同时返回 `stopped` 与 `running=true`。
2. 结算后 PATCH 成功，`maintenance.pausedRoleIds` 为空，角色保持停止。

## 4. 交接边界

- 本文为实现方自验；R02 的同文本重发仍需 Electron 复验两种响应先后顺序。
- [283 第 3 节](283-278-workflow-simplification-independent-review.md#3-待实施与待验收) 所列的句段标注与过场图规划维护期拦截、角色删除同页流程、草稿生图、未保存录音试听、设置导航收敛仍未实施。
