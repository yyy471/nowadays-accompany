import { randomUUID } from "node:crypto";
import { localDateFromIso } from "../../storage/memory/evidence.js";
import {
  DEFAULT_MEMORY_BUDGET_CHARS,
  DEFAULT_MEMORY_RETRY_DELAYS_MS,
  DEFAULT_OUTPUT_RESERVE_CHARS,
  memoryFormationResponseSchema,
  type DailySummaryBrief,
  type MemoryBatchRecord,
  type MemoryClaim,
  type MemoryClaimRecord,
  type MemoryFormationInput,
  type MemoryFormationResponse,
  type MemoryModelCapacity,
  type MemoryModelInfo,
  type MemoryModelPort,
  type MemoryOperation,
  type RefineCandidateBrief,
  type RelatedEventBrief,
} from "../../domain/memory.js";
import {
  AppError,
  MemoryOperationInvalidError,
  MemoryVersionConflictError,
} from "../../domain/errors.js";
import type {
  MemoryStore,
  NextSegment,
  StartedBatch,
} from "../../storage/memory/memory-store.js";
import type { ModelUsage } from "../../domain/model.js";
import type { TokenUsageCallEvent } from "../../domain/token-usage.js";

export interface MemoryServiceOptions {
  modelInfo?: MemoryModelInfo;
  budgetChars?: number;
  outputReserveChars?: number;
  /** 按绑定模型声明容量时启用完整预算核算（GAP-04）；缺省保持既有保守行为。 */
  capacity?: MemoryModelCapacity;
  /** 请求组装的固定开销估算（系统提示与 JSON 骨架）。 */
  requestOverheadChars?: number;
  retryDelaysMs?: readonly number[];
  idleMs?: number;
  timeZone?: string;
  now?: () => Date;
  onModelCallFinished?: (event: TokenUsageCallEvent) => void;
}

/** 整理请求中除证据片段以外的固定与上下文内容。 */
interface BatchContext {
  roleName: string;
  currentRound: number;
  refineCandidates: RefineCandidateBrief[];
  summaryCandidates: DailySummaryBrief[];
  relatedEvents: RelatedEventBrief[];
}

export interface MemoryBatchRunResult {
  batchId: string | null;
  status: "completed" | "failed" | "partial" | "none";
  operations: number;
  evidenceProcessed: number;
  errorCode: string | null;
  maintenance: boolean;
}

export interface MemoryDrainResult {
  status: "completed" | "failed" | "partial" | "none";
  batches: MemoryBatchRunResult[];
  operations: number;
  evidenceProcessed: number;
}

export class MemoryService {
  private readonly store: MemoryStore;
  private readonly model: MemoryModelPort;
  private readonly modelInfo: MemoryModelInfo;
  private readonly budgetChars: number;
  private readonly outputReserveChars: number;
  private readonly capacity: MemoryModelCapacity | null;
  private readonly requestOverheadChars: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly idleMs: number;
  private readonly timeZone: string | undefined;
  private readonly now: () => Date;
  private readonly onModelCallFinished: ((event: TokenUsageCallEvent) => void) | undefined;

  constructor(
    store: MemoryStore,
    model: MemoryModelPort,
    options: MemoryServiceOptions = {},
  ) {
    this.store = store;
    this.model = model;
    this.modelInfo = options.modelInfo ?? {
      modelName: "offline-memory",
      protocol: "openai-chat",
    };
    this.capacity = options.capacity ?? null;
    this.budgetChars = options.budgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS;
    this.outputReserveChars =
      options.capacity?.maxOutputChars ??
      options.outputReserveChars ??
      DEFAULT_OUTPUT_RESERVE_CHARS;
    this.requestOverheadChars = Math.max(0, options.requestOverheadChars ?? 2_000);
    this.retryDelaysMs =
      options.retryDelaysMs ?? DEFAULT_MEMORY_RETRY_DELAYS_MS;
    this.idleMs = options.idleMs ?? 60_000;
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
    this.onModelCallFinished = options.onModelCallFinished;
  }

