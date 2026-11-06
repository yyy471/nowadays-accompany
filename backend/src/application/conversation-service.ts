import type http from "node:http";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { rolePaths } from "../bootstrap/config.js";
import type {
  AgentTaskAction,
  BackgroundToolSettlement,
  ClaimedMessage,
  ConversationExecutionDetail,
  ConversationMessageView,
  ConversationTool,
  RecallBrief,
  SkillBrief,
} from "../domain/conversation.js";
import {
  AppError,
  AutonomyBudgetExhaustedError,
  ExecutionSupersededError,
  ModelRequestFailedError,
  SseCursorInvalidError,
  TaskEndedError,
} from "../domain/errors.js";
import type { ModelPort } from "../domain/model.js";
import { localDateFromIso } from "../storage/evidence.js";
import { resolveCredential } from "../model/credentials.js";
import { HttpModelAdapter } from "../model/protocols.js";
import type { AppStore } from "../storage/app-store.js";
import {
  ConversationStore,
  type CommitConversationTaskDecision,
  type PrimaryExecutionTask,
  type RecoverableTaskContinuation,
  type RecoveredExecution,
} from "../storage/conversation-store.js";
import {
  AutonomyStore,
  type AutonomyWakeRecord,
} from "../storage/autonomy-store.js";
import type {
  ExecutionRecord,
  MessageRecord,
  RoleStore,
  SubmitMessageInput,
  SubmitMessageResult,
  TaskRecord,
} from "../storage/role-store.js";
import { RoleStorage } from "../storage/role-storage.js";
import {
  AgentGraphRunner,
  type AgentModelHandle,
} from "./agent-graph.js";
import { loadAgentTools, type AgentToolCatalog } from "./agent-tools.js";
import type { AutonomyService } from "./autonomy-service.js";
import { InputStateRegistry } from "./input-state.js";
import type { MemoryQueryService } from "./memory-query-service.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import type {
  ModelBindingResolver,
  ResolvedModelBinding,
} from "./model-binding-resolver.js";
import type { RoleAccess } from "./role-access.js";

export type ChatModelPortFactory = (binding: ResolvedModelBinding) => ModelPort;

/** 外部工具前台等待窗口原型默认值；越过后自动转后台，等待时长仍待真实工具联调校准。 */
export const DEFAULT_TOOL_FOREGROUND_WAIT_MS = 2_000;

export interface ConversationServiceOptions {
  now?: () => Date;
  timeZone?: string;
  typingMs?: number;
  autoRecallLimit?: number;
  maxToolRounds?: number;
  toolForegroundWaitMs?: number;
  modelPortFactory?: ChatModelPortFactory;
  memoryRuntime?: MemoryRuntime | null;
  autonomy?: AutonomyService | null;
}

interface RunningExecution {
  roleId: string;
  windowId: string;
  executionId: string;
  controller: AbortController;
  partialText: string;
  superseded: boolean;
  autonomous: boolean;
  promise: Promise<void>;
}

interface PendingTaskContinuation {
  taskId: string;
  windowId: string;
}

interface AutonomyExecutionContext {
  activityId: string | null;
  wakeId: string | null;
  intent: string;
  resumed: boolean;
}

interface ResumableExecution {
  execution: ExecutionRecord;
  taskId: string | null;
  taskStatus: string | null;
  taskOrigin: string | null;
  windowId: string;
}

export interface SubmitConversationResult extends SubmitMessageResult {
  decisionScheduled: boolean;
}

export class ConversationService {
  readonly inputStates: InputStateRegistry;
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private readonly autoRecallLimit: number;
  private readonly maxToolRounds: number;
  private readonly toolForegroundWaitMs: number;
  private readonly modelFactory: ChatModelPortFactory;
  private readonly memoryRuntime: MemoryRuntime | null;
  private readonly autonomy: AutonomyService | null;
  private readonly running = new Map<string, RunningExecution>();
  private readonly detached = new Set<RunningExecution>();
  private readonly backgroundToolSettles = new Set<Promise<void>>();
  private readonly backgroundToolsByRole = new Map<string, number>();
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  private readonly dueWakeChecks = new Map<string, string>();
  private readonly pendingContinuations = new Map<
    string,
    PendingTaskContinuation[]
  >();
  private readonly taskCatalogs = new Map<
    string,
    {
      roleId: string;
      catalog: AgentToolCatalog;
      modelBinding: ResolvedModelBinding;
    }
  >();
  private readonly activeStreams = new Set<() => void>();
  private readonly blockedWindows = new Set<string>();
  private closed = false;

  constructor(
    private readonly appStore: AppStore,
    private readonly roleAccess: RoleAccess,
    private readonly bindings: ModelBindingResolver,
    private readonly memory: MemoryQueryService,
    private readonly appRoot: string,
    private readonly dataRoot: string,
    options: ConversationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
    this.autoRecallLimit = options.autoRecallLimit ?? 8;
    this.maxToolRounds = options.maxToolRounds ?? 8;
    this.toolForegroundWaitMs =
      options.toolForegroundWaitMs ?? DEFAULT_TOOL_FOREGROUND_WAIT_MS;
    this.modelFactory =
      options.modelPortFactory ??
      ((binding) =>
        new HttpModelAdapter(
          binding.config,
          resolveCredential(this.appRoot, binding.config.credentialRef),
        ));
    this.memoryRuntime = options.memoryRuntime ?? null;
    this.autonomy = options.autonomy ?? null;
    this.inputStates = new InputStateRegistry({
      typingMs: options.typingMs ?? 1000,
      now: this.now,
      onExpire: (roleId) => {
        void this.schedule(roleId);
      },
    });
  }

  submitMessage(
    roleId: string,
    windowId: string,
    input: SubmitMessageInput,
  ): SubmitConversationResult {
    const result = this.roleAccess.withStore(roleId, (storage) =>
      storage.business.submitMessage(roleId, windowId, input),
    );
    if (result.duplicate) {
      return { ...result, decisionScheduled: false };
    }
    this.blockedWindows.delete(windowKey(roleId, windowId));
    this.supersedeWindow(roleId, windowId);
    const decisionScheduled = this.schedule(roleId);
    return { ...result, decisionScheduled };
  }

  updateInputState(input: {
    roleId: string;
    windowId: string;
    clientId: string;
    typing: boolean;
  }): { state: Record<string, unknown> | null } {
    this.roleAccess.withStore(input.roleId, (storage) =>
      storage.business.getWindow(input.roleId, input.windowId),
    );
    const state = this.inputStates.update(input);
    if (!input.typing) {
      this.schedule(input.roleId);
    }
    return { state: state === null ? null : { ...state } };
  }

  clearInputState(input: {
    roleId: string;
    windowId: string;
    clientId: string;
  }): { cleared: boolean } {
    this.roleAccess.withStore(input.roleId, (storage) =>
      storage.business.getWindow(input.roleId, input.windowId),
    );
    this.inputStates.clearClient(input.roleId, input.windowId, input.clientId);
    this.schedule(input.roleId);
    return { cleared: true };
  }

  getExecution(
    roleId: string,
    executionId: string,
  ): ConversationExecutionDetail {
    return this.withConversationStore(roleId, (store) =>
      store.getExecutionDetail(executionId),
    );
  }

  runMemoryPending(roleId: string): Promise<void> {
    if (this.memoryRuntime === null) {
      return Promise.resolve();
    }
    return this.memoryRuntime.runPending(roleId);
  }

