import { RoleExchangeService } from "./role-exchanges.js";
import { DialogueBatchDelivery } from "./dialogue-batch-delivery.js";
import type {
  ConversationExecutionDetail,
  ConversationWaitReason,
} from "../../domain/conversation.js";
import { AppError } from "../../domain/errors.js";
import type { RoleActivityGate } from "../../domain/role-activity.js";
import { resolveCredential } from "../../model/credentials.js";
import { HttpModelAdapter } from "../../model/protocols.js";
import type { AppStore } from "../../storage/core/app-store.js";
import { ConversationStore } from "../../storage/conversation/conversation-store.js";
import type { AutonomyService } from "./autonomy-service.js";
import type { CredentialResolver } from "../resources/credential-resolver.js";
import { InputStateRegistry } from "./input-state.js";
import type { MemoryQueryService } from "../memory/memory-query-service.js";
import type { MemoryRuntime } from "../memory/memory-runtime.js";
import type {
  ModelBindingResolver,
  ResolvedModelBinding,
} from "../resources/model-binding-resolver.js";
import type { ModelCallClaim } from "../resources/model-maintenance.js";
import type { RoleAccess } from "../role/role-access.js";
import {
  SegmentAnnotationService,
  type SegmentAnnotationServiceOptions,
} from "./segment-annotation-service.js";
import type { TokenUsageCallEvent } from "../../domain/token-usage.js";
import type { AdminToolServices } from "../role/admin-tools.js";
import type { MessageRecord, SubmitMessageInput, SubmitMessageResult, TaskRecord } from "../../storage/role/role-store.js";
import { DEFAULT_MAX_TOOL_ROUNDS } from "./agent-graph.js";
import {
  type ChatModelPortFactory,
  type ConversationContext,
  type ConversationState,
  type QueueSegmentAnnotationInput,
  type StreamEventsInput,
} from "./conversation-internal-types.js";
import { ConversationPromptBuilder, windowKey } from "./conversation-prompt-builder.js";
import { ConversationStreamHub } from "./conversation-stream-hub.js";
import { ConversationRecovery } from "./conversation-recovery.js";
import { ConversationExecutionRunner } from "./conversation-execution-runner.js";
import { ConversationScheduler } from "./conversation-scheduler.js";
import { StaticTokenCountCache } from "./context-budget.js";
import {
  tryCommitWindowSummary,
  type ProposedWindowCompaction,
  type WindowCyclePolicy,
  type WindowSummaryCompactor,
} from "./window-context-cycle.js";
import { mergeModelUsage } from "../../domain/token-usage.js";
import type { ModelUsage } from "../../domain/model.js";

export type { ChatModelPortFactory } from "./conversation-internal-types.js";

/** 外部工具前台等待窗口原型默认值；越过后自动转后台，等待时长仍待真实工具联调校准。 */
export const DEFAULT_TOOL_FOREGROUND_WAIT_MS = 2_000;

export interface ConversationServiceOptions {
  batchDelayMs?: number;
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
  /** 模型调用结束时上报全局 Token 账本（DL-183）。 */
  onModelCallFinished?: (event: TokenUsageCallEvent) => void;
  /** 主对话 30+n 窗口历史周期策略（DL-202）。 */
  windowCycle?: WindowCyclePolicy;
  /** 可选自定义窗口滚动摘要整理器（测试或扩展注入）。 */
  windowSummaryCompactor?: WindowSummaryCompactor;
}

export interface SubmitConversationResult extends SubmitMessageResult {
  decisionScheduled: boolean;
  /** 未安排回复时的可读原因；已安排或重复找回且可调度时为 null。 */
  waitReason: ConversationWaitReason | null;
}

export class ConversationService {
  readonly inputStates: InputStateRegistry;
  readonly exchanges: RoleExchangeService;
  readonly batchDelivery: DialogueBatchDelivery;
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private readonly state: ConversationState;
  private readonly context: ConversationContext;
  private readonly prompt: ConversationPromptBuilder;
  private readonly streams: ConversationStreamHub;
  private readonly recovery: ConversationRecovery;
  private readonly runner: ConversationExecutionRunner;
  private readonly scheduler: ConversationScheduler;
  // 供既有白盒恢复与续行测试直接观察任务目录与待续行队列，指向共享状态实例。
  private get taskCatalogs() {
    return this.state.taskCatalogs;
  }
  private get pendingContinuations() {
    return this.state.pendingContinuations;
  }

