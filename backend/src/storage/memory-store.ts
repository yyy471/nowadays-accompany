import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AppError,
  DiaryNotFoundError,
  MemoryBatchConflictError,
  MemoryEventNotFoundError,
  MemoryOperationInvalidError,
  MemorySummaryNotFoundError,
  MemoryVersionConflictError,
} from "../domain/errors.js";
import type {
  DailySummaryBrief,
  DailySummaryRecord,
  DailySummarySourceRecord,
  DiaryDetail,
  DiaryRecord,
  MemoryBatchRecord,
  MemoryEventPatch,
  MemoryEventRecord,
  MemoryEventSourceRecord,
  MemoryEvidenceDetail,
  MemoryEvidenceRecord,
  MemoryRecordType,
  MemorySegmentRecord,
  MemorySourceKind,
  MemoryTagValues,
  MemoryTriggerKind,
  RefineCandidateBrief,
  RelatedEventBrief,
  SummaryEvidenceItem,
} from "../domain/memory.js";

interface EvidenceRow {
  evidence_id: string;
  role_id: string;
  source_kind: MemorySourceKind;
  source_id: string;
  window_id: string | null;
  task_id: string | null;
  execution_id: string | null;
  source_status: string;
  occurred_at: string;
  local_date: string;
  role_sequence: number;
  processing_status: string;
  next_retry_at: string | null;
  deferred_after_sequence: number | null;
}

interface SegmentRow {
  evidence_id: string;
  segment_index: number;
  from_char: number;
  to_char: number;
  status: "pending" | "processed" | "failed";
  batch_id: string | null;
}

interface EventRow {
  event_id: string;
  role_id: string;
  title: string;
  summary: string;
  subjective_experience: string;
  occurred_at_start: string;
  occurred_at_end: string | null;
  experience_date: string;
  lifecycle_status: "active" | "refined";
  refined_summary_id: string | null;
  version: number;
  last_supplemented_round: number;
  created_at: string;
  updated_at: string;
}

