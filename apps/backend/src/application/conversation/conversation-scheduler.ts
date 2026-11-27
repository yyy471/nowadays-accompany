import { EngineeringJobs, engineeringWait } from "../../storage/conversation/engineering-jobs.js";
import { isAdminSeat } from "../../domain/admin-seat.js";
import { isManagedPiResource } from "../../domain/resource.js";
import { setTimeout as delay } from "node:timers/promises";
import type { ConversationWaitReason } from "../../domain/conversation.js";
import { ModelCredentialUnavailableError } from "../../domain/errors.js";
import { ROLE_STOP_TASK_END_REASON } from "../../domain/role-activity.js";
import {
  ConversationStore,
} from "../../storage/conversation/conversation-store.js";
import {
  isFirstActivationWake,
  type AutonomyWakeRecord,
} from "../../storage/conversation/autonomy-store.js";
import type { RoleStorage } from "../../storage/core/role-storage.js";
import type { RoleStorageLease } from "../role/role-access.js";
import type { ResolvedModelBinding } from "../resources/model-binding-resolver.js";
import type {
  AutonomyExecutionContext,
  ConversationContext,
  PendingTaskContinuation,
  RunningExecution,
} from "./conversation-internal-types.js";
import { windowKey } from "./conversation-prompt-builder.js";

const FIRST_ACTIVATION_CREDENTIAL_RETRY_MS = 1_000;

/**
 * 角色排队调度、抢占、唤醒计时器、自主活动与任务续行。
 */
export class ConversationScheduler {
  constructor(private readonly ctx: ConversationContext) {}

  private get state() {
    return this.ctx.state;
  }

  /**
   * 已接收但未安排回复的原因。用于桌面端区分「角色已停止」「缺少对话模型」
   * 「其他窗口正在生成」与「正常排队」，避免用单一字段猜测。
   */
  roleWaitReason(
    roleId: string,
    windowId: string,
  ): ConversationWaitReason | null {
    if (this.ctx.activity !== null && !this.ctx.activity.canStart(roleId)) {
      return "ROLE_STOPPED";
    }
    if (this.state.running.has(roleId)) {
      return "BUSY";
    }
    if (this.state.blockedWindows.has(windowKey(roleId, windowId))) {
      return "WINDOW_BLOCKED";
    }
    let pending: ReturnType<ConversationStore["listPendingWindows"]>;
    try {
      pending = this.ctx.withConversationStore(roleId, (store) =>
        store.listPendingWindows(),
      );
    } catch {
      return "QUEUE_PENDING";
    }
    if (pending.length === 0) {
      return "QUEUE_PENDING";
    }
    const target = pending.find(
      (window) => !this.state.blockedWindows.has(windowKey(roleId, window.windowId)),
    );
    if (target === undefined) {
      return "WINDOW_BLOCKED";
    }
    let pendingTaskId: string | null = null;
    try {
      pendingTaskId = this.ctx.withConversationStore(roleId, (store) =>
        store.findInterruptedUserTask(target.windowId),
      );
    } catch {
      return "QUEUE_PENDING";
    }
    const hasModel =
      this.ctx.bindings.hasChatBinding(roleId) ||
      (pendingTaskId !== null &&
        this.ctx.bindings.hasChatForTask(roleId, pendingTaskId));
    return hasModel ? null : "MODEL_MISSING";
  }

  schedule(roleId: string): boolean {
    const started = this.scheduleInternal(roleId);
    this.armWakeTimer(roleId);
    return started;
  }

  /** 是否还有属于该角色的执行或后台工具在跑；停止确认据此判断是否要等边界。 */
  isRunning(roleId: string): boolean {
    if (this.state.running.has(roleId)) return true;
    if ((this.state.backgroundToolsByRole.get(roleId) ?? 0) > 0) return true;
    for (const detached of this.state.detached) {
      if (detached.roleId === roleId) return true;
    }
    return false;
  }

  /** 正在使用目标模型服务的执行角色；不受当前绑定变化影响（283 §7 R01）。 */
  inflightRoleIds(resourceId: string): string[] {
    const roles = new Set<string>();
    for (const entry of this.state.inflightResources.values()) {
      if (entry.resourceId === resourceId) roles.add(entry.roleId);
    }
    return [...roles].sort();
  }