  /**
   * 证据片段可用的字符预算：声明容量时按
   * maxInputChars − 输出预留 − 固定开销 − 请求骨架核算；
   * 请求骨架按序列化后的实际长度计算（含转义与证据元数据），
   * 未声明容量时保持既有保守预算（仅约束证据装载）。
   */
  private effectiveEvidenceBudget(baseChars: number): number {
    if (this.capacity === null) {
      return this.budgetChars;
    }
    const budget =
      this.capacity.maxInputChars -
      this.outputReserveChars -
      this.requestOverheadChars -
      baseChars;
    if (budget <= 0) {
      throw new AppError(
        502,
        "MEMORY_CAPACITY_EXCEEDED",
        "整理请求的上下文与输出预留超出模型可用容量",
        {
          maxInputChars: this.capacity.maxInputChars,
          outputReserveChars: this.outputReserveChars,
          baseChars,
          requestOverheadChars: this.requestOverheadChars,
        },
      );
    }
    return budget;
  }

  /** 不含证据片段的整理请求序列化长度；证据条目按逗号分隔追加。 */
  private requestBaseChars(
    roleId: string,
    batchId: string,
    context: BatchContext,
  ): number {
    return Array.from(
      JSON.stringify({
        roleId,
        roleName: context.roleName,
        batchId,
        currentRound: context.currentRound,
        evidence: [],
        relatedEvents: context.relatedEvents,
        refineCandidates: context.refineCandidates,
        summaryCandidates: context.summaryCandidates,
      }),
    ).length;
  }

  private assertRequestCapacity(input: MemoryFormationInput): void {
    if (this.capacity === null) {
      return;
    }
    const serializedChars = Array.from(JSON.stringify(input)).length;
    const totalChars =
      serializedChars + this.requestOverheadChars + this.outputReserveChars;
    if (totalChars > this.capacity.maxInputChars) {
      throw new AppError(
        502,
        "MEMORY_CAPACITY_EXCEEDED",
        "整理请求超过模型声明容量",
        {
          maxInputChars: this.capacity.maxInputChars,
          serializedChars,
          requestOverheadChars: this.requestOverheadChars,
          outputReserveChars: this.outputReserveChars,
          totalChars,
        },
      );
    }
  }

  onEvidenceRegistered(roleId: string): void {
    const now = this.now();
    for (const stats of this.store.pendingMessageStats(roleId)) {
      if (stats.count >= 50) {
        this.store.enqueueTrigger({
          roleId,
          kind: "message_threshold",
          windowId: stats.windowId,
          now: now.toISOString(),
        });
      }
    }
    this.checkIdle(roleId, now);
  }

  checkIdle(roleId: string, now = this.now()): void {
    const cutoff = new Date(now.getTime() - this.idleMs).toISOString();
    for (const stats of this.store.pendingMessageStats(roleId)) {
      if (stats.count >= 30 && stats.lastOccurredAt <= cutoff) {
        this.store.enqueueTrigger({
          roleId,
          kind: "idle",
          windowId: stats.windowId,
          now: now.toISOString(),
        });
      }
    }
  }

  onTaskFinished(roleId: string, taskId: string): void {
    if (this.store.pendingTaskEvidenceCount(roleId, taskId) > 0) {
      this.store.enqueueTrigger({
        roleId,
        kind: "task_end",
        taskId,
        now: this.now().toISOString(),
      });
    }
  }

  enqueueManual(roleId: string): { triggerId: string; duplicate: boolean } {
    return this.store.enqueueTrigger({
      roleId,
      kind: "manual",
      now: this.now().toISOString(),
    });
  }

