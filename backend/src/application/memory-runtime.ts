import {
  InvalidRoleIdError,
  ModelBindingMissingError,
  ResourceKindMismatchError,
  RoleNotFoundError,
  RoleNotReadyError,
  StorageError,
} from "../domain/errors.js";
import {
  DEFAULT_MEMORY_BUDGET_CHARS,
  DEFAULT_MEMORY_RETRY_DELAYS_MS,
  DEFAULT_OUTPUT_RESERVE_CHARS,
  type MemoryFormationInput,
  type MemoryModelCapacity,
  type MemoryModelPort,
} from "../domain/memory.js";
import { isIncompleteCompletion, type ModelPort } from "../domain/model.js";
import { resolveCredential } from "../model/credentials.js";
import { HttpModelAdapter } from "../model/protocols.js";
import { rolePaths } from "../bootstrap/config.js";
import type { AppStore } from "../storage/app-store.js";
import { MemoryStore } from "../storage/memory-store.js";
import { RoleStorage } from "../storage/role-storage.js";
import { MemoryService } from "./memory-service.js";
import type { CredentialResolver } from "./credential-resolver.js";
import type { ModelBindingResolver, ResolvedModelBinding } from "./model-binding-resolver.js";
import type { RoleAccess } from "./role-access.js";

export type MemoryModelFactory = (
  binding: ResolvedModelBinding,
) => MemoryModelPort;

export interface MemoryRuntimeOptions {
  timeZone?: string;
  now?: () => Date;
  enabled?: boolean;
  idleMs?: number;
  credentialResolver?: CredentialResolver;
  /** 目标模型服务维护中：暂缓后台调用，等维护结束后重新唤醒（283 R01）。 */
  maintenance?: (resourceId: string) => boolean;
  /** 记忆队列彻底空闲（包括同一批后续调用）后通知，用于确认停止（283 §4 R01）。 */
  onIdle?: (roleId: string) => void;
  /** 角色删除收尾期间不再接收新的整理任务（283 §16）。 */
  isRoleDeleting?: (roleId: string) => boolean;
}

interface QueueState {
  running: boolean;
  pendingEvidence: boolean;
  pendingTaskIds: string[];
  pendingManual: boolean;
  pendingScheduled: boolean;
  promise: Promise<void> | null;
}

const IDLE_WAKE_MS = 60_000;
const MAINTENANCE_RECHECK_MS = 3_600_000;
const TIMER_RETRY_DELAYS_MS = [250, 1_000, 5_000, 30_000] as const;

export class MemoryRuntime {
  private readonly queues = new Map<string, QueueState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposedRoles = new Set<string>();
  private readonly timeZone: string | undefined;
  private readonly now: () => Date;
  private readonly enabled: boolean;
  private readonly idleWakeMs: number;
  private readonly modelFactory: MemoryModelFactory;
  private readonly customModelFactory: boolean;
  private readonly appRoot: string;
  private readonly credentials: CredentialResolver | null;
  private readonly maintenance: (resourceId: string) => boolean;
  private readonly onIdle: (roleId: string) => void;
  private readonly isRoleDeleting: (roleId: string) => boolean;
  /** 角色当前正在整理的模型服务；维护等待按目标服务判断在途调用（283 §6 R01）。 */
  private readonly activeResources = new Map<string, string>();
  /** 删除保护期间或触发写入失败时暂存的任务结束通知，待后续对账／唤醒恢复（283 §18/§22）。 */
  private readonly deferredTaskIds = new Map<string, string[]>();
  /** 个别任务补写触发失败后的退避重试状态（283 §22）。 */
  private readonly reconcileRetryState = new Map<
    string,
    { attempts: number; retryAt: number }
  >();
  /** 定时器读取绑定／角色库暂不可用或有遗留待处理触发时的短退避次数（283 §24）。 */
  private readonly timerRetryAttempts = new Map<string, number>();
  /** 启动恢复时因角色库暂不可用而跳过的角色集合（283 §25）。 */
  private readonly pendingStartupRecoveryRoles = new Set<string>();
  private closed = false;