  /**
   * 没有前台执行、只剩后台工具时，停止确认只能在最后一个后台工具结算后收敛。
   * 只改活动状态，不改工具调用记录：晚到结果仍按原调用结算并保留原始响应。
   */
  confirmStopIfIdle(
    roleId: string,
    boundaryExecutionId: string | null,
  ): void {
    const activity = this.ctx.activity;
    if (this.state.closed) return;
    if (activity?.isStopRequested(roleId) !== true) return;
    if (this.isRunning(roleId)) return;
    // 后台记忆整理也属于本角色的在途工作，必须等它到达安全边界（283 §5 R01）。
    if (this.ctx.hasExternalWork(roleId)) return;
    try {
      activity.confirmStop(roleId, boundaryExecutionId);
    } catch {
      // 确认失败时保持 stopping，不放行配置写入。
    }
  }

  private scheduleInternal(roleId: string): boolean {
    if (this.state.closed || this.state.running.has(roleId)) {
      return false;
    }
    // 已停止或正在停止的角色不再启动任何新步骤（DL-148）。
    if (this.ctx.activity !== null && !this.ctx.activity.canStart(roleId)) {
      return false;
    }
    this.registerFirstActivation(roleId);
    let pending: ReturnType<ConversationStore["listPendingWindows"]>;
    try {
      pending = this.ctx.withConversationStore(roleId, (store) =>
        store.listPendingWindows(),
      );
    } catch {
      return false;
    }
    let target: (typeof pending)[number] | undefined;
    let pendingTaskId: string | null = null;
    for (const window of pending) {
      if (this.state.blockedWindows.has(windowKey(roleId, window.windowId))) {
        continue;
      }
      let taskId: string | null = null;
      try {
        taskId = this.ctx.withConversationStore(roleId, (store) =>
          store.findInterruptedUserTask(window.windowId),
        );
      } catch {
        taskId = null;
      }
      // 维护中的模型服务暂缓领取；其他窗口与任务仍可继续（283 R01）。
      if (this.chatTargetUnderMaintenance(roleId, taskId)) {
        continue;
      }
      target = window;
      pendingTaskId = taskId;
      break;
    }
    if (target && (
      this.ctx.bindings.hasChatBinding(roleId) ||
      (pendingTaskId !== null && this.ctx.bindings.hasChatForTask(roleId, pendingTaskId))
    )) {
      if (this.ctx.inputStates.isTyping(roleId, target.windowId)) {
        return true;
      }
      return this.startExecution(roleId, target.windowId);
    }
    const continuation = (this.state.pendingContinuations.get(roleId) ?? []).find(
      (item) => !this.chatTargetUnderMaintenance(roleId, item.taskId),
    );
    if (continuation) {
      return this.startTaskContinuation(roleId, continuation);
    }
    const engineering = isAdminSeat(this.ctx.appStore.getRoleIndex(roleId)?.builtinKey ?? null)
      && this.ctx.withConversationStore(roleId, store => store.nextEngineeringDelivery());
    if (engineering && !this.chatTargetUnderMaintenance(roleId, engineering.taskId)) {
      return this.startTaskContinuation(roleId, { ...engineering, engineering: true });
    }
    return this.startDueAutonomy(roleId);
  }

  /** 该窗口／任务实际使用的对话模型是否正在维护（283 R01、R04）。 */
  private chatTargetUnderMaintenance(
    roleId: string,
    taskId: string | null,
  ): boolean {
    if (this.ctx.isResourceUnderMaintenance === null) {
      return false;
    }
    const resourceId =
      (taskId === null ? null : this.ctx.bindings.taskChatResourceId(roleId, taskId)) ??
      this.ctx.bindings.chatResourceId(roleId);
    return (
      resourceId !== null && this.ctx.isResourceUnderMaintenance(resourceId)
    );
  }

