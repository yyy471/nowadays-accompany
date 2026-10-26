import crypto from 'node:crypto';
import type { Logger } from '../../core/logger.js';
import { AccompanyError, InvalidSpecError, IsolationError } from '../../core/errors.js';
import type { ConversationRef } from '../../routing/identity.js';
import type { ToolInvocationResult, ToolInvocationStatus } from '../contracts.js';
import { validateToolArguments } from '../schema.js';
import type { RegisteredToolDefinition } from '../types.js';
import { stableStringify } from '../../providers/types.js';
import { sanitizeErrorText } from '../../platform/security/redaction.js';
import {
  TOOL_LEDGER_LIMITS,
  ToolInvocationStore,
  toolArgumentDigest,
  toolInvocationId,
  toolInvocationKey,
  toolLedgerPath,
  type ToolLedgerBegin
} from './ledger.js';
import { ToolConcurrencyLimiter, type ToolConcurrencyLimits } from './limiter.js';

export const TOOL_EXECUTION_LIMITS = {
  maxCallsPerBatch: 4,
  maxArgumentBytes: 16 * 1024,
  maxResultBytes: 8 * 1024,
  maxRoundResultBytes: 24 * 1024,
  toolTimeoutMs: 30_000,
  drainTimeoutMs: 5_000,
  maxCallIdLength: 200
} as const;

export interface ToolExecutionLimits extends ToolConcurrencyLimits {
  toolTimeoutMs?: number;
  maxResultBytes?: number;
  maxRoundResultBytes?: number;
  drainTimeoutMs?: number;
}

export interface ToolHandlerContext {
  accountId: string;
  conversation: ConversationRef;
  invocationId: string;
  invocationKey: string;
  tool: RegisteredToolDefinition;
  signal: AbortSignal;
  deadlineAt: number;
  guard?: () => boolean | Promise<boolean>;
  logger: Logger;
  contextEpoch?: string;
  runtimeGeneration?: string;
}

export interface ToolHandlerOutcome {
  status: ToolInvocationStatus;
  text?: string;
  data?: unknown;
  errorCode?: string;
  jobId?: string;
  media?: NonNullable<ToolInvocationResult['media']>;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolHandlerContext
) => ToolHandlerOutcome | Promise<ToolHandlerOutcome>;

export interface ToolHandlerBinding {
  /** Runtime generation/handler version; a change invalidates the prepared call. */
  generation: string;
  handler: ToolHandler;
}

export type ToolHandlerResolver = (toolId: string) => ToolHandlerBinding | undefined;

export interface ToolView {
  tools: readonly RegisteredToolDefinition[];
  authorized: ReadonlySet<string>;
}

export type ToolViewProvider = (accountId: string, conversation: ConversationRef) => ToolView | Promise<ToolView>;

export interface ToolExecutorOptions {
  view: ToolViewProvider;
  handlers: ToolHandlerResolver;
  accountDir: (accountId: string) => string;
  logger: Logger;
  now?: () => number;
  limits?: ToolExecutionLimits;
  /** Shared across accounts when one process must bound global tool concurrency; then closed by the owner. */
  limiter?: ToolConcurrencyLimiter;
  /** Test/embedding seam; production uses the account ledger path. */
  storeFactory?: (filePath: string) => Promise<ToolInvocationStore>;
}

export interface ToolCallRequest {
  /** Model-provided opaque id; omitted calls get a deterministic internal id. */
  callId?: string;
  /** Model-facing name from this round's mapping. */
  name: string;
  /** Parsed JSON arguments; strings are rejected rather than parsed here. */
  arguments: unknown;
}

export interface ToolBatchContext {
  accountId: string;
  conversation: ConversationRef;
  /** Stable inbound message id or seq; must not be a wall-clock value. */
  messageId: string;
  /** Zero-based model round within this turn; part of the invocation identity. */
  turn: number;
  toolIdsByModelName: ReadonlyMap<string, string>;
  signal: AbortSignal;
  guard?: () => boolean | Promise<boolean>;
  remainingCalls?: number;
  remainingResultBytes?: number;
  contextEpoch?: string;
  runtimeGeneration?: string;
  /** Turn-scoped host handlers (built-in media tools); consulted before the executor resolver. */
  extraHandlers?: ToolHandlerResolver;
}