  constructor(
    private readonly appStore: AppStore,
    private readonly roleAccess: RoleAccess,
    private readonly bindings: ModelBindingResolver,
    appRoot: string,
    private readonly dataRoot: string,
    options: MemoryRuntimeOptions & { modelFactory?: MemoryModelFactory } = {},
  ) {
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
    this.enabled = options.enabled ?? true;
    this.idleWakeMs = options.idleMs ?? IDLE_WAKE_MS;
    this.appRoot = appRoot;
    this.credentials = options.credentialResolver ?? null;
    this.maintenance = options.maintenance ?? (() => false);
    this.onIdle = options.onIdle ?? (() => undefined);
    this.isRoleDeleting = options.isRoleDeleting ?? (() => false);
    this.customModelFactory = options.modelFactory !== undefined;
    this.modelFactory =
      options.modelFactory ??
      ((binding) => this.createHttpMemoryModel(binding));
  }

  recoverOnStartup(): number {
    if (!this.enabled || this.closed) {
      return 0;
    }
    const now = this.now().toISOString();
    let recovered = 0;
    for (const index of this.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") {
        continue;
      }
      let startupRecovered = false;
      try {
        const storage = RoleStorage.openExisting(
          rolePaths(this.dataRoot, index.roleId),
        );
        let shouldWake = false;
        try {
          const store = new MemoryStore(storage.business.db);
          recovered += store.recoverInterruptedBatches(index.roleId, now);
          startupRecovered = true;
          try {
            store.reconcileFinishedTaskTriggers(index.roleId, now);
          } catch {
            // 触发写入若仍受阻，保留唤醒标记，待存储恢复或维护结束后再补写（283 §21）。
          }
          shouldWake =
            store.listPendingTriggers(index.roleId).length > 0 ||
            store.listFinishedTasksNeedingTrigger(index.roleId).length > 0;
        } finally {
          storage.close();
        }
        this.pendingStartupRecoveryRoles.delete(index.roleId);
        this.armTimer(index.roleId);
        if (shouldWake) {
          // 待处理触发或待对账结束任务跨重启保留；启动后主动检查一次，模型可用时自动继续（283 §20/§21）。
          void this.enqueue(index.roleId, (queue) => {
            queue.pendingScheduled = true;
          });
        }
      } catch {
        // 单个角色损坏不应阻止后端启动；临时锁冲突时登记待补齐的中断批次恢复并退避重查（283 §24/§25）。
        if (!startupRecovered) {
          this.pendingStartupRecoveryRoles.add(index.roleId);
        }
        this.armTimer(index.roleId);
      }
    }
    return recovered;
  }

  notifyEvidence(roleId: string): void {
    this.enqueue(roleId, (queue) => {
      queue.pendingEvidence = true;
    });
  }

  notifyTaskFinished(roleId: string, taskId: string): void {
    if (!this.enabled || this.closed || this.disposedRoles.has(roleId)) {
      return;
    }
    // 无论是否处于删除保护，先把任务结束意图持久化，避免维护或进程重启丢失（283 §20/§21）。
    const status = this.persistTaskEndTrigger(roleId, taskId);
    if (status === "failed") {
      // 存储暂不可用时退回内存暂存，并在后续对账/恢复时继续补写（283 §18/§21）。
      const list = this.deferredTaskIds.get(roleId) ?? [];
      if (!list.includes(taskId)) list.push(taskId);
      this.deferredTaskIds.set(roleId, list);
    }
    if (this.isRoleDeleting(roleId) || status === "none") {
      return;
    }
    this.enqueue(roleId, (queue) => {
      if (status === "failed") {
        if (!queue.pendingTaskIds.includes(taskId)) {
          queue.pendingTaskIds.push(taskId);
        }
        return;
      }
      queue.pendingScheduled = true;
    });
  }

  /** 任务结束且仍有待整理工具证据时写入持久化触发；区分已写入、无需写入与写入失败。 */
  private persistTaskEndTrigger(
    roleId: string,
    taskId: string,
  ): "persisted" | "none" | "failed" {
    try {
      return this.roleAccess.withStore(roleId, (storage) => {
        const store = new MemoryStore(storage.business.db);
        if (store.pendingTaskEvidenceCount(roleId, taskId) <= 0) {
          return "none" as const;
        }
        store.enqueueTrigger({
          roleId,
          kind: "task_end",
          taskId,
          now: this.now().toISOString(),
        });
        return "persisted" as const;
      });
    } catch {
      return "failed" as const;
    }
  }

  runPending(roleId: string): Promise<void> {
    return this.enqueue(roleId, (queue) => {
      queue.pendingManual = true;
    });
  }

  /** 模型服务恢复或维护结束后重新检查待处理触发（283 R02）。 */
  kick(roleId: string): void {
    if (!this.enabled || this.closed || this.disposedRoles.has(roleId)) {
      return;
    }
    // 删除保护仍在时保留通知，等删除失败后的补发（283 §18）。
    if (this.isRoleDeleting(roleId)) {
      return;
    }
    // 任务结束通知保留在暂存区，由下一个真正可运行的批次吸收；
    // 记忆服务仍在维护时批次会提前返回，通知不会丢失（283 §19）。
    void this.enqueue(roleId, (queue) => {
      queue.pendingScheduled = true;
    });
  }

  /**
   * 该角色是否仍有记忆整理在途（含同一批的后续调用与排队触发）。
   * 停止确认与维护等待据此把后台调用算作角色仍在运行（283 §4 R01）。
   */
  isBusy(roleId: string): boolean {
    if (!this.enabled || this.closed) {
      return false;
    }
    const queue = this.queues.get(roleId);
    return queue === undefined ? false : queueBusy(queue);
  }

  /** 正在使用目标模型服务的记忆整理角色；已停止角色也可能在其中（283 §6 R01）。 */
  inflightRoleIds(resourceId: string): string[] {
    if (!this.enabled || this.closed) {
      return [];
    }
    const roles: string[] = [];
    for (const [roleId, active] of this.activeResources) {
      if (active !== resourceId) continue;
      if (this.isBusy(roleId)) roles.push(roleId);
    }
    return roles.sort();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.deferredTaskIds.clear();
    this.reconcileRetryState.clear();
    this.timerRetryAttempts.clear();
    this.pendingStartupRecoveryRoles.clear();
    await Promise.all(
      [...this.queues.values()]
        .map((queue) => queue.promise)
        .filter((promise): promise is Promise<void> => promise !== null),
    );
  }

  /** 等待该角色的记忆队列收尾并停止后续调度；删除角色前调用。 */
  async disposeRole(roleId: string): Promise<void> {
    this.disposedRoles.add(roleId);
    this.deferredTaskIds.delete(roleId);
    this.reconcileRetryState.delete(roleId);
    this.timerRetryAttempts.delete(roleId);
    this.pendingStartupRecoveryRoles.delete(roleId);
    const timer = this.timers.get(roleId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(roleId);
    }
    const queue = this.queues.get(roleId);
    if (queue?.promise !== null && queue?.promise !== undefined) {
      await queue.promise.catch(() => {});
    }
    const late = this.timers.get(roleId);
    if (late !== undefined) {
      clearTimeout(late);
      this.timers.delete(roleId);
    }
    this.queues.delete(roleId);
  }

  private enqueue(
    roleId: string,
    mark: (queue: QueueState) => void,
  ): Promise<void> {
    if (
      !this.enabled ||
      this.closed ||
      this.disposedRoles.has(roleId) ||
      this.isRoleDeleting(roleId)
    ) {
      return Promise.resolve();
    }
    const queue = this.queues.get(roleId) ?? {
      running: false,
      pendingEvidence: false,
      pendingTaskIds: [],
      pendingManual: false,
      pendingScheduled: false,
      promise: null,
    };
    this.queues.set(roleId, queue);
    mark(queue);
    if (queue.running) {
      return queue.promise ?? Promise.resolve();
    }
    queue.running = true;
    queue.promise = this.drain(roleId, queue).finally(() => {
      queue.running = false;
      queue.promise = null;
      if (queueBusy(queue)) {
        void this.drain(roleId, queue);
      } else {
        // 整批（含后续模型调用）都结束后再通知；停止确认可据此收敛。
        this.onIdle(roleId);
      }
    });
    return queue.promise;
  }

  private async drain(roleId: string, queue: QueueState): Promise<void> {
    try {
      while (
        queue.pendingEvidence ||
        queue.pendingTaskIds.length > 0 ||
        queue.pendingManual ||
        queue.pendingScheduled
      ) {
        const evidence = queue.pendingEvidence;
        const taskIds = queue.pendingTaskIds.splice(0);
        const manual = queue.pendingManual;
        const scheduled = queue.pendingScheduled;
        queue.pendingEvidence = false;
        queue.pendingManual = false;
        queue.pendingScheduled = false;
        try {
          await this.runOnce(roleId, { evidence, taskIds, manual, scheduled });
        } catch {
          // 后台整理失败保留待处理证据，下次触发或重启后继续重试。
        }
      }
    } finally {
      this.armTimer(roleId);
    }
  }

  /** 删除中、缺少模型绑定或目标服务维护期间暂不安排定时轮询；临时读库错误向上交给 armTimer 退避重查（283 §23/§24）。 */
  private canScheduleNow(roleId: string): boolean {
    if (this.isRoleDeleting(roleId)) {
      return false;
    }
    try {
      const binding = this.bindings.resolveMemory(roleId);
      return !this.maintenance(binding.resourceId);
    } catch (error) {
      if (
        error instanceof ModelBindingMissingError ||
        error instanceof ResourceKindMismatchError ||
        error instanceof RoleNotFoundError ||
        error instanceof RoleNotReadyError ||
        error instanceof InvalidRoleIdError
      ) {
        return false;
      }
      throw error;
    }
  }

  private nextTimerRetryDelayMs(roleId: string): number {
    const attempts = (this.timerRetryAttempts.get(roleId) ?? 0) + 1;
    this.timerRetryAttempts.set(roleId, attempts);
    return (
      TIMER_RETRY_DELAYS_MS[
        Math.min(attempts - 1, TIMER_RETRY_DELAYS_MS.length - 1)
      ] ?? 30_000
    );
  }

  private scheduleWakeTimer(roleId: string, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(roleId);
      void this.enqueue(roleId, (queue) => {
        queue.pendingScheduled = true;
      });
    }, Math.max(0, delay));
    timer.unref?.();
    this.timers.set(roleId, timer);
  }

  private armTimer(roleId: string): void {
    if (!this.enabled || this.closed || this.disposedRoles.has(roleId)) {
      return;
    }
    const existing = this.timers.get(roleId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(roleId);
    }
    let wakeAt: number | null = null;
    let shouldResetRetry = true;
    try {
      if (!this.canScheduleNow(roleId)) {
        this.timerRetryAttempts.delete(roleId);
        return;
      }
      const storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
      try {
        const store = new MemoryStore(storage.business.db);
        const nowMs = this.now().getTime();
        const retryAt = store.nextFailedRetryAt(roleId);
        if (retryAt !== null) {
          wakeAt = Date.parse(retryAt);
        }
        const maintenanceRetryAt = this.maintenanceRetryAt(store, roleId);
        if (maintenanceRetryAt !== null) {
          const at = Date.parse(maintenanceRetryAt);
          if (wakeAt === null || at < wakeAt) {
            wakeAt = at;
          }
        }
        const maintenanceCheckAt = this.maintenanceCheckAt(store, roleId);
        if (maintenanceCheckAt !== null) {
          const at = Date.parse(maintenanceCheckAt);
          if (wakeAt === null || at < wakeAt) {
            wakeAt = at;
          }
        }
        for (const stats of store.pendingMessageStats(roleId)) {
          if (stats.count < 30) {
            continue;
          }
          const idleAt = Date.parse(stats.lastOccurredAt) + this.idleWakeMs;
          if (wakeAt === null || idleAt < wakeAt) {
            wakeAt = idleAt;
          }
        }
        const reconcileRetryAt = this.reconcileRetryAt(store, roleId);
        if (
          reconcileRetryAt !== null &&
          (wakeAt === null || reconcileRetryAt < wakeAt)
        ) {
          wakeAt = reconcileRetryAt;
        }
        // 启动未完成中断批次恢复、上一轮异常留下的待处理触发，或尚未登记补写退避的已结束任务，按短退避自动恢复继续（283 §24/§25）。
        const needsStartupRecovery =
          this.pendingStartupRecoveryRoles.has(roleId);
        const hasPendingTriggers = store.listPendingTriggers(roleId).length > 0;
        const hasUntrackedFinishedTasks =
          !this.reconcileRetryState.has(roleId) &&
          store.listFinishedTasksNeedingTrigger(roleId).length > 0;
        if (
          needsStartupRecovery ||
          hasPendingTriggers ||
          hasUntrackedFinishedTasks
        ) {
          shouldResetRetry = false;
          const retryAtMs = nowMs + this.nextTimerRetryDelayMs(roleId);
          if (wakeAt === null || retryAtMs < wakeAt) {
            wakeAt = retryAtMs;
          }
        }
      } finally {
        storage.close();
      }
      if (shouldResetRetry) {
        this.timerRetryAttempts.delete(roleId);
      }
    } catch (error) {
      // 定时器收尾读取绑定或角色库失败时不得抛出未处理拒绝；仅非缺失路径错误安排短退避重试（283 §24）。
      if (!isMissingRoleStorageError(error)) {
        this.scheduleWakeTimer(roleId, this.nextTimerRetryDelayMs(roleId));
      }
      return;
    }
    if (wakeAt === null || Number.isNaN(wakeAt)) {
      return;
    }
    this.scheduleWakeTimer(roleId, wakeAt - this.now().getTime());
  }

  private maintenanceRetryAt(store: MemoryStore, roleId: string): string | null {
    const latest = store.latestMaintenanceBatch(roleId);
    if (
      latest === null ||
      latest.status !== "failed" ||
      latest.finishedAt === null
    ) {
      return null;
    }
    if (
      store.listRefineCandidates(roleId, store.getCurrentRound(roleId))
        .length === 0
    ) {
      return null;
    }
    const index = Math.min(
      Math.max(latest.attemptCount - 1, 0),
      DEFAULT_MEMORY_RETRY_DELAYS_MS.length - 1,
    );
    return new Date(
      Date.parse(latest.finishedAt) +
        (DEFAULT_MEMORY_RETRY_DELAYS_MS[index] ?? 3_600_000),
    ).toISOString();
  }

  private maintenanceCheckAt(
    store: MemoryStore,
    roleId: string,
  ): string | null {
    if (
      store.listRefineCandidates(roleId, store.getCurrentRound(roleId))
        .length === 0
    ) {
      return null;
    }
    const latest = store.latestMaintenanceBatch(roleId);
    if (latest === null) {
      // 首次出现候选时立即安排一次维护检查。
      return this.now().toISOString();
    }
    if (latest.status !== "completed" || latest.finishedAt === null) {
      return null;
    }
    return new Date(
      Date.parse(latest.finishedAt) + MAINTENANCE_RECHECK_MS,
    ).toISOString();
  }

  private advanceReconcileRetry(roleId: string): void {
    const attempts = (this.reconcileRetryState.get(roleId)?.attempts ?? 0) + 1;
    const delayMs =
      DEFAULT_MEMORY_RETRY_DELAYS_MS[
        Math.min(attempts - 1, DEFAULT_MEMORY_RETRY_DELAYS_MS.length - 1)
      ] ?? 3_600_000;
    this.reconcileRetryState.set(roleId, {
      attempts,
      retryAt: this.now().getTime() + delayMs,
    });
  }

  private reconcileRetryAt(store: MemoryStore, roleId: string): number | null {
    const retry = this.reconcileRetryState.get(roleId);
    if (retry === undefined) {
      return null;
    }
    if (store.listFinishedTasksNeedingTrigger(roleId).length === 0) {
      this.reconcileRetryState.delete(roleId);
      return null;
    }
    return retry.retryAt;
  }

  private createHttpMemoryModel(binding: ResolvedModelBinding): MemoryModelPort {
    return new HttpMemoryModel(
      new HttpModelAdapter(
        binding.config,
        this.credentials === null
          ? resolveCredential(this.appRoot, binding.config.credentialRef)
          : this.credentials.resolve(
              binding.resourceId,
              binding.config.credentialRef,
            ),
      ),
      binding,
    );
  }

  private async runOnce(
    roleId: string,
    input: {
      evidence: boolean;
      taskIds: string[];
      manual: boolean;
      scheduled: boolean;
    },
  ): Promise<void> {
    let binding: ResolvedModelBinding;
    try {
      binding = this.bindings.resolveMemory(roleId);
    } catch (error) {
      if (error instanceof ModelBindingMissingError) {
        this.reconcileRetryState.delete(roleId);
        return;
      }
      throw error;
    }
    // 删除收尾期间不再领取新的整理批次；已开始的批次照常结算（283 §20）。
    if (this.isRoleDeleting(roleId)) {
      this.reconcileRetryState.delete(roleId);
      return;
    }
    // 目标服务正在维护：原待处理触发保留在存储里，清理已过期补写退避，待维护结束后由唤醒重查（283 §23）。
    if (this.maintenance(binding.resourceId)) {
      this.reconcileRetryState.delete(roleId);
      return;
    }
    // 记录本批实际使用的模型服务：维护等待要覆盖已停止角色的在途调用（283 §6 R01）。
    this.activeResources.set(roleId, binding.resourceId);
    try {
      this.roleAccess.requireReady(roleId);
      const storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
      try {
        const store = new MemoryStore(storage.business.db);
        const model = this.customModelFactory
          ? this.modelFactory(binding)
          : new RefreshingMemoryModel(
              () => this.bindings.refresh(binding, roleId),
              (current) => this.createHttpMemoryModel(current),
            );
        const capacity = memoryCapacityOf(binding);
        const service = new MemoryService(store, model, {
          modelInfo: {
            modelName: binding.modelName,
            protocol: binding.config.protocol,
          },
          ...(capacity === null ? {} : { capacity }),
          requestOverheadChars: Array.from(MEMORY_SYSTEM_PROMPT).length + 1_000,
          idleMs: this.idleWakeMs,
          ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
          now: this.now,
        });
        const nowIso = this.now().toISOString();
        // 启动阶段若因角色库暂不可用跳过了中断批次恢复，在任何触发入队或批次启动前补齐；
        // 仅针对登记为待恢复启动状态的角色，避免重置当前进程正常运行中的批次（283 §25）。
        let recoveredStartupBatches = 0;
        if (this.pendingStartupRecoveryRoles.has(roleId)) {
          recoveredStartupBatches = store.recoverInterruptedBatches(
            roleId,
            nowIso,
          );
          this.pendingStartupRecoveryRoles.delete(roleId);
        }
        const deferredSnapshot = [...(this.deferredTaskIds.get(roleId) ?? [])];
        const taskIdsToPersist = [...input.taskIds];
        for (const taskId of deferredSnapshot) {
          if (!taskIdsToPersist.includes(taskId)) {
            taskIdsToPersist.push(taskId);
          }
        }
        const failedTaskIds = new Set<string>();
        const succeededTaskIds = new Set<string>();
        let reconcileThrew = false;

        try {
          // 1) 从持久化状态逐项对账补写 task_end，单项写入失败不影响其他任务与后续整理（283 §21/§22）。
          try {
            const reconciled = store.reconcileFinishedTaskTriggers(roleId, nowIso);
            for (const taskId of reconciled.failedTaskIds) {
              failedTaskIds.add(taskId);
            }
          } catch {
            reconcileThrew = true;
            // 对账异常时不阻断已有的手动、对话阈值或重试整理（283 §22）。
          }

          // 2) 对话阈值／空闲触发独立生成，不被个别任务写库失败阻断。
          if (input.evidence || input.scheduled) {
            try {
              service.onEvidenceRegistered(roleId);
            } catch {
              // 触发写库异常不阻断本轮已有触发。
            }
          }

          // 3) 逐项吸收待补发任务结束通知：写入失败的保留可重试状态，其余移除（283 §19/§22）。
          for (const taskId of taskIdsToPersist) {
            if (failedTaskIds.has(taskId)) {
              continue;
            }
            try {
              service.onTaskFinished(roleId, taskId);
              succeededTaskIds.add(taskId);
            } catch {
              failedTaskIds.add(taskId);
            }
          }

          const currentDeferred = this.deferredTaskIds.get(roleId) ?? [];
          const nextDeferred = currentDeferred.filter(
            (taskId) => failedTaskIds.has(taskId) || !succeededTaskIds.has(taskId),
          );
          for (const taskId of failedTaskIds) {
            if (!nextDeferred.includes(taskId)) {
              nextDeferred.push(taskId);
            }
          }
          if (nextDeferred.length === 0) {
            this.deferredTaskIds.delete(roleId);
          } else {
            this.deferredTaskIds.set(roleId, nextDeferred);
          }

          if (input.manual && store.listPendingTriggers(roleId).length === 0) {
            try {
              service.enqueueManual(roleId);
            } catch {
              // 写库失败时不丢弃既有待处理触发检查。
            }
          }

          const dueRetry =
            (input.scheduled || recoveredStartupBatches > 0) &&
            store.hasDueFailedEvidence(roleId, nowIso);
          const maintenanceRetryAt = this.maintenanceRetryAt(store, roleId);
          const dueMaintenance =
            maintenanceRetryAt !== null && maintenanceRetryAt <= nowIso;
          const checkAt = this.maintenanceCheckAt(store, roleId);
          const dueMaintenanceCheck = checkAt !== null && checkAt <= nowIso;
          const pendingTriggers = store.listPendingTriggers(roleId);
          if (pendingTriggers.length > 0 || dueRetry) {
            await service.runPending(roleId, {
              includeRefinement: true,
              includeDeferred: pendingTriggers.some((trigger) => trigger.kind === "manual" && trigger.batchId === null),
            });
          } else if (dueMaintenance || dueMaintenanceCheck) {
            await service.runBatch(roleId, { maintenanceOnly: true });
          }

          // 若失败任务的工具证据已在本轮其余触发中被整理完成，清理其过期暂存与重试计数。
          if (failedTaskIds.size > 0) {
            const retained = (this.deferredTaskIds.get(roleId) ?? []).filter(
              (taskId) =>
                !failedTaskIds.has(taskId) ||
                store.pendingTaskEvidenceCount(roleId, taskId) > 0,
            );
            if (retained.length === 0) {
              this.deferredTaskIds.delete(roleId);
            } else {
              this.deferredTaskIds.set(roleId, retained);
            }
          }
        } finally {
          // 无论后续整理是否抛错，只要待补写任务仍在且无有效未来退避，就刷新重试时间，避免零延迟自旋（283 §23）。
          try {
            const remainingNeedingTrigger =
              store.listFinishedTasksNeedingTrigger(roleId);
            if (remainingNeedingTrigger.length === 0) {
              this.reconcileRetryState.delete(roleId);
            } else if (
              failedTaskIds.size > 0 ||
              reconcileThrew ||
              (this.reconcileRetryState.get(roleId)?.retryAt ?? Infinity) <=
                this.now().getTime()
            ) {
              this.advanceReconcileRetry(roleId);
            }
          } catch {
            if (this.reconcileRetryState.has(roleId)) {
              this.advanceReconcileRetry(roleId);
            }
          }
        }
      } finally {
        storage.close();
      }
    } finally {
      if (this.activeResources.get(roleId) === binding.resourceId) {
        this.activeResources.delete(roleId);
      }
    }
  }
}

