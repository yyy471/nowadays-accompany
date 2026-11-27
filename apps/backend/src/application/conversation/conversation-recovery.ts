import { EngineeringJobs, engineeringWait } from "../../storage/conversation/engineering-jobs.js";
import { ConversationStore } from "../../storage/conversation/conversation-store.js";
import type {
  PrimaryExecutionTask,
  RecoverableTaskContinuation,
  RecoveredExecution,
} from "../../storage/conversation/conversation-store.js";
import { AutonomyStore } from "../../storage/conversation/autonomy-store.js";
import type { RoleStorageLease } from "../role/role-access.js";
import type { RoleStorage } from "../../storage/core/role-storage.js";
import type { ExecutionRecord } from "../../storage/role/role-store.js";
import type {
  AutonomyExecutionContext,
  ConversationContext,
  ResumableExecution,
  RunningExecution,
} from "./conversation-internal-types.js";
import { windowKey } from "./conversation-prompt-builder.js";

/**
 * 启动恢复协调器：把宿主重启前的在途执行、已提交但未落实的任务决定
 * 和被打断的工程回执接回统一调度。
 */
export class ConversationRecovery {
  constructor(private readonly ctx: ConversationContext) {}

  recoverOnStartup(): number {
    let recovered = 0;
    for (const index of this.ctx.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") {
        continue;
      }
      try {
        const now = this.ctx.now().toISOString();
        this.ctx.exchanges.recover(index.roleId);
        const lease = this.ctx.roleAccess.borrow(index.roleId);
    const storage = lease.storage;
        let interrupted: RecoveredExecution[] = [];
        let superseded: RecoverableTaskContinuation[] = [];
        const resumable: ResumableExecution[] = [];
        let pendingUserRecovery = false;
        try {
          const store = new ConversationStore(
            storage.business.db,
            index.roleId,
            this.ctx.timeZone,
          );
          const jobs = new EngineeringJobs(storage.business.db);
          for (const job of jobs.listRunning()) jobs.settle(job.jobId, "interrupted_unknown", "宿主重新启动，工程结果待核查", now);
          for (const execution of store.listRunningExecutions()) {
            const resumableTask = this.resumableTask(
              store,
              storage,
              execution,
            );
            if (resumableTask === null) {
              continue;
            }
            resumable.push({
              execution,
              taskId: resumableTask.task?.taskId ?? null,
              taskStatus: resumableTask.task?.status ?? null,
              taskOrigin: resumableTask.task?.origin ?? null,
              windowId: execution.windowId!,
            });
            store.failRunningModelCalls(execution.executionId, now);
          }
          const resumableIds = resumable.map(
            (item) => item.execution.executionId,
          );
          store.reconcileInterruptedInternalTools(now);
          const autonomyStore = new AutonomyStore(
            storage.business.db,
            index.roleId,
            this.ctx.timeZone,
          );
          try {
            autonomyStore.reconcileToolReservations(now);
          } catch {
            // 预留结算失败保留原状态，后续启动继续重试。
          }
          interrupted = store.recoverInterruptedExecutions(now, resumableIds);
          store.failOrphanedModelCalls(now);
          superseded = store.listSupersededTaskContinuations();
          storage.business.recoverInterruptedToolCalls(
            index.roleId,
            now,
            resumableIds,
          );
          this.reconcileCommittedGaps(
            storage,
            store,
            autonomyStore,
            index.roleId,
            now,
          );
          for (const { windowId } of store.listPendingWindows()) {
            const failed = store.getFailedReply(windowId);
            if (failed && failed.errorCode !== "PROCESS_INTERRUPTED") {
              if (failed.receiptSummary) pendingUserRecovery = true;
              else this.ctx.state.blockedWindows.add(windowKey(index.roleId, windowId));
            }
            if (store.findInterruptedUserTask(windowId) !== null) pendingUserRecovery = true;
          }
        } finally {
          lease.release();
        }
        let continuationQueued = false;
        const resumableTaskIds = new Set(
          resumable
            .map((item) => item.taskId)
            .filter((taskId): taskId is string => taskId !== null),
        );
        for (const item of interrupted) {
          if (item.taskId !== null && !resumableTaskIds.has(item.taskId)) {
            continuationQueued = this.fallbackFromResume(index.roleId, item) || continuationQueued;
          }
        }
        for (const item of superseded) {
          if (resumableTaskIds.has(item.taskId)) {
            continue;
          }
          this.ctx.scheduler.queueTaskContinuation(index.roleId, {
            taskId: item.taskId,
            windowId: item.windowId,
          });
          continuationQueued = true;
        }
        let resumeFallback = false;
        for (const item of resumable) {
          if (this.startResumedExecution(index.roleId, item)) {
            recovered += 1;
            continue;
          }
          resumeFallback = true;
          continuationQueued =
            this.fallbackFromResume(index.roleId, item) || continuationQueued;
        }
        recovered += interrupted.length;
        this.ctx.scheduler.registerFirstActivation(index.roleId);
        this.ctx.scheduler.armWakeTimer(index.roleId);
        if (continuationQueued || pendingUserRecovery || resumeFallback || this.ctx.withConversationStore(index.roleId, s => s.nextEngineeringDelivery())) {
          this.ctx.schedule(index.roleId);
        }
      } catch {
        // 单个角色损坏不应阻止后端启动；读取时仍会返回存储错误。
      }
    }
    return recovered;
  }

  private resumableTask(
    store: ConversationStore,
    storage: RoleStorage,
    execution: ExecutionRecord,
  ): { task: PrimaryExecutionTask | null } | null {
    if (execution.status !== "running" || execution.windowId === null) {
      return null;
    }
    let roleVersion: number;
    try {
      roleVersion = store.getRoleContext().stateVersion;
    } catch {
      return null;
    }
    if (
      execution.stateVersionLoaded === null ||
      execution.stateVersionLoaded !== roleVersion
    ) {
      return null;
    }
    const task = store.getPrimaryExecutionTask(execution.executionId);
    if (task !== null && task.status !== "active") {
      return null;
    }
    const pending = store.listPendingWindows();
    if (pending.some((window) => window.windowId === execution.windowId)) {
      return null;
    }
    if (!storage.checkpoint.hasCompletedCheckpoint(execution.executionId)) {
      return null;
    }
    return { task };
  }

  private reconcileCommittedGaps(
    storage: RoleStorage,
    store: ConversationStore,
    autonomyStore: AutonomyStore,
    roleId: string,
    now: string,
  ): void {
    const gaps = store.listCommittedExecutionGaps();
    // 同一任务可能有多条已完成执行：旧暂停在续行后已不是当前决定，
    // 只落实最后一条尚未执行的终态决定。查询按提交顺序返回，
    // 后面的记录覆盖前面的同任务记录。
    const latestByTask = new Map<string, (typeof gaps)[number]>();
    for (const gap of gaps) {
      latestByTask.set(gap.taskId, gap);
    }
    for (const gap of latestByTask.values()) {
      try {
        const task = storage.business.getTask(roleId, gap.taskId);
        if (task.status !== "active") {
          continue;
        }
        const decision =
          gap.taskDecision !== null && gap.taskDecision.taskId === gap.taskId
            ? gap.taskDecision
            : null;
        if (decision?.action.kind === "continue") {
          // 回复已提交但续行未排队：按原决定保持任务活跃并补排续行（DL-154）。
          if (gap.windowId !== null) {
            this.ctx.scheduler.queueTaskContinuation(roleId, {
              taskId: gap.taskId,
              windowId: gap.windowId,
            });
          }
          continue;
        }
        if (decision?.action.kind === "pause") {
          // 回复已提交但暂停写入中断：按原决定暂停，保留资源续行与唤醒。
          storage.business.pauseTask({
            roleId,
            taskId: gap.taskId,
            endReason: decision.action.reason,
            waitReason: decision.action.waitReason ?? "AWAITING_USER_INPUT",
          });
          continue;
        }
        const status =
          decision?.action.kind === "finish"
            ? decision.action.status
            : "completed";
        const endReason =
          decision?.action.kind === "finish"
            ? decision.action.endReason
            : "回复完成";
        storage.business.finishTask({
          roleId,
          taskId: gap.taskId,
          status,
          endReason,
        });
        autonomyStore.cancelPendingBudgetResumes(gap.taskId, "TASK_ENDED", now);
        this.ctx.memoryRuntime?.notifyTaskFinished(roleId, gap.taskId);
      } catch {
        // 单个任务收尾失败不阻塞其他恢复；下次启动仍可重试。
      }
    }
    try {
      storage.business.endOpenResourceContinuationsForTerminalTasks(roleId, now);
    } catch {
      // 资源清理失败保留记录，下次启动按任务终态重试。
    }
    try {
      autonomyStore.reconcileTerminalActivities(now);
    } catch {
      // 活动收尾失败保留原记录，下次启动重试。
    }
    if (gaps.length > 0) {
      this.ctx.memoryRuntime?.notifyEvidence(roleId);
    }
  }

  private startResumedExecution(
    roleId: string,
    item: ResumableExecution,
  ): boolean {
    if (this.ctx.state.running.has(roleId)) {
      return false;
    }
    let storage: RoleStorage | null = null;
    let lease: RoleStorageLease | null = null;
    try {
      lease = this.ctx.roleAccess.borrow(roleId);
      storage = lease.storage;
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.ctx.timeZone,
      );
      const execution = store.getExecution(item.execution.executionId);
      if (execution.status !== "running" || execution.windowId === null) {
        lease.release();
        return false;
      }
      const task =
        item.taskId === null
          ? null
          : storage.business.getTask(roleId, item.taskId);
      if (task !== null && task.status !== "active") {
        lease.release();
        return false;
      }
      const pendingMessages = store.listClaimedMessages(execution.executionId);
      const activity =
        this.ctx.autonomy?.getActivityByExecution(roleId, execution.executionId) ??
        null;
      const autonomous = task?.origin === "autonomous" || activity !== null;
      const autonomyContext: AutonomyExecutionContext | null = autonomous
        ? {
            activityId: activity?.activityId ?? null,
            wakeId: activity?.wakeId ?? null,
            intent: task?.goal ?? "继续中断的自主活动",
            resumed: true,
          }
        : null;
      const controller: RunningExecution = {
        roleId,
        windowId: execution.windowId,
        executionId: execution.executionId,
        controller: new AbortController(),
        partialText: store.partialText(execution.executionId),
        superseded: false,
        autonomous,
        promise: Promise.resolve(),
      };
      this.ctx.state.running.set(roleId, controller);
      store.appendStreamEvent({
        windowId: execution.windowId,
        executionId: execution.executionId,
        type: "execution_started",
        payload: {
          executionId: execution.executionId,
          windowId: execution.windowId,
          triggerType: execution.triggerType,
          taskId: task?.taskId ?? null,
          messageIds: pendingMessages.map((message) => message.messageId),
          recovered: true,
        },
        now: this.ctx.now().toISOString(),
      });
      controller.promise = this.ctx.runner.runExecution({
        storage,
        store,
        running: controller,
        execution,
        pendingMessages,
        taskId: task?.taskId ?? null,
        autonomy: autonomyContext,
        resume: true,
      })
        .finally(lease.release)
        .catch(() => {
          // runExecution 内部已保存失败／中断状态，这里只防止未处理的 Promise。
        })
        .finally(() => {
          if (
            this.ctx.state.running.get(roleId)?.executionId ===
            execution.executionId
          ) {
            this.ctx.state.running.delete(roleId);
          }
          this.ctx.state.detached.delete(controller);
          void this.ctx.schedule(roleId);
        });
      return true;
    } catch {
      lease?.release();
      return false;
    }
  }

  private fallbackFromResume(
    roleId: string,
    item: ResumableExecution | RecoveredExecution,
  ): boolean {
    // 缺少节点检查点的执行已在批量中断恢复时结算，只有续跑启动失败才需在此结算。
    if ("execution" in item) {
      try {
        this.ctx.withConversationStore(roleId, (store) => {
          if (store.getExecution(item.execution.executionId).status !== "running") {
            return;
          }
          const now = this.ctx.now().toISOString();
          store.failRunningModelCalls(
            item.execution.executionId,
            now,
            "RECOVERY_RESUME_FAILED",
          );
          store.interruptExecution({
            executionId: item.execution.executionId,
            partialText: store.partialText(item.execution.executionId),
            status: "failed",
            reason: "RECOVERY_RESUME_FAILED",
            errorCode: "RECOVERY_RESUME_FAILED",
            now,
          });
        });
      } catch {
        return false;
      }
    }
    const {taskId, windowId, taskStatus, taskOrigin} = item;
    if (!taskId || !windowId || taskStatus !== "active") return false;
    const engineering = this.ctx.roleAccess.withStore(roleId, storage => {
      const jobs = new EngineeringJobs(storage.business.db);
      if (jobs.awaiting(taskId)) {
        storage.business.pauseTask({ roleId, taskId, waitReason: engineeringWait, endReason: "等待工程回执" });
        return "waiting";
      }
      return jobs.receipts(taskId, "execution" in item ? item.execution.executionId : item.executionId).length ? "claimed" : null;
    });
    if (engineering === "waiting") return true;
    if (taskOrigin === "autonomous" || engineering === "claimed") {
      this.ctx.scheduler.queueTaskContinuation(roleId, { taskId, windowId });
      return true;
    }
    return false;
  }
}
