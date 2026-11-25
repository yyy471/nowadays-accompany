import { z } from "zod";
import type { ModelProtocol } from "./model.js";

export const memoryTriggerKindSchema = z.enum([
  "message_threshold",
  "idle",
  "task_end",
  "manual",
  "retry",
]);
export type MemoryTriggerKind = z.infer<typeof memoryTriggerKindSchema>;

export const memorySourceKindSchema = z.enum(["message", "tool_result", "role_exchange"]);
export type MemorySourceKind = z.infer<typeof memorySourceKindSchema>;

const tagValuesSchema = z.object({
  person: z.array(z.string().trim().min(1).max(200)).optional(),
  topic: z.array(z.string().trim().min(1).max(200)).optional(),
  place: z.array(z.string().trim().min(1).max(200)).optional(),
  emotion: z.array(z.string().trim().min(1).max(200)).optional(),
  source: z.array(z.string().trim().min(1).max(200)).optional(),
}).strict();

const claimSchema = z.object({
  kind: z.enum(["observation", "interest", "released", "user_quote", "impression", "past_feeling", "reflection", "practice", "cherished_detail", "shared_detail", "commitment", "unknown"]),
  text: z.string().trim().min(1).max(2000),
  evidenceId: z.uuid(),
  relatedEventId: z.uuid().optional(),
  practice: z.object({
    key: z.string().trim().min(1).max(100),
    scope: z.string().trim().min(1).max(500),
    outcome: z.string().trim().min(1).max(500),
  }).strict().optional(),
}).strict().refine(value => (value.kind === "practice") === Boolean(value.practice), {
  message: "实践经验须包含稳定键、适用范围与实际结果",
});
export type MemoryClaim = z.infer<typeof claimSchema>;
export interface MemoryClaimRecord extends Omit<MemoryClaim, "kind"> {
  kind: MemoryClaim["kind"] | "correction";
  correctedKind?: MemoryClaim["kind"];
  claimId?: string;
  correctionSource?: MemoryCorrectionSource;
  correctedPracticeKey?: string;
  originalPracticeClaimId?: string;
  sourceKind?: MemorySourceKind;
  sourceSender?: EvidenceSender;
  learnedAt: string | null;
  sourceAt: string;
  recordedAt: string;
  quoteContext?: string;
}
const claimsSchema = z.array(claimSchema).max(30).optional();
export type EvidenceSender = "user" | "assistant" | null;

export const eventPatchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().trim().min(1).max(20_000).optional(),
  subjectiveExperience: z.string().trim().max(20_000).optional(),
  occurredAtStart: z.iso.datetime().optional(),
  occurredAtEnd: z.iso.datetime().nullable().optional(),
  tags: tagValuesSchema.optional(),
}).strict();

export const memoryOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create_event"),
    claims: claimsSchema,
    localKey: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(20_000),
    subjectiveExperience: z.string().trim().max(20_000).optional(),
    occurredAtStart: z.iso.datetime(),
    occurredAtEnd: z.iso.datetime().nullable().optional(),
    experienceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tags: tagValuesSchema.optional(),
    evidenceIds: z.array(z.uuid()).min(1),
  }).strict(),
  z.object({
    op: z.literal("update_event"),
    claims: claimsSchema,
    eventId: z.uuid(),
    expectedVersion: z.number().int().min(1),
    patch: eventPatchSchema,
    addEvidenceIds: z.array(z.uuid()).optional(),
    reason: z.string().trim().max(2000).optional(),
  }).strict(),
  z.object({
    op: z.literal("refine_event"),
    events: z
      .array(
        z
          .object({
            eventId: z.uuid(),
            expectedVersion: z.number().int().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    summary: z.string().trim().min(1).max(20_000),
    targetSummaryId: z.uuid().optional(),
    expectedSummaryVersion: z.number().int().min(1).optional(),
    topic: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().max(2000).optional(),
  }).strict().superRefine((value, context) => {
    if (
      (value.targetSummaryId === undefined) !==
      (value.expectedSummaryVersion === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "targetSummaryId 与 expectedSummaryVersion 需同时提供",
        path: ["targetSummaryId"],
      });
    }
  }),
  z.object({
    op: z.literal("defer"),
    evidenceIds: z.array(z.uuid()).min(1),
    reason: z.string().trim().max(2000).optional(),
  }).strict(),
]);

