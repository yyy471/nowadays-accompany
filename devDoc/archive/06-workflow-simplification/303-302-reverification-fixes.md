# 303 302 补修独立复验问题修复

2026-11-13。按 [283 第 22 节](283-278-workflow-simplification-independent-review.md#22-302-补修独立复验) 修复「单项任务补写失败会阻塞角色的其他整理」问题（292-R03 扩展场景 · P2）。302 的跨重启补写原场景在该轮复验中通过；本文为实现方自验记录，最终结论仍由独立复核确认。

## 1. 修复内容

- 在 [memory-store.ts](../../../backend/src/storage/memory-store.ts#L340-L366) 将 `reconcileFinishedTaskTriggers` 从整批单事务改为**按任务独立事务与逐项异常隔离**，返回 `{ inserted, failedTaskIds }`。任一结束任务的 `task_end` 写入失败不会回滚同角色其他任务，也不会抛出未捕获异常中断后续步骤。
- 在 [memory-runtime.ts](../../../backend/src/application/memory-runtime.ts#L543-L650) 的 `runOnce` 对对账补写 `reconcileFinishedTaskTriggers`、对话触发生成 `service.onEvidenceRegistered`、逐项 `service.onTaskFinished` 以及 `service.enqueueManual` 做故障隔离：
  - 个别任务写 `task_end` 失败时保留在 `deferredTaskIds` 与数据库可对账集合中，并在 `reconcileRetryState` 记录退避重试（`armTimer` 检查 `reconcileRetryAt`），模型可用且角色有其他触发（如已入库的 `manual` 手动整理、`message_threshold`／`idle` 对话整理、或同批次其余健康的 `task_end`）时继续执行 `runPending`／`runBatch`，不再提前退出。
  - 若失败任务的工具证据已随本轮其余整理一并完成处理，本轮结束后清理其过期暂存与重试计数；若仍未处理且缺少未消费 `task_end`，保留可重试状态等待后续唤醒、重启或定时退避重试。
- 在 `close()` 与 `disposeRole()` 同步清理 `reconcileRetryState`。

## 2. 变更文件

- 后端存储：`backend/src/storage/memory-store.ts`（`reconcileFinishedTaskTriggers` 逐项事务隔离并返回 `{ inserted, failedTaskIds }`）。
- 后端运行时：`backend/src/application/memory-runtime.ts`（`reconcileRetryState`、`close`、`disposeRole`、`armTimer`、`reconcileRetryAt`、`runOnce`）。
- 测试：`backend/tests/p18-278-review-fixes.test.ts` 新增「单项任务触发补写失败不阻塞手动整理与独立对话整理（283 §22）」与「部分任务补写失败保留可重试状态且不阻塞其他任务触发（283 §22）」。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `cd backend && npm run typecheck` | 通过 |
| 后端全量测试 | `cd backend && npx -y node@24 --import tsx --test --test-concurrency=8 tests/*.test.ts` | 396／396 |
| 后端离线验收 | `cd backend && npx -y node@24 scripts/accept-offline.mjs` | 21／21 步通过，`realServiceCalls=0` |
| 渲染端类型检查与构建 | `npm --prefix desktop/desk-preview/renderer run typecheck && build` | 通过 |
| 桌面逻辑测试 | `npx -y node@24 --test desktop/desk-preview/tests/*.test.cjs` | 115／115 |

验收报告：`backend/test-results/p5-2026-11-13T12-17-30-115Z-5f4f60a9/summary.json`。

新增用例覆盖：
- 运行中拦截 `task_end` 插入且记忆模型可用：结束任务（`200`）后再调用 `POST /v1/roles/:roleId/memory/batches`（`202`），故障未解除时手动触发仍被正常消费并完成独立对话证据整理，不受 `task_end` 失败阻断。
- 删除超时返回 `409 ROLE_BUSY` 并保留 `task_end` 写入故障跨重启（原 `deferredTaskIds` 已清空）：重启后发起手动整理仍立即完成消费并整理独立对话证据。
- 同一角色两个已结束任务：排序在前的 `blockedTaskId` 被单独拦截写库时，排序在后的 `healthyTaskId` 仍成功写入并消费 `task_end`、执行整理。
- 失败任务在不发起手动整理时保留 `listFinishedTasksNeedingTrigger` 与待整理工具证据，解除故障并唤醒后自动补写 `task_end` 并完成整理。

## 4. 交接边界

- 本文为实现方自验；独立复核需按 283 第 22 节继续复验，并在独立复核通过前不提交。
- 278 §5 的草稿生图、未保存录音试听、设置导航收敛与 §4 的跨页返回、重连等待原因仍待实施或联调。