export interface ToolBatchResult {
  results: ToolInvocationResult[];
  executed: number;
  replayed: number;
  bytes: number;
  preflightFailed: boolean;
}

interface PreparedCall {
  index: number;
  invocationId: string;
  invocationKey: string;
  toolId: string;
  tool: RegisteredToolDefinition;
  handler: ToolHandlerBinding;
  args: Record<string, unknown>;
  argumentDigest: string;
}

interface Gate {
  ok: boolean;
  code?: string;
  fatal?: boolean;
}

/** Handlers throw this to expose a safe business code instead of an arbitrary error message. */
export class ToolExecutionError extends AccompanyError {
  constructor(code: string, message = '工具执行失败。') {
    super(code, message);
  }
}

/**
 * Unified tool admission and execution. A batch with any preflight failure performs zero side
 * effects; each admitted call still revalidates authorization, handler generation and guards
 * immediately before the side effect. The ledger is written before action tools run.
 */
export class ToolExecutor {
  readonly #options: ToolExecutorOptions;
  readonly #limiter: ToolConcurrencyLimiter;
  readonly #ownsLimiter: boolean;
  readonly #stores = new Map<string, Promise<ToolInvocationStore>>();
  readonly #closing = new AbortController();
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #now: () => number;
  readonly #toolTimeoutMs: number;
  readonly #maxResultBytes: number;
  readonly #maxRoundResultBytes: number;
  readonly #drainTimeoutMs: number;
  #closed = false;

  constructor(options: ToolExecutorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#ownsLimiter = options.limiter === undefined;
    this.#limiter = options.limiter ?? new ToolConcurrencyLimiter(options.limits);
    this.#toolTimeoutMs = positiveInt(options.limits?.toolTimeoutMs, TOOL_EXECUTION_LIMITS.toolTimeoutMs);
    this.#maxResultBytes = positiveInt(options.limits?.maxResultBytes, TOOL_EXECUTION_LIMITS.maxResultBytes);
    this.#maxRoundResultBytes = positiveInt(options.limits?.maxRoundResultBytes, TOOL_EXECUTION_LIMITS.maxRoundResultBytes);
    this.#drainTimeoutMs = positiveInt(options.limits?.drainTimeoutMs, TOOL_EXECUTION_LIMITS.drainTimeoutMs);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get active(): number {
    return this.#limiter.running;
  }

  async executeBatch(calls: ToolCallRequest[], context: ToolBatchContext): Promise<ToolBatchResult> {
    if (context.accountId !== context.conversation.accountId) {
      throw new IsolationError('tool batch account does not match the conversation account');
    }
    assertBatchContext(context);
    if (calls.length === 0) {
      return { results: [], executed: 0, replayed: 0, bytes: 0, preflightFailed: false };
    }
    if (this.#closed) {
      return this.#batchReject(calls, context, 'executor_closed', '工具执行器正在关闭。');
    }
    const remainingCalls = boundedBudget(context.remainingCalls, TOOL_EXECUTION_LIMITS.maxCallsPerBatch);
    if (calls.length > TOOL_EXECUTION_LIMITS.maxCallsPerBatch || calls.length > remainingCalls) {
      return this.#batchReject(calls, context, 'tool_call_limit', '工具调用次数超过本轮预算。');
    }

    const duplicate = findDuplicateCallId(calls);
    if (duplicate) {
      return this.#batchReject(calls, context, 'duplicate_call_id', '同批工具调用包含重复调用 ID。');
    }

    let view: ToolView;
    try {
      view = await this.#options.view(context.accountId, context.conversation);
    } catch (error) {
      this.#options.logger.warn('tool view unavailable', { message: safeError(error) });
      return this.#batchReject(calls, context, 'tool_unavailable', '当前工具目录不可用。');
    }

    const prepared: PreparedCall[] = [];
    const issues = new Map<number, { code: string; text: string }>();
    for (const [index, call] of calls.entries()) {
      const result = this.#prepare(index, call, context, view);
      if ('issue' in result) issues.set(index, result.issue);
      else prepared.push(result.prepared);
    }
    if (issues.size > 0) {
      const results = calls.map((call, index) => {
        const issue = issues.get(index);
        return this.#result(
          this.#rejectionId(call, context, index),
          'error',
          issue?.code ?? 'batch_rejected',
          issue?.text ?? '同批其他工具调用预检失败，本批未执行任何工具。'
        );
      });
      return { results, executed: 0, replayed: 0, bytes: 0, preflightFailed: true };
    }