  constructor(
    private readonly appStore: AppStore,
    private readonly roleAccess: RoleAccess,
    private readonly bindings: ModelBindingResolver,
    private readonly memory: MemoryQueryService,
    private readonly appRoot: string,
    options: ConversationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
    const batchDelayMs = options.batchDelayMs;
    const autoRecallLimit = options.autoRecallLimit ?? 8;
    const maxToolRounds =
      options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const toolForegroundWaitMs =
      options.toolForegroundWaitMs ?? DEFAULT_TOOL_FOREGROUND_WAIT_MS;
    const credentials = options.credentialResolver ?? null;
    const usesHttpModel = options.modelPortFactory === undefined;
    const memoryRuntime = options.memoryRuntime ?? null;
    const autonomy = options.autonomy ?? null;
    const activity = options.activity ?? null;
    const isResourceUnderMaintenance =
      options.isResourceUnderMaintenance ?? null;
    const waitForMaintenanceEnd = options.waitForMaintenanceEnd ?? null;
    const hasExternalWork = options.hasExternalWork ?? (() => false);
    const adminServices = options.adminServices ?? null;
    const onModelCallFinished = options.onModelCallFinished;
    const extensions = options.adminServices?.extensions;
    const resolveModelCredential = (
      binding: ResolvedModelBinding,
    ): string | undefined => {
      const reference = binding.config.credentialRef;
      return credentials === null
        ? resolveCredential(this.appRoot, reference)
        : credentials.resolve(binding.resourceId, reference);
    };
    this.batchDelivery = new DialogueBatchDelivery(appStore, roleAccess, this.now, id => this.refreshWakeTimer(id),
      batch => extensions?.publish("dialogue_batch", batch));
    this.exchanges = new RoleExchangeService(appStore, roleAccess, this.now,
      id => activity?.canStart(id) ?? true, id => this.refreshWakeTimer(id),
      id => memoryRuntime?.kick(id), this.timeZone, session => extensions?.publish("role_exchange", session));
    const modelFactory: ChatModelPortFactory = options.modelPortFactory ??
      ((binding) =>
        new HttpModelAdapter(
          binding.config,
          resolveModelCredential(binding),
        ));
    const segmentAnnotation = new SegmentAnnotationService(
      roleAccess,
      bindings,
      {
        now: this.now,
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
        modelFactory,
        autonomy,
        maintenance:
          isResourceUnderMaintenance === null ||
          waitForMaintenanceEnd === null
            ? null
            : {
                isUnder: isResourceUnderMaintenance,
                wait: waitForMaintenanceEnd,
              },
        claim:
          options.claimModelCall === undefined ||
          options.claimModelCall === null
            ? null
            : { claim: options.claimModelCall },
        ...(options.resolveVoiceRuntime === undefined
          ? {}
          : { resolveVoiceRuntime: options.resolveVoiceRuntime }),
        ...(onModelCallFinished === undefined
          ? {}
          : { onModelCallFinished }),
      },
    );
    this.inputStates = new InputStateRegistry({
      typingMs: options.typingMs ?? 1000,
      now: this.now,
      onExpire: (roleId) => {
        void this.scheduler.schedule(roleId);
      },
    });
    const state: ConversationState = {
      running: new Map(),
      inflightResources: new Map(),
      detached: new Set(),
      segmentAnnotations: new Map(),
      annotationControllers: new Set(),
      annotationWaitControllers: new Map(),
      backgroundToolSettles: new Set(),
      backgroundToolsByRole: new Map(),
      backgroundToolsByTask: new Map(),
      wakeTimers: new Map(),
      firstActivationCredentialTimers: new Map(),
      dueWakeChecks: new Map(),
      pendingContinuations: new Map(),
      taskCatalogs: new Map(),
      closingTaskCatalogs: new Set(),
      catalogClosePending: new Set(),
      activeStreams: new Map(),
      blockedWindows: new Set(),
      windowCompactions: new Map(),
      closed: false,
    };
    const context = { state } as unknown as ConversationContext;
    Object.assign(context, {
      appStore,
      roleAccess,
      bindings,
      memory: this.memory,
      appRoot: this.appRoot,
      now: this.now,
      timeZone: this.timeZone,
      batchDelayMs,
      autoRecallLimit,
      maxToolRounds,
      toolForegroundWaitMs,
      modelFactory,
      usesHttpModel,
      credentials,
      segmentAnnotation,
      memoryRuntime,
      autonomy,
      activity,
      isResourceUnderMaintenance,
      waitForMaintenanceEnd,
      hasExternalWork,
      adminServices,
      onModelCallFinished,
      inputStates: this.inputStates,
      exchanges: this.exchanges,
      batchDelivery: this.batchDelivery,
      resolveModelCredential,
      tokenCountCache: new StaticTokenCountCache(),
      windowCycle: options.windowCycle,
      windowSummaryCompactor: options.windowSummaryCompactor,
      autoScenes: null,
    });
    this.state = state;
    this.context = context;
    this.prompt = new ConversationPromptBuilder(context);
    this.streams = new ConversationStreamHub(context);
    this.runner = new ConversationExecutionRunner(context);
    this.scheduler = new ConversationScheduler(context);
    this.recovery = new ConversationRecovery(context);
    context.prompt = this.prompt;
    context.streams = this.streams;
    context.runner = this.runner;
    context.scheduler = this.scheduler;
    context.recovery = this.recovery;
    context.schedule = (roleId) => this.scheduler.schedule(roleId);
    context.withConversationStore = <T>(
      roleId: string,
      action: (store: ConversationStore) => T,
    ): T => {
      const lease = this.roleAccess.borrow(roleId);
      const storage = lease.storage;
      try {
        return action(
          new ConversationStore(storage.business.db, roleId, this.timeZone),
        );
      } finally {
        lease.release();
      }
    };
    context.queueSegmentAnnotation = (input) => this.queueSegmentAnnotation(input);
    context.scheduleWindowCompaction = (plan) => this.scheduleWindowCompaction(plan);
  }

