import type { ChatKind } from '../routing/identity.js';
import type {
  MemoryEvaluation,
  MemoryExtractionFailure,
  MemoryExtractionPauseReason,
  MemoryRecord,
  MemorySettings,
  MemorySourceRange
} from '../memory/types.js';

export type { MemoryEvaluation } from '../memory/types.js';

export type MemoryExtractionEffectiveStatus = 'disabled' | 'needs-confirmation' | 'active' | 'paused' | 'cooldown' | 'failed';

export interface MemoryExtractionView {
  effectiveStatus: MemoryExtractionEffectiveStatus;
  autoExtract: boolean;
  activationVersion?: 1;
  activatedAfterSeq?: number;
  throughSeq: number;
  lastCompletedSourceKey?: string;
  recentResultCount: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  cooldownUntil?: number;
  pausedReason?: MemoryExtractionPauseReason;
  lastFailure?: MemoryExtractionFailure;
}

/** Browser-safe views for the per-conversation memory APIs. */
export interface MemoryStateView {
  accountId: string;
  kind: ChatKind;
  peerId: string;
  /** Opaque namespace; writes must send it back as expectedScope. */
  scopeToken: string;
  revision: string;
  generation: number;
  settings: MemorySettings;
  recordCount: number;
  extraction: MemoryExtractionView;
}

export interface MemoryRecordSummary {
  id: string;
  revision: string;
  type: MemoryRecord['type'];
  contentLength: number;
  keys: string[];
  pinned: boolean;
  origin: MemoryRecord['origin'];
  createdAt: number;
  updatedAt: number;
  source?: MemorySourceRange;
}

export interface MemoryRecordPage {
  scopeToken: string;
  revision: string;
  generation: number;
  total: number;
  items: MemoryRecordSummary[];
  nextOffset?: number;
}

export interface MemoryRecordDetail extends MemoryStateView {
  record: MemoryRecord;
}

export interface MemoryRecordMutation extends MemoryStateView {
  record: MemoryRecord;
  created?: boolean;
}

export interface MemoryDeleteResult {
  scopeToken: string;
  revision: string;
  generation: number;
  recordCount: number;
  deleted: string;
  extraction: MemoryExtractionView;
}

/** Effective extraction status without chat text or model output. */
export interface MemoryExtractionStatusView {
  scopeToken: string;
  revision: string;
  generation: number;
  extraction: MemoryExtractionView;
  /** Present when the coordinator/quota store is wired. */
  quota?: MemoryExtractionQuotaView;
  runtime?: MemoryExtractionRuntimeView;
}

export interface MemoryExtractionQuotaView {
  windowStart: number;
  resetAt: number;
  accountUsed: number;
  accountLimit: number;
  globalUsed: number;
  globalLimit: number;
}

export interface MemoryExtractionRuntimeView {
  running: boolean;
  pending: boolean;
  circuitOpen: boolean;
}

/** Read-only selector preview; it never models the full role/worldbook/history prompt. */
export interface MemoryPreviewResult {
  scopeToken: string;
  revision: string;
  generation: number;
  evaluation: MemoryEvaluation;
  budgetBasis: 'memory-only';
  notice: string;
}
