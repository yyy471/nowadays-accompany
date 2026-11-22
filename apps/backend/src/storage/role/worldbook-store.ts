import type Database from "better-sqlite3";
import { AppError } from "../../domain/errors.js";
import { embeddedWorldbook, type Worldbook, type WorldbookSelection, type WorldbookSnapshot } from "../../domain/worldbook.js";

export function readWorldbooks(db: Database.Database, roleId: string): WorldbookSnapshot {
  const row = db.prepare("SELECT revision, books_json FROM role_worldbooks WHERE role_id = ?").get(roleId) as
    { revision: number; books_json: string } | undefined;
  if (row) return { revision: row.revision, books: JSON.parse(row.books_json) as Worldbook[] };
  const card = db.prepare(`SELECT definition_revision AS revision,
    COALESCE(json_extract(definition_payload_json, '$.data.character_book'),
      json_extract(definition_payload_json, '$.character_book')) AS embedded
    FROM roles WHERE role_id = ?`).get(roleId) as { revision: number; embedded: unknown } | undefined;
  // 兼容只含角色卡的旧库和迁移包，用户保存或清空后优先使用独立世界书。
  if (typeof card?.embedded === "string" && card.embedded.startsWith("{")) {
    let raw: unknown;
    try { raw = JSON.parse(card.embedded); } catch { /* 非结构化扩展字段不作为设定 */ }
    const book = embeddedWorldbook(raw);
    if (book) return { revision: card.revision, books: [book] };
  }
  return { revision: 0, books: [] };
}

export function replaceWorldbooks(db: Database.Database, roleId: string, expectedRevision: number, books: Worldbook[]): WorldbookSnapshot {
  return db.transaction(() => {
    const current = readWorldbooks(db, roleId);
    if (current.revision !== expectedRevision) {
      throw new AppError(409, "WORLDBOOK_REVISION_CONFLICT", "世界书已被修改，请重新读取后合并更改", { revision: current.revision });
    }
    const revision = current.revision + 1;
    db.prepare(`INSERT INTO role_worldbooks (role_id, revision, books_json) VALUES (?, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET revision = excluded.revision, books_json = excluded.books_json`)
      .run(roleId, revision, JSON.stringify(books));
    return { revision, books };
  }).immediate();
}

export function recordWorldbookUsage(db: Database.Database, input: {
  roleId: string; executionId: string; modelCallId: string; worldbookSelection: WorldbookSelection[];
}): void {
  if (!input.worldbookSelection.length) return;
  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO worldbook_usage
      (role_id, execution_id, model_call_id, revision, book_id, entry_id, status, matched_message_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of input.worldbookSelection) {
      insert.run(input.roleId, input.executionId, input.modelCallId, item.revision, item.bookId, item.entryId,
        item.status, JSON.stringify(item.messageIds));
    }
  })();
}

export function readWorldbookUsage(db: Database.Database, roleId: string, executionId: string) {
  const rows = db.prepare(`SELECT model_call_id AS modelCallId, execution_id AS executionId, revision,
    book_id AS bookId, entry_id AS entryId, status, matched_message_ids_json AS messageIdsJson
    FROM worldbook_usage WHERE role_id = ? AND execution_id = ? ORDER BY rowid`).all(roleId, executionId) as
    (Omit<WorldbookSelection, "messageIds"> & { executionId: string; modelCallId: string; messageIdsJson: string })[];
  return rows.map(({ messageIdsJson, ...row }) => ({ ...row, messageIds: JSON.parse(messageIdsJson) as string[] }));
}

export interface EventWorldbookReference { bookId: string; entryId: string; revision: number; evidenceId: string }

/** 消息来源与已送达条目的交叉引用，只说明当时的上下文，不代表角色亲历了设定。 */
export function eventWorldbookReferences(db: Database.Database, roleId: string, eventId: string): EventWorldbookReference[] {
  return db.prepare(`SELECT DISTINCT u.book_id AS bookId, u.entry_id AS entryId, u.revision, e.evidence_id AS evidenceId
    FROM memory_event_sources s JOIN evidence_records e ON e.evidence_id = s.evidence_id
    JOIN messages m ON m.message_id = e.source_id AND e.source_kind = 'message'
    JOIN executions x ON x.role_id = e.role_id AND x.window_id = m.window_id
    JOIN worldbook_usage u ON u.role_id = x.role_id AND u.execution_id = x.execution_id AND u.status = 'included'
    WHERE s.event_id = ? AND e.role_id = ? AND (
      (m.sender = 'assistant' AND m.execution_id = u.execution_id) OR
      (m.sender = 'user' AND m.message_id IN (SELECT value FROM json_each(u.matched_message_ids_json))))
    ORDER BY e.evidence_id, u.revision, u.book_id, u.entry_id`).all(eventId, roleId) as EventWorldbookReference[];
}