interface BatchRow {
  batch_id: string;
  role_id: string;
  status: "running" | "completed" | "failed" | "partial";
  input_from_sequence: number;
  input_to_sequence: number;
  context_budget_chars: number;
  output_reserve_chars: number;
  attempt_count: number;
  last_error_code: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

interface SummaryRow {
  summary_id: string;
  role_id: string;
  experience_date: string;
  topic: string;
  summary: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface SummarySourceRow {
  summary_source_id: string;
  summary_id: string;
  window_id: string | null;
  from_sequence: number | null;
  to_sequence: number | null;
  occurred_from: string;
  occurred_to: string;
}

interface DiaryRow {
  diary_id: string;
  role_id: string;
  relative_path: string;
  content: string;
  content_hash: string;
  occurred_at: string;
  experience_date: string;
  created_at: string;
  updated_at: string;
}

export interface StartedEvidence {
  evidence: MemoryEvidenceRecord;
  content: string;
  segments: MemorySegmentRecord[];
  attemptCount: number;
}

export interface StartedBatch {
  batch: MemoryBatchRecord;
  evidence: StartedEvidence[];
  maintenance: boolean;
}

export interface NextSegment {
  evidence: MemoryEvidenceRecord;
  content: string;
  segment: MemorySegmentRecord;
  segmentCount: number;
}

export interface CreateEventInput {
  roleId: string;
  title: string;
  summary: string;
  subjectiveExperience: string;
  occurredAtStart: string;
  occurredAtEnd: string | null;
  experienceDate: string;
  tags: MemoryTagValues;
  evidenceIds: readonly string[];
  currentRound: number;
  now: string;
}

export interface UpdateEventInput {
  roleId: string;
  eventId: string;
  expectedVersion: number;
  patch: MemoryEventPatch;
  addEvidenceIds: readonly string[];
  currentRound: number;
  now: string;
  experienceDate?: string;
  changeSource?: "memory_batch" | "agent_correction";
}

export interface MemoryStatus {
  runningBatchId: string | null;
  pendingEvidence: number;
  failedEvidence: number;
  deferredEvidence: number;
  pendingTriggers: number;
  lastBatch: MemoryBatchRecord | null;
}

export class MemoryStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  getCurrentRound(roleId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(decision_round), 0) AS round FROM executions WHERE role_id = ?",
      )
      .get(roleId) as { round: number };
    return row.round;
  }

  enqueueTrigger(input: {
    roleId: string;
    kind: MemoryTriggerKind;
    windowId?: string | null;
    taskId?: string | null;
    now?: string;
  }): { triggerId: string; duplicate: boolean } {
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

  listPendingTriggers(roleId: string): Array<{
    triggerId: string;
    kind: MemoryTriggerKind;
    windowId: string | null;
    taskId: string | null;
    createdAt: string;
    batchId: string | null;
  }> {
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

  pendingMessageStats(roleId: string): Array<{
    windowId: string | null;
    count: number;
    lastOccurredAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT er.window_id, COUNT(*) AS count, MAX(er.occurred_at) AS last_occurred_at
         FROM evidence_records er
         JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
         WHERE er.role_id = ? AND er.source_kind = 'message' AND ep.status = 'pending'
         GROUP BY er.window_id`,
      )
      .all(roleId) as Array<{
        window_id: string | null;
        count: number;
        last_occurred_at: string;
      }>;
    return rows.map((row) => ({
      windowId: row.window_id,
      count: row.count,
      lastOccurredAt: row.last_occurred_at,
    }));
  }

  pendingTaskEvidenceCount(roleId: string, taskId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM evidence_records er
         JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
         WHERE er.role_id = ? AND er.task_id = ? AND ep.status = 'pending'`,
      )
      .get(roleId, taskId) as { count: number };
    return row.count;
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

  nextFailedRetryAt(roleId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MIN(ep.next_retry_at) AS at
           FROM evidence_processing ep
           JOIN evidence_records er ON er.evidence_id = ep.evidence_id
          WHERE er.role_id = ? AND ep.status = 'failed'
            AND ep.next_retry_at IS NOT NULL`,
      )
      .get(roleId) as { at: string | null };
    return row.at;
  }

  hasDueFailedEvidence(roleId: string, now: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS due
           FROM evidence_processing ep
           JOIN evidence_records er ON er.evidence_id = ep.evidence_id
          WHERE er.role_id = ? AND ep.status = 'failed'
            AND (ep.next_retry_at IS NULL OR ep.next_retry_at <= ?)
          LIMIT 1`,
      )
      .get(roleId, now) as { due: number } | undefined;
    return row !== undefined;
  }

  startBatch(input: {
    roleId: string;
    budgetChars: number;
    outputReserveChars: number;
    includeDeferred?: boolean;
    includeRefinement?: boolean;
    maintenanceOnly?: boolean;
    now?: string;
  }): StartedBatch | null {
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
          `SELECT er.*, ep.status AS processing_status, ep.next_retry_at,
                  ep.deferred_after_sequence, ep.attempt_count
           FROM evidence_records er
           JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
           WHERE er.role_id = ?
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
        EvidenceRow & { attempt_count: number }
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
      const windowKey = rows[0]?.window_id ?? "";
      const grouped = rows.filter(
        (row) => (row.window_id ?? "") === windowKey,
      );
      const selected: Array<{ row: EvidenceRow & { attempt_count: number }; content: string }> = [];
      let usedChars = 0;
      for (const row of grouped) {
        const content = this.loadEvidenceContent(row);
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
        const segments = this.ensureSegments(
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
      this.listRefineCandidates(
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

  getNextSegments(
    roleId: string,
    batchId: string,
    budgetChars: number,
    options: { serialized?: boolean } = {},
  ): NextSegment[] {
    const serialized = options.serialized === true;
    if (serialized) {
      this.splitOversizedSegments(roleId, batchId, budgetChars);
    }
    const rows = this.db
      .prepare(
        `SELECT s.evidence_id, s.segment_index, s.from_char, s.to_char, s.status, s.batch_id,
                er.role_id, er.source_kind, er.source_id, er.window_id, er.task_id,
                er.execution_id, er.source_status, er.occurred_at, er.local_date, er.role_sequence
         FROM memory_evidence_segments s
         JOIN evidence_records er ON er.evidence_id = s.evidence_id
         JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
         WHERE s.batch_id = ? AND er.role_id = ? AND ep.status = 'processing'
           AND s.status IN ('pending', 'failed')
         ORDER BY er.role_sequence ASC, s.segment_index ASC`,
      )
      .all(batchId, roleId) as Array<
      SegmentRow & {
        role_id: string;
        source_kind: MemorySourceKind;
        source_id: string;
        window_id: string | null;
        task_id: string | null;
        execution_id: string | null;
        source_status: string;
        occurred_at: string;
        local_date: string;
        role_sequence: number;
      }
    >;
    const selected: NextSegment[] = [];
    let usedChars = 0;
    const contentCache = new Map<string, string>();
    const segmentCounts = new Map<string, number>();
    const contentOf = (evidenceId: string, load: () => string): string => {
      let content = contentCache.get(evidenceId);
      if (content === undefined) {
        content = load();
        contentCache.set(evidenceId, content);
        segmentCounts.set(
          evidenceId,
          (
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM memory_evidence_segments WHERE evidence_id = ?",
              )
              .get(evidenceId) as { count: number }
          ).count,
        );
      }
      return content;
    };
    for (const row of rows) {
      const content = contentOf(row.evidence_id, () =>
        this.loadEvidenceContent(row),
      );
      const itemChars = serialized
        ? // 按完整请求中的序列化长度核算，转义字符与证据元数据均计入。
          this.serializedEvidenceItem(
            row,
            Array.from(content)
              .slice(row.from_char, row.to_char)
              .join(""),
            segmentCounts.get(row.evidence_id) ?? 1,
          ) + 1
        : Math.max(0, row.to_char - row.from_char);
      if (serialized) {
        if (usedChars + itemChars > budgetChars) {
          if (selected.length === 0) {
            throw new AppError(
              502,
              "MEMORY_CAPACITY_EXCEEDED",
              "单条证据片段超过模型可用容量",
              {
                evidenceId: row.evidence_id,
                segmentIndex: row.segment_index,
                itemChars,
                budgetChars,
              },
            );
          }
          break;
        }
      } else if (selected.length > 0 && usedChars + itemChars > budgetChars) {
        break;
      }
      selected.push({
        evidence: mapEvidence({
          evidence_id: row.evidence_id,
          role_id: row.role_id,
          source_kind: row.source_kind,
          source_id: row.source_id,
          window_id: row.window_id,
          task_id: row.task_id,
          execution_id: row.execution_id,
          source_status: row.source_status,
          occurred_at: row.occurred_at,
          local_date: row.local_date,
          role_sequence: row.role_sequence,
          processing_status: "processing",
          next_retry_at: null,
          deferred_after_sequence: null,
        }),
        content,
        segment: mapSegment(row),
        segmentCount: segmentCounts.get(row.evidence_id) ?? 1,
      });
      usedChars += itemChars;
      if (usedChars >= budgetChars) {
        break;
      }
    }
    return selected;
  }

  /** 证据条目在整理请求中的序列化长度（内容按 JSON 转义后计算）。 */
  private serializedEvidenceItem(
    row: SegmentRow & {
      evidence_id: string;
      source_kind: MemorySourceKind;
      source_status: string;
      window_id: string | null;
      occurred_at: string;
      local_date: string;
    },
    content: string,
    segmentCount: number,
  ): number {
    return Array.from(
      JSON.stringify({
        evidenceId: row.evidence_id,
        sourceKind: row.source_kind,
        sourceStatus: row.source_status,
        windowId: row.window_id,
        occurredAt: row.occurred_at,
        localDate: row.local_date,
        content,
        segmentIndex: row.segment_index,
        segmentCount,
      }),
    ).length;
  }

  /**
   * 旧批次或大段证据可能按原始字符切分，序列化后（含转义）
   * 会超过当前容量。发送前把仍待处理的超长片段继续拆小，
   * 已处理片段保持不变，避免重试时重复推进或送出超限请求。
   */
  private splitOversizedSegments(
    roleId: string,
    batchId: string,
    budgetChars: number,
  ): void {
    this.db.transaction(() => {
      for (let guard = 0; guard < 200; guard += 1) {
        const rows = this.db
          .prepare(
            `SELECT s.evidence_id, s.segment_index, s.from_char, s.to_char, s.status, s.batch_id,
                    er.role_id, er.source_kind, er.source_id, er.window_id, er.task_id,
                    er.execution_id, er.source_status, er.occurred_at, er.local_date, er.role_sequence
             FROM memory_evidence_segments s
             JOIN evidence_records er ON er.evidence_id = s.evidence_id
             JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
             WHERE s.batch_id = ? AND er.role_id = ? AND ep.status = 'processing'
               AND s.status IN ('pending', 'failed')
             ORDER BY er.role_sequence ASC, s.segment_index ASC`,
          )
          .all(batchId, roleId) as Array<
          SegmentRow & {
            role_id: string;
            source_kind: MemorySourceKind;
            source_id: string;
            window_id: string | null;
            task_id: string | null;
            execution_id: string | null;
            source_status: string;
            occurred_at: string;
            local_date: string;
            role_sequence: number;
          }
        >;
        let target: (typeof rows)[number] | null = null;
        let targetContent = "";
        let targetCount = 1;
        for (const row of rows) {
          const content = this.loadEvidenceContent(row);
          const chars = Array.from(content);
          const count = (
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM memory_evidence_segments WHERE evidence_id = ?",
              )
              .get(row.evidence_id) as { count: number }
          ).count;
          const itemChars =
            this.serializedEvidenceItem(
              row,
              chars.slice(row.from_char, row.to_char).join(""),
              count,
            ) + 1;
          if (itemChars > budgetChars) {
            target = row;
            targetContent = content;
            targetCount = count;
            break;
          }
        }
        if (target === null) {
          return;
        }
        const segmentChars = Array.from(targetContent).slice(
          target.from_char,
          target.to_char,
        );
        const baseChars = this.serializedEvidenceItem(target, "", targetCount);
        const maxContentChars = budgetChars - baseChars - 1;
        if (maxContentChars < 1 || segmentChars.length <= 1) {
          throw new AppError(
            502,
            "MEMORY_CAPACITY_EXCEEDED",
            "证据片段元数据已超过模型可用容量",
            {
              evidenceId: target.evidence_id,
              segmentIndex: target.segment_index,
              budgetChars,
            },
          );
        }
        let escapedChars = 0;
        let cut = 0;
        for (const char of segmentChars) {
          const charChars = Array.from(JSON.stringify(char)).length - 2;
          if (cut > 0 && escapedChars + charChars > maxContentChars) {
            break;
          }
          escapedChars += charChars;
          cut += 1;
        }
        if (cut <= 0 || cut >= segmentChars.length) {
          throw new AppError(
            502,
            "MEMORY_CAPACITY_EXCEEDED",
            "证据片段无法拆分到模型可用容量",
            {
              evidenceId: target.evidence_id,
              segmentIndex: target.segment_index,
              budgetChars,
            },
          );
        }
        const splitAt = target.from_char + cut;
        const now = new Date().toISOString();
        const later = this.db
          .prepare(
            `SELECT segment_index FROM memory_evidence_segments
              WHERE evidence_id = ? AND segment_index > ?
              ORDER BY segment_index DESC`,
          )
          .all(target.evidence_id, target.segment_index) as Array<{
          segment_index: number;
        }>;
        for (const row of later) {
          this.db
            .prepare(
              "UPDATE memory_evidence_segments SET segment_index = ? WHERE evidence_id = ? AND segment_index = ?",
            )
            .run(row.segment_index + 1, target.evidence_id, row.segment_index);
        }
        this.db
          .prepare(
            `UPDATE memory_evidence_segments
                SET to_char = ?, status = 'pending', updated_at = ?
              WHERE evidence_id = ? AND segment_index = ?`,
          )
          .run(splitAt, now, target.evidence_id, target.segment_index);
        this.db
          .prepare(
            `INSERT INTO memory_evidence_segments
               (evidence_id, segment_index, from_char, to_char, status, batch_id, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            target.evidence_id,
            target.segment_index + 1,
            splitAt,
            target.to_char,
            batchId,
            now,
          );
      }
      throw new AppError(
        502,
        "MEMORY_CAPACITY_EXCEEDED",
        "证据片段拆分次数超过上限",
        { batchId, budgetChars },
      );
    })();
  }

  markSegmentProcessed(
    evidenceId: string,
    segmentIndex: number,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE memory_evidence_segments
         SET status = 'processed', updated_at = ?
         WHERE evidence_id = ? AND segment_index = ?`,
      )
      .run(now, evidenceId, segmentIndex);
  }

  remainingSegments(evidenceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_evidence_segments
         WHERE evidence_id = ? AND status != 'processed'`,
      )
      .get(evidenceId) as { count: number };
    return row.count;
  }

  markEvidenceProcessed(
    roleId: string,
    batchId: string,
    evidenceId: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE evidence_processing
         SET status = 'processed', next_retry_at = NULL, deferred_after_sequence = NULL,
             last_error_code = NULL, updated_at = ?
         WHERE evidence_id = ? AND last_batch_id = ?
           AND EXISTS (
             SELECT 1 FROM evidence_records er
             WHERE er.evidence_id = evidence_processing.evidence_id AND er.role_id = ?
           )`,
      )
      .run(now, evidenceId, batchId, roleId);
  }

  markEvidenceDeferred(input: {
    roleId: string;
    batchId: string;
    evidenceId: string;
    afterSequence: number;
    now: string;
  }): void {
    this.db
      .prepare(
        `UPDATE evidence_processing
         SET status = 'deferred', deferred_after_sequence = ?, last_error_code = NULL,
             next_retry_at = NULL, updated_at = ?
         WHERE evidence_id = ? AND last_batch_id = ?
           AND EXISTS (
             SELECT 1 FROM evidence_records er
             WHERE er.evidence_id = evidence_processing.evidence_id AND er.role_id = ?
           )`,
      )
      .run(
        input.afterSequence,
        input.now,
        input.evidenceId,
        input.batchId,
        input.roleId,
      );
  }

  finishBatch(input: {
    roleId: string;
    batchId: string;
    status: "completed" | "failed" | "partial";
    errorCode?: string | null;
    nextRetryAt?: string | null;
    now?: string;
  }): void {
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

  listEvents(roleId: string): MemoryEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, role_id, title, summary, subjective_experience,
                occurred_at_start, occurred_at_end, experience_date, lifecycle_status,
                refined_summary_id, version, last_supplemented_round, created_at, updated_at
         FROM memory_events WHERE role_id = ? ORDER BY created_at ASC, event_id ASC`,
      )
      .all(roleId) as EventRow[];
    return rows.map(mapEvent);
  }

  listRecentEvents(roleId: string, limit = 20): RelatedEventBrief[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, title, summary, experience_date, version
         FROM memory_events WHERE role_id = ? AND lifecycle_status = 'active'
         ORDER BY updated_at DESC, event_id ASC LIMIT ?`,
      )
      .all(roleId, limit) as Array<{
        event_id: string;
        title: string;
        summary: string;
        experience_date: string;
        version: number;
      }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      title: row.title,
      summary: row.summary,
      experienceDate: row.experience_date,
      version: row.version,
    }));
  }

  getEvent(roleId: string, eventId: string): MemoryEventRecord {
    const row = this.db
      .prepare(
        `SELECT event_id, role_id, title, summary, subjective_experience,
                occurred_at_start, occurred_at_end, experience_date, lifecycle_status,
                refined_summary_id, version, last_supplemented_round, created_at, updated_at
         FROM memory_events WHERE event_id = ? AND role_id = ?`,
      )
      .get(eventId, roleId) as EventRow | undefined;
    if (!row) {
      throw new MemoryEventNotFoundError(eventId);
    }
    return mapEvent(row);
  }

  createEvent(input: CreateEventInput): MemoryEventRecord {
    const eventId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_events
         (event_id, role_id, title, summary, subjective_experience,
          occurred_at_start, occurred_at_end, experience_date, lifecycle_status,
          refined_summary_id, version, last_supplemented_round, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.roleId,
        input.title,
        input.summary,
        input.subjectiveExperience,
        input.occurredAtStart,
        input.occurredAtEnd,
        input.experienceDate,
        input.currentRound,
        input.now,
        input.now,
      );
    this.insertTags(eventId, input.tags);
    for (const evidenceId of input.evidenceIds) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_event_sources (event_id, evidence_id, linked_at)
           VALUES (?, ?, ?)`,
        )
        .run(eventId, evidenceId, input.now);
    }
    this.insertRevision({
      roleId: input.roleId,
      targetType: "event",
      targetId: eventId,
      revisionNumber: 1,
      baseRevision: 0,
      changeSource: "memory_batch",
      content: {
        title: input.title,
        summary: input.summary,
        subjectiveExperience: input.subjectiveExperience,
        occurredAtStart: input.occurredAtStart,
        occurredAtEnd: input.occurredAtEnd,
        experienceDate: input.experienceDate,
        tags: input.tags,
      },
      evidenceIds: input.evidenceIds,
      now: input.now,
    });
    this.upsertSearchDocument({
      roleId: input.roleId,
      recordType: "event",
      recordId: eventId,
      title: input.title,
      body: [input.summary, input.subjectiveExperience].filter(Boolean).join("\n"),
      now: input.now,
    });
    return this.getEvent(input.roleId, eventId);
  }

  updateEvent(input: UpdateEventInput): MemoryEventRecord {
    const current = this.getEvent(input.roleId, input.eventId);
    if (current.version !== input.expectedVersion) {
      throw new MemoryVersionConflictError(
        input.eventId,
        input.expectedVersion,
        current.version,
      );
    }
    const patch = input.patch;
    const title = patch.title ?? current.title;
    const summary = patch.summary ?? current.summary;
    const subjectiveExperience =
      patch.subjectiveExperience ?? current.subjectiveExperience;
    const occurredAtStart = patch.occurredAtStart ?? current.occurredAtStart;
    const occurredAtEnd =
      patch.occurredAtEnd === undefined
        ? current.occurredAtEnd
        : patch.occurredAtEnd;
    if (occurredAtEnd !== null && occurredAtEnd < occurredAtStart) {
      throw new MemoryOperationInvalidError("事件结束时间早于开始时间", {
        eventId: input.eventId,
      });
    }
    const nextVersion = current.version + 1;
    const experienceDate = input.experienceDate ?? current.experienceDate;
    this.db
      .prepare(
        `UPDATE memory_events
         SET title = ?, summary = ?, subjective_experience = ?,
             occurred_at_start = ?, occurred_at_end = ?, experience_date = ?,
             version = ?, last_supplemented_round = ?, updated_at = ?
         WHERE event_id = ? AND role_id = ?`,
      )
      .run(
        title,
        summary,
        subjectiveExperience,
        occurredAtStart,
        occurredAtEnd,
        experienceDate,
        nextVersion,
        input.currentRound,
        input.now,
        input.eventId,
        input.roleId,
      );
    if (patch.tags) {
      this.replaceTagDimensions(input.eventId, patch.tags);
    }
    for (const evidenceId of input.addEvidenceIds) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_event_sources (event_id, evidence_id, linked_at)
           VALUES (?, ?, ?)`,
        )
        .run(input.eventId, evidenceId, input.now);
    }
    const tags = this.getTags(input.eventId);
    this.insertRevision({
      roleId: input.roleId,
      targetType: "event",
      targetId: input.eventId,
      revisionNumber: nextVersion,
      baseRevision: current.version,
      changeSource: input.changeSource ?? "memory_batch",
      content: {
        title,
        summary,
        subjectiveExperience,
        occurredAtStart,
        occurredAtEnd,
        experienceDate,
        tags,
      },
      evidenceIds: input.addEvidenceIds,
      now: input.now,
    });
    if (current.lifecycleStatus === "active") {
      this.upsertSearchDocument({
        roleId: input.roleId,
        recordType: "event",
        recordId: input.eventId,
        title,
        body: [summary, subjectiveExperience].filter(Boolean).join("\n"),
        now: input.now,
      });
    }
    return this.getEvent(input.roleId, input.eventId);
  }

  listEventSources(
    roleId: string,
    eventId: string,
  ): MemoryEventSourceRecord[] {
    this.getEvent(roleId, eventId);
    const rows = this.db
      .prepare(
        `SELECT er.*
         FROM memory_event_sources s
         JOIN evidence_records er ON er.evidence_id = s.evidence_id
         WHERE s.event_id = ? AND er.role_id = ?
         ORDER BY er.role_sequence ASC`,
      )
      .all(eventId, roleId) as EvidenceRow[];
    return rows.map(mapEventSource);
  }

  getEvidenceDetail(roleId: string, evidenceId: string): MemoryEvidenceDetail {
    const row = this.db
      .prepare(
        `SELECT er.*, ep.status AS processing_status, ep.attempt_count
         FROM evidence_records er
         JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
         WHERE er.evidence_id = ? AND er.role_id = ?`,
      )
      .get(evidenceId, roleId) as
      | (EvidenceRow & { attempt_count: number })
      | undefined;
    if (!row) {
      throw new MemoryOperationInvalidError("证据不存在", { evidenceId });
    }
    const detail: MemoryEvidenceDetail = {
      ...mapEvidence(row),
      processingStatus: row.processing_status,
      attemptCount: row.attempt_count,
      content: this.loadEvidenceContent(row),
    };
    if (row.source_kind === "tool_result") {
      const result = this.db
        .prepare(
          `SELECT raw_response_json, adapted_result_json, error_json
           FROM tool_results WHERE tool_call_id = ?`,
        )
        .get(row.source_id) as
        | {
            raw_response_json: string | null;
            adapted_result_json: string | null;
            error_json: string | null;
          }
        | undefined;
      if (result) {
        detail.rawResponse = parseOptionalJson(result.raw_response_json);
        detail.adaptedResult = parseOptionalJson(result.adapted_result_json);
        detail.error = parseOptionalJson(result.error_json);
      }
    }
    return detail;
  }

  getSummary(roleId: string, summaryId: string): DailySummaryRecord {
    const row = this.db
      .prepare(
        `SELECT summary_id, role_id, experience_date, topic, summary, version,
                created_at, updated_at
         FROM daily_summaries WHERE summary_id = ? AND role_id = ?`,
      )
      .get(summaryId, roleId) as SummaryRow | undefined;
    if (!row) {
      throw new MemorySummaryNotFoundError(summaryId);
    }
    return mapSummary(row);
  }

  listSummarySources(summaryId: string): DailySummarySourceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT summary_source_id, summary_id, window_id, from_sequence,
                to_sequence, occurred_from, occurred_to
         FROM daily_summary_sources WHERE summary_id = ?
         ORDER BY occurred_from ASC, summary_source_id ASC`,
      )
      .all(summaryId) as SummarySourceRow[];
    return rows.map((row) => ({
      summarySourceId: row.summary_source_id,
      summaryId: row.summary_id,
      windowId: row.window_id,
      fromSequence: row.from_sequence,
      toSequence: row.to_sequence,
      occurredFrom: row.occurred_from,
      occurredTo: row.occurred_to,
    }));
  }

  listSummaryEvidence(input: {
    roleId: string;
    summaryId: string;
    windowId?: string;
    fromSequence?: number;
    toSequence?: number;
    limit?: number;
  }): SummaryEvidenceItem[] {
    this.getSummary(input.roleId, input.summaryId);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const sources = this.listSummarySources(input.summaryId).filter(
      (source) =>
        input.windowId === undefined || source.windowId === input.windowId,
    );
    const items = new Map<string, SummaryEvidenceItem>();
    for (const source of sources) {
      if (source.windowId === null) {
        continue;
      }
      const fromSequence = input.fromSequence ?? source.fromSequence;
      const toSequence = input.toSequence ?? source.toSequence;
      if (fromSequence !== null && toSequence !== null) {
        const rows = this.db
          .prepare(
            `SELECT er.evidence_id, er.source_kind, er.window_id, er.occurred_at,
                    er.role_sequence, m.sequence, m.content
               FROM evidence_records er
               JOIN messages m
                 ON er.source_kind = 'message' AND m.message_id = er.source_id
              WHERE er.role_id = ? AND m.window_id = ?
                AND m.sequence >= ? AND m.sequence <= ?
              ORDER BY er.role_sequence ASC`,
          )
          .all(
            input.roleId,
            source.windowId,
            Math.min(fromSequence, toSequence),
            Math.max(fromSequence, toSequence),
          ) as Array<{
          evidence_id: string;
          source_kind: MemorySourceKind;
          window_id: string | null;
          occurred_at: string;
          role_sequence: number;
          sequence: number;
          content: string;
        }>;
        for (const row of rows) {
          items.set(row.evidence_id, {
            evidenceId: row.evidence_id,
            sourceKind: row.source_kind,
            windowId: row.window_id,
            sequence: row.sequence,
            occurredAt: row.occurred_at,
            roleSequence: row.role_sequence,
            content: row.content,
          });
        }
      }
      const toolRows = this.db
        .prepare(
          `SELECT evidence_id, source_kind, source_id, window_id, occurred_at,
                  role_sequence
             FROM evidence_records
            WHERE role_id = ? AND source_kind = 'tool_result'
              AND window_id = ? AND occurred_at >= ? AND occurred_at <= ?
            ORDER BY role_sequence ASC`,
        )
        .all(
          input.roleId,
          source.windowId,
          source.occurredFrom,
          source.occurredTo,
        ) as Array<{
        evidence_id: string;
        source_kind: MemorySourceKind;
        source_id: string;
        window_id: string | null;
        occurred_at: string;
        role_sequence: number;
      }>;
      for (const row of toolRows) {
        if (items.has(row.evidence_id)) {
          continue;
        }
        items.set(row.evidence_id, {
          evidenceId: row.evidence_id,
          sourceKind: row.source_kind,
          windowId: row.window_id,
          sequence: null,
          occurredAt: row.occurred_at,
          roleSequence: row.role_sequence,
          content: this.loadEvidenceContent({
            source_kind: row.source_kind,
            source_id: row.source_id,
          }),
        });
      }
    }
    return [...items.values()]
      .sort((left, right) => left.roleSequence - right.roleSequence)
      .slice(0, limit);
  }

  listRefineCandidates(
    roleId: string,
    currentRound: number,
    window = 100,
  ): RefineCandidateBrief[] {
    const rows = this.db
      .prepare(
        `SELECT e.event_id, e.title, e.summary, e.experience_date, e.version,
                e.last_supplemented_round
         FROM memory_events e
         WHERE e.role_id = ? AND e.lifecycle_status = 'active'
           AND ? - e.last_supplemented_round >= ?
           AND (
             SELECT COUNT(*)
             FROM memory_recalls mr
             JOIN executions x ON x.execution_id = mr.execution_id
             WHERE mr.role_id = e.role_id
               AND mr.record_type = 'event'
               AND mr.record_id = e.event_id
               AND x.decision_round IS NOT NULL
               AND x.decision_round > ? - ?
               AND x.decision_round <= ?
           ) <= 1
         ORDER BY e.experience_date ASC, e.event_id ASC
         LIMIT 50`,
      )
      .all(
        roleId,
        currentRound,
        window,
        currentRound,
        window,
        currentRound,
      ) as Array<{
      event_id: string;
      title: string;
      summary: string;
      experience_date: string;
      version: number;
      last_supplemented_round: number;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      title: row.title,
      summary: row.summary,
      experienceDate: row.experience_date,
      version: row.version,
      lastSupplementedRound: row.last_supplemented_round,
    }));
  }

  listSummaryCandidates(
    roleId: string,
    experienceDates: readonly string[],
  ): DailySummaryBrief[] {
    const dates = [...new Set(experienceDates)];
    if (dates.length === 0) {
      return [];
    }
    const placeholders = dates.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT summary_id, experience_date, topic, summary, version
         FROM daily_summaries
         WHERE role_id = ? AND experience_date IN (${placeholders})
         ORDER BY experience_date ASC, created_at ASC, summary_id ASC
         LIMIT 100`,
      )
      .all(roleId, ...dates) as Array<{
      summary_id: string;
      experience_date: string;
      topic: string;
      summary: string;
      version: number;
    }>;
    return rows.map((row) => ({
      summaryId: row.summary_id,
      experienceDate: row.experience_date,
      topic: row.topic,
      summary: row.summary,
      version: row.version,
    }));
  }

  refineEvent(input: {
    roleId: string;
    events: ReadonlyArray<{ eventId: string; expectedVersion: number }>;
    summary: string;
    targetSummaryId?: string;
    expectedSummaryVersion?: number;
    topic?: string;
    reason?: string;
    now: string;
  }): { events: MemoryEventRecord[]; summary: DailySummaryRecord } {
    return this.db.transaction(() => {
      const seen = new Set<string>();
      const events: MemoryEventRecord[] = [];
      for (const target of input.events) {
        if (seen.has(target.eventId)) {
          throw new MemoryOperationInvalidError("精炼目标事件重复", {
            eventId: target.eventId,
          });
        }
        seen.add(target.eventId);
        const event = this.getEvent(input.roleId, target.eventId);
        if (event.version !== target.expectedVersion) {
          throw new MemoryVersionConflictError(
            target.eventId,
            target.expectedVersion,
            event.version,
          );
        }
        if (event.lifecycleStatus !== "active") {
          throw new MemoryOperationInvalidError("事件已精炼，不能重复精炼", {
            eventId: target.eventId,
          });
        }
        events.push(event);
      }
      const firstEvent = events[0];
      if (!firstEvent) {
        throw new MemoryOperationInvalidError("精炼至少需要一个事件");
      }
      if (events.some((event) => event.experienceDate !== firstEvent.experienceDate)) {
        throw new MemoryOperationInvalidError(
          "只能聚合同一经历日期的事件",
          {
            experienceDates: [
              ...new Set(events.map((event) => event.experienceDate)),
            ],
          },
        );
      }
      const experienceDate = firstEvent.experienceDate;
      const summaryText = input.summary.trim();
      if (summaryText.length === 0) {
        throw new MemoryOperationInvalidError("摘要正文不能为空");
      }
      const eventSources = new Map<string, MemoryEventSourceRecord[]>();
      for (const event of events) {
        const sources = this.listEventSources(input.roleId, event.eventId);
        if (sources.length === 0) {
          throw new MemoryOperationInvalidError("事件没有来源证据，不能精炼", {
            eventId: event.eventId,
          });
        }
        eventSources.set(event.eventId, sources);
      }
      const sources = [...eventSources.values()].flat();
      const eventTopics = events.map(
        (event) => this.getTags(event.eventId).topic?.[0]?.trim() ?? "",
      );
      const providedTopic = input.topic?.trim() ?? "";
      const distinctTopics = [
        ...new Set(eventTopics.filter((topic) => topic.length > 0)),
      ];
      if (
        providedTopic.length === 0 &&
        distinctTopics.length > 1
      ) {
        throw new MemoryOperationInvalidError(
          "聚合事件的主题不一致，需要提供摘要主题",
          { topics: distinctTopics },
        );
      }
      let summaryId: string;
      let summaryVersion: number;
      let baseVersion: number;
      let topic: string;
      let summaryTitle: string;
      if (input.targetSummaryId !== undefined) {
        if (input.expectedSummaryVersion === undefined) {
          throw new MemoryOperationInvalidError(
            "补充已有摘要必须提供摘要版本",
            { summaryId: input.targetSummaryId },
          );
        }
        const target = this.getSummary(input.roleId, input.targetSummaryId);
        if (target.experienceDate !== experienceDate) {
          throw new MemoryOperationInvalidError(
            "摘要日期与事件经历日期不一致",
            {
              summaryId: target.summaryId,
              summaryExperienceDate: target.experienceDate,
              experienceDate,
            },
          );
        }
        if (target.version !== input.expectedSummaryVersion) {
          throw new MemoryVersionConflictError(
            target.summaryId,
            input.expectedSummaryVersion,
            target.version,
          );
        }
        if (
          target.topic.length > 0 &&
          providedTopic.length > 0 &&
          target.topic !== providedTopic
        ) {
          throw new MemoryOperationInvalidError(
            "摘要主题与已有摘要不一致",
            {
              summaryId: target.summaryId,
              summaryTopic: target.topic,
              topic: providedTopic,
            },
          );
        }
        summaryId = target.summaryId;
        baseVersion = target.version;
        summaryVersion = target.version + 1;
        topic =
          providedTopic.length > 0
            ? providedTopic
            : target.topic.length > 0
              ? target.topic
              : (distinctTopics[0] ?? "");
        summaryTitle =
          this.getSearchDocument(input.roleId, "daily_summary", summaryId)
            ?.title ?? firstEvent.title;
        this.db
          .prepare(
            `UPDATE daily_summaries
             SET topic = ?, summary = ?, version = ?, updated_at = ?
             WHERE summary_id = ? AND role_id = ?`,
          )
          .run(
            topic,
            summaryText,
            summaryVersion,
            input.now,
            summaryId,
            input.roleId,
          );
      } else {
        summaryId = randomUUID();
        baseVersion = 0;
        summaryVersion = 1;
        topic = providedTopic.length > 0 ? providedTopic : (distinctTopics[0] ?? "");
        summaryTitle = firstEvent.title;
        this.db
          .prepare(
            `INSERT INTO daily_summaries
             (summary_id, role_id, experience_date, topic, summary, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            summaryId,
            input.roleId,
            experienceDate,
            topic,
            summaryText,
            input.now,
            input.now,
          );
      }
      for (const source of groupSummarySources(this.db, sources)) {
        const duplicate = this.db
          .prepare(
            `SELECT 1 FROM daily_summary_sources
             WHERE summary_id = ? AND window_id IS ? AND from_sequence IS ?
               AND to_sequence IS ? AND occurred_from = ? AND occurred_to = ?`,
          )
          .get(
            summaryId,
            source.windowId,
            source.fromSequence,
            source.toSequence,
            source.occurredFrom,
            source.occurredTo,
          );
        if (duplicate) {
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO daily_summary_sources
             (summary_source_id, summary_id, window_id, from_sequence, to_sequence,
              occurred_from, occurred_to)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            summaryId,
            source.windowId,
            source.fromSequence,
            source.toSequence,
            source.occurredFrom,
            source.occurredTo,
          );
      }
      const refinedEventIds = events.map((event) => event.eventId);
      for (const event of events) {
        const nextVersion = event.version + 1;
        this.db
          .prepare(
            `UPDATE memory_events
             SET lifecycle_status = 'refined', refined_summary_id = ?, version = ?,
                 updated_at = ?
             WHERE event_id = ? AND role_id = ?`,
          )
          .run(summaryId, nextVersion, input.now, event.eventId, input.roleId);
        this.db
          .prepare(
            `DELETE FROM memory_search_documents
             WHERE role_id = ? AND record_type = 'event' AND record_id = ?`,
          )
          .run(input.roleId, event.eventId);
        this.insertRevision({
          roleId: input.roleId,
          targetType: "event",
          targetId: event.eventId,
          revisionNumber: nextVersion,
          baseRevision: event.version,
          changeSource: "memory_batch",
          content: {
            lifecycleStatus: "refined",
            refinedSummaryId: summaryId,
            title: event.title,
            summary: event.summary,
            experienceDate: event.experienceDate,
            mergedEventIds: refinedEventIds,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
          evidenceIds: (eventSources.get(event.eventId) ?? []).map(
            (source) => source.evidenceId,
          ),
          now: input.now,
        });
      }
      this.upsertSearchDocument({
        roleId: input.roleId,
        recordType: "daily_summary",
        recordId: summaryId,
        title: summaryTitle,
        body: summaryText,
        now: input.now,
      });
      this.insertRevision({
        roleId: input.roleId,
        targetType: "daily_summary",
        targetId: summaryId,
        revisionNumber: summaryVersion,
        baseRevision: baseVersion,
        changeSource: "memory_batch",
        content: {
          experienceDate,
          topic,
          summary: summaryText,
          eventIds: refinedEventIds,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        evidenceIds: sources.map((source) => source.evidenceId),
        now: input.now,
      });
      return {
        events: events.map((event) =>
          this.getEvent(input.roleId, event.eventId),
        ),
        summary: this.getSummary(input.roleId, summaryId),
      };
    })();
  }

  correctSummary(input: {
    roleId: string;
    summaryId: string;
    expectedVersion: number;
    summary: string;
    now: string;
  }): DailySummaryRecord {
    const current = this.getSummary(input.roleId, input.summaryId);
    if (current.version !== input.expectedVersion) {
      throw new MemoryVersionConflictError(
        input.summaryId,
        input.expectedVersion,
        current.version,
      );
    }
    const nextVersion = current.version + 1;
    this.db
      .prepare(
        `UPDATE daily_summaries
         SET summary = ?, version = ?, updated_at = ?
         WHERE summary_id = ? AND role_id = ?`,
      )
      .run(input.summary, nextVersion, input.now, input.summaryId, input.roleId);
    const existingDocument = this.getSearchDocument(
      input.roleId,
      "daily_summary",
      input.summaryId,
    );
    this.upsertSearchDocument({
      roleId: input.roleId,
      recordType: "daily_summary",
      recordId: input.summaryId,
      title: existingDocument?.title ?? current.experienceDate,
      body: input.summary,
      now: input.now,
    });
    this.insertRevision({
      roleId: input.roleId,
      targetType: "daily_summary",
      targetId: input.summaryId,
      revisionNumber: nextVersion,
      baseRevision: current.version,
      changeSource: "agent_correction",
      content: {
        experienceDate: current.experienceDate,
        topic: current.topic,
        summary: input.summary,
      },
      evidenceIds: [],
      now: input.now,
    });
    return this.getSummary(input.roleId, input.summaryId);
  }

  getMemoryStatus(roleId: string): MemoryStatus {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN ep.status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN ep.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN ep.status = 'deferred' THEN 1 ELSE 0 END) AS deferred
         FROM evidence_records er
         JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
         WHERE er.role_id = ?`,
      )
      .get(roleId) as {
      pending: number | null;
      failed: number | null;
      deferred: number | null;
    };
    const running = this.db
      .prepare(
        "SELECT batch_id FROM memory_batches WHERE role_id = ? AND status = 'running' LIMIT 1",
      )
      .get(roleId) as { batch_id: string } | undefined;
    const last = this.db
      .prepare(
        `SELECT batch_id, role_id, status, input_from_sequence, input_to_sequence,
                context_budget_chars, output_reserve_chars, attempt_count,
                last_error_code, started_at, finished_at, created_at
         FROM memory_batches WHERE role_id = ?
         ORDER BY created_at DESC, batch_id DESC LIMIT 1`,
      )
      .get(roleId) as BatchRow | undefined;
    const triggers = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM memory_triggers WHERE role_id = ? AND consumed_at IS NULL",
      )
      .get(roleId) as { count: number };
    return {
      runningBatchId: running?.batch_id ?? null,
      pendingEvidence: counts.pending ?? 0,
      failedEvidence: counts.failed ?? 0,
      deferredEvidence: counts.deferred ?? 0,
      pendingTriggers: triggers.count,
      lastBatch: last ? mapBatch(last) : null,
    };
  }

  listBatches(roleId: string, limit: number): MemoryBatchRecord[] {
    const rows = this.db
      .prepare(
        `SELECT batch_id, role_id, status, input_from_sequence, input_to_sequence,
                context_budget_chars, output_reserve_chars, attempt_count,
                last_error_code, started_at, finished_at, created_at
         FROM memory_batches WHERE role_id = ?
         ORDER BY created_at DESC, batch_id DESC LIMIT ?`,
      )
      .all(roleId, limit) as BatchRow[];
    return rows.map(mapBatch);
  }

  saveRetrieval(input: {
    retrievalId: string;
    roleId: string;
    executionId: string | null;
    mode: "auto" | "agent" | "manual";
    queryJson: string;
    status: "succeeded" | "failed";
    errorCode: string | null;
    now: string;
    items: ReadonlyArray<{
      type: MemoryRecordType;
      id: string;
      rank: number;
      delivered: boolean;
    }>;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO retrieval_queries
           (retrieval_id, role_id, execution_id, mode, query_json, status,
            error_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.retrievalId,
          input.roleId,
          input.executionId,
          input.mode,
          input.queryJson,
          input.status,
          input.errorCode,
          input.now,
        );
      const insert = this.db.prepare(
        `INSERT INTO retrieval_results
         (retrieval_id, rank, record_type, record_id, delivered)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const item of input.items) {
        insert.run(
          input.retrievalId,
          item.rank,
          item.type,
          item.id,
          item.delivered ? 1 : 0,
        );
      }
    })();
  }

  recordRecall(input: {
    roleId: string;
    executionId: string;
    recordType: MemoryRecordType;
    recordId: string;
    now: string;
  }): boolean {
    const execution = this.db
      .prepare(
        "SELECT decision_round FROM executions WHERE execution_id = ? AND role_id = ?",
      )
      .get(input.executionId, input.roleId) as
      | { decision_round: number | null }
      | undefined;
    if (!execution) {
      throw new MemoryOperationInvalidError("召回执行不存在或不属于该角色", {
        executionId: input.executionId,
      });
    }
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_recalls
         (recall_id, role_id, execution_id, record_type, record_id, recalled_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.roleId,
        input.executionId,
        input.recordType,
        input.recordId,
        input.now,
      );
    return result.changes > 0;
  }

  createDiary(input: {
    diaryId: string;
    roleId: string;
    relativePath: string;
    content: string;
    contentHash: string;
    occurredAt: string;
    experienceDate: string;
    eventIds: readonly string[];
    now: string;
  }): DiaryRecord {
    for (const eventId of input.eventIds) {
      this.getEvent(input.roleId, eventId);
    }
    this.db
      .prepare(
        `INSERT INTO diaries
         (diary_id, role_id, relative_path, content, content_hash, occurred_at,
          experience_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.diaryId,
        input.roleId,
        input.relativePath,
        input.content,
        input.contentHash,
        input.occurredAt,
        input.experienceDate,
        input.now,
        input.now,
      );
    for (const eventId of input.eventIds) {
      this.db
        .prepare(
          `INSERT INTO diary_events (diary_id, event_id, linked_at)
           VALUES (?, ?, ?)`,
        )
        .run(input.diaryId, eventId, input.now);
    }
    this.upsertSearchDocument({
      roleId: input.roleId,
      recordType: "diary",
      recordId: input.diaryId,
      title: diaryTitle(input.content, input.experienceDate),
      body: input.content,
      now: input.now,
    });
    return this.getDiaryRow(input.roleId, input.diaryId);
  }

  listDiaries(roleId: string): DiaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT diary_id, role_id, relative_path, content, content_hash,
                occurred_at, experience_date, created_at, updated_at
         FROM diaries WHERE role_id = ?
         ORDER BY experience_date DESC, occurred_at DESC, diary_id ASC`,
      )
      .all(roleId) as DiaryRow[];
    return rows.map(mapDiary);
  }

  getDiary(roleId: string, diaryId: string): DiaryDetail {
    const row = this.db
      .prepare(
        `SELECT diary_id, role_id, relative_path, content, content_hash,
                occurred_at, experience_date, created_at, updated_at
         FROM diaries WHERE diary_id = ? AND role_id = ?`,
      )
      .get(diaryId, roleId) as DiaryRow | undefined;
    if (!row) {
      throw new DiaryNotFoundError(diaryId);
    }
    const links = this.db
      .prepare(
        "SELECT event_id FROM diary_events WHERE diary_id = ? ORDER BY linked_at ASC, event_id ASC",
      )
      .all(diaryId) as Array<{ event_id: string }>;
    return {
      ...mapDiary(row),
      content: row.content,
      eventIds: links.map((link) => link.event_id),
    };
  }

  updateDiarySnapshot(input: {
    roleId: string;
    diaryId: string;
    content: string;
    contentHash: string;
    now: string;
  }): DiaryRecord {
    const current = this.getDiaryRow(input.roleId, input.diaryId);
    this.db
      .prepare(
        `UPDATE diaries SET content = ?, content_hash = ?, updated_at = ?
         WHERE diary_id = ? AND role_id = ?`,
      )
      .run(
        input.content,
        input.contentHash,
        input.now,
        input.diaryId,
        input.roleId,
      );
    this.upsertSearchDocument({
      roleId: input.roleId,
      recordType: "diary",
      recordId: input.diaryId,
      title: diaryTitle(input.content, current.experienceDate),
      body: input.content,
      now: input.now,
    });
    return this.getDiaryRow(input.roleId, input.diaryId);
  }

  private getDiaryRow(roleId: string, diaryId: string): DiaryRecord {
    const row = this.db
      .prepare(
        `SELECT diary_id, role_id, relative_path, content, content_hash,
                occurred_at, experience_date, created_at, updated_at
         FROM diaries WHERE diary_id = ? AND role_id = ?`,
      )
      .get(diaryId, roleId) as DiaryRow | undefined;
    if (!row) {
      throw new DiaryNotFoundError(diaryId);
    }
    return mapDiary(row);
  }

  getTags(eventId: string): MemoryTagValues {
    const rows = this.db
      .prepare(
        "SELECT dimension, value FROM memory_event_tags WHERE event_id = ? ORDER BY dimension ASC, normalized_value ASC",
      )
      .all(eventId) as Array<{ dimension: keyof MemoryTagValues; value: string }>;
    const tags: MemoryTagValues = {};
    for (const row of rows) {
      const list = tags[row.dimension] ?? [];
      list.push(row.value);
      tags[row.dimension] = list;
    }
    return tags;
  }

  getSearchDocument(
    roleId: string,
    recordType: string,
    recordId: string,
  ): { title: string; body: string } | null {
    const row = this.db
      .prepare(
        "SELECT title, body FROM memory_search_documents WHERE role_id = ? AND record_type = ? AND record_id = ?",
      )
      .get(roleId, recordType, recordId) as
      | { title: string; body: string }
      | undefined;
    return row ?? null;
  }

  listEvidence(roleId: string): Array<
    MemoryEvidenceRecord & { processingStatus: string; attemptCount: number }
  > {
    const rows = this.db
      .prepare(
        `SELECT er.*, ep.status AS processing_status, ep.attempt_count
         FROM evidence_records er
         JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
         WHERE er.role_id = ? ORDER BY er.role_sequence ASC`,
      )
      .all(roleId) as Array<EvidenceRow & { attempt_count: number }>;
    return rows.map((row) => ({
      ...mapEvidence(row),
      processingStatus: row.processing_status,
      attemptCount: row.attempt_count,
    }));
  }

  evidenceContent(evidenceId: string): string {
    const row = this.db
      .prepare("SELECT * FROM evidence_records WHERE evidence_id = ?")
      .get(evidenceId) as EvidenceRow | undefined;
    if (!row) {
      throw new MemoryOperationInvalidError("证据不存在", { evidenceId });
    }
    return this.loadEvidenceContent(row);
  }

  private ensureSegments(
    evidenceId: string,
    content: string,
    budgetChars: number,
    batchId: string,
    now: string,
  ): MemorySegmentRecord[] {
    const existing = this.db
      .prepare(
        `SELECT evidence_id, segment_index, from_char, to_char, status, batch_id
         FROM memory_evidence_segments WHERE evidence_id = ? ORDER BY segment_index ASC`,
      )
      .all(evidenceId) as SegmentRow[];
    if (existing.length === 0) {
      const chars = Array.from(content);
      const size = Math.max(1, budgetChars);
      if (chars.length === 0) {
        this.db
          .prepare(
            `INSERT INTO memory_evidence_segments
             (evidence_id, segment_index, from_char, to_char, status, batch_id, updated_at)
             VALUES (?, 0, 0, 0, 'pending', ?, ?)`,
          )
          .run(evidenceId, batchId, now);
      } else {
        let index = 0;
        for (let start = 0; start < chars.length; start += size) {
          const end = Math.min(chars.length, start + size);
          this.db
            .prepare(
              `INSERT INTO memory_evidence_segments
               (evidence_id, segment_index, from_char, to_char, status, batch_id, updated_at)
               VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(evidenceId, index, start, end, batchId, now);
          index += 1;
        }
      }
    } else {
      this.db
        .prepare(
          `UPDATE memory_evidence_segments
           SET batch_id = ?, status = CASE WHEN status = 'processed' THEN 'processed' ELSE 'pending' END,
               updated_at = ?
           WHERE evidence_id = ?`,
        )
        .run(batchId, now, evidenceId);
    }
    const rows = this.db
      .prepare(
        `SELECT evidence_id, segment_index, from_char, to_char, status, batch_id
         FROM memory_evidence_segments WHERE evidence_id = ? ORDER BY segment_index ASC`,
      )
      .all(evidenceId) as SegmentRow[];
    return rows.map(mapSegment);
  }

  private loadEvidenceContent(row: {
    source_kind: MemorySourceKind;
    source_id: string;
  }): string {
    if (row.source_kind === "message") {
      const message = this.db
        .prepare("SELECT content FROM messages WHERE message_id = ?")
        .get(row.source_id) as { content: string } | undefined;
      return message?.content ?? "";
    }
    const result = this.db
      .prepare(
        `SELECT raw_response_json, adapted_result_json, error_json
         FROM tool_results WHERE tool_call_id = ?`,
      )
      .get(row.source_id) as
      | {
          raw_response_json: string | null;
          adapted_result_json: string | null;
          error_json: string | null;
        }
      | undefined;
    return (
      result?.raw_response_json ??
      result?.adapted_result_json ??
      result?.error_json ??
      ""
    );
  }

  private insertTags(eventId: string, tags: MemoryTagValues): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO memory_event_tags
       (event_id, dimension, value, normalized_value) VALUES (?, ?, ?, ?)`,
    );
    const dimensions: Array<keyof MemoryTagValues> = [
      "person",
      "topic",
      "place",
      "emotion",
      "source",
    ];
    for (const dimension of dimensions) {
      for (const value of tags[dimension] ?? []) {
        const normalized = value.trim().toLowerCase();
        if (!normalized) {
          continue;
        }
        insert.run(eventId, dimension, value.trim(), normalized);
      }
    }
  }

  private replaceTagDimensions(eventId: string, tags: MemoryTagValues): void {
    const dimensions: Array<keyof MemoryTagValues> = [
      "person",
      "topic",
      "place",
      "emotion",
      "source",
    ];
    for (const dimension of dimensions) {
      if (tags[dimension] === undefined) {
        continue;
      }
      this.db
        .prepare(
          "DELETE FROM memory_event_tags WHERE event_id = ? AND dimension = ?",
        )
        .run(eventId, dimension);
    }
    this.insertTags(eventId, tags);
  }

  private insertRevision(input: {
    roleId: string;
    targetType: "event" | "daily_summary";
    targetId: string;
    revisionNumber: number;
    baseRevision: number;
    changeSource: "memory_batch" | "agent_correction";
    content: unknown;
    evidenceIds: readonly string[];
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_revisions
         (revision_id, role_id, target_type, target_id, revision_number, base_revision,
          change_source, content_json, evidence_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.roleId,
        input.targetType,
        input.targetId,
        input.revisionNumber,
        input.baseRevision,
        input.changeSource,
        JSON.stringify(input.content),
        JSON.stringify(input.evidenceIds),
        input.now,
      );
  }

  private upsertSearchDocument(input: {
    roleId: string;
    recordType: "event" | "daily_summary" | "diary";
    recordId: string;
    title: string;
    body: string;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_search_documents
         (role_id, record_type, record_id, title, body, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (role_id, record_type, record_id)
         DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(
        input.roleId,
        input.recordType,
        input.recordId,
        input.title,
        input.body,
        input.now,
      );
  }
}

function mapEventSource(row: EvidenceRow): MemoryEventSourceRecord {
  return {
    evidenceId: row.evidence_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    windowId: row.window_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    sourceStatus: row.source_status,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    roleSequence: row.role_sequence,
  };
}

function mapSummary(row: SummaryRow): DailySummaryRecord {
  return {
    summaryId: row.summary_id,
    roleId: row.role_id,
    experienceDate: row.experience_date,
    topic: row.topic,
    summary: row.summary,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDiary(row: DiaryRow): DiaryRecord {
  return {
    diaryId: row.diary_id,
    roleId: row.role_id,
    relativePath: row.relative_path,
    occurredAt: row.occurred_at,
    experienceDate: row.experience_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function diaryTitle(content: string, experienceDate: string): string {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return (line ?? experienceDate).slice(0, 120);
}

function parseOptionalJson(value: string | null): unknown {
  if (value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function groupSummarySources(
  db: Database.Database,
  sources: readonly MemoryEventSourceRecord[],
): Array<{
  windowId: string | null;
  fromSequence: number | null;
  toSequence: number | null;
  occurredFrom: string;
  occurredTo: string;
}> {
  const groups = new Map<
    string,
    {
      windowId: string | null;
      fromSequence: number | null;
      toSequence: number | null;
      occurredFrom: string;
      occurredTo: string;
    }
  >();
  for (const source of sources) {
    const key = source.windowId ?? "";
    let sequence: number | null = null;
    if (source.sourceKind === "message") {
      const row = db
        .prepare("SELECT sequence FROM messages WHERE message_id = ?")
        .get(source.sourceId) as { sequence: number } | undefined;
      sequence = row?.sequence ?? null;
    }
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        windowId: source.windowId,
        fromSequence: sequence,
        toSequence: sequence,
        occurredFrom: source.occurredAt,
        occurredTo: source.occurredAt,
      });
      continue;
    }
    if (
      sequence !== null &&
      (existing.fromSequence === null || sequence < existing.fromSequence)
    ) {
      existing.fromSequence = sequence;
    }
    if (
      sequence !== null &&
      (existing.toSequence === null || sequence > existing.toSequence)
    ) {
      existing.toSequence = sequence;
    }
    if (source.occurredAt < existing.occurredFrom) {
      existing.occurredFrom = source.occurredAt;
    }
    if (source.occurredAt > existing.occurredTo) {
      existing.occurredTo = source.occurredAt;
    }
  }
  return [...groups.values()];
}

function mapBatch(row: BatchRow): MemoryBatchRecord {
  return {
    batchId: row.batch_id,
    roleId: row.role_id,
    status: row.status,
    inputFromSequence: row.input_from_sequence,
    inputToSequence: row.input_to_sequence,
    contextBudgetChars: row.context_budget_chars,
    outputReserveChars: row.output_reserve_chars,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function mapSegment(row: SegmentRow): MemorySegmentRecord {
  return {
    evidenceId: row.evidence_id,
    segmentIndex: row.segment_index,
    fromChar: row.from_char,
    toChar: row.to_char,
    status: row.status,
    batchId: row.batch_id,
  };
}

function mapEvidence(row: EvidenceRow): MemoryEvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    roleId: row.role_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    windowId: row.window_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    sourceStatus: row.source_status,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    roleSequence: row.role_sequence,
  };
}

function mapEvent(row: EventRow): MemoryEventRecord {
  return {
    eventId: row.event_id,
    roleId: row.role_id,
    title: row.title,
    summary: row.summary,
    subjectiveExperience: row.subjective_experience,
    occurredAtStart: row.occurred_at_start,
    occurredAtEnd: row.occurred_at_end,
    experienceDate: row.experience_date,
    lifecycleStatus: row.lifecycle_status,
    refinedSummaryId: row.refined_summary_id,
    version: row.version,
    lastSupplementedRound: row.last_supplemented_round,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
