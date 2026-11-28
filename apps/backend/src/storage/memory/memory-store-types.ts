import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { MemoryEventNotFoundError } from "../../domain/errors.js";
import type {
  DailySummaryRecord,
  DiaryRecord,
  EvidenceSender,
  MemoryBatchRecord,
  MemoryClaimRecord,
  MemoryCorrectionSource,
  MemoryEventPatch,
  MemoryEventRecord,
  MemoryEventSourceRecord,
  MemoryEvidenceRecord,
  MemoryRecordType,
  MemorySegmentRecord,
  MemorySourceKind,
  MemoryTagValues,
  MemoryTriggerKind,
} from "../../domain/memory.js";
import { readWebEvidenceProjection } from "../conversation/web-reading.js";
import { SPOKEN_REPLY_SQL } from "./evidence.js";

const claimLabels: Record<MemoryClaimRecord["kind"], string> = {
  observation: "有据观察", interest: "个人兴趣", released: "当时已释怀",
  user_quote: "用户原话", impression: "角色当时的印象", past_feeling: "当时感受",
  reflection: "后来的理解", practice: "实践经验", cherished_detail: "珍惜的细节",
  shared_detail: "角色已讲原话", commitment: "角色承诺", unknown: "尚未知",
  correction: "更正后的线索",
};

export function claimSearchText(claim: MemoryClaimRecord): string {
  if (claim.correctionSource) {
    return `${claim.correctionSource === "user_correction" ? "用户更正" : "角色核验更正"}（${claim.recordedAt}） ${claim.text}`;
  }
  const scope = claim.practice ? `；适用：${claim.practice.scope}；实际结果：${claim.practice.outcome}` : "";
  const origin = claim.sourceSender === "assistant" ? "，据角色当时的发言" :
    claim.sourceSender === "user" ? "，据用户当时的发言" :
    claim.sourceKind === "tool_result" ? "，据工具回执" :
    claim.sourceKind === "role_exchange" ? "，据角色间发言" : "";
  return `${claimLabels[claim.kind]}（${claim.sourceAt}${origin}） ${claim.quoteContext ?? claim.text}${scope}`;
}

// 同一实践办法保留所有有据版本，检索正文只收录最新的适用范围和做法。
export function currentPracticeKey(claim: MemoryClaimRecord): string | undefined {
  return claim.practice?.key ?? claim.correctedPracticeKey;
}

export function comparePracticeHistory(a: MemoryClaimRecord, b: MemoryClaimRecord): number {
  const byEvidenceDate = Date.parse(a.sourceAt) - Date.parse(b.sourceAt);
  if (byEvidenceDate) return byEvidenceDate;
  const first = a.originalPracticeClaimId ?? a.claimId;
  const second = b.originalPracticeClaimId ?? b.claimId;
  if (!first || !second) return 0;
  // 同一证据日期下沿用原修订号和行号，编辑旧做法不会改变它在实践历程中的顺序。
  return first.localeCompare(second, "en", { numeric: true });
}

export function searchableClaims(claims: MemoryClaimRecord[]): MemoryClaimRecord[] {
  const latest = new Map<string, MemoryClaimRecord>();
  for (const claim of claims) {
    const key = currentPracticeKey(claim);
    if (!key) continue;
    const current = latest.get(key);
    if (!current || comparePracticeHistory(claim, current) >= 0) {
      latest.set(key, claim);
    }
  }
  return claims.filter(claim => {
    const key = currentPracticeKey(claim);
    return !key || latest.get(key) === claim;
  });
}

export function searchableClaimText(claims: MemoryClaimRecord[]): string[] {
  return searchableClaims(claims).map(claimSearchText);
}

