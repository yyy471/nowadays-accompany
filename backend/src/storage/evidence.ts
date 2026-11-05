import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

interface MessageEvidenceRow {
  message_id: string;
  window_id: string;
  status: string;
  sequence: number;
  created_at: string;
}

interface ToolEvidenceRow {
  tool_call_id: string;
  status: string;
  saved_at: string;
  task_id: string;
  execution_id: string;
  window_id: string | null;
}

interface EvidenceInput {
  roleId: string;
  sourceKind: "message" | "tool_result";
  sourceId: string;
  windowId: string | null;
  taskId: string | null;
  executionId: string | null;
  sourceStatus: string;
  occurredAt: string;
  localDate: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function localDateFromIso(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`INVALID_TIMESTAMP:${iso}`);
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function registerMessageEvidence(
  db: Database.Database,
  input: {
    roleId: string;
    messageIds: readonly string[];
    executionId: string | null;
    timeZone?: string;
    now?: string;
  },
): number {
  const rows = input.messageIds.map((messageId) => {
    const row = db
      .prepare(
        `SELECT m.message_id, m.window_id, m.status, m.sequence, m.created_at
         FROM messages m JOIN windows w ON w.window_id = m.window_id
         WHERE m.message_id = ? AND w.role_id = ?`,
      )
      .get(messageId, input.roleId) as MessageEvidenceRow | undefined;
    if (!row) {
      throw new Error(`EVIDENCE_MESSAGE_NOT_FOUND:${messageId}`);
    }
    if (row.status === "generating") {
      throw new Error(`EVIDENCE_MESSAGE_NOT_FINAL:${messageId}`);
    }
    return row;
  });
  for (const row of rows) {
    upsertEvidence(db, {
      roleId: input.roleId,
      sourceKind: "message",
      sourceId: row.message_id,
      windowId: row.window_id,
      taskId: null,
      executionId: input.executionId,
      sourceStatus: row.status,
      occurredAt: row.created_at,
      localDate: localDateFromIso(row.created_at, input.timeZone),
    }, input.now);
  }
  return rows.length;
}

export function registerToolResultEvidence(
  db: Database.Database,
  input: {
    roleId: string;
    toolCallId: string;
    timeZone?: string;
    now?: string;
  },
): boolean {
  const row = db
    .prepare(
      `SELECT tr.tool_call_id, tr.status, tr.saved_at, tc.task_id,
              tc.execution_id, e.window_id
       FROM tool_results tr
       JOIN tool_calls tc ON tc.tool_call_id = tr.tool_call_id
       JOIN tasks t ON t.task_id = tc.task_id
       LEFT JOIN executions e ON e.execution_id = tc.execution_id
       WHERE tr.tool_call_id = ? AND t.role_id = ?`,
    )
    .get(input.toolCallId, input.roleId) as ToolEvidenceRow | undefined;
  if (!row) {
    return false;
  }
  upsertEvidence(db, {
    roleId: input.roleId,
    sourceKind: "tool_result",
    sourceId: row.tool_call_id,
    windowId: row.window_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    sourceStatus: row.status,
    occurredAt: row.saved_at,
    localDate: localDateFromIso(row.saved_at, input.timeZone),
  }, input.now);
  return true;
}

export function backfillEvidence(
  db: Database.Database,
  timeZone?: string,
): void {
  const role = db
    .prepare("SELECT role_id FROM roles ORDER BY rowid ASC LIMIT 1")
    .get() as { role_id: string } | undefined;
  if (!role) {
    return;
  }
  const messages = db
    .prepare(
      `SELECT message_id, window_id, status, sequence, created_at
       FROM messages ORDER BY created_at ASC, window_id ASC, sequence ASC`,
    )
    .all() as MessageEvidenceRow[];
  const tools = db
    .prepare(
      `SELECT tr.tool_call_id, tr.status, tr.saved_at, tc.task_id,
              tc.execution_id, e.window_id
       FROM tool_results tr
       JOIN tool_calls tc ON tc.tool_call_id = tr.tool_call_id
       JOIN tasks t ON t.task_id = tc.task_id
       LEFT JOIN executions e ON e.execution_id = tc.execution_id
       WHERE t.role_id = ?
       ORDER BY tr.saved_at ASC, tr.tool_call_id ASC`,
    )
    .all(role.role_id) as ToolEvidenceRow[];
  const rows: Array<{ occurredAt: string; kind: "message" | "tool_result"; row: MessageEvidenceRow | ToolEvidenceRow }> = [
    ...messages.map((row) => ({
      occurredAt: row.created_at,
      kind: "message" as const,
      row,
    })),
    ...tools.map((row) => ({
      occurredAt: row.saved_at,
      kind: "tool_result" as const,
      row,
    })),
  ].sort((left, right) => {
    const byTime = left.occurredAt.localeCompare(right.occurredAt);
    if (byTime !== 0) {
      return byTime;
    }
    const byKind = left.kind.localeCompare(right.kind);
    if (byKind !== 0) {
      return byKind;
    }
    if (left.kind === "message") {
      const leftMessage = left.row as MessageEvidenceRow;
      const rightMessage = right.row as MessageEvidenceRow;
      const byWindow = leftMessage.window_id.localeCompare(rightMessage.window_id);
      if (byWindow !== 0) {
        return byWindow;
      }
      const bySequence = leftMessage.sequence - rightMessage.sequence;
      if (bySequence !== 0) {
        return bySequence;
      }
      return leftMessage.message_id.localeCompare(rightMessage.message_id);
    }
    const leftId = (left.row as ToolEvidenceRow).tool_call_id;
    const rightId = (right.row as ToolEvidenceRow).tool_call_id;
    return leftId.localeCompare(rightId);
  });
  for (const item of rows) {
    if (item.kind === "message") {
      const row = item.row as MessageEvidenceRow;
      upsertEvidence(db, {
        roleId: role.role_id,
        sourceKind: "message",
        sourceId: row.message_id,
        windowId: row.window_id,
        taskId: null,
        executionId: null,
        sourceStatus: row.status,
        occurredAt: row.created_at,
        localDate: localDateFromIso(row.created_at, timeZone),
      });
      continue;
    }
    const row = item.row as ToolEvidenceRow;
    upsertEvidence(db, {
      roleId: role.role_id,
      sourceKind: "tool_result",
      sourceId: row.tool_call_id,
      windowId: row.window_id,
      taskId: row.task_id,
      executionId: row.execution_id,
      sourceStatus: row.status,
      occurredAt: row.saved_at,
      localDate: localDateFromIso(row.saved_at, timeZone),
    });
  }
}

function upsertEvidence(
  db: Database.Database,
  input: EvidenceInput,
  now = new Date().toISOString(),
): void {
  const existing = db
    .prepare(
      "SELECT evidence_id FROM evidence_records WHERE role_id = ? AND source_kind = ? AND source_id = ?",
    )
    .get(input.roleId, input.sourceKind, input.sourceId) as
    | { evidence_id: string }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE evidence_records
       SET source_status = ?, window_id = COALESCE(?, window_id),
           task_id = COALESCE(?, task_id), execution_id = COALESCE(?, execution_id)
       WHERE evidence_id = ?`,
    ).run(
      input.sourceStatus,
      input.windowId,
      input.taskId,
      input.executionId,
      existing.evidence_id,
    );
    return;
  }
  const sequence = (
    db
      .prepare(
        "SELECT COALESCE(MAX(role_sequence), 0) + 1 AS next_sequence FROM evidence_records WHERE role_id = ?",
      )
      .get(input.roleId) as { next_sequence: number }
  ).next_sequence;
  const evidenceId = randomUUID();
  db.prepare(
    `INSERT INTO evidence_records (
       evidence_id, role_id, source_kind, source_id, window_id, task_id,
       execution_id, source_status, occurred_at, local_date, role_sequence, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evidenceId,
    input.roleId,
    input.sourceKind,
    input.sourceId,
    input.windowId,
    input.taskId,
    input.executionId,
    input.sourceStatus,
    input.occurredAt,
    input.localDate,
    sequence,
    now,
  );
  db.prepare(
    "INSERT INTO evidence_processing (evidence_id, status, updated_at) VALUES (?, 'pending', ?)",
  ).run(evidenceId, now);
}
