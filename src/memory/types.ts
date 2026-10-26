import type { ChatKind } from '../routing/identity.js';

/** A memory namespace is one explicit role's history epoch inside one conversation. */
export interface MemoryScope {
  accountId: string;
  kind: ChatKind;
  peerId: string;
  contextEpoch: string;
}

export interface MemorySettings {
  enabled: boolean;
  autoExtract: boolean;
  budgetChars: number;
  maxSelected: number;
}

export type MemoryRecordType = 'fact' | 'summary';
export type MemoryRecordOrigin = 'user' | 'model';

export interface MemorySourceRange {
  fromSeq: number;
  throughSeq: number;
}

export interface MemoryRecord {
  id: string;
  revision: string;
  type: MemoryRecordType;
  content: string;
  keys: string[];
  pinned: boolean;
  origin: MemoryRecordOrigin;
  createdAt: number;
  updatedAt: number;
  source?: MemorySourceRange;
}

export type MemoryExtractionPauseReason = 'user' | 'deleted' | 'cleared' | 'memory-disabled' | 'capacity';

export interface MemoryExtractionResult {
  sourceKey: string;
  throughSeq: number;
  at: number;
}

export interface MemoryExtractionFailure {
  code: string;
  at: number;
  /** A fatal failure requires an explicit recovery action instead of automatic retry. */
  fatal?: boolean;
}

export interface MemoryExtractionState {
  throughSeq: number;
  /** Only version 1 means the user explicitly confirmed paid model use in MEM03. */
  activationVersion?: 1;
  /** Messages at or before this seq must not be backfilled by this activation. */
  activatedAfterSeq?: number;
  lastCompletedSourceKey?: string;
  recentResults?: MemoryExtractionResult[];
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  cooldownUntil?: number;
  pausedReason?: MemoryExtractionPauseReason;
  lastFailure?: MemoryExtractionFailure;
}

export interface MemoryReceipt {
  requestId: string;
  payload: string;
  recordId: string;
  at: number;
}

export interface MemoryState {
  version: 1;
  scope: MemoryScope;
  revision: string;
  /** Increases on every persisted content, settings or reset change. */
  generation: number;
  settings: MemorySettings;
  records: MemoryRecord[];
  extraction?: MemoryExtractionState;
  receipts: MemoryReceipt[];
}

/** Immutable per-turn view used by the agent and the send guard. */
export interface MemorySnapshot {
  scopeToken: string;
  revision: string;
  generation: number;
  settings: MemorySettings;
  records: readonly MemoryRecord[];
  state: 'ready' | 'unavailable';
  /** Safe diagnostic; never contains the state file path or record text. */
  error?: string;
  guard: string;
}

export interface MemoryEvaluation {
  /** Full "长期记忆" section including its title; empty when nothing is selected. */
  content: string;
  selectedIds: string[];
  budgetSkippedIds: string[];
  countSkippedIds: string[];
  /** Actual runtime text increment, including the section title, tags, separators and system join. */
  usedChars: number;
  scanLimited?: boolean;
  unscannedIds?: string[];
  ignoredSummaryCount?: number;
}

export const MEMORY_LIMITS = {
  maxRecords: 1000,
  maxContentChars: 4000,
  maxTotalContentChars: 1_048_576,
  maxKeys: 16,
  maxKeyChars: 128,
  maxBudgetChars: 8000,
  maxSelectedMin: 1,
  maxSelectedMax: 20,
  defaultBudgetChars: 1500,
  defaultMaxSelected: 8,
  maxStateFileBytes: 8 * 1024 * 1024,
  receiptLimit: 128,
  pageDefault: 50,
  pageMax: 100,
  maxEpochChars: 512,
  maxRevisionChars: 128,
  scanTailChars: 16_000,
  matchWorkLimit: 8_000_000,
  recentExtractionResults: 64,
  maxExtractionFacts: 8,
  maxExtractionContentChars: 1_000,
  maxExtractionKeys: 8,
  maxExtractionKeyChars: 64,
  maxExtractionOutputChars: 16_000
} as const;

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: false,
  autoExtract: false,
  budgetChars: MEMORY_LIMITS.defaultBudgetChars,
  maxSelected: MEMORY_LIMITS.defaultMaxSelected
};

/** Revision reported for a scope that has no state file yet; the first write replaces it. */
export const MEMORY_DEFAULT_REVISION = 'r0';
