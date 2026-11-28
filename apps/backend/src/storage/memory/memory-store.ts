import type Database from "better-sqlite3";
import type { MemoryDelivery } from "../../domain/model.js";
import type {
  DailySummaryBrief,
  DailySummaryRecord,
  DailySummarySourceRecord,
  DiaryDetail,
  DiaryRecord,
  EvidenceSender,
  MemoryBatchRecord,
  MemoryEventRecord,
  MemoryEventSourceRecord,
  MemoryEvidenceDetail,
  MemorySourceKind,
  MemoryTagValues,
  RefineCandidateBrief,
  RelatedEventBrief,
  SummaryEvidenceItem,
} from "../../domain/memory.js";
import { MemoryBatchStore } from "./memory-batch-store.js";
import { MemoryEventStore } from "./memory-event-store.js";
import { MemoryEvidenceStore } from "./memory-evidence-store.js";
import { MemorySearchStore } from "./memory-search-store.js";
import { MemorySummaryDiaryStore } from "./memory-summary-diary-store.js";
import type {
  CorrectSummaryInput,
  CreateDiaryInput,
  CreateEventInput,
  EnqueueTriggerInput,
  EventClaim,
  EvidenceWithProcessing,
  FinishBatchInput,
  ListSummaryEvidenceInput,
  MarkEvidenceDeferredInput,
  MemoryStatus,
  NextSegment,
  PendingMessageStat,
  PendingTrigger,
  RecordRecallInput,
  RefineEventInput,
  SaveRetrievalInput,
  SearchDocument,
  StartBatchInput,
  StartedBatch,
  UpdateDiarySnapshotInput,
  UpdateEventInput,
} from "./memory-store-types.js";

export type {
  CorrectSummaryInput,
  CreateDiaryInput,
  CreateEventInput,
  EnqueueTriggerInput,
  EventClaim,
  EvidenceWithProcessing,
  FinishBatchInput,
  ListSummaryEvidenceInput,
  MarkEvidenceDeferredInput,
  MemoryStatus,
  NextSegment,
  PendingMessageStat,
  PendingTrigger,
  RecordRecallInput,
  RefineEventInput,
  SaveRetrievalInput,
  SearchDocument,
  StartBatchInput,
  StartedBatch,
  StartedEvidence,
  UpdateDiarySnapshotInput,
  UpdateEventInput,
} from "./memory-store-types.js";

export class MemoryStore {
  private readonly db: Database.Database;
  private readonly evidence: MemoryEvidenceStore;
  private readonly batches: MemoryBatchStore;
  private readonly events: MemoryEventStore;
  private readonly summaries: MemorySummaryDiaryStore;
  private readonly search: MemorySearchStore;

