import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { DEFAULT_WORLDBOOK_OPTIONS, parseWorldbook, parseWorldbookOptions } from '../src/worldbook/schema.js';
import { evaluateWorldbook } from '../src/worldbook/matcher.js';
import { convertTavernWorldbook } from '../src/worldbook/tavern.js';

const entry = (id: string, options: Record<string, unknown> = {}) => ({ id, keys: ['cat'], content: id, ...options });
const book = (entries: unknown[], options: Record<string, unknown> = {}) => parseWorldbook({ version: 1, entries, ...options });
const run = (entries: unknown[], options: Record<string, unknown> = {}) => evaluateWorldbook(book(entries), { currentText: 'cat', enabled: true, ...options });

describe('normalized worldbook schema', () => {
  it('normalizes defaults without mutating or sharing caller arrays', () => {
    const raw = { version: 1, entries: [entry('a')] }; const before = structuredClone(raw);
    const parsed = parseWorldbook(raw);
    expect(parsed).toEqual({ version: 1, scanDepth: 4, budgetChars: 2000, entries: [{ id: 'a', keys: ['cat'], content: 'a', enabled: true, constant: false, caseSensitive: false, priority: 0, position: 'after-role' }] });
    expect(raw).toEqual(before); parsed.entries[0]!.keys.push('changed'); expect(raw).toEqual(before);
    expect(parseWorldbookOptions()).toEqual({ enabled: false, scanDepth: 4, budgetChars: 2000 });
    const options = { enabled: true, scanDepth: 0, budgetChars: 0 }; const parsedOptions = parseWorldbookOptions(options);
    expect(parsedOptions).toEqual(options); expect(parsedOptions).not.toBe(options); expect(DEFAULT_WORLDBOOK_OPTIONS.enabled).toBe(false);
  });
  it('accepts exact range limits, empty books and constant entries without keys', () => {
    expect(book([], { scanDepth: 20, budgetChars: 8000 }).entries).toEqual([]);
    expect(book([{ id: 'z', content: '', constant: true, priority: -1000 }, entry('a', { priority: 1000, keys: ['x'.repeat(256)], content: 'x'.repeat(8192) })]).entries).toHaveLength(2);
    expect(book(Array.from({ length: 200 }, (_, index) => entry(`e${index}`, { keys: Array.from({ length: 32 }, () => 'x') })))).toBeDefined();
  });
  it.each([null, [], {}, { version: 2, entries: [] }, { version: 1, entries: {}, extra: true }, { version: 1, entries: [], extra: true },
    { version: 1, entries: [], name: 3 }, { version: 1, entries: [], name: 'n'.repeat(16385) }, { version: 1, entries: Array.from({ length: 201 }, (_, index) => entry(`e${index}`)) }
  ])('rejects invalid book %j', raw => { expect(() => parseWorldbook(raw)).toThrow(); });
  it.each([
    { id: '' }, { id: '../escape' }, { id: 'x'.repeat(65) }, { content: null }, { content: 'x'.repeat(8193) },
    { keys: [''] }, { keys: ['  '] }, { keys: [null] }, { keys: ['x'.repeat(257)] }, { keys: Array(33).fill('key') }, { keys: 'cat' },
    { enabled: 1 }, { constant: 'true' }, { caseSensitive: null }, { priority: null }, { priority: Infinity }, { priority: -1001 }, { priority: 1001 },
    { position: 'at-depth' }, { script: 'code' }
  ])('rejects invalid entry %j', overrides => { expect(() => book([entry('a', overrides)])).toThrow(); });
  it('rejects duplicate ids and oversized total text even if individual entries fit', () => {
    expect(() => book([entry('a'), entry('a')])).toThrow('id');
    expect(() => book(Array.from({ length: 25 }, (_, index) => entry(`e${index}`, { content: 'x'.repeat(8192) })))).toThrow('200000');
  });
  it.each([{ scanDepth: -1 }, { scanDepth: 21 }, { scanDepth: 1.5 }, { scanDepth: '4' }, { scanDepth: null }, { budgetChars: -1 }, { budgetChars: 8001 }, { budgetChars: 0.5 }, { enabled: 'false' }, { enabled: null }, { extra: true }, null])('strictly rejects invalid options %j', value => {
    expect(() => parseWorldbookOptions(value)).toThrow();
  });
});