class RefreshingMemoryModel implements MemoryModelPort {
  constructor(
    private readonly resolveBinding: () => ResolvedModelBinding,
    private readonly create: (binding: ResolvedModelBinding) => MemoryModelPort,
  ) {}

  form(input: MemoryFormationInput): Promise<unknown> {
    return this.create(this.resolveBinding()).form(input);
  }
}

/** 从模型资源配置读取可核实容量声明；缺省时返回 null 走保守默认。 */
function memoryCapacityOf(
  binding: ResolvedModelBinding,
): MemoryModelCapacity | null {
  const config = binding.config;
  const maxInputChars =
    typeof config.maxInputChars === "number" ? config.maxInputChars : null;
  const maxOutputChars =
    typeof config.maxOutputChars === "number" ? config.maxOutputChars : null;
  if (maxInputChars === null && maxOutputChars === null) {
    return null;
  }
  return {
    maxInputChars: maxInputChars ?? DEFAULT_MEMORY_BUDGET_CHARS,
    maxOutputChars: maxOutputChars ?? DEFAULT_OUTPUT_RESERVE_CHARS,
    source: "declared",
  };
}

export class HttpMemoryModel implements MemoryModelPort {
  constructor(
    private readonly model: ModelPort,
    private readonly binding: ResolvedModelBinding,
  ) {}