  async runBatch(
    roleId: string,
    options: {
      includeDeferred?: boolean;
      includeRefinement?: boolean;
      maintenanceOnly?: boolean;
    } = {},
  ): Promise<MemoryBatchRunResult> {
    const startedAt = this.now().toISOString();
    let initialBudget: number;
    try {
      const initialContext = this.prepareBatchContext(roleId);
      initialBudget = this.effectiveEvidenceBudget(
        this.requestBaseChars(roleId, "0".repeat(36), initialContext),
      );
    } catch (error) {
      if (isCapacityExceeded(error)) {
        return {
          batchId: null,
          status: "failed",
          operations: 0,
          evidenceProcessed: 0,
          errorCode: error.code,
          maintenance: false,
        };
      }
      throw error;
    }
    let batch: StartedBatch | null;
    try {
      batch = this.store.startBatch({
        roleId,
        budgetChars: initialBudget,
        outputReserveChars: this.outputReserveChars,
        ...(options.includeDeferred !== undefined
          ? { includeDeferred: options.includeDeferred }
          : {}),
        ...(options.includeRefinement !== undefined
          ? { includeRefinement: options.includeRefinement }
          : {}),
        ...(options.maintenanceOnly !== undefined
          ? { maintenanceOnly: options.maintenanceOnly }
          : {}),
        now: startedAt,
      });
    } catch (error) {
      if (isBatchConflict(error)) {
        return {
          batchId: null,
          status: "none",
          operations: 0,
          evidenceProcessed: 0,
          errorCode: "MEMORY_BATCH_CONFLICT",
          maintenance: false,
        };
      }
      if (isCapacityExceeded(error)) {
        return {
          batchId: null,
          status: "failed",
          operations: 0,
          evidenceProcessed: 0,
          errorCode: error.code,
          maintenance: false,
        };
      }
      throw error;
    }
    if (!batch) {
      return {
        batchId: null,
        status: "none",
        operations: 0,
        evidenceProcessed: 0,
        errorCode: null,
        maintenance: false,
      };
    }
    let operations = 0;
    let maintenanceCall = batch.maintenance;
    try {
      while (true) {
        // 候选与关联事件会随操作变化，逐轮按最新内容重测预算。
        const context = this.prepareBatchContext(roleId, batch.evidence.map(item => item.content.slice(0, 2000)).join("\n").slice(0, 16000).toLowerCase());
        let next: NextSegment[] = [];
        if (!batch.maintenance) {
          const budget = this.effectiveEvidenceBudget(
            this.requestBaseChars(roleId, batch.batch.batchId, context),
          );
          next = this.store.getNextSegments(
            roleId,
            batch.batch.batchId,
            budget,
            { serialized: this.capacity !== null },
          );
        }
        maintenanceCall = false;
        if (next.length === 0 && !batch.maintenance) {
          break;
        }
        const callId = this.startModelCall(
          roleId,
          batch.batch,
          this.now().toISOString(),
        );
        let response: MemoryFormationResponse | null = null;
        let callUsage: ModelUsage | null = null;
        let callMeta: MemoryModelInfo = this.modelInfo;
        let modelInvoked = false;
        let failureCode: string | null = null;
        try {
          const modelInput = this.buildModelInput(
            roleId,
            batch.batch,
            next,
            context,
          );
          this.assertRequestCapacity(modelInput);
          const refineCandidates = modelInput.refineCandidates;
          const summaryCandidates = modelInput.summaryCandidates;
          modelInvoked = true;
          const raw = await this.model.form(modelInput, {
            onUsage: (usage) => {
              callUsage = usage;
            },
            onModelInfo: (info) => {
              callMeta = info;
            },
          });
          const parsed = memoryFormationResponseSchema.safeParse(raw);
          if (!parsed.success) {
            throw new MemoryOperationInvalidError(
              "整理模型返回格式不符合契约",
              parsed.error.issues.map((issue) => ({
                path: issue.path.map(String).join("."),
                message: issue.message,
              })),
            );
          }
          response = parsed.data;
          this.applyResponse(
            roleId,
            batch,
            next,
            response,
            modelInput.relatedEvents,
            refineCandidates,
            summaryCandidates,
          );
        } catch (error) {
          failureCode =
            error instanceof MemoryOperationInvalidError ||
            error instanceof MemoryVersionConflictError ||
            isCapacityExceeded(error)
              ? error.code
              : "MEMORY_MODEL_FAILED";
        }
        if (failureCode !== null) {
          this.finishModelCall(roleId, callId, "failed", failureCode, callUsage, callMeta, modelInvoked);
          this.store.finishBatch({
            roleId,
            batchId: batch.batch.batchId,
            status: "failed",
            errorCode: failureCode,
            nextRetryAt: new Date(
              this.now().getTime() + this.retryDelayForBatch(batch),
            ).toISOString(),
            now: this.now().toISOString(),
          });
          return {
            batchId: batch.batch.batchId,
            status: "failed",
            operations,
            evidenceProcessed: 0,
            errorCode: failureCode,
            maintenance: batch.maintenance,
          };
        }
        this.finishModelCall(roleId, callId, "succeeded", null, callUsage, callMeta, modelInvoked);
        operations += response?.operations.length ?? 0;
        if (batch.maintenance) {
          break;
        }
      }
      this.store.finishBatch({
        roleId,
        batchId: batch.batch.batchId,
        status: "completed",
        now: this.now().toISOString(),
      });
      const batchEvidence = new Set(
        batch.evidence.map((item) => item.evidence.evidenceId),
      );
      const processed = this.store
        .listEvidence(roleId)
        .filter(
          (item) =>
            batchEvidence.has(item.evidenceId) &&
            item.processingStatus === "processed",
        ).length;
      return {
        batchId: batch.batch.batchId,
        status: "completed",
        operations,
        evidenceProcessed: processed,
        errorCode: null,
        maintenance: batch.maintenance,
      };
    } catch (error) {
      const code =
        error instanceof MemoryOperationInvalidError ||
        error instanceof MemoryVersionConflictError ||
        isCapacityExceeded(error)
          ? error.code
          : "MEMORY_BATCH_FAILED";
      this.store.finishBatch({
        roleId,
        batchId: batch.batch.batchId,
        status: "failed",
        errorCode: code,
        nextRetryAt: new Date(
          this.now().getTime() + this.retryDelayForBatch(batch),
        ).toISOString(),
        now: this.now().toISOString(),
      });
      return {
        batchId: batch.batch.batchId,
        status: "failed",
        operations,
        evidenceProcessed: 0,
        errorCode: code,
        maintenance: batch.maintenance,
      };
    }
  }

