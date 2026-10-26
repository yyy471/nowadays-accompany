import { describe, expect, it } from 'vitest';
import {
  blankWorldbook, copyBookId, draftIsDirty, duplicateEntry, duplicateEntryId, newEntry, nextRevision, parseKeys,
  revisionConflict, validateWorldbookDraft
} from '../desktop/renderer/src/lib/worldbook-editor.js';

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, keys: ['花园'], content: '正文', enabled: true, constant: false, caseSensitive: false, priority: 0,
  position: 'after-role' as const, ...overrides
});

describe('worldbook editor draft rules', () => {
  it('suggests an unused numeric revision and falls back for non-numeric histories', () => {
    expect(nextRevision([])).toBe('r1');
    expect(nextRevision(['r1', 'r3'])).toBe('r4');
    expect(nextRevision(['r1', 'r2', 'r4'])).toBe('r5');
    expect(nextRevision(['r2', 'r3'])).toBe('r4');
    expect(nextRevision(['draft-a', 'draft-b'])).toBe('r1');
  });

  it('derives unique entry ids without breaking the 64-character segment limit', () => {
    expect(duplicateEntryId('tree', [])).toBe('tree-copy');
    expect(duplicateEntryId('tree', ['tree-copy'])).toBe('tree-copy-2');
    const long = 'a'.repeat(64);
    const copy = duplicateEntryId(long, []);
    expect(copy).toHaveLength(64);
    expect(copy.endsWith('-copy')).toBe(true);
    const entryCopy = duplicateEntry(entry('tree'), ['tree']);
    expect(entryCopy.id).toBe('tree-copy');
    expect(entryCopy.keys).not.toBe(entry('tree').keys);
    expect(newEntry(['entry']).id).toBe('entry-2');
  });

  it('keeps a copy suffix for 63/64-character book ids and avoids known conflicts', () => {
    for (const length of [63, 64]) {
      const source = 'a'.repeat(length);
      const copy = copyBookId(source, []);
      expect(copy).toHaveLength(64);
      expect(copy.endsWith('-copy')).toBe(true);
      expect(copy).not.toBe(source);
      expect(copyBookId(source, ['a'.repeat(59) + '-copy'])).toMatch(/-copy-2$/);
    }
    expect(copyBookId('tree', ['tree'])).toBe('tree-copy');
    expect(copyBookId('tree', ['tree-copy'])).toBe('tree-copy-2');
    expect(copyBookId('tree', ['tree-copy', 'tree-copy-2'])).toBe('tree-copy-3');
  });

  it('parses both comma styles and newlines while trimming blanks', () => {
    expect(parseKeys(' 花园, 银杏，\n藤蔓 ,, ')).toEqual(['花园', '银杏', '藤蔓']);
  });

  it('matches domain limits and locates entry errors by index', () => {
    const book = blankWorldbook();
    book.entries = [entry('one'), entry('one'), entry('bad id', { keys: ['x'.repeat(257)] }), entry('disabled', { enabled: false, keys: [] })];
    const errors = validateWorldbookDraft({ id: '../escape', revision: 'r 1', name: '', worldbook: book });
    expect(errors.id).toBeDefined();
    expect(errors.revision).toBeDefined();
    expect(errors['entry:1:id']).toContain('唯一');
    expect(errors['entry:2:id']).toBeDefined();
    expect(errors['entry:2:keys']).toContain('256');
    expect(errors['entry:3:keys']).toBeUndefined();
    book.entries = [entry('enabled-without-keys', { keys: [] })];
    expect(validateWorldbookDraft({ id: 'book', revision: 'r1', name: '', worldbook: book })['entry:0:keys']).toContain('关键词');
    book.entries = [entry('ok', { keys: ['x'], content: 'x'.repeat(8193) })];
    expect(validateWorldbookDraft({ id: 'book', revision: 'r1', name: '', worldbook: book })['entry:0:content']).toBeDefined();
    book.scanDepth = 21; book.budgetChars = 8001;
    const ranges = validateWorldbookDraft({ id: 'book', revision: 'r1', name: '', worldbook: book });
    expect(ranges.scanDepth).toBeDefined(); expect(ranges.budgetChars).toBeDefined();
  });

  it('detects dirty drafts and refuses to overwrite the base revision', () => {
    const baseline = { id: 'book', revision: 'r1', name: 'Book', worldbook: blankWorldbook() };
    expect(draftIsDirty({ id: 'book', revision: 'r1', name: 'Book', worldbook: blankWorldbook() }, baseline)).toBe(false);
    const changed = { ...baseline, worldbook: { ...blankWorldbook(), budgetChars: 1 } };
    expect(draftIsDirty(changed, baseline)).toBe(true);
    expect(revisionConflict({ ...baseline, revision: 'r1' }, { revision: 'r1' })).toBe(true);
    expect(revisionConflict({ ...baseline, revision: 'r2' }, { revision: 'r1' })).toBe(false);
    expect(revisionConflict({ ...baseline, revision: 'r1' })).toBe(false);
  });
});