  listTasks(roleId: string): TaskRecord[] {
    return this.roleAccess.withStore(roleId, (storage) =>
      storage.business.listTasks(roleId),
    );
  }

  getTask(roleId: string, taskId: string): TaskRecord {
    return this.roleAccess.withStore(roleId, (storage) =>
      storage.business.getTask(roleId, taskId),
    );
  }

  finishTask(input: {
    roleId: string;
    taskId: string;
    status: "completed" | "failed";
    endReason: string;
  }): TaskRecord {
    const task = this.roleAccess.withStore(input.roleId, (storage) => {
      const finished = storage.business.finishTask(input);
      for (const continuation of storage.business.listResourceContinuations(
        input.roleId,
        input.taskId,
      )) {
        if (continuation.endedAt === null) {
          storage.business.endResourceContinuation({
            roleId: input.roleId,
            taskId: input.taskId,
            resourceId: continuation.resourceId,
          });
        }
      }
      return finished;
    });
    try {
      this.autonomy?.cancelPendingBudgetResumes(
        input.roleId,
        input.taskId,
        "TASK_ENDED",
      );
    } catch {
      // 任务已经结束；取消失败时由恢复领取时的终态检查兜底。
    }
    void this.closeTaskCatalog(input.taskId);
    this.memoryRuntime?.notifyTaskFinished(input.roleId, input.taskId);
    return task;
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

  async streamEvents(input: {
    roleId: string;
    windowId: string;
    after: number | null;
    clientId: string | null;
    request: http.IncomingMessage;
    response: http.ServerResponse;
  }): Promise<void> {
    this.roleAccess.requireReady(input.roleId);
    const storage = RoleStorage.openExisting(
      rolePaths(this.dataRoot, input.roleId),
    );
    const store = new ConversationStore(
      storage.business.db,
      input.roleId,
      this.timeZone,
    );
    let cursor: number;
    try {
      cursor = input.after ?? store.latestEventId(input.windowId);
      if (input.after !== null) {
        store.validateCursor(input.windowId, input.after);
      }
    } catch (error) {
      storage.close();
      throw error;
    }
    let closed = false;
    let cleanupDone = false;
    const cleanup = (): void => {
      if (cleanupDone) {
        return;
      }
      cleanupDone = true;
      this.activeStreams.delete(cleanup);
      if (input.clientId !== null && input.clientId.length > 0) {
        this.inputStates.clearClient(
          input.roleId,
          input.windowId,
          input.clientId,
        );
        this.schedule(input.roleId);
      }
      storage.close();
      if (!input.response.writableEnded && !input.response.destroyed) {
        try {
          input.response.end();
          if (this.closed) {
            input.response.destroy();
          }
        } catch {
          // 客户端已经断开。
        }
      }
    };
    this.activeStreams.add(cleanup);
    input.request.once("close", () => {
      closed = true;
      cleanup();
    });
    input.request.once("aborted", () => {
      closed = true;
      cleanup();
    });
    input.response.once("close", () => {
      closed = true;
      cleanup();
    });
    input.response.once("error", () => {
      closed = true;
      cleanup();
    });
    input.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    });
    input.response.flushHeaders?.();
    let lastHeartbeat = Date.now();
    try {
      while (
        !closed &&
        !this.closed &&
        !input.response.destroyed &&
        !input.response.writableEnded
      ) {
        const events = store.listStreamEventsAfter(input.windowId, cursor, 200);
        if (events.length > 0) {
          for (const event of events) {
            cursor = event.streamEventId;
            const data = {
              streamEventId: event.streamEventId,
              type: event.type,
              ...event.payload,
            };
            input.response.write(
              `id: ${event.streamEventId}\nevent: execution\ndata: ${JSON.stringify(data)}\n\n`,
            );
          }
          continue;
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
          lastHeartbeat = Date.now();
          input.response.write(": heartbeat\n\n");
        }
        await delay(100);
      }
    } finally {
      cleanup();
    }
  }

  recoverOnStartup(): number {
    let recovered = 0;
    for (const index of this.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") {
        continue;
      }
      try {
        const now = this.now().toISOString();
        const storage = RoleStorage.openExisting(
          rolePaths(this.dataRoot, index.roleId),
        );
        let interrupted: RecoveredExecution[] = [];
        let superseded: RecoverableTaskContinuation[] = [];
        const resumable: ResumableExecution[] = [];
        let pendingUserRecovery = false;
        try {
          const store = new ConversationStore(
            storage.business.db,
            index.roleId,
            this.timeZone,
          );
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
            this.timeZone,
          );
          try {
            autonomyStore.reconcileToolReservations(now);
          } catch {
            // 预留结算失败保留原状态，后续启动继续重试。
          }
          interrupted = store.recoverInterruptedExecutions(now, resumableIds);
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
          pendingUserRecovery = store.listPendingWindows().some(
            (window) => store.findInterruptedUserTask(window.windowId) !== null,
          );
        } finally {
          storage.close();
        }
        let continuationQueued = false;
        const resumableTaskIds = new Set(
          resumable
            .map((item) => item.taskId)
            .filter((taskId): taskId is string => taskId !== null),
        );
        for (const item of interrupted) {
          if (
            item.windowId !== null &&
            item.taskId !== null &&
            item.taskStatus === "active" &&
            item.taskOrigin === "autonomous" &&
            !resumableTaskIds.has(item.taskId)
          ) {
            this.queueTaskContinuation(index.roleId, {
              taskId: item.taskId,
              windowId: item.windowId,
            });
            continuationQueued = true;
          }
        }
        for (const item of superseded) {
          if (resumableTaskIds.has(item.taskId)) {
            continue;
          }
          this.queueTaskContinuation(index.roleId, {
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
        this.armWakeTimer(index.roleId);
        if (continuationQueued || pendingUserRecovery || resumeFallback) {
          this.schedule(index.roleId);
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
    if (!this.executionHasCompletedCheckpoint(storage, execution.executionId)) {
      return null;
    }
    return { task };
  }

  private executionHasCompletedCheckpoint(
    storage: RoleStorage,
    executionId: string,
  ): boolean {
    try {
      const row = storage.checkpoint.db
        .prepare(
          `SELECT metadata FROM checkpoints
            WHERE thread_id = ?
            ORDER BY rowid DESC LIMIT 1`,
        )
        .get(executionId) as
        | { metadata: string | Buffer | null }
        | undefined;
      if (row === undefined || row.metadata === null) {
        return false;
      }
      const metadata = JSON.parse(row.metadata.toString()) as {
        step?: unknown;
      };
      // step -1 是仅含输入的初始检查点，step 0 尚未完成首轮模型。
      return typeof metadata.step === "number" && metadata.step >= 1;
    } catch {
      return false;
    }
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
        if (decision?.action.kind === "pause") {
          // 回复已提交但暂停写入中断：按原决定暂停，保留资源续行与唤醒。
          storage.business.pauseTask({
            roleId,
            taskId: gap.taskId,
            endReason: decision.action.reason,
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
        this.memoryRuntime?.notifyTaskFinished(roleId, gap.taskId);
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
      this.memoryRuntime?.notifyEvidence(roleId);
    }
  }

  private startResumedExecution(
    roleId: string,
    item: ResumableExecution,
  ): boolean {
    if (this.running.has(roleId)) {
      return false;
    }
    let storage: RoleStorage | null = null;
    try {
      this.roleAccess.requireReady(roleId);
      storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.timeZone,
      );
      const execution = store.getExecution(item.execution.executionId);
      if (execution.status !== "running" || execution.windowId === null) {
        storage.close();
        return false;
      }
      const task =
        item.taskId === null
          ? null
          : storage.business.getTask(roleId, item.taskId);
      if (task !== null && task.status !== "active") {
        storage.close();
        return false;
      }
      const pendingMessages = store.listClaimedMessages(execution.executionId);
      const activity =
        this.autonomy?.getActivityByExecution(roleId, execution.executionId) ??
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
      this.running.set(roleId, controller);
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
        now: this.now().toISOString(),
      });
      controller.promise = this.runExecution({
        storage,
        store,
        running: controller,
        execution,
        pendingMessages,
        taskId: task?.taskId ?? null,
        autonomy: autonomyContext,
        resume: true,
      })
        .catch(() => {
          // runExecution 内部已保存失败／中断状态，这里只防止未处理的 Promise。
        })
        .finally(() => {
          if (
            this.running.get(roleId)?.executionId ===
            execution.executionId
          ) {
            this.running.delete(roleId);
          }
          this.detached.delete(controller);
          void this.schedule(roleId);
        });
      return true;
    } catch {
      storage?.close();
      return false;
    }
  }

  private fallbackFromResume(
    roleId: string,
    item: ResumableExecution,
  ): boolean {
    try {
      this.withConversationStore(roleId, (store) => {
        if (store.getExecution(item.execution.executionId).status !== "running") {
          return;
        }
        const now = this.now().toISOString();
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
    if (
      item.taskId !== null &&
      item.taskStatus === "active" &&
      item.taskOrigin === "autonomous"
    ) {
      this.queueTaskContinuation(roleId, {
        taskId: item.taskId,
        windowId: item.windowId,
      });
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.wakeTimers.values()) {
      clearTimeout(timer);
    }
    this.wakeTimers.clear();
    this.dueWakeChecks.clear();
    for (const cleanup of [...this.activeStreams]) {
      cleanup();
    }
    this.inputStates.close();
    const active = [...this.running.values(), ...this.detached];
    for (const running of active) {
      running.superseded = true;
      running.controller.abort();
    }
    await Promise.allSettled(active.map((running) => running.promise));
    const backgroundSettles = [...this.backgroundToolSettles];
    if (backgroundSettles.length > 0) {
      await Promise.allSettled(backgroundSettles);
    }
    const catalogs = [...this.taskCatalogs.values()];
    this.taskCatalogs.clear();
    await Promise.allSettled(catalogs.map((entry) => entry.catalog.close()));
    await this.memoryRuntime?.close();
  }

  private schedule(roleId: string): boolean {
    const started = this.scheduleInternal(roleId);
    this.armWakeTimer(roleId);
    return started;
  }

  private scheduleInternal(roleId: string): boolean {
    if (this.closed || this.running.has(roleId)) {
      return false;
    }
    let pending: ReturnType<ConversationStore["listPendingWindows"]>;
    try {
      pending = this.withConversationStore(roleId, (store) =>
        store.listPendingWindows(),
      );
    } catch {
      return false;
    }
    const target = pending.find(
      (window) => !this.blockedWindows.has(windowKey(roleId, window.windowId)),
    );
    const pendingTaskId = target
      ? this.withConversationStore(roleId, (store) =>
          store.findInterruptedUserTask(target.windowId),
        )
      : null;
    if (target && (
      this.bindings.hasChatBinding(roleId) ||
      (pendingTaskId !== null && this.bindings.hasChatForTask(roleId, pendingTaskId))
    )) {
      if (this.inputStates.isTyping(roleId, target.windowId)) {
        return true;
      }
      return this.startExecution(roleId, target.windowId);
    }
    const continuation = this.pendingContinuations.get(roleId)?.[0];
    if (continuation) {
      return this.startTaskContinuation(roleId, continuation);
    }
    return this.startDueAutonomy(roleId);
  }

  private armWakeTimer(roleId: string): void {
    const existing = this.wakeTimers.get(roleId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.wakeTimers.delete(roleId);
    }
    if (this.closed || this.autonomy === null || this.running.has(roleId)) {
      return;
    }
    let next;
    try {
      next = this.autonomy.nextPendingWake(roleId);
    } catch {
      return;
    }
    if (next === null) {
      this.dueWakeChecks.delete(roleId);
      return;
    }
    if (!this.canStartAutonomyWake(roleId, next)) {
      return;
    }
    const due = Date.parse(next.scheduledAt);
    if (Number.isNaN(due)) {
      return;
    }
    const remaining = due - this.now().getTime();
    const dueKey = `${next.wakeId}\u0000${next.scheduledAt}`;
    if (remaining <= 0) {
      if (this.dueWakeChecks.get(roleId) === dueKey) {
        return;
      }
      this.dueWakeChecks.set(roleId, dueKey);
    } else {
      this.dueWakeChecks.delete(roleId);
    }
    const delay = Math.min(
      Math.max(0, remaining),
      2_147_483_647,
    );
    const timer = setTimeout(() => {
      this.wakeTimers.delete(roleId);
      void this.schedule(roleId);
    }, delay);
    timer.unref?.();
    this.wakeTimers.set(roleId, timer);
  }

  runDueAutonomy(roleId: string): boolean {
    const started = this.schedule(roleId);
    return started && this.running.get(roleId)?.autonomous === true;
  }

  refreshWakeTimer(roleId: string): void {
    this.armWakeTimer(roleId);
  }

  private canStartAutonomyWake(
    roleId: string,
    wake: AutonomyWakeRecord,
  ): boolean {
    if (this.bindings.hasChatBinding(roleId)) {
      return true;
    }
    if (wake.taskId !== null) {
      return this.bindings.hasChatForTask(roleId, wake.taskId);
    }
    return false;
  }

  private grantTaskResources(
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
        return this.appStore.getResource(item.resourceId).kind === "model";
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
        resource = this.appStore.getResource(binding.resourceId);
      } catch {
        continue;
      }
      if (!resource.enabled) {
        continue;
      }
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
    if (this.autonomy === null) {
      return false;
    }
    const due = this.autonomy.dueWake(roleId);
    if (due === null || !this.canStartAutonomyWake(roleId, due)) {
      return false;
    }
    let storage: RoleStorage | null = null;
    try {
      this.roleAccess.requireReady(roleId);
      storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
      const window = storage.business.getOrCreateWindow({
        roleId,
        kind: "custom",
        source: "nowadays-autonomy",
      });
      const begun = this.autonomy.beginDueWake(roleId, window.windowId);
      if (!begun) {
        storage.close();
        return false;
      }
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.timeZone,
      );
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
      this.running.set(roleId, controller);
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
        now: this.now().toISOString(),
      });
      controller.promise = this.runExecution({
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
        .catch(() => {
          // runExecution 内部已保存失败／暂停状态，这里只防止未处理的 Promise。
        })
        .finally(() => {
          if (
            this.running.get(roleId)?.executionId ===
            begun.execution.executionId
          ) {
            this.running.delete(roleId);
          }
          this.detached.delete(controller);
          void this.schedule(roleId);
        });
      return true;
    } catch {
      storage?.close();
      return false;
    }
  }

  private startTaskContinuation(
    roleId: string,
    continuation: PendingTaskContinuation,
  ): boolean {
    let storage: RoleStorage | null = null;
    try {
      this.roleAccess.requireReady(roleId);
      storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.timeZone,
      );
      const execution = store.beginTaskContinuation({
        taskId: continuation.taskId,
        windowId: continuation.windowId,
        now: this.now().toISOString(),
      });
      this.removePendingContinuation(roleId, continuation.taskId);
      if (!execution) {
        storage.close();
        void this.closeTaskCatalog(continuation.taskId);
        return false;
      }
      const task = storage.business.getTask(roleId, continuation.taskId);
      const autonomous = task.origin === "autonomous";
      let autonomyContext: AutonomyExecutionContext | null = null;
      if (autonomous) {
        const activity =
          this.autonomy?.getLatestActivityByTask(roleId, task.taskId) ?? null;
        if (activity !== null && activity.status === "paused") {
          this.autonomy?.updateActivity(roleId, {
            activityId: activity.activityId,
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
      this.running.set(roleId, controller);
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
        now: this.now().toISOString(),
      });
      controller.promise = this.runExecution({
        storage,
        store,
        running: controller,
        execution,
        pendingMessages: [],
        taskId: continuation.taskId,
        autonomy: autonomyContext,
      })
        .catch(() => {
          // runExecution 内部已保存失败／中断状态，这里只防止未处理的 Promise。
        })
        .finally(() => {
          if (
            this.running.get(roleId)?.executionId === execution.executionId
          ) {
            this.running.delete(roleId);
          }
          this.detached.delete(controller);
          void this.schedule(roleId);
        });
      return true;
    } catch {
      this.removePendingContinuation(roleId, continuation.taskId);
      storage?.close();
      void this.closeTaskCatalog(continuation.taskId);
      return false;
    }
  }

  private queueTaskContinuation(
    roleId: string,
    continuation: PendingTaskContinuation,
  ): void {
    const list = this.pendingContinuations.get(roleId) ?? [];
    const existing = list.find(
      (item) => item.taskId === continuation.taskId,
    );
    if (existing) {
      existing.windowId = continuation.windowId;
    } else {
      list.push(continuation);
    }
    this.pendingContinuations.set(roleId, list);
  }

  private removePendingContinuation(roleId: string, taskId: string): void {
    const list = this.pendingContinuations.get(roleId);
    if (list === undefined) {
      return;
    }
    const next = list.filter((item) => item.taskId !== taskId);
    if (next.length === 0) {
      this.pendingContinuations.delete(roleId);
    } else {
      this.pendingContinuations.set(roleId, next);
    }
  }

  private closeTaskCatalog(taskId: string): Promise<void> {
    const entry = this.taskCatalogs.get(taskId);
    if (entry === undefined) {
      return Promise.resolve();
    }
    this.taskCatalogs.delete(taskId);
    return entry.catalog.close();
  }

  private startExecution(roleId: string, windowId: string): boolean {
    let storage: RoleStorage | null = null;
    try {
      this.roleAccess.requireReady(roleId);
      storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.timeZone,
      );
      const begun = store.beginExecution({
        windowId,
        now: this.now().toISOString(),
      });
      if (!begun) {
        storage.close();
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
      this.running.set(roleId, controller);
      store.appendStreamEvent({
        windowId,
        executionId: begun.execution.executionId,
        type: "execution_started",
        payload: {
          executionId: begun.execution.executionId,
          windowId,
          triggerType: begun.execution.triggerType,
          messageIds: begun.messages.map((message) => message.messageId),
        },
        now: this.now().toISOString(),
      });
      controller.promise = this.runExecution({
        storage,
        store,
        running: controller,
        execution: begun.execution,
        pendingMessages: begun.messages,
        taskId: begun.taskId,
      })
        .catch(() => {
          // runExecution 内部已保存失败／中断状态，这里只防止未处理的 Promise。
        })
        .finally(() => {
          if (this.running.get(roleId)?.executionId === begun.execution.executionId) {
            this.running.delete(roleId);
          }
          this.detached.delete(controller);
          void this.schedule(roleId);
        });
      return true;
    } catch {
      storage?.close();
      return false;
    }
  }

  private async runExecution(input: {
    storage: RoleStorage;
    store: ConversationStore;
    running: RunningExecution;
    execution: ExecutionRecord;
    pendingMessages: ClaimedMessage[];
    taskId?: string | null;
    autonomy?: AutonomyExecutionContext | null;
    resume?: boolean;
  }): Promise<void> {
    const { storage, store, running, execution, pendingMessages } = input;
    const roleId = execution.roleId;
    const windowId = execution.windowId ?? running.windowId;
    const autonomy = input.autonomy ?? null;
    // 续行计量按原任务来源（DL-110）：唤醒接回的用户任务仍是用户任务，
    // 不消耗自主点数；只有自主任务继续受自主额度控制。
    const taskOrigin =
      input.taskId === null || input.taskId === undefined
        ? null
        : storage.business.getTask(roleId, input.taskId).origin;
    const purpose: "user_chat" | "autonomous" =
      taskOrigin === "user"
        ? "user_chat"
        : taskOrigin === "autonomous"
          ? "autonomous"
          : autonomy === null
            ? "user_chat"
            : "autonomous";
    const meter =
      purpose !== "autonomous" || this.autonomy === null
        ? null
        : {
            consume: (): boolean => {
              const budget = this.autonomy!.consumePoint(roleId);
              if (budget.exhausted) {
                throw new AutonomyBudgetExhaustedError(
                  roleId,
                  budget.budget.dailyLimit,
                  budget.budget.usedPoints,
                );
              }
              return budget.counted;
            },
            reserveTool: (toolCallId: string) => {
              const autonomyService = this.autonomy!;
              const reserved = autonomyService.reserveToolPoint(
                roleId,
                toolCallId,
              );
              let settled = false;
              const reservation = {
                counted: reserved.counted,
                committed: false,
                commit: (): void => {
                  if (settled) {
                    return;
                  }
                  const committed = autonomyService.commitToolReservation(
                    roleId,
                    toolCallId,
                  );
                  reservation.counted = committed.found
                    ? committed.counted
                    : false;
                  settled = true;
                  reservation.committed = true;
                },
                cancel: (): void => {
                  if (settled) {
                    return;
                  }
                  settled = true;
                  autonomyService.releaseToolReservation(roleId, toolCallId);
                },
              };
              return reservation;
            },
          };
    let catalog: AgentToolCatalog | null = null;
    let saver: SqliteSaver | null = null;
    let pausedForBudget = false;
    let pausedByDecision = false;
    let backgroundedTool = false;
    let taskId: string | null = input.taskId ?? null;
    const checkRunning = (): void => {
      if (running.superseded || running.controller.signal.aborted) {
        throw new ExecutionSupersededError(execution.executionId);
      }
      const current = store.getExecution(execution.executionId);
      if (current.status !== "running") {
        throw new ExecutionSupersededError(execution.executionId);
      }
    };
    const checkDispatch = (): void => {
      if (
        !backgroundedTool ||
        running.superseded ||
        running.controller.signal.aborted
      ) {
        checkRunning();
        const currentTaskId = taskId;
        if (currentTaskId !== null) {
          let status: string;
          try {
            status = storage.business.getTask(roleId, currentTaskId).status;
          } catch {
            status = "missing";
          }
          if (status !== "active") {
            throw new TaskEndedError(currentTaskId, status);
          }
        }
        return;
      }
      const backgroundTaskId = taskId;
      if (backgroundTaskId === null) {
        throw new ExecutionSupersededError(execution.executionId);
      }
      // 工具已转后台时原存储句柄随执行收尾关闭；派发前用新句柄核对
      // 任务是否仍活跃，避免在已释放的连接上判定而丢弃可执行的调用。
      this.roleAccess.withStore(roleId, (fresh) => {
        let status: string;
        try {
          status = fresh.business.getTask(roleId, backgroundTaskId).status;
        } catch {
          status = "missing";
        }
        if (status !== "active") {
          throw new TaskEndedError(backgroundTaskId, status);
        }
      });
    };
    const emitDelta = (text: string): void => {
      checkRunning();
      running.partialText += text;
      store.appendMessageDelta({
        windowId,
        executionId: execution.executionId,
        text,
        now: this.now().toISOString(),
      });
    };
    try {
      const continuationResourceIds =
        input.taskId !== null &&
        input.taskId !== undefined
          ? this.grantTaskResources(storage, roleId, input.taskId)
          : [];
      const cachedCatalog =
        input.taskId === null || input.taskId === undefined
          ? undefined
          : this.taskCatalogs.get(input.taskId);
      // 续行仍属原任务链，沿用已取得的模型；开关仅限制新任务。
      const initialBinding =
        cachedCatalog?.roleId === roleId
          ? cachedCatalog.modelBinding
          : input.taskId !== null &&
              input.taskId !== undefined
            ? (this.bindings.resolveChatForTask(roleId, input.taskId) ??
              this.bindings.resolveChat(roleId))
            : this.bindings.resolveChat(roleId);
      const resolveModel = (): AgentModelHandle => {
        const binding = this.bindings.refresh(initialBinding, roleId);
        return {
          model: this.modelFactory(binding),
          resourceId: binding.resourceId,
          modelName: binding.modelName,
          protocol: binding.config.protocol,
        };
      };
      const recent = store.listRecentMessages(windowId, 30);
      const continuationTask =
        input.taskId === null ||
        input.taskId === undefined ||
        (autonomy !== null && !autonomy.resumed)
          ? null
          : storage.business.getTask(roleId, input.taskId);
      const recall = this.autoRecall(
        roleId,
        execution.executionId,
        pendingMessages,
        recent,
        autonomy?.intent ?? continuationTask?.goal ?? "",
      );
      if (
        cachedCatalog !== undefined &&
        cachedCatalog.roleId === roleId
      ) {
        catalog = cachedCatalog.catalog;
      } else {
        catalog = await loadAgentTools({
          roleId,
          appStore: this.appStore,
          roleAccess: this.roleAccess,
          memory: this.memory,
          autonomy: this.autonomy,
          allowAutonomyShare: autonomy !== null,
          continuationResourceIds,
          appRoot: this.appRoot,
          workspaceDir: storage.paths.workspaceDir,
        });
        if (input.taskId !== null && input.taskId !== undefined) {
          this.taskCatalogs.set(input.taskId, {
            roleId,
            catalog,
            modelBinding: initialBinding,
          });
        }
      }
      const systemPrompt = (): string =>
        this.buildSystemPrompt({
          roleContext: store.getRoleContext(),
          recallBriefs: recall.briefs,
          recallWarning: recall.warning,
          skillBriefs: catalog?.skillBriefs ?? [],
          warnings: catalog?.warnings ?? [],
          tools: catalog?.tools ?? [],
          pendingMessages,
          taskBrief: this.buildTaskBrief(storage, roleId, taskId),
          continuation:
            continuationTask === null
              ? null
              : {
                  taskId: continuationTask.taskId,
                  goal: continuationTask.goal,
                },
          autonomy:
            autonomy === null
              ? null
              : {
                  intent: autonomy.intent,
                  resumed: autonomy.resumed,
                },
        });
      const ensureTask = (): string => {
        if (taskId !== null) {
          return taskId;
        }
        const goal = pendingMessages
          .map((message) => message.content)
          .join("\n")
          .slice(0, 500);
        const task = storage.business.createTask({
          roleId,
          goal: goal.length > 0 ? goal : "本轮对话",
          origin: "user",
          initiatorExecutionId: execution.executionId,
        });
        storage.business.linkExecutionTask({
          roleId,
          executionId: execution.executionId,
          taskId: task.taskId,
          relation: "initiates",
        });
        // 用户任务与自主任务使用同一条链资源延续规则，授权需跨进程保存。
        this.grantTaskResources(storage, roleId, task.taskId);
        if (catalog !== null) {
          this.taskCatalogs.set(task.taskId, {
            roleId,
            catalog,
            modelBinding: initialBinding,
          });
        }
        taskId = task.taskId;
        return taskId;
      };
      const messages = [
        ...this.buildMessages(recent, pendingMessages),
        ...(continuationTask === null
          ? []
          : this.buildContinuationToolMessages(
              storage,
              roleId,
              continuationTask.taskId,
            )),
      ];
      saver = SqliteSaver.fromConnString(storage.paths.executionDatabasePath);
      const runner = new AgentGraphRunner(
        {
          store,
          roleStore: storage.business,
          resolveModel,
          tools: catalog.tools,
          systemPrompt,
          signal: running.controller.signal,
          checkRunning,
          checkDispatch,
          emitDelta,
          ensureTask,
          now: this.now,
          maxToolRounds: this.maxToolRounds,
          purpose,
          meter,
          toolForegroundWaitMs: this.toolForegroundWaitMs,
          onBackgroundToolSettled: (settlement) =>
            this.handleBackgroundToolSettled(settlement),
          onToolBackgrounded: () => {
            backgroundedTool = true;
          },
          registerBackgroundTool: (settlement, roleId) => {
            this.backgroundToolSettles.add(settlement);
            this.backgroundToolsByRole.set(
              roleId,
              (this.backgroundToolsByRole.get(roleId) ?? 0) + 1,
            );
            void settlement.then(() => {
              this.backgroundToolSettles.delete(settlement);
              const remaining = (this.backgroundToolsByRole.get(roleId) ?? 1) - 1;
              if (remaining <= 0) {
                this.backgroundToolsByRole.delete(roleId);
              } else {
                this.backgroundToolsByRole.set(roleId, remaining);
              }
            });
          },
        },
        saver,
      );
      const result = await runner.run({
        executionId: execution.executionId,
        roleId,
        windowId,
        messages,
        taskId,
        resume: input.resume === true,
      });
      checkRunning();
      if (result.text.trim().length === 0) {
        throw new ModelRequestFailedError("模型没有产生可保存的回复文字", {
          reason: "EMPTY_RESPONSE",
        });
      }
      const taskDecision =
        result.taskId === null
          ? null
          : toCommittedTaskDecision(result.taskId, result.taskAction);
      store.commitConversation({
        executionId: execution.executionId,
        content: result.text,
        statePatch: result.statePatch,
        countsAsConversationRound: autonomy === null,
        taskDecision,
        now: this.now().toISOString(),
      });
      if (result.taskId !== null && taskDecision !== null) {
        taskId = result.taskId;
        this.applyCommittedTaskDecision(storage, roleId, taskDecision, () => {
          pausedByDecision = true;
        });
      }
      if (autonomy !== null) {
        try {
          if (autonomy.activityId !== null) {
            this.autonomy?.updateActivity(roleId, {
              activityId: autonomy.activityId,
              status: "completed",
              summary: truncate(result.text, 2000),
            });
          }
          if (autonomy.wakeId !== null) {
            this.autonomy?.completeWake(roleId, autonomy.wakeId);
          }
        } catch {
          // 活动记录失败不覆盖已提交的回复。
        }
      }
      this.memoryRuntime?.notifyEvidence(roleId);
      if (taskId !== null && taskDecision?.action.kind !== "pause") {
        this.memoryRuntime?.notifyTaskFinished(roleId, taskId);
      }
    } catch (error) {
      let status: ExecutionRecord["status"] | null = null;
      try {
        status = store.getExecution(execution.executionId).status;
      } catch {
        status = null;
      }
      if (status === "running" && !running.superseded) {
        const code = errorCodeOf(error);
        if (code === "TOOL_BACKGROUNDED") {
          // 慢工具转后台：释放决策位置，工具继续在后台执行；
          // 不结束任务、不拉黑窗口、不动活动与唤醒；
          // 用户消息保持领取状态，由原任务续行接手。
          try {
            store.interruptExecution({
              executionId: execution.executionId,
              partialText: running.partialText,
              status: "superseded",
              reason: code,
              errorCode: code,
              keepClaimedMessages: true,
              now: this.now().toISOString(),
            });
          } catch {
            // 状态已由其他路径改变，保留已有事件。
          }
          backgroundedTool = true;
        } else if (code === "AUTONOMY_BUDGET_EXHAUSTED" && autonomy !== null) {
          pausedForBudget = true;
          try {
            store.interruptExecution({
              executionId: execution.executionId,
              partialText: running.partialText,
              status: "paused",
              reason: code,
              errorCode: code,
              now: this.now().toISOString(),
            });
          } catch {
            // 状态已由其他路径改变，保留已有事件。
          }
          try {
            if (taskId !== null) {
              this.autonomy?.pauseForBudget(roleId, {
                taskId,
                activityId: autonomy.activityId,
                wakeId: autonomy.wakeId,
              });
            }
          } catch {
            // 暂停安排失败时保留已保存的执行暂停状态，可人工处理。
          }
          this.memoryRuntime?.notifyEvidence(roleId);
        } else {
          try {
            store.interruptExecution({
              executionId: execution.executionId,
              partialText: running.partialText,
              status: "failed",
              reason: code,
              errorCode: code,
              now: this.now().toISOString(),
            });
          } catch {
            // 状态已由其他路径改变，保留已有事件。
          }
          this.blockedWindows.add(windowKey(roleId, windowId));
          if (taskId !== null && code !== "TASK_ENDED") {
            this.finishTaskAfterExecution(
              storage,
              roleId,
              taskId,
              "failed",
              code,
            );
            this.memoryRuntime?.notifyTaskFinished(roleId, taskId);
          }
          if (autonomy !== null) {
            try {
              if (autonomy.activityId !== null) {
                this.autonomy?.updateActivity(roleId, {
                  activityId: autonomy.activityId,
                  status: "failed",
                });
              }
              if (autonomy.wakeId !== null) {
                this.autonomy?.completeWake(roleId, autonomy.wakeId, code);
              }
            } catch {
              // 活动记录失败不覆盖执行失败状态。
            }
          }
          this.memoryRuntime?.notifyEvidence(roleId);
        }
      }
    } finally {
      let keepCatalog = false;
      if (running.superseded && taskId !== null) {
        try {
          if (storage.business.getTask(roleId, taskId).status === "active") {
            this.queueTaskContinuation(roleId, {
              taskId,
              windowId,
            });
            keepCatalog = true;
          }
        } catch {
          // 任务已结束或不可读时不再安排继续执行。
        }
      }
      if (!keepCatalog && pausedForBudget && taskId !== null) {
        try {
          keepCatalog =
            storage.business.getTask(roleId, taskId).status === "paused";
        } catch {
          keepCatalog = false;
        }
      }
      if (!keepCatalog && pausedByDecision && taskId !== null) {
        try {
          keepCatalog =
            storage.business.getTask(roleId, taskId).status === "paused";
        } catch {
          keepCatalog = false;
        }
      }
      if (!keepCatalog && backgroundedTool && taskId !== null) {
        // 转后台后任务仍活跃时保住任务目录，供结果结算后的续行复用。
        try {
          keepCatalog =
            storage.business.getTask(roleId, taskId).status === "active";
        } catch {
          keepCatalog = false;
        }
      }
      if (!keepCatalog) {
        await catalog?.close();
        if (taskId !== null) {
          this.taskCatalogs.delete(taskId);
        }
      }
      saver?.db.close();
      storage.close();
    }
  }

  /**
   * 转后台的工具在后台结算（真实结果产生）后的入口：
   * 用独立存储句柄保存结果、结算计量并追加流事件，
   * 任务仍活跃时把真实结果交回原任务续行。
   */
  private handleBackgroundToolSettled(settlement: BackgroundToolSettlement): void {
    try {
      this.roleAccess.withStore(settlement.roleId, (storage) => {
        const business = storage.business;
        business.saveToolResult({
          roleId: settlement.roleId,
          toolCallId: settlement.toolCallId,
          status: settlement.outcome.status,
          ...(settlement.outcome.rawResponse === undefined
            ? {}
            : { rawResponse: settlement.outcome.rawResponse }),
          ...(settlement.outcome.adaptedResult === undefined
            ? {}
            : { adaptedResult: settlement.outcome.adaptedResult }),
          ...(settlement.outcome.diagnosticCode === undefined
            ? {}
            : { diagnosticCode: settlement.outcome.diagnosticCode }),
          ...(settlement.outcome.error === undefined
            ? {}
            : { error: settlement.outcome.error }),
        });
        const shouldRecordMetering =
          settlement.purpose !== "autonomous" || settlement.committed;
        if (shouldRecordMetering) {
          new ConversationStore(storage.business.db, settlement.roleId, this.timeZone).recordToolMetering({
            executionId: settlement.executionId,
            taskId: settlement.taskId,
            toolCallId: settlement.toolCallId,
            purpose: settlement.purpose,
            counted: settlement.counted,
            now: this.now().toISOString(),
          });
        }
        if (settlement.windowId !== null) {
          new ConversationStore(storage.business.db, settlement.roleId, this.timeZone).appendStreamEvent({
            windowId: settlement.windowId,
            executionId: settlement.executionId,
            type: "tool_result_saved",
            payload: {
              executionId: settlement.executionId,
              toolCallId: settlement.toolCallId,
              status: settlement.outcome.status,
              background: true,
            },
            now: this.now().toISOString(),
          });
        }
      });
    } catch {
      // 后台结算失败时保留执行侧的恢复路径：重启后按中断调用补录 unknown。
      return;
    }
    if (this.closed || settlement.taskId === null || settlement.windowId === null) {
      return;
    }
    try {
      const task = this.roleAccess.withStore(settlement.roleId, (storage) =>
        storage.business.getTask(settlement.roleId, settlement.taskId!),
      );
      if (task.status !== "active") {
        return;
      }
    } catch {
      return;
    }
    this.queueTaskContinuation(settlement.roleId, {
      taskId: settlement.taskId,
      windowId: settlement.windowId,
    });
    // 结算回调由工具 promise 的延续触发，仍处在原图执行的异步上下文中；
    // LangChain 的隐式配置会沿异步上下文继承，直接调度会让新执行读到旧执行
    // 的检查点配置（旧 saver 已关闭）。延迟到独立宏任务并在干净上下文中调度。
    const deferredRoleId = settlement.roleId;
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      const deferred = setTimeout(() => {
        void this.schedule(deferredRoleId);
      }, 0);
      deferred.unref?.();
    });
  }

  private applyCommittedTaskDecision(
    storage: RoleStorage,
    roleId: string,
    decision: CommitConversationTaskDecision,
    onPause?: () => void,
  ): void {
    if (decision.action.kind === "pause") {
      onPause?.();
      try {
        // 暂停保留原任务编号与资源延续，等待唤醒或后续轮次接回。
        storage.business.pauseTask({
          roleId,
          taskId: decision.taskId,
          endReason: decision.action.reason,
        });
      } catch {
        // 决定已随回复提交；写入失败时任务保持原状，重启按原决定恢复。
      }
      return;
    }
    // 角色按真实结果结束任务；经历整理由调用方 notifyTaskFinished 触发。
    this.finishTaskAfterExecution(
      storage,
      roleId,
      decision.taskId,
      decision.action.status,
      decision.action.endReason,
    );
  }

  private finishTaskAfterExecution(
    storage: RoleStorage,
    roleId: string,
    taskId: string,
    status: "completed" | "failed",
    endReason: string,
  ): void {    try {
      storage.business.finishTask({ roleId, taskId, status, endReason });
      for (const continuation of storage.business.listResourceContinuations(
        roleId,
        taskId,
      )) {
        if (continuation.endedAt === null) {
          storage.business.endResourceContinuation({
            roleId,
            taskId,
            resourceId: continuation.resourceId,
          });
        }
      }
      this.autonomy?.cancelPendingBudgetResumes(
        roleId,
        taskId,
        "TASK_ENDED",
      );
    } catch {
      // 结束任务失败不覆盖已提交的回复或工具结果。
    }
  }

  private autoRecall(
    roleId: string,
    executionId: string,
    pendingMessages: readonly ClaimedMessage[],
    recent: readonly ConversationMessageView[],
    extraQuery = "",
  ): { briefs: RecallBrief[]; warning: string | null } {
    const recentText = recent
      .slice(-4)
      .map((message) => message.content)
      .join("\n");
    const query =
      `${pendingMessages.map((message) => message.content).join("\n")}\n${extraQuery}\n${recentText}`
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
    const dates = extractDateRange(query, this.now(), this.timeZone);
    try {
      const result = this.memory.search(
        roleId,
        {
          ...(query.length === 0 ? {} : { query }),
          types: ["event", "daily_summary", "diary"],
          ...dates,
          limit: this.autoRecallLimit,
        },
        { mode: "auto", executionId },
      );
      return {
        briefs: result.items.map((item) => ({
          type: item.type,
          id: item.id,
          title: item.title,
          snippet: item.snippet,
        })),
        warning: null,
      };
    } catch (error) {
      return {
        briefs: [],
        warning:
          error instanceof AppError
            ? error.code
            : "MEMORY_QUERY_FAILED",
      };
    }
  }

  private buildMessages(
    recent: readonly ConversationMessageView[],
    pendingMessages: readonly ClaimedMessage[],
  ): import("../domain/model.js").ModelMessage[] {
    const messages: import("../domain/model.js").ModelMessage[] = [];
    const included = new Set<string>();
    for (const message of recent) {
      if (message.status === "generating") {
        continue;
      }
      included.add(message.messageId);
      if (message.sender === "user") {
        messages.push({ role: "user", content: message.content });
      } else {
        messages.push({
          role: "assistant",
          content:
            message.status === "interrupted"
              ? `${message.content}\n[以上回复中断，未完成]`
              : message.content,
        });
      }
    }
    for (const pending of pendingMessages) {
      if (!included.has(pending.messageId)) {
        messages.push({ role: "user", content: pending.content });
      }
    }
    return messages;
  }

  private buildContinuationToolMessages(
    storage: RoleStorage,
    roleId: string,
    taskId: string,
  ): import("../domain/model.js").ModelMessage[] {
    const messages: import("../domain/model.js").ModelMessage[] = [];
    for (const call of storage.business.listTaskToolCalls(roleId, taskId)) {
      let result: ReturnType<RoleStore["getToolResult"]>;
      try {
        result = storage.business.getToolResult(roleId, call.toolCallId);
      } catch {
        continue;
      }
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            callId: call.toolCallId,
            name: call.toolName,
            arguments: call.args,
          },
        ],
      });
      messages.push({
        role: "tool",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        content: JSON.stringify({
          status: result.status,
          ...(result.diagnosticCode === null
            ? {}
            : { diagnosticCode: result.diagnosticCode }),
          result: result.adaptedResult ?? null,
        }),
      });
    }
    const internal = new ConversationStore(storage.business.db, roleId, this.timeZone)
      .listTaskInternalToolFacts(taskId);
    for (const fact of internal) {
      messages.push({
        role: "assistant",
        content: `原任务已保存的内部操作记录：${truncate(JSON.stringify(fact), 8000)}`,
      });
    }
    return messages;
  }

  /** 汇总当前任务的目标、状态、已保存调用与进度笔记，供角色决策任务收尾。 */
  private buildTaskBrief(
    storage: RoleStorage,
    roleId: string,
    taskId: string | null,
  ): {
    taskId: string;
    goal: string;
    status: string;
    origin: string;
    toolCalls: Array<{ name: string; status: string }>;
    notes: string[];
  } | null {
    if (taskId === null) {
      return null;
    }
    try {
      const task = storage.business.getTask(roleId, taskId);
      const calls = storage.business
        .listTaskToolCalls(roleId, taskId)
        .slice(-10)
        .map((call) => ({ name: call.toolName, status: call.status }));
      const notes = storage.business
        .listTaskNotes(roleId, taskId)
        .slice(-5)
        .map((note) => note.note);
      return {
        taskId: task.taskId,
        goal: task.goal,
        status: task.status,
        origin: task.origin,
        toolCalls: calls,
        notes,
      };
    } catch {
      return null;
    }
  }

  private buildSystemPrompt(input: {
    roleContext: ReturnType<ConversationStore["getRoleContext"]>;
    recallBriefs: readonly RecallBrief[];
    recallWarning: string | null;
    skillBriefs: readonly SkillBrief[];
    warnings: readonly string[];
    tools: readonly ConversationTool[];
    pendingMessages: readonly ClaimedMessage[];
    taskBrief: {
      taskId: string;
      goal: string;
      status: string;
      origin: string;
      toolCalls: Array<{ name: string; status: string }>;
      notes: string[];
    } | null;
    continuation: { taskId: string; goal: string } | null;
    autonomy: { intent: string; resumed: boolean } | null;
  }): string {
    const lines = [
      `你是角色「${input.roleContext.displayName}」，始终以该角色的身份、经历和当前状态回应。`,
      "以下角色设定是长期身份依据：",
      truncate(input.roleContext.definitionText, 12_000),
    ];
    const payload = JSON.stringify(input.roleContext.definitionPayload);
    if (payload !== undefined && payload !== "{}") {
      lines.push(`设定附加信息：${truncate(payload, 4000)}`);
    }
    lines.push(
      `当前状态（版本 ${input.roleContext.stateVersion}）：${truncate(
        JSON.stringify(input.roleContext.state),
        6000,
      )}`,
      `当前时间：${this.now().toISOString()}`,
    );
    if (input.autonomy === null) {
      lines.push(
        "本轮用户已发送的消息已按顺序放在对话历史中；同一窗口的多条未处理消息应共同判断和回应。",
      );
    }
    if (input.pendingMessages.length > 1) {
      lines.push(`本轮共同处理的用户消息数：${input.pendingMessages.length}。`);
    }
    if (input.continuation !== null) {
      lines.push(
        `当前执行在继续原任务 ${input.continuation.taskId}，任务目标：${truncate(
          input.continuation.goal,
          1000,
        )}。`,
        "原任务已完成的工具调用和真实结果已附在对话历史中；不要重做已成功步骤，不要续写被中断的回复，按最新上下文继续推进原目标。",
      );
    }
    if (input.taskBrief !== null && input.taskBrief.status === "active") {
      lines.push(
        `当前任务（taskId=${input.taskBrief.taskId}）：目标「${truncate(
          input.taskBrief.goal,
          500,
        )}」，状态 ${input.taskBrief.status}，来源 ${input.taskBrief.origin}。`,
      );
      if (input.taskBrief.toolCalls.length > 0) {
        const callSummary = input.taskBrief.toolCalls
          .map((call) => `${call.name}(${call.status})`)
          .join("、");
        lines.push(`本任务已保存的工具调用（最近）：${callSummary}。`);
      }
      if (input.taskBrief.notes.length > 0) {
        lines.push("任务进度笔记：");
        for (const note of input.taskBrief.notes) {
          lines.push(`- ${truncate(note, 300)}`);
        }
      }
      lines.push(
        "任务决策：默认情况下回复完成后任务按「回复完成」结束；如果目标尚未完成、本轮只想先回复或需要延后处理，调用 task_pause 暂停任务（可用 autonomy_schedule 携带本任务编号安排唤醒，唤醒会接回同一任务继续）；如果任务已达成或确认失败，调用 task_finish 声明 completed 或 failed 及结束原因。",
      );
    }
    if (input.autonomy !== null) {
      lines.push(
        "这是一次自主活动：你按自己的安排醒来，不是用户刚发来新消息。",
        `本次自主安排的目标：${truncate(input.autonomy.intent, 2000)}`,
        "可以实际使用已启用工具做事并保存真实成果；需要时调用 autonomy_share 主动分享到主对话，或调用 autonomy_schedule 安排下一次，也可以不调用工具。",
        "不要虚构用户发言、离线经历或未实际发生的工具结果。",
      );
      if (input.autonomy.resumed) {
        lines.push(
          "这是额度恢复或中断后继续的自主任务；先结合最新情况与已有结果重新评估，不重复已完成操作。",
        );
      }
    }
    if (input.recallBriefs.length > 0) {
      lines.push("自动召回的相关长期记忆概况（不是完整原文）：");
      for (const brief of input.recallBriefs) {
        lines.push(
          `- [${brief.type}] ${brief.title}（id=${brief.id}）：${truncate(
            brief.snippet,
            500,
          )}`,
        );
      }
      lines.push(
        "如果需要核对细节，调用 memory_event、memory_summary、memory_evidence 或 memory_search；不要仅凭概况编造原文。",
      );
    } else {
      lines.push("本轮自动召回没有命中相关概况；未命中不代表事情从未发生，可以按需检索。");
    }
    if (input.recallWarning !== null) {
      lines.push(`自动召回本轮失败（${input.recallWarning}），不能把失败当作没有经历。`);
    }
    if (input.skillBriefs.length > 0) {
      lines.push("已启用 Skill（按需用 skill_read 读取正文或文件）：");
      for (const skill of input.skillBriefs) {
        lines.push(`- ${skill.name}：${truncate(skill.description, 300)}`);
      }
    }
    if (input.warnings.length > 0) {
      lines.push(`扩展资源提示：${input.warnings.join("；")}`);
    }
    lines.push(
      "可用工具规则：",
      "- 记忆检索成功但无结果与查询失败不同；未命中和失败都不等于事情没发生。",
      "- 外部 MCP 工具的实际调用会保存原始响应和结果；不要重复调用已经成功或结果未知的操作。",
      "- 需要更新角色当前状态时调用 state_update，补丁只在本轮正式提交时生效。",
      "- 不要声称执行了没有实际调用工具的操作，也不要编造工具结果。",
      `- 单次决策最多 ${this.maxToolRounds} 个模型／工具回合。`,
    );
    const names = input.tools.map((tool) => tool.name);
    if (names.length > 0) {
      lines.push(`可用工具：${names.join("、")}`);
    }
    return lines.join("\n");
  }

  private isIdle(roleId: string): boolean {
    if (this.running.has(roleId)) {
      return false;
    }
    if ((this.backgroundToolsByRole.get(roleId) ?? 0) > 0) {
      // 仍有转后台的工具在途：结算后可能续行，不算空闲。
      return false;
    }
    if ([...this.detached].some((running) => running.roleId === roleId)) {
      return false;
    }
    if ((this.pendingContinuations.get(roleId)?.length ?? 0) > 0) {
      return false;
    }
    try {
      const pending = this.withConversationStore(roleId, (store) =>
        store.listPendingWindows(),
      );
      return pending.every((window) =>
        this.blockedWindows.has(windowKey(roleId, window.windowId)),
      );
    } catch {
      return true;
    }
  }

  private supersedeWindow(roleId: string, windowId: string): void {
    const running = this.running.get(roleId);
    if (!running || running.superseded) {
      return;
    }
    if (running.windowId !== windowId && !running.autonomous) {
      return;
    }
    running.superseded = true;
    running.controller.abort();
    try {
      this.withConversationStore(roleId, (store) =>
        store.interruptExecution({
          executionId: running.executionId,
          partialText: running.partialText,
          status: "superseded",
          reason: "NEW_MESSAGE",
          supersededByExecutionId: null,
          now: this.now().toISOString(),
        }),
      );
    } catch {
      // 状态已被其他路径处理时保持既有事件。
    }
    if (this.running.get(roleId) === running) {
      this.running.delete(roleId);
    }
    this.detached.add(running);
  }

  private withConversationStore<T>(
    roleId: string,
    action: (store: ConversationStore) => T,
  ): T {
    this.roleAccess.requireReady(roleId);
    const storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
    try {
      return action(
        new ConversationStore(storage.business.db, roleId, this.timeZone),
      );
    } finally {
      storage.close();
    }
  }
}