  async runPending(
    roleId: string,
    options: { includeDeferred?: boolean; includeRefinement?: boolean } = {},
  ): Promise<MemoryDrainResult> {
    const batches: MemoryBatchRunResult[] = [];
    let includeDeferred = options.includeDeferred === true;
    const includeRefinement = options.includeRefinement === true;
    while (true) {
      const result = await this.runBatch(roleId, {
        includeDeferred,
        includeRefinement,
      });
      includeDeferred = false;
      if (result.status === "none") {
        break;
      }
      batches.push(result);
      if (result.maintenance) {
        break;
      }
    }
    const failed = batches.filter((item) => item.status === "failed").length;
    return {
      status:
        batches.length === 0
          ? "none"
          : failed === 0
            ? "completed"
            : failed === batches.length
              ? "failed"
              : "partial",
      batches,
      operations: batches.reduce((sum, item) => sum + item.operations, 0),
      evidenceProcessed: batches.reduce(
        (sum, item) => sum + item.evidenceProcessed,
        0,
      ),
    };
  }

  private retryDelayForBatch(batch: StartedBatch): number {
    const attempt =
      batch.evidence.reduce(
        (max, item) => Math.max(max, item.attemptCount),
        0,
      ) + 1;
    const delays =
      this.retryDelaysMs.length > 0
        ? this.retryDelaysMs
        : DEFAULT_MEMORY_RETRY_DELAYS_MS;
    const index = Math.min(Math.max(attempt - 1, 0), delays.length - 1);
    return delays[index] ?? 3_600_000;
  }

  private prepareBatchContext(roleId: string, evidenceText = ""): BatchContext {
    const currentRound = this.store.getCurrentRound(roleId);
    const refineCandidates = this.store.listRefineCandidates(
      roleId,
      currentRound,
    );
    const summaryCandidates = this.store.listSummaryCandidates(
      roleId,
      refineCandidates.map((candidate) => candidate.experienceDate),
    );
    return {
      roleName: this.store.roleName(roleId),
      currentRound,
      refineCandidates,
      summaryCandidates,
      relatedEvents: this.store.listRecentEvents(roleId, 20, evidenceText),
    };
  }

  private buildModelInput(
    roleId: string,
    batch: MemoryBatchRecord,
    next: NextSegment[],
    context: BatchContext,
  ): MemoryFormationInput {
    return {
      roleId,
      roleName: context.roleName,
      batchId: batch.batchId,
      currentRound: context.currentRound,
      evidence: next.map((item) => {
        const chars = Array.from(item.content);
        return {
          evidenceId: item.evidence.evidenceId,
          sourceKind: item.evidence.sourceKind,
          ...this.store.evidenceMessageContext(item.evidence.sourceKind, item.evidence.sourceId),
          sourceStatus: item.evidence.sourceStatus,
          windowId: item.evidence.windowId,
          occurredAt: item.evidence.occurredAt,
          localDate: item.evidence.localDate,
          content: chars
            .slice(item.segment.fromChar, item.segment.toChar)
            .join(""),
          segmentIndex: item.segment.segmentIndex,
          segmentCount: item.segmentCount,
        };
      }),
      relatedEvents: context.relatedEvents,
      refineCandidates: context.refineCandidates,
      summaryCandidates: context.summaryCandidates,
    };
  }

