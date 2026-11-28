import type Database from "better-sqlite3";
import { AppError, MemoryOperationInvalidError } from "../../domain/errors.js";
import type {
  EvidenceSender,
  MemoryBatchRecord,
  MemoryEvidenceDetail,
  MemorySegmentRecord,
  MemorySourceKind,
} from "../../domain/memory.js";
import { readWebEvidenceProjection } from "../conversation/web-reading.js";
import {
  loadEvidenceContent,
  mapBatch,
  mapEvidence,
  mapSegment,
  parseOptionalJson,
  readEvidenceMessageContext,
} from "./memory-store-types.js";
import type {
  BatchRow,
  EvidenceRow,
  EvidenceWithProcessing,
  MarkEvidenceDeferredInput,
  MemoryStatus,
  NextSegment,
  PendingMessageStat,
  SegmentRow,
} from "./memory-store-types.js";

export class MemoryEvidenceStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
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
        loadEvidenceContent(this.db, row),
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
        publishedReply: false,
        sender: "assistant", // 为最长的发送者名称预留容量。
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
          const content = loadEvidenceContent(this.db, row);
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

  markEvidenceDeferred(input: MarkEvidenceDeferredInput): void {
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

  pendingMessageStats(roleId: string): PendingMessageStat[] {
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
      sender: readEvidenceMessageContext(this.db, row.source_kind, row.source_id).sender,
      processingStatus: row.processing_status,
      attemptCount: row.attempt_count,
      content: loadEvidenceContent(this.db, row),
    };
    if (row.source_kind === "tool_result") {
      const web = readWebEvidenceProjection(this.db, roleId, row.source_id);
      if (web !== undefined) {
        detail.adaptedResult = parseOptionalJson(web);
        return detail;
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
      if (result) {
        detail.rawResponse = parseOptionalJson(result.raw_response_json);
        detail.adaptedResult = parseOptionalJson(result.adapted_result_json);
        detail.error = parseOptionalJson(result.error_json);
      }
    }
    return detail;
  }

  listEvidence(roleId: string): EvidenceWithProcessing[] {
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
    return loadEvidenceContent(this.db, row);
  }

  ensureSegments(
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

  evidenceMessageContext(
    kind: MemorySourceKind,
    sourceId: string,
  ): { sender: EvidenceSender; publishedReply?: boolean } {
    return readEvidenceMessageContext(this.db, kind, sourceId);
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

  listBatches(roleId: string, limit: number, offset = 0): MemoryBatchRecord[] {
    const rows = this.db
      .prepare(
        `SELECT batch_id, role_id, status, input_from_sequence, input_to_sequence,
                context_budget_chars, output_reserve_chars, attempt_count,
                last_error_code, started_at, finished_at, created_at
         FROM memory_batches WHERE role_id = ?
         ORDER BY created_at DESC, batch_id DESC LIMIT ? OFFSET ?`,
      )
      .all(roleId, limit, offset) as BatchRow[];
    return rows.map(mapBatch);
  }
}
