import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertWorldbookImport } from '../src/worldbook/import-adapter.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`fixtures/worldbook/${name}.json`, import.meta.url), 'utf8'));

describe('standalone worldbook import adapter', () => {
  it('reads a native manifest and normalizes its book', () => {
    const result = convertWorldbookImport(fixture('native-manifest'));
    expect(result.detectedFormat).toBe('native');
    expect(result.warnings).toEqual([]);
    expect(result.worldbook?.entries.map((entry) => entry.id)).toEqual(['garden', 'weather']);
    expect(result.worldbook?.entries.find((entry) => entry.id === 'weather')?.constant).toBe(true);
  });

  it('reads a bare version-1 book as native', () => {
    const result = convertWorldbookImport({ version: 1, entries: [{ id: 'a', keys: ['x'], content: 'x' }] });
    expect(result.detectedFormat).toBe('native');
    expect(result.worldbook?.entries).toHaveLength(1);
  });

  it('converts a tavern entries array preserving ids, positions and constants', () => {
    const result = convertWorldbookImport(fixture('tavern-array'));
    expect(result.detectedFormat).toBe('tavern-array');
    expect(result.warnings).toEqual([]);
    const book = result.worldbook!;
    expect(book.entries.map((entry) => entry.id).sort()).toEqual(['entry-0', 'entry-2', 'role']);
    const role = book.entries.find((entry) => entry.id === 'role')!;
    expect(role.constant).toBe(true);
    expect(role.position).toBe('before-role');
    expect(book.entries.every((entry) => entry.enabled)).toBe(true);
  });

  it('orders a tavern entries object by explicit numeric key, not enumeration order', () => {
    const result = convertWorldbookImport(fixture('tavern-object'));
    expect(result.detectedFormat).toBe('tavern-object');
    expect(result.warnings).toEqual([]);
    const ids = result.worldbook!.entries.map((entry) => entry.id);
    expect([...ids].sort((left, right) => Number(left) - Number(right))).toEqual([1, 2, 10].map(String));
    expect(result.worldbook!.entries.find((entry) => entry.id === '1')?.position).toBe('before-role');
  });

  it('warns when object keys are not numeric and applies a stable order', () => {
    const result = convertWorldbookImport({ entries: { b: { keys: ['k'], content: 'B' }, a: { keys: ['k'], content: 'A' } } });
    expect(result.detectedFormat).toBe('tavern-object');
    expect(result.warnings.some((warning) => warning.includes('稳定'))).toBe(true);
    expect(result.worldbook!.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('disables unsupported rules and warns without guessing them into constants (D06)', () => {
    const result = convertWorldbookImport(fixture('tavern-unsupported'));
    expect(result.detectedFormat).toBe('tavern-object');
    const book = result.worldbook!;
    expect(book.entries.every((entry) => !entry.enabled)).toBe(true);
    expect(book.entries.every((entry) => !entry.constant)).toBe(true);
    const joined = result.warnings.join('；');
    expect(joined).toContain('递归');
    expect(joined).toContain('正则');
    expect(joined).toContain('selective');
    expect(joined).toContain('概率');
  });

  it('rejects unknown shapes instead of guessing a role card (D07)', () => {
    expect(convertWorldbookImport({}).detectedFormat).toBe('unknown');
    expect(convertWorldbookImport('nope').detectedFormat).toBe('unknown');
    expect(convertWorldbookImport({ entries: 123 }).detectedFormat).toBe('unknown');
    expect(convertWorldbookImport({ version: 2, entries: [] }).detectedFormat).toBe('unknown');
    const roleCard = convertWorldbookImport({ name: '卡', description: '含角色字段但无entries' });
    expect(roleCard.detectedFormat).toBe('unknown');
    expect(roleCard.worldbook).toBeUndefined();
  });

  it('runs native manifests through strict validation and rejects stray outer fields (D02/D03/R4)', () => {
    const missing = convertWorldbookImport({ kind: 'worldbook', id: 'x', revision: 'r1' });
    expect(missing.detectedFormat).toBe('native');
    expect(missing.worldbook).toBeUndefined();
    expect(missing.warnings.length).toBeGreaterThan(0);

    const noOuterId = convertWorldbookImport({ kind: 'worldbook', worldbook: { version: 1, entries: [] } });
    expect(noOuterId.worldbook).toBeUndefined();
    expect(noOuterId.warnings.length).toBeGreaterThan(0);

    const strayEntry = convertWorldbookImport({ kind: 'worldbook', id: 'x', revision: 'r1', worldbook: { version: 1, entries: [] }, entry: '../wrong.js' });
    expect(strayEntry.worldbook).toBeUndefined();
    expect(strayEntry.warnings.some((warning) => warning.includes('manifest'))).toBe(true);

    const badBook = convertWorldbookImport({ kind: 'worldbook', id: 'x', revision: 'r1', worldbook: { version: 1, entries: [{ id: '../escape', content: 'x' }] } });
    expect(badBook.detectedFormat).toBe('native');
    expect(badBook.worldbook).toBeUndefined();
  });

  it('accepts empty and all-disabled books but they resolve to the empty state (D08)', () => {
    expect(convertWorldbookImport({ version: 1, entries: [] }).worldbook?.entries).toEqual([]);
    const allDisabled = convertWorldbookImport({ version: 1, entries: [{ id: 'a', keys: ['k'], content: 'c', enabled: false }] });
    expect(allDisabled.worldbook?.entries.every((entry) => !entry.enabled)).toBe(true);
  });
});