  armWakeTimer(roleId: string): void {
    const autonomy = this.ctx.autonomy;
    const existing = this.state.wakeTimers.get(roleId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.state.wakeTimers.delete(roleId);
    }
    if (this.state.closed || autonomy === null || this.state.running.has(roleId) ||
        this.ctx.activity?.canStart(roleId) === false) {
      return;
    }
    let next;
    try {
      next = autonomy.nextPendingWake(roleId);
    } catch {
      return;
    }
    if (next === null) {
      this.state.dueWakeChecks.delete(roleId);
      return;
    }
    if (!this.canStartAutonomyWake(roleId, next)) {
      return;
    }
    const due = Date.parse(next.scheduledAt);
    if (Number.isNaN(due)) {
      return;
    }
    const remaining = due - this.ctx.now().getTime();
    const dueKey = `${next.wakeId}\u0000${next.scheduledAt}`;
    if (remaining <= 0) {
      if (this.state.dueWakeChecks.get(roleId) === dueKey) {
        return;
      }
    } else {
      this.state.dueWakeChecks.delete(roleId);
    }
    const delay = Math.min(
      Math.max(0, remaining),
      2_147_483_647,
    );
    const timer = setTimeout(() => {
      // 只有实际检查过的到期待办才去重；重投或重新挂钟不能吞掉尚未触发的定时器。
      this.state.dueWakeChecks.set(roleId, dueKey);
      this.state.wakeTimers.delete(roleId);
      void this.schedule(roleId);
    }, delay);
    timer.unref?.();
    this.state.wakeTimers.set(roleId, timer);
  }

  runDueAutonomy(roleId: string): boolean {
    const started = this.schedule(roleId);
    return started && this.state.running.get(roleId)?.autonomous === true;
  }

  refreshWakeTimer(roleId: string): void {
    this.armWakeTimer(roleId);
  }

  /**
   * 后台记忆整理等外部工作收尾后的空闲通知（283 §4 R01）。
   * 停止请求可能只等这些调用；这里在它们真正结束后确认停止。
   */
  notifyExternalIdle(roleId: string, executionId: string | null = null): void {
    this.confirmStopIfIdle(roleId, executionId);
    if (this.ctx.autonomy?.coplay.hasDue(roleId)) this.schedule(roleId);
  }

  /**
   * 模型恢复、绑定修复或维护结束后重新检查已有待处理工作（283 R02）。
   * 不传角色时覆盖所有已初始化角色；停止中的角色由统一调度跳过。
   */
  wakePendingWork(roleId?: string): void {
    if (this.state.closed) {
      return;
    }
    const targets =
      roleId === undefined
        ? this.ctx.appStore
            .listRoleIndexes()
            .filter((index) => index.initStatus === "ready")
            .map((index) => index.roleId)
        : [roleId];
    for (const target of targets) {
      this.ctx.memoryRuntime?.kick(target);
      this.schedule(target);
    }
  }

  /**
   * 恢复活动后的重新调度（RA-R02）：把因停止而暂停的任务链改回 active 并排队
   * 续行，再交给统一调度接上到期待办与后台工具留下的续行。待办、任务链与
   * 自主额度原样保留，不新建任务、不清空排队、不重置额度。
   */
  rescheduleAfterStop(roleId: string): void {
    if (this.state.closed) return;
    let resumed: PendingTaskContinuation[] = [];
    try {
      resumed = this.ctx.roleAccess.withStore(roleId, (storage) => {
        const store = new ConversationStore(
          storage.business.db,
          roleId,
          this.ctx.timeZone,
        );
        const targets = store.listStoppedTaskContinuations(
          ROLE_STOP_TASK_END_REASON,
        );
        const queued: PendingTaskContinuation[] = [];
        for (const target of targets) {
          try {
            storage.business.resumeTask({ roleId, taskId: target.taskId });
            queued.push(target);
          } catch {
            // 任务已被其他路径结束或恢复时跳过，不影响其余任务。
          }
        }
        return queued;
      });
    } catch {
      // 存储暂不可用时不阻塞恢复：下一次调度或新消息会重新接上。
      resumed = [];
    }
    for (const continuation of resumed) {
      this.queueTaskContinuation(roleId, continuation);
    }
    // 统一调度同时负责重挂唤醒定时器，让停止期间到期的待办继续推进。
    this.schedule(roleId);
  }