    const results: ToolInvocationResult[] = [];
    let remainingBytes = boundedBudget(context.remainingResultBytes, this.#maxRoundResultBytes);
    let executed = 0;
    let replayed = 0;
    let bytes = 0;
    let stopCode: string | undefined;
    let stopText: string | undefined;

    for (const [position, call] of prepared.entries()) {
      if (stopCode) {
        const bounded = this.#bound(this.#result(call.invocationId, 'error', stopCode, stopText ?? '后续工具调用未执行。'), remainingBytes);
        results.push(bounded.result);
        bytes += bounded.bytes;
        remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
        continue;
      }
      if (remainingBytes < 128) {
        const bounded = this.#bound(this.#result(call.invocationId, 'error', 'round_budget_exhausted', '本轮工具结果预算已用尽。'), remainingBytes);
        results.push(bounded.result);
        bytes += bounded.bytes;
        stopCode = 'round_budget_exhausted';
        stopText = gateText('round_budget_exhausted');
        continue;
      }
      const gate = await this.#gate(call, context);
      if (!gate.ok) {
        const bounded = this.#bound(this.#result(call.invocationId, 'error', gate.code!, gateText(gate.code!)), remainingBytes);
        results.push(bounded.result);
        bytes += bounded.bytes;
        remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
        if (gate.fatal) {
          stopCode = gate.code;
          stopText = gateText(gate.code!);
        }
        continue;
      }
      let release: (() => void) | undefined;
      try {
        try {
          release = await this.#limiter.acquire(context.accountId, context.signal);
        } catch (error) {
          const code = errorCode(error, 'tool_queue_full');
          const bounded = this.#bound(this.#result(call.invocationId, 'error', code, gateText(code)), remainingBytes);
          results.push(bounded.result);
          bytes += bounded.bytes;
          remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
          if (code === 'tool_executor_closed' || code === 'cancelled') {
            stopCode = code;
            stopText = gateText(code);
          }
          continue;
        }
        const afterQueue = await this.#gate(call, context);
        if (!afterQueue.ok) {
          const bounded = this.#bound(this.#result(call.invocationId, 'error', afterQueue.code!, gateText(afterQueue.code!)), remainingBytes);
          results.push(bounded.result);
          bytes += bounded.bytes;
          remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
          if (afterQueue.fatal) {
            stopCode = afterQueue.code;
            stopText = gateText(afterQueue.code!);
          }
          continue;
        }

        const store = await this.#storeFor(context.accountId);
        let begin: ToolLedgerBegin;
        try {
          begin = await store.begin({
            key: call.invocationKey,
            invocationId: call.invocationId,
            scope: {
              accountId: context.accountId,
              kind: context.conversation.kind,
              peerId: context.conversation.peerId,
              messageId: context.messageId,
              turn: context.turn,
              index: call.index,
              ...(context.contextEpoch !== undefined ? { contextEpoch: context.contextEpoch } : {}),
              ...(context.runtimeGeneration ? { runtimeGeneration: context.runtimeGeneration } : {})
            },
            toolId: call.toolId,
            effect: call.tool.effect,
            handlerGeneration: call.handler.generation,
            argumentDigest: call.argumentDigest,
            at: this.#now()
          });
        } catch (error) {
          const code = errorCode(error, 'ledger_unavailable');
          const bounded = this.#bound(this.#result(call.invocationId, 'error', code, gateText(code)), remainingBytes);
          results.push(bounded.result);
          bytes += bounded.bytes;
          remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
          stopCode = code;
          stopText = gateText(code);
          continue;
        }

        if (begin.kind === 'replay') {
          const bounded = this.#bound(begin.result, remainingBytes);
          results.push(bounded.result);
          bytes += bounded.bytes;
          remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
          replayed += 1;
          continue;
        }
        if (begin.kind === 'conflict') {
          const bounded = this.#bound(this.#result(call.invocationId, 'error', 'invocation_conflict', '相同调用记录已存在但参数或处理器版本不同。'), remainingBytes);
          results.push(bounded.result);
          bytes += bounded.bytes;
          remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
          continue;
        }
        if (begin.kind === 'in_progress' || begin.kind === 'unknown') {
          const code = begin.kind === 'in_progress' ? 'invocation_in_progress' : 'invocation_unknown';
          const bounded = this.#bound(this.#result(call.invocationId, 'error', code, gateText(code)), remainingBytes);
          results.push(bounded.result);
          bytes += bounded.bytes;
          remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
          continue;
        }

        // The ledger write may have yielded while authorization or role scope changed.
        const beforeSideEffect = await this.#gate(call, context);
        if (!beforeSideEffect.ok) {
          const rejection = this.#result(call.invocationId, 'error', beforeSideEffect.code!, gateText(beforeSideEffect.code!));
          const completed = await this.#completeNoSideEffect(store, call, rejection);
          const bounded = this.#bound(completed, remainingBytes);
          results.push(bounded.result);
          bytes += bounded.bytes;
          remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
          if (beforeSideEffect.fatal) {
            stopCode = beforeSideEffect.code;
            stopText = gateText(beforeSideEffect.code!);
          }
          continue;
        }

        executed += 1;
        const invocation = await this.#invoke(call, context);
        const perCallLimit = Math.min(call.tool.maxResultBytes, this.#maxResultBytes, remainingBytes);
        let result: ToolInvocationResult;
        if (invocation.kind === 'outcome') {
          result = this.#bound(this.#normalizeOutcome(call.invocationId, invocation.outcome), perCallLimit).result;
          const completion = await this.#complete(store, call, result);
          if (!completion.ok) {
            result = this.#result(call.invocationId, call.tool.effect === 'action' ? 'unknown' : 'error', 'ledger_write_failed', '工具结果未能写入调用账本。');
            stopCode = 'ledger_unavailable';
            stopText = gateText('ledger_unavailable');
          } else {
            result = completion.result;
          }
        } else if (invocation.kind === 'timeout' || invocation.kind === 'cancelled' || invocation.kind === 'closed') {
          const code = invocation.kind === 'timeout' ? 'tool_timeout' : invocation.kind === 'cancelled' ? 'cancelled' : 'executor_closed';
          if (call.tool.effect === 'action') {
            try {
              await store.markUnknown(call.invocationKey, code, this.#now());
            } catch {
              // The on-disk started intent is recovered as unknown on the next load.
            }
            result = this.#result(call.invocationId, 'unknown', code, '工具动作可能已开始，但结果未知。');
          } else {
            const completed = await this.#complete(store, call, this.#result(call.invocationId, 'error', code, gateText(code)));
            result = completed.ok
              ? completed.result
              : this.#result(call.invocationId, 'error', 'ledger_write_failed', '工具结果未能写入调用账本。');
            if (!completed.ok) {
              stopCode = 'ledger_unavailable';
              stopText = gateText('ledger_unavailable');
            }
          }
          if (invocation.kind !== 'timeout') {
            stopCode = code;
            stopText = gateText(code);
          }
        } else {
          const code = invocation.code;
          result = this.#result(call.invocationId, 'error', code, invocation.text ?? gateText(code));
          const completed = await this.#complete(store, call, result);
          if (!completed.ok) {
            result = this.#result(call.invocationId, 'error', 'ledger_write_failed', '工具结果未能写入调用账本。');
            stopCode = 'ledger_unavailable';
            stopText = gateText('ledger_unavailable');
          } else {
            result = completed.result;
          }
        }

        const bounded = this.#bound(result, Math.min(call.tool.maxResultBytes, this.#maxResultBytes, remainingBytes));
        results.push(bounded.result);
        bytes += bounded.bytes;
        remainingBytes = Math.max(0, remainingBytes - bounded.bytes);
        if (remainingBytes === 0 && position < prepared.length - 1) {
          stopCode = 'round_budget_exhausted';
          stopText = gateText('round_budget_exhausted');
        }
      } finally {
        release?.();
      }
    }
    return { results, executed, replayed, bytes, preflightFailed: false };
  }

  /** Stop admissions, cancel local waits, and wait a bounded time for in-flight handlers. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing.abort(new AccompanyError('tool_executor_closed', 'tool executor is closed'));
    if (this.#ownsLimiter) this.#limiter.close();
    const inflight = [...this.#inflight];
    if (inflight.length > 0) {
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#drainTimeoutMs);
          timer.unref?.();
        })
      ]);
    }
    await Promise.allSettled([...this.#stores.values()].map(async (pending) => (await pending).close()));
    this.#stores.clear();
  }

  async drain(): Promise<void> {
    await this.#limiter.idle();
    await Promise.allSettled([...this.#stores.values()].map(async (pending) => (await pending).drain()));
  }

  #prepare(
    index: number,
    call: ToolCallRequest,
    context: ToolBatchContext,
    view: ToolView
  ): { prepared: PreparedCall } | { issue: { code: string; text: string } } {
    if (call.callId !== undefined && (typeof call.callId !== 'string' || call.callId.length > TOOL_EXECUTION_LIMITS.maxCallIdLength)) {
      return { issue: { code: 'invalid_call_id', text: '工具调用 ID 无效。' } };
    }
    const callId = call.callId || undefined;
    if (typeof call.name !== 'string' || !call.name || call.name.length > 64) {
      return { issue: { code: 'unknown_tool', text: '模型请求了未知工具。' } };
    }
    const toolId = context.toolIdsByModelName.get(call.name);
    if (!toolId) return { issue: { code: 'unknown_tool', text: '模型请求了本轮未提供的工具。' } };
    const tool = view.tools.find((entry) => entry.id === toolId);
    if (!tool) return { issue: { code: 'tool_unavailable', text: '工具当前不可用。' } };
    if (!view.authorized.has(toolId)) {
      return { issue: { code: 'tool_not_authorized', text: '账号未授权该工具。' } };
    }
    const handler = this.#resolveHandler(context, toolId);
    if (!handler || typeof handler.handler !== 'function' || !validGeneration(handler.generation)) {
      return { issue: { code: 'handler_not_ready', text: '工具没有可执行的处理器。' } };
    }
    if (typeof call.arguments === 'string') {
      return { issue: { code: 'invalid_arguments', text: '工具参数必须是已解析的 JSON 对象。' } };
    }
    let args: Record<string, unknown>;
    let serialized: string;
    try {
      args = call.arguments as Record<string, unknown>;
      serialized = JSON.stringify(args);
    } catch {
      return { issue: { code: 'invalid_arguments', text: '工具参数必须是可序列化的 JSON 对象。' } };
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { issue: { code: 'invalid_arguments', text: '工具参数必须是 JSON 对象。' } };
    }
    const argumentLimit = Math.min(tool.maxArgumentBytes, TOOL_EXECUTION_LIMITS.maxArgumentBytes);
    if (Buffer.byteLength(serialized, 'utf8') > argumentLimit) {
      return { issue: { code: 'arguments_too_large', text: '工具参数超过本轮上限。' } };
    }
    try {
      validateToolArguments(tool.inputSchema, args);
    } catch (error) {
      const detail = error instanceof InvalidSpecError ? ` ${error.message}` : '';
      return { issue: { code: 'invalid_arguments', text: `工具参数不符合输入 schema。${detail}`.trim() } };
    }
    let argumentDigest: string;
    try {
      argumentDigest = toolArgumentDigest(args);
    } catch {
      return { issue: { code: 'invalid_arguments', text: '工具参数必须是可序列化的 JSON 对象。' } };
    }
    const key = toolInvocationKey({
      accountId: context.accountId,
      kind: context.conversation.kind,
      peerId: context.conversation.peerId,
      messageId: context.messageId,
      turn: context.turn,
      index,
      ...(context.contextEpoch !== undefined ? { contextEpoch: context.contextEpoch } : {}),
      ...(context.runtimeGeneration ? { runtimeGeneration: context.runtimeGeneration } : {}),
      ...(callId ? { callId } : {}),
      toolId
    });
    return {
      prepared: {
        index,
        invocationId: toolInvocationId(key, callId),
        invocationKey: key,
        toolId,
        tool,
        handler,
        args,
        argumentDigest
      }
    };
  }

  async #gate(call: PreparedCall, context: ToolBatchContext): Promise<Gate> {
    if (this.#closed) return { ok: false, code: 'executor_closed', fatal: true };
    if (context.signal.aborted) return { ok: false, code: 'cancelled', fatal: true };
    let view: ToolView;
    try {
      view = await this.#options.view(context.accountId, context.conversation);
    } catch {
      return { ok: false, code: 'tool_unavailable', fatal: true };
    }
    const tool = view.tools.find((entry) => entry.id === call.toolId);
    if (!tool) return { ok: false, code: 'tool_unavailable' };
    if (!view.authorized.has(call.toolId)) return { ok: false, code: 'tool_not_authorized' };
    const handler = this.#resolveHandler(context, call.toolId);
    if (!handler || handler.generation !== call.handler.generation) {
      return { ok: false, code: 'handler_changed' };
    }
    if (context.guard) {
      try {
        if (!(await context.guard())) return { ok: false, code: 'guard_changed', fatal: true };
      } catch {
        return { ok: false, code: 'guard_failed', fatal: true };
      }
    }
    if (context.signal.aborted) return { ok: false, code: 'cancelled', fatal: true };
    return { ok: true };
  }

  #resolveHandler(context: ToolBatchContext, toolId: string): ToolHandlerBinding | undefined {
    try {
      return context.extraHandlers?.(toolId) ?? this.#options.handlers(toolId);
    } catch {
      return undefined;
    }
  }

  async #invoke(
    call: PreparedCall,
    context: ToolBatchContext
  ): Promise<
    | { kind: 'outcome'; outcome: unknown }
    | { kind: 'timeout' }
    | { kind: 'cancelled' }
    | { kind: 'closed' }
    | { kind: 'error'; code: string; text?: string }
  > {
    const timeoutMs = Math.min(call.tool.timeoutMs, this.#toolTimeoutMs);
    const timeout = AbortSignal.timeout(timeoutMs);
    let timedOut = false;
    timeout.addEventListener('abort', () => { timedOut = true; }, { once: true });
    const combined = AbortSignal.any([context.signal, this.#closing.signal, timeout]);
    const handlerContext: ToolHandlerContext = {
      accountId: context.accountId,
      conversation: context.conversation,
      invocationId: call.invocationId,
      invocationKey: call.invocationKey,
      tool: call.tool,
      signal: combined,
      deadlineAt: Date.now() + timeoutMs,
      // Revalidate the complete executor admission gate at the handler's commit
      // points (including after a plugin-manager queue wait), not just the
      // caller-supplied role guard.
      guard: async () => (await this.#gate(call, context)).ok,
      logger: this.#options.logger,
      ...(context.contextEpoch !== undefined ? { contextEpoch: context.contextEpoch } : {}),
      ...(context.runtimeGeneration ? { runtimeGeneration: context.runtimeGeneration } : {})
    };
    const handlerPromise = Promise.resolve().then(() => call.handler.handler(call.args, handlerContext));
    this.#inflight.add(handlerPromise);
    void handlerPromise.finally(() => this.#inflight.delete(handlerPromise)).catch(() => {});
    const aborted = new Promise<never>((_, reject) => {
      if (combined.aborted) {
        reject(combined.reason);
        return;
      }
      combined.addEventListener('abort', () => reject(combined.reason), { once: true });
    });
    try {
      const outcome = await Promise.race([handlerPromise, aborted]);
      if (combined.aborted) throw combined.reason;
      return { kind: 'outcome', outcome };
    } catch (error) {
      if (this.#closed) return { kind: 'closed' };
      if (context.signal.aborted) return { kind: 'cancelled' };
      if (timedOut || timeout.aborted) return { kind: 'timeout' };
      if (error instanceof AccompanyError) {
        return {
          kind: 'error',
          code: safeCode(error.code),
          text: sanitizeErrorText(error.message, 200)
        };
      }
      return { kind: 'error', code: 'tool_failed', text: '工具执行失败。' };
    } finally {
      // If the handler ignored aborts, its late settlement must never reach the ledger or model.
      handlerPromise.catch(() => {});
    }
  }

  #normalizeOutcome(invocationId: string, raw: unknown): ToolInvocationResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return this.#result(invocationId, 'error', 'invalid_tool_result', '工具返回了无效结果。');
    }
    const value = raw as Record<string, unknown>;
    const status = value.status;
    if (status !== 'ok' && status !== 'error' && status !== 'submitted' && status !== 'unknown') {
      return this.#result(invocationId, 'error', 'invalid_tool_result', '工具返回了无效状态。');
    }
    const errorCode = typeof value.errorCode === 'string' && safeCodePattern(value.errorCode)
      ? value.errorCode
      : (status === 'error' || status === 'unknown') ? 'tool_failed' : undefined;
    const text = typeof value.text === 'string' ? value.text : undefined;
    const data = jsonSerializable(value.data) ? value.data : undefined;
    const jobId = typeof value.jobId === 'string' && value.jobId.length <= 200 ? value.jobId : undefined;
    const media = parseMedia(value.media);
    return this.#result(invocationId, status as ToolInvocationStatus, errorCode, text, {
      ...(data !== undefined ? { data } : {}),
      ...(jobId ? { jobId } : {}),
      ...(media ? { media } : {})
    });
  }

  async #completeNoSideEffect(
    store: ToolInvocationStore,
    call: PreparedCall,
    result: ToolInvocationResult
  ): Promise<ToolInvocationResult> {
    const completed = await this.#complete(store, call, result);
    return completed.ok ? completed.result : result;
  }

  async #complete(
    store: ToolInvocationStore,
    call: PreparedCall,
    result: ToolInvocationResult
  ): Promise<{ ok: true; result: ToolInvocationResult } | { ok: false }> {
    try {
      return { ok: true, result: await store.complete(call.invocationKey, result, this.#now()) };
    } catch (error) {
      this.#options.logger.warn('tool ledger completion failed', {
        toolId: call.toolId,
        code: errorCode(error, 'tool_ledger_write_failed'),
        message: safeError(error)
      });
      return { ok: false };
    }
  }

  async #storeFor(accountId: string): Promise<ToolInvocationStore> {
    let pending = this.#stores.get(accountId);
    if (!pending) {
      const filePath = toolLedgerPath(this.#options.accountDir(accountId));
      pending = (this.#options.storeFactory?.(filePath) ?? ToolInvocationStore.load(filePath, this.#options.logger, this.#now));
      this.#stores.set(accountId, pending);
      pending.catch(() => this.#stores.delete(accountId));
    }
    return pending;
  }

  #result(
    invocationId: string,
    status: ToolInvocationStatus,
    errorCode?: string,
    text?: string,
    extra: Partial<Pick<ToolInvocationResult, 'data' | 'jobId' | 'media'>> = {}
  ): ToolInvocationResult {
    return {
      invocationId,
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(text ? { text } : {}),
      ...extra
    };
  }

  #bound(result: ToolInvocationResult, maxBytes: number): { result: ToolInvocationResult; bytes: number } {
    const limit = Math.max(0, maxBytes);
    let candidate = { ...result };
    let payload = payloadBytes(candidate);
    if (payload <= limit) return { result: candidate, bytes: payload };
    let truncated = true;
    if (candidate.text) {
      candidate = { ...candidate, text: truncateUtf8(candidate.text, Math.max(0, limit - 96)), truncated };
      payload = payloadBytes(candidate);
    }
    if (payload > limit && candidate.data !== undefined) {
      candidate = { ...candidate, data: undefined, truncated };
      payload = payloadBytes(candidate);
    }
    if (payload > limit && candidate.text) {
      candidate = { ...candidate, text: truncateUtf8(candidate.text, Math.max(0, limit - 64)), truncated };
      payload = payloadBytes(candidate);
    }
    if (payload > limit) {
      candidate = {
        invocationId: candidate.invocationId,
        status: candidate.status,
        errorCode: candidate.errorCode ?? 'result_too_large',
        truncated,
        text: truncateUtf8('', 0)
      };
      payload = payloadBytes(candidate);
    }
    return { result: candidate, bytes: payload };
  }

  #batchReject(calls: ToolCallRequest[], context: ToolBatchContext, code: string, text: string): ToolBatchResult {
    const results = calls.map((call, index) => this.#result(this.#rejectionId(call, context, index), 'error', code, text));
    return { results, executed: 0, replayed: 0, bytes: results.reduce((sum, result) => sum + payloadBytes(result), 0), preflightFailed: true };
  }

  #rejectionId(call: ToolCallRequest, context: ToolBatchContext, index: number): string {
    if (typeof call.callId === 'string' && call.callId && call.callId.length <= TOOL_EXECUTION_LIMITS.maxCallIdLength) {
      return call.callId;
    }
    const digest = crypto.createHash('sha256')
      .update(stableStringify({
        accountId: context.accountId,
        kind: context.conversation.kind,
        peerId: context.conversation.peerId,
        messageId: context.messageId,
        turn: context.turn,
        index
      }))
      .digest('hex')
      .slice(0, 16);
    return `tool_${digest}`;
  }
}

function assertBatchContext(context: ToolBatchContext): void {
  if (!context.messageId || context.messageId.length > TOOL_LEDGER_LIMITS.maxMessageIdLength) {
    throw new AccompanyError('invalid_tool_context', 'tool batch requires a stable bounded message id');
  }
  if (!Number.isSafeInteger(context.turn) || context.turn < 0) {
    throw new AccompanyError('invalid_tool_context', 'tool batch requires a non-negative model round');
  }
  if (!context.signal) throw new AccompanyError('invalid_tool_context', 'tool batch requires an abort signal');
}

function boundedBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, fallback);
}

function findDuplicateCallId(calls: ToolCallRequest[]): string | undefined {
  const seen = new Set<string>();
  for (const call of calls) {
    if (typeof call.callId !== 'string' || !call.callId) continue;
    if (seen.has(call.callId)) return call.callId;
    seen.add(call.callId);
  }
  return undefined;
}

function gateText(code: string): string {
  switch (code) {
    case 'unauthorized':
    case 'tool_not_authorized':
      return '账号未授权该工具。';
    case 'plugin_switch_off':
      return '插件已在当前会话关闭。';
    case 'switch_off':
      return '工具已在当前会话关闭。';
    case 'handler_not_ready':
      return '工具没有可执行的处理器。';
    case 'handler_changed':
      return '工具处理器已变化，请重新请求。';
    case 'tool_unavailable':
      return '工具当前不可用。';
    case 'capability_unavailable':
      return '工具依赖的模型能力不可用。';
    case 'guard_changed':
    case 'guard_failed':
      return '会话状态已变化，工具调用已取消。';
    case 'cancelled':
      return '工具调用已取消。';
    case 'executor_closed':
      return '工具执行器正在关闭。';
    case 'tool_timeout':
      return '工具执行超时。';
    case 'tool_queue_full':
      return '工具执行队列已满。';
    case 'tool_ledger_full':
    case 'ledger_full':
      return '工具调用账本已满，暂不能执行动作。';
    case 'tool_ledger_unavailable':
    case 'tool_ledger_corrupt':
    case 'tool_ledger_closed':
    case 'ledger_unavailable':
      return '工具调用账本不可用。';
    case 'invocation_in_progress':
      return '相同工具调用正在执行。';
    case 'invocation_unknown':
      return '相同工具调用的结果未知，不能自动重试。';
    case 'round_budget_exhausted':
      return '本轮工具结果预算已用尽。';
    default:
      return '工具调用未执行。';
  }
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof AccompanyError && safeCodePattern(error.code) ? error.code : fallback;
}

function safeCode(code: string): string {
  return safeCodePattern(code) ? code : 'tool_failed';
}

function safeCodePattern(code: string): boolean {
  return /^[a-z][a-z0-9._-]{0,63}$/.test(code);
}

function validGeneration(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= TOOL_LEDGER_LIMITS.maxGenerationLength;
}

function safeError(error: unknown): string {
  return sanitizeErrorText(error instanceof Error ? error.message : String(error), 200);
}

function jsonSerializable(value: unknown): boolean {
  if (value === undefined) return true;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function parseMedia(raw: unknown): NonNullable<ToolInvocationResult['media']> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.mediaId !== 'string' || !value.mediaId || value.mediaId.length > 200) return undefined;
  if (value.kind !== 'image' && value.kind !== 'audio' && value.kind !== 'video' && value.kind !== 'file') return undefined;
  if (value.mimeType !== undefined && (typeof value.mimeType !== 'string' || value.mimeType.length > 128)) return undefined;
  return {
    mediaId: value.mediaId,
    kind: value.kind,
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {})
  };
}

function payloadBytes(result: ToolInvocationResult): number {
  return Buffer.byteLength(JSON.stringify({
    status: result.status,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.jobId ? { jobId: result.jobId } : {}),
    ...(result.media ? { media: result.media } : {})
  }), 'utf8');
}

function truncateUtf8(text: string, maxBytes: number): string {
  const ellipsis = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'));
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= budget) return text;
  return `${buffer.subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, '')}${ellipsis}`;
}

function positiveInt(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new AccompanyError('invalid_limit', 'tool execution limit must be >= 1');
  }
  return resolved;
}