  private resolveClaims(
    claims: MemoryClaim[] | undefined,
    evidenceIds: readonly string[],
    segments: NextSegment[],
    relatedEvents: readonly RelatedEventBrief[],
  ): MemoryClaimRecord[] {
    return (claims ?? []).map(claim => {
      if (claim.relatedEventId && !relatedEvents.some(event => event.eventId === claim.relatedEventId)) {
        throw new MemoryOperationInvalidError("关联的成长经历不在本次整理上下文", { eventId: claim.relatedEventId });
      }
      let quoteContext: string | undefined;
      const segment = segments.find(item => {
        if (item.evidence.evidenceId !== claim.evidenceId) return false;
        if (claim.kind !== "user_quote" && claim.kind !== "shared_detail") return true;
        const message = this.store.evidenceMessageContext(item.evidence.sourceKind, item.evidence.sourceId);
        if (claim.kind === "shared_detail" && !message.publishedReply) return false;
        const expected = claim.kind === "user_quote" ? "user" : "assistant";
        const visible = Array.from(item.content).slice(item.segment.fromChar, item.segment.toChar).join("");
        const index = visible.indexOf(claim.text);
        if (message.sender !== expected || index < 0) return false;
        if (claim.kind === "user_quote") {
          // 取原消息中的前后语句，保留被短引文截掉的主体、时间和否定限定。
          const prefix = Array.from(item.content).slice(0, item.segment.fromChar).join("").length;
          const from = prefix + index;
          const end = from + claim.text.length;
          const before = item.content.slice(Math.max(0, from - 240), from).match(/[^。！？!?\n]*$/u)?.[0] ?? "";
          const after = /[。！？!?\n]$/u.test(claim.text) ? "" :
            item.content.slice(end, end + 240).match(/^[^。！？!?\n]*[。！？!?]?/u)?.[0] ?? "";
          quoteContext = before + claim.text + after;
        }
        return true;
      });
      if (!segment || !evidenceIds.includes(claim.evidenceId)) {
        throw new MemoryOperationInvalidError("说法必须与当前片段的来源、原话和事件证据匹配", { kind: claim.kind, evidenceId: claim.evidenceId });
      }
      const sourceAt = segment.evidence.occurredAt;
      // 知悉依据与后台整理各有时间；延迟运行整理不能改写角色历史。
      return {
        ...claim,
        ...(quoteContext === undefined ? {} : { quoteContext }),
        sourceKind: segment.evidence.sourceKind,
        sourceSender: this.store.evidenceMessageContext(segment.evidence.sourceKind, segment.evidence.sourceId).sender,
        sourceAt,
        learnedAt: claim.kind === "unknown" ? null : sourceAt,
        recordedAt: this.now().toISOString(),
      };
    });
  }

