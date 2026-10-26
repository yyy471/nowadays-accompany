import { InvalidSpecError } from '../core/errors.js';
import { parseWorldbookOptions } from './schema.js';
import type { Worldbook, WorldbookEvaluation, WorldbookEvaluationInput } from './types.js';

const HEADERS = { 'before-role': '## 世界书（角色前）\n', 'after-role': '## 世界书（角色后）\n' } as const;
const MAX_SCAN_CHARS = 16000;
const MAX_COMPARISON_WORK = 8_000_000;

/** A single literal matching pass. Selected content never becomes a new matching source. */
export function evaluateWorldbook(book: Worldbook, input: WorldbookEvaluationInput): WorldbookEvaluation {
  const result: WorldbookEvaluation = { beforeRole: '', afterRole: '', selectedIds: [], skippedIds: [], usedChars: 0 };
  const options = parseWorldbookOptions({ enabled: input.enabled, scanDepth: input.scanDepth === undefined ? book.scanDepth : input.scanDepth, budgetChars: input.budgetChars === undefined ? book.budgetChars : input.budgetChars });
  if (!options.enabled || options.budgetChars === 0 || !book.entries.some(entry => entry.enabled)) return result;
  if (typeof input.currentText !== 'string' || (input.historyTexts !== undefined && !Array.isArray(input.historyTexts))) throw new InvalidSpecError('世界书扫描内容必须是文本。');
  let remainingChars = MAX_SCAN_CHARS;
  let scanLimited = false;
  const texts: string[] = [];
  const appendTail = (text: string): void => {
    if (typeof text !== 'string') throw new InvalidSpecError('世界书扫描内容必须是文本。');
    if (text.length > remainingChars) scanLimited = true;
    const taken = Math.min(text.length, remainingChars);
    if (taken > 0) texts.push(text.slice(-taken));
    remainingChars -= taken;
  };
  appendTail(input.currentText);
  const history = input.historyTexts ?? [];
  for (let index = history.length - 1, depth = 0; index >= 0 && depth < options.scanDepth; index--, depth++) appendTail(history[index]!);
  const insensitiveTexts = texts.map(text => text.toLowerCase());
  const cache = new Map<string, boolean>();
  let comparisonWork = 0, workExhausted = false;
  const matchKey = (key: string, caseSensitive: boolean): boolean | undefined => {
    const normalized = caseSensitive ? key : key.toLowerCase();
    const cacheKey = `${caseSensitive ? 's' : 'i'}\0${normalized}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (workExhausted) return undefined;
    const sources = caseSensitive ? texts : insensitiveTexts;
    for (const text of sources) {
      const cost = text.length + normalized.length;
      if (comparisonWork + cost > MAX_COMPARISON_WORK) { workExhausted = true; scanLimited = true; return undefined; }
      comparisonWork += cost;
      if (text.includes(normalized)) { cache.set(cacheKey, true); return true; }
    }
    cache.set(cacheKey, false);
    return false;
  };
  const unscannedIds: string[] = [];
  const candidates = book.entries.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry.priority - a.entry.priority || a.index - b.index);
  for (const { entry } of candidates) {
    if (!entry.enabled) continue;
    let matched = entry.constant, unknown = false;
    if (!matched) {
      for (const key of entry.keys) {
        if (!key.length) continue;
        const found = matchKey(key, entry.caseSensitive);
        if (found === true) { matched = true; break; }
        if (found === undefined) unknown = true;
      }
    }
    if (!matched) { if (unknown) unscannedIds.push(entry.id); continue; }
    const section = entry.position === 'before-role' ? 'beforeRole' : 'afterRole';
    const addition = result[section] ? `\n\n${entry.content}` : `${HEADERS[entry.position]}${entry.content}`;
    const cost = addition.length + (result[section] ? 0 : 2);
    if (result.usedChars + cost > options.budgetChars) { result.skippedIds.push(entry.id); continue; }
    result[section] += addition; result.usedChars += cost; result.selectedIds.push(entry.id);
  }
  if (scanLimited) result.scanLimited = true;
  if (unscannedIds.length) result.unscannedIds = unscannedIds;
  return result;
}
