import { randomUUID } from "node:crypto";
import { localDateFromIso } from "../storage/evidence.js";
import {
  DEFAULT_MEMORY_BUDGET_CHARS,
  DEFAULT_MEMORY_RETRY_DELAYS_MS,
  DEFAULT_OUTPUT_RESERVE_CHARS,
  memoryFormationResponseSchema,
  type MemoryBatchRecord,
  type MemoryFormationInput,
  type MemoryFormationResponse,
  type MemoryModelInfo,
  type MemoryModelPort,
  type MemoryOperation,
} from "../domain/memory.js";
import {
  MemoryOperationInvalidError,
  MemoryVersionConflictError,
} from "../domain/errors.js";
import type {
  MemoryStore,
  NextSegment,
  StartedBatch,
} from "../storage/memory-store.js";

export interface MemoryServiceOptions {
  modelInfo?: MemoryModelInfo;
  budgetChars?: number;
  outputReserveChars?: number;
  retryDelaysMs?: readonly number[];
  idleMs?: number;
  timeZone?: string;
  now?: () => Date;
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
  private readonly retryDelaysMs: readonly number[];
  private readonly idleMs: number;
  private readonly timeZone: string | undefined;
  private readonly now: () => Date;

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
    this.budgetChars = options.budgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS;
    this.outputReserveChars =
      options.outputReserveChars ?? DEFAULT_OUTPUT_RESERVE_CHARS;
    this.retryDelaysMs =
      options.retryDelaysMs ?? DEFAULT_MEMORY_RETRY_DELAYS_MS;
    this.idleMs = options.idleMs ?? 60_000;
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
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
    let batch: StartedBatch | null;
    try {
      batch = this.store.startBatch({
        roleId,
        budgetChars: this.budgetChars,
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
        const next = maintenanceCall
          ? []
          : this.store.getNextSegments(
              roleId,
              batch.batch.batchId,
              this.budgetChars,
            );
        maintenanceCall = false;
        if (next.length === 0 && !batch.maintenance) {
          break;
        }
        const callId = this.startModelCall(
          roleId,
          batch.batch,
          this.now().toISOString(),
        );
        let response: MemoryFormationResponse;
        try {
          const modelInput = this.buildModelInput(
            roleId,
            batch.batch,
            next,
          );
          const refineCandidates = modelInput.refineCandidates;
          const summaryCandidates = modelInput.summaryCandidates;
          const raw = await this.model.form(modelInput);
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
            refineCandidates,
            summaryCandidates,
          );
          this.finishModelCall(callId, "succeeded", null);
          operations += response.operations.length;
          if (batch.maintenance) {
            break;
          }
        } catch (error) {
          const code =
            error instanceof MemoryOperationInvalidError ||
            error instanceof MemoryVersionConflictError
              ? error.code
              : "MEMORY_MODEL_FAILED";
          this.finishModelCall(callId, "failed", code);
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
        error instanceof MemoryVersionConflictError
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

  private buildModelInput(
    roleId: string,
    batch: MemoryBatchRecord,
    next: NextSegment[],
  ): MemoryFormationInput {
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
      roleId,
      batchId: batch.batchId,
      currentRound,
      evidence: next.map((item) => {
        const chars = Array.from(item.content);
        return {
          evidenceId: item.evidence.evidenceId,
          sourceKind: item.evidence.sourceKind,
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
      relatedEvents: this.store.listRecentEvents(roleId),
      refineCandidates,
      summaryCandidates,
    };
  }

  private applyResponse(
    roleId: string,
    batch: StartedBatch,
    next: NextSegment[],
    response: MemoryFormationResponse,
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
       (model_call_id, role_id, execution_id, batch_id, purpose, resource_id,
        model_name, protocol, status, error_code, started_at, finished_at,
        usage_json, raw_response_json)
       VALUES (?, ?, NULL, ?, 'memory_maintenance', NULL, ?, ?, 'running', NULL, ?, NULL, NULL, NULL)`,
    ).run(
      callId,
      roleId,
      batch.batchId,
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
    callId: string,
    status: "succeeded" | "failed",
    errorCode: string | null,
  ): void {
    this.store.getDatabase().prepare(
      `UPDATE model_calls SET status = ?, error_code = ?, finished_at = ?
       WHERE model_call_id = ?`,
    ).run(status, errorCode, this.now().toISOString(), callId);
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
