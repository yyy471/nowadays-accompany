import crypto from 'node:crypto';
import type { ResolvedPlugin } from '../../artifacts/types.js';
import type { Logger } from '../../core/logger.js';
import type { AccountPolicy } from '../../providers/types.js';
import type { PluginHookName } from '../contracts.js';
import { resolvePluginSwitch } from '../policy.js';
import { stableStringify } from '../../providers/types.js';
import type { ToolHandlerResolver } from '../execution/executor.js';
import { PluginStateService } from './state.js';
import {
  PluginWorkerManager,
  PLUGIN_HOOK_BUDGET,
  type PluginHookInput,
  type PluginHookOutcome,
  type PluginHookBudget,
  type PluginRuntimeLimits
} from './plugin-worker.js';

export interface AccountPluginRuntimeOptions {
  accountId: string;
  logger: Logger;
  accountDir: string;
  accountPolicy: () => AccountPolicy;
  limits?: PluginRuntimeLimits;
}

export interface PluginRuntimeStatus {
  pluginKey: string;
  revision: string;
  ready: boolean;
  reason?: string;
  tools: string[];
  hooks: PluginHookName[];
}

export interface PluginRuntimeSnapshotEntry {
  pluginKey: string;
  revision: string;
  configDigest: string;
  runtimeGeneration: string;
  tools: string[];
  hooks: PluginHookName[];
}

export interface PluginHookDispatchOptions {
  pluginKeys?: ReadonlySet<string>;
  budget?: PluginHookBudget;
}

interface RuntimeEntry {
  manager: PluginWorkerManager;
  revision: string;
  configDigest: string;
}

/**
 * Owns one Worker per installed plugin for one account. Plugin identity includes public/private
 * source, so same-id artifacts from different stores cannot share handlers or state.
 */
