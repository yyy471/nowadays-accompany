export type DraftOwner = 'page' | 'settings';

export interface DraftSnapshot {
  id: string;
  owner: DraftOwner;
  accountId?: string;
  label: string;
  dirty: boolean;
  busy: boolean;
  revision: number;
  discard: () => void;
}

export interface DraftSource {
  id: string;
  owner: DraftOwner;
  getSnapshot: () => Omit<DraftSnapshot, 'id' | 'owner'>;
}

export type DraftScope =
  | { kind: 'page' }
  | { kind: 'settings' }
  | { kind: 'all' }
  | { kind: 'account'; accountId: string }
  | { kind: 'ids'; ids: string[] };

interface Entry {
  source: DraftSource;
  generation: number;
}

export class DraftRegistry {
  private entries = new Map<string, Entry>();
  private generations = new Map<string, number>();

  register(source: DraftSource): () => void {
    const generation = (this.generations.get(source.id) ?? 0) + 1;
    this.generations.set(source.id, generation);
    this.entries.set(source.id, { source, generation });
    return () => {
      if (this.entries.get(source.id)?.generation === generation) this.entries.delete(source.id);
    };
  }

  snapshot(scope: DraftScope = { kind: 'all' }): DraftSnapshot[] {
    const all = [...this.entries.values()].map(({ source }) => {
      const state = source.getSnapshot();
      return { id: source.id, owner: source.owner, ...state };
    }).sort((left, right) => left.id.localeCompare(right.id));
    switch (scope.kind) {
      case 'page': return all.filter((entry) => entry.owner === 'page');
      case 'settings': return all.filter((entry) => entry.owner === 'settings');
      case 'all': return all;
      case 'account': return all.filter((entry) => entry.accountId === scope.accountId);
      case 'ids': {
        const ids = new Set(scope.ids);
        return all.filter((entry) => ids.has(entry.id));
      }
    }
  }

  hasPending(): boolean {
    return this.snapshot().some((entry) => entry.dirty || entry.busy);
  }
}

export function hashRevision(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
