import type { Worldbook, WorldbookEntry, WorldbookEntryPosition } from '../../../../src/worldbook/types.js';

export const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorldbookEditorSeed {
  mode: 'create' | 'derive' | 'copy';
  id: string;
  revision: string;
  name: string;
  description?: string;
  worldbook: Worldbook;
  base?: { id: string; revision: string; fingerprint: string };
}

export interface WorldbookDraft {
  id: string;
  revision: string;
  name: string;
  worldbook: Worldbook;
}

export interface WorldbookDraftErrors {
  [field: string]: string;
}

export function blankWorldbook(): Worldbook {
  return { version: 1, scanDepth: 4, budgetChars: 2000, entries: [] };
}

export function cloneWorldbook(book: Worldbook): Worldbook {
  return JSON.parse(JSON.stringify(book)) as Worldbook;
}

export function draftFromSeed(seed: WorldbookEditorSeed): WorldbookDraft {
  return { id: seed.id, revision: seed.revision, name: seed.name, worldbook: cloneWorldbook(seed.worldbook) };
}

/** Suggest a new revision without ever reusing an existing one. */
export function nextRevision(revisions: string[]): string {
  const existing = new Set(revisions);
  let highest = 0;
  for (const revision of revisions) {
    const match = /^r(\d{1,9})$/.exec(revision);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  let candidate = `r${highest + 1}`;
  for (let index = 2; existing.has(candidate); index += 1) candidate = `r${highest + index}`;
  return candidate;
}

/** Derive a unique copy id while preserving the suffix within the 64-character limit. */
export function duplicateSegmentId(source: string, existing: Iterable<string>, suffix = '-copy'): string {
  const ids = new Set(existing);
  const build = (tail: string): string => `${source.slice(0, 64 - suffix.length - tail.length)}${suffix}${tail}`;
  let candidate = build('');
  if (!ids.has(candidate)) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    candidate = build(`-${index}`);
    if (!ids.has(candidate)) return candidate;
  }
  return build(`-${Date.now().toString(36)}`);
}

export function duplicateEntryId(source: string, existing: Iterable<string>): string {
  return duplicateSegmentId(source, existing);
}

export function copyBookId(source: string, existing: Iterable<string>): string {
  return duplicateSegmentId(source, existing);
}

export function newEntry(existing: Iterable<string>): WorldbookEntry {
  const ids = new Set(existing);
  let id = 'entry';
  for (let index = 2; ids.has(id); index += 1) id = `entry-${index}`;
  return { id, keys: [], content: '', enabled: false, constant: false, caseSensitive: false, priority: 0, position: 'after-role' };
}

export function duplicateEntry(entry: WorldbookEntry, existing: Iterable<string>): WorldbookEntry {
  return { ...entry, keys: [...entry.keys], id: duplicateEntryId(entry.id, existing) };
}

export function parseKeys(raw: string): string[] {
  return raw.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
}

export function entryTextLength(entry: WorldbookEntry): number {
  return entry.id.length + entry.content.length + entry.keys.reduce((sum, key) => sum + key.length, 0);
}

/** Mirrors the domain schema so the editor can locate errors before the server sees them. */
export function validateWorldbookDraft(draft: WorldbookDraft): WorldbookDraftErrors {
  const errors: WorldbookDraftErrors = {};
  if (!SEGMENT_PATTERN.test(draft.id)) errors.id = '世界书 id 只能使用 1–64 位字母、数字、点、下划线或短横线。';
  if (!SEGMENT_PATTERN.test(draft.revision)) errors.revision = '版本号只能使用 1–64 位字母、数字、点、下划线或短横线。';
  if (draft.name.length > 16384) errors.name = '名称不能超过 16384 字符。';
  const book = draft.worldbook;
  if (!Number.isInteger(book.scanDepth) || book.scanDepth < 0 || book.scanDepth > 20) errors.scanDepth = '扫描历史条数必须是 0–20 的整数。';
  if (!Number.isInteger(book.budgetChars) || book.budgetChars < 0 || book.budgetChars > 8000) errors.budgetChars = '注入预算必须是 0–8000 的整数。';
  if (book.entries.length > 200) errors.entries = '条目不能超过 200 个。';
  const seen = new Set<string>();
  let total = draft.name.length;
  book.entries.forEach((entry, index) => {
    const idKey = `entry:${index}:id`, contentKey = `entry:${index}:content`, keysKey = `entry:${index}:keys`, priorityKey = `entry:${index}:priority`;
    if (!ENTRY_ID_PATTERN.test(entry.id)) errors[idKey] = '条目 id 必须是 1–64 位安全标识。';
    else if (seen.has(entry.id)) errors[idKey] = '条目 id 必须唯一。';
    seen.add(entry.id);
    if (entry.content.length > 8192) errors[contentKey] = '正文不能超过 8192 字符。';
    if (entry.keys.length > 32) errors[keysKey] = '关键词不能超过 32 个。';
    else if (entry.keys.some(key => !key.trim() || key.length > 256)) errors[keysKey] = '关键词必须是 1–256 字符的非空文本。';
    else if (entry.enabled && !entry.constant && entry.keys.length === 0) errors[keysKey] = '启用且非常驻的条目至少需要一个关键词。';
    if (!Number.isFinite(entry.priority) || entry.priority < -1000 || entry.priority > 1000) errors[priorityKey] = '优先级必须是 -1000 至 1000 的数字。';
    total += entryTextLength(entry);
  });
  if (total > 200000) errors.entries = '世界书总文本不能超过 200000 字符。';
  return errors;
}

export function draftIsDirty(draft: WorldbookDraft, baseline: { id: string; revision: string; name: string; worldbook: Worldbook }): boolean {
  return JSON.stringify(draft) !== JSON.stringify({ id: baseline.id, revision: baseline.revision, name: baseline.name, worldbook: baseline.worldbook });
}

export function revisionConflict(draft: WorldbookDraft, base?: { revision: string }): boolean {
  return Boolean(base && draft.revision === base.revision);
}

export function requestId(): string {
  const value = globalThis.crypto?.randomUUID?.();
  return value ?? `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export const POSITION_LABELS: Record<WorldbookEntryPosition, string> = {
  'before-role': '角色前',
  'after-role': '角色后'
};

export const POSITIONS: WorldbookEntryPosition[] = ['before-role', 'after-role'];