  async form(input: MemoryFormationInput): Promise<unknown> {
    let text = "";
    let completed = false;
    let incomplete = false;
    for await (const event of this.model.stream({
      modelName: this.binding.modelName,
      system: MEMORY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(input) }],
      tools: [],
    })) {
      if (event.type === "text_delta") {
        text += event.text;
      }
      if (event.type === "completed") {
        completed = true;
        incomplete = isIncompleteCompletion(event);
      }
    }
    if (!completed) {
      throw new Error("MEMORY_MODEL_STREAM_TRUNCATED");
    }
    if (incomplete) {
      throw new Error("MEMORY_MODEL_INCOMPLETE");
    }
    const json = extractJson(text);
    return json === null ? text : json;
  }
}

const MEMORY_SYSTEM_PROMPT = [
  "你是记忆整理器，不是对话角色。",
  "阅读用户提供的 JSON（batchId、currentRound、evidence、relatedEvents、refineCandidates、summaryCandidates），只输出一个 JSON 对象，不要 Markdown、解释或代码围栏。",
  '输出格式：{"operations":[...]}；没有合适操作时输出 {"operations":[]}。',
  "可用操作及必需字段：",
  '1. create_event：{"op":"create_event","localKey":"批次内唯一字符串","title":"...","summary":"...","subjectiveExperience":"可选","occurredAtStart":"ISO 时间","occurredAtEnd":"可选 ISO 或 null","experienceDate":"YYYY-MM-DD，必须与 occurredAtStart 的本地日期一致","tags":{"person":[],"topic":[],"place":[],"emotion":[],"source":[]},"evidenceIds":["本批 evidence 中的 evidenceId，至少一个"]}',
  '2. update_event：{"op":"update_event","eventId":"...","expectedVersion":1,"patch":{"title?","summary?","subjectiveExperience?","occurredAtStart?","occurredAtEnd?","tags?"},"addEvidenceIds":["本批 evidence 中的 id，可选"],"reason":"可选"}',
  '3. refine_event：{"op":"refine_event","events":[{"eventId":"refineCandidates 中的 id","expectedVersion":1}],"summary":"概括后的日常摘要","targetSummaryId":"summaryCandidates 中的 id，可选","expectedSummaryVersion":1,"topic":"可选","reason":"可选"}；targetSummaryId 与 expectedSummaryVersion 必须同时提供',
  '4. defer：{"op":"defer","evidenceIds":["本批 evidence 中的 id"],"reason":"可选"}',
  "约束：",
  "- 只能引用输入中实际出现的 evidenceId、eventId、summaryId；不得编造。",
  "- create_event 的 experienceDate 必须与 occurredAtStart 按系统时区计算的本地日期一致。",
  "- update_event 与 refine_event 必须带当前 expectedVersion；版本不一致会整批失败。",
  "- 事件补充优先 update_event；多个低频事件的概括优先 refine_event；证据暂不明确时用 defer。",
  "- subjectiveExperience 只写角色主观感受，事实写入 summary。",
  "- tags 的键只能是 person、topic、place、emotion、source（均为单数），每个值都是字符串数组。",
  '示例（仅示意格式）：{"operations":[{"op":"create_event","localKey":"visit-1","title":"去旧书店","summary":"用户和角色去了旧书店。","occurredAtStart":"2026-11-04T03:00:00.000Z","experienceDate":"2026-11-04","tags":{"person":["用户"],"topic":["旧书"],"place":["旧书店"],"emotion":["怀念"],"source":["对话"]},"evidenceIds":["<取自输入>"]}]}',
].join("\n");

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

/** 队列仍在运行或还有已排队触发，都算记忆整理未收尾。 */
function queueBusy(queue: QueueState): boolean {
  return (
    queue.running ||
    queue.pendingEvidence ||
    queue.pendingTaskIds.length > 0 ||
    queue.pendingManual ||
    queue.pendingScheduled
  );
}

/** 识别角色目录本身缺失或路径非法的永久错误，避免无效重试定时。 */
function isMissingRoleStorageError(error: unknown): boolean {
  if (error instanceof StorageError) {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    return (
      reason === "ROLE_STORAGE_PATH_MISSING" ||
      reason === "ROLE_STORAGE_PATH_INVALID"
    );
  }
  if (error instanceof Error) {
    return (
      error.message.startsWith("ROLE_STORAGE_PATH_MISSING:") ||
      error.message.startsWith("ROLE_STORAGE_PATH_INVALID:")
    );
  }
  return false;
}