  private canStartAutonomyWake(
    roleId: string,
    wake: Pick<AutonomyWakeRecord, "wakeId" | "taskId">,
  ): boolean {
    if (isFirstActivationWake(wake.wakeId)) {
      return this.firstActivationModelReady(roleId);
    }
    // 唤醒会接回原任务时按任务模型判断；否则按当前对话模型判断。
    if (this.chatTargetUnderMaintenance(roleId, wake.taskId)) {
      return false;
    }
    if (this.ctx.bindings.hasChatBinding(roleId)) {
      return true;
    }
    if (wake.taskId !== null) {
      return this.ctx.bindings.hasChatForTask(roleId, wake.taskId);
    }
    return false;
  }

  registerFirstActivation(roleId: string): void {
    const autonomy = this.ctx.autonomy;
    if (autonomy === null || this.ctx.activity?.canStart(roleId) !== true) {
      return;
    }
    try {
      if (autonomy.hasPendingFirstActivation(roleId) &&
          this.firstActivationModelReady(roleId)) {
        autonomy.enqueueFirstActivation(roleId);
      }
    } catch {
      // 状态与唤醒落在不同的库；下次调度重新检查资格。
    }
  }

  resolveModelCredential(binding: ResolvedModelBinding): string | undefined {
    return this.ctx.resolveModelCredential(binding);
  }

  private firstActivationModelReady(roleId: string): boolean {
    this.clearFirstActivationCredentialRetry(roleId);
    try {
      const binding = this.ctx.bindings.resolveChat(roleId);
      if (this.ctx.isResourceUnderMaintenance?.(binding.resourceId) === true) {
        return false;
      }
      // 与实际调用走同一份本机凭据解析。注入的模型不依赖 HTTP 凭据。
      if (this.ctx.usesHttpModel) this.resolveModelCredential(binding);
      return true;
    } catch (error) {
      if (error instanceof ModelCredentialUnavailableError) {
        // env:/file: 可独立于资源 API 就绪，给已激活的角色重新检查机会。
        const timer = setTimeout(() => {
          this.state.firstActivationCredentialTimers.delete(roleId);
          this.schedule(roleId);
        }, FIRST_ACTIVATION_CREDENTIAL_RETRY_MS);
        timer.unref();
        this.state.firstActivationCredentialTimers.set(roleId, timer);
      }
      return false;
    }
  }

