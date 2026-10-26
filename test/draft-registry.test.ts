import { describe, expect, it } from 'vitest';
import { DraftRegistry, hashRevision, type DraftSource } from '../desktop/renderer/src/lib/drafts/registry.js';

function source(id: string, state: Partial<ReturnType<DraftSource['getSnapshot']>> = {}): DraftSource {
  return {
    id,
    owner: 'page',
    getSnapshot: () => ({
      label: id,
      dirty: false,
      busy: false,
      revision: 1,
      discard: () => {},
      ...state
    })
  };
}

describe('draft registry', () => {
  it('reads the latest snapshot instead of a value captured at registration', () => {
    let dirty = false;
    const registry = new DraftRegistry();
    registry.register({ id: 'policy:1', owner: 'page', getSnapshot: () => ({ label: 'policy', dirty, busy: false, revision: dirty ? 2 : 1, discard: () => {} }) });

    expect(registry.snapshot()[0]?.dirty).toBe(false);
    dirty = true;
    expect(registry.snapshot()[0]).toMatchObject({ dirty: true, revision: 2 });
  });

  it('filters by page, settings, account and explicit ids', () => {
    const registry = new DraftRegistry();
    registry.register({ ...source('page:a'), owner: 'page' });
    registry.register({ ...source('page:b', { accountId: '10002' }), owner: 'page' });
    registry.register({ ...source('settings:models'), owner: 'settings' });

    expect(registry.snapshot({ kind: 'page' }).map((entry) => entry.id)).toEqual(['page:a', 'page:b']);
    expect(registry.snapshot({ kind: 'settings' }).map((entry) => entry.id)).toEqual(['settings:models']);
    expect(registry.snapshot({ kind: 'account', accountId: '10002' }).map((entry) => entry.id)).toEqual(['page:b']);
    expect(registry.snapshot({ kind: 'ids', ids: ['settings:models', 'missing'] }).map((entry) => entry.id)).toEqual(['settings:models']);
  });

  it('does not let an old cleanup remove a newer registration with the same id', () => {
    const registry = new DraftRegistry();
    const first = registry.register(source('same'));
    registry.register({ ...source('same'), owner: 'settings' });

    first();
    expect(registry.snapshot()).toHaveLength(1);
    expect(registry.snapshot()[0]?.owner).toBe('settings');
  });

  it('reports pending dirty or busy entries', () => {
    const registry = new DraftRegistry();
    registry.register(source('clean'));
    expect(registry.hasPending()).toBe(false);
    registry.register({ ...source('busy', { busy: true }), owner: 'settings' });
    expect(registry.hasPending()).toBe(true);
  });
});

describe('draft revisions', () => {
  it('changes when the draft changes and is stable for equal values', () => {
    expect(hashRevision({ value: 'a', nested: [1, 2] })).toBe(hashRevision({ value: 'a', nested: [1, 2] }));
    expect(hashRevision({ value: 'a' })).not.toBe(hashRevision({ value: 'b' }));
  });
});
