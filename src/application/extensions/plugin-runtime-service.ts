import type { ResolvedProfile } from '../../artifacts/types.js';
import type { Logger } from '../../core/logger.js';
import type { AccountPolicy } from '../../providers/types.js';
import { AccountPluginRuntime, type PluginRuntimeStatus } from '../../extensions/runtime/account-runtime.js';
import type { PluginToolRuntimePort } from './extension-tool-service.js';

export interface PluginRuntimeServiceOptions {
  accountDir: (accountId: string) => string;
  profiles: (accountId: string) => Promise<ResolvedProfile>;
  accountPolicy: (accountId: string) => AccountPolicy;
  logger: Logger;
}

interface Owned {
  dir: string;
  runtime: AccountPluginRuntime;
}

/**
 * Holds the per-account plugin Workers below Core. Plugin identity carries the public/private
 * source, so one account's handshake never leaks handlers or state into another account.
 */
export class PluginRuntimeService {
  readonly #options: PluginRuntimeServiceOptions;
  readonly #owned = new Map<string, Owned>();
  readonly #chains = new Map<string, Promise<PluginRuntimeStatus[]>>();
  readonly #closingAccounts = new Set<string>();
  readonly #accountClosePromises = new Map<string, Promise<void>>();
  readonly #accountGenerations = new Map<string, number>();
  readonly #closeWaiters = new Map<string, Set<() => void>>();
  readonly #lastStatuses = new Map<string, PluginRuntimeStatus[]>();
  readonly #syncedAccounts = new Set<string>();
  #closed = false;

  constructor(options: PluginRuntimeServiceOptions) {
    this.#options = options;
  }

  /** Serialize per account: the same account must never run two overlapping installs. */
  async sync(accountId: string): Promise<PluginRuntimeStatus[]> {
    if (this.#closed || this.#closingAccounts.has(accountId)) return [];
    const generation = this.#accountGenerations.get(accountId) ?? 0;
    const previous = this.#chains.get(accountId) ?? Promise.resolve([]);
    const next = previous.then(
      () => this.#sync(accountId, generation),
      () => this.#sync(accountId, generation)
    );
    this.#chains.set(accountId, next);
    try {
      const statuses = await next;
      if (this.#isCurrent(accountId, generation)) {
        this.#lastStatuses.set(accountId, statuses);
        this.#syncedAccounts.add(accountId);
      }
      return statuses;
    } finally {
      if (this.#chains.get(accountId) === next) this.#chains.delete(accountId);
    }
  }

  /** Last handshake outcome, including plugins that failed to start. */
  statuses(accountId: string): { synced: boolean; plugins: PluginRuntimeStatus[] } {
    return {
      synced: this.#syncedAccounts.has(accountId),
      plugins: structuredClone(this.#lastStatuses.get(accountId) ?? [])
    };
  }

  port(accountId: string): PluginToolRuntimePort | undefined {
    return this.#owned.get(accountId)?.runtime;
  }

  readyTools(accountId: string): ReadonlySet<string> {
    return this.#owned.get(accountId)?.runtime.readyTools() ?? new Set<string>();
  }

  readyPlugins(accountId: string): ReadonlySet<string> {
    return this.#owned.get(accountId)?.runtime.readyPlugins() ?? new Set<string>();
  }

  async close(accountId?: string): Promise<void> {
    if (accountId === undefined) {
      this.#closed = true;
      const ids = new Set([...this.#owned.keys(), ...this.#chains.keys(), ...this.#accountClosePromises.keys()]);
      await Promise.allSettled([...ids].map((id) => this.#closeAccountNow(id)));
      return;
    }
    await this.#closeAccountNow(accountId);
  }

  /** Interrupt pending profile reads immediately and terminate any already-owned runtime. */
  async #closeAccountNow(accountId: string): Promise<void> {
    const existing = this.#accountClosePromises.get(accountId);
    if (existing) return existing;
    this.#closingAccounts.add(accountId);
    this.#accountGenerations.set(accountId, (this.#accountGenerations.get(accountId) ?? 0) + 1);
    for (const wake of this.#closeWaiters.get(accountId) ?? []) wake();
    // Mark the account runtime closed immediately so an in-flight handshake/sync is interrupted.
    const owned = this.#owned.get(accountId);
    if (owned) this.#owned.delete(accountId);
    this.#lastStatuses.delete(accountId);
    this.#syncedAccounts.delete(accountId);
    const runtimeClose = owned?.runtime.close() ?? Promise.resolve();
    const close = runtimeClose.finally(() => {
      this.#accountClosePromises.delete(accountId);
      if (!this.#closed) this.#closingAccounts.delete(accountId);
    });
    this.#accountClosePromises.set(accountId, close);
    return close;
  }

  async #closeOne(accountId: string, expected?: Owned): Promise<void> {
    const owned = this.#owned.get(accountId);
    if (expected && owned !== expected) return;
    this.#owned.delete(accountId);
    if (!owned) return;
    await owned.runtime.close();
  }

  async #sync(accountId: string, generation: number): Promise<PluginRuntimeStatus[]> {
    if (!this.#isCurrent(accountId, generation)) return [];
    const dir = this.#options.accountDir(accountId);
    let owned = this.#owned.get(accountId);
    if (owned && owned.dir !== dir) {
      await this.#closeOne(accountId, owned);
      owned = undefined;
    }
    if (!this.#isCurrent(accountId, generation)) return [];
    if (!owned) {
      const runtime = new AccountPluginRuntime({
        accountId,
        logger: this.#options.logger,
        accountDir: dir,
        accountPolicy: () => this.#options.accountPolicy(accountId)
      });
      owned = { dir, runtime };
      this.#owned.set(accountId, owned);
    }
    try {
      let wake!: () => void;
      const closed = new Promise<'closed'>((resolve) => { wake = () => resolve('closed'); });
      const waiters = this.#closeWaiters.get(accountId) ?? new Set<() => void>();
      waiters.add(wake);
      this.#closeWaiters.set(accountId, waiters);
      const profileResult = await Promise.race([
        this.#options.profiles(accountId).then((profile) => ({ kind: 'profile' as const, profile })),
        closed.then(() => ({ kind: 'closed' as const }))
      ]).finally(() => {
        waiters.delete(wake);
        if (waiters.size === 0) this.#closeWaiters.delete(accountId);
      });
      if (profileResult.kind === 'closed') return [];
      const profile = profileResult.profile;
      if (!this.#isCurrent(accountId, generation) || this.#owned.get(accountId) !== owned) return [];
      return await owned.runtime.sync(profile.plugins);
    } catch (error) {
      if (!this.#isCurrent(accountId, generation) || this.#owned.get(accountId) !== owned) return [];
      // A profile that cannot be read must not leave a stale generation claiming tool handlers.
      this.#options.logger.warn('plugin runtime sync failed', {
        accountId,
        message: error instanceof Error ? error.message : String(error)
      });
      await this.#closeOne(accountId, owned);
      return [];
    }
  }

  #isCurrent(accountId: string, generation: number): boolean {
    return !this.#closed && !this.#closingAccounts.has(accountId)
      && (this.#accountGenerations.get(accountId) ?? 0) === generation;
  }
}
