import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  MemoryBatchConflictError,
  MemoryOperationInvalidError,
} from "../../domain/errors.js";
import type {
  MemoryBatchRecord,
  MemoryTriggerKind,
} from "../../domain/memory.js";
import type { MemoryEventStore } from "./memory-event-store.js";
import type { MemoryEvidenceStore } from "./memory-evidence-store.js";
import {
  loadEvidenceContent,
  mapBatch,
  mapEvidence,
} from "./memory-store-types.js";
import type {
  BatchRow,
  EnqueueTriggerInput,
  EvidenceRow,
  FinishBatchInput,
  PendingTrigger,
  StartBatchInput,
  StartedBatch,
  StartedEvidence,
} from "./memory-store-types.js";

export class MemoryBatchStore {
  private readonly db: Database.Database;
  private readonly evidence: MemoryEvidenceStore;
  private readonly events: MemoryEventStore;

  constructor(
    db: Database.Database,
    evidence: MemoryEvidenceStore,
    events: MemoryEventStore,
  ) {
    this.db = db;
    this.evidence = evidence;
    this.events = events;
  }

  getCurrentRound(roleId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(decision_round), 0) AS round FROM executions WHERE role_id = ?",
      )
      .get(roleId) as { round: number };
    return row.round;
  }

  enqueueTrigger(input: EnqueueTriggerInput): { triggerId: string; duplicate: boolean } {
    const now = input.now ?? new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT trigger_id FROM memory_triggers
         WHERE role_id = ? AND kind = ? AND consumed_at IS NULL
           AND COALESCE(window_id, '') = COALESCE(?, '')
           AND COALESCE(task_id, '') = COALESCE(?, '')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(
        input.roleId,
        input.kind,
        input.windowId ?? null,
        input.taskId ?? null,
      ) as { trigger_id: string } | undefined;
    if (existing) {
      return { triggerId: existing.trigger_id, duplicate: true };
    }
    const triggerId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_triggers
         (trigger_id, role_id, kind, window_id, task_id, consumed_at, batch_id, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        triggerId,
        input.roleId,
        input.kind,
        input.windowId ?? null,
        input.taskId ?? null,
        now,
      );
    return { triggerId, duplicate: false };
  }

  listPendingTriggers(roleId: string): PendingTrigger[] {
    const rows = this.db
      .prepare(
        `SELECT trigger_id, kind, window_id, task_id, created_at, batch_id
         FROM memory_triggers
         WHERE role_id = ? AND consumed_at IS NULL
         ORDER BY created_at ASC, trigger_id ASC`,
      )
      .all(roleId) as Array<{
        trigger_id: string;
        kind: MemoryTriggerKind;
        window_id: string | null;
        task_id: string | null;
        created_at: string;
        batch_id: string | null;
      }>;
    return rows.map((row) => ({
      triggerId: row.trigger_id,
      kind: row.kind,
      windowId: row.window_id,
      taskId: row.task_id,
      createdAt: row.created_at,
      batchId: row.batch_id,
    }));
  }

  /** 列出已结束且仍有待整理工具证据、但缺少未消费 task_end 触发的任务。 */
  listFinishedTasksNeedingTrigger(roleId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.task_id
         FROM tasks t
         WHERE t.role_id = ?
           AND t.status IN ('completed', 'failed')
           AND EXISTS (
             SELECT 1
             FROM evidence_records er
             JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
             WHERE er.role_id = t.role_id
               AND er.task_id = t.task_id
               AND ep.status = 'pending'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM memory_triggers mt
             WHERE mt.role_id = t.role_id
               AND mt.kind = 'task_end'
               AND mt.task_id = t.task_id
               AND mt.consumed_at IS NULL
           )
         ORDER BY t.updated_at ASC, t.task_id ASC`,
      )
      .all(roleId) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  /** 从已持久化任务与工具证据逐项对账补写缺失的 task_end 触发；单项失败不影响其余任务（283 §21/§22）。 */
  reconcileFinishedTaskTriggers(
    roleId: string,
    now?: string,
  ): { inserted: number; failedTaskIds: string[] } {
    const taskIds = this.listFinishedTasksNeedingTrigger(roleId);
    let inserted = 0;
    const failedTaskIds: string[] = [];
    for (const taskId of taskIds) {
      try {
        const result = this.db.transaction(() =>
          this.enqueueTrigger({
            roleId,
            kind: "task_end",
            taskId,
            ...(now === undefined ? {} : { now }),
          }),
        )();
        if (!result.duplicate) {
          inserted += 1;
        }
      } catch {
        failedTaskIds.push(taskId);
      }
    }
    return { inserted, failedTaskIds };
  }

  startBatch(input: StartBatchInput): StartedBatch | null {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const running = this.db
        .prepare(
          "SELECT batch_id FROM memory_batches WHERE role_id = ? AND status = 'running' LIMIT 1",
        )
        .get(input.roleId) as { batch_id: string } | undefined;
      if (running) {
        throw new MemoryBatchConflictError(input.roleId);
      }
      const maintenanceRequested = input.maintenanceOnly === true;
      if (maintenanceRequested) {
        return this.startMaintenanceBatch(input, now, false);
      }
      if (input.includeDeferred === true) {
        // 手动整理领取时固定本轮延后证据；本轮再次 defer 的证据不会被重复领取。
        this.db.prepare(`UPDATE evidence_processing SET status = 'pending'
          WHERE status = 'deferred' AND evidence_id IN
            (SELECT evidence_id FROM evidence_records WHERE role_id = ?)`)
          .run(input.roleId);
      }
      const rows = this.db
        .prepare(
          `SELECT er.*, turn.sessionId AS exchange_session_id, ep.status AS processing_status, ep.next_retry_at,
                  ep.deferred_after_sequence, ep.attempt_count
           FROM evidence_records er
           JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
           LEFT JOIN role_exchange_turns turn ON er.source_kind='role_exchange' AND turn.exchangeId=er.source_id
           WHERE er.role_id = ?
             AND (er.source_kind <> 'role_exchange' OR EXISTS (
               SELECT 1 FROM role_exchange_sessions s WHERE s.sessionId=turn.sessionId AND s.status <> 'active'))
             AND (
               ep.status = 'pending'
               OR (ep.status = 'failed' AND (ep.next_retry_at IS NULL OR ep.next_retry_at <= ?))
               OR (
                 ep.status = 'deferred'
                 AND (
                   ? = 1
                   OR ((SELECT MAX(x.role_sequence) FROM evidence_records x
                       WHERE x.role_id = er.role_id) > ep.deferred_after_sequence
                       AND NOT EXISTS (SELECT 1 FROM memory_triggers mt
                         WHERE mt.role_id = er.role_id AND mt.kind = 'manual'
                           AND mt.consumed_at IS NULL AND mt.batch_id IS NOT NULL))
                 )
               )
             )
           ORDER BY er.role_sequence ASC`,
        )
        .all(input.roleId, now, input.includeDeferred ? 1 : 0) as Array<
        EvidenceRow & { attempt_count: number; exchange_session_id: string | null }
      >;
      if (rows.length === 0) {
        if (input.includeRefinement !== true) {
          return null;
        }
        const maintenance = this.startMaintenanceBatch(input, now, true);
        if (maintenance === null) {
          // 在同一事务中确认没有可处理证据或精炼候选，结算空触发，避免定时器无限重试。
          this.db.prepare(
            `UPDATE memory_triggers SET consumed_at = ?
             WHERE role_id = ? AND consumed_at IS NULL`,
          ).run(now, input.roleId);
        }
        return maintenance;
      }
      // 互聊没有用户窗口，按会话归组，避免一次整理把不同往来的发言归给同一个人。
      const first = rows[0]!;
      const grouped = rows.filter(
        (row) => row.window_id === first.window_id && row.exchange_session_id === first.exchange_session_id,
      );
      const selected: Array<{ row: EvidenceRow & { attempt_count: number }; content: string }> = [];
      let usedChars = 0;
      for (const row of grouped) {
        const content = loadEvidenceContent(this.db, row);
        const length = Array.from(content).length;
        if (selected.length > 0 && usedChars + Math.min(length, input.budgetChars) > input.budgetChars) {
          break;
        }
        selected.push({ row, content });
        usedChars += Math.min(length, input.budgetChars);
        if (usedChars >= input.budgetChars) {
          break;
        }
      }
      if (selected.length === 0) {
        return null;
      }
      const batchId = randomUUID();
      const fromSequence = Math.min(...selected.map((item) => item.row.role_sequence));
      const toSequence = Math.max(...selected.map((item) => item.row.role_sequence));
      this.db
        .prepare(
          `INSERT INTO memory_batches
           (batch_id, role_id, status, input_from_sequence, input_to_sequence,
            context_budget_chars, output_reserve_chars, attempt_count, last_error_code,
            started_at, finished_at, created_at)
           VALUES (?, ?, 'running', ?, ?, ?, ?, 0, NULL, ?, NULL, ?)`,
        )
        .run(
          batchId,
          input.roleId,
          fromSequence,
          toSequence,
          input.budgetChars,
          input.outputReserveChars,
          now,
          now,
        );
      const evidence: StartedEvidence[] = [];
      for (const item of selected) {
        this.db
          .prepare(
            `UPDATE evidence_processing
             SET status = 'processing', last_batch_id = ?, updated_at = ?
             WHERE evidence_id = ?`,
          )
          .run(batchId, now, item.row.evidence_id);
        const segments = this.evidence.ensureSegments(
          item.row.evidence_id,
          item.content,
          input.budgetChars,
          batchId,
          now,
        );
        evidence.push({
          evidence: mapEvidence(item.row),
          content: item.content,
          segments,
          attemptCount: item.row.attempt_count,
        });
      }
      this.db
        .prepare(
          `UPDATE memory_triggers
           SET consumed_at = ?, batch_id = ?
           WHERE role_id = ? AND consumed_at IS NULL AND kind <> 'manual'`,
        )
        .run(now, batchId, input.roleId);
      this.db.prepare(`UPDATE memory_triggers SET batch_id = ?
        WHERE role_id = ? AND kind = 'manual' AND consumed_at IS NULL AND batch_id IS NULL`)
        .run(batchId, input.roleId);
      const batch = this.getBatch(input.roleId, batchId);
      return { batch, evidence, maintenance: false };
    })();
  }

  private startMaintenanceBatch(
    input: {
      roleId: string;
      budgetChars: number;
      outputReserveChars: number;
    },
    now: string,
    consumeTriggers: boolean,
  ): StartedBatch | null {
    if (
      this.events.listRefineCandidates(
        input.roleId,
        this.getCurrentRound(input.roleId),
      ).length === 0
    ) {
      return null;
    }
    const maintenanceId = randomUUID();
    // 维护批次没有证据，用 0/0 区间与普通证据批次区分；连续失败次数跨批保留。
    this.db
      .prepare(
        `INSERT INTO memory_batches
         (batch_id, role_id, status, input_from_sequence, input_to_sequence,
          context_budget_chars, output_reserve_chars, attempt_count, last_error_code,
          started_at, finished_at, created_at)
         VALUES (?, ?, 'running', 0, 0, ?, ?, ?, NULL, ?, NULL, ?)`,
      )
      .run(
        maintenanceId,
        input.roleId,
        input.budgetChars,
        input.outputReserveChars,
        this.consecutiveMaintenanceFailures(input.roleId),
        now,
        now,
      );
    if (consumeTriggers) {
      this.db
        .prepare(
          `UPDATE memory_triggers
           SET consumed_at = ?, batch_id = ?
           WHERE role_id = ? AND consumed_at IS NULL`,
        )
        .run(now, maintenanceId, input.roleId);
    }
    return {
      batch: this.getBatch(input.roleId, maintenanceId),
      evidence: [],
      maintenance: true,
    };
  }

  private consecutiveMaintenanceFailures(roleId: string): number {
    const rows = this.db
      .prepare(
        `SELECT status FROM memory_batches
         WHERE role_id = ? AND input_from_sequence = 0 AND input_to_sequence = 0
         ORDER BY created_at DESC, rowid DESC LIMIT 100`,
      )
      .all(roleId) as Array<{ status: string }>;
    let failures = 0;
    for (const row of rows) {
      if (row.status !== "failed") {
        break;
      }
      failures += 1;
    }
    return failures;
  }

  finishBatch(input: FinishBatchInput): void {
    const now = input.now ?? new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE memory_batches
           SET status = ?, last_error_code = ?, finished_at = ?
           WHERE batch_id = ? AND role_id = ? AND status = 'running'`,
        )
        .run(input.status, input.errorCode ?? null, now, input.batchId, input.roleId);
      if (input.status === "failed") {
        this.db
          .prepare(
            `UPDATE memory_batches
             SET attempt_count = attempt_count + 1
             WHERE batch_id = ? AND role_id = ?`,
          )
          .run(input.batchId, input.roleId);
        this.db
          .prepare(
            `UPDATE evidence_processing
             SET status = 'failed', attempt_count = attempt_count + 1,
                 next_retry_at = ?, last_error_code = ?, updated_at = ?
             WHERE last_batch_id = ? AND status = 'processing'`,
          )
          .run(
            input.nextRetryAt ?? now,
            input.errorCode ?? "MEMORY_BATCH_FAILED",
            now,
            input.batchId,
          );
      } else {
        this.db
          .prepare(
            `UPDATE evidence_processing
             SET status = 'processed', next_retry_at = NULL, deferred_after_sequence = NULL,
                 last_error_code = NULL, updated_at = ?
             WHERE last_batch_id = ? AND status = 'processing'
               AND NOT EXISTS (
                 SELECT 1 FROM memory_evidence_segments s
                 WHERE s.evidence_id = evidence_processing.evidence_id
                   AND s.status != 'processed'
               )`,
          )
          .run(now, input.batchId);
      }
    })();
  }

  recoverInterruptedBatches(
    roleId: string,
    now = new Date().toISOString(),
  ): number {
    const rows = this.db
      .prepare(
        "SELECT batch_id FROM memory_batches WHERE role_id = ? AND status = 'running' ORDER BY started_at ASC",
      )
      .all(roleId) as Array<{ batch_id: string }>;
    for (const row of rows) {
      this.finishBatch({
        roleId,
        batchId: row.batch_id,
        status: "failed",
        errorCode: "PROCESS_INTERRUPTED",
        nextRetryAt: now,
        now,
      });
    }
    return rows.length;
  }

  getBatch(roleId: string, batchId: string): MemoryBatchRecord {
    const row = this.db
      .prepare(
        `SELECT batch_id, role_id, status, input_from_sequence, input_to_sequence,
                context_budget_chars, output_reserve_chars, attempt_count,
                last_error_code, started_at, finished_at, created_at
         FROM memory_batches WHERE batch_id = ? AND role_id = ?`,
      )
      .get(batchId, roleId) as BatchRow | undefined;
    if (!row) {
      throw new MemoryOperationInvalidError("记忆整理批次不存在", { batchId });
    }
    return mapBatch(row);
  }

  latestMaintenanceBatch(roleId: string): MemoryBatchRecord | null {
    const row = this.db
      .prepare(
        `SELECT batch_id, role_id, status, input_from_sequence, input_to_sequence,
                context_budget_chars, output_reserve_chars, attempt_count,
                last_error_code, started_at, finished_at, created_at
         FROM memory_batches
         WHERE role_id = ? AND input_from_sequence = 0 AND input_to_sequence = 0
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(roleId) as BatchRow | undefined;
    return row === undefined ? null : mapBatch(row);
  }
}