function windowKey(roleId: string, windowId: string): string {
  return `${roleId}\u0000${windowId}`;
}

function toCommittedTaskDecision(
  taskId: string,
  action: AgentTaskAction | null,
): CommitConversationTaskDecision {
  if (action === null) {
    // 无显式任务决策时保持既有默认：回复完成即结束任务。
    return {
      taskId,
      action: { kind: "finish", status: "completed", endReason: "回复完成" },
    };
  }
  if (action.kind === "pause") {
    return { taskId, action: { kind: "pause", reason: action.reason } };
  }
  return {
    taskId,
    action: {
      kind: "finish",
      status: action.status,
      endReason: action.endReason,
    },
  };
}

function errorCodeOf(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "EXECUTION_FAILED";
}

function extractDateRange(
  text: string,
  now: Date,
  timeZone: string | undefined,
): { dateFrom?: string; dateTo?: string } {
  const explicit = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (explicit?.[1] !== undefined) {
    return { dateFrom: explicit[1], dateTo: explicit[1] };
  }
  const today = localDateFromIso(now.toISOString(), timeZone);
  if (text.includes("今天")) {
    return { dateFrom: today, dateTo: today };
  }
  if (text.includes("昨天")) {
    const date = shiftDate(today, -1);
    return { dateFrom: date, dateTo: date };
  }
  if (text.includes("前天")) {
    const date = shiftDate(today, -2);
    return { dateFrom: date, dateTo: date };
  }
  return {};
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function truncate(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length <= limit ? value : `${chars.slice(0, limit).join("")}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