export interface EvidenceRow {
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

export interface SegmentRow {
  evidence_id: string;
  segment_index: number;
  from_char: number;
  to_char: number;
  status: "pending" | "processed" | "failed";
  batch_id: string | null;
}

export interface EventRow {
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

export interface BatchRow {
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

export interface SummaryRow {
  summary_id: string;
  role_id: string;
  experience_date: string;
  topic: string;
  summary: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SummarySourceRow {
  summary_source_id: string;
  summary_id: string;
  window_id: string | null;
  from_sequence: number | null;
  to_sequence: number | null;
  occurred_from: string;
  occurred_to: string;
}

export interface DiaryRow {
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
  claims?: MemoryClaimRecord[];
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
  claims?: MemoryClaimRecord[];
  supersedeClaimIds?: string[];
  claimReplacements?: Record<string, string>;
  roleId: string;
  eventId: string;
  expectedVersion: number;
  patch: MemoryEventPatch;
  addEvidenceIds: readonly string[];
  currentRound: number;
  now: string;
  experienceDate?: string;
  changeSource?: "memory_batch" | MemoryCorrectionSource;
  reason?: string;
}

export interface MemoryStatus {
  runningBatchId: string | null;
  pendingEvidence: number;
  failedEvidence: number;
  deferredEvidence: number;
  pendingTriggers: number;
  lastBatch: MemoryBatchRecord | null;
}

export interface EnqueueTriggerInput {
  roleId: string;
  kind: MemoryTriggerKind;
  windowId?: string | null;
  taskId?: string | null;
  now?: string;
}

export interface PendingTrigger {
  triggerId: string;
  kind: MemoryTriggerKind;
  windowId: string | null;
  taskId: string | null;
  createdAt: string;
  batchId: string | null;
}

export interface PendingMessageStat {
  windowId: string | null;
  count: number;
  lastOccurredAt: string;
}

export interface StartBatchInput {
  roleId: string;
  budgetChars: number;
  outputReserveChars: number;
  includeDeferred?: boolean;
  includeRefinement?: boolean;
  maintenanceOnly?: boolean;
  now?: string;
}

export interface MarkEvidenceDeferredInput {
  roleId: string;
  batchId: string;
  evidenceId: string;
  afterSequence: number;
  now: string;
}

export interface FinishBatchInput {
  roleId: string;
  batchId: string;
  status: "completed" | "failed" | "partial";
  errorCode?: string | null;
  nextRetryAt?: string | null;
  now?: string;
}

export interface ListSummaryEvidenceInput {
  roleId: string;
  summaryId: string;
  windowId?: string;
  fromSequence?: number;
  toSequence?: number;
  limit?: number;
}

export interface RefineEventInput {
  roleId: string;
  events: ReadonlyArray<{ eventId: string; expectedVersion: number }>;
  summary: string;
  targetSummaryId?: string;
  expectedSummaryVersion?: number;
  topic?: string;
  reason?: string;
  now: string;
}

export interface CorrectSummaryInput {
  roleId: string;
  summaryId: string;
  expectedVersion: number;
  summary: string;
  changeSource?: MemoryCorrectionSource;
  reason?: string;
  now: string;
}

export interface SaveRetrievalInput {
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
}

export interface RecordRecallInput {
  roleId: string;
  executionId: string;
  recordType: MemoryRecordType;
  recordId: string;
  now: string;
}

export interface CreateDiaryInput {
  diaryId: string;
  roleId: string;
  relativePath: string;
  content: string;
  contentHash: string;
  occurredAt: string;
  experienceDate: string;
  eventIds: readonly string[];
  now: string;
}

export interface UpdateDiarySnapshotInput {
  roleId: string;
  diaryId: string;
  content: string;
  contentHash: string;
  now: string;
}

export type EventClaim = MemoryClaimRecord & { claimId: string };
export type EvidenceWithProcessing = MemoryEvidenceRecord & {
  processingStatus: string;
  attemptCount: number;
};
export type SearchDocument = { title: string; body: string };

export interface UpsertSearchDocumentInput {
  roleId: string;
  recordType: "event" | "daily_summary" | "diary";
  recordId: string;
  title: string;
  body: string;
  relatedText?: string;
  now: string;
}

export interface RevisionInput {
  roleId: string;
  targetType: "event" | "daily_summary";
  targetId: string;
  revisionNumber: number;
  baseRevision: number;
  changeSource: "memory_batch" | MemoryCorrectionSource;
  content: unknown;
  evidenceIds: readonly string[];
  now: string;
}

export interface EvidenceContentSource {
  role_id: string;
  source_kind: MemorySourceKind;
  source_id: string;
}

export function mapEventSource(row: EvidenceRow): MemoryEventSourceRecord {
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

export function mapSummary(row: SummaryRow): DailySummaryRecord {
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

export function mapDiary(row: DiaryRow): DiaryRecord {
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

export function diaryTitle(content: string, experienceDate: string): string {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return (line ?? experienceDate).slice(0, 120);
}

export function parseOptionalJson(value: string | null): unknown {
  if (value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function groupSummarySources(
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

export function mapBatch(row: BatchRow): MemoryBatchRecord {
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

export function mapSegment(row: SegmentRow): MemorySegmentRecord {
  return {
    evidenceId: row.evidence_id,
    segmentIndex: row.segment_index,
    fromChar: row.from_char,
    toChar: row.to_char,
    status: row.status,
    batchId: row.batch_id,
  };
}

export function mapEvidence(row: EvidenceRow): MemoryEvidenceRecord {
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

export function mapEvent(row: EventRow): MemoryEventRecord {
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

export function readEvent(
  db: Database.Database,
  roleId: string,
  eventId: string,
): MemoryEventRecord {
  const row = db
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

export function readEventClaims(
  db: Database.Database,
  roleId: string,
  eventId: string,
): EventClaim[] {
  const rows = db.prepare(
    `SELECT revision_number, json_extract(content_json, '$.claims') AS claims,
            json_extract(content_json, '$.supersedeClaimIds') AS superseded
       FROM memory_revisions WHERE role_id=? AND target_type='event' AND target_id=?
       ORDER BY revision_number`,
  ).all(roleId, eventId) as Array<{ revision_number: number; claims: string | null; superseded: string | null }>;
  const current = new Map<string, EventClaim>();
  for (const row of rows) {
    for (const id of row.superseded ? JSON.parse(row.superseded) as string[] : []) current.delete(id);
    const claims = row.claims ? JSON.parse(row.claims) as MemoryClaimRecord[] : [];
    for (const [index, claim] of claims.entries()) {
      const claimId = `v${row.revision_number}:${index}`;
      current.set(claimId, { ...claim, claimId });
    }
  }
  return [...current.values()];
}

export function readEvidenceMessageContext(
  db: Database.Database,
  kind: MemorySourceKind,
  sourceId: string,
): { sender: EvidenceSender; publishedReply?: boolean } {
  if (kind !== "message") return { sender: null };
  const row = db.prepare(
    `SELECT m.sender, (${SPOKEN_REPLY_SQL}) AS published
     FROM messages m JOIN windows w ON w.window_id = m.window_id WHERE m.message_id = ?`,
  ).get(sourceId) as { sender: EvidenceSender; published: number } | undefined;
  return row?.sender === "assistant" ? { sender: row.sender, publishedReply: Boolean(row.published) } : { sender: row?.sender ?? null };
}

export function loadEvidenceContent(
  db: Database.Database,
  row: EvidenceContentSource,
): string {
  if (row.source_kind === "role_exchange") {
    const turn = db.prepare(`SELECT t.sessionId, t.turnIndex, t.speakerRoleId, t.speakerName, t.createdAt, t.content,
        s.topic, s.initiatorName, s.targetName, s.initiatorRoleId, s.targetRoleId
      FROM role_exchange_turns t JOIN role_exchange_sessions s USING(sessionId) WHERE exchangeId = ?`).get(row.source_id);
    return JSON.stringify({ source: "角色间对话", perspectiveRoleId: row.role_id, turn });
  }
  if (row.source_kind === "message") {
    const message = db
      .prepare("SELECT content FROM messages WHERE message_id = ?")
      .get(row.source_id) as { content: string } | undefined;
    return message?.content ?? "";
  }
  const web = readWebEvidenceProjection(db, row.role_id, row.source_id);
  if (web !== undefined) return web;
  const result = db
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

export function insertRevision(
  db: Database.Database,
  input: RevisionInput,
): void {
  db
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