export const memoryFormationResponseSchema = z.object({
  operations: z.array(memoryOperationSchema).max(100),
}).strict();

export type MemoryOperation = z.infer<typeof memoryOperationSchema>;
export type MemoryFormationResponse = z.infer<typeof memoryFormationResponseSchema>;
export type MemoryTagValues = z.infer<typeof tagValuesSchema>;
export type MemoryEventPatch = z.infer<typeof eventPatchSchema>;

export interface MemoryEvidenceInput {
  publishedReply?: boolean;
  sender?: EvidenceSender;
  evidenceId: string;
  sourceKind: MemorySourceKind;
  sourceStatus: string;
  windowId: string | null;
  occurredAt: string;
  localDate: string;
  content: string;
  segmentIndex: number;
  segmentCount: number;
}

export interface RelatedEventBrief {
  practiceKeys?: string[];
  eventId: string;
  title: string;
  summary: string;
  experienceDate: string;
  version: number;
}

export interface RefineCandidateBrief extends RelatedEventBrief {
  lastSupplementedRound: number;
}

export interface DailySummaryBrief {
  summaryId: string;
  experienceDate: string;
  topic: string;
  summary: string;
  version: number;
}

export interface MemoryFormationInput {
  roleId: string;
  roleName?: string;
  batchId: string;
  currentRound: number;
  evidence: MemoryEvidenceInput[];
  relatedEvents: RelatedEventBrief[];
  refineCandidates: RefineCandidateBrief[];
  summaryCandidates: DailySummaryBrief[];
}

export const memoryRecordTypeSchema = z.enum(["event", "daily_summary", "diary"]);
export type MemoryRecordType = z.infer<typeof memoryRecordTypeSchema>;

const tagFilterSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(20)
  .optional();

