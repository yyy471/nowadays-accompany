import { MEMORY_LIMITS, type MemoryEvaluation, type MemoryRecord } from './types.js';

export const MEMORY_SECTION_TITLE = '## 长期记忆（会话数据）';
/** `buildChatContext` joins system sections with a blank line; the memory increment includes it. */
export const MEMORY_SYSTEM_JOIN_CHARS = 2;

export interface MemorySelectionInput {
  records: readonly MemoryRecord[];
  currentText: string;
  enabled: boolean;
  budgetChars: number;
  maxSelected: number;
}

const empty = (ignoredSummaryCount: number): MemoryEvaluation => ({
  content: '',
  selectedIds: [],
  budgetSkippedIds: [],
  countSkippedIds: [],
  usedChars: 0,
  ...(ignoredSummaryCount > 0 ? { ignoredSummaryCount } : {})
});

/**
 * Pure MEM02 selector shared by the preview API and the agent runtime.
 * It never reads files, clocks, history or providers and never mutates its input.
 */
export function selectMemory(input: MemorySelectionInput): MemoryEvaluation {
  if (!input.enabled || !(input.budgetChars > 0)) return empty(0);

  const facts: MemoryRecord[] = [];
  let ignoredSummaryCount = 0;
  for (const record of input.records) {
    if (record.type === 'summary') {
      ignoredSummaryCount += 1;
      continue;
    }
    if (record.type === 'fact' && record.content.trim()) facts.push(record);
  }
  if (facts.length === 0) return empty(ignoredSummaryCount);

  const candidates = matchRecords(facts, input.currentText);
  const ordered = [...candidates.matched].sort((left, right) =>
    Number(right.pinned) - Number(left.pinned)
    || right.updatedAt - left.updatedAt
    || compareIds(left.id, right.id));

  const selected: MemoryRecord[] = [];
  const budgetSkippedIds: string[] = [];
  const countSkippedIds: string[] = [];
  let usedChars = ordered.length === 0 ? 0 : MEMORY_SYSTEM_JOIN_CHARS + MEMORY_SECTION_TITLE.length;
  for (const record of ordered) {
    if (selected.length >= input.maxSelected) {
      countSkippedIds.push(record.id);
      continue;
    }
    const increment = 1 + entryText(record).length;
    if (usedChars + increment > input.budgetChars) {
      budgetSkippedIds.push(record.id);
      continue;
    }
    usedChars += increment;
    selected.push(record);
  }

  const content = selected.length > 0
    ? `${MEMORY_SECTION_TITLE}\n${selected.map(entryText).join('\n')}`
    : '';
  const evaluation: MemoryEvaluation = {
    content,
    selectedIds: selected.map(record => record.id),
    budgetSkippedIds,
    countSkippedIds,
    usedChars: selected.length > 0 ? usedChars : 0,
    ...(candidates.scanLimited ? { scanLimited: true } : {}),
    ...(candidates.unscannedIds.length > 0 ? { unscannedIds: candidates.unscannedIds } : {}),
    ...(ignoredSummaryCount > 0 ? { ignoredSummaryCount } : {})
  };
  return evaluation;
}

interface MatchResult {
  matched: MemoryRecord[];
  unscannedIds: string[];
  scanLimited: boolean;
}

function matchRecords(facts: readonly MemoryRecord[], currentText: string): MatchResult {
  const matched: MemoryRecord[] = [];
  const unscannedIds: string[] = [];
  const needsScan = facts.some(record => !record.pinned && record.keys.length > 0);
  const truncated = needsScan && currentText.length > MEMORY_LIMITS.scanTailChars;
  const text = needsScan
    ? (truncated ? currentText.slice(-MEMORY_LIMITS.scanTailChars) : currentText).toLowerCase()
    : '';
  // Completed bools are safe to reuse after the work budget is exhausted; unknown keys never are.
  const cache = new Map<string, boolean>();
  let work = 0;
  let exhausted = false;

  for (const record of facts) {
    if (record.pinned) {
      matched.push(record);
      continue;
    }
    if (record.keys.length === 0) continue;
    let hit = false;
    let unknown = false;
    for (const rawKey of record.keys) {
      const key = rawKey.toLowerCase();
      const cached = cache.get(key);
      if (cached === true) {
        hit = true;
        break;
      }
      if (cached === false) continue;
      if (exhausted) {
        // Keep walking this OR so an already-cached true key can still decide the record.
        unknown = true;
        continue;
      }
      const cost = text.length + key.length;
      if (work + cost > MEMORY_LIMITS.matchWorkLimit) {
        exhausted = true;
        unknown = true;
        continue;
      }
      work += cost;
      const found = text.includes(key);
      cache.set(key, found);
      if (found) {
        hit = true;
        break;
      }
    }
    if (hit) matched.push(record);
    else if (unknown) unscannedIds.push(record.id);
  }

  return { matched, unscannedIds, scanLimited: truncated || exhausted };
}

function entryText(record: MemoryRecord): string {
  return record.pinned ? `- [固定] ${record.content}` : `- ${record.content}`;
}

/** Code-unit order so the result does not depend on host locale/ICU. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