export class AccountPluginRuntime {
  readonly #options: AccountPluginRuntimeOptions;
  readonly #state: PluginStateService;
  readonly #entries = new Map<string, RuntimeEntry>();
  readonly #toolOwners = new Map<string, PluginWorkerManager>();
  #chain: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(options: AccountPluginRuntimeOptions) {
    this.#options = options;
    this.#state = new PluginStateService(options.accountDir, options.logger);
  }

  async sync(plugins: readonly ResolvedPlugin[]): Promise<PluginRuntimeStatus[]> {
    if (this.#closing) return [];
    const run = this.#chain.then(() => this.#sync(plugins));
    this.#chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  readyPlugins(): ReadonlySet<string> {
    return new Set([...this.#entries.values()].filter((entry) => !entry.manager.terminated).map((entry) => entry.manager.pluginKey));
  }

  readyTools(): ReadonlySet<string> {
    const ready = new Set<string>();
    for (const [toolId, manager] of this.#toolOwners) {
      if (!manager.terminated) ready.add(toolId);
    }
    return ready;
  }

  snapshot(): PluginRuntimeSnapshotEntry[] {
    return [...this.#entries.values()]
      .filter((entry) => !entry.manager.terminated)
      .map((entry) => ({ ...entry.manager.snapshot(), configDigest: entry.configDigest }))
      .sort((left, right) => left.pluginKey.localeCompare(right.pluginKey));
  }

  handlers(): ToolHandlerResolver {
    return (toolId) => this.#toolOwners.get(toolId)?.toolBinding(toolId);
  }

  async beforeContext(input: PluginHookInput, options: PluginHookDispatchOptions = {}): Promise<Array<{ pluginKey: string; result: PluginHookOutcome }>> {
    const entries = [...this.#entries.values()]
      .filter((entry) => entry.manager.hasHook('beforeContext')
        && !entry.manager.terminated
        && (!options.pluginKeys || options.pluginKeys.has(entry.manager.pluginKey))
        && this.#pluginEnabled(entry.manager.pluginKey, input.conversation));
    const budget = options.budget ?? { remainingMs: PLUGIN_HOOK_BUDGET.turnMs };
    const results: Array<{ pluginKey: string; result: PluginHookOutcome }> = [];
    for (const entry of entries) {
      if (budget.remainingMs <= 0) {
        results.push({ pluginKey: entry.manager.pluginKey, result: { status: 'unavailable', reason: 'plugin_hook_budget_exhausted' } });
        continue;
      }
      const startedAt = Date.now();
      const deadlineAt = startedAt + Math.min(PLUGIN_HOOK_BUDGET.singleHookMs, budget.remainingMs);
      try {
        results.push({ pluginKey: entry.manager.pluginKey, result: await entry.manager.beforeContext({ ...input, deadlineAt }) });
      } catch (error) {
        // One plugin must not remove the other plugins' additions or the Agent's own turn.
        results.push({ pluginKey: entry.manager.pluginKey, result: { status: 'failed', reason: safeReason(error) } });
      } finally {
        budget.remainingMs = Math.max(0, budget.remainingMs - (Date.now() - startedAt));
      }
    }
    return results;
  }

  async afterTurn(
    input: Omit<PluginHookInput, 'message'> & { outcome: 'sent' | 'suppressed' | 'failed'; replyText?: string; errorCode?: string },
    options: PluginHookDispatchOptions = {}
  ): Promise<void> {
    const entries = [...this.#entries.values()]
      .filter((entry) => entry.manager.hasHook('afterTurn')
        && (!options.pluginKeys || options.pluginKeys.has(entry.manager.pluginKey))
        && this.#pluginEnabled(entry.manager.pluginKey, input.conversation)
        && !entry.manager.terminated);
    const budget = options.budget ?? { remainingMs: PLUGIN_HOOK_BUDGET.turnMs };
    for (const entry of entries) {
      if (budget.remainingMs <= 0) break;
      const startedAt = Date.now();
      const deadlineAt = startedAt + Math.min(PLUGIN_HOOK_BUDGET.singleHookMs, budget.remainingMs);
      try {
        await entry.manager.afterTurn({ ...input, deadlineAt });
      } catch (error) {
        this.#options.logger.warn('plugin afterTurn dispatch failed', {
          pluginKey: entry.manager.pluginKey,
          reason: safeReason(error)
        });
      } finally {
        budget.remainingMs = Math.max(0, budget.remainingMs - (Date.now() - startedAt));
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const inProgress = this.#chain;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    this.#toolOwners.clear();
    const stops = Promise.allSettled(entries.map((entry) => entry.manager.stop()));
    this.#closePromise = Promise.allSettled([inProgress, stops]).then(async () => {
      await this.#state.close();
    });
    this.#chain = this.#closePromise.then(() => undefined, () => undefined);
    return this.#closePromise;
  }

  async #sync(plugins: readonly ResolvedPlugin[]): Promise<PluginRuntimeStatus[]> {
    const desired = new Map<string, ResolvedPlugin>();
    for (const plugin of plugins) {
      const key = `${plugin.ref.source}/plugin/${plugin.ref.id}`;
      if (!desired.has(key)) desired.set(key, plugin);
    }
    for (const [key, entry] of [...this.#entries]) {
      const plugin = desired.get(key);
      if (!plugin || plugin.ref.revision !== entry.revision || configDigest(plugin.config) !== entry.configDigest) {
        this.#entries.delete(key);
        this.#removeToolOwners(entry.manager);
        void entry.manager.stop();
      } else if (entry.manager.terminated) {
        this.#entries.delete(key);
        this.#removeToolOwners(entry.manager);
        void entry.manager.stop();
      }
    }

    const statuses: PluginRuntimeStatus[] = [];
    for (const [key, plugin] of desired) {
      if (this.#closing) break;
      let entry = this.#entries.get(key);
      if (!entry) {
        const manager = new PluginWorkerManager(plugin, {
          accountId: this.#options.accountId,
          state: this.#state,
          logger: this.#options.logger,
          accountPolicy: this.#options.accountPolicy,
          ...(this.#options.limits ? { limits: this.#options.limits } : {})
        });
        entry = { manager, revision: plugin.ref.revision, configDigest: configDigest(plugin.config) };
        this.#entries.set(key, entry);
      }
      try {
        await entry.manager.start();
        for (const tool of entry.manager.readyTools) this.#toolOwners.set(tool, entry.manager);
        statuses.push({
          pluginKey: key,
          revision: entry.revision,
          ready: true,
          tools: entry.manager.readyTools,
          hooks: entry.manager.readyHooks
        });
      } catch (error) {
        this.#removeToolOwners(entry.manager);
        statuses.push({
          pluginKey: key,
          revision: entry.revision,
          ready: false,
          reason: safeReason(error),
          tools: [],
          hooks: []
        });
      }
    }
    return statuses;
  }

  #pluginEnabled(key: string, conversation: PluginHookInput['conversation']): boolean {
    return conversation.accountId === this.#options.accountId
      && resolvePluginSwitch(this.#options.accountPolicy(), conversation, key).value === 'on';
  }

  #removeToolOwners(manager: PluginWorkerManager): void {
    for (const [toolId, owner] of [...this.#toolOwners]) {
      if (owner === manager) this.#toolOwners.delete(toolId);
    }
  }
}

function safeReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return /^[a-z][a-z0-9._-]{0,63}$/.test((error as { code: string }).code) ? (error as { code: string }).code : 'plugin_runtime_failed';
  }
  return 'plugin_runtime_failed';
}

function configDigest(config: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 32);
}