export const memorySearchRequestSchema = z
  .object({
    query: z.string().trim().max(500).optional(),
    types: z.array(memoryRecordTypeSchema).max(3).optional(),
    people: tagFilterSchema,
    topics: tagFilterSchema,
    places: tagFilterSchema,
    emotions: tagFilterSchema,
    sources: tagFilterSchema,
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;

export interface MemorySearchItem {
  type: MemoryRecordType;
  id: string;
  title: string;
  snippet: string;
  experienceDate?: string;
  rank: number;
}

export interface MemorySearchOutcome {
  retrievalId: string;
  items: MemorySearchItem[];
}

const claimIdSchema = z.string().regex(/^v[1-9]\d*:\d+$/).max(40);
export const eventCorrectionSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    patch: eventPatchSchema.default({}),
    addEvidenceIds: z.array(z.uuid()).max(50).optional(),
    supersedeClaimIds: z.array(claimIdSchema).max(100).optional(),
    claimReplacements: z.record(claimIdSchema, z.string().trim().min(1).max(2000)).optional(),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();
export type EventCorrection = z.infer<typeof eventCorrectionSchema>;
export type MemoryCorrectionSource = "user_correction" | "agent_correction";

export const summaryCorrectionSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    summary: z.string().trim().min(1).max(20_000),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();
export type SummaryCorrection = z.infer<typeof summaryCorrectionSchema>;

export const diaryCreateSchema = z
  .object({
    content: z.string().trim().min(1).max(100_000),
    occurredAt: z.iso.datetime().optional(),
    eventIds: z.array(z.uuid()).max(50).optional(),
  })
  .strict();
export type DiaryCreateInput = z.infer<typeof diaryCreateSchema>;

export interface MemoryEventSourceRecord {
  sender?: EvidenceSender;
  evidenceId: string;
  sourceKind: MemorySourceKind;
  sourceId: string;
  windowId: string | null;
  taskId: string | null;
  executionId: string | null;
  sourceStatus: string;
  occurredAt: string;
  localDate: string;
  roleSequence: number;
}

export interface MemoryEvidenceDetail extends MemoryEvidenceRecord {
  sender?: EvidenceSender;
  processingStatus: string;
  attemptCount: number;
  content: string;
  rawResponse?: unknown;
  adaptedResult?: unknown;
  error?: unknown;
}

export interface DailySummaryRecord {
  summaryId: string;
  roleId: string;
  experienceDate: string;
  topic: string;
  summary: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DailySummarySourceRecord {
  summarySourceId: string;
  summaryId: string;
  windowId: string | null;
  fromSequence: number | null;
  toSequence: number | null;
  occurredFrom: string;
  occurredTo: string;
}

export interface SummaryEvidenceItem {
  sender?: EvidenceSender;
  evidenceId: string;
  sourceKind: MemorySourceKind;
  windowId: string | null;
  sequence: number | null;
  occurredAt: string;
  roleSequence: number;
  content: string;
}

export interface DiaryRecord {
  diaryId: string;
  roleId: string;
  relativePath: string;
  occurredAt: string;
  experienceDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiaryDetail extends DiaryRecord {
  content: string;
  eventIds: string[];
}

export interface DiarySegmentView {
  diaryId: string;
  relativePath: string;
  occurredAt: string;
  experienceDate: string;
  content: string;
  totalChars: number;
  fromChar: number;
  toChar: number;
  hasMore: boolean;
  eventIds: string[];
}

export const DEFAULT_DIARY_SEGMENT_CHARS = 4_000;
export const MAX_DIARY_SEGMENT_CHARS = 20_000;

/** 记忆整理所绑定模型的可用容量声明；资料不全时按保守默认估算。 */
export interface MemoryModelCapacity {
  maxInputChars: number;
  maxOutputChars: number;
  source: "declared" | "conservative_default";
}

export interface MemoryFormationCallOptions {
  onUsage?: (usage: import("./model.js").ModelUsage) => void;
  onModelInfo?: (info: MemoryModelInfo) => void;
}

export interface MemoryModelPort {
  form(input: MemoryFormationInput, options?: MemoryFormationCallOptions): Promise<unknown>;
}

export interface MemoryModelInfo {
  resourceId?: string | null;
  modelName: string;
  protocol: ModelProtocol;
}

export const DEFAULT_MEMORY_BUDGET_CHARS = 24_000;
export const DEFAULT_OUTPUT_RESERVE_CHARS = 4_000;
export const DEFAULT_MEMORY_RETRY_DELAYS_MS = [
  30_000,
  120_000,
  600_000,
  3_600_000,
] as const;

export interface MemoryBatchRecord {
  batchId: string;
  roleId: string;
  status: "running" | "completed" | "failed" | "partial";
  inputFromSequence: number;
  inputToSequence: number;
  contextBudgetChars: number;
  outputReserveChars: number;
  attemptCount: number;
  lastErrorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface MemorySegmentRecord {
  evidenceId: string;
  segmentIndex: number;
  fromChar: number;
  toChar: number;
  status: "pending" | "processed" | "failed";
  batchId: string | null;
}

export interface MemoryEvidenceRecord {
  evidenceId: string;
  roleId: string;
  sourceKind: MemorySourceKind;
  sourceId: string;
  windowId: string | null;
  taskId: string | null;
  executionId: string | null;
  sourceStatus: string;
  occurredAt: string;
  localDate: string;
  roleSequence: number;
}

export interface MemoryEventRecord {
  eventId: string;
  roleId: string;
  title: string;
  summary: string;
  subjectiveExperience: string;
  occurredAtStart: string;
  occurredAtEnd: string | null;
  experienceDate: string;
  lifecycleStatus: "active" | "refined";
  refinedSummaryId: string | null;
  version: number;
  lastSupplementedRound: number;
  createdAt: string;
  updatedAt: string;
}