  private applyResponse(
    roleId: string,
    batch: StartedBatch,
    next: NextSegment[],
    response: MemoryFormationResponse,
    relatedEvents: readonly RelatedEventBrief[],
    refineCandidates: readonly { eventId: string }[],
    summaryCandidates: readonly { summaryId: string }[],
  ): void {
    const allowedCandidates = new Set(
      refineCandidates.map((candidate) => candidate.eventId),
    );
    const allowedSummaries = new Set(
      summaryCandidates.map((candidate) => candidate.summaryId),
    );
    const allowedEvidence = new Set(
      batch.evidence.map((item) => item.evidence.evidenceId),
    );
    const db = this.store.getDatabase();
    db.transaction(() => {
      const localKeys = new Set<string>();
      for (const operation of response.operations) {
        const evidenceIds = operationEvidenceIds(operation);
        for (const evidenceId of evidenceIds) {
          if (!allowedEvidence.has(evidenceId)) {
            throw new MemoryOperationInvalidError(
              "整理结果引用了本批次之外的证据",
              { evidenceId, batchId: batch.batch.batchId },
            );
          }
        }
        if (operation.op === "create_event") {
          if (localKeys.has(operation.localKey)) {
            throw new MemoryOperationInvalidError(
              "整理结果包含重复的 localKey",
              { localKey: operation.localKey },
            );
          }
          localKeys.add(operation.localKey);
          const expectedDate = localDateFromIso(
            operation.occurredAtStart,
            this.timeZone,
          );
          if (expectedDate !== operation.experienceDate) {
            throw new MemoryOperationInvalidError(
              "事件日期与发生时间不一致",
              {
                expectedDate,
                experienceDate: operation.experienceDate,
              },
            );
          }
        }
        if (operation.op === "update_event") {
          const event = this.store.getEvent(roleId, operation.eventId);
          if (event.version !== operation.expectedVersion) {
            throw new MemoryOperationInvalidError(
              "整理目标版本已变化",
              {
                eventId: operation.eventId,
                expected: operation.expectedVersion,
                actual: event.version,
              },
            );
          }
          if (
            Object.keys(operation.patch).length === 0 &&
            !operation.claims?.length &&
            (operation.addEvidenceIds?.length ?? 0) === 0
          ) {
            throw new MemoryOperationInvalidError(
              "事件更新没有提供任何变化",
              { eventId: operation.eventId },
            );
          }
        }
        if (operation.op === "refine_event") {
          const seenEvents = new Set<string>();
          for (const target of operation.events) {
            if (seenEvents.has(target.eventId)) {
              throw new MemoryOperationInvalidError(
                "精炼目标事件重复",
                { eventId: target.eventId },
              );
            }
            seenEvents.add(target.eventId);
            if (!allowedCandidates.has(target.eventId)) {
              throw new MemoryOperationInvalidError(
                "精炼目标不在本批候选内",
                { eventId: target.eventId },
              );
            }
            const event = this.store.getEvent(roleId, target.eventId);
            if (event.version !== target.expectedVersion) {
              throw new MemoryOperationInvalidError(
                "精炼目标版本已变化",
                {
                  eventId: target.eventId,
                  expected: target.expectedVersion,
                  actual: event.version,
                },
              );
            }
          }
          if (
            operation.targetSummaryId !== undefined &&
            !allowedSummaries.has(operation.targetSummaryId)
          ) {
            throw new MemoryOperationInvalidError(
              "摘要聚合目标不在本批候选内",
              { summaryId: operation.targetSummaryId },
            );
          }
        }
      }
      for (const operation of response.operations) {
        if (operation.op === "create_event") {
          this.store.createEvent({
            roleId,
            claims: this.resolveClaims(operation.claims, operation.evidenceIds, next, relatedEvents),
            title: operation.title,
            summary: operation.summary,
            subjectiveExperience: operation.subjectiveExperience ?? "",
            occurredAtStart: operation.occurredAtStart,
            occurredAtEnd: operation.occurredAtEnd ?? null,
            experienceDate: operation.experienceDate,
            tags: operation.tags ?? {},
            evidenceIds: operation.evidenceIds,
            currentRound: this.store.getCurrentRound(roleId),
            now: this.now().toISOString(),
          });
          continue;
        }
        if (operation.op === "update_event") {
          this.store.updateEvent({
            roleId,
            eventId: operation.eventId,
            expectedVersion: operation.expectedVersion,
            claims: this.resolveClaims(operation.claims, operation.addEvidenceIds ?? [], next, relatedEvents),
            patch: operation.patch,
            addEvidenceIds: operation.addEvidenceIds ?? [],
            currentRound: this.store.getCurrentRound(roleId),
            now: this.now().toISOString(),
            ...(operation.patch.occurredAtStart
              ? {
                  experienceDate: localDateFromIso(
                    operation.patch.occurredAtStart,
                    this.timeZone,
                  ),
                }
              : {}),
          });
          continue;
        }
        if (operation.op === "refine_event") {
          this.store.refineEvent({
            roleId,
            events: operation.events,
            summary: operation.summary,
            ...(operation.targetSummaryId === undefined
              ? {}
              : { targetSummaryId: operation.targetSummaryId }),
            ...(operation.expectedSummaryVersion === undefined
              ? {}
              : { expectedSummaryVersion: operation.expectedSummaryVersion }),
            ...(operation.topic === undefined
              ? {}
              : { topic: operation.topic }),
            ...(operation.reason === undefined
              ? {}
              : { reason: operation.reason }),
            now: this.now().toISOString(),
          });
          continue;
        }
        for (const evidenceId of operation.evidenceIds) {
          this.store.markEvidenceDeferred({
            roleId,
            batchId: batch.batch.batchId,
            evidenceId,
            afterSequence: batch.batch.inputToSequence,
            now: this.now().toISOString(),
          });
        }
      }
      const deferredEvidence = new Set<string>();
      for (const operation of response.operations) {
        if (operation.op !== "defer") {
          continue;
        }
        for (const evidenceId of operation.evidenceIds) {
          deferredEvidence.add(evidenceId);
        }
      }
      for (const item of next) {
        if (deferredEvidence.has(item.evidence.evidenceId)) {
          continue;
        }
        this.store.markSegmentProcessed(
          item.evidence.evidenceId,
          item.segment.segmentIndex,
          this.now().toISOString(),
        );
      }
    })();
  }

