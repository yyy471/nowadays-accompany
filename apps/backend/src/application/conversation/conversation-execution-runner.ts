import { EngineeringJobs, engineeringWait } from "../../storage/conversation/engineering-jobs.js";
import { exchangeWake } from "./role-exchanges.js";
import {
  AppError,
  AutonomyBudgetExhaustedError,
  ExecutionSupersededError,
  ModelRequestFailedError,
  RoleStopRequestedError,
  TaskEndedError,
  TaskStateConflictError,
} from "../../domain/errors.js";
import type {
  AgentRunResult,
  AgentSegmentStopKind,
  BackgroundToolSettlement,
} from "../../domain/conversation.js";
import type { ModelMessage } from "../../domain/model.js";
import { localDateFromIso } from "../../storage/memory/evidence.js";
import { MemoryStore } from "../../storage/memory/memory-store.js";
import {
  ConversationStore,
  type CommitConversationTaskDecision,
} from "../../storage/conversation/conversation-store.js";
import { AutonomyStore } from "../../storage/conversation/autonomy-store.js";
import type { ExecutionRecord, TaskRecord } from "../../storage/role/role-store.js";
import type { RoleStorage } from "../../storage/core/role-storage.js";
import { prepareModelWebReadings, readWebHistoryProjection, recordAcceptedWebReadings } from "../../storage/conversation/web-reading.js";
import { matchWorldbooks } from "../../domain/worldbook.js";
import { readWorldbooks, recordWorldbookUsage } from "../../storage/role/worldbook-store.js";
import {
  AgentGraphRunner,
  CIRCUIT_FAILURE_THRESHOLD,
  type AgentModelHandle,
} from "./agent-graph.js";
import type { AgentSystemPrompt } from "./agent-context.js";
import { findAgentEvidence } from "./conversation-history.js";
import { loadAgentTools, type AgentToolCatalog } from "./agent-tools.js";
import type {
  ConversationContext,
  RunExecutionInput,
  RunningExecution,
} from "./conversation-internal-types.js";
import {
  errorCodeOf,
  memoryDetailTools,
  recallStepTopic,
  segmentNotice,
  toCommittedTaskDecision,
  truncate,
  windowKey,
} from "./conversation-prompt-builder.js";

/**
 * 单轮执行驱动：图运行、后台工具结算、分段追踪、任务完成与资源释放。
 */
export class ConversationExecutionRunner {
  constructor(private readonly ctx: ConversationContext) {}

  private get state() {
    return this.ctx.state;
  }

