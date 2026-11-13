# 304 303 补修独立复验问题修复

2026-11-13。对应 [283 第 23 节复验](283-278-workflow-simplification-independent-review.md#23-303-补修独立复验)。

## 修复内容

- **维护／删除／无绑定期间停止安排零延迟扫库与唤醒**：
  - 在 [`MemoryRuntime.canScheduleNow`](../backend/src/application/memory-runtime.ts#L350-L363) 与 [`armTimer`](../backend/src/application/memory-runtime.ts#L365-L433) 中，先清掉旧定时器，若角色处于删除收尾、缺少可用记忆模型绑定或目标模型服务正在维护，立即返回，不再打开角色库读取 `nextFailedRetryAt`、`maintenanceRetryAt`、`maintenanceCheckAt`、阈值窗口或 `reconcileRetryAt`，也不再安排 `delay = 0` 的定时回调。
  - 在 [`runOnce`](../backend/src/application/memory-runtime.ts#L532-L551) 因缺少绑定、角色删除或目标服务维护提前返回时，同步清理过期的 `reconcileRetryState`；已结束但未补写触发的任务继续保留在角色库 `tasks` 与待整理工具证据中，待维护结束、恢复绑定或删除失败后由 `wakePendingWork` / `kick` 重新唤醒对账并执行一次整理。
- **非维护路径下保证补写退避始终向未来推进**：
  - 抽取 [`advanceReconcileRetry`](../backend/src/application/memory-runtime.ts#L484-L494)，并将 [`runOnce` 批内退避结算](../backend/src/application/memory-runtime.ts#L672-L692) 收拢到 `finally`：当 `reconcileFinishedTaskTriggers` 顶层抛错、返回 `failedTaskIds` 或既有 `retryAt` 已到期而角色库仍有待补写任务时，都会推进下一次退避时间戳，避免后续 `armTimer` 读到过期 `retryAt` 触发零延迟循环。

## 验证

- **专项测试**（[`backend/tests/p18-278-review-fixes.test.ts`](../backend/tests/p18-278-review-fixes.test.ts#L3109-L3395)）：
  - `退避到期时模型仍在维护不重复扫库，维护结束后自动整理一次（283 §23）`：覆盖虚拟 30 秒退避定时器到期与 HTTP 真实事件循环下唤醒两条路径，确认退避到期且模型处于维护期内不再重复打开角色记忆存储、待补写扫描与失败重试查询为 0、模型调用为 0，解除写库故障并结束维护后自动补写 `task_end` 并单次完成整理。
  - 执行 `cd backend && npx -y node@24 --import tsx --test --test-name-pattern="283 §23" tests/p18-278-review-fixes.test.ts` 通过（`1/1`）。
- **后端全量检查**：
  - `cd backend && npm run typecheck` 通过。
  - `cd backend && npx -y node@24 --import tsx --test --test-concurrency=8 tests/*.test.ts` 通过（`397/397`）。
- **离线验收**：
  - `cd backend && npx -y node@24 scripts/accept-offline.mjs` 通过（`21/21` 步全过，报告位于 `backend/test-results/p5-2026-11-13T12-38-40-465Z-6bb02d2b/summary.json`，`realServiceCalls: 0`）。
- **桌面端检查**：
  - `npm --prefix desktop/desk-preview/renderer run typecheck`、`npm --prefix desktop/desk-preview/renderer run build` 与 `npx -y node@24 --test desktop/desk-preview/tests/*.test.cjs` 通过（`115/115`）。