  private startModelCall(
    roleId: string,
    batch: MemoryBatchRecord,
    now: string,
  ): string {
    const callId = randomUUID();
    const db = this.store.getDatabase();
    db.prepare(
      `INSERT INTO model_calls
       (model_call_id, role_id, execution_id, batch_id, task_id, call_kind,
        purpose, resource_id, model_name, protocol, status, error_code,
        started_at, finished_at, usage_json, raw_response_json)
       VALUES (?, ?, NULL, ?, NULL, 'memory_maintenance', 'memory_maintenance', ?, ?, ?, 'running', NULL, ?, NULL, NULL, NULL)`,
    ).run(
      callId,
      roleId,
      batch.batchId,
      this.modelInfo.resourceId ?? null,
      this.modelInfo.modelName,
      this.modelInfo.protocol,
      now,
    );
    db.prepare(
      `INSERT INTO call_metering
       (metering_id, role_id, execution_id, task_id, batch_id, call_kind, call_id,
        purpose, counted, created_at)
       VALUES (?, ?, NULL, NULL, ?, 'model', ?, 'memory_maintenance', 0, ?)`,
    ).run(randomUUID(), roleId, batch.batchId, callId, now);
    return callId;
  }

  private finishModelCall(
    roleId: string,
    callId: string,
    status: "succeeded" | "failed",
    errorCode: string | null,
    usage: ModelUsage | null,
    meta: MemoryModelInfo,
    recordGlobalUsage = true,
  ): void {
    const finishedAt = this.now().toISOString();
    const resourceId = meta.resourceId ?? this.modelInfo.resourceId ?? null;
    try {
      this.store.getDatabase().prepare(
        `UPDATE model_calls
            SET status = ?, error_code = ?, finished_at = ?, usage_json = ?,
                resource_id = ?, model_name = ?, protocol = ?
         WHERE model_call_id = ?`,
      ).run(
        status,
        errorCode,
        finishedAt,
        usage === null ? null : JSON.stringify(usage),
        resourceId,
        meta.modelName,
        meta.protocol,
        callId,
      );
    } finally {
      // 未真正向模型发起调用（如本地容量预检拦截）不计入全局调用；已调用则隔离角色库写失败。
      if (recordGlobalUsage) {
        this.onModelCallFinished?.({
          sourceCallId: `role:${roleId}:${callId}`,
          roleId,
          resourceId,
          modelName: meta.modelName,
          protocol: meta.protocol,
          category: "memory",
          status,
          occurredAt: finishedAt,
          usage,
        });
      }
    }
  }
}

function operationEvidenceIds(operation: MemoryOperation): readonly string[] {
  if (operation.op === "create_event") {
    return operation.evidenceIds;
  }
  if (operation.op === "update_event") {
    return operation.addEvidenceIds ?? [];
  }
  if (operation.op === "defer") {
    return operation.evidenceIds;
  }
  return [];
}

function isBatchConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === "MEMORY_BATCH_CONFLICT"
  );
}

function isCapacityExceeded(error: unknown): error is AppError {
  return (
    error instanceof AppError && error.code === "MEMORY_CAPACITY_EXCEEDED"
  );
}
