# 305 304 补修独立复验问题修复

2026-11-13。对应 [283 第 24 节复验](283-278-workflow-simplification-independent-review.md#24-304-补修独立复验)。

## 修复内容

- **把 `canScheduleNow` 纳入 `armTimer` 异常保护边界**：
  - 在 [`MemoryRuntime.canScheduleNow`](../backend/src/application/memory-runtime.ts#L363-L382) 中，除原有的 `ModelBindingMissingError` 外，只将非锁类绑定/角色状态异常（`ResourceKindMismatchError`、`RoleNotFoundError`、`RoleNotReadyError`、`InvalidRoleIdError`）判定为不可调度，临时读库错误（如 `SQLITE_BUSY`）交由 [`armTimer`](../backend/src/application/memory-runtime.ts#L405-L488) 的统一 `try/catch` 接管，不再从 `drain` 的 `finally` 向外抛出未处理 Promise 拒绝，避免单角色临时锁冲突导致整个后端进程退出。
- **读库临时失败与遗留待处理触发的退避自动恢复**：
  - 在 [`armTimer`](../backend/src/application/memory-runtime.ts#L459-L483) 与 [`isMissingRoleStorageError`](../backend/src/application/memory-runtime.ts#L874-L889) 中，当读取绑定或打开角色库出现非路径缺失/非法错误时，通过 [`nextTimerRetryDelayMs`](../backend/src/application/memory-runtime.ts#L384-L392) 与 [`scheduleWakeTimer`](../backend/src/application/memory-runtime.ts#L394-L403) 安排短退避唤醒（`250ms` 起步）；当角色库可打开但仍有未消费触发（`listPendingTriggers`）或尚未登记补写退避的已结束任务（`listFinishedTasksNeedingTrigger`）时同样安排恢复唤醒；[`recoverOnStartup`](../backend/src/application/memory-runtime.ts#L147-L150) 遇单角色恢复异常时也接入 `armTimer`，并在 `close`／`disposeRole` 时清理退避状态。

## 验证

- **专项测试**（[`backend/tests/p18-278-review-fixes.test.ts`](../backend/tests/p18-278-review-fixes.test.ts#L3400-L3678)）：
  - `定时器读取绑定或角色库暂不可用时不崩溃且恢复后继续处理已持久化触发（283 §24）`：
    1. 在 Node 默认设置（未处理 Promise 拒绝直接退出）的独立子进程内，经由 `POST /v1/roles/:roleId/memory/batches`（返回 `202`）并在 `canScheduleNow` 注入 `SQLITE_BUSY`，验证工具证据处理完成、子进程不崩溃并以退出码 `0` 收尾、`/v1/health` 返回 `200`。
    2. 分别向 `canScheduleNow` 与 `armTimer` 直接打开角色库两条路径注入 `SQLITE_BUSY` 后解除锁，验证不触发未处理拒绝且短退避定时器在存储恢复后自动消费持久化 `manual` 触发并完成一次整理。
  - 执行 `cd backend && npx -y node@24 --import tsx --test --test-name-pattern="283 §24" tests/p18-278-review-fixes.test.ts` 通过（`1/1`）。
- **后端全量检查**：
  - `cd backend && npm run typecheck` 通过。
  - `cd backend && npx -y node@24 --import tsx --test --test-concurrency=8 tests/*.test.ts` 通过（`398/398`）。
- **离线验收**：
  - `cd backend && npx -y node@24 scripts/accept-offline.mjs` 通过（`21/21` 步全过，报告位于 `backend/test-results/p5-2026-11-13T12-58-44-669Z-736fc21a/summary.json`，`realServiceCalls: 0`）。
- **桌面端检查**：
  - `npm --prefix desktop/desk-preview/renderer run typecheck`、`npm --prefix desktop/desk-preview/renderer run build` 与 `npx -y node@24 --test desktop/desk-preview/tests/*.test.cjs` 通过（`115/115`）。