describe('one-pass literal matching and budgets', () => {
  it('defaults off at caller options and skips disabled and nonmatching entries', () => {
    const normalized = book([entry('a', { constant: true })]);
    expect(evaluateWorldbook(normalized, { currentText: 'anything', ...parseWorldbookOptions() })).toEqual({ beforeRole: '', afterRole: '', selectedIds: [], skippedIds: [], usedChars: 0 });
    expect(run([entry('disabled', { enabled: false, constant: true }), entry('none', { keys: ['dog'] })]).selectedIds).toEqual([]);
    expect(run([entry('none', { keys: [] })]).selectedIds).toEqual([]);
  });
  it('uses OR and literal substrings with case-sensitive control, never regex or macro expansion', () => {
    expect(run([entry('or', { keys: ['dog', 'CAT'] }), entry('case', { keys: ['CAT'], caseSensitive: true }), entry('regex', { keys: ['.*'] }), entry('macro', { keys: ['{{user}}'] })]).selectedIds).toEqual(['or']);
    expect(run([entry('regex', { keys: ['.*'] }), entry('macro', { keys: ['{{user}}'] })], { currentText: 'literal .* {{user}}' }).selectedIds).toEqual(['regex', 'macro']);
  });
  it('scans the current message plus only the most recent N history messages', () => {
    const entries = [entry('current'), entry('old', { keys: ['old'] }), entry('recent', { keys: ['recent'] }), entry('cross', { keys: ['old\nrecent'] })];
    expect(run(entries, { historyTexts: ['old', 'recent'], scanDepth: 1 }).selectedIds).toEqual(['current', 'recent']);
    expect(run(entries, { historyTexts: ['old', 'recent'], scanDepth: 0 }).selectedIds).toEqual(['current']);
    expect(run(entries, { historyTexts: ['old', 'recent'], scanDepth: 2 }).selectedIds).toEqual(['current', 'old', 'recent']);
  });
  it('honors constants but never recursively triggers from selected content', () => {
    const result = run([entry('first', { content: 'dog' }), entry('second', { keys: ['dog'] }), entry('constant', { keys: [], constant: true })]);
    expect(result.selectedIds).toEqual(['first', 'constant']); expect(result.skippedIds).toEqual([]);
  });
  it('orders priorities descending with stable source ties, without modifying book entries', () => {
    const normalized = book([entry('a', { priority: -2 }), entry('b', { priority: 4 }), entry('c', { priority: 4 }), entry('d', { priority: 0.5 })]);
    const before = structuredClone(normalized);
    expect(evaluateWorldbook(normalized, { currentText: 'cat', enabled: true }).selectedIds).toEqual(['b', 'c', 'd', 'a']);
    expect(normalized).toEqual(before);
  });
  it('counts headers, content separators and two caller separator characters per section exactly', () => {
    const result = run([entry('a', { content: 'A', position: 'before-role' }), entry('b', { content: 'B', position: 'before-role' }), entry('c', { content: 'C', position: 'after-role' })]);
    expect(result.beforeRole).toBe('## 世界书（角色前）\nA\n\nB'); expect(result.afterRole).toBe('## 世界书（角色后）\nC');
    expect(result.usedChars).toBe(result.beforeRole.length + result.afterRole.length + 4);
    expect(run([entry('a', { content: 'A', position: 'before-role' }), entry('b', { content: 'B', position: 'before-role' }), entry('c', { content: 'C', position: 'after-role' })], { budgetChars: result.usedChars }).selectedIds).toEqual(['a', 'b', 'c']);
    expect(run([entry('a', { content: 'A', position: 'before-role' }), entry('b', { content: 'B', position: 'before-role' }), entry('c', { content: 'C', position: 'after-role' })], { budgetChars: result.usedChars - 1 }).selectedIds).toEqual(['a', 'b']);
  });
  it('skips whole oversized entries and continues to later entries instead of truncating', () => {
    const result = run([entry('large', { content: 'x'.repeat(8192), priority: 100 }), entry('small', { content: 'ok' }), entry('unmatched', { keys: ['dog'] })], { budgetChars: 8000 });
    expect(result.selectedIds).toEqual(['small']); expect(result.skippedIds).toEqual(['large']); expect(result.afterRole).toContain('ok'); expect(result.afterRole).not.toContain('xxxx');
    expect(run([entry('zero')], { budgetChars: 0 })).toMatchObject({ beforeRole: '', afterRole: '', selectedIds: [], skippedIds: [], usedChars: 0 });
  });
  it('uses book defaults unless explicitly overridden and enforces override bounds', () => {
    const normalized = book([entry('old', { keys: ['history'] })], { scanDepth: 0, budgetChars: 0 });
    expect(evaluateWorldbook(normalized, { currentText: '', historyTexts: ['history'], enabled: true }).selectedIds).toEqual([]);
    expect(evaluateWorldbook(normalized, { currentText: '', historyTexts: ['history'], enabled: true, scanDepth: 1, budgetChars: 100 }).selectedIds).toEqual(['old']);
    expect(() => evaluateWorldbook(normalized, { currentText: '', enabled: true, budgetChars: 8001 })).toThrow();
  });
});