  clearFirstActivationCredentialRetry(roleId: string): void {
    const timer = this.state.firstActivationCredentialTimers.get(roleId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.state.firstActivationCredentialTimers.delete(roleId);
  }

  grantTaskResources(
    storage: RoleStorage,
    roleId: string,
    taskId: string,
  ): string[] {
    const bindings = storage.business.listRoleBindings(roleId);
    const existing = storage.business
      .listResourceContinuations(roleId, taskId)
      .filter((item) => item.endedAt === null);
    const continuationIds = new Set(
      existing.map((item) => item.resourceId),
    );
    const hasChatModel = existing.some((item) => {
      try {
        return this.ctx.appStore.getResource(item.resourceId).kind === "model";
      } catch {
        return false;
      }
    });
    for (const binding of bindings) {
      if (
        binding.capability !== "chat_model" &&
        binding.capability !== "mcp" &&
        binding.capability !== "skill"
      ) {
        continue;
      }
      if (!binding.enabled) {
        continue;
      }
      if (binding.capability === "chat_model" && hasChatModel) {
        continue;
      }
      let resource;
      try {
        resource = this.ctx.appStore.getResource(binding.resourceId);
      } catch {
        continue;
      }
      if (!resource.enabled) {
        continue;
      }
      if (isManagedPiResource(resource) && !isAdminSeat(storage.business.getRole(roleId).builtinKey)) continue;
      storage.business.grantResourceContinuation({
        roleId,
        taskId,
        resourceId: binding.resourceId,
      });
      continuationIds.add(binding.resourceId);
    }
    return [...continuationIds];
  }

  private startDueAutonomy(roleId: string): boolean {
    const autonomy = this.ctx.autonomy;
    if (autonomy === null) {
      return false;
    }
    const due = autonomy.dueWake(roleId);
    const coplay = due === null ? autonomy.coplay.due(roleId) : undefined;
    const next = due ?? coplay;
    if (!next || (coplay && (!this.isIdle(roleId) || this.ctx.hasExternalWork(roleId))) || !this.canStartAutonomyWake(roleId, next)) {
      return false;
    }
    let storage: RoleStorage | null = null;
    let lease: RoleStorageLease | null = null;
    try {
      lease = this.ctx.roleAccess.borrow(roleId);
      storage = lease.storage;
      const window = storage.business.getOrCreateWindow({
        roleId,
        kind: "custom",
        source: "nowadays-autonomy",
      });
      const begun = autonomy.beginDueWake(roleId, window.windowId, coplay);
      if (!begun) {
        lease.release();
        return false;
      }
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.ctx.timeZone,
      );
      if (begun.wake.wakeId === coplay?.wakeId) coplay?.claimed();
      const controller: RunningExecution = {
        roleId,
        windowId: window.windowId,
        executionId: begun.execution.executionId,
        controller: new AbortController(),
        partialText: "",
        superseded: false,
        autonomous: true,
        promise: Promise.resolve(),
      };
      this.state.running.set(roleId, controller);
      store.appendStreamEvent({
        windowId: window.windowId,
        executionId: begun.execution.executionId,
        type: "execution_started",
        payload: {
          executionId: begun.execution.executionId,
          windowId: window.windowId,
          triggerType: "autonomous",
          taskId: begun.taskId,
          messageIds: [],
          activityId: begun.activity.activityId,
        },
        now: this.ctx.now().toISOString(),
      });
      controller.promise = this.ctx.runner.runExecution({
        storage,
        store,
        running: controller,
        execution: begun.execution,
        pendingMessages: [],
        taskId: begun.taskId,
        autonomy: {
          activityId: begun.activity.activityId,
          wakeId: begun.wake.wakeId,
          intent: begun.wake.intent,
          // budget_resume 或携带任务编号的 scheduled 唤醒都接回原任务链，
          // 需要把已保存的工具结果重放进上下文。
          resumed:
            begun.wake.kind === "budget_resume" || begun.wake.taskId !== null,
        },
      })
        .finally(lease.release)
        .catch(() => {
          // runExecution 内部已保存失败／暂停状态，这里只防止未处理的 Promise。
        })
        .finally(() => {
          if (
            this.state.running.get(roleId)?.executionId ===
            begun.execution.executionId
          ) {
            this.state.running.delete(roleId);
          }
          this.state.detached.delete(controller);
          void this.schedule(roleId);
        });
      return true;
    } catch {
      lease?.release();
      return false;
    }
  }

