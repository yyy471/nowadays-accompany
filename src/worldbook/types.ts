export type WorldbookEntryPosition = 'before-role' | 'after-role';

export interface WorldbookEntry {
  id: string;
  keys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  caseSensitive: boolean;
  priority: number;
  position: WorldbookEntryPosition;
}

export interface Worldbook {
  version: 1;
  name?: string;
  scanDepth: number;
  budgetChars: number;
  entries: WorldbookEntry[];
}

export interface WorldbookOptions {
  enabled: boolean;
  scanDepth: number;
  budgetChars: number;
}

export interface WorldbookEvaluation {
  beforeRole: string;
  afterRole: string;
  selectedIds: string[];
  skippedIds: string[];
  usedChars: number;
  /** Source scanning or comparison work was limited; this is not a complete search. */
  scanLimited?: boolean;
  /** Entries that did not match because comparison work could not finish. */
  unscannedIds?: string[];
}

export interface WorldbookEvaluationInput {
  currentText: string;
  historyTexts?: string[];
  enabled: boolean;
  scanDepth?: number;
  budgetChars?: number;
}

/** Where a conversation reads its worldbook from. An artifact source is always a fixed revision. */
export type ConversationWorldbookSource =
  | { kind: 'role-card' }
  | { kind: 'artifact'; ref: { source: 'public'; id: string; revision: string } };

/** Resolution status of the effective worldbook for a conversation. */
export type WorldbookResourceState = 'ready' | 'empty' | 'missing' | 'invalid';

export interface EffectiveWorldbook {
  source: ConversationWorldbookSource;
  state: WorldbookResourceState;
  /** Fixed revision when the source is an artifact; the resolved built-in revision is not exposed here. */
  revision?: string;
  name?: string;
  entryCount: number;
  enabledEntryCount: number;
  /** Safe, non-path summary shown when state is missing/invalid. */
  error?: string;
}

export interface WorldbookSettings {
  options: WorldbookOptions;
  source: ConversationWorldbookSource;
}

/** Format detected by the standalone worldbook import adapter. */
export type WorldbookImportFormat = 'native' | 'tavern-array' | 'tavern-object' | 'unknown';

export interface WorldbookImportResult {
  detectedFormat: WorldbookImportFormat;
  worldbook?: Worldbook;
  warnings: string[];
}
