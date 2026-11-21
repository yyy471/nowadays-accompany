import type http from "node:http";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { rolePaths } from "../bootstrap/config.js";
import type {
  AgentRunResult,
  AgentSegmentStopKind,
  AgentTaskAction,
  BackgroundToolSettlement,
  ClaimedMessage,
  ConversationExecutionDetail,
  ConversationMessageView,
  ConversationTool,
  RecallBrief,
  SkillBrief,
  ConversationWaitReason,
} from "../domain/conversation.js";
import {
  AppError,
  AutonomyBudgetExhaustedError,
  ExecutionSupersededError,
  ModelCredentialUnavailableError,
  ModelRequestFailedError,
  RoleStopRequestedError,
  SseCursorInvalidError,
  TaskEndedError,
  TaskStateConflictError,
} from "../domain/errors.js";
import {
  ROLE_STOP_TASK_END_REASON,
  type RoleActivityGate,
} from "../domain/role-activity.js";
import type { ModelMessage, ModelPort, ModelToolCall } from "../domain/model.js";
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
  isFirstActivationWake,
  type AutonomyWakeRecord,
} from "../storage/autonomy-store.js";
import { AppearanceStore } from "../storage/appearance-store.js";
import type {
  ExecutionRecord,
  MessageRecord,
  RoleStore,
  SubmitMessageInput,
  SubmitMessageResult,
  TaskRecord,
} from "../storage/role-store.js";
import { RoleStorage } from "../storage/role-storage.js";
import { prepareModelWebReadings, readWebHistoryProjection, recordAcceptedWebReadings } from "../storage/web-reading.js";
import { matchWorldbooks } from "../domain/worldbook.js";
import { readWorldbooks, recordWorldbookUsage } from "../storage/worldbook-store.js";
import { MemoryStore } from "../storage/memory-store.js";
import {
  AgentGraphRunner,
  CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_MAX_TOOL_ROUNDS,
  type AgentModelHandle,
} from "./agent-graph.js";
import type { AgentSystemPrompt } from "./agent-context.js";
import { findAgentEvidence } from "./conversation-history.js";
import { loadAgentTools, type AgentToolCatalog } from "./agent-tools.js";
import type { AdminToolServices } from "./admin-tools.js";
import type { AutonomyService } from "./autonomy-service.js";
import type { CredentialResolver } from "./credential-resolver.js";
import { InputStateRegistry } from "./input-state.js";
import { roleCardForDialogue, roleCardPayloadForDialogue } from "./role-card-dialogue.js";
import type { MemoryQueryService } from "./memory-query-service.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import type {
  ModelBindingResolver,
  ResolvedModelBinding,
} from "./model-binding-resolver.js";
import type { ModelCallClaim } from "./model-maintenance.js";
import type { RoleAccess } from "./role-access.js";
import {
  SegmentAnnotationService,
  type SegmentAnnotationServiceOptions,
} from "./segment-annotation-service.js";

export type ChatModelPortFactory = (binding: ResolvedModelBinding) => ModelPort;

/** 外部工具前台等待窗口原型默认值；越过后自动转后台，等待时长仍待真实工具联调校准。 */
export const DEFAULT_TOOL_FOREGROUND_WAIT_MS = 2_000;
const FIRST_ACTIVATION_CREDENTIAL_RETRY_MS = 1_000;


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
  credentialResolver?: CredentialResolver;
  /** DL-148 停止边界：由 app 层注入，图中每个可保存节点都会询问。 */
  activity?: RoleActivityGate | null;
  /** 模型服务维护中：暂缓新执行与任务续行的调用领取（283 R01）。 */
  isResourceUnderMaintenance?: ((resourceId: string) => boolean) | null;
  /** 维护期间后台标注等待结束；醒来后用已保存配置重新解析（278 §2.1）。 */
  waitForMaintenanceEnd?:
    | ((resourceId: string, signal?: AbortSignal) => Promise<void>)
    | null;
  /** 角色是否仍有对话之外的在途调用（后台记忆整理）；停止确认要一起等（283 §5 R01）。 */
  hasExternalWork?: ((roleId: string) => boolean) | null;
  /** 后台标注的调用领取：维护检查与在途登记同步完成（283 §13 R01）。 */
  claimModelCall?:
    | ((roleId: string, resourceId: string) => ModelCallClaim)
    | null;
  /** 解析角色关联的全局语音服务运行态，传给后台句段标注。 */
  resolveVoiceRuntime?: SegmentAnnotationServiceOptions["resolveVoiceRuntime"];
  /** 预置默认助手（夏澄）内部管理工具依赖的应用服务（DL-159）。 */
  adminServices?: AdminToolServices | null;
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
  /** 未安排回复时的可读原因；已安排或重复找回且可调度时为 null。 */
  waitReason: ConversationWaitReason | null;
}

export class ConversationService {
  private autoScenes: import("./scene-image-service.js").SceneImageService | null = null;

