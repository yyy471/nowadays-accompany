# 306 305 补修独立复验问题修复

2026-11-13。对应 [283 第 25 节复验](283-278-workflow-simplification-independent-review.md#25-305-补修独立复验)。

## 修复内容

- **登记启动阶段跳过的中断批次恢复角色并在恢复读库后先行补齐**：
  - 在 [`MemoryRuntime`](../backend/src/application/memory-runtime.ts#L86-L87) 新增 `pendingStartupRecoveryRoles`，在 [`recoverOnStartup`](../backend/src/application/memory-runtime.ts#L123-L158) 中仅当 `RoleStorage.openExisting` 或 `recoverInterruptedBatches` 未完成而抛出异常时，将该角色登记到 `pendingStartupRecoveryRoles` 并交由 [`armTimer`](../backend/src/application/memory-runtime.ts#L469-L500) 安排短退避唤醒；若角色路径缺失／非法或执行 `close`／`disposeRole`（[`close`](../backend/src/application/memory-runtime.ts#L275)、[`disposeRole`](../backend/src/application/memory-runtime.ts#L289)），则清理对应登记。
  - 在 [`armTimer`](../backend/src/application/memory-runtime.ts#L469-L486) 中把 `pendingStartupRecoveryRoles.has(roleId)` 纳入短退避唤醒条件，避免遗留 `running` 批次尚无待处理触发或 `failed` 重试时间戳时定时器静默退出。
  - 在 [`runOnce`](../backend/src/application/memory-runtime.ts#L650-L659) 打开角色库后、任何触发写入或 `service.runPending`／`runBatch` 执行之前，先检查 `pendingStartupRecoveryRoles.has(roleId)` 并补齐 `store.recoverInterruptedBatches(roleId, nowIso)`，随即同步移除该角色标记；同时在 [`dueRetry`](../backend/src/application/memory-runtime.ts#L728-L737) 中纳入本次启动补齐恢复到的失败证据。由于该步骤严格串行在角色队列内且仅覆盖未完成启动恢复的角色，因此当前进程正常运行中的批次不会被误重置，也无需再次重启即可继续整理已持久化或新提交的触发。

## 验证

- **专项测试**（[`backend/tests/p18-278-review-fixes.test.ts`](../backend/tests/p18-278-review-fixes.test.ts#L3680-L3938)）：
  - `启动读库失败后恢复遗漏的中断批次并继续整理且不重置运行中批次（283 §25）`：
    1. 用真实 `MemoryStore.startBatch` 在角色库留下“已消费触发 + `running` 状态未完成批次 + `processing` 证据”，重启时仅对目标角色的 `MemoryRuntime` 存储打开注入临时 `SQLITE_BUSY`，确认 `/v1/health` 返回 `200`、遗留批次仍保持 `running` 且模型调用为 `0`。
    2. 分别验证三条路径无需再次重启即可恢复：解锁后等待退避定时器自动把遗留批次置为 `failed`（`PROCESS_INTERRUPTED`）并完成一次整理及后续新增手动整理（`autoRecovery`）；解锁前保留已持久化 `manual` 触发并自动消费完成（`persistedTrigger`）；解锁后立即调用 `POST /v1/roles/:roleId/memory/batches`（返回 `202`）时先清理遗留 `running` 批次再完成整理，不再因 `MemoryBatchConflictError` 吞为 `0` 次调用（`immediateManual`）。
    3. 守护验证：当正常批次处于运行中（模型调用挂起、数据库批次为 `running`）时，并发发起 `POST /v1/roles/:roleId/memory/batches` 与 `wakePendingWork` 并越过短退避窗口等待 `350ms`，运行中的批次保持 `running` 并在模型返回后正常结算为 `completed`，不会被重置为 `PROCESS_INTERRUPTED`。
  - 执行 `cd backend; npx -y node@24 --import tsx --test --test-name-pattern="283 §25" tests/p18-278-review-fixes.test.ts` 通过（`1/1`）。
- **后端全量检查**：
  - `cd backend; npm run typecheck` 通过。
  - `cd backend; npx -y node@24 --import tsx --test --test-concurrency=8 tests/*.test.ts` 通过（`399/399`）。
- **离线验收**：
  - `cd backend; npx -y node@24 scripts/accept-offline.mjs` 通过（`21/21` 步全过，报告位于 `backend/test-results/p5-2026-11-13T13-15-17-364Z-87aa3f9c/summary.json`，`realServiceCalls: 0`）。
- **桌面端检查**：
  - `npm --prefix desktop/desk-preview/renderer run typecheck`、`npm --prefix desktop/desk-preview/renderer run build` 与 `npx -y node@24 --test desktop/desk-preview/tests/*.test.cjs` 通过（`115/115`）。