describe('bounded worldbook scanning and comparison work', () => {
  const expensiveEntries = (count: number) => Array.from({ length: count }, (_, index) => entry(`expensive-${index}`, {
    keys: Array.from({ length: 32 }, (_, keyIndex) => `${'a'.repeat(20)}${String(index * 32 + keyIndex).padStart(9, '0')}b`),
    content: 'LORE', priority: 500
  }));
  it('prioritizes current-text tails, then newest history tails, and reports character truncation', () => {
    const normalized = book([entry('current-prefix', { keys: ['PREFIX'] }), entry('current-tail', { keys: ['TAIL'] }), entry('recent-prefix', { keys: ['HIDDEN'] }), entry('recent-tail', { keys: ['RECENT'] }), entry('old', { keys: ['OLD'] })]);
    const result = evaluateWorldbook(normalized, { enabled: true, currentText: `${'x'.repeat(9996)}TAIL`, historyTexts: ['OLD', `HIDDEN${'x'.repeat(5994)}RECENT`], scanDepth: 2 });
    expect(result.selectedIds).toEqual(['current-tail', 'recent-tail']); expect(result.scanLimited).toBe(true); expect(result.unscannedIds).toBeUndefined();
    const currentOnly = evaluateWorldbook(normalized, { enabled: true, currentText: `PREFIX${'x'.repeat(16000)}TAIL`, historyTexts: ['OLD'], scanDepth: 0 });
    expect(currentOnly.selectedIds).toEqual(['current-tail']); expect(currentOnly.scanLimited).toBe(true);
    const untruncated = evaluateWorldbook(normalized, { enabled: true, currentText: 'TAIL', historyTexts: ['OLD'], scanDepth: 0 });
    expect(untruncated).not.toHaveProperty('scanLimited'); expect(untruncated).not.toHaveProperty('unscannedIds'); expect(untruncated.selectedIds).toEqual(['current-tail']);
  });
  it('finishes a legal maximum-size scan in under one second and labels unfinished matches', () => {
    const normalized = book(expensiveEntries(200));
    const input = { currentText: 'a'.repeat(256 * 1024), historyTexts: Array(20).fill('a'.repeat(256 * 1024)) as string[], enabled: true, scanDepth: 20, budgetChars: 2000 };
    const started = performance.now(); const result = evaluateWorldbook(normalized, input); const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000); expect(result.selectedIds).toEqual([]); expect(result.skippedIds).toEqual([]);
    expect(result.scanLimited).toBe(true); expect(result.unscannedIds!.length).toBeGreaterThan(0); expect(result.unscannedIds).toContain('expensive-199');
  });
  it('keeps constants and cached OR hits eligible after work exhaustion, without caching unknown false', () => {
    const normalized = book([
      entry('warm-hit', { keys: ['SENTINEL'], priority: 1000 }), entry('warm-miss', { keys: ['WARM_MISS'], priority: 999 }),
      ...expensiveEntries(193),
      entry('cached-hit', { keys: ['new-key-after-exhaustion', 'sentinel'], priority: 0 }),
      entry('cached-false', { keys: ['warm_miss'], priority: 0 }),
      entry('still-unknown', { keys: ['new-key-after-exhaustion'], priority: 0 }),
      entry('sensitive-not-cached', { keys: ['SENTINEL'], caseSensitive: true, priority: 0 }),
      entry('constant', { keys: [], constant: true, content: 'new-key-after-exhaustion', priority: -1 })
    ]);
    const result = evaluateWorldbook(normalized, { currentText: `${'a'.repeat(15992)}SENTINEL`, enabled: true });
    expect(result.scanLimited).toBe(true); expect(result.selectedIds).toEqual(['warm-hit', 'cached-hit', 'constant']);
    expect(result.unscannedIds).toContain('still-unknown'); expect(result.unscannedIds).toContain('sensitive-not-cached');
    expect(result.unscannedIds).not.toContain('cached-hit'); expect(result.unscannedIds).not.toContain('cached-false');
    expect(result.usedChars).toBe(result.afterRole.length + 2); expect(result.usedChars).toBeLessThanOrEqual(2000);
  });
  it('caches repeated normalized keywords so duplicate schema-valid entries can complete cheaply', () => {
    const normalized = book(Array.from({ length: 200 }, (_, index) => entry(`e${index}`, { keys: Array(32).fill(index % 2 ? 'ABSENT' : 'absent') })));
    const result = evaluateWorldbook(normalized, { currentText: 'a'.repeat(16000), enabled: true });
    expect(result).toEqual({ beforeRole: '', afterRole: '', selectedIds: [], skippedIds: [], usedChars: 0 });
  });
  it('returns immediately for zero budget or no enabled entries without reading scan text', () => {
    const input = { enabled: true, currentText: 'unused', historyTexts: [] as string[] };
    Object.defineProperty(input, 'currentText', { get() { throw new Error('scan text should not be touched'); } });
    const started = performance.now();
    expect(evaluateWorldbook(book(expensiveEntries(200)), { ...{ enabled: input.enabled }, get currentText() { return input.currentText; }, budgetChars: 0 })).toEqual({ beforeRole: '', afterRole: '', selectedIds: [], skippedIds: [], usedChars: 0 });
    expect(evaluateWorldbook(book([entry('disabled', { enabled: false })]), input).selectedIds).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('Tavern character_book subset conversion', () => {
  it('converts numeric ids, literal keys, positions and insertion ordering without clamping source values', () => {
    const raw = { name: 'World', scan_depth: 2, token_budget: 999, entries: [
      { id: 3, keys: ['CAT'], content: 'third', enabled: true, insertion_order: 1000000, position: 'after_char' },
      { id: 1, keys: [], constant: true, content: 'first', insertion_order: -1000000, position: 'before_char' },
      { id: 2, keys: ['cat'], content: 'second', case_sensitive: true, insertion_order: 0, position: 'after_char' }
    ] };
    const before = structuredClone(raw); const converted = convertTavernWorldbook(raw);
    expect(converted.worldbook).toMatchObject({ version: 1, name: 'World', scanDepth: 2, budgetChars: 2000 });
    expect(converted.warnings.join(' ')).toContain('token_budget');
    expect(evaluateWorldbook(converted.worldbook!, { currentText: 'cat', enabled: true }).selectedIds).toEqual(['entry-1', 'entry-2', 'entry-3']);
    expect(converted.worldbook!.entries[0]!.position).toBe('after-role'); expect(converted.worldbook!.entries[1]!.position).toBe('before-role'); expect(raw).toEqual(before);
  });
  it('preserves equal insertion_order source ordering and deterministically repairs duplicate ids', () => {
    const raw = { entries: [{ id: 'same', keys: [], content: 'one', constant: true, insertion_order: 2 }, { id: 'same', keys: [], content: 'two', constant: true, insertion_order: 2 }, { id: -4, content: 'three', constant: true }] };
    const converted = convertTavernWorldbook(raw); expect(converted.worldbook!.entries.map(item => item.id)).toEqual(['same', 'same-2', 'entry-n4']);
    expect(evaluateWorldbook(converted.worldbook!, { currentText: '', enabled: true }).selectedIds).toEqual(['same', 'same-2', 'entry-n4']);
    expect(convertTavernWorldbook(raw)).toEqual(converted);
  });
  it.each([{ selective: true }, { use_regex: true }, { probability: 50 }, { extensions: { probability: 100 } }, { extensions: { useProbability: true } },
    { recursive: true }, { extensions: { prevent_recursion: true } }, { extensions: { depth: 4 } }, { extensions: { position: 0 } }, { position: 'at_depth' }
  ])('disables unsupported entry features instead of turning them into always-on content: %j', feature => {
    const converted = convertTavernWorldbook({ entries: [{ id: 1, keys: ['cat'], content: 'MUST_NOT_APPEAR', constant: true, ...feature }] });
    expect(converted.worldbook!.entries[0]!.enabled).toBe(false); expect(converted.warnings.join(' ')).toContain('禁用');
    expect(evaluateWorldbook(converted.worldbook!, { currentText: 'cat', enabled: true }).selectedIds).toEqual([]);
  });
  it('disables recursively configured books and never loses a source disabled flag', () => {
    const recursive = convertTavernWorldbook({ recursive_scanning: true, entries: [{ content: 'one', constant: true }] });
    expect(recursive.worldbook!.entries[0]!.enabled).toBe(false);
    const disabled = convertTavernWorldbook({ entries: [{ content: 'one', constant: true, enabled: false }] });
    expect(disabled.worldbook!.entries[0]!.enabled).toBe(false);
  });
  it('skips invalid entries and disables nonconstant entries without keys while preserving valid ones', () => {
    const converted = convertTavernWorldbook({ entries: [null, { content: 4 }, { content: 'bad', keys: [4] }, { content: 'bad', enabled: 'true' }, { content: 'no keys' }, { id: '../invalid', content: 'valid', constant: true, unknown: { ignored: true } }] });
    expect(converted.worldbook!.entries).toHaveLength(2); expect(converted.worldbook!.entries[0]!.enabled).toBe(false);
    expect(converted.worldbook!.entries[1]!.id).toBe('entry-6'); expect(converted.warnings.join(' ')).toContain('归档');
  });
  it.each([null, [], {}, { entries: {} }, { scan_depth: 21, entries: [] }, { name: 1, entries: [] }, { recursive_scanning: 'true', entries: [] },
    { entries: Array.from({ length: 201 }, () => ({ content: 'a', constant: true })) },
    { entries: Array.from({ length: 25 }, () => ({ content: 'a'.repeat(8192), constant: true })) }
  ])('returns warnings rather than throwing for bad books: %j', value => {
    const result = convertTavernWorldbook(value); expect(result.worldbook).toBeUndefined(); expect(result.warnings.length).toBeGreaterThan(0);
  });
  it('treats missing optional worldbooks as absent', () => { expect(convertTavernWorldbook(undefined)).toEqual({ warnings: [] }); });
});
