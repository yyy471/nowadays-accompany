import { InvalidSpecError } from '../core/errors.js';
import { isSafeArtifactSegment } from '../artifacts/segment.js';
import type { ConversationWorldbookSource, Worldbook, WorldbookEntry, WorldbookOptions } from './types.js';

export const DEFAULT_WORLDBOOK_OPTIONS: Readonly<WorldbookOptions> = Object.freeze({ enabled: false, scanDepth: 4, budgetChars: 2000 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function safeSegment(value: unknown, label: string): string {
  if (!isSafeArtifactSegment(value)) {
    throw new InvalidSpecError(`${label}只能使用1至64位字母、数字、点、下划线或短横线，且必须是有效名称。`);
  }
  return value;
}

/**
 * Parse a conversation worldbook source. Absent means "role-card built-in"; an artifact
 * source must fix a public revision (no catalog following, no latest). null and unknown
 * shapes are rejected rather than silently treated as built-in.
 */
export function parseConversationWorldbookSource(raw: unknown = undefined): ConversationWorldbookSource {
  if (raw === undefined) return { kind: 'role-card' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidSpecError('世界书来源必须是对象。');
  const value = raw as Record<string, unknown>;
  if (value.kind === 'role-card') {
    exactKeys(value, ['kind'], '世界书来源');
    return { kind: 'role-card' };
  }
  if (value.kind === 'artifact') {
    exactKeys(value, ['kind', 'ref'], '世界书来源');
    const ref = value.ref;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new InvalidSpecError('世界书来源ref必须是对象。');
    const reference = ref as Record<string, unknown>;
    exactKeys(reference, ['source', 'id', 'revision'], '世界书来源ref');
    if (reference.source !== 'public') throw new InvalidSpecError('独立世界书来源当前只支持public。');
    if (typeof reference.revision !== 'string' || !reference.revision) throw new InvalidSpecError('独立世界书来源必须固定revision，不能使用latest或跟随当前。');
    return { kind: 'artifact', ref: { source: 'public', id: safeSegment(reference.id, '世界书id'), revision: safeSegment(reference.revision, '世界书revision') } };
  }
  throw new InvalidSpecError('世界书来源kind必须为role-card或artifact。');
}

/**
 * Parse a single worldbook-settings write. Options always apply; an omitted source means
 * "keep the currently stored source", so legacy clients that only send options do not
 * silently reset an independent book back to the built-in one.
 */
export function parseWorldbookSettings(raw: unknown): { options: WorldbookOptions; source?: ConversationWorldbookSource } {
  const value = raw === undefined ? {} : object(raw, '世界书设置');
  exactKeys(value, ['worldbook', 'source'], '世界书设置');
  const options = parseWorldbookOptions(value.worldbook);
  const source = value.source === undefined ? undefined : parseConversationWorldbookSource(value.source);
  return { options, ...(source ? { source } : {}) };
}

/** Disk-free view of an already-resolved book: state and entry counts for列表/详情契约. */
export function summarizeWorldbook(book: Worldbook): { entryCount: number; enabledEntryCount: number; state: 'ready' | 'empty' } {
  const enabledEntryCount = book.entries.reduce((sum, entry) => sum + Number(entry.enabled), 0);
  return { entryCount: book.entries.length, enabledEntryCount, state: enabledEntryCount === 0 ? 'empty' : 'ready' };
}

function object(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidSpecError(`${label}必须是对象。`);
  return raw as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new InvalidSpecError(`${label}不支持字段${unknown}。`);
}
function integer(raw: unknown, fallback: number, max: number, label: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > max) throw new InvalidSpecError(`${label}必须为0至${max}的整数。`);
  return raw;
}
function boolean(raw: unknown, fallback: boolean, label: string): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') throw new InvalidSpecError(`${label}必须是布尔值。`);
  return raw;
}

export function parseWorldbookOptions(raw: unknown = undefined): WorldbookOptions {
  const value = raw === undefined ? {} : object(raw, '世界书选项');
  exactKeys(value, ['enabled', 'scanDepth', 'budgetChars'], '世界书选项');
  return {
    enabled: boolean(value.enabled, DEFAULT_WORLDBOOK_OPTIONS.enabled, 'enabled'),
    scanDepth: integer(value.scanDepth, DEFAULT_WORLDBOOK_OPTIONS.scanDepth, 20, 'scanDepth'),
    budgetChars: integer(value.budgetChars, DEFAULT_WORLDBOOK_OPTIONS.budgetChars, 8000, 'budgetChars')
  };
}

export function parseWorldbook(raw: unknown): Worldbook {
  const value = object(raw, '世界书');
  exactKeys(value, ['version', 'name', 'scanDepth', 'budgetChars', 'entries'], '世界书');
  if (value.version !== 1) throw new InvalidSpecError('世界书version必须为1。');
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 16384)) throw new InvalidSpecError('世界书name必须是不超过16384字符的文本。');
  if (!Array.isArray(value.entries) || value.entries.length > 200) throw new InvalidSpecError('世界书entries必须是最多200项的数组。');
  const seen = new Set<string>();
  let textLength = typeof value.name === 'string' ? value.name.length : 0;
  const entries: WorldbookEntry[] = value.entries.map((rawEntry: unknown, index: number) => {
    const entry = object(rawEntry, `世界书条目${index + 1}`);
    exactKeys(entry, ['id', 'keys', 'content', 'enabled', 'constant', 'caseSensitive', 'priority', 'position'], `世界书条目${index + 1}`);
    if (typeof entry.id !== 'string' || !ID.test(entry.id) || seen.has(entry.id)) throw new InvalidSpecError('世界书条目id必须是唯一的1至64位安全标识。');
    seen.add(entry.id);
    if (typeof entry.content !== 'string' || entry.content.length > 8192) throw new InvalidSpecError(`世界书条目${entry.id}的content必须是不超过8192字符的文本。`);
    const keys = entry.keys === undefined ? [] : entry.keys;
    if (!Array.isArray(keys) || keys.length > 32 || keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 256)) throw new InvalidSpecError(`世界书条目${entry.id}最多32个关键词，每个必须为1至256字符的非空文本。`);
    const priority = entry.priority === undefined ? 0 : entry.priority;
    if (typeof priority !== 'number' || !Number.isFinite(priority) || priority < -1000 || priority > 1000) throw new InvalidSpecError(`世界书条目${entry.id}的priority必须在-1000至1000之间。`);
    const position = entry.position === undefined ? 'after-role' : entry.position;
    if (position !== 'before-role' && position !== 'after-role') throw new InvalidSpecError(`世界书条目${entry.id}的position必须为before-role或after-role。`);
    textLength += entry.id.length + entry.content.length + (keys as string[]).reduce((sum, key) => sum + key.length, 0);
    return {
      id: entry.id, keys: [...keys] as string[], content: entry.content,
      enabled: boolean(entry.enabled, true, 'entry.enabled'), constant: boolean(entry.constant, false, 'entry.constant'),
      caseSensitive: boolean(entry.caseSensitive, false, 'entry.caseSensitive'), priority, position
    };
  });
  if (textLength > 200000) throw new InvalidSpecError('世界书总文本不能超过200000字符。');
  return {
    version: 1, ...(value.name !== undefined ? { name: value.name as string } : {}),
    scanDepth: integer(value.scanDepth, DEFAULT_WORLDBOOK_OPTIONS.scanDepth, 20, 'scanDepth'),
    budgetChars: integer(value.budgetChars, DEFAULT_WORLDBOOK_OPTIONS.budgetChars, 8000, 'budgetChars'), entries
  };
}