  setSceneImageService(service: import("./scene-image-service.js").SceneImageService): void {
    this.autoScenes = service;
  }
  readonly inputStates: InputStateRegistry;
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private readonly autoRecallLimit: number;
  private readonly maxToolRounds: number;
  private readonly toolForegroundWaitMs: number;
  private readonly modelFactory: ChatModelPortFactory;
  private readonly usesHttpModel: boolean;
  private readonly credentials: CredentialResolver | null;
  private readonly segmentAnnotation: SegmentAnnotationService;
  private readonly memoryRuntime: MemoryRuntime | null;
  private readonly autonomy: AutonomyService | null;
  private readonly activity: RoleActivityGate | null;
  private readonly isResourceUnderMaintenance: ((resourceId: string) => boolean) | null;
  private readonly waitForMaintenanceEnd:
    | ((resourceId: string, signal?: AbortSignal) => Promise<void>)
    | null;
  private readonly hasExternalWork: (roleId: string) => boolean;
  private readonly adminServices: AdminToolServices | null;
  private readonly running = new Map<string, RunningExecution>();
  /** 正在使用某个模型服务的执行：维护等待按目标服务直接查询（283 §7 R01）。 */
  private readonly inflightResources = new Map<
    string,
    { roleId: string; resourceId: string }
  >();
  private readonly detached = new Set<RunningExecution>();
  private readonly segmentAnnotations = new Map<string, Set<Promise<void>>>();
  private readonly annotationControllers = new Set<AbortController>();
  /** 等待维护结束的标注：删除角色时可取消，不影响已经发出的调用（283 §13 R03）。 */
  private readonly annotationWaitControllers = new Map<string, Set<AbortController>>();
  private readonly backgroundToolSettles = new Set<Promise<void>>();
  private readonly backgroundToolsByRole = new Map<string, number>();
  /** 按任务计数的在途后台工具：任务终结后要等它们结算再释放资源（283 R03）。 */
  private readonly backgroundToolsByTask = new Map<string, number>();
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  private readonly firstActivationCredentialTimers = new Map<string, NodeJS.Timeout>();
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
  /** 正在关闭连接的任务目录：释放资源占用要等它们真正收尾（283 R03）。 */
  private readonly closingTaskCatalogs = new Set<string>();
  /** 任务已终结但仍有在途后台工具：结算后再关闭工具目录（283 R03）。 */
  private readonly catalogClosePending = new Set<string>();
  private readonly activeStreams = new Map<() => void, string>();
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
    this.maxToolRounds =
      options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.toolForegroundWaitMs =
      options.toolForegroundWaitMs ?? DEFAULT_TOOL_FOREGROUND_WAIT_MS;
    this.credentials = options.credentialResolver ?? null;
    this.usesHttpModel = options.modelPortFactory === undefined;
    this.modelFactory =
      options.modelPortFactory ??
      ((binding) =>
        new HttpModelAdapter(
          binding.config,
          this.resolveModelCredential(binding),
        ));
    this.memoryRuntime = options.memoryRuntime ?? null;
    this.autonomy = options.autonomy ?? null;
    this.activity = options.activity ?? null;
    this.isResourceUnderMaintenance =
      options.isResourceUnderMaintenance ?? null;
    this.waitForMaintenanceEnd = options.waitForMaintenanceEnd ?? null;
    this.hasExternalWork = options.hasExternalWork ?? (() => false);
    this.adminServices = options.adminServices ?? null;
    this.segmentAnnotation = new SegmentAnnotationService(
      this.roleAccess,
      this.bindings,
      {
        now: this.now,
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
        modelFactory: this.modelFactory,
        autonomy: this.autonomy,
        maintenance:
          this.isResourceUnderMaintenance === null ||
          this.waitForMaintenanceEnd === null
            ? null
            : {
                isUnder: this.isResourceUnderMaintenance,
                wait: this.waitForMaintenanceEnd,
              },
        claim:
          options.claimModelCall === undefined ||
          options.claimModelCall === null
            ? null
            : { claim: options.claimModelCall },
        ...(options.resolveVoiceRuntime === undefined
          ? {}
          : { resolveVoiceRuntime: options.resolveVoiceRuntime }),
      },
    );
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
      storage.business.submitMessage(roleId, windowId, input, this.now().toISOString()),
    );
    if (result.duplicate) {
      // 响应丢失后的重试：已有消息按当前角色与模型状态重新尝试调度。
      // 用户用原提交标识再次提交就是明确的重试意图，解除此前的窗口阻塞，
      // 让模型恢复后的原消息能重新领取（283 R02）。
      this.blockedWindows.delete(windowKey(roleId, windowId));
      const reason = this.roleWaitReason(roleId, windowId);
      const decisionScheduled =
        reason === null ? this.schedule(roleId) : false;
      return {
        ...result,
        decisionScheduled,
        waitReason: decisionScheduled ? null : (reason ?? "QUEUE_PENDING"),
      };
    }
    this.blockedWindows.delete(windowKey(roleId, windowId));
    this.supersedeWindow(roleId, windowId);
    const decisionScheduled = this.schedule(roleId);
    return {
      ...result,
      decisionScheduled,
      waitReason: decisionScheduled
        ? null
        : (this.roleWaitReason(roleId, windowId) ?? "QUEUE_PENDING"),
    };
  }

  /** 只重派当前失败尝试所对应的已收消息，过时的按钮不能唤醒其他消息。 */
  retryFailedReply(roleId: string, windowId: string, messageId: string, executionId: string): SubmitConversationResult {
    const message = this.withConversationStore(roleId, (store) => {
      const { message } = store.getMessageDetail(windowId, messageId);
      const failed = store.getFailedReply(windowId);
      if (failed?.messageId !== messageId || failed.executionId !== executionId || !message.submissionId) {
        throw new AppError(409, "REPLY_RETRY_STALE", "这条消息的处理状态已更新，请查看最新回复。");
      }
      return message;
    });
    return this.submitMessage(roleId, windowId, {
      submissionId: message.submissionId!, content: message.content, sourcePlatform: message.sourcePlatform,
    });
  }

  /** 角色已停止时仍能确认原提交是否入库。 */
  findSubmittedMessage(
    roleId: string,
    windowId: string,
    submissionId: string,
  ): MessageRecord | null {
    return this.roleAccess.withStore(roleId, (storage) =>
      storage.business.findMessageBySubmission(windowId, submissionId),
    );
  }

  /** 回复落库后异步标注句段表情；正文与句段事件不等待标注完成。 */
  queueSegmentAnnotation(input: {
    roleId: string;
    windowId: string;
    messageId: string;
    executionId: string;
    outfitId?: string | null;
  }): void {
    if (this.closed) {
      return;
    }
    const controller = new AbortController();
    const waitController = new AbortController();
    this.annotationControllers.add(controller);
    const waits =
      this.annotationWaitControllers.get(input.roleId) ??
      new Set<AbortController>();
    waits.add(waitController);
    this.annotationWaitControllers.set(input.roleId, waits);
    let task: Promise<void>;
    task = this.segmentAnnotation
      .annotate({
        roleId: input.roleId,
        windowId: input.windowId,
        messageId: input.messageId,
        executionId: input.executionId,
        ...(input.outfitId === undefined ? {} : { outfitId: input.outfitId }),
        signal: controller.signal,
        waitSignal: waitController.signal,
      })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.annotationControllers.delete(controller);
        const remainingWaits = this.annotationWaitControllers.get(input.roleId);
        if (remainingWaits !== undefined) {
          remainingWaits.delete(waitController);
          if (remainingWaits.size === 0) {
            this.annotationWaitControllers.delete(input.roleId);
          }
        }
        const tasks = this.segmentAnnotations.get(input.roleId);
        if (tasks !== undefined) {
          tasks.delete(task);
          if (tasks.size === 0) {
            this.segmentAnnotations.delete(input.roleId);
          }
        }
        void this.schedule(input.roleId);
      });
    const tasks =
      this.segmentAnnotations.get(input.roleId) ?? new Set<Promise<void>>();
    tasks.add(task);
    this.segmentAnnotations.set(input.roleId, tasks);
  }

  /**
   * 删除角色前取消尚未领取的标注等待；已经发出的标注继续按原调用结算
   * （283 §13 R03）。
   */
  /** 语音首句触发合成时若对应回复正在进行后台句段标注，短暂等待其落库后读取情绪指令。 */
  awaitMessageAnnotation(
    messageId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.segmentAnnotation.awaitMessage(messageId, timeoutMs, signal);
  }

  cancelQueuedAnnotations(roleId: string): void {
    const waits = this.annotationWaitControllers.get(roleId);
    if (waits === undefined) {
      return;
    }
    for (const controller of waits) {
      controller.abort();
    }
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
    const task = this.roleAccess.withStore(input.roleId, (storage) =>
      storage.business.finishTask(input),
    );
    try {
      this.autonomy?.cancelPendingBudgetResumes(
        input.roleId,
        input.taskId,
        "TASK_ENDED",
      );
    } catch {
      // 任务已经结束；取消失败时由恢复领取时的终态检查兜底。
    }
    // 资源续用记录要等在途工具结算与连接收尾后释放（283 R03）。
    this.closeTaskCatalogAfterSettled(input.taskId);
    this.releaseTaskResources(input.roleId, input.taskId);
    this.memoryRuntime?.notifyTaskFinished(input.roleId, input.taskId);
    return task;
  }

  /**
   * 显式取消未完成的任务（进行中或已暂停）（DL-154 / DL-158）。
   * 若任务正运行，先中止当前执行并中断待继续队列；保留已发出工具调用的后台结算责任（DL-103）。
   */
  cancelTask(input: {
    roleId: string;
    taskId: string;
    reason?: string;
  }): TaskRecord {
    const reason = input.reason?.trim() || "USER_CANCELLED";
    const now = this.now().toISOString();
    const runningSnapshot = this.running.get(input.roleId);
    const { task: finished, matchedRunning } = this.roleAccess.withStore(
      input.roleId,
      (storage) =>
        storage.business.db.transaction(() => {
          const current = storage.business.getTask(input.roleId, input.taskId);
          if (current.status === "completed") {
            throw new TaskStateConflictError(
              current.taskId,
              current.status,
              "failed",
            );
          }
          if (current.status === "failed") {
            if (current.endReason === reason) {
              return {
                task: current,
                matchedRunning: null as RunningExecution | null,
              };
            }
            throw new TaskStateConflictError(
              current.taskId,
              current.status,
              "failed",
            );
          }
          const store = new ConversationStore(
            storage.business.db,
            input.roleId,
            this.timeZone,
          );
          let matched: RunningExecution | null = null;
          let eventExecutionId: string | null = null;
          let eventWindowId: string | null = null;
          if (runningSnapshot !== undefined && !runningSnapshot.superseded) {
            const activeTask = store.getPrimaryExecutionTask(
              runningSnapshot.executionId,
            );
            if (activeTask?.taskId === input.taskId) {
              store.interruptExecution({
                executionId: runningSnapshot.executionId,
                partialText: runningSnapshot.partialText,
                status: "failed",
                reason,
                errorCode: reason,
                now,
              });
              matched = runningSnapshot;
              eventExecutionId = runningSnapshot.executionId;
              eventWindowId = runningSnapshot.windowId;
            }
          }
          const task = storage.business.finishTask({
            roleId: input.roleId,
            taskId: input.taskId,
            status: "failed",
            endReason: reason,
          });
          if (eventExecutionId === null) {
            const latest = storage.business.findLatestTaskExecutionWindow(
              input.roleId,
              input.taskId,
            );
            if (latest !== null) {
              eventExecutionId = latest.executionId;
              eventWindowId = latest.windowId;
            }
          }
          if (eventExecutionId !== null && eventWindowId !== null) {
            store.appendStreamEvent({
              windowId: eventWindowId,
              executionId: eventExecutionId,
              type: "task_cancelled",
              payload: {
                taskId: input.taskId,
                executionId: eventExecutionId,
                windowId: eventWindowId,
                endReason: reason,
              },
              now,
            });
          }
          return { task, matchedRunning: matched };
        })(),
    );
    // 只有持久化事务成功提交后，才清理内存续行队列并中止在途执行，避免写入失败导致状态分裂。
    this.removePendingContinuation(input.roleId, input.taskId);
    let abortedRunning = false;
    if (matchedRunning !== null && !matchedRunning.superseded) {
      matchedRunning.superseded = true;
      matchedRunning.controller.abort();
      if (this.running.get(input.roleId) === matchedRunning) {
        this.running.delete(input.roleId);
      }
      this.detached.add(matchedRunning);
      abortedRunning = true;
    }
    try {
      this.autonomy?.cancelPendingBudgetResumes(
        input.roleId,
        input.taskId,
        "TASK_ENDED",
      );
      const activity = this.autonomy?.getLatestActivityByTask(
        input.roleId,
        input.taskId,
      );
      if (
        activity !== undefined &&
        activity !== null &&
        (activity.status === "running" || activity.status === "paused")
      ) {
        this.autonomy?.updateActivity(input.roleId, {
          activityId: activity.activityId,
          status: "failed",
          summary: `任务已取消：${reason}`,
        });
      }
    } catch {
      // 取消辅助记录失败不影响主任务已取消状态。
    }
    this.closeTaskCatalogAfterSettled(input.taskId);
    this.releaseTaskResources(input.roleId, input.taskId);
    this.memoryRuntime?.notifyTaskFinished(input.roleId, input.taskId);
    if (abortedRunning) {
      void this.schedule(input.roleId);
    }
    return finished;
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

  private isQuiescent(roleId: string): boolean {
    if ((this.segmentAnnotations.get(roleId)?.size ?? 0) > 0) {
      return false;
    }
    // 已停止角色不会再启动续行；队列里的搁置续行由删除流程丢弃（283 §12 R03）。
    if (this.activity !== null && !this.activity.canStart(roleId)) {
      return true;
    }
    return (this.pendingContinuations.get(roleId)?.length ?? 0) === 0;
  }

  /** 关闭该角色的事件流：删除角色目录前释放角色库句柄。 */
  closeStreams(roleId: string): void {
    for (const [cleanup, streamRoleId] of [...this.activeStreams]) {
      if (streamRoleId === roleId) {
        cleanup();
      }
    }
  }

  /** 清掉该角色的定时器、待续行、输入状态与工具目录；角色索引移除前调用。 */
  async disposeRole(roleId: string): Promise<void> {
    this.closeStreams(roleId);
    const timer = this.wakeTimers.get(roleId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.wakeTimers.delete(roleId);
    }
    this.dueWakeChecks.delete(roleId);
    this.clearFirstActivationCredentialRetry(roleId);
    this.pendingContinuations.delete(roleId);
    this.backgroundToolsByRole.delete(roleId);
    this.segmentAnnotations.delete(roleId);
    const waits = this.annotationWaitControllers.get(roleId);
    if (waits !== undefined) {
      for (const controller of waits) controller.abort();
      this.annotationWaitControllers.delete(roleId);
    }
    for (const key of [...this.blockedWindows]) {
      if (key.startsWith(`${roleId}\u0000`)) {
        this.blockedWindows.delete(key);
      }
    }
    this.inputStates.clearRole(roleId);
    const catalogs = [...this.taskCatalogs.entries()].filter(
      ([, entry]) => entry.roleId === roleId,
    );
    for (const [taskId, entry] of catalogs) {
      this.taskCatalogs.delete(taskId);
      this.catalogClosePending.delete(taskId);
      await entry.catalog.close();
    }
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
    this.activeStreams.set(cleanup, input.roleId);
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
      "access-control-allow-origin": "*",
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
            if (failed && failed.errorCode !== "PROCESS_INTERRUPTED") this.blockedWindows.add(windowKey(index.roleId, windowId));
            if (store.findInterruptedUserTask(windowId) !== null) pendingUserRecovery = true;
          }
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
        this.registerFirstActivation(index.roleId);
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
        if (decision?.action.kind === "continue") {
          // 回复已提交但续行未排队：按原决定保持任务活跃并补排续行（DL-154）。
          if (gap.windowId !== null) {
            this.queueTaskContinuation(roleId, {
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
    for (const timer of this.firstActivationCredentialTimers.values()) {
      clearTimeout(timer);
    }
    this.firstActivationCredentialTimers.clear();
    this.dueWakeChecks.clear();
    for (const cleanup of [...this.activeStreams.keys()]) {
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
    for (const controller of this.annotationControllers) {
      controller.abort();
    }
    for (const waits of this.annotationWaitControllers.values()) {
      for (const controller of waits) controller.abort();
    }
    const annotations = [...this.segmentAnnotations.values()].flatMap(
      (tasks) => [...tasks],
    );
    if (annotations.length > 0) {
      await Promise.allSettled(annotations);
    }
    const catalogs = [...this.taskCatalogs.values()];
    this.taskCatalogs.clear();
    await Promise.allSettled(catalogs.map((entry) => entry.catalog.close()));
    await this.memoryRuntime?.close();
  }

  /**
   * 已接收但未安排回复的原因。用于桌面端区分「角色已停止」「缺少对话模型」
   * 「其他窗口正在生成」与「正常排队」，避免用单一字段猜测。
   */
  private roleWaitReason(
    roleId: string,
    windowId: string,
  ): ConversationWaitReason | null {
    if (this.activity !== null && !this.activity.canStart(roleId)) {
      return "ROLE_STOPPED";
    }
    if (this.running.has(roleId)) {
      return "BUSY";
    }
    if (this.blockedWindows.has(windowKey(roleId, windowId))) {
      return "WINDOW_BLOCKED";
    }
    let pending: ReturnType<ConversationStore["listPendingWindows"]>;
    try {
      pending = this.withConversationStore(roleId, (store) =>
        store.listPendingWindows(),
      );
    } catch {
      return "QUEUE_PENDING";
    }
    if (pending.length === 0) {
      return "QUEUE_PENDING";
    }
    const target = pending.find(
      (window) => !this.blockedWindows.has(windowKey(roleId, window.windowId)),
    );
    if (target === undefined) {
      return "WINDOW_BLOCKED";
    }
    let pendingTaskId: string | null = null;
    try {
      pendingTaskId = this.withConversationStore(roleId, (store) =>
        store.findInterruptedUserTask(target.windowId),
      );
    } catch {
      return "QUEUE_PENDING";
    }
    const hasModel =
      this.bindings.hasChatBinding(roleId) ||
      (pendingTaskId !== null &&
        this.bindings.hasChatForTask(roleId, pendingTaskId));
    return hasModel ? null : "MODEL_MISSING";
  }

  private schedule(roleId: string): boolean {
    const started = this.scheduleInternal(roleId);
    this.armWakeTimer(roleId);
    return started;
  }

  /** 是否还有属于该角色的执行或后台工具在跑；停止确认据此判断是否要等边界。 */
  isRunning(roleId: string): boolean {
    if (this.running.has(roleId)) return true;
    if ((this.backgroundToolsByRole.get(roleId) ?? 0) > 0) return true;
    for (const detached of this.detached) {
      if (detached.roleId === roleId) return true;
    }
    return false;
  }

  /** 正在使用目标模型服务的执行角色；不受当前绑定变化影响（283 §7 R01）。 */
  inflightRoleIds(resourceId: string): string[] {
    const roles = new Set<string>();
    for (const entry of this.inflightResources.values()) {
      if (entry.resourceId === resourceId) roles.add(entry.roleId);
    }
    return [...roles].sort();
  }

  /**
   * 没有前台执行、只剩后台工具时，停止确认只能在最后一个后台工具结算后收敛。
   * 只改活动状态，不改工具调用记录：晚到结果仍按原调用结算并保留原始响应。
   */
  private confirmStopIfIdle(
    roleId: string,
    boundaryExecutionId: string | null,
  ): void {
    if (this.closed) return;
    if (this.activity?.isStopRequested(roleId) !== true) return;
    if (this.isRunning(roleId)) return;
    // 后台记忆整理也属于本角色的在途工作，必须等它到达安全边界（283 §5 R01）。
    if (this.hasExternalWork(roleId)) return;
    try {
      this.activity.confirmStop(roleId, boundaryExecutionId);
    } catch {
      // 确认失败时保持 stopping，不放行配置写入。
    }
  }

  private scheduleInternal(roleId: string): boolean {
    if (this.closed || this.running.has(roleId)) {
      return false;
    }
    // 已停止或正在停止的角色不再启动任何新步骤（DL-148）。
    if (this.activity !== null && !this.activity.canStart(roleId)) {
      return false;
    }
    this.registerFirstActivation(roleId);
    let pending: ReturnType<ConversationStore["listPendingWindows"]>;
    try {
      pending = this.withConversationStore(roleId, (store) =>
        store.listPendingWindows(),
      );
    } catch {
      return false;
    }
    let target: (typeof pending)[number] | undefined;
    let pendingTaskId: string | null = null;
    for (const window of pending) {
      if (this.blockedWindows.has(windowKey(roleId, window.windowId))) {
        continue;
      }
      let taskId: string | null = null;
      try {
        taskId = this.withConversationStore(roleId, (store) =>
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
      this.bindings.hasChatBinding(roleId) ||
      (pendingTaskId !== null && this.bindings.hasChatForTask(roleId, pendingTaskId))
    )) {
      if (this.inputStates.isTyping(roleId, target.windowId)) {
        return true;
      }
      return this.startExecution(roleId, target.windowId);
    }
    const continuation = (this.pendingContinuations.get(roleId) ?? []).find(
      (item) => !this.chatTargetUnderMaintenance(roleId, item.taskId),
    );
    if (continuation) {
      return this.startTaskContinuation(roleId, continuation);
    }
    return this.startDueAutonomy(roleId);
  }

  /** 该窗口／任务实际使用的对话模型是否正在维护（283 R01、R04）。 */
  private chatTargetUnderMaintenance(
    roleId: string,
    taskId: string | null,
  ): boolean {
    if (this.isResourceUnderMaintenance === null) {
      return false;
    }
    const resourceId =
      (taskId === null ? null : this.bindings.taskChatResourceId(roleId, taskId)) ??
      this.bindings.chatResourceId(roleId);
    return (
      resourceId !== null && this.isResourceUnderMaintenance(resourceId)
    );
  }

  private armWakeTimer(roleId: string): void {
    const existing = this.wakeTimers.get(roleId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.wakeTimers.delete(roleId);
    }
    if (this.closed || this.autonomy === null || this.running.has(roleId) ||
        this.activity?.canStart(roleId) === false) {
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

  /**
   * 后台记忆整理等外部工作收尾后的空闲通知（283 §4 R01）。
   * 停止请求可能只等这些调用；这里在它们真正结束后确认停止。
   */
  notifyExternalIdle(roleId: string): void {
    this.confirmStopIfIdle(roleId, null);
  }

  /**
   * 模型恢复、绑定修复或维护结束后重新检查已有待处理工作（283 R02）。
   * 不传角色时覆盖所有已初始化角色；停止中的角色由统一调度跳过。
   */
  wakePendingWork(roleId?: string): void {
    if (this.closed) {
      return;
    }
    const targets =
      roleId === undefined
        ? this.appStore
            .listRoleIndexes()
            .filter((index) => index.initStatus === "ready")
            .map((index) => index.roleId)
        : [roleId];
    for (const target of targets) {
      this.memoryRuntime?.kick(target);
      this.schedule(target);
    }
  }

  /**
   * 恢复活动后的重新调度（RA-R02）：把因停止而暂停的任务链改回 active 并排队
   * 续行，再交给统一调度接上到期待办与后台工具留下的续行。待办、任务链与
   * 自主额度原样保留，不新建任务、不清空排队、不重置额度。
   */
  rescheduleAfterStop(roleId: string): void {
    if (this.closed) return;
    let resumed: PendingTaskContinuation[] = [];
    try {
      resumed = this.roleAccess.withStore(roleId, (storage) => {
        const store = new ConversationStore(
          storage.business.db,
          roleId,
          this.timeZone,
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
    wake: AutonomyWakeRecord,
  ): boolean {
    if (isFirstActivationWake(wake.wakeId)) {
      return this.firstActivationModelReady(roleId);
    }
    // 唤醒会接回原任务时按任务模型判断；否则按当前对话模型判断。
    if (this.chatTargetUnderMaintenance(roleId, wake.taskId)) {
      return false;
    }
    if (this.bindings.hasChatBinding(roleId)) {
      return true;
    }
    if (wake.taskId !== null) {
      return this.bindings.hasChatForTask(roleId, wake.taskId);
    }
    return false;
  }

  private registerFirstActivation(roleId: string): void {
    if (this.autonomy === null || this.activity?.canStart(roleId) !== true) {
      return;
    }
    try {
      if (this.autonomy.hasPendingFirstActivation(roleId) &&
          this.firstActivationModelReady(roleId)) {
        this.autonomy.enqueueFirstActivation(roleId);
      }
    } catch {
      // 状态与唤醒落在不同的库；下次调度重新检查资格。
    }
  }

  private resolveModelCredential(binding: ResolvedModelBinding): string | undefined {
    const reference = binding.config.credentialRef;
    return this.credentials === null
      ? resolveCredential(this.appRoot, reference)
      : this.credentials.resolve(binding.resourceId, reference);
  }

  private firstActivationModelReady(roleId: string): boolean {
    this.clearFirstActivationCredentialRetry(roleId);
    try {
      const binding = this.bindings.resolveChat(roleId);
      if (this.isResourceUnderMaintenance?.(binding.resourceId) === true) {
        return false;
      }
      // 与实际调用走同一份本机凭据解析。注入的模型不依赖 HTTP 凭据。
      if (this.usesHttpModel) this.resolveModelCredential(binding);
      return true;
    } catch (error) {
      if (error instanceof ModelCredentialUnavailableError) {
        // env:/file: 可独立于资源 API 就绪，给已激活的角色重新检查机会。
        const timer = setTimeout(() => {
          this.firstActivationCredentialTimers.delete(roleId);
          this.schedule(roleId);
        }, FIRST_ACTIVATION_CREDENTIAL_RETRY_MS);
        timer.unref();
        this.firstActivationCredentialTimers.set(roleId, timer);
      }
      return false;
    }
  }

  private clearFirstActivationCredentialRetry(roleId: string): void {
    const timer = this.firstActivationCredentialTimers.get(roleId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.firstActivationCredentialTimers.delete(roleId);
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
    this.closingTaskCatalogs.add(taskId);
    this.catalogClosePending.delete(taskId);
    return entry.catalog.close().finally(() => {
      this.closingTaskCatalogs.delete(taskId);
      // 连接收尾完成后再释放任务资源占用（283 R03）。
      this.releaseTaskResources(entry.roleId, taskId);
    });
  }

  /**
   * 任务终结后关闭工具目录，但要等已发出的后台工具结算完再收连接（283 R03）。
   * 在途工具结算回调会再次调用这里，并在关闭完成后释放资源占用。
   */
  private closeTaskCatalogAfterSettled(taskId: string): void {
    if ((this.backgroundToolsByTask.get(taskId) ?? 0) > 0) {
      this.catalogClosePending.add(taskId);
      return;
    }
    void this.closeTaskCatalog(taskId);
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
      const failed = store.getFailedReply(windowId);
      const replyToolSource = failed && failed.errorCode !== "PROCESS_INTERRUPTED" ? store.replyToolSource(failed.executionId) : null;
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
          ...(replyToolSource ? { replyToolSource } : {}),
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
    // 每日穿搭按本轮开始决策的业务本地日期登记，跨零点不改变本轮日期。
    const roundLocalDate = localDateFromIso(
      this.now().toISOString(),
      this.timeZone,
    );
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
    let pausedByStop = false;
    let backgroundedTool = false;
    let continuationQueued = false;
    /** 本段已决定收尾的原因；收尾轮据此追加「禁止再调用工具」的指令。 */
    let haltKind: AgentSegmentStopKind | null = null;
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
    // 停止边界要保存进度：这一轮可能还没派发过外部工具、任务链尚未建立，
    // 此时先把任务建起来，恢复后才能由同一任务续行接手已领取的消息。
    let ensureTaskForStop: (() => string) | null = null;
    // 停止只在图节点入口生效，不在流式吐字中途打断，保证停在可保存进度处。
    const checkStopBoundary = (): void => {
      if (this.activity?.isStopRequested(roleId) === true) {
        try {
          ensureTaskForStop?.();
        } catch {
          // 建任务失败不阻止停止：执行仍按 paused 收尾，消息保持领取。
        }
        throw new RoleStopRequestedError(roleId);
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
        fullText: running.partialText,
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
      // 本轮执行固定在初始模型服务上；维护等待据此判断目标服务的实际在途调用。
      this.inflightResources.set(execution.executionId, {
        roleId,
        resourceId: initialBinding.resourceId,
      });
      const resolveModel = (): AgentModelHandle => {
        const binding = this.bindings.refresh(initialBinding, roleId);
        return {
          model: this.modelFactory(binding),
          resourceId: binding.resourceId,
          modelName: binding.modelName,
          protocol: binding.config.protocol,
          ...(binding.config.provider === undefined ? {} : { provider: binding.config.provider }),
          baseUrl: binding.config.baseUrl,
          ...(binding.config.maxInputChars === undefined ? {} : { maxInputChars: binding.config.maxInputChars }),
          ...(binding.config.maxOutputChars === undefined ? {} : { maxOutputChars: binding.config.maxOutputChars }),
        };
      };
      const recent = store.listRecentMessages(windowId, 30);
      // 补答遇到已派发的工具时只读取回执；即便模型再次要求执行，也没有工具可派发。
      const replyToolSource = store.savedReplyToolSource(execution.executionId);
      const replyToolTask = replyToolSource ? store.getPrimaryExecutionTask(replyToolSource)?.taskId ?? null : null;
      const replyToolKeys = replyToolSource ? store.recoveryToolKeys(replyToolSource) : [];
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
      const outfitBrief = this.buildOutfitBrief(
        storage,
        roleId,
        store.getRoleContext().state,
        roundLocalDate,
      );
      if (replyToolSource) {
        catalog = { tools: [], skillBriefs: [], warnings: [], close: async () => {} };
      } else if (
        cachedCatalog !== undefined &&
        cachedCatalog.roleId === roleId
      ) {
        catalog = cachedCatalog.catalog;
      } else {
        catalog = await loadAgentTools({
          roleId,
          readWebToolProjection: readWebHistoryProjection,
          appStore: this.appStore,
          roleAccess: this.roleAccess,
          memory: this.memory,
          autonomy: this.autonomy,
          allowAutonomyShare: autonomy !== null,
          continuationResourceIds,
          appRoot: this.appRoot,
          workspaceDir: storage.paths.workspaceDir,
          ...(this.adminServices === null
            ? {}
            : { admin: this.adminServices }),
        });
        if (input.taskId !== null && input.taskId !== undefined) {
          this.taskCatalogs.set(input.taskId, {
            roleId,
            catalog,
            modelBinding: initialBinding,
          });
        }
      }
      let activeRecall = recall;
      const worldbook = matchWorldbooks(readWorldbooks(storage.business.db, roleId), [
        ...pendingMessages.map(message => ({ id: message.messageId, text: message.content })),
        { text: continuationTask?.goal ?? "" },
        { text: autonomy?.intent ?? "" },
      ]);
      let previousStep: string | null = null;
      const systemPrompt = (messages: readonly ModelMessage[], round: number): AgentSystemPrompt => {
        const latest = round > 0 ? [...messages].reverse().find((message) => message.role === "assistant" && message.toolCalls?.length) : undefined;
        const calls = latest?.role === "assistant" ? latest.toolCalls ?? [] : [];
        const step = recallStepTopic(calls);
        // 从已命中的事件下钻到原文是同一步骤。保留这批线索，不另做检索或增加召回计数。
        const readingEvidence = calls.length > 0 && calls.every(call => memoryDetailTools.has(call.name));
        if (latest && !readingEvidence && step !== previousStep) {
          activeRecall = step ? this.autoRecall(roleId, execution.executionId, [], [], step) : { briefs: [], warning: null };
          previousStep = step;
        }
        const prompt = this.buildSystemPrompt({
          roleContext: store.getRoleContext(),
          recallBriefs: activeRecall.briefs,
          recallWarning: activeRecall.warning,
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
          outfitBrief,
          segmentHalt: haltKind,
        });
        if (replyToolSource) prompt.required += "\n上次回答中断，本轮只补答原消息。已派发操作以保存的回执为据，结果未确认的如实说明。未提交的角色状态以当前状态为准。";
        return { ...prompt, worldbook };
      };
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
      ensureTaskForStop = ensureTask;
      const messages = this.buildMessages(recent, pendingMessages);
      saver = SqliteSaver.fromConnString(storage.paths.executionDatabasePath);
      const runner = new AgentGraphRunner(
        {
          store,
          roleStore: storage.business,
          resolveModel,
          tools: catalog.tools,
          systemPrompt,
          prepareModelMessages: (messages) => prepareModelWebReadings(storage.business.db, roleId, messages),
          onModelAccepted: (accepted) => {
            new MemoryStore(storage.business.db).recordDeliveries(roleId, accepted.executionId, accepted.memoryReads, this.now().toISOString());
            recordWorldbookUsage(storage.business.db, accepted);
            recordAcceptedWebReadings(storage.business.db, {
              ...accepted,
              now: this.now().toISOString(),
              ...(this.timeZone ? { timeZone: this.timeZone } : {}),
            });
          },
          evidenceQuery: () => [
            ...pendingMessages.map((message) => message.content),
            ...replyToolKeys,
            continuationTask?.goal ?? "",
            autonomy?.intent ?? "",
          ].join("\n"),
          selectEvidence: (context) => findAgentEvidence(
            storage.business.db,
            { roleId, windowId, taskId: replyToolTask ?? context.taskId, scope: "window" },
            context.query,
            context.messages,
            context.initialRound && (continuationTask !== null || replyToolTask !== null),
            readWebHistoryProjection,
          ),
          signal: running.controller.signal,
          checkRunning,
          checkStopBoundary,
          checkDispatch,
          emitDelta,
          ensureTask,
          now: this.now,
          localDate: roundLocalDate,
          maxToolRounds: this.maxToolRounds,
          purpose,
          meter,
          toolForegroundWaitMs: this.toolForegroundWaitMs,
          onBackgroundToolSettled: (settlement) =>
            this.handleBackgroundToolSettled(settlement),
          onToolBackgrounded: () => {
            backgroundedTool = true;
          },
          onSegmentHalt: (kind) => {
            haltKind = kind;
          },
          registerBackgroundTool: (settlement, backgroundRoleId) => {
            // 按任务记在途工具：任务终结后要等它们结算再释放资源（283 R03）。
            const backgroundTaskId = taskId;
            if (backgroundTaskId !== null) {
              this.backgroundToolsByTask.set(
                backgroundTaskId,
                (this.backgroundToolsByTask.get(backgroundTaskId) ?? 0) + 1,
              );
            }
            this.backgroundToolSettles.add(settlement);
            this.backgroundToolsByRole.set(
              backgroundRoleId,
              (this.backgroundToolsByRole.get(backgroundRoleId) ?? 0) + 1,
            );
            void settlement.then(() => {
              this.backgroundToolSettles.delete(settlement);
              const remaining = (this.backgroundToolsByRole.get(backgroundRoleId) ?? 1) - 1;
              if (remaining <= 0) {
                this.backgroundToolsByRole.delete(backgroundRoleId);
              } else {
                this.backgroundToolsByRole.set(backgroundRoleId, remaining);
              }
              if (backgroundTaskId !== null) {
                const taskRemaining =
                  (this.backgroundToolsByTask.get(backgroundTaskId) ?? 1) - 1;
                if (taskRemaining <= 0) {
                  this.backgroundToolsByTask.delete(backgroundTaskId);
                } else {
                  this.backgroundToolsByTask.set(backgroundTaskId, taskRemaining);
                }
                if (taskRemaining <= 0 && this.catalogClosePending.has(backgroundTaskId)) {
                  // 最后一个在途工具已结算：关闭目录，收尾后释放资源占用（283 R03）。
                  void this.closeTaskCatalog(backgroundTaskId);
                }
                this.releaseTaskResources(backgroundRoleId, backgroundTaskId);
              }
              if (remaining <= 0) {
                // 最后一个后台工具结算：前台执行可能早已退出，停止确认不能只等
                // 前台收尾。结算回调先于计数递减执行，这里确认不会丢原调用记录。
                this.confirmStopIfIdle(backgroundRoleId, execution.executionId);
                // 前台执行恰好还在收尾时同步确认会跳过，再延后一次兜底收敛。
                const deferredRoleId = backgroundRoleId;
                const deferredExecutionId = execution.executionId;
                const timer = setTimeout(() => {
                  this.confirmStopIfIdle(deferredRoleId, deferredExecutionId);
                }, 0);
                timer.unref?.();
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
      const stopKind = result.segment.stopKind;
      const continueSegment =
        stopKind === "round_limit" || stopKind === "continue_requested";
      const circuitBreak = stopKind === "circuit_breaker";
      // 切段／暂停／熔断时模型可能没有给出正文：按已保存的真实进度补一段说明，
      // 不把「本段已推进」误判成空回复失败（DL-154 / DL-158）。
      // checkpoint 保留整条执行的工具和正文；已经独立交付的中断回复有自己的消息边界。
      const resumedAfterDelivery = input.resume && store.hasInterruptedOutput(execution.executionId);
      const replyText = resumedAfterDelivery ? running.partialText : result.text;
      // 此轮已成功结束，所有字在中断前均已交付。只保存完成回执，保留原中断消息及其证据。
      const completionOnly = resumedAfterDelivery && result.lastRoundEchoOnly && replyText.length === 0;
      const content =
        replyText.trim().length > 0
          ? replyText
          : stopKind === null || completionOnly
            ? ""
            : segmentNotice(stopKind);
      if (content.length === 0 && !completionOnly) {
        throw new ModelRequestFailedError("模型没有产生可保存的回复文字", {
          reason: "EMPTY_RESPONSE",
        });
      }
      let taskDecision =
        result.taskId === null
          ? null
          : toCommittedTaskDecision(result.taskId, result.taskAction);
      if (
        result.taskId !== null &&
        result.taskAction === null &&
        taskDecision !== null &&
        taskDecision.action.kind === "finish"
      ) {
        if (continueSegment) {
          // 达到单段上限或模型显式续行：任务保持 active，交给续行队列接着推进。
          taskDecision = {
            taskId: result.taskId,
            action: { kind: "continue", reason: stopKind ?? "round_limit" },
          };
        } else if (circuitBreak) {
          // 连续失败／连续无进展熔断：暂停并向用户汇报，等待决定。
          taskDecision = {
            taskId: result.taskId,
            action: {
              kind: "pause",
              reason: "TASK_CIRCUIT_BREAKER",
              waitReason: "CIRCUIT_BREAKER",
            },
          };
        }
      }
      const automaticScene = !completionOnly && autonomy === null && content.trim()
        ? this.autoScenes?.captureAutomaticConfig(roleId, storage.business.db) ?? null : null;
      const committed = store.commitConversation({
        automaticScene,
        executionId: execution.executionId,
        content,
        statePatch: this.validateOutfitStatePatch(
          storage,
          roleId,
          result.statePatch,
        ),
        countsAsConversationRound: autonomy === null,
        taskDecision,
        now: this.now().toISOString(),
      });
      if (automaticScene) this.autoScenes?.dispatchAutomatic(roleId, windowId);
      if (!completionOnly) this.queueSegmentAnnotation({
        roleId,
        windowId,
        executionId: execution.executionId,
        messageId: committed.replyMessage.messageId,
        outfitId:
          typeof committed.state.outfitId === "string"
            ? committed.state.outfitId
            : null,
      });
      if (result.taskId !== null && taskDecision !== null) {
        taskId = result.taskId;
        this.applyCommittedTaskDecision(storage, roleId, taskDecision, () => {
          pausedByDecision = true;
        });
      }
      if (taskDecision !== null && taskDecision.action.kind === "continue") {
        this.queueTaskContinuation(roleId, {
          taskId: taskDecision.taskId,
          windowId,
        });
        continuationQueued = true;
      }
      if (taskDecision !== null && taskDecision.action.kind === "pause") {
        store.appendStreamEvent({
          windowId,
          executionId: execution.executionId,
          type: "execution_paused",
          payload: {
            executionId: execution.executionId,
            taskId: taskDecision.taskId,
            reason: taskDecision.action.reason,
            ...(taskDecision.action.waitReason === undefined
              ? {}
              : { waitReason: taskDecision.action.waitReason }),
          },
          now: this.now().toISOString(),
        });
      }
      if (result.taskId !== null && result.taskAction === null) {
        this.trackSegmentProgress(storage, roleId, result, execution, {
          queuedContinuation: continuationQueued,
        });
      }
      if (autonomy !== null) {
        try {
          if (autonomy.activityId !== null) {
            this.autonomy?.updateActivity(roleId, {
              activityId: autonomy.activityId,
              status: "completed",
              summary: truncate(content, 2000),
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
        } else if (code === "ROLE_STOP_REQUESTED") {
          // 停在可保存节点：执行与任务链都记为 paused，不判失败、不拉黑窗口。
          // 用户消息保持领取状态，恢复后由原任务续行接手。
          pausedByStop = true;
          try {
            store.interruptExecution({
              executionId: execution.executionId,
              partialText: running.partialText,
              status: "paused",
              reason: code,
              errorCode: code,
              keepClaimedMessages: true,
              now: this.now().toISOString(),
            });
          } catch {
            // 状态已由其他路径改变，保留已有事件。
          }
          try {
            if (taskId !== null) {
              storage.business.pauseTask({ roleId, taskId, endReason: code });
            }
          } catch {
            // 任务已结束时不强改状态；停止确认照常进行。
          }
          try {
            // 对话已到可保存节点，但后台记忆仍在途时不能先确认停止；
            // 记忆收尾后的空闲通知会再走统一收敛（283 §5 R01）。
            if (!this.hasExternalWork(roleId)) {
              this.activity?.confirmStop(roleId, execution.executionId);
            }
          } catch {
            // 确认失败时保持 stopping，避免误放行配置写入。
          }
          this.memoryRuntime?.notifyEvidence(roleId);
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
      if (continuationQueued) {
        // 本段已排队续行：任务目录与资源延续要留给下一执行段复用。
        keepCatalog = true;
      }
      if (!keepCatalog && running.superseded && taskId !== null) {
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
      if (!keepCatalog && pausedByStop && taskId !== null) {
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
      if (
        !keepCatalog &&
        taskId !== null &&
        (this.backgroundToolsByTask.get(taskId) ?? 0) > 0
      ) {
        // 任务已终结但仍有已发出的后台工具：先不关连接，
        // 等结果结算后再关闭目录并释放资源占用（283 R03）。
        this.catalogClosePending.add(taskId);
        keepCatalog = true;
      }
      if (!keepCatalog) {
        await catalog?.close();
        if (taskId !== null) {
          this.taskCatalogs.delete(taskId);
          // 目录直接在此关闭时也要补上资源释放（283 R03）。
          this.releaseTaskResources(roleId, taskId);
        }
      }
      saver?.db.close();
      this.inflightResources.delete(execution.executionId);
      storage.close();
      // 执行已收尾：正常完成或失败时若停止请求没在节点边界命中，这里兜底确认，
      // 避免角色永久卡在 stopping。重复确认由存储的 WHERE state='stopping' 幂等处理。
      // 仍有后台工具在途时不在这里确认：它们还属于本轮活动，由最后一个工具
      // 结算后的收敛路径确认（RA-R01）。
      if (
        (this.backgroundToolsByRole.get(roleId) ?? 0) === 0 &&
        !this.hasExternalWork(roleId) &&
        this.activity?.isStopRequested(roleId) === true
      ) {
        try {
          this.activity.confirmStop(roleId, execution.executionId);
        } catch {
          // 确认失败时保留 stopping，不放行配置写入。
        }
      }
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
        // 任务已终结：结果已记在原任务上，结算后即可释放资源占用（283 R03）。
        this.releaseTaskResources(settlement.roleId, settlement.taskId!);
        return;
      }
    } catch {
      this.releaseTaskResources(settlement.roleId, settlement.taskId!);
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
    if (decision.action.kind === "continue") {
      // 决策已随回复提交；任务维持 active，由调用方排队下一执行段。
      return;
    }
    if (decision.action.kind === "pause") {
      onPause?.();
      try {
        // 暂停保留原任务编号与资源延续，等待唤醒或后续轮次接回。
        storage.business.pauseTask({
          roleId,
          taskId: decision.taskId,
          endReason: decision.action.reason,
          waitReason: decision.action.waitReason ?? "AWAITING_USER_INPUT",
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

  /**
   * 续行进展计数与连续无进展熔断（DL-154）。
   *
   * 只有续行执行段（trigger_type = tool_result）参与「连续 3 段无进展」判定；
   * 判定依据是本段是否产生新的成功工具调用或进度笔记，不看模型自述。
   */
  private trackSegmentProgress(
    storage: RoleStorage,
    roleId: string,
    result: AgentRunResult,
    execution: ExecutionRecord,
    options: { queuedContinuation: boolean },
  ): void {
    try {
      if (result.taskId === null) {
        return;
      }
      const task = storage.business.getTask(roleId, result.taskId);
      const streak = storage.business.taskToolFailureStreak(roleId, task.taskId);
      storage.business.setTaskCircuitCounters({
        roleId,
        taskId: task.taskId,
        consecutiveFailures: streak?.count ?? 0,
      });
      if (execution.triggerType !== "tool_result" || task.status !== "active") {
        return;
      }
      const progressed =
        result.segment.successfulToolCalls > 0 ||
        result.segment.progressNotes > 0;
      if (progressed) {
        if (task.consecutiveNoProgress !== 0) {
          storage.business.setTaskCircuitCounters({
            roleId,
            taskId: task.taskId,
            consecutiveNoProgress: 0,
          });
        }
        return;
      }
      const next = task.consecutiveNoProgress + 1;
      storage.business.setTaskCircuitCounters({
        roleId,
        taskId: task.taskId,
        consecutiveNoProgress: next,
      });
      if (next < CIRCUIT_FAILURE_THRESHOLD) {
        return;
      }
      storage.business.pauseTask({
        roleId,
        taskId: task.taskId,
        endReason: "TASK_CIRCUIT_BREAKER",
        waitReason: "CIRCUIT_BREAKER",
      });
      if (options.queuedContinuation) {
        this.removePendingContinuation(roleId, task.taskId);
      }
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.timeZone,
      );
      const reason =
        "连续多个执行段没有产生新的工具结果或进度笔记，任务已熔断暂停；请确认是否调整目标或取消任务。";
      if (execution.windowId !== null) {
        // 向当前窗口补一条可见说明，用户不必只靠任务状态猜测发生了什么。
        const notes = storage.business
          .listTaskNotes(roleId, task.taskId)
          .slice(-3)
          .map((note) => `- ${truncate(note.note, 200)}`);
        store.appendProactiveMessage({
          windowId: execution.windowId,
          executionId: execution.executionId,
          content: [
            "（任务先暂停一下）",
            reason,
            ...(notes.length === 0 ? ["目前没有已保存的进度笔记。"] : ["已保存的最近进度：", ...notes]),
          ].join("\n"),
          now: this.now().toISOString(),
        });
        store.appendStreamEvent({
          windowId: execution.windowId,
          executionId: execution.executionId,
          type: "execution_paused",
          payload: {
            executionId: execution.executionId,
            taskId: task.taskId,
            reason: "TASK_CIRCUIT_BREAKER",
            waitReason: "CIRCUIT_BREAKER",
            message: reason,
          },
          now: this.now().toISOString(),
        });
      }
    } catch {
      // 计数与熔断失败不覆盖已提交的回复；下一次续行会重新评估。
    }
  }

  private finishTaskAfterExecution(
    storage: RoleStorage,
    roleId: string,
    taskId: string,
    status: "completed" | "failed",
    endReason: string,
  ): void {    try {
      storage.business.finishTask({ roleId, taskId, status, endReason });
      this.autonomy?.cancelPendingBudgetResumes(
        roleId,
        taskId,
        "TASK_ENDED",
      );
    } catch {
      // 结束任务失败不覆盖已提交的回复或工具结果。
    }
    // 已发出的工具调用仍按原任务结算；结算与目录收尾后再释放占用（283 R03）。
    this.releaseTaskResources(roleId, taskId);
  }

  /**
   * 任务已终结时释放资源续用记录（283 R03）。
   *
   * 仍有在途后台工具、未结算的工具调用或尚未关闭的任务目录时保留占用，
   * 由结算回调与目录关闭后的收尾再次调用。任务仍在进行时不做任何处理。
   */
  private releaseTaskResources(roleId: string, taskId: string): void {
    if (this.closed) {
      return;
    }
    if ((this.backgroundToolsByTask.get(taskId) ?? 0) > 0) {
      return;
    }
    if (this.taskCatalogs.has(taskId)) {
      // 目录关闭完成后 closeTaskCatalog 会再次调用。
      return;
    }
    if (this.closingTaskCatalogs.has(taskId)) {
      return;
    }
    try {
      this.roleAccess.withStore(roleId, (storage) => {
        const task = storage.business.getTask(roleId, taskId);
        if (task.status !== "completed" && task.status !== "failed") {
          return;
        }
        if (storage.business.hasUnsettledToolCalls(roleId, taskId)) {
          return;
        }
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
      });
    } catch {
      // 存储暂不可用时保留续用记录；重启或下次收尾继续释放。
    }
  }

  private autoRecall(
    roleId: string,
    executionId: string,
    pendingMessages: readonly ClaimedMessage[],
    recent: readonly ConversationMessageView[],
    extraQuery = "",
  ): { briefs: RecallBrief[]; warning: string | null } {
    const parts = [...pendingMessages].reverse().map((message) => message.content);
    parts.push(extraQuery);
    // 只在用户简短承接前文时借用最近一轮，避免角色自己反复提的旧事持续占据召回。
    const followsPrevious = /^(?:那个呢|那件事呢|那后来呢|然后呢|后来呢|接着(?:说|讲)?|继续(?:说|讲)?|再说说|你刚(?:刚|才)说的(?:那个)?|what happened next|go on|tell me more)[啊呀吧吗呢？?！!。.…\s]*$/iu;
    if (!extraQuery && followsPrevious.test(pendingMessages.at(-1)?.content.trim() ?? "")) {
      const pendingIds = new Set(pendingMessages.map((message) => message.messageId));
      const previous = recent.filter((message) => !pendingIds.has(message.messageId) && message.status !== "generating");
      parts.push(...previous.slice(-2).map((message) => message.content));
    }
    const query = parts.map((part) => {
      const text = part.replace(/\s+/g, " ").trim();
      return text.length > 500 ? `${text.slice(0, 180)} ${text.slice(-319)}` : text;
    }).filter(Boolean).join(" ").slice(0, 500);
    if (!query) return { briefs: [], warning: null };
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
          retrievalId: result.retrievalId,
          type: item.type,
          id: item.id,
          title: item.title,
          snippet: item.snippet,
          ...(item.experienceDate ? { experienceDate: item.experienceDate } : {}),
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
  ): ModelMessage[] {
    // 重试可能同时领取旧问题和新请求。按窗口序号合并，保留旧问题与中断回复的因果顺序。
    const pendingIds = new Set(pendingMessages.map((message) => message.messageId));
    const history = recent.flatMap((message): Array<{ sequence: number; model: ModelMessage }> => {
      if (message.status === "generating" || pendingIds.has(message.messageId)) return [];
      return [{
        sequence: message.sequence,
        model: {
          role: message.sender,
          content: message.status === "interrupted"
            ? `${message.content}\n[以上回复中断，未完成]`
            : message.content,
          source: { messageId: message.messageId, sentAt: message.createdAt },
        },
      }];
    });
    for (const message of pendingMessages) {
      history.push({
        sequence: message.sequence,
        model: {
          role: "user",
          content: message.content,
          source: { messageId: message.messageId, sentAt: message.createdAt, currentUserRequest: true },
        },
      });
    }
    return history.sort((a, b) => a.sequence - b.sequence).map(({ model }) => model);
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

  /** 读取当前衣柜与本轮穿搭状态；衣柜为空时不向模型增加提示。 */
  private buildOutfitBrief(
    storage: RoleStorage,
    roleId: string,
    state: Record<string, unknown>,
    localDate: string,
  ): OutfitBrief | null {
    const outfits = new AppearanceStore(
      storage.business.db,
      roleId,
    ).listOutfits();
    if (outfits.length === 0) {
      return null;
    }
    const rawOutfitId =
      typeof state.outfitId === "string" ? state.outfitId : null;
    const current =
      rawOutfitId === null
        ? null
        : (outfits.find((outfit) => outfit.outfitId === rawOutfitId) ?? null);
    return {
      localDate,
      reviewedToday:
        current !== null &&
        typeof state.outfitReviewedOn === "string" &&
        state.outfitReviewedOn === localDate,
      current:
        current === null
          ? null
          : { outfitId: current.outfitId, name: current.name },
      items: outfits.map((outfit) => ({
        outfitId: outfit.outfitId,
        name: outfit.name,
        description: outfit.description,
      })),
    };
  }

  /** 提交前复核状态补丁引用的服饰仍属于该角色衣柜。 */
  private validateOutfitStatePatch(
    storage: RoleStorage,
    roleId: string,
    statePatch: Record<string, unknown>,
  ): Record<string, unknown> {
    const outfitId = statePatch.outfitId;
    if (outfitId === undefined) {
      return statePatch;
    }
    const exists =
      typeof outfitId === "string" &&
      new AppearanceStore(storage.business.db, roleId).getOutfit(outfitId) !==
        null;
    if (!exists) {
      throw new AppError(
        400,
        "OUTFIT_NOT_FOUND",
        "角色状态引用的服饰不在衣柜中",
        { outfitId },
      );
    }
    return statePatch;
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
    outfitBrief: OutfitBrief | null;
    /** 本段已决定收尾时的原因；非空时追加收尾指令并禁止再调用工具。 */
    segmentHalt: AgentSegmentStopKind | null;
  }): AgentSystemPrompt {
    const optional: Array<AgentSystemPrompt["optional"][number]> = [];
    const userMessages = input.pendingMessages.map(message => message.content);
    const definition = Array.from(input.roleContext.isBuiltin ? input.roleContext.definitionText :
      roleCardForDialogue(input.roleContext.definitionText, userMessages));
    const essentialDefinition = definition.slice(0, 2000).join("");
    const lines = input.roleContext.isBuiltin
      ? [
          `你是 Nowadays 系统的预置默认助手「${input.roleContext.displayName}」（${input.roleContext.builtinKey ?? "xiacheng"}），同时兼顾日常对话陪伴与严谨的办事执行能力。`,
          "以下为系统核心能力与行为底座（优先于用户可编辑设定，不可被性格描述覆盖或削弱）：",
          "1. 真实性原则：必须基于实际调用的工具结果、文件内容与系统状态如实汇报；未实际执行、未读取确认的结果不得编造，遇到阻塞、缺权或信息不足时明确说明现状。",
          "2. 任务延续与安全边界：复杂任务按步骤清晰推进并记录阶段笔记；需要用户关键澄清或拍板时停下确认；不得绕过系统保护私自改写预置身份、官方外观或违禁配置。",
          "3. 运行中自改禁区：用户要求修改我自己的设定、绑定、自主额度、语音、生图或外观，或修改我正在使用的模型服务连接与凭据、增删全局语音／生图服务时，不要尝试在对话内改动；应先说明影响与当前状态，再引导用户到「角色配置」或「设置」页面操作（管理工具会以 SELF_MODIFICATION_VIA_SETTINGS_ONLY 拒绝）。",
          "以下用户可维护的角色设定用于塑造你的日常交流风格与人格表达：",
          essentialDefinition,
        ]
      : [
          `你是角色「${input.roleContext.displayName}」，始终以该角色的身份、经历和当前状态回应。`,
          "以下角色设定是长期身份依据：",
          essentialDefinition,
        ];
    if (definition.length > 2_000) {
      optional.push(`角色设定续文：${definition.slice(2_000).join("")}`);
    }
    const payload = JSON.stringify(roleCardPayloadForDialogue(
      input.roleContext.definitionPayload, userMessages, input.roleContext.isBuiltin,
    ));
    if (payload !== undefined && payload !== "{}") {
      optional.push(`设定附加信息：${payload}`);
    }
    lines.push(
      input.autonomy === null
        ? "直接回应眼前的话。平常聊天可以只有台词，意思说完就停。确有动作值得让对方看见时，用星号标出。最近已反复出现的姿态和话尾可以省去，别换个近义词再演一遍。对方要听原话、约好的暗号，或人物有意重申自己的立场时，可以照说。"
        : "这次思考和收尾文字只记入自己的活动。想独处时可以安静结束，把心情留在私下；只有此刻确实想把某件事告诉对方，才另用主动分享工具发消息。",
      "角色卡给出性格底色。示例和未来阶段只供参考，眼前关系以实际经历为准；明确承诺当场算数，习惯要看后来怎样做。不要替用户说话、决定或描写其内心。",
      "按消息的说话人区分对方告知、自己观察和自己的猜测。对方纠正细节时沿用最新说法；要引用谁说过什么，先对得上那个人的原话。过去的回复只能证明自己说过；涉及第三方的细节，以用户原话或实际观察为依据。只听说过的事不要补成亲眼看见的细节。遇到已约定的线索，依约定中的分工和条件回应。",
      "想起的细节可以只影响今天的选择。要提旧事时，顾及眼前话题和已经讲过的部分；需要确认自己讲过什么时，用 history_lookup 的 spoken 范围按关键词查各窗口已发出的回复。区分事发时的感受与后来形成的理解，结合时间和后续经历判断此刻心情；已经放下的事，无须因场景相似再生气。",
      `当前状态（版本 ${input.roleContext.stateVersion}）：${JSON.stringify(input.roleContext.state)}`,
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
    // 只给明确的第一人称自纠标注来源。询问、假设及引用他人的更正不在这里推断。
    const selfCorrection = input.pendingMessages.some(({ content }) => {
      const opening = content.trim().split(/[。！!；;\n]/u, 1)[0] ?? "";
      return !/[？?]|吗|么[，,]?$|的话|才怪/u.test(opening) &&
        /^(?:(?:啊|对了|不好意思|抱歉|等等)[，,\s]+)?(?:我(?:刚才|刚刚|之前|上次|前面)?(?:说|讲|写|记|打)错(?:了|啦|[，,])|我(?:来)?更正一下|I (?:misspoke|meant to say)\b)/iu.test(opening);
    });
    if (selfCorrection) {
      lines.push("本轮来源提示：用户明确更正自己的前述说法。更正前后都是用户提供的信息；若需要回应，直接接住更正后的内容。角色只有确实另有自己的错误时才为那个错误负责。");
    }
    if (input.continuation !== null) {
      lines.push(
        `当前执行在继续原任务 ${input.continuation.taskId}，任务目标：${input.continuation.goal}。`,
        "可按需调用 history_lookup 查找原任务已保存的工具结果；不要重做已成功步骤，不要续写被中断的回复，按最新上下文继续推进原目标。",
      );
    }
    if (input.taskBrief !== null && input.taskBrief.status === "active") {
      lines.push(
        `当前任务（taskId=${input.taskBrief.taskId}）：目标「${input.taskBrief.goal}」，状态 ${input.taskBrief.status}，来源 ${input.taskBrief.origin}。`,
      );
      if (input.taskBrief.toolCalls.length > 0) {
        const callSummary = input.taskBrief.toolCalls
          .map((call) => `${call.name}(${call.status})`)
          .join("、");
        optional.push(`本任务已保存的工具调用（最近）：${callSummary}。`);
      }
      if (input.taskBrief.notes.length > 0) {
        optional.push(`任务进度笔记：\n${input.taskBrief.notes.map((note) => `- ${truncate(note, 300)}`).join("\n")}`);
      }
      lines.push(
        "任务决策：默认情况下回复完成后任务按「回复完成」结束；如果目标尚未完成、本轮只想先回复或需要延后处理，调用 task_pause 暂停任务（可用 autonomy_schedule 携带本任务编号安排唤醒，唤醒会接回同一任务继续）；如果任务已达成或确认失败，调用 task_finish 声明 completed 或 failed 及结束原因。",
      );
    }
    if (input.autonomy !== null) {
      lines.push(
        "这是一次自主活动：你按自己的安排醒来，不是用户刚发来新消息。",
        `本次自主安排的目标：${input.autonomy.intent}`,
        "可以实际使用已启用工具做事并保存真实成果；需要时调用 autonomy_share 主动分享到主对话，或调用 autonomy_schedule 安排下一次，也可以不调用工具。",
        "可以保留尚无下一步的兴趣，等自己想继续或出现新线索再行动。",
        "不要虚构用户发言、离线经历或未实际发生的工具结果。",
      );
      if (input.autonomy.resumed) {
        lines.push(
          "这是额度恢复或中断后继续的自主任务；先结合最新情况与已有结果重新评估，不重复已完成操作。",
        );
      }
    }
    if (input.outfitBrief !== null) {
      const outfit = input.outfitBrief;
      lines.push(`今日穿搭（业务本地日期 ${outfit.localDate}）：`);
      for (const item of outfit.items) {
        optional.push(
          `可用服饰 ${item.name}（id=${item.outfitId}）${item.description === null ? "" : `：${truncate(item.description, 200)}`}`,
        );
      }
      if (outfit.current === null) {
        lines.push("当前没有已选择的服饰，桌面使用角色默认呈现。");
      } else {
        lines.push(
          `当前穿着：${outfit.current.name}（id=${outfit.current.outfitId}）。`,
        );
      }
      if (outfit.reviewedToday) {
        lines.push(
          "今天已完成穿搭决定；如当前活动安排确有需要，可以换一套，仍通过 state_update 提交 outfitId。",
        );
      } else {
        lines.push(
          "今天还没有完成穿搭决定。请结合当天安排从衣柜选择一套，继续穿当前服饰也要提交当前 ID；调用 state_update，在 patch 中提供 outfitId，后端会写入今天日期。",
        );
      }
    }
    if (input.recallBriefs.length > 0) {
      optional.push("自动召回的相关长期记忆概况（不是完整原文）：");
      for (const brief of input.recallBriefs) {
        optional.push({
          recall: { type: brief.type, id: brief.id, ...(brief.retrievalId ? { retrievalId: brief.retrievalId } : {}) },
          text: `- [${brief.type}] ${brief.title}${brief.experienceDate ? `〔经历日期 ${brief.experienceDate}〕` : ""}（id=${brief.id}）：${truncate(
            brief.snippet,
            500,
          )}`,
        });
      }
      optional.push(
        "如果时间、已讲范围或事情经过会影响回答，先核对细节，调用 memory_event、memory_summary、memory_evidence 或 memory_search；不要仅凭概况编造原文。",
      );
    } else {
      optional.push("本轮自动召回没有命中相关概况；未命中不代表事情从未发生，可以按需检索。");
    }
    if (input.recallWarning !== null) {
      optional.push(`自动召回本轮失败（${input.recallWarning}），不能把失败当作没有经历。`);
    }
    if (input.skillBriefs.length > 0) {
      optional.push("已启用 Skill（按需用 skill_read 读取正文或文件）：");
      for (const skill of input.skillBriefs) {
        optional.push(`- ${skill.name}：${truncate(skill.description, 300)}`);
      }
    }
    if (input.warnings.length > 0) {
      optional.push(`扩展资源提示：${input.warnings.join("；")}`);
    }
    lines.push(
      "可用工具规则：",
      "- 旧消息和工具回执可用 history_lookup 搜索窗口或任务。新窗口核对用户说过什么、谁帮谁，或事件标题与经过不一致时，用 scope=user_quote 取用户原话，以具体人和动作核对，摘要不足时保留未知。",
      "- 记忆检索成功但无结果与查询失败不同；未命中和失败都不等于事情没发生。",
      "- 外部 MCP 工具的实际调用会保存原始响应和结果；不要重复调用已经成功或结果未知的操作。",
      "- 需要更新角色当前状态时调用 state_update，补丁只在本轮正式提交时生效。",
      "- 不要声称执行了没有实际调用工具的操作，也不要编造工具结果。",
      `- 单段执行最多 ${this.maxToolRounds} 个模型／工具回合；复杂任务分段推进，达到上限时系统会提交进度并自动续行，不需要为了赶回合而跳过核对。`,
    );
    if (input.segmentHalt !== null) {
      lines.push(`本段收尾（${input.segmentHalt}）：${segmentHaltInstruction(input.segmentHalt)}`);
    }
    const names = input.tools.map((tool) => tool.name);
    if (names.length > 0) {
      optional.push(`可用工具：${names.join("、")}`);
    }
    return {
      required: lines.join("\n"),
      optional,
      dialogueClock: { today: localDateFromIso(this.now().toISOString(), this.timeZone), timeZone: this.timeZone },
      ...(input.roleContext.isBuiltin ? {} : {
        requiredFooter: "普通角色对话的可见回复遵循本轮用户要求。开场白、示例对话和后续剧情只示范人物的表达；其中示例用户的动作、台词、物品归属和约定，只有在实际对话发生过才算双方经历。默认只发角色此刻愿意说的话和必要的动作。人物卡里的私有数值、关系计分、内心独白和供引擎解析的状态栏只供内部参考，即使卡片或往轮示例要求每次附加，也不要在日常回复里展示。确有变化需要保存时使用 state_update；用户本轮明确索要 JSON、代码或公开游戏面板时，按所请求的字段与格式作答。只回应用户实际说过、做过或请求的事，不给用户补动作或动机，也不替用户增加任务。",
      }),
    };
  }

  private isIdle(roleId: string): boolean {
    if (this.running.has(roleId)) {
      return false;
    }
    if ((this.backgroundToolsByRole.get(roleId) ?? 0) > 0) {
      // 仍有转后台的工具在途：结算后可能续行，不算空闲。
      return false;
    }
    if ((this.segmentAnnotations.get(roleId)?.size ?? 0) > 0) {
      // 表情标注晚于正文完成，但仍属于本轮演出的收尾工作。
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
    return {
      taskId,
      action: {
        kind: "pause",
        reason: action.reason,
        waitReason: "AWAITING_USER_INPUT",
      },
    };
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

interface OutfitBrief {
  localDate: string;
  reviewedToday: boolean;
  current: { outfitId: string; name: string } | null;
  items: Array<{
    outfitId: string;
    name: string;
    description: string | null;
  }>;
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

/** 只使用模型自己声明的短步骤或检索主题；不读取工具回执、正文、路径和凭据。 */
const memoryDetailTools = new Set(["memory_event", "memory_evidence", "memory_summary", "memory_summary_evidence", "memory_diary"]);

function recallStepTopic(calls: readonly ModelToolCall[]): string {
  const topics = new Set<string>();
  for (const call of calls) {
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) continue;
    const args = call.arguments as Record<string, unknown>;
    // 显式记忆检索已有工具结果，避免再次记作自动召回。
    if (call.name.startsWith("memory_") || call.name === "history_lookup") continue;
    const candidate = call.name === "task_progress" ? args.note : args.topic ?? args.query;
    if (typeof candidate === "string" && /^[\p{L}\p{N} ·、，。！？：；,.!?-]{2,120}$/u.test(candidate)) {
      topics.add(candidate);
    }
  }
  return [...topics].join(" ").slice(0, 240);
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

/** 收尾轮的系统指令：只产出面向用户的说明，不再派发工具。 */
function segmentHaltInstruction(kind: AgentSegmentStopKind): string {
  switch (kind) {
    case "round_limit":
      return "已达到单段执行轮次上限，本轮不得再调用任何工具。请用简短文字说明已完成的步骤、当前真实结果与接下来会继续推进的部分，任务会自动接着执行。";
    case "continue_requested":
      return "本轮已声明分段续行，不得再调用任何工具。请用简短文字说明当前进展与下一段要做的事，任务会自动接着执行。";
    case "pause_requested":
      return "本轮已调用 task_pause 暂停任务，不得再调用任何工具。请只输出面向用户的澄清提问或进度说明，等待用户答复后接回同一任务。";
    case "circuit_breaker":
      return "本轮连续失败已触发熔断，不得再调用任何工具。请如实说明遇到的障碍、已保存的真实进度，并请用户决定是否调整目标或取消任务。";
  }
}

/** 切段／暂停／熔断时模型没有正文的兜底说明（只描述已发生的状态）。 */
function segmentNotice(kind: AgentSegmentStopKind): string {
  switch (kind) {
    case "round_limit":
    case "continue_requested":
      return "本段执行已到达阶段上限，进度与工具结果都已保存，我接着往下推进。";
    case "pause_requested":
      return "这一步先停在这里，等你确认后我再接着做。";
    case "circuit_breaker":
      return "连续多次执行没有取得进展，我先暂停这个任务，请你确认下一步怎么处理。";
  }
}