  async runExecution(input: RunExecutionInput): Promise<void> {
    const { storage, store, running, execution, pendingMessages } = input;
    const roleId = execution.roleId;
    const windowId = execution.windowId ?? running.windowId;
    const autonomy = input.autonomy ?? null;
    // 每日穿搭按本轮开始决策的业务本地日期登记，跨零点不改变本轮日期。
    const roundLocalDate = localDateFromIso(
      this.ctx.now().toISOString(),
      this.ctx.timeZone,
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
      purpose !== "autonomous" || this.ctx.autonomy === null
        ? null
        : {
            consume: (): boolean => {
              const budget = this.ctx.autonomy!.consumePoint(roleId);
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
              const autonomyService = this.ctx.autonomy!;
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
      if (this.ctx.activity?.isStopRequested(roleId) === true) {
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
      this.ctx.roleAccess.withStore(roleId, (fresh) => {
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
        now: this.ctx.now().toISOString(),
      });
    };
    try {
      const continuationResourceIds =
        input.taskId !== null &&
        input.taskId !== undefined
          ? this.ctx.scheduler.grantTaskResources(storage, roleId, input.taskId)
          : [];
      const cachedCatalog =
        input.taskId === null || input.taskId === undefined
          ? undefined
          : this.state.taskCatalogs.get(input.taskId);
      // 续行仍属原任务链，沿用已取得的模型；开关仅限制新任务。
      const initialBinding =
        cachedCatalog?.roleId === roleId
          ? cachedCatalog.modelBinding
          : input.taskId !== null &&
              input.taskId !== undefined
            ? (this.ctx.bindings.resolveChatForTask(roleId, input.taskId) ??
              this.ctx.bindings.resolveChat(roleId))
            : this.ctx.bindings.resolveChat(roleId);
      // 本轮执行固定在初始模型服务上；维护等待据此判断目标服务的实际在途调用。
      this.state.inflightResources.set(execution.executionId, {
        roleId,
        resourceId: initialBinding.resourceId,
      });
      const resolveModel = (): AgentModelHandle => {
        const binding = this.ctx.bindings.refresh(initialBinding, roleId);
        return {
          model: this.ctx.modelFactory(binding),
          resourceId: binding.resourceId,
          modelName: binding.modelName,
          protocol: binding.config.protocol,
          ...(binding.config.provider === undefined ? {} : { provider: binding.config.provider }),
          baseUrl: binding.config.baseUrl,
          ...(binding.config.vertexSafety === undefined ? {} : { vertexSafety: binding.config.vertexSafety }),
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
      const exchangeTurn = exchangeWake(autonomy?.wakeId);
      const exchangeContext = exchangeTurn ? this.ctx.exchanges.recallContext(roleId, exchangeTurn.sessionId) : null;
      const recall = await this.ctx.prompt.autoRecall(
        roleId,
        execution.executionId,
        pendingMessages,
        recent,
        exchangeContext?.query ?? autonomy?.intent ?? continuationTask?.goal ?? "",
      );
      const outfitBrief = this.ctx.prompt.buildOutfitBrief(
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
        // 工程权来自该链实际登记的 job；复用对话目录时重新读取工程池与该链证据。
        if (input.taskId) await catalog.refreshEngineering?.(input.taskId);
      } else {
        catalog = await loadAgentTools({
          roleId,
          taskId: input.taskId ?? null,
          readWebToolProjection: readWebHistoryProjection,
          appStore: this.ctx.appStore,
          roleAccess: this.ctx.roleAccess,
          memory: this.ctx.memory,
          autonomy: this.ctx.autonomy,
          exchanges: this.ctx.exchanges,
          exchangeTurn,
          allowAutonomyShare: autonomy !== null,
          continuationResourceIds,
          appRoot: this.ctx.appRoot,
          workspaceDir: storage.paths.workspaceDir,
          ...(this.ctx.adminServices === null
            ? {}
            : { admin: this.ctx.adminServices }),
        });
        if (input.taskId !== null && input.taskId !== undefined) {
          this.state.taskCatalogs.set(input.taskId, {
            roleId,
            catalog,
            modelBinding: initialBinding,
          });
        }
      }
      const engineering = new EngineeringJobs(storage.business.db);
      if (taskId && !running.superseded && continuationTask?.status === "active") engineering.claim(taskId, execution.executionId);
      const receipts = taskId ? engineering.receipts(taskId, execution.executionId) : [];
      let activeRecall = recall;
      const worldbook = matchWorldbooks(readWorldbooks(storage.business.db, roleId), [
        ...pendingMessages.map(message => ({ id: message.messageId, text: message.content })),
        { text: continuationTask?.goal ?? "" },
        { text: autonomy?.intent ?? "" },
      ]);
      let previousStep: string | null = null;
      const systemPrompt = async (messages: readonly ModelMessage[], round: number): Promise<AgentSystemPrompt> => {
        const latest = round > 0 ? [...messages].reverse().find((message) => message.role === "assistant" && message.toolCalls?.length) : undefined;
        const calls = latest?.role === "assistant" ? latest.toolCalls ?? [] : [];
        const step = recallStepTopic(calls);
        // 从已命中的事件下钻到原文是同一步骤。保留这批线索，不另做检索或增加召回计数。
        const readingEvidence = calls.length > 0 && calls.every(call => memoryDetailTools.has(call.name));
        if (latest && !readingEvidence && step !== previousStep) {
          activeRecall = step ? await this.ctx.prompt.autoRecall(roleId, execution.executionId, [], [], step) : { briefs: [], warning: null };
          previousStep = step;
        }
        const prompt = this.ctx.prompt.buildSystemPrompt({
          roleContext: store.getRoleContext(),
          recallBriefs: activeRecall.briefs,
          recallWarning: activeRecall.warning,
          skillBriefs: catalog?.skillBriefs ?? [],
          warnings: catalog?.warnings ?? [],
          tools: catalog?.tools ?? [],
          pendingMessages,
          taskBrief: this.ctx.prompt.buildTaskBrief(storage, roleId, taskId),
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
        if (receipts.length) prompt.required += "\n原任务的后台工程回执如下。依据实际结果完成原交办，发布对应草稿时同时传入 extId 和 jobId。interrupted_unknown 表示结果待核查，不得自动重跑工程。\n" + JSON.stringify(receipts);
        if (replyToolSource) prompt.required += "\n上次回答中断，本轮只补答原消息。已派发操作以保存的回执为据，结果未确认的如实说明。未提交的角色状态以当前状态为准。";
        if (exchangeContext?.spoken.length) {
          return { ...prompt, worldbook, optional: [
            "与本次互聊有关、你曾向用户发表的回复摘录（按发言时间核对更正；只证明你当时这样说过）：" + JSON.stringify(exchangeContext.spoken),
            ...prompt.optional,
          ] };
        }
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
        this.ctx.scheduler.grantTaskResources(storage, roleId, task.taskId);
        if (catalog !== null) {
          this.state.taskCatalogs.set(task.taskId, {
            roleId,
            catalog,
            modelBinding: initialBinding,
          });
        }
        taskId = task.taskId;
        return taskId;
      };
      ensureTaskForStop = ensureTask;
      const messages = this.ctx.prompt.buildMessages(recent, pendingMessages);
      const runner = new AgentGraphRunner(
        {
          store,
          roleStore: storage.business,
          resolveModel,
          replyOnly: replyToolSource !== null,
          get tools() { return catalog!.tools; },
          systemPrompt,
          prepareModelMessages: (messages) => prepareModelWebReadings(storage.business.db, roleId, messages),
          onModelAccepted: (accepted) => {
            new MemoryStore(storage.business.db).recordDeliveries(roleId, accepted.executionId, accepted.memoryReads, this.ctx.now().toISOString());
            recordWorldbookUsage(storage.business.db, accepted);
            recordAcceptedWebReadings(storage.business.db, {
              ...accepted,
              now: this.ctx.now().toISOString(),
              ...(this.ctx.timeZone ? { timeZone: this.ctx.timeZone } : {}),
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
          now: this.ctx.now,
          localDate: roundLocalDate,
          maxToolRounds: this.ctx.maxToolRounds,
          purpose,
          meter,
          ...(this.ctx.onModelCallFinished === undefined
            ? {}
            : { onModelCallFinished: this.ctx.onModelCallFinished }),
          toolForegroundWaitMs: this.ctx.toolForegroundWaitMs,
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
              this.state.backgroundToolsByTask.set(
                backgroundTaskId,
                (this.state.backgroundToolsByTask.get(backgroundTaskId) ?? 0) + 1,
              );
            }
            this.state.backgroundToolSettles.add(settlement);
            this.state.backgroundToolsByRole.set(
              backgroundRoleId,
              (this.state.backgroundToolsByRole.get(backgroundRoleId) ?? 0) + 1,
            );
            void settlement.then(() => {
              this.state.backgroundToolSettles.delete(settlement);
              const remaining = (this.state.backgroundToolsByRole.get(backgroundRoleId) ?? 1) - 1;
              if (remaining <= 0) {
                this.state.backgroundToolsByRole.delete(backgroundRoleId);
              } else {
                this.state.backgroundToolsByRole.set(backgroundRoleId, remaining);
              }
              if (backgroundTaskId !== null) {
                const taskRemaining =
                  (this.state.backgroundToolsByTask.get(backgroundTaskId) ?? 1) - 1;
                if (taskRemaining <= 0) {
                  this.state.backgroundToolsByTask.delete(backgroundTaskId);
                } else {
                  this.state.backgroundToolsByTask.set(backgroundTaskId, taskRemaining);
                }
                if (taskRemaining <= 0 && this.state.catalogClosePending.has(backgroundTaskId)) {
                  // 最后一个在途工具已结算：关闭目录，收尾后释放资源占用（283 R03）。
                  void this.ctx.scheduler.closeTaskCatalog(backgroundTaskId);
                }
                this.releaseTaskResources(backgroundRoleId, backgroundTaskId);
              }
              if (remaining <= 0) {
                // 最后一个后台工具结算：前台执行可能早已退出，停止确认不能只等
                // 前台收尾。结算回调先于计数递减执行，这里确认不会丢原调用记录。
                this.ctx.scheduler.confirmStopIfIdle(backgroundRoleId, execution.executionId);
                // 前台执行恰好还在收尾时同步确认会跳过，再延后一次兜底收敛。
                const deferredRoleId = backgroundRoleId;
                const deferredExecutionId = execution.executionId;
                const timer = setTimeout(() => {
                  this.ctx.scheduler.notifyExternalIdle(deferredRoleId, deferredExecutionId);
                }, 0);
                timer.unref?.();
              }
            });
          },
        },
        storage.checkpoint,
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
      if (autonomy?.wakeId && this.ctx.exchanges.finishUnanswered(roleId, autonomy.wakeId, "ROLE_EXCHANGE_NO_REPLY")) {
        throw new AppError(409, "ROLE_EXCHANGE_NO_REPLY", "本次自主活动结束时未发送会话回复");
      }
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
          : toCommittedTaskDecision(result.taskId, result.taskAction, !circuitBreak && engineering.awaiting(result.taskId));
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
        ? this.ctx.autoScenes?.captureAutomaticConfig(roleId, storage.business.db) ?? null : null;
      const waiting = taskDecision?.action.kind === "pause" && taskDecision.action.waitReason === engineeringWait;
      const commitReply = () => store.commitConversation({
        automaticScene,
        executionId: execution.executionId,
        content,
        statePatch: this.ctx.prompt.validateOutfitStatePatch(
          storage,
          roleId,
          result.statePatch,
        ),
        countsAsConversationRound: autonomy === null,
        ...(this.ctx.batchDelayMs === undefined ? {} : { batchDelayMs: this.ctx.batchDelayMs }),
        taskDecision,
        now: this.ctx.now().toISOString(),
      });
      // 与前台回复一起提交工程等待态。崩溃或先到的回执都不能把任务遗留在 active。
      const committed = waiting && result.taskId ? storage.business.db.transaction((parentId: string) => {
        const reply = commitReply();
        storage.business.pauseTask({ roleId, taskId: parentId, waitReason: engineeringWait, endReason: "等待工程回执" });
        if (autonomy?.activityId) new AutonomyStore(storage.business.db, roleId, this.ctx.timeZone).updateActivity({
          activityId: autonomy.activityId, status: "paused", summary: truncate(content, 2000),
        });
        return reply;
      })(result.taskId) : commitReply();
      if (committed.observedBatch) this.ctx.batchDelivery.notify(roleId);
      if (automaticScene) this.ctx.autoScenes?.dispatchAutomatic(roleId, windowId);
      if (!completionOnly) this.ctx.queueSegmentAnnotation({
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
        if (waiting) pausedByDecision = true;
        else this.applyCommittedTaskDecision(storage, roleId, taskDecision, () => {
          pausedByDecision = true;
        });
      }
      if (taskDecision !== null && taskDecision.action.kind === "continue") {
        this.ctx.scheduler.queueTaskContinuation(roleId, {
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
          now: this.ctx.now().toISOString(),
        });
      }
      if (result.taskId !== null && result.taskAction === null) {
        this.trackSegmentProgress(storage, roleId, result, execution, {
          queuedContinuation: continuationQueued,
        });
      }
      if (autonomy !== null && !waiting) {
        try {
          if (autonomy.activityId !== null) {
            this.ctx.autonomy?.updateActivity(roleId, {
              activityId: autonomy.activityId,
              status: "completed",
              summary: truncate(content, 2000),
            });
          }
          if (autonomy.wakeId !== null) {
            this.ctx.autonomy?.completeWake(roleId, autonomy.wakeId);
          }
        } catch {
          // 活动记录失败不覆盖已提交的回复。
        }
      }
      this.ctx.memoryRuntime?.notifyEvidence(roleId);
      if (taskId !== null && taskDecision?.action.kind !== "pause") {
        this.ctx.memoryRuntime?.notifyTaskFinished(roleId, taskId);
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
        if (autonomy?.wakeId && code !== "TOOL_BACKGROUNDED") this.ctx.exchanges.finishUnanswered(roleId, autonomy.wakeId, code);
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
              now: this.ctx.now().toISOString(),
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
              now: this.ctx.now().toISOString(),
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
            if (!this.ctx.hasExternalWork(roleId)) {
              this.ctx.activity?.confirmStop(roleId, execution.executionId);
            }
          } catch {
            // 确认失败时保持 stopping，避免误放行配置写入。
          }
          this.ctx.memoryRuntime?.notifyEvidence(roleId);
        } else if (code === "AUTONOMY_BUDGET_EXHAUSTED" && autonomy !== null && !exchangeWake(autonomy.wakeId) && !autonomy.wakeId?.startsWith("coplay/")) {
          pausedForBudget = true;
          try {
            store.interruptExecution({
              executionId: execution.executionId,
              partialText: running.partialText,
              status: "paused",
              reason: code,
              errorCode: code,
              now: this.ctx.now().toISOString(),
            });
          } catch {
            // 状态已由其他路径改变，保留已有事件。
          }
          try {
            if (taskId !== null) {
              this.ctx.autonomy?.pauseForBudget(roleId, {
                taskId,
                activityId: autonomy.activityId,
                wakeId: autonomy.wakeId,
              });
            }
          } catch {
            // 暂停安排失败时保留已保存的执行暂停状态，可人工处理。
          }
          this.ctx.memoryRuntime?.notifyEvidence(roleId);
        } else {
          try {
            const details = error instanceof AppError ? error.details : null;
            const upstreamStatus = details && typeof details === "object" && "status" in details ? details.status : undefined;
            const retryableModelError = (code === "MODEL_REQUEST_FAILED" || code === "EXECUTION_FAILED") &&
              !(typeof upstreamStatus === "number" && upstreamStatus >= 400 && upstreamStatus < 500 && upstreamStatus !== 408);
            store.interruptExecution({
              executionId: execution.executionId,
              partialText: running.partialText,
              status: "failed",
              reportReceiptsImmediately: !retryableModelError,
              reason: code,
              errorCode: code,
              now: this.ctx.now().toISOString(),
            });
          } catch {
            // 状态已由其他路径改变，保留已有事件。
          }
          // 原消息仍有已确认结果时，交给现有窗口调度自动补答。补答再失败会在事务内交付系统回执。
          const pendingReply = store.getFailedReply(windowId);
          if (code !== "AUTONOMY_BUDGET_EXHAUSTED" && !exchangeWake(autonomy?.wakeId) && !pendingReply?.receiptSummary) this.state.blockedWindows.add(windowKey(roleId, windowId));
          if (taskId !== null && code !== "TASK_ENDED") {
            const saved = store.savedTaskFinish(execution.executionId);
            const finish = saved?.taskId === taskId ? saved : undefined;
            this.finishTaskAfterExecution(
              storage,
              roleId,
              taskId,
              finish?.status ?? "failed",
              finish?.reason ?? code,
            );
            this.ctx.memoryRuntime?.notifyTaskFinished(roleId, taskId);
          }
          if (autonomy !== null) {
            try {
              if (autonomy.activityId !== null) {
                this.ctx.autonomy?.updateActivity(roleId, {
                  activityId: autonomy.activityId,
                  status: "failed",
                });
              }
              if (autonomy.wakeId !== null) {
                this.ctx.autonomy?.completeWake(roleId, autonomy.wakeId, code);
              }
            } catch {
              // 活动记录失败不覆盖执行失败状态。
            }
          }
          this.ctx.memoryRuntime?.notifyEvidence(roleId);
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
            this.ctx.scheduler.queueTaskContinuation(roleId, {
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
        (this.state.backgroundToolsByTask.get(taskId) ?? 0) > 0
      ) {
        // 任务已终结但仍有已发出的后台工具：先不关连接，
        // 等结果结算后再关闭目录并释放资源占用（283 R03）。
        this.state.catalogClosePending.add(taskId);
        keepCatalog = true;
      }
      if (!keepCatalog) {
        await catalog?.close();
        if (taskId !== null) {
          this.state.taskCatalogs.delete(taskId);
          // 目录直接在此关闭时也要补上资源释放（283 R03）。
          this.releaseTaskResources(roleId, taskId);
        }
      }
      this.state.inflightResources.delete(execution.executionId);
      // 执行已收尾：正常完成或失败时若停止请求没在节点边界命中，这里兜底确认，
      // 避免角色永久卡在 stopping。重复确认由存储的 WHERE state='stopping' 幂等处理。
      // 仍有后台工具在途时不在这里确认：它们还属于本轮活动，由最后一个工具
      // 结算后的收敛路径确认（RA-R01）。
      const activity = this.ctx.activity;
      if (
        (this.state.backgroundToolsByRole.get(roleId) ?? 0) === 0 &&
        !this.ctx.hasExternalWork(roleId) &&
        activity?.isStopRequested(roleId) === true
      ) {
        try {
          activity.confirmStop(roleId, execution.executionId);
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
      this.ctx.roleAccess.withStore(settlement.roleId, (storage) => {
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
          new ConversationStore(storage.business.db, settlement.roleId, this.ctx.timeZone).recordToolMetering({
            executionId: settlement.executionId,
            taskId: settlement.taskId,
            toolCallId: settlement.toolCallId,
            purpose: settlement.purpose,
            counted: settlement.counted,
            now: this.ctx.now().toISOString(),
          });
        }
        if (settlement.windowId !== null) {
          new ConversationStore(storage.business.db, settlement.roleId, this.ctx.timeZone).appendStreamEvent({
            windowId: settlement.windowId,
            executionId: settlement.executionId,
            type: "tool_result_saved",
            payload: {
              executionId: settlement.executionId,
              toolCallId: settlement.toolCallId,
              status: settlement.outcome.status,
              background: true,
            },
            now: this.ctx.now().toISOString(),
          });
        }
      });
    } catch {
      // 后台结算失败时保留执行侧的恢复路径：重启后按中断调用补录 unknown。
      return;
    }
    if (this.state.closed || settlement.taskId === null || settlement.windowId === null) {
      return;
    }
    try {
      const task = this.ctx.roleAccess.withStore(settlement.roleId, (storage) =>
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
    this.ctx.scheduler.queueTaskContinuation(settlement.roleId, {
      taskId: settlement.taskId,
      windowId: settlement.windowId,
    });
    const deferred = setTimeout(() => { void this.ctx.schedule(settlement.roleId); }, 0);
    deferred.unref?.();
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
        this.ctx.scheduler.removePendingContinuation(roleId, task.taskId);
      }
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.ctx.timeZone,
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
          source: "task_circuit_breaker",
          windowId: execution.windowId,
          executionId: execution.executionId,
          content: [
            "（任务先暂停一下）",
            reason,
            ...(notes.length === 0 ? ["目前没有已保存的进度笔记。"] : ["已保存的最近进度：", ...notes]),
          ].join("\n"),
          now: this.ctx.now().toISOString(),
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
          now: this.ctx.now().toISOString(),
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
      this.ctx.autonomy?.cancelPendingBudgetResumes(
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
  releaseTaskResources(roleId: string, taskId: string): void {
    if (this.state.closed) {
      return;
    }
    if ((this.state.backgroundToolsByTask.get(taskId) ?? 0) > 0) {
      return;
    }
    if (this.state.taskCatalogs.has(taskId)) {
      // 目录关闭完成后 closeTaskCatalog 会再次调用。
      return;
    }
    if (this.state.closingTaskCatalogs.has(taskId)) {
      return;
    }
    try {
      this.ctx.roleAccess.withStore(roleId, (storage) => {
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

  finishTask(input: {
    roleId: string;
    taskId: string;
    status: "completed" | "failed";
    endReason: string;
  }): TaskRecord {
    const task = this.ctx.roleAccess.withStore(input.roleId, (storage) =>
      storage.business.finishTask(input),
    );
    try {
      this.ctx.autonomy?.cancelPendingBudgetResumes(
        input.roleId,
        input.taskId,
        "TASK_ENDED",
      );
    } catch {
      // 任务已经结束；取消失败时由恢复领取时的终态检查兜底。
    }
    // 资源续用记录要等在途工具结算与连接收尾后释放（283 R03）。
    this.ctx.scheduler.closeTaskCatalogAfterSettled(input.taskId);
    this.releaseTaskResources(input.roleId, input.taskId);
    this.ctx.memoryRuntime?.notifyTaskFinished(input.roleId, input.taskId);
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
    const now = this.ctx.now().toISOString();
    const runningSnapshot = this.state.running.get(input.roleId);
    const { task: finished, matchedRunning } = this.ctx.roleAccess.withStore(
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
            this.ctx.timeZone,
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
    this.ctx.adminServices?.pi?.cancelTask(input.roleId, input.taskId);
    // 只有持久化事务成功提交后，才清理内存续行队列并中止在途执行，避免写入失败导致状态分裂。
    this.ctx.scheduler.removePendingContinuation(input.roleId, input.taskId);
    let abortedRunning = false;
    if (matchedRunning !== null && !matchedRunning.superseded) {
      matchedRunning.superseded = true;
      matchedRunning.controller.abort();
      if (this.state.running.get(input.roleId) === matchedRunning) {
        this.state.running.delete(input.roleId);
      }
      this.state.detached.add(matchedRunning);
      abortedRunning = true;
    }
    try {
      this.ctx.autonomy?.cancelPendingBudgetResumes(
        input.roleId,
        input.taskId,
        "TASK_ENDED",
      );
      const activity = this.ctx.autonomy?.getLatestActivityByTask(
        input.roleId,
        input.taskId,
      );
      if (
        activity !== undefined &&
        activity !== null &&
        (activity.status === "running" || activity.status === "paused")
      ) {
        this.ctx.autonomy?.updateActivity(input.roleId, {
          activityId: activity.activityId,
          status: "failed",
          summary: `任务已取消：${reason}`,
        });
      }
    } catch {
      // 取消辅助记录失败不影响主任务已取消状态。
    }
    this.ctx.scheduler.closeTaskCatalogAfterSettled(input.taskId);
    this.releaseTaskResources(input.roleId, input.taskId);
    this.ctx.memoryRuntime?.notifyTaskFinished(input.roleId, input.taskId);
    if (abortedRunning) {
      void this.ctx.schedule(input.roleId);
    }
    return finished;
  }
}
