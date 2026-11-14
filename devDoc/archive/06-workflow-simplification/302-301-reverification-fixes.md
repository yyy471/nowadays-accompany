# 302 301 补修独立复验问题修复

2026-11-13。按 [283 第 21 节](283-278-workflow-simplification-independent-review.md#21-301-补修独立复验) 修复「触发写入失败时已确认的整理仍无法跨重启恢复」问题（292-R03 扩展场景 · P2）。301 的正常重启场景在该轮复验中通过；本文为实现方自验记录，最终结论仍由独立复核确认。

## 1. 修复内容

- 在 [memory-store.ts](../../../backend/src/storage/memory-store.ts) 新增 `listFinishedTasksNeedingTrigger` 与 `reconcileFinishedTaskTriggers`：以已持久化的 `tasks`（`status IN ('completed', 'failed')`）、工具结果 `evidence_records`（`er.task_id = t.task_id`）及 `evidence_processing.status = 'pending'` 为准，为缺少未消费 `task_end` 触发的已结束任务按事务幂等补写 `task_end` 触发；已通过 `keepHistory=1`/`0` 删除成功的角色已从 `app.db` 的 `roles` 移除，重启恢复不会对已删除角色触发整理。
- 在 [memory-runtime.ts](../../../backend/src/application/memory-runtime.ts) 的 `recoverOnStartup` 补齐对账：先调用 `store.reconcileFinishedTaskTriggers` 补写缺失的 `task_end` 触发（若存储触发写仍受阻则本地捕获异常），再同时检查 `listPendingTriggers` 与 `listFinishedTasksNeedingTrigger` 以决定启动后是否排队唤醒检查，避免故障直到重启后唤醒前才恢复时被遗漏。
- 在 `notifyTaskFinished` 与 `persistTaskEndTrigger` 统一即时持久化逻辑：无论角色是否处于删除保护期，任务结束均先尝试写入 `task_end` 触发，区分 `"persisted"` / `"none"` / `"failed"`，仅在 `"failed"` 时转入内存暂存 `deferredTaskIds`；非删除状态下入队 `pendingScheduled` 检查，不再依赖可能因维护提前返回的 `pendingTaskIds`。
- 在 `runOnce` 先执行 `store.reconcileFinishedTaskTriggers`，再吸收 `deferredTaskIds` 与本次 `taskIds`，并仅在相关写库完成后移除本次快照对应的 `deferredTaskIds`，避免提前清队列导致写入失败或并发通知丢失。

## 2. 变更文件

- 后端存储：`backend/src/storage/memory-store.ts`（`listFinishedTasksNeedingTrigger`、`reconcileFinishedTaskTriggers`）。
- 后端运行时：`backend/src/application/memory-runtime.ts`（`recoverOnStartup`、`notifyTaskFinished`、`persistTaskEndTrigger`、`runOnce`）。
- 测试：`backend/tests/p18-278-review-fixes.test.ts` 新增「触发写入失败时已确认的任务结束整理仍可跨重启恢复（283 §21）」与「删除成功路径与非删除触发写入失败场景边界（283 §21）」。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `cd backend && npm run typecheck` | 通过 |
| 后端全量测试 | `cd backend && npx -y node@24 --import tsx --test --test-concurrency=8 tests/*.test.ts` | 394／394 |
| 后端离线验收 | `cd backend && npx -y node@24 scripts/accept-offline.mjs` | 21／21 步通过，`realServiceCalls=0` |
| 渲染端类型检查与构建 | `npm --prefix desktop/desk-preview/renderer run typecheck && build` | 通过 |
| 桌面逻辑测试 | `npx -y node@24 --test desktop/desk-preview/tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-13T12-00-09-265Z-d5514a02/summary.json`。

新增用例覆盖：
- `keepHistory=1` 删除超时失败路径：在仅拦截 `memory_triggers`（`kind = 'task_end'`）写入失败时确认完成带待整理工具证据的任务（接口返回 `200` 且 `tasks` 为 `completed`，`memory_triggers` 为 `0` 条），删除返回 `409 ROLE_BUSY`；恢复触发写入、保留同一角色库重启并用 `PATCH /v1/resources/:id` 唤醒后，自动补写并消费一次 `task_end` 触发、完成工具证据整理；再次重启不重复整理。
- `keepHistory=0` 删除超时失败路径（故障持续至重启后、唤醒前才恢复）：同样在保留角色库重启并清除写入故障后唤醒，自动补写并消费一次 `task_end` 触发、完成整理；再次重启不重复整理。
- `keepHistory=1`／`keepHistory=0` 实际删除成功对照：即使删除前注入相同写入故障，删除返回 `200` 后重启不再触发记忆整理。
- 非删除状态确认结束遇 `task_end` 触发写入故障：故障解除并重启后自动对账补写并整理一次。

## 4. 交接边界

- 本文为实现方自验；独立复核需按 283 第 21 节继续复验，并在独立复核通过前不提交。
- 278 §5 的草稿生图、未保存录音试听、设置导航收敛与 §4 的跨页返回、重连等待原因仍待实施或联调。