  constructor(db: Database.Database) {
    this.db = db;
    this.evidence = new MemoryEvidenceStore(db);
    this.events = new MemoryEventStore(db);
    this.batches = new MemoryBatchStore(db, this.evidence, this.events);
    this.summaries = new MemorySummaryDiaryStore(db, this.events);
    this.search = new MemorySearchStore(db);
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  roleName(roleId: string): string {
    const row = this.db.prepare("SELECT display_name FROM roles WHERE role_id=?").get(roleId) as {display_name: string};
    return row.display_name;
  }

  getCurrentRound(roleId: string): number {
    return this.batches.getCurrentRound(roleId);
  }

  enqueueTrigger(input: EnqueueTriggerInput): { triggerId: string; duplicate: boolean } {
    return this.batches.enqueueTrigger(input);
  }

  listPendingTriggers(roleId: string): PendingTrigger[] {
    return this.batches.listPendingTriggers(roleId);
  }

  pendingMessageStats(roleId: string): PendingMessageStat[] {
    return this.evidence.pendingMessageStats(roleId);
  }

  pendingTaskEvidenceCount(roleId: string, taskId: string): number {
    return this.evidence.pendingTaskEvidenceCount(roleId, taskId);
  }

  listFinishedTasksNeedingTrigger(roleId: string): string[] {
    return this.batches.listFinishedTasksNeedingTrigger(roleId);
  }

  reconcileFinishedTaskTriggers(
    roleId: string,
    now?: string,
  ): { inserted: number; failedTaskIds: string[] } {
    return this.batches.reconcileFinishedTaskTriggers(roleId, now);
  }

  nextFailedRetryAt(roleId: string): string | null {
    return this.evidence.nextFailedRetryAt(roleId);
  }

  hasDueFailedEvidence(roleId: string, now: string): boolean {
    return this.evidence.hasDueFailedEvidence(roleId, now);
  }

  startBatch(input: StartBatchInput): StartedBatch | null {
    return this.batches.startBatch(input);
  }

  getNextSegments(
    roleId: string,
    batchId: string,
    budgetChars: number,
    options: { serialized?: boolean } = {},
  ): NextSegment[] {
    return this.evidence.getNextSegments(roleId, batchId, budgetChars, options);
  }

  markSegmentProcessed(
    evidenceId: string,
    segmentIndex: number,
    now: string,
  ): void {
    this.evidence.markSegmentProcessed(evidenceId, segmentIndex, now);
  }

  remainingSegments(evidenceId: string): number {
    return this.evidence.remainingSegments(evidenceId);
  }

  markEvidenceProcessed(
    roleId: string,
    batchId: string,
    evidenceId: string,
    now: string,
  ): void {
    this.evidence.markEvidenceProcessed(roleId, batchId, evidenceId, now);
  }

  markEvidenceDeferred(input: MarkEvidenceDeferredInput): void {
    this.evidence.markEvidenceDeferred(input);
  }

  finishBatch(input: FinishBatchInput): void {
    this.batches.finishBatch(input);
  }

  recoverInterruptedBatches(
    roleId: string,
    now = new Date().toISOString(),
  ): number {
    return this.batches.recoverInterruptedBatches(roleId, now);
  }

  getBatch(roleId: string, batchId: string): MemoryBatchRecord {
    return this.batches.getBatch(roleId, batchId);
  }

  latestMaintenanceBatch(roleId: string): MemoryBatchRecord | null {
    return this.batches.latestMaintenanceBatch(roleId);
  }

  listEvents(roleId: string): MemoryEventRecord[] {
    return this.events.listEvents(roleId);
  }

  listRecentEvents(roleId: string, limit = 20, evidenceText = ""): RelatedEventBrief[] {
    return this.events.listRecentEvents(roleId, limit, evidenceText);
  }

  getEvent(roleId: string, eventId: string): MemoryEventRecord {
    return this.events.getEvent(roleId, eventId);
  }

  createEvent(input: CreateEventInput): MemoryEventRecord {
    return this.events.createEvent(input);
  }

  updateEvent(input: UpdateEventInput): MemoryEventRecord {
    return this.events.updateEvent(input);
  }

  listRelatedGrowthEvents(roleId: string, eventId: string): string[] {
    return this.events.listRelatedGrowthEvents(roleId, eventId);
  }

  listEventClaims(roleId: string, eventId: string): EventClaim[] {
    return this.events.listEventClaims(roleId, eventId);
  }

  evidenceMessageContext(
    kind: MemorySourceKind,
    sourceId: string,
  ): { sender: EvidenceSender; publishedReply?: boolean } {
    return this.evidence.evidenceMessageContext(kind, sourceId);
  }

  listEventSources(
    roleId: string,
    eventId: string,
  ): MemoryEventSourceRecord[] {
    return this.events.listEventSources(roleId, eventId);
  }

  getEvidenceDetail(roleId: string, evidenceId: string): MemoryEvidenceDetail {
    return this.evidence.getEvidenceDetail(roleId, evidenceId);
  }

  getSummary(roleId: string, summaryId: string): DailySummaryRecord {
    return this.summaries.getSummary(roleId, summaryId);
  }

  listSummarySources(summaryId: string): DailySummarySourceRecord[] {
    return this.summaries.listSummarySources(summaryId);
  }

  listSummaryEvidence(input: ListSummaryEvidenceInput): SummaryEvidenceItem[] {
    return this.summaries.listSummaryEvidence(input);
  }

  listRefineCandidates(
    roleId: string,
    currentRound: number,
    window = 100,
  ): RefineCandidateBrief[] {
    return this.events.listRefineCandidates(roleId, currentRound, window);
  }

  listSummaryCandidates(
    roleId: string,
    experienceDates: readonly string[],
  ): DailySummaryBrief[] {
    return this.summaries.listSummaryCandidates(roleId, experienceDates);
  }

  refineEvent(input: RefineEventInput): { events: MemoryEventRecord[]; summary: DailySummaryRecord } {
    return this.summaries.refineEvent(input);
  }

  correctSummary(input: CorrectSummaryInput): DailySummaryRecord {
    return this.summaries.correctSummary(input);
  }

  getMemoryStatus(roleId: string): MemoryStatus {
    return this.evidence.getMemoryStatus(roleId);
  }

  listBatches(roleId: string, limit: number, offset = 0): MemoryBatchRecord[] {
    return this.evidence.listBatches(roleId, limit, offset);
  }

  saveRetrieval(input: SaveRetrievalInput): void {
    this.search.saveRetrieval(input);
  }

  recordDeliveries(roleId: string, executionId: string, reads: readonly MemoryDelivery[], now: string): void {
    this.search.recordDeliveries(roleId, executionId, reads, now);
  }

  recordRecall(input: RecordRecallInput): boolean {
    return this.search.recordRecall(input);
  }

  createDiary(input: CreateDiaryInput): DiaryRecord {
    return this.summaries.createDiary(input);
  }

  listDiaries(roleId: string): DiaryRecord[] {
    return this.summaries.listDiaries(roleId);
  }

  getDiary(roleId: string, diaryId: string): DiaryDetail {
    return this.summaries.getDiary(roleId, diaryId);
  }

  updateDiarySnapshot(input: UpdateDiarySnapshotInput): DiaryRecord {
    return this.summaries.updateDiarySnapshot(input);
  }

  getTags(eventId: string): MemoryTagValues {
    return this.events.getTags(eventId);
  }

  getSearchDocument(
    roleId: string,
    recordType: string,
    recordId: string,
  ): SearchDocument | null {
    return this.search.getSearchDocument(roleId, recordType, recordId);
  }

  listEvidence(roleId: string): EvidenceWithProcessing[] {
    return this.evidence.listEvidence(roleId);
  }

  evidenceContent(evidenceId: string): string {
    return this.evidence.evidenceContent(evidenceId);
  }

  rebuildEventSearch(): void {
    this.search.rebuildEventSearch();
  }

  rebuildSummarySearch(): void {
    this.search.rebuildSummarySearch();
  }
}
