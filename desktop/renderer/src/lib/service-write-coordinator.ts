export type ServiceEditOwner = 'models' | 'advanced';

export type ServiceWriteSnapshot = {
  /** 某服务当前由哪个编辑面的未保存草稿先占用；另一侧只能查看，不能提交。 */
  locks: Record<string, ServiceEditOwner>;
  /** 正在提交的写入归属；同服务同时只允许一个写入。 */
  writes: Record<string, ServiceEditOwner>;
};

export interface ServiceWriteGuard extends ServiceWriteSnapshot {
  setIntents(owner: ServiceEditOwner, providerIds: string[]): void;
  begin(providerId: string, owner: ServiceEditOwner): boolean;
  end(providerId: string, owner: ServiceEditOwner): void;
}

function sameIntents(current: Map<string, number>, next: Map<string, number>): boolean {
  if (current.size !== next.size) return false;
  for (const [id, sequence] of next) if (current.get(id) !== sequence) return false;
  return true;
}

/** 服务ID可能等于constructor/toString等原型属性，快照必须只含自有键。 */
function ownRecord<T>(entries: Iterable<[string, T]> = []): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

/** 页面内共享的简易／高级服务写入协调器；实例由ModelConfig持有，不做模块级状态。 */
export class ServiceWriteCoordinator {
  #intents = new Map<ServiceEditOwner, Map<string, number>>();
  #writes = new Map<string, ServiceEditOwner>();
  #sequence = 0;
  #listeners = new Set<() => void>();
  #snapshot: ServiceWriteSnapshot = { locks: ownRecord(), writes: ownRecord() };

  getSnapshot = (): ServiceWriteSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  setIntents = (owner: ServiceEditOwner, providerIds: string[]): void => {
    const current = this.#intents.get(owner) ?? new Map<string, number>();
    const next = new Map<string, number>();
    for (const id of new Set(providerIds)) next.set(id, current.get(id) ?? ++this.#sequence);
    if (sameIntents(current, next)) return;
    this.#intents.set(owner, next);
    this.#commit();
  };

  begin = (providerId: string, owner: ServiceEditOwner): boolean => {
    if (this.#writes.has(providerId)) return false;
    const locks = this.#buildLocks();
    const lock = Object.hasOwn(locks, providerId) ? locks[providerId] : undefined;
    if (lock && lock !== owner) return false;
    this.#writes.set(providerId, owner);
    this.#commit();
    return true;
  };

  end = (providerId: string, owner: ServiceEditOwner): void => {
    if (this.#writes.get(providerId) !== owner) return;
    this.#writes.delete(providerId);
    this.#commit();
  };

  #buildLocks(): Record<string, ServiceEditOwner> {
    const chosen = new Map<string, { owner: ServiceEditOwner; sequence: number }>();
    for (const [owner, intents] of this.#intents) {
      for (const [providerId, sequence] of intents) {
        const current = chosen.get(providerId);
        if (!current || sequence < current.sequence) chosen.set(providerId, { owner, sequence });
      }
    }
    return ownRecord([...chosen].map(([providerId, value]) => [providerId, value.owner] as [string, ServiceEditOwner]));
  }

  #commit(): void {
    this.#snapshot = { locks: this.#buildLocks(), writes: ownRecord(this.#writes) };
    for (const listener of this.#listeners) listener();
  }
}

export function createServiceWriteCoordinator(): ServiceWriteCoordinator {
  return new ServiceWriteCoordinator();
}