  setSceneImageService(service: import("../media/scene-image-service.js").SceneImageService): void {
    this.context.autoScenes = service;
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
      this.state.blockedWindows.delete(windowKey(roleId, windowId));
      const reason = this.scheduler.roleWaitReason(roleId, windowId);
      const decisionScheduled =
        reason === null ? this.scheduler.schedule(roleId) : false;
      return {
        ...result,
        decisionScheduled,
        waitReason: decisionScheduled ? null : (reason ?? "QUEUE_PENDING"),
      };
    }
    this.state.blockedWindows.delete(windowKey(roleId, windowId));
    this.scheduler.supersedeWindow(roleId, windowId);
    const decisionScheduled = this.scheduler.schedule(roleId);
    return {
      ...result,
      decisionScheduled,
      waitReason: decisionScheduled
        ? null
        : (this.scheduler.roleWaitReason(roleId, windowId) ?? "QUEUE_PENDING"),
    };
  }

  /** 只重派当前失败尝试所对应的已收消息，过时的按钮不能唤醒其他消息。 */
  retryFailedReply(roleId: string, windowId: string, messageId: string, executionId: string): SubmitConversationResult {
    const message = this.context.withConversationStore(roleId, (store) => {
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
  queueSegmentAnnotation(input: QueueSegmentAnnotationInput): void {
    if (this.state.closed) {
      return;
    }
    const controller = new AbortController();
    const waitController = new AbortController();
    this.state.annotationControllers.add(controller);
    const waits =
      this.state.annotationWaitControllers.get(input.roleId) ??
      new Set<AbortController>();
    waits.add(waitController);
    this.state.annotationWaitControllers.set(input.roleId, waits);
    let task: Promise<void>;
    task = this.context.segmentAnnotation
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
        this.state.annotationControllers.delete(controller);
        const remainingWaits = this.state.annotationWaitControllers.get(input.roleId);
        if (remainingWaits !== undefined) {
          remainingWaits.delete(waitController);
          if (remainingWaits.size === 0) {
            this.state.annotationWaitControllers.delete(input.roleId);
          }
        }
        const tasks = this.state.segmentAnnotations.get(input.roleId);
        if (tasks !== undefined) {
          tasks.delete(task);
          if (tasks.size === 0) {
            this.state.segmentAnnotations.delete(input.roleId);
          }
        }
        void this.context.schedule(input.roleId);
      });
    const tasks =
      this.state.segmentAnnotations.get(input.roleId) ?? new Set<Promise<void>>();
    tasks.add(task);
    this.state.segmentAnnotations.set(input.roleId, tasks);
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
    return this.context.segmentAnnotation.awaitMessage(messageId, timeoutMs, signal);
  }

  cancelQueuedAnnotations(roleId: string): void {
    const waits = this.state.annotationWaitControllers.get(roleId);
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
      this.context.schedule(input.roleId);
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
    this.context.schedule(input.roleId);
    return { cleared: true };
  }

  getExecution(
    roleId: string,
    executionId: string,
  ): ConversationExecutionDetail {
    return this.context.withConversationStore(roleId, (store) =>
      store.getExecutionDetail(executionId),
    );
  }

  runMemoryPending(roleId: string): Promise<void> {
    if (this.context.memoryRuntime === null) {
      return Promise.resolve();
    }
    return this.context.memoryRuntime.runPending(roleId);
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
    return this.runner.finishTask(input);
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
    return this.runner.cancelTask(input);
  }

  waitForIdle(roleId: string, timeoutMs = 15_000): Promise<void> {
    return this.scheduler.waitForIdle(roleId, timeoutMs);
  }

  /**
   * 删除角色前确认没有前台执行、后台工具、差分标注或待续行。
   * 与 isIdle 不同，不把「已领取但被停止搁置的待处理窗口」算作在途。
   */
  waitForQuiescent(roleId: string, timeoutMs = 15_000): Promise<void> {
    return this.scheduler.waitForQuiescent(roleId, timeoutMs);
  }

  /** 关闭该角色的事件流：删除角色目录前释放角色库句柄。 */
  closeStreams(roleId: string): void {
    this.streams.closeStreams(roleId);
  }

  /** 清掉该角色的定时器、待续行、输入状态与工具目录；角色索引移除前调用。 */
  async disposeRole(roleId: string): Promise<void> {
    this.streams.closeStreams(roleId);
    const timer = this.state.wakeTimers.get(roleId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.state.wakeTimers.delete(roleId);
    }
    this.state.dueWakeChecks.delete(roleId);
    this.scheduler.clearFirstActivationCredentialRetry(roleId);
    this.state.pendingContinuations.delete(roleId);
    this.state.backgroundToolsByRole.delete(roleId);
    this.state.segmentAnnotations.delete(roleId);
    const waits = this.state.annotationWaitControllers.get(roleId);
    if (waits !== undefined) {
      for (const controller of waits) controller.abort();
      this.state.annotationWaitControllers.delete(roleId);
    }
    for (const key of [...this.state.blockedWindows]) {
      if (key.startsWith(`${roleId}\u0000`)) {
        this.state.blockedWindows.delete(key);
      }
    }
    this.inputStates.clearRole(roleId);
    const compactions = [...this.state.windowCompactions.entries()].filter(
      ([, entry]) => entry.roleId === roleId,
    );
    for (const [key, entry] of compactions) {
      entry.controller.abort();
      await entry.promise.catch(() => undefined);
      if (this.state.windowCompactions.get(key) === entry) {
        this.state.windowCompactions.delete(key);
      }
    }
    const catalogs = [...this.state.taskCatalogs.entries()].filter(
      ([, entry]) => entry.roleId === roleId,
    );
    for (const [taskId, entry] of catalogs) {
      this.state.taskCatalogs.delete(taskId);
      this.state.catalogClosePending.delete(taskId);
      await entry.catalog.close();
    }
  }

  /** 等待指定角色（或全部角色）当前在途的窗口滚动摘要整理收尾；供测试与关闭收口使用。 */
  async waitForWindowCompactions(roleId?: string): Promise<void> {
    const tasks = [...this.state.windowCompactions.values()]
      .filter((entry) => roleId === undefined || entry.roleId === roleId)
      .map((entry) => entry.promise);
    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  /** 按窗口去重调度 30+n 滚动历史摘要整理；失败或未覆盖全部待移出历史时保留旧周期。 */
  private scheduleWindowCompaction(plan: ProposedWindowCompaction): void {
    if (this.state.closed) return;
    if (this.context.activity !== null && !this.context.activity.canStart(plan.roleId)) {
      return;
    }
    const key = windowKey(plan.roleId, plan.windowId);
    if (this.state.windowCompactions.has(key)) return;
    const controller = new AbortController();
    const promise = this.runWindowCompaction(plan, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.state.windowCompactions.get(key)?.controller === controller) {
          this.state.windowCompactions.delete(key);
        }
      });
    this.state.windowCompactions.set(key, {
      roleId: plan.roleId,
      controller,
      promise,
    });
  }

  private async runWindowCompaction(
    plan: ProposedWindowCompaction,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.state.closed || signal.aborted) return;
    const compactor: WindowSummaryCompactor =
      this.context.windowSummaryCompactor ??
      ((input) => this.defaultWindowSummaryCompactor(input));
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("WINDOW_COMPACTION_ABORTED"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("WINDOW_COMPACTION_ABORTED")),
        { once: true },
      );
    });
    const result = await Promise.race([
      compactor({
        roleId: plan.roleId,
        windowId: plan.windowId,
        previousSummary: plan.previousSummaryText,
        previousCoveredUntilSequence: plan.previousCoveredUntilSequence,
        evictedMessages: plan.evictedMessages,
        targetCoveredUntilSequence: plan.targetCoveredUntilSequence,
        signal,
      }),
      aborted,
    ]);
    if (this.state.closed || signal.aborted) return;
    this.roleAccess.withStore(plan.roleId, (storage) => {
      tryCommitWindowSummary(storage.business.db, {
        windowId: plan.windowId,
        roleId: plan.roleId,
        expectedSummaryVersion: plan.previousSummaryVersion,
        summaryText: result.summaryText,
        coveredUntilSequence: result.coveredUntilSequence,
        proposedLeftSequence: plan.proposedLeftSequence,
        latestCommittedSequence: plan.latestCommittedSequence,
        now: this.now().toISOString(),
      });
    });
  }

  private async defaultWindowSummaryCompactor(
    input: Parameters<WindowSummaryCompactor>[0],
  ): Promise<{ summaryText: string; coveredUntilSequence: number }> {
    const binding =
      this.bindings.resolveMemory(input.roleId) ??
      this.bindings.resolveChat(input.roleId);
    if (this.context.isResourceUnderMaintenance?.(binding.resourceId) === true) {
      throw new Error("WINDOW_COMPACTION_RESOURCE_MAINTENANCE");
    }
    const transcript = input.evictedMessages
      .map((msg) => `#${msg.sequence} [${msg.sender === "user" ? "用户" : "角色"}]: ${msg.content}`)
      .join("\n");
    const promptLines = [
      "你是窗口历史滚动摘要整理器。请把较早的窗口对话压缩成客观、简洁、可继续衔接的中文摘要。",
      "要求：保留关键事实、约定、任务进展、已做决定与未完成事项；区分用户所说与角色所说；不编造未出现的信息。",
      ...(input.previousSummary.trim().length > 0
        ? [`已有历史摘要（覆盖至 #${input.previousCoveredUntilSequence}）：\n${input.previousSummary.trim()}`]
        : []),
      `新增待并入的早期消息（截止序号 #${input.targetCoveredUntilSequence}）：\n${transcript}`,
    ];
    const port = this.context.modelFactory(binding);
    let summaryText = "";
    let usage: ModelUsage | null = null;
    try {
      for await (const event of port.stream({
        modelName: binding.modelName,
        resourceId: binding.resourceId,
        system: "输出纯文本中文滚动摘要，不附额外寒暄。",
        messages: [{ role: "user", content: promptLines.join("\n\n") }],
        tools: [],
        maxOutputTokens: 2_048,
        signal: input.signal,
      })) {
        if (event.type === "text_delta") summaryText += event.text;
        else if (event.type === "usage") usage = mergeModelUsage(usage, event);
      }
      this.context.onModelCallFinished?.({
        sourceCallId: `window-compact:${input.windowId}:${input.targetCoveredUntilSequence}:${Date.now()}`,
        occurredAt: this.now().toISOString(),
        category: "memory",
        roleId: input.roleId,
        resourceId: binding.resourceId,
        ...(binding.config.provider === undefined ? {} : { provider: binding.config.provider }),
        modelName: binding.modelName,
        protocol: binding.config.protocol,
        status: "succeeded",
        usage,
      });
    } catch (error) {
      this.context.onModelCallFinished?.({
        sourceCallId: `window-compact:${input.windowId}:${input.targetCoveredUntilSequence}:${Date.now()}`,
        occurredAt: this.now().toISOString(),
        category: "memory",
        roleId: input.roleId,
        resourceId: binding.resourceId,
        ...(binding.config.provider === undefined ? {} : { provider: binding.config.provider }),
        modelName: binding.modelName,
        protocol: binding.config.protocol,
        status: "failed",
        usage,
      });
      throw error;
    }
    return {
      summaryText: summaryText.trim(),
      coveredUntilSequence: input.targetCoveredUntilSequence,
    };
  }

  streamEvents(input: StreamEventsInput): Promise<void> {
    return this.streams.streamEvents(input);
  }

  recoverOnStartup(): number {
    return this.recovery.recoverOnStartup();
  }

  async close(): Promise<void> {
    this.state.closed = true;
    this.batchDelivery.close();
    for (const entry of this.state.windowCompactions.values()) {
      entry.controller.abort();
    }
    if (this.state.windowCompactions.size > 0) {
      await Promise.allSettled(
        [...this.state.windowCompactions.values()].map((entry) => entry.promise),
      );
      this.state.windowCompactions.clear();
    }
    for (const timer of this.state.wakeTimers.values()) {
      clearTimeout(timer);
    }
    this.state.wakeTimers.clear();
    for (const timer of this.state.firstActivationCredentialTimers.values()) {
      clearTimeout(timer);
    }
    this.state.firstActivationCredentialTimers.clear();
    this.state.dueWakeChecks.clear();
    for (const cleanup of [...this.state.activeStreams.keys()]) {
      cleanup();
    }
    this.inputStates.close();
    const active = [...this.state.running.values(), ...this.state.detached];
    for (const running of active) {
      running.superseded = true;
      running.controller.abort();
    }
    await Promise.allSettled(active.map((running) => running.promise));
    const backgroundSettles = [...this.state.backgroundToolSettles];
    if (backgroundSettles.length > 0) {
      await Promise.allSettled(backgroundSettles);
    }
    for (const controller of this.state.annotationControllers) {
      controller.abort();
    }
    for (const waits of this.state.annotationWaitControllers.values()) {
      for (const controller of waits) controller.abort();
    }
    const annotations = [...this.state.segmentAnnotations.values()].flatMap(
      (tasks) => [...tasks],
    );
    if (annotations.length > 0) {
      await Promise.allSettled(annotations);
    }
    const catalogs = [...this.state.taskCatalogs.values()];
    this.state.taskCatalogs.clear();
    await Promise.allSettled(catalogs.map((entry) => entry.catalog.close()));
    await this.context.memoryRuntime?.close();
  }

  /** 是否还有属于该角色的执行或后台工具在跑；停止确认据此判断是否要等边界。 */
  isRunning(roleId: string): boolean {
    return this.scheduler.isRunning(roleId);
  }

  /** 正在使用目标模型服务的执行角色；不受当前绑定变化影响（283 §7 R01）。 */
  inflightRoleIds(resourceId: string): string[] {
    return this.scheduler.inflightRoleIds(resourceId);
  }

  runDueAutonomy(roleId: string): boolean {
    return this.scheduler.runDueAutonomy(roleId);
  }

  refreshWakeTimer(roleId: string): void {
    this.scheduler.refreshWakeTimer(roleId);
  }

  /**
   * 后台记忆整理等外部工作收尾后的空闲通知（283 §4 R01）。
   * 停止请求可能只等这些调用；这里在它们真正结束后确认停止。
   */
  notifyExternalIdle(roleId: string, executionId: string | null = null): void {
    this.scheduler.notifyExternalIdle(roleId, executionId);
  }

  /**
   * 模型恢复、绑定修复或维护结束后重新检查已有待处理工作（283 R02）。
   * 不传角色时覆盖所有已初始化角色；停止中的角色由统一调度跳过。
   */
  wakePendingWork(roleId?: string): void {
    this.scheduler.wakePendingWork(roleId);
  }

  /**
   * 恢复活动后的重新调度（RA-R02）：把因停止而暂停的任务链改回 active 并排队
   * 续行，再交给统一调度接上到期待办与后台工具留下的续行。待办、任务链与
   * 自主额度原样保留，不新建任务、不清空排队、不重置额度。
   */
  rescheduleAfterStop(roleId: string): void {
    this.scheduler.rescheduleAfterStop(roleId);
  }

  /**
   * 任务已终结时释放资源续用记录（283 R03）。
   *
   * 仍有在途后台工具、未结算的工具调用或尚未关闭的任务目录时保留占用，
   * 由结算回调与目录关闭后的收尾再次调用。任务仍在进行时不做任何处理。
   */
  releaseTaskResources(roleId: string, taskId: string): void {
    this.runner.releaseTaskResources(roleId, taskId);
  }
}
