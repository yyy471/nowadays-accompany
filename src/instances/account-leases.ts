import { IsolationError } from '../core/errors.js';

/** 一个 QQ 号在同一 Core 内只能由一个实例持有。 */
export class AccountLeases {
  readonly #owners = new Map<string, string>();

  acquire(accountId: string, owner: string): void {
    const existing = this.#owners.get(accountId);
    if (existing && existing !== owner) {
      throw new IsolationError(`account ${accountId} is already owned by instance ${existing}`);
    }
    this.#owners.set(accountId, owner);
  }

  release(accountId: string, owner: string): void {
    if (this.#owners.get(accountId) === owner) this.#owners.delete(accountId);
  }

  ownerOf(accountId: string): string | undefined {
    return this.#owners.get(accountId);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#owners);
  }

  clear(): void {
    this.#owners.clear();
  }
}
