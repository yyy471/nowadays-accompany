import { describe, expect, it } from 'vitest';
import { parseConversationWorldbookSource, parseWorldbookSettings, summarizeWorldbook } from '../src/worldbook/schema.js';
import { parseArtifactManifest } from '../src/artifacts/manifest.js';

describe('conversation worldbook source contract', () => {
  it('defaults to the built-in role-card source', () => {
    expect(parseConversationWorldbookSource()).toEqual({ kind: 'role-card' });
    expect(parseConversationWorldbookSource({ kind: 'role-card' })).toEqual({ kind: 'role-card' });
  });

  it('accepts only a fixed public artifact revision', () => {
    const raw = { kind: 'artifact', ref: { source: 'public', id: 'garden-guide', revision: 'w-001' } };
    expect(parseConversationWorldbookSource(raw)).toEqual(raw);
  });

  it.each([
    { kind: 'artifact', ref: { source: 'public', id: 'x' } },                 // missing revision
    { kind: 'artifact', ref: { source: 'private', id: 'x', revision: 'r' } }, // non-public
    { kind: 'artifact', ref: { source: 'public', id: '../x', revision: 'r' } }, // traversal id
    { kind: 'artifact', ref: { source: 'public', id: 'x', revision: 'r.' } },  // trailing dot revision
    { kind: 'artifact', ref: { source: 'public', id: 'x', revision: 'r', extra: 1 } },
    { kind: 'artifact' },
    { kind: 'other' },
    { kind: 'role-card', extra: 1 },
    null,
    'role-card',
    []
  ])('rejects invalid source %j', (raw) => {
    expect(() => parseConversationWorldbookSource(raw)).toThrow();
  });
});

describe('worldbook settings write contract', () => {
  it('applies options and keeps the existing source when omitted', () => {
    expect(parseWorldbookSettings({})).toEqual({ options: { enabled: false, scanDepth: 4, budgetChars: 2000 } });
    expect(parseWorldbookSettings({ worldbook: { enabled: true } })).toEqual({ options: { enabled: true, scanDepth: 4, budgetChars: 2000 } });
  });

  it('submits source and options in a single write', () => {
    const result = parseWorldbookSettings({ worldbook: { enabled: true, budgetChars: 500 }, source: { kind: 'artifact', ref: { source: 'public', id: 'garden-guide', revision: 'w-001' } } });
    expect(result.options).toEqual({ enabled: true, scanDepth: 4, budgetChars: 500 });
    expect(result.source).toEqual({ kind: 'artifact', ref: { source: 'public', id: 'garden-guide', revision: 'w-001' } });
  });

  it('rejects null source and unknown top-level fields', () => {
    expect(() => parseWorldbookSettings({ source: null })).toThrow();
    expect(() => parseWorldbookSettings({ worldbook: {}, unexpected: 1 })).toThrow();
  });
});

describe('summarizeWorldbook view', () => {
  it('marks a book with no enabled entries as empty', () => {
    const enabled = { version: 1 as const, scanDepth: 4, budgetChars: 2000, entries: [{ id: 'a', keys: ['k'], content: 'c', enabled: true, constant: false, caseSensitive: false, priority: 0, position: 'after-role' as const }] };
    expect(summarizeWorldbook(enabled)).toEqual({ entryCount: 1, enabledEntryCount: 1, state: 'ready' });
    const disabled = { ...enabled, entries: enabled.entries.map((entry) => ({ ...entry, enabled: false })) };
    expect(summarizeWorldbook(disabled)).toEqual({ entryCount: 1, enabledEntryCount: 0, state: 'empty' });
  });
});

describe('worldbook artifact manifest contract', () => {
  it('normalizes a frozen manifest without mutating caller-owned data', () => {
    const book = Object.freeze({ version: 1, entries: [] });
    const input = Object.freeze({ id: 'garden', kind: 'worldbook', revision: 'r1', worldbook: book });
    const parsed = parseArtifactManifest(input, { strict: true });
    expect(parsed.worldbook).toMatchObject({ scanDepth: 4, budgetChars: 2000 });
    expect(input.worldbook).toBe(book);
    expect(input.worldbook).not.toHaveProperty('scanDepth');
  });
  const base = { id: 'garden-guide', revision: 'w-001' };
  const worldbook = { version: 1, entries: [{ id: 'garden', keys: ['花园'], content: '银杏' }] };

  it('parses a valid worldbook resource and its book', () => {
    const manifest = parseArtifactManifest({ ...base, kind: 'worldbook', worldbook }, { strict: true });
    expect(manifest.kind).toBe('worldbook');
    expect(manifest.worldbook?.entries[0]?.id).toBe('garden');
  });

  it('does not require role content or plugin entry for a worldbook', () => {
    expect(() => parseArtifactManifest({ ...base, kind: 'worldbook', worldbook }, { strict: true })).not.toThrow();
  });

  it('rejects a worldbook without a book and with stray fields', () => {
    expect(() => parseArtifactManifest({ ...base, kind: 'worldbook' }, { strict: true })).toThrow();
    expect(() => parseArtifactManifest({ ...base, kind: 'worldbook', worldbook, content: 'x' }, { strict: true })).toThrow();
  });

  it('keeps the built-in worldbook on a role card and rejects unknown kinds', () => {
    expect(() => parseArtifactManifest({ ...base, kind: 'role-card', content: '设定', worldbook }, { strict: true })).not.toThrow();
    expect(() => parseArtifactManifest({ ...base, kind: 'notebook' }, { strict: true })).toThrow();
  });
});
