import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { MemoryOperationInvalidError } from "../../domain/errors.js";
import type { MemoryDelivery } from "../../domain/model.js";
import {
  claimSearchText,
  readEvent,
  readEventClaims,
  searchableClaims,
  searchableClaimText,
} from "./memory-store-types.js";
import type {
  RecordRecallInput,
  SaveRetrievalInput,
  SearchDocument,
  UpsertSearchDocumentInput,
} from "./memory-store-types.js";

/** 写入检索文档；事件、摘要与日记维护共用同一份 upsert。 */
export function upsertSearchDocument(
  db: Database.Database,
  input: UpsertSearchDocumentInput,
): void {
  db
    .prepare(
      `INSERT INTO memory_search_documents
       (role_id, record_type, record_id, title, body, related_text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (role_id, record_type, record_id)
       DO UPDATE SET title = excluded.title, body = excluded.body,
         related_text=excluded.related_text, updated_at = excluded.updated_at`,
    )
    .run(
      input.roleId,
      input.recordType,
      input.recordId,
      input.title,
      input.body,
      input.relatedText ?? "",
      input.now,
    );
}

/** 精炼后只有长期线索参与普通检索，事件档案、历次理解和原始证据继续供深查。 */
export function indexRetainedDetails(
  db: Database.Database,
  roleId: string,
  eventId: string,
  now: string,
): void {
  const claims = readEventClaims(db, roleId, eventId).filter(claim => claim.relatedEventId ||
    ["cherished_detail", "interest", "practice", "commitment"].includes(claim.correctedKind ?? claim.kind));
  if (claims.length === 0) {
    db.prepare("DELETE FROM memory_search_documents WHERE role_id=? AND record_type='event' AND record_id=?")
      .run(roleId, eventId);
    return;
  }
  const visible = searchableClaims(claims);
  const relatedText = visible.map(claim =>
    [claim.quoteContext ?? claim.text, claim.practice?.scope, claim.practice?.outcome].filter(Boolean).join("\n"),
  ).join("\n").toLowerCase();
  upsertSearchDocument(db, { roleId, recordType: "event", recordId: eventId,
    title: "保留的经历线索", body: visible.map(claimSearchText).join("\n"), relatedText, now });
}

export class MemorySearchStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getSearchDocument(
    roleId: string,
    recordType: string,
    recordId: string,
  ): SearchDocument | null {
    const row = this.db
      .prepare(
        "SELECT title, body FROM memory_search_documents WHERE role_id = ? AND record_type = ? AND record_id = ?",
      )
      .get(roleId, recordType, recordId) as
      | SearchDocument
      | undefined;
    return row ?? null;
  }

  saveRetrieval(input: SaveRetrievalInput): void {
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

  /** 最终出站请求获得确认后登记。同一次决策内，概况和工具深查共用一次召回。 */
  recordDeliveries(roleId: string, executionId: string, reads: readonly MemoryDelivery[], now: string): void {
    if (reads.length === 0) return;
    this.db.transaction(() => {
      const mark = this.db.prepare(`UPDATE retrieval_results SET delivered = 1
        WHERE retrieval_id = ? AND record_type = ? AND record_id = ? AND EXISTS (
          SELECT 1 FROM retrieval_queries q WHERE q.retrieval_id = retrieval_results.retrieval_id
            AND q.role_id = ? AND q.mode <> 'manual')`);
      for (const read of reads) {
        if (read.retrievalId) mark.run(read.retrievalId, read.type, read.id, roleId);
        this.recordRecall({ roleId, executionId, recordType: read.type, recordId: read.id, now });
      }
    })();
  }

  recordRecall(input: RecordRecallInput): boolean {
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

  rebuildEventSearch(): void {
    const rows = this.db.prepare("SELECT role_id,event_id FROM memory_events").all() as {role_id: string; event_id: string}[];
    for (const row of rows) {
      const event = readEvent(this.db, row.role_id, row.event_id);
      if (event.lifecycleStatus === "refined") {
        indexRetainedDetails(this.db, row.role_id, row.event_id, event.updatedAt);
      } else {
        upsertSearchDocument(this.db, { roleId: row.role_id, recordType: "event", recordId: row.event_id,
          title: event.title, body: [event.summary, event.subjectiveExperience,
            ...searchableClaimText(readEventClaims(this.db, row.role_id, row.event_id))].filter(Boolean).join("\n"), now: event.updatedAt });
      }
    }
  }

  rebuildSummarySearch(): void {
    this.db.exec(`INSERT INTO memory_search_documents (role_id,record_type,record_id,title,body,updated_at)
      SELECT role_id,'daily_summary',summary_id,coalesce(nullif(topic,''),experience_date),summary,updated_at
      FROM daily_summaries WHERE true
      ON CONFLICT(role_id,record_type,record_id) DO UPDATE SET
        title=excluded.title, body=excluded.body, updated_at=excluded.updated_at`);
  }

  upsertSearchDocument(input: UpsertSearchDocumentInput): void {
    upsertSearchDocument(this.db, input);
  }
}
