import { describe, expect, it } from 'vitest';
import { mergeAccountPlugins } from '../desktop/renderer/src/lib/account-plugins.js';
import type { AccountPluginEntry } from '../desktop/renderer/src/types.js';

describe('account plugin merge', () => {
  it('updates available public plugins without touching private or missing entries', () => {
    const existing: AccountPluginEntry[] = [
      { source: 'public', id: 'enabled-now', enabled: true, revision: 'r1', config: { tone: 'warm' } },
      { source: 'public', id: 'missing-from-library', enabled: false, revision: 'r2' },
      { source: 'private', id: 'private-one', enabled: false, revision: 'r3', config: { local: true } }
    ];

    const next = mergeAccountPlugins(existing, ['enabled-now'], []);

    expect(next).toEqual([
      { source: 'public', id: 'enabled-now', enabled: false, revision: 'r1', config: { tone: 'warm' } },
      { source: 'public', id: 'missing-from-library', enabled: false, revision: 'r2' },
      { source: 'private', id: 'private-one', enabled: false, revision: 'r3', config: { local: true } }
    ]);
  });

  it('re-enables a selected public plugin and keeps its fixed revision and config', () => {
    const existing: AccountPluginEntry[] = [
      { source: 'public', id: 'card', enabled: false, revision: 'v3', config: { mode: 'fixed' } }
    ];

    expect(mergeAccountPlugins(existing, ['card'], ['card'])).toEqual([
      { source: 'public', id: 'card', enabled: true, revision: 'v3', config: { mode: 'fixed' } }
    ]);
  });

  it('appends newly selected public plugins once', () => {
    const existing: AccountPluginEntry[] = [
      { source: 'private', id: 'new', revision: 'private-r1' }
    ];

    const next = mergeAccountPlugins(existing, ['new'], ['new', 'new']);

    expect(next).toEqual([
      { source: 'private', id: 'new', revision: 'private-r1' },
      { source: 'public', id: 'new', enabled: true }
    ]);
  });

  it('preserves stopped entries and does not mutate the input array', () => {
    const existing: AccountPluginEntry[] = [
      { source: 'public', id: 'a', enabled: true },
      { source: 'public', id: 'b', enabled: false }
    ];
    const snapshot = structuredClone(existing);

    const next = mergeAccountPlugins(existing, ['a', 'b'], ['a']);

    expect(existing).toEqual(snapshot);
    expect(next).not.toBe(existing);
    expect(next[0]).toEqual({ source: 'public', id: 'a', enabled: true });
    expect(next[1]).toEqual({ source: 'public', id: 'b', enabled: false });
  });
});
