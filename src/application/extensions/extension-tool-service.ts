import crypto from 'node:crypto';
import { IsolationError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { CapabilityId } from '../../policy/capabilities.js';
import type { ConversationRef } from '../../routing/identity.js';
import { catalogToolDefinition } from '../../extensions/catalog.js';
import type { EffectiveExtensions } from '../../extensions/effective.js';
import type { PluginHookName, ToolInvocationResult } from '../../extensions/contracts.js';
import type { ToolView } from '../../extensions/execution/executor.js';
import type { RegisteredToolDefinition } from '../../extensions/types.js';
import type { PluginHookInput, PluginAfterTurnInput, PluginHookOutcome, PluginHookBudget } from '../../extensions/runtime/plugin-worker.js';
import { PLUGIN_HOOK_BUDGET } from '../../extensions/runtime/plugin-worker.js';
import { PLUGIN_RUNTIME_LIMITS } from '../../extensions/runtime/protocol.js';
import type { PluginHookDispatchOptions, PluginRuntimeSnapshotEntry } from '../../extensions/runtime/account-runtime.js';
import {
  ToolExecutor,
  type ToolBatchContext,
  type ToolBatchResult,
  type ToolCallRequest,
  type ToolExecutionLimits,
  type ToolHandlerResolver
} from '../../extensions/execution/executor.js';
import { ToolConcurrencyLimiter } from '../../extensions/execution/limiter.js';
import { stableStringify } from '../../providers/types.js';
import { truncateTextToFit } from '../../platform/text/truncate.js';
import type { ExtensionPolicyService } from './extension-policy-service.js';

/** The part of a plugin runtime the tool service needs; ready tools are read from the runtime service. */
export interface PluginToolRuntimePort {
  handlers(): ToolHandlerResolver;
  snapshot?(): PluginRuntimeSnapshotEntry[];
  beforeContext?(input: PluginHookInput, options?: PluginHookDispatchOptions): Promise<Array<{ pluginKey: string; result: PluginHookOutcome }>>;
  afterTurn?(input: PluginAfterTurnInput, options?: PluginHookDispatchOptions): Promise<void>;
}

export interface ExtensionTurnSnapshot {
  accountId: string;
  conversation: ConversationRef;
  token: string;
  policyToken: string;
  participatingPluginKeys: string[];
  runtimeGeneration: string;
  toolView: ToolView;
  skills: Array<{
    id: string;
    name: string;
    source: 'public' | 'private' | 'plugin';
    instructions: string;
    tools: string[];
  }>;
  hookPluginKeys: string[];
  excludedPluginKeys: string[];
  /** Private snapshot inputs retained so failed hook Workers can be excluded without refreshing policy. */
  sourceEffective: EffectiveExtensions;
  sourceRuntime: PluginRuntimeSnapshotEntry[];
}

export interface ExtensionHookResult {
  additions: Array<{ pluginKey: string; source: string; text: string }>;
  failedPluginKeys: string[];
}

export interface ExtensionToolServiceOptions {
  policy: ExtensionPolicyService;
  accountDir: (accountId: string) => string;
  logger: Logger;
  capabilityEnabled: (accountId: string, conversation: ConversationRef) => (capability: CapabilityId) => boolean;
  runtime?: (accountId: string) => PluginToolRuntimePort | undefined;
  limits?: ToolExecutionLimits;
  now?: () => number;
}

/**
 * Owns the account-scoped executors behind one shared tool concurrency budget. Admission data comes
 * from the same effective-resolution path the pages use, and is re-read for every pre-action gate,
 * so a revoked authorization or a changed plugin handshake stops work that has not started yet.
 */
export class ExtensionToolService {
  readonly #policy: ExtensionPolicyService;
  readonly #accountDir: (accountId: string) => string;
  readonly #logger: Logger;
  readonly #capabilityEnabled: ExtensionToolServiceOptions['capabilityEnabled'];
  readonly #runtime?: (accountId: string) => PluginToolRuntimePort | undefined;
  readonly #limiter: ToolConcurrencyLimiter;
  readonly #limits?: ToolExecutionLimits;
  readonly #now?: () => number;
  readonly #executors = new Map<string, ToolExecutor>();
  #closed = false;

  constructor(options: ExtensionToolServiceOptions) {
    this.#policy = options.policy;
    this.#accountDir = options.accountDir;
    this.#logger = options.logger;
    this.#capabilityEnabled = options.capabilityEnabled;
    if (options.runtime) this.#runtime = options.runtime;
    this.#limits = options.limits;
    if (options.now) this.#now = options.now;
    this.#limiter = new ToolConcurrencyLimiter(options.limits ?? {});
  }

  async view(accountId: string, conversation: ConversationRef): Promise<ToolView> {
    if (accountId !== conversation.accountId) {
      throw new IsolationError('tool view account does not match the conversation account');
    }
    const effective = await this.#policy.effective(accountId, conversation, this.#capabilityEnabled(accountId, conversation));
    const tools = effective.tools
      .filter((entry) => entry.enabled)
      .map((entry) => catalogToolDefinition(entry.tool));
    return { tools, authorized: new Set(tools.map((tool) => tool.id)) };
  }

  async captureTurn(accountId: string, conversation: ConversationRef): Promise<ExtensionTurnSnapshot> {
    if (accountId !== conversation.accountId) {
      throw new IsolationError('extension snapshot account does not match the conversation account');
    }
    const effective = await this.#policy.effective(accountId, conversation, this.#capabilityEnabled(accountId, conversation));
    const runtime = this.#runtime?.(accountId);
    return this.#makeSnapshot(accountId, conversation, effective, runtime?.snapshot?.() ?? [], new Set());
  }

  async isTurnSnapshotCurrent(snapshot: ExtensionTurnSnapshot): Promise<boolean> {
    if (snapshot.accountId !== snapshot.conversation.accountId) return false;
    try {
      const current = await this.captureTurn(snapshot.accountId, snapshot.conversation);
      const comparable = this.#makeSnapshot(
        current.accountId,
        current.conversation,
        current.sourceEffective,
        current.sourceRuntime,
        new Set(snapshot.excludedPluginKeys)
      );
      return comparable.token === snapshot.token;
    } catch {
      return false;
    }
  }

  /** Checks only current scope/config policy so a hook's own Worker failure can be excluded safely. */
  async isTurnPolicyCurrent(snapshot: ExtensionTurnSnapshot): Promise<boolean> {
    if (snapshot.accountId !== snapshot.conversation.accountId) return false;
    try {
      const effective = await this.#policy.effective(
        snapshot.accountId,
        snapshot.conversation,
        this.#capabilityEnabled(snapshot.accountId, snapshot.conversation)
      );
      return extensionPolicyToken(effective, new Set(snapshot.participatingPluginKeys)) === snapshot.policyToken;
    } catch {
      return false;
    }
  }

  excludeFailedPlugins(snapshot: ExtensionTurnSnapshot, pluginKeys: readonly string[]): ExtensionTurnSnapshot {
    const excluded = new Set(snapshot.excludedPluginKeys);
    for (const key of pluginKeys) excluded.add(key);
    return this.#makeSnapshot(snapshot.accountId, snapshot.conversation, snapshot.sourceEffective, snapshot.sourceRuntime, excluded);
  }

  newHookBudget(): PluginHookBudget {
    return { remainingMs: PLUGIN_HOOK_BUDGET.turnMs };
  }

  async beforeContext(
    snapshot: ExtensionTurnSnapshot,
    input: PluginHookInput,
    budget: PluginHookBudget
  ): Promise<ExtensionHookResult> {
    const runtime = this.#runtime?.(snapshot.accountId);
    if (!runtime?.beforeContext) return { additions: [], failedPluginKeys: [] };
    const pluginKeys = new Set(snapshot.hookPluginKeys.filter((key) => !snapshot.excludedPluginKeys.includes(key)));
    if (pluginKeys.size === 0) return { additions: [], failedPluginKeys: [] };
    const results = await runtime.beforeContext(input, { pluginKeys, budget });
    const additions: Array<{ pluginKey: string; source: string; text: string }> = [];
    const failedPluginKeys: string[] = [];
    let usedBytes = 0;
    for (const { pluginKey, result } of results) {
      if (!pluginKeys.has(pluginKey)) continue;
      if (result.status !== 'ok') {
        failedPluginKeys.push(pluginKey);
        this.#logger.warn('plugin beforeContext ignored for this turn', { pluginKey, reason: result.reason });
        continue;
      }
      for (const addition of result.additions) {
        if (additions.length >= MAX_TURN_HOOK_ADDITIONS) break;
        const origin = `${pluginKey} · ${safeHookSource(addition.source)}`;
        const originBytes = Buffer.byteLength(origin, 'utf8');
        const remaining = PLUGIN_RUNTIME_LIMITS.maxHookResultBytes - usedBytes - originBytes;
        if (remaining <= 0) break;
        const text = truncateUtf8(addition.text, remaining);
        if (!text) continue;
        usedBytes += originBytes + Buffer.byteLength(text, 'utf8');
        additions.push({ pluginKey, source: origin, text });
      }
    }
    return { additions, failedPluginKeys: [...new Set(failedPluginKeys)] };
  }

  async afterTurn(
    snapshot: ExtensionTurnSnapshot,
    input: PluginAfterTurnInput,
    budget: PluginHookBudget
  ): Promise<void> {
    if (!(await this.isTurnSnapshotCurrent(snapshot))) return;
    const runtime = this.#runtime?.(snapshot.accountId);
    if (!runtime?.afterTurn) return;
    const pluginKeys = new Set(snapshot.hookPluginKeys.filter((key) => !snapshot.excludedPluginKeys.includes(key)));
    if (pluginKeys.size === 0) return;
    await runtime.afterTurn(input, { pluginKeys, budget });
  }

  #makeSnapshot(
    accountId: string,
    conversation: ConversationRef,
    effective: EffectiveExtensions,
    runtimeEntries: PluginRuntimeSnapshotEntry[],
    excluded: ReadonlySet<string>
  ): ExtensionTurnSnapshot {
    const includedToolStatuses = effective.tools.filter((status) => status.enabled
      && (!status.tool.pluginKey || !excluded.has(status.tool.pluginKey)));
    const includedHooks = effective.hooks.filter((status) => status.enabled && !excluded.has(status.hook.pluginKey));
    const includedToolIds = new Set(includedToolStatuses.map((status) => status.tool.id));
    const includedSkills = effective.skills.filter((status) => status.enabled
      && (!status.skill.pluginKey || !excluded.has(status.skill.pluginKey))
      && status.skill.tools.every((toolId) => includedToolIds.has(toolId)));
    const pluginKeys = new Set<string>();
    for (const status of includedToolStatuses) if (status.tool.pluginKey) pluginKeys.add(status.tool.pluginKey);
    for (const status of includedHooks) pluginKeys.add(status.hook.pluginKey);
    for (const status of includedSkills) if (status.skill.pluginKey) pluginKeys.add(status.skill.pluginKey);
    const relevantRuntime = runtimeEntries
      .filter((entry) => pluginKeys.has(entry.pluginKey))
      .map((entry) => ({
        pluginKey: entry.pluginKey,
        revision: entry.revision,
        configDigest: entry.configDigest,
        runtimeGeneration: entry.runtimeGeneration,
        tools: [...entry.tools].sort(),
        hooks: [...entry.hooks].sort()
      }))
      .sort((left, right) => left.pluginKey.localeCompare(right.pluginKey));
    const relevantPlugins = effective.plugins
      .filter((plugin) => pluginKeys.has(plugin.key))
      .map((plugin) => ({ key: plugin.key, revision: plugin.revision, configDigest: plugin.configDigest }))
      .sort((left, right) => left.key.localeCompare(right.key));
    const tools = includedToolStatuses.map((status) => catalogToolDefinition(status.tool));
    const skills = includedSkills.map((status) => ({
      id: status.skill.id,
      name: status.skill.name,
      source: status.skill.source,
      instructions: status.skill.instructions,
      tools: [...status.skill.tools]
    }));
    const hookPluginKeys = [...new Set(includedHooks.map((status) => status.hook.pluginKey))].sort();
    const participatingPluginKeys = [...pluginKeys].sort();
    const policyToken = extensionPolicyToken(effective, pluginKeys);
    const token = crypto.createHash('sha256').update(stableStringify({
      accountId,
      conversation: { kind: conversation.kind, peerId: conversation.peerId },
      policyToken,
      tools,
      hooks: includedHooks.map((status) => ({
        pluginKey: status.hook.pluginKey,
        name: status.hook.name,
        timeoutMs: status.hook.timeoutMs
      })),
      plugins: relevantPlugins,
      skills,
      states: effective.states.filter((status) => pluginKeys.has(status.pluginKey)).map((status) => ({
        pluginKey: status.pluginKey,
        accountSharedState: status.accountSharedState,
        enabled: status.enabled,
        switchSource: status.switchSource
      })),
      runtime: relevantRuntime
    })).digest('hex').slice(0, 32);
    return {
      accountId,
      conversation,
      token,
      policyToken,
      participatingPluginKeys,
      runtimeGeneration: `extensions:${token}`,
      toolView: { tools, authorized: new Set(tools.map((tool) => tool.id)) },
      skills,
      hookPluginKeys,
      excludedPluginKeys: [...excluded].sort(),
      sourceEffective: effective,
      sourceRuntime: runtimeEntries
    };
  }

  async executeBatch(calls: ToolCallRequest[], context: ToolBatchContext): Promise<ToolBatchResult> {
    if (context.accountId !== context.conversation.accountId) {
      throw new IsolationError('tool batch account does not match the conversation account');
    }
    if (this.#closed) return this.#rejected(calls, context);
    const executor = this.#executorFor(context.accountId);
    return executor.executeBatch(calls, context);
  }

  /** Wait for admitted work to settle, then close ledger writers. New batches are rejected. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const executors = [...this.#executors.values()];
    this.#executors.clear();
    await Promise.allSettled(executors.map((executor) => executor.close()));
    this.#limiter.close();
  }

  #executorFor(accountId: string): ToolExecutor {
    const existing = this.#executors.get(accountId);
    if (existing) return existing;
    const executor = new ToolExecutor({
      view: (viewAccountId, conversation) => this.view(viewAccountId, conversation),
      handlers: (toolId) => {
        try {
          return this.#runtime?.(accountId)?.handlers()(toolId);
        } catch {
          this.#logger.warn('plugin tool handler lookup failed', { accountId, toolId });
          return undefined;
        }
      },
      accountDir: this.#accountDir,
      logger: this.#logger,
      limiter: this.#limiter,
      ...(this.#limits ? { limits: this.#limits } : {}),
      ...(this.#now ? { now: this.#now } : {})
    });
    this.#executors.set(accountId, executor);
    return executor;
  }

  #rejected(calls: ToolCallRequest[], context: ToolBatchContext): ToolBatchResult {
    const results: ToolInvocationResult[] = calls.map((call, index) => ({
      invocationId: call.callId || `tool_closed_${index}`,
      status: 'error',
      errorCode: 'executor_closed',
      text: '工具执行器正在关闭。'
    }));
    return {
      results,
      executed: 0,
      replayed: 0,
      bytes: results.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result), 'utf8'), 0),
      preflightFailed: true
    };
  }
}

const MAX_TURN_HOOK_ADDITIONS = PLUGIN_RUNTIME_LIMITS.maxAdditions;

function safeHookSource(value: string): string {
  return value.replace(/[\u0000-\u001f<>]/g, '_').slice(0, PLUGIN_RUNTIME_LIMITS.maxAdditionSource);
}

function truncateUtf8(value: string, maxBytes: number): string {
  return truncateTextToFit(value, (candidate) => Buffer.byteLength(candidate, 'utf8') <= maxBytes) ?? '';
}

function extensionPolicyToken(effective: EffectiveExtensions, pluginKeys: ReadonlySet<string>): string {
  const pluginToolIds = new Set(effective.tools
    .filter((status) => status.tool.pluginKey && pluginKeys.has(status.tool.pluginKey))
    .map((status) => status.tool.id));
  const relevantSkills = effective.skills.filter((status) =>
    (status.skill.pluginKey !== undefined && pluginKeys.has(status.skill.pluginKey))
    || status.skill.tools.some((toolId) => pluginToolIds.has(toolId))
  );
  const tokenBody = {
    accountId: effective.accountId,
    conversation: { kind: effective.conversation.kind, peerId: effective.conversation.peerId },
    plugins: effective.plugins.filter((plugin) => pluginKeys.has(plugin.key))
      .map((plugin) => ({ key: plugin.key, revision: plugin.revision, configDigest: plugin.configDigest }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    tools: effective.tools.filter((status) => status.tool.pluginKey && pluginKeys.has(status.tool.pluginKey))
      .map((status) => ({
        id: status.tool.id,
        authorized: status.authorized,
        switchSource: status.switchSource,
        issues: status.issues.filter((issue) => issue.code !== 'handler_not_ready')
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    hooks: effective.hooks.filter((status) => pluginKeys.has(status.hook.pluginKey))
      .map((status) => ({
        pluginKey: status.hook.pluginKey,
        name: status.hook.name,
        switchSource: status.switchSource,
        issues: status.issues.filter((issue) => issue.code !== 'handler_not_ready')
      }))
      .sort((left, right) => `${left.pluginKey}/${left.name}`.localeCompare(`${right.pluginKey}/${right.name}`)),
    skills: relevantSkills.map((status) => {
      const issues = status.issues.filter((issue) => issue.code !== 'skill_tool_unavailable');
      return {
        id: status.skill.id,
        enabled: issues.length === 0,
        switchSource: status.switchSource,
        issues,
        unavailableTools: status.unavailableTools.filter((toolId) => !pluginToolIds.has(toolId))
      };
    }).sort((left, right) => left.id.localeCompare(right.id)),
    states: effective.states.filter((status) => pluginKeys.has(status.pluginKey)).map((status) => ({
      pluginKey: status.pluginKey,
      accountSharedState: status.accountSharedState,
      enabled: status.enabled,
      switchSource: status.switchSource
    }))
  };
  return crypto.createHash('sha256').update(stableStringify(tokenBody)).digest('hex').slice(0, 32);
}