  private startTaskContinuation(
    roleId: string,
    continuation: PendingTaskContinuation,
  ): boolean {
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
      const begin = () => store.beginTaskContinuation({
        taskId: continuation.taskId, windowId: continuation.windowId, now: this.ctx.now().toISOString(),
      });
      const business = storage.business;
      const jobs = new EngineeringJobs(business.db);
      const execution = continuation.engineering ? business.db.transaction(() => {
        const task = business.getTask(roleId, continuation.taskId);
        if (task.status !== "paused" || task.waitReason !== engineeringWait) return null;
        business.resumeTask({ roleId, taskId: task.taskId });
        const next = begin();
        if (!next || !jobs.claim(task.taskId, next.executionId)) throw new Error("PI_WAKE_CLAIM_CONFLICT");
        return next;
      })() : begin();
      this.removePendingContinuation(roleId, continuation.taskId);
      if (!execution) {
        lease.release();
        void this.closeTaskCatalog(continuation.taskId);
        return false;
      }
      const task = storage.business.getTask(roleId, continuation.taskId);
      const autonomous = task.origin === "autonomous";
      let autonomyContext: AutonomyExecutionContext | null = null;
      if (autonomous) {
        const activity =
          this.ctx.autonomy?.getLatestActivityByTask(roleId, task.taskId) ?? null;
        if (activity !== null && activity.status === "paused") {
          this.ctx.autonomy?.updateActivity(roleId, {
            activityId: activity.activityId,
            executionId: execution.executionId,
            status: "running",
          });
        }
        autonomyContext = {
          activityId: activity?.activityId ?? null,
          wakeId: activity?.wakeId ?? null,
          intent: task.goal,
          resumed: true,
        };
      }
      const controller: RunningExecution = {
        roleId,
        windowId: continuation.windowId,
        executionId: execution.executionId,
        controller: new AbortController(),
        partialText: "",
        superseded: false,
        autonomous,
        promise: Promise.resolve(),
      };
      this.state.running.set(roleId, controller);
      store.appendStreamEvent({
        windowId: continuation.windowId,
        executionId: execution.executionId,
        type: "execution_started",
        payload: {
          executionId: execution.executionId,
          windowId: continuation.windowId,
          triggerType: execution.triggerType,
          taskId: continuation.taskId,
          messageIds: [],
        },
        now: this.ctx.now().toISOString(),
      });
      controller.promise = this.ctx.runner.runExecution({
        storage,
        store,
        running: controller,
        execution,
        pendingMessages: [],
        taskId: continuation.taskId,
        autonomy: autonomyContext,
      })
        .finally(lease.release)
        .catch(() => {
          // runExecution 内部已保存失败／中断状态，这里只防止未处理的 Promise。
        })
        .finally(() => {
          if (
            this.state.running.get(roleId)?.executionId === execution.executionId
          ) {
            this.state.running.delete(roleId);
          }
          this.state.detached.delete(controller);
          void this.schedule(roleId);
        });
      return true;
    } catch (error) {
      if (continuation.engineering) console.error("PI_DELIVERY_START_FAILED", roleId, continuation.taskId, error);
      this.removePendingContinuation(roleId, continuation.taskId);
      lease?.release();
      void this.closeTaskCatalog(continuation.taskId);
      return false;
    }
  }

  queueTaskContinuation(
    roleId: string,
    continuation: PendingTaskContinuation,
  ): void {
    const list = this.state.pendingContinuations.get(roleId) ?? [];
    const existing = list.find(
      (item) => item.taskId === continuation.taskId,
    );
    if (existing) {
      existing.windowId = continuation.windowId;
    } else {
      list.push(continuation);
    }
    this.state.pendingContinuations.set(roleId, list);
  }

  removePendingContinuation(roleId: string, taskId: string): void {
    const list = this.state.pendingContinuations.get(roleId);
    if (list === undefined) {
      return;
    }
    const next = list.filter((item) => item.taskId !== taskId);
    if (next.length === 0) {
      this.state.pendingContinuations.delete(roleId);
    } else {
      this.state.pendingContinuations.set(roleId, next);
    }
  }

  closeTaskCatalog(taskId: string): Promise<void> {
    const entry = this.state.taskCatalogs.get(taskId);
    if (entry === undefined) {
      return Promise.resolve();
    }
    this.state.taskCatalogs.delete(taskId);
    this.state.closingTaskCatalogs.add(taskId);
    this.state.catalogClosePending.delete(taskId);
    return entry.catalog.close().finally(() => {
      this.state.closingTaskCatalogs.delete(taskId);
      // 连接收尾完成后再释放任务资源占用（283 R03）。
      this.ctx.runner.releaseTaskResources(entry.roleId, taskId);
    });
  }

  /**
   * 任务终结后关闭工具目录，但要等已发出的后台工具结算完再收连接（283 R03）。
   * 在途工具结算回调会再次调用这里，并在关闭完成后释放资源占用。
   */
  closeTaskCatalogAfterSettled(taskId: string): void {
    if ((this.state.backgroundToolsByTask.get(taskId) ?? 0) > 0) {
      this.state.catalogClosePending.add(taskId);
      return;
    }
    void this.closeTaskCatalog(taskId);
  }

  private startExecution(roleId: string, windowId: string): boolean {
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
      const failed = store.getFailedReply(windowId);
      const replyToolSource = failed && (failed.receiptSummary || failed.errorCode !== "PROCESS_INTERRUPTED")
        ? store.replyToolSource(failed.executionId) : null;
      const begun = store.beginExecution({
        windowId,
        now: this.ctx.now().toISOString(),
      });
      if (!begun) {
        lease.release();
        return false;
      }
      const controller: RunningExecution = {
        roleId,
        windowId,
        executionId: begun.execution.executionId,
        controller: new AbortController(),
        partialText: "",
        superseded: false,
        autonomous: false,
        promise: Promise.resolve(),
      };
      this.state.running.set(roleId, controller);
      store.appendStreamEvent({
        windowId,
        executionId: begun.execution.executionId,
        type: "execution_started",
        payload: {
          executionId: begun.execution.executionId,
          windowId,
          triggerType: begun.execution.triggerType,
          messageIds: begun.messages.map((message) => message.messageId),
          ...(replyToolSource ? { replyToolSource, receiptSummary: failed?.receiptSummary } : {}),
        },
        now: this.ctx.now().toISOString(),
      });
      controller.promise = this.ctx.runner.runExecution({
        storage,
        store,
        running: controller,
        execution: begun.execution,
        pendingMessages: begun.messages,
        taskId: begun.taskId,
      })
        .finally(lease.release)
        .catch(() => {
          // runExecution 内部已保存失败／中断状态，这里只防止未处理的 Promise。
        })
        .finally(() => {
          if (this.state.running.get(roleId)?.executionId === begun.execution.executionId) {
            this.state.running.delete(roleId);
          }
          this.state.detached.delete(controller);
          void this.schedule(roleId);
        });
      return true;
    } catch {
      lease?.release();
      return false;
    }
  }

  supersedeWindow(roleId: string, windowId: string): void {
    const running = this.state.running.get(roleId);
    if (!running || running.superseded) {
      return;
    }
    if (running.windowId !== windowId && !running.autonomous) {
      return;
    }
    running.superseded = true;
    running.controller.abort();
    try {
      this.ctx.withConversationStore(roleId, (store) =>
        store.interruptExecution({
          executionId: running.executionId,
          partialText: running.partialText,
          status: "superseded",
          reason: "NEW_MESSAGE",
          supersededByExecutionId: null,
          now: this.ctx.now().toISOString(),
        }),
      );
    } catch {
      // 状态已被其他路径处理时保持既有事件。
    }
    if (this.state.running.get(roleId) === running) {
      this.state.running.delete(roleId);
    }
    this.state.detached.add(running);
  }

  private isIdle(roleId: string): boolean {
    if (this.state.running.has(roleId)) {
      return false;
    }
    if ((this.state.backgroundToolsByRole.get(roleId) ?? 0) > 0) {
      // 仍有转后台的工具在途：结算后可能续行，不算空闲。
      return false;
    }
    if ((this.state.segmentAnnotations.get(roleId)?.size ?? 0) > 0) {
      // 表情标注晚于正文完成，但仍属于本轮演出的收尾工作。
      return false;
    }
    if ([...this.state.detached].some((running) => running.roleId === roleId)) {
      return false;
    }
    if ((this.state.pendingContinuations.get(roleId)?.length ?? 0) > 0) {
      return false;
    }
    try {
      const pending = this.ctx.withConversationStore(roleId, (store) =>
        store.listPendingWindows(),
      );
      return pending.every((window) =>
        this.state.blockedWindows.has(windowKey(roleId, window.windowId)),
      );
    } catch {
      return true;
    }
  }

  private isQuiescent(roleId: string): boolean {
    if ((this.state.segmentAnnotations.get(roleId)?.size ?? 0) > 0) {
      return false;
    }
    // 已停止角色不会再启动续行；队列里的搁置续行由删除流程丢弃（283 §12 R03）。
    if (this.ctx.activity !== null && !this.ctx.activity.canStart(roleId)) {
      return true;
    }
    return (this.state.pendingContinuations.get(roleId)?.length ?? 0) === 0;
  }

  async waitForIdle(roleId: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isIdle(roleId)) {
        return;
      }
      await delay(20);
    }
    throw new Error("CONVERSATION_IDLE_TIMEOUT");
  }

  /**
   * 删除角色前确认没有前台执行、后台工具、差分标注或待续行。
   * 与 isIdle 不同，不把「已领取但被停止搁置的待处理窗口」算作在途。
   */
  async waitForQuiescent(roleId: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isRunning(roleId) && this.isQuiescent(roleId)) {
        return;
      }
      await delay(20);
    }
    throw new Error("CONVERSATION_QUIESCE_TIMEOUT");
  }
}
