import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { ResolvedPlugin } from '../../artifacts/types.js';
import { AccompanyError, IsolationError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { sanitizeErrorText } from '../../platform/security/redaction.js';
import type { AccountPolicy } from '../../providers/types.js';
import type { ConversationRef } from '../../routing/identity.js';
import { pluginToolId, type PluginHookName } from '../contracts.js';
import { resolveExtensionSwitch, resolvePluginSwitch } from '../policy.js';
import type { ToolHandler, ToolHandlerBinding, ToolHandlerOutcome } from '../execution/executor.js';
import {
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_RUNTIME_LIMITS,
  pluginScopeTokenString,
  pluginWorkerSource,
  type PluginAfterTurnContext,
  type PluginBeforeContextResult,
  type PluginExecutionContext,
  type PluginHandshake,
  type PluginHistorySnapshot,
  type PluginResponse,
  type PluginScopeToken,
  type PluginTaskRequest,
  type PluginTaskResponse
} from './protocol.js';
import type { PluginStateService } from './state.js';

export interface PluginRuntimeLimits {
  initTimeoutMs?: number;
  disposeTimeoutMs?: number;
  timeoutGraceMs?: number;
}

export interface PluginWorkerStartOptions {
  accountId: string;
  state: PluginStateService;
  logger: Logger;
  accountPolicy: () => AccountPolicy;
  limits?: PluginRuntimeLimits;
}

export interface PluginHookInput {
  conversation: ConversationRef;
  contextEpoch: string;
  turnId: string;
  message?: PluginExecutionContext['message'];
  history: PluginHistorySnapshot[];
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  guard?: () => boolean | Promise<boolean>;
  /** Absolute host deadline; set before entering this plugin's serial queue. */
  deadlineAt?: number;
}

export interface PluginHookBudget {
  remainingMs: number;
}

export const PLUGIN_HOOK_BUDGET = { singleHookMs: 500, turnMs: 2_000 } as const;

export type PluginAfterTurnInput = PluginHookInput & {
  outcome: PluginAfterTurnContext['outcome'];
  replyText?: string;
  errorCode?: string;
};

/**
 * Hook failure reasons are diagnostic, not a stable single-code contract. When the host deadline
 * and the Worker handler deadline share the same cap, `plugin_timeout` and `plugin_handler_timeout`
 * may race; both terminate the generation, and callers must decide by the observable effects.
 */
export type PluginHookOutcome =
  | { status: 'ok'; additions: PluginBeforeContextResult['additions'] }
  | { status: 'unavailable'; reason: string; detail?: string }
  | { status: 'failed'; reason: string };

export interface PluginToolInput {
  conversation: ConversationRef;
  contextEpoch: string;
  invocationId: string;
  toolId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  guard?: () => boolean | Promise<boolean>;
  deadlineAt?: number;
}

interface PendingWorkerRequest {
  resolve: (response: PluginResponse) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  accountId: string;
  pluginKey: string;
  runtimeGeneration: string;
  scopeToken?: string;
  cleanup?: () => void;
}

/**
 * One plugin, one account, one Worker. Tasks are serialized so the scoped state snapshot cannot be
 * concurrently overwritten. Every response is checked against request id, account, full plugin key
 * and runtime generation; a timeout invalidates the whole generation instead of trusting late work.
 */
export class PluginWorkerManager {
  readonly pluginKey: string;
  readonly runtimeGeneration: string;
  readonly #plugin: ResolvedPlugin;
  readonly #options: PluginWorkerStartOptions;
  readonly #tools = new Set<string>();
  readonly #hooks = new Set<PluginHookName>();
  readonly #pending = new Map<number, PendingWorkerRequest>();
  #worker?: Worker;
  #handshake?: Promise<void>;
  #termination?: Promise<number>;
  #requestSeq = 0;
  #terminated = false;
  #stopRequested = false;
  #ready = false;
  #initializationReject?: (error: unknown) => void;
  #busy = 0;
  #unavailableReason?: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(plugin: ResolvedPlugin, options: PluginWorkerStartOptions) {
    this.#plugin = plugin;
    this.#options = options;
    this.pluginKey = `${plugin.ref.source}/plugin/${plugin.ref.id}`;
    this.runtimeGeneration = crypto.randomUUID();
  }

  get readyTools(): string[] {
    return [...this.#tools];
  }

  get readyHooks(): PluginHookName[] {
    return [...this.#hooks];
  }

  get terminated(): boolean {
    return this.#terminated;
  }

  get unavailableReason(): string | undefined {
    return this.#unavailableReason;
  }

  snapshot(): { pluginKey: string; revision: string; runtimeGeneration: string; tools: string[]; hooks: PluginHookName[] } {
    return {
      pluginKey: this.pluginKey,
      revision: this.#plugin.ref.revision,
      runtimeGeneration: this.runtimeGeneration,
      tools: this.readyTools,
      hooks: this.readyHooks
    };
  }

  hasTool(toolId: string): boolean {
    return this.#tools.has(toolId);
  }

  hasHook(hook: PluginHookName): boolean {
    return this.#hooks.has(hook);
  }

  async start(): Promise<void> {
    await this.#ensure();
  }

  toolBinding(fullToolId: string): ToolHandlerBinding | undefined {
    if (this.#terminated || !this.#tools.has(fullToolId)) return undefined;
    const declaration = (this.#plugin.manifest.tools ?? []).find((tool) => pluginToolId(this.#plugin.ref.source as 'public' | 'private', this.#plugin.ref.id, tool.id) === fullToolId);
    if (!declaration) return undefined;
    const localToolId = declaration.id;
    const handler: ToolHandler = async (args, context) => {
      if (!context.contextEpoch) {
        return { status: 'error', errorCode: 'plugin_context_epoch_missing', text: '缺少角色会话代际，插件工具未执行。' };
      }
      const result = await this.callTool({
        conversation: context.conversation,
        contextEpoch: context.contextEpoch,
        invocationId: context.invocationId,
        toolId: fullToolId,
        args,
        signal: context.signal,
        ...(context.guard ? { guard: context.guard } : {}),
        deadlineAt: context.deadlineAt
      });
      return result;
    };
    return { generation: `${this.runtimeGeneration}:${localToolId}`, handler };
  }

  beforeContext(input: PluginHookInput): Promise<PluginHookOutcome> {
    const timeout = this.#hookTimeout('beforeContext');
    const deadlineAt = Math.min(input.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + timeout);
    const execution = { ...input, deadlineAt };
    let expired = false;
    let dispatched = false;
    const timeoutValue: PluginHookOutcome = { status: 'failed', reason: 'plugin_timeout' };
    return this.#withHookDeadline(
      this.#serialize(() => {
        if (expired || Date.now() >= deadlineAt) return Promise.resolve(timeoutValue);
        dispatched = true;
        return this.#beforeContext(execution, deadlineAt);
      }),
      deadlineAt,
      timeoutValue,
      () => {
        expired = true;
        // A queued hook must not kill an unrelated tool that currently owns this Worker.
        // Once dispatched, termination fences off late hook state writes and responses.
        if (dispatched) this.#terminate('plugin hook deadline elapsed');
      }
    );
  }

  afterTurn(input: PluginAfterTurnInput): Promise<void> {
    const timeout = this.#hookTimeout('afterTurn');
    const deadlineAt = Math.min(input.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + timeout);
    const execution = { ...input, deadlineAt };
    let expired = false;
    let dispatched = false;
    return this.#withHookDeadline(this.#serialize(() => {
      if (expired || Date.now() >= deadlineAt) return Promise.resolve();
      dispatched = true;
      return this.#afterTurn(execution, deadlineAt);
    }), deadlineAt, undefined, () => {
      expired = true;
      if (dispatched) this.#terminate('plugin hook deadline elapsed');
    });
  }

  callTool(input: PluginToolInput): Promise<ToolHandlerOutcome> {
    const full = parsePluginToolId(input.toolId);
    const declaration = (this.#plugin.manifest.tools ?? []).find((tool) => tool.id === full.localId);
    const timeout = declaration?.timeoutMs ?? 1;
    const normalized: PluginToolInput = {
      ...input,
      signal: input.signal ?? new AbortController().signal,
      deadlineAt: input.deadlineAt ?? Date.now() + timeout
    };
    return this.#serialize(() => this.#callTool(normalized));
  }

  async stop(): Promise<void> {
    if (this.#terminated) {
      await this.#termination;
      return;
    }
    this.#stopRequested = true;
    const worker = this.#worker;
    if (!worker || !this.#ready || this.#busy > 0 || this.#pending.size > 0) {
      this.#terminate('plugin host stopped');
      await this.#termination;
      return;
    }
    try {
      const request: PluginTaskRequest = {
        type: 'stop',
        id: ++this.#requestSeq,
        timeoutMs: this.#options.limits?.disposeTimeoutMs ?? 2_000,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        accountId: this.#options.accountId,
        pluginKey: this.pluginKey,
        runtimeGeneration: this.runtimeGeneration
      };
      await Promise.race([
        this.#request(request),
        delay(this.#options.limits?.disposeTimeoutMs ?? 2_000)
      ]);
    } catch {
      // Stop is best-effort; the worker is terminated below regardless.
    }
    this.#terminate('plugin host stopped');
    await this.#termination;
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.catch(() => {}).then(async () => {
      this.#busy += 1;
      try {
        return await task();
      } finally {
        this.#busy = Math.max(0, this.#busy - 1);
      }
    });
    this.#chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #withHookDeadline<T>(work: Promise<T>, deadlineAt: number, timeoutValue: T, onTimeout: () => void): Promise<T> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      onTimeout();
      return timeoutValue;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        onTimeout();
        resolve(timeoutValue);
      }, remaining);
    });
    timer?.unref?.();
    try {
      return await Promise.race([work, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #ensure(): Promise<void> {
    if (this.#terminated) throw new AccompanyError(this.#unavailableReason ?? 'plugin_runtime_terminated', 'plugin runtime is terminated');
    if (this.#handshake) return this.#handshake;
    this.#handshake = this.#startWorker();
    try {
      await this.#handshake;
    } catch (error) {
      this.#handshake = undefined;
      throw error;
    }
    return this.#handshake;
  }

  async #startWorker(): Promise<void> {
    const created = new Worker(pluginWorkerSource(), {
      eval: true,
      workerData: {
        accountId: this.#options.accountId,
        pluginKey: this.pluginKey,
        entry: this.#plugin.entry,
        runtimeGeneration: this.runtimeGeneration,
        config: boundedJson(this.#plugin.config, PLUGIN_RUNTIME_LIMITS.maxConfigBytes, 'plugin_config'),
        declarations: {
          tools: this.#plugin.manifest.tools ?? [],
          hooks: this.#plugin.manifest.hooks ?? []
        },
        limits: {
          initTimeoutMs: this.#options.limits?.initTimeoutMs ?? 2_000,
          disposeTimeoutMs: this.#options.limits?.disposeTimeoutMs ?? 2_000,
          maxAdditions: PLUGIN_RUNTIME_LIMITS.maxAdditions,
          maxAdditionSource: PLUGIN_RUNTIME_LIMITS.maxAdditionSource,
          maxAdditionBytes: PLUGIN_RUNTIME_LIMITS.maxAdditionBytes
        }
      }
    });
    this.#worker = created;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const initTimeout = this.#options.limits?.initTimeoutMs ?? 2_000;
      const hostDeadline = initTimeout + (this.#options.limits?.timeoutGraceMs ?? 1_000);
      let timer: NodeJS.Timeout;
      const cleanup = (): void => {
        clearTimeout(timer);
        created.off('message', onMessage);
        created.off('error', onError);
        created.off('exit', onExit);
        if (this.#initializationReject === fail) this.#initializationReject = undefined;
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#tools.clear();
        this.#hooks.clear();
        this.#worker = undefined;
        this.#unavailableReason = error instanceof AccompanyError ? error.code : 'plugin_runtime_terminated';
        this.#terminated = true;
        reject(error);
        this.#termination ??= created.terminate().catch(() => 0);
      };
      const onMessage = (message: unknown): void => {
        const payload = message as Partial<PluginHandshake> & { type?: string; error?: string; errorCode?: string };
        if (payload?.type === 'handshake') {
          if (payload.protocolVersion !== PLUGIN_PROTOCOL_VERSION
            || payload.accountId !== this.#options.accountId
            || payload.pluginKey !== this.pluginKey
            || payload.runtimeGeneration !== this.runtimeGeneration) {
            fail(new AccompanyError('plugin_protocol_mismatch', 'plugin handshake identity does not match this runtime generation'));
            return;
          }
          for (const tool of payload.tools ?? []) {
            this.#tools.add(pluginToolId(this.#plugin.ref.source as 'public' | 'private', this.#plugin.ref.id, tool));
          }
          for (const hook of payload.hooks ?? []) {
            if (hook === 'beforeContext' || hook === 'afterTurn') this.#hooks.add(hook);
          }
          settled = true;
          cleanup();
          this.#ready = true;
          resolve();
        } else if (payload?.type === 'init_error') {
          const code = typeof payload.errorCode === 'string' ? payload.errorCode : 'plugin_init_failed';
          fail(new AccompanyError(code, sanitizeErrorText(payload.error ?? 'plugin init failed', 200)));
        }
      };
      const onError = (error: Error): void => fail(error);
      const onExit = (code: number): void => fail(new AccompanyError('plugin_worker_exit', `plugin worker exited with code ${code}`));
      this.#initializationReject = fail;
      created.on('message', onMessage);
      created.on('error', onError);
      created.on('exit', onExit);
      timer = setTimeout(() => {
        fail(new AccompanyError('plugin_init_timeout', `plugin ${this.pluginKey} initialization exceeded its host deadline`));
      }, hostDeadline);
    });
    created.on('message', (message: unknown) => this.#onMessage(message));
    created.on('error', (error) => {
      this.#failAll('plugin_worker_error', error.message);
      this.#terminate('plugin worker error');
    });
    created.on('exit', (code) => {
      if (!this.#stopRequested) this.#failAll('plugin_worker_exit', String(code));
      this.#terminate('plugin worker exit');
    });
  }

  #onMessage(message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const response = message as Partial<PluginTaskResponse>;
    if (response.type !== 'response' || typeof response.id !== 'number') return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    if (response.accountId !== pending.accountId || response.pluginKey !== pending.pluginKey || response.runtimeGeneration !== pending.runtimeGeneration) {
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new AccompanyError('plugin_protocol_mismatch', 'plugin response identity does not match this request'));
      this.#terminate('plugin protocol mismatch');
      return;
    }
    if (pending.scopeToken && (!('scopeToken' in response) || response.scopeToken !== pending.scopeToken)) {
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new AccompanyError('plugin_protocol_mismatch', 'plugin response scope does not match this request'));
      this.#terminate('plugin protocol mismatch');
      return;
    }
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    pending.resolve(response as PluginResponse);
    if (response.errorCode === 'plugin_handler_timeout') this.#terminate('plugin handler timeout');
  }

  async #request(
    request: PluginTaskRequest,
    execution: {
      conversation?: ConversationRef;
      contextEpoch?: string;
      signal?: AbortSignal;
      guard?: () => boolean | Promise<boolean>;
      deadlineAt?: number;
      onDispatch?: () => void;
    } = {}
  ): Promise<PluginResponse> {
    const worker = this.#worker;
    if (!worker || this.#terminated) throw new AccompanyError('plugin_runtime_unavailable', 'plugin runtime is unavailable');
    if (execution.conversation) await this.#assertExecutionCurrent(execution.conversation, execution);
    const deadlineAt = execution.deadlineAt ?? ('deadlineAt' in request ? request.deadlineAt : undefined);
    const remainingMs = deadlineAt === undefined ? request.timeoutMs : Math.min(request.timeoutMs, deadlineAt - Date.now());
    if (remainingMs <= 0) throw new AccompanyError('plugin_timeout', 'plugin task deadline elapsed before dispatch');
    const outgoing: PluginTaskRequest = request.type === 'stop'
      ? request
      : { ...request, timeoutMs: remainingMs, deadlineAt: deadlineAt ?? Date.now() + remainingMs };
    const serialized = JSON.stringify(outgoing);
    if (Buffer.byteLength(serialized, 'utf8') > PLUGIN_RUNTIME_LIMITS.maxRequestBytes) {
      throw new AccompanyError('plugin_request_too_large', 'plugin request exceeds its bounded size');
    }
    return new Promise((resolve, reject) => {
      const timeoutMs = outgoing.timeoutMs;
      let guardTimer: NodeJS.Timeout | undefined;
      let guardCheckRunning = false;
      const onAbort = (): void => cancel(new AccompanyError('plugin_cancelled', 'plugin task was cancelled'));
      const cleanup = (): void => {
        if (guardTimer) clearInterval(guardTimer);
        execution.signal?.removeEventListener('abort', onAbort);
      };
      const cancel = (error: AccompanyError): void => {
        const pending = this.#pending.get(outgoing.id);
        if (!pending) return;
        this.#pending.delete(outgoing.id);
        clearTimeout(pending.timer);
        pending.cleanup?.();
        pending.reject(error);
        this.#cancelGeneration(outgoing.id, error.code);
      };
      const hookRequest = outgoing.type === 'beforeContext' || outgoing.type === 'afterTurn';
      const hostGraceMs = hookRequest ? 0 : (this.#options.limits?.timeoutGraceMs ?? 1_000);
      const timer = setTimeout(() => {
        if (!this.#pending.has(outgoing.id)) return;
        const pending = this.#pending.get(outgoing.id)!;
        this.#pending.delete(outgoing.id);
        pending.cleanup?.();
        pending.reject(new AccompanyError('plugin_timeout', `plugin ${this.pluginKey} timed out after ${timeoutMs}ms`));
        this.#terminate('plugin timeout');
      }, timeoutMs + hostGraceMs);
      timer.unref?.();
      this.#pending.set(outgoing.id, {
        resolve: resolve as (response: PluginResponse) => void,
        reject,
        timer,
        accountId: outgoing.accountId,
        pluginKey: outgoing.pluginKey,
        runtimeGeneration: outgoing.runtimeGeneration,
        ...(outgoing.type === 'stop' ? {} : { scopeToken: outgoing.scopeToken }),
        cleanup
      });
      if (execution.signal) {
        if (execution.signal.aborted) {
          cancel(new AccompanyError('plugin_cancelled', 'plugin task was cancelled'));
          return;
        }
        execution.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (execution.conversation && (execution.guard || execution.signal || execution.deadlineAt !== undefined)) {
        guardTimer = setInterval(() => {
          if (guardCheckRunning || !this.#pending.has(outgoing.id)) return;
          guardCheckRunning = true;
          void this.#assertExecutionCurrent(execution.conversation!, execution).catch((error: unknown) => {
            cancel(error instanceof AccompanyError ? error : new AccompanyError('plugin_execution_guard_changed', 'plugin execution guard failed'));
          }).finally(() => { guardCheckRunning = false; });
        }, 25);
      }
      worker.postMessage(outgoing);
      execution.onDispatch?.();
    });
  }

  async #beforeContext(input: PluginHookInput, deadlineAt: number): Promise<PluginHookOutcome> {
    if (!this.#hooks.has('beforeContext')) return { status: 'ok', additions: [] };
    if (!validContextEpoch(input.contextEpoch)) return { status: 'unavailable', reason: 'plugin_context_epoch_missing' };
    if (!validHookInput(input, this.#plugin.config)) return { status: 'unavailable', reason: 'plugin_hook_context_too_large' };
    try {
      await this.#assertExecutionCurrent(input.conversation, input);
    } catch (error) {
      return { status: 'unavailable', reason: safeReason(error) };
    }
    const prepared = await this.#prepare(input.conversation, input.contextEpoch, input);
    if (!prepared.ok) return { status: 'unavailable', reason: prepared.reason };
    const timeout = Math.min(this.#hookTimeout('beforeContext'), Math.max(1, deadlineAt - Date.now()));
    let response: PluginResponse;
    try {
      response = await this.#request({
        type: 'beforeContext',
        id: ++this.#requestSeq,
        timeoutMs: timeout,
        deadlineAt,
        scopeToken: prepared.scopeToken,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        accountId: this.#options.accountId,
        pluginKey: this.pluginKey,
        runtimeGeneration: this.runtimeGeneration,
        context: {
          accountId: this.#options.accountId,
          conversation: { kind: input.conversation.kind, peerId: input.conversation.peerId },
          scope: prepared.scope,
          turnId: input.turnId,
          ...(input.message ? { message: input.message } : {}),
          history: input.history,
          config: input.config ?? {}
        },
        state: prepared.state
      }, { conversation: input.conversation, contextEpoch: input.contextEpoch, signal: input.signal, guard: input.guard, deadlineAt });
    } catch (error) {
      return { status: 'failed', reason: safeReason(error) };
    }
    if (response.error) {
      if ('state' in response) await this.#writeState(prepared, response.state, input);
      if (response.errorCode === 'plugin_handler_timeout') return { status: 'failed', reason: 'plugin_handler_timeout' };
      return { status: 'failed', reason: sanitizeErrorText(response.error, PLUGIN_RUNTIME_LIMITS.maxErrorText) };
    }
    if (response.task !== 'beforeContext' || !validAdditions(response.result)) {
      return { status: 'failed', reason: 'invalid_plugin_hook_result' };
    }
    const written = await this.#writeState(prepared, response.state, input);
    if (!written) return { status: 'failed', reason: 'plugin_state_write_failed' };
    if (Date.now() >= deadlineAt || !(await this.#executionGuard(input))) {
      return { status: 'failed', reason: 'plugin_timeout' };
    }
    return { status: 'ok', additions: response.result.additions };
  }

  async #afterTurn(input: PluginAfterTurnInput, deadlineAt: number): Promise<void> {
    if (!this.#hooks.has('afterTurn') || !validContextEpoch(input.contextEpoch) || !validHookInput(input, this.#plugin.config)) return;
    try {
      await this.#assertExecutionCurrent(input.conversation, input);
    } catch {
      return;
    }
    const prepared = await this.#prepare(input.conversation, input.contextEpoch, input);
    if (!prepared.ok) return;
    const timeout = Math.min(this.#hookTimeout('afterTurn'), Math.max(1, deadlineAt - Date.now()));
    try {
      const response = await this.#request({
        type: 'afterTurn',
        id: ++this.#requestSeq,
        timeoutMs: timeout,
        deadlineAt,
        scopeToken: prepared.scopeToken,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        accountId: this.#options.accountId,
        pluginKey: this.pluginKey,
        runtimeGeneration: this.runtimeGeneration,
        context: {
          accountId: this.#options.accountId,
          conversation: { kind: input.conversation.kind, peerId: input.conversation.peerId },
          scope: prepared.scope,
          turnId: input.turnId,
          history: input.history,
          config: input.config ?? {},
          outcome: input.outcome,
          ...(input.replyText ? { replyText: truncate(input.replyText, PLUGIN_RUNTIME_LIMITS.maxMessageBytes) } : {}),
          ...(input.errorCode ? { errorCode: input.errorCode } : {})
        },
        state: prepared.state
      }, { conversation: input.conversation, contextEpoch: input.contextEpoch, signal: input.signal, guard: input.guard, deadlineAt });
      if (response.task === 'afterTurn') await this.#writeState(prepared, response.state, input);
    } catch (error) {
      this.#options.logger.warn('plugin afterTurn failed', {
        pluginKey: this.pluginKey,
        reason: safeReason(error)
      });
    }
  }

  async #callTool(input: PluginToolInput): Promise<ToolHandlerOutcome> {
    if (this.#terminated) throw new AccompanyError(this.#unavailableReason ?? 'plugin_runtime_terminated', 'plugin runtime is terminated');
    if (!this.#tools.has(input.toolId)) throw new AccompanyError('handler_not_ready', 'plugin tool handler is not ready');
    const full = parsePluginToolId(input.toolId);
    const declaration = (this.#plugin.manifest.tools ?? []).find((tool) => tool.id === full.localId);
    if (!declaration) throw new AccompanyError('handler_not_ready', 'plugin tool declaration is missing');
    try {
      await this.#assertExecutionCurrent(input.conversation, input);
    } catch (error) {
      return { status: 'error', errorCode: safeReason(error), text: '插件执行资格已失效。' };
    }
    const prepared = await this.#prepare(input.conversation, input.contextEpoch, input);
    if (!prepared.ok) {
      return { status: 'error', errorCode: prepared.reason, text: '插件状态命名空间不可用。' };
    }
    const timeout = Math.min(declaration.timeoutMs, Math.max(1, (input.deadlineAt ?? Date.now() + declaration.timeoutMs) - Date.now()));
    let dispatched = false;
    try {
      const response = await this.#request({
        type: 'tool',
        id: ++this.#requestSeq,
        timeoutMs: timeout,
        deadlineAt: input.deadlineAt ?? Date.now() + declaration.timeoutMs,
        scopeToken: prepared.scopeToken,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        accountId: this.#options.accountId,
        pluginKey: this.pluginKey,
        runtimeGeneration: this.runtimeGeneration,
        toolId: input.toolId,
        declaredToolId: full.localId,
        invocationId: input.invocationId,
        args: input.args,
        context: {
          accountId: this.#options.accountId,
          conversation: { kind: input.conversation.kind, peerId: input.conversation.peerId },
          scope: prepared.scope,
          invocationId: input.invocationId,
          config: this.#plugin.config
        },
        state: prepared.state
      }, {
        conversation: input.conversation,
        contextEpoch: input.contextEpoch,
        signal: input.signal,
        guard: input.guard,
        deadlineAt: input.deadlineAt,
        onDispatch: () => { dispatched = true; }
      });
      if (response.error) {
        if ('state' in response) await this.#writeState(prepared, response.state, input);
        if (response.errorCode === 'plugin_handler_timeout') {
          return { status: declaration.effect === 'action' ? 'unknown' : 'error', errorCode: 'plugin_handler_timeout', text: '插件工具超时，结果不可确认。' };
        }
        return { status: 'error', errorCode: 'plugin_handler_failed', text: sanitizeErrorText(response.error, PLUGIN_RUNTIME_LIMITS.maxErrorText) };
      }
      if (response.task !== 'tool') return { status: 'error', errorCode: 'invalid_plugin_result', text: '插件返回了无效工具结果。' };
      const outcome = response.result;
      if (!outcome || (outcome.status !== 'ok' && outcome.status !== 'error' && outcome.status !== 'submitted')) {
        await this.#writeState(prepared, response.state, input);
        return { status: 'error', errorCode: 'invalid_plugin_result', text: '插件返回了无效工具结果。' };
      }
      const written = await this.#writeState(prepared, response.state, input);
      if (!written && (outcome.status === 'ok' || outcome.status === 'submitted')) {
        return { status: 'unknown', errorCode: 'plugin_state_write_failed', text: '插件动作已提交，但状态结果未能持久化。' };
      }
      return outcome;
    } catch (error) {
      // Once postMessage succeeds the plugin may have started an external action.
      // A later guard revocation, stop, timeout, or worker failure cannot be
      // reported as a definite failure because the host cannot roll that action back.
      if (dispatched && declaration.effect === 'action') {
        return {
          status: 'unknown',
          errorCode: safeReason(error),
          text: '插件动作已派发，但执行被中断，结果未知。'
        };
      }
      if (error instanceof AccompanyError && (error.code === 'plugin_timeout' || error.code === 'plugin_handler_timeout')) {
        return { status: 'unknown', errorCode: 'plugin_timeout', text: '插件工具可能已执行，但结果未知。' };
      }
      if ((input.signal?.aborted || (error instanceof AccompanyError && error.code === 'plugin_cancelled')) && declaration.effect === 'action') {
        return { status: 'unknown', errorCode: 'cancelled', text: '插件动作可能已开始，但结果未知。' };
      }
      return { status: 'error', errorCode: safeReason(error), text: '插件工具执行失败。' };
    }
  }

  async #prepare(conversation: ConversationRef, contextEpoch: string, execution?: PluginHookInput | PluginToolInput): Promise<
    | { ok: true; scope: PluginScopeToken; scopeToken: string; state: Record<string, unknown>; stateSerialized: string }
    | { ok: false; reason: string }
  > {
    await this.#ensure();
    if (execution) await this.#assertExecutionCurrent(conversation, execution);
    const stateDeclaration = this.#plugin.manifest.state ?? { version: '1', accountShared: false };
    const accountShared = stateDeclaration.accountShared
      && resolveExtensionSwitch(this.#options.accountPolicy(), conversation, 'state', this.pluginKey, 'off').value === 'on';
    const scope: PluginScopeToken = {
      kind: conversation.kind,
      peerId: conversation.peerId,
      contextEpoch,
      accountShared
    };
    const scopeToken = pluginScopeTokenString(scope);
    const read = await this.#options.state.read(
      {
        source: this.#plugin.ref.source as 'public' | 'private',
        pluginId: this.#plugin.ref.id,
        kind: conversation.kind,
        peerId: conversation.peerId,
        contextEpoch,
        accountShared
      },
      stateDeclaration.version
    );
    if (read.status === 'conflict') return { ok: false, reason: 'plugin_state_version_conflict' };
    if (read.status === 'unavailable') return { ok: false, reason: read.reason };
    const state = read.status === 'ready' ? read.state : {};
    if (execution) await this.#assertExecutionCurrent(conversation, execution);
    return { ok: true, scope, scopeToken, state, stateSerialized: JSON.stringify(state) };
  }

  async #writeState(
    prepared: { ok: true; scope: PluginScopeToken; stateSerialized: string } | { ok: false; reason: string },
    value: Record<string, unknown> | undefined,
    execution?: PluginHookInput | PluginToolInput
  ): Promise<boolean> {
    if (!prepared.ok || !validState(value) || this.#terminated) return false;
    if (execution) {
      try { await this.#assertExecutionCurrent(execution.conversation, execution); }
      catch { return false; }
    }
    if (JSON.stringify(value) === prepared.stateSerialized) return true;
    const stateVersion = this.#plugin.manifest.state?.version ?? '1';
    try {
      await this.#options.state.write(
        {
          source: this.#plugin.ref.source as 'public' | 'private',
          pluginId: this.#plugin.ref.id,
          kind: prepared.scope.kind,
          peerId: prepared.scope.peerId,
          contextEpoch: prepared.scope.contextEpoch,
          accountShared: prepared.scope.accountShared
        },
        stateVersion,
        value,
        Date.now(),
        { guard: execution ? () => this.#executionGuard(execution) : undefined }
      );
      return true;
    } catch (error) {
      this.#options.logger.warn('plugin state write failed', {
        pluginKey: this.pluginKey,
        reason: safeReason(error)
      });
      return false;
    }
  }

  #hookTimeout(name: PluginHookName): number {
    return Math.min(
      PLUGIN_HOOK_BUDGET.singleHookMs,
      (this.#plugin.manifest.hooks ?? []).find((hook) => hook.name === name)?.timeoutMs ?? PLUGIN_HOOK_BUDGET.singleHookMs
    );
  }

  #pluginEnabled(conversation: ConversationRef): boolean {
    if (conversation.accountId !== this.#options.accountId) return false;
    return resolvePluginSwitch(this.#options.accountPolicy(), conversation, this.pluginKey).value === 'on';
  }

  async #executionGuard(execution: { conversation: ConversationRef; contextEpoch: string; signal?: AbortSignal; guard?: () => boolean | Promise<boolean>; deadlineAt?: number }): Promise<boolean> {
    if (this.#terminated || this.#stopRequested || execution.signal?.aborted) return false;
    if (!validContextEpoch(execution.contextEpoch)) return false;
    if (execution.deadlineAt !== undefined && Date.now() >= execution.deadlineAt) return false;
    if (!this.#pluginEnabled(execution.conversation)) return false;
    if (execution.guard && !(await execution.guard())) return false;
    return !this.#terminated && !this.#stopRequested && !execution.signal?.aborted
      && (execution.deadlineAt === undefined || Date.now() < execution.deadlineAt)
      && this.#pluginEnabled(execution.conversation);
  }

  async #assertExecutionCurrent(
    conversation: ConversationRef,
    execution: { contextEpoch?: string; signal?: AbortSignal; guard?: () => boolean | Promise<boolean>; deadlineAt?: number }
  ): Promise<void> {
    if (this.#terminated || this.#stopRequested) throw new AccompanyError('plugin_runtime_terminated', 'plugin runtime is terminated');
    if (conversation.accountId !== this.#options.accountId) throw new IsolationError('plugin context account does not match its runtime');
    if (!validContextEpoch(execution.contextEpoch)) throw new AccompanyError('plugin_context_epoch_missing', 'plugin task requires the role history epoch');
    if (execution.signal?.aborted) throw new AccompanyError('cancelled', 'plugin task was cancelled');
    if (execution.deadlineAt !== undefined && Date.now() >= execution.deadlineAt) throw new AccompanyError('plugin_timeout', 'plugin task deadline elapsed');
    if (!this.#pluginEnabled(conversation)) throw new AccompanyError('plugin_switch_off', 'plugin is disabled for this conversation');
    if (execution.guard) {
      try {
        if (!(await execution.guard())) throw new AccompanyError('plugin_execution_guard_changed', 'plugin task authorization changed');
      } catch (error) {
        if (error instanceof AccompanyError) throw error;
        throw new AccompanyError('plugin_execution_guard_failed', 'plugin task authorization could not be checked');
      }
    }
    if (execution.signal?.aborted) throw new AccompanyError('cancelled', 'plugin task was cancelled');
    if (execution.deadlineAt !== undefined && Date.now() >= execution.deadlineAt) throw new AccompanyError('plugin_timeout', 'plugin task deadline elapsed');
    if (!this.#pluginEnabled(conversation)) throw new AccompanyError('plugin_switch_off', 'plugin is disabled for this conversation');
  }

  #cancelGeneration(requestId: number, reason: string): void {
    if (this.#terminated) return;
    const worker = this.#worker;
    if (worker) {
      try { worker.postMessage({ type: 'cancel', id: requestId }); } catch { /* already exiting */ }
    }
    this.#terminated = true;
    this.#ready = false;
    this.#unavailableReason = 'plugin_runtime_terminated';
    this.#tools.clear();
    this.#hooks.clear();
    this.#failAll('plugin_runtime_terminated', reason);
    this.#worker = undefined;
    this.#handshake = undefined;
    if (worker) {
      // Give the cancel notification a short cooperative window, but track the actual
      // termination so close()/stop() cannot report completion during that window.
      this.#termination ??= new Promise<void>((resolve) => setTimeout(resolve, 25))
        .then(() => worker.terminate())
        .catch(() => 0);
    }
  }

  #failAll(reason: string, detail: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new AccompanyError(reason, detail));
    }
    this.#pending.clear();
  }

  #terminate(reason: string): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#ready = false;
    this.#unavailableReason = 'plugin_runtime_terminated';
    const rejectInitialization = this.#initializationReject;
    this.#initializationReject = undefined;
    rejectInitialization?.(new AccompanyError('plugin_runtime_terminated', reason));
    this.#tools.clear();
    this.#hooks.clear();
    this.#failAll('plugin_runtime_terminated', reason);
    const worker = this.#worker;
    if (worker) this.#termination ??= worker.terminate().catch(() => 0);
    this.#worker = undefined;
    this.#handshake = undefined;
  }
}

function validState(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= PLUGIN_RUNTIME_LIMITS.maxStateBytes;
  } catch {
    return false;
  }
}

function validHookInput(input: PluginHookInput, pluginConfig: Record<string, unknown> = input.config ?? {}): boolean {
  if (!input.turnId || input.turnId.length > 128) return false;
  if (input.message && Buffer.byteLength(input.message.text, 'utf8') > PLUGIN_RUNTIME_LIMITS.maxMessageBytes) return false;
  if (input.history.length > PLUGIN_RUNTIME_LIMITS.maxHistoryItems) return false;
  try {
    return Buffer.byteLength(JSON.stringify({ history: input.history, config: pluginConfig }), 'utf8') <= PLUGIN_RUNTIME_LIMITS.maxHistoryBytes;
  } catch {
    return false;
  }
}

function validContextEpoch(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 2_048;
}

function validAdditions(value: unknown): value is PluginBeforeContextResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const additions = (value as { additions?: unknown }).additions;
  if (!Array.isArray(additions) || additions.length > PLUGIN_RUNTIME_LIMITS.maxAdditions) return false;
  let total = 0;
  for (const entry of additions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as { source?: unknown; text?: unknown };
    if (typeof item.source !== 'string' || item.source.length > PLUGIN_RUNTIME_LIMITS.maxAdditionSource) return false;
    if (typeof item.text !== 'string' || Buffer.byteLength(item.text, 'utf8') > PLUGIN_RUNTIME_LIMITS.maxAdditionBytes) return false;
    total += Buffer.byteLength(`${item.source}${item.text}`, 'utf8');
  }
  return total <= PLUGIN_RUNTIME_LIMITS.maxHookResultBytes;
}

function boundedJson(value: unknown, maxBytes: number, label: string): Record<string, unknown> {
  const safe = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  try {
    const body = JSON.stringify(safe);
    if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new AccompanyError('plugin_config_too_large', `${label} exceeds its bound`);
    return JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccompanyError) throw error;
    throw new AccompanyError('invalid_plugin_config', `${label} must be JSON serializable`);
  }
}

function parsePluginToolId(value: string): { source: 'public' | 'private'; pluginId: string; localId: string } {
  const match = /^(public|private)\/plugin\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new AccompanyError('invalid_plugin_tool_id', `invalid plugin tool id ${value}`);
  return { source: match[1] as 'public' | 'private', pluginId: match[2]!, localId: match[3]! };
}

function safeReason(error: unknown): string {
  if (error instanceof AccompanyError) return /^[a-z][a-z0-9._-]{0,63}$/.test(error.code) ? error.code : 'plugin_failed';
  return 'plugin_failed';
}

function truncate(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export { pluginScopeTokenString };
export type { PluginScopeToken };
