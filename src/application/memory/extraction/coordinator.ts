import { AccompanyError } from '../../../core/errors.js';
import { Semaphore, withTimeout } from '../../../core/concurrency.js';
import type { Logger } from '../../../core/logger.js';
import type { ExtractionTurnCompletion } from '../../../core/extraction-events.js';
import type {
  MemoryExtractionQuotaView,
  MemoryExtractionRuntimeView,
  MemoryExtractionStatusView
} from '../../../contracts/memory.js';
import { conversationKey, type ConversationRef } from '../../../routing/identity.js';
import type { MessageStore } from '../../../storage/contract.js';
import { ExtractionAttemptError } from './errors.js';
import {
  EXTRACTION_INPUT_LIMITS,
  buildExtractionInput,
  type ExtractionInputBatch,
  type ExtractionScanResume
} from './input.js';
import type { ExtractionQuotaStore } from './quota.js';
import type { ExtractionAdvanceInput } from '../memory-service.js';

export interface ExtractionMemoryPort {
  status(conversation: ConversationRef): Promise<MemoryExtractionStatusView>;
  beginAttempt(
    conversation: ConversationRef,
    expectedScope: string,
    expectedGeneration: number,
    expectedThroughSeq: number,
    now: number
  ): Promise<{ started: boolean; reason?: string }>;
  recordFailure(
    conversation: ConversationRef,
    expectedScope: string,
    expectedGeneration: number,
    failure: { code: string; at: number; cooldownUntil?: number; fatal?: boolean }
  ): Promise<boolean>;
  advance(conversation: ConversationRef, input: ExtractionAdvanceInput): Promise<boolean>;
}

export interface ExtractionRunInput {
  completion: ExtractionTurnCompletion;
  /** Snapshot captured after the concurrency slot was acquired and revalidated. */
  status: MemoryExtractionStatusView;
  batch: ExtractionInputBatch;
  signal: AbortSignal;
  /** False after coordinator shutdown; late provider results must not commit. */
  isAdmitted(): boolean;
  now(): number;
}

export interface ExtractionRunner {
  run(input: ExtractionRunInput): Promise<void>;
}

export interface ExtractionCoordinatorLimits {
  /** New qualifying user text messages required before a paid call. */
  minNewTexts: number;
  /** Minimum gap from the previous attempt. */
  minIntervalMs: number;
  failureCooldownMs: number;
  globalConcurrency: number;
  maxPendingScopes: number;
  /** Records inspected by one admission scan before it must be resumed on a later trigger. */
  scanRecordsPerScan: number;
  shutdownTimeoutMs: number;
}

export const DEFAULT_EXTRACTION_COORDINATOR_LIMITS: ExtractionCoordinatorLimits = {
  minNewTexts: 6,
  minIntervalMs: 5 * 60_000,
  failureCooldownMs: 10 * 60_000,
  globalConcurrency: 2,
  maxPendingScopes: 32,
  scanRecordsPerScan: EXTRACTION_INPUT_LIMITS.maxScanRecords,
  shutdownTimeoutMs: 5_000
};

export interface ExtractionCoordinatorOptions {
  memories: ExtractionMemoryPort;
  quota: Pick<ExtractionQuotaStore, 'acquire' | 'snapshot'>;
  store: (accountId: string) => MessageStore;
  contextEpoch: (accountId: string, conversation: ConversationRef) => Promise<string | undefined>;
  runner: ExtractionRunner;
  /** Routes state-only scan advances through the same conversation queue as commits. */
  enqueue: (completion: ExtractionTurnCompletion, task: () => Promise<void>) => Promise<void>;
  now?: () => number;
  logger?: Logger;
  limits?: Partial<ExtractionCoordinatorLimits>;
}

interface ScopeState {
  completion: ExtractionTurnCompletion;
  running: boolean;
  pending: boolean;
}

interface CachedScanResume {
  scopeToken: string;
  generation: number;
  throughSeq: number;
  resume: ExtractionScanResume;
}

export interface ExtractionCoordinatorStatus {
  quota: MemoryExtractionQuotaView;
  runtime: MemoryExtractionRuntimeView;
}

/**
 * Minimal per-scope extraction coordinator. It never blocks normal messaging: notifications only
 * mark/merge a scope, and all model work runs under a bounded global semaphore.
 */
export class ExtractionCoordinator {
  readonly #options: ExtractionCoordinatorOptions;
  readonly #limits: ExtractionCoordinatorLimits;
  readonly #now: () => number;
  readonly #semaphore: Semaphore;
  readonly #controller = new AbortController();
  readonly #scopes = new Map<string, ScopeState>();
  readonly #tasks = new Set<Promise<void>>();
  /** In-process fail-closed breaker for scopes whose persisted pause/failure state could not be written. */
  readonly #breakers = new Map<string, { scopeToken: string; generation: number }>();
  /** Bounded in-process continuation for under-threshold admission scans. */
  readonly #scanResumes = new Map<string, CachedScanResume>();
  #closed = false;

  constructor(options: ExtractionCoordinatorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#limits = {
      ...DEFAULT_EXTRACTION_COORDINATOR_LIMITS,
      ...options.limits
    };
    assertPositiveInteger(this.#limits.minNewTexts, 'minNewTexts');
    assertPositiveInteger(this.#limits.minIntervalMs, 'minIntervalMs');
    assertPositiveInteger(this.#limits.failureCooldownMs, 'failureCooldownMs');
    assertPositiveInteger(this.#limits.globalConcurrency, 'globalConcurrency');
    assertPositiveInteger(this.#limits.maxPendingScopes, 'maxPendingScopes');
    assertPositiveInteger(this.#limits.scanRecordsPerScan, 'scanRecordsPerScan');
    assertPositiveInteger(this.#limits.shutdownTimeoutMs, 'shutdownTimeoutMs');
    this.#semaphore = new Semaphore(this.#limits.globalConcurrency);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Synchronous and non-blocking; only schedules work. */
  notify(completion: ExtractionTurnCompletion): void {
    if (this.#closed) return;
    if (!Number.isSafeInteger(completion.inboundSeq) || completion.inboundSeq < 0
      || !Number.isSafeInteger(completion.outboundSeq) || completion.outboundSeq < 0) return;
    const key = conversationKey(completion.conversation);
    const existing = this.#scopes.get(key);
    if (!existing) {
      if (this.#scopes.size >= this.#limits.maxPendingScopes) {
        this.#options.logger?.warn('memory extraction scope backlog full; trigger dropped', {
          accountId: completion.accountId,
          conversation: completion.conversation,
          pending: this.#scopes.size
        });
        return;
      }
      const state: ScopeState = { completion, running: true, pending: false };
      this.#scopes.set(key, state);
      this.#start(key, state);
      return;
    }
    if (completion.inboundSeq > existing.completion.inboundSeq
      || (completion.inboundSeq === existing.completion.inboundSeq && completion.outboundSeq > existing.completion.outboundSeq)) {
      existing.completion = completion;
    }
    if (existing.running) existing.pending = true;
    else this.#start(key, existing);
  }

  status(conversation: ConversationRef): ExtractionCoordinatorStatus {
    const key = conversationKey(conversation);
    const scope = this.#scopes.get(key);
    return {
      quota: this.#options.quota.snapshot(conversation.accountId, this.#now()),
      runtime: {
        running: scope?.running === true,
        pending: scope?.pending === true,
        circuitOpen: this.#breakers.has(key)
      }
    };
  }

  /** Stop admission and abort local waits; in-flight providers may ignore the signal. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort(new AccompanyError('core_stopped', 'memory extraction coordinator stopped'));
    for (const state of this.#scopes.values()) state.pending = false;
    this.#scanResumes.clear();
  }

  /** Bounded wait for in-flight attempts; late results cannot commit because close() aborted admission. */
  async drain(): Promise<void> {
    if (this.#tasks.size === 0) return;
    try {
      await withTimeout(
        Promise.allSettled([...this.#tasks]),
        this.#limits.shutdownTimeoutMs,
        'memory extraction drain timed out'
      );
    } catch (error) {
      this.#options.logger?.warn('memory extraction tasks did not finish before shutdown', {
        tasks: this.#tasks.size,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  #start(key: string, state: ScopeState): void {
    state.running = true;
    const task = this.#process(key, state)
      .catch(error => {
        if (!this.#closed) {
          this.#options.logger?.warn('memory extraction coordinator task failed', {
            accountId: state.completion.accountId,
            conversation: state.completion.conversation,
            message: safeMessage(error)
          });
        }
      })
      .finally(() => {
        this.#tasks.delete(task);
        const current = this.#scopes.get(key);
        if (current !== state) return;
        if (this.#closed) {
          this.#scopes.delete(key);
          return;
        }
        if (state.pending) {
          state.pending = false;
          state.running = false;
          this.#start(key, state);
          return;
        }
        this.#scopes.delete(key);
      });
    this.#tasks.add(task);
  }

  async #process(key: string, state: ScopeState): Promise<void> {
    const completion = state.completion;
    if (this.#closed) return;
    const epoch = await this.#options.contextEpoch(completion.accountId, completion.conversation);
    if (this.#closed || !epoch || epoch !== completion.contextEpoch) return;

    const before = await this.#options.memories.status(completion.conversation);
    if (this.#closed) return;
    // The role can change between the epoch read and the status read; never write attempt metadata
    // into a scope that was created after this turn completed.
    const statusEpoch = await this.#options.contextEpoch(completion.accountId, completion.conversation);
    if (this.#closed || statusEpoch !== completion.contextEpoch) return;
    const breakerGeneration = this.#breakers.get(key);
    if (breakerGeneration !== undefined) {
      if (before.scopeToken === breakerGeneration.scopeToken && before.generation === breakerGeneration.generation) return;
      this.#breakers.delete(key);
    }
    const extraction = before.extraction;
    if (extraction.effectiveStatus !== 'active') return;
    if (completion.inboundSeq <= extraction.throughSeq) return;
    if (extraction.lastAttemptAt !== undefined
      && this.#now() - extraction.lastAttemptAt < this.#limits.minIntervalMs) return;

    const resume = this.#resumeFor(key, before);
    const batch = await buildExtractionInput({
      store: this.#options.store(completion.accountId),
      conversation: completion.conversation,
      scope: { contextEpoch: epoch },
      afterSeq: extraction.throughSeq,
      throughSeq: completion.inboundSeq,
      admissionTexts: this.#limits.minNewTexts,
      scanLimit: this.#limits.scanRecordsPerScan,
      ...(resume ? { resume } : {})
    });
    if (this.#closed) return;
    this.#options.logger?.debug('memory extraction input scanned', {
      accountId: completion.accountId,
      conversation: completion.conversation,
      inspected: batch.inspected,
      eligibleTexts: batch.eligibleTexts,
      selected: batch.messages.length,
      processedThroughSeq: batch.processedThroughSeq,
      reachedTrigger: batch.reachedTrigger,
      resumed: Boolean(resume),
      hasMore: batch.scan !== undefined,
      skipped: batch.skipped
    });
    // Waiting for more completed turns must not advance over unread backlog. An under-threshold
    // scan that found eligible texts keeps its safe prefix in-process and continues on the next
    // trigger; a scan that found none advances only over the inspected non-text prefix.
    if (batch.eligibleTexts < this.#limits.minNewTexts) {
      if (batch.scan && batch.messages.length > 0) {
        this.#rememberScan(key, before, {
          afterSeq: batch.scan.afterSeq,
          messages: batch.messages,
          processedThroughSeq: batch.processedThroughSeq,
          eligibleTexts: batch.eligibleTexts,
          batchClosed: batch.scan.batchClosed
        });
      } else {
        this.#scanResumes.delete(key);
      }
      if (batch.messages.length === 0 && batch.processedThroughSeq > extraction.throughSeq) {
        await this.#advance(completion, before, batch.processedThroughSeq);
      }
      return;
    }

    const release = await this.#acquire();
    try {
      if (this.#closed) return;
      const fresh = await this.#options.memories.status(completion.conversation);
      if (this.#closed) return;
      if (fresh.scopeToken !== before.scopeToken || fresh.generation !== before.generation) return;
      if (fresh.extraction.effectiveStatus !== 'active') return;
      if (fresh.extraction.throughSeq !== extraction.throughSeq) return;

      const begin = await this.#options.memories.beginAttempt(
        completion.conversation,
        fresh.scopeToken,
        fresh.generation,
        fresh.extraction.throughSeq,
        this.#now()
      );
      if (!begin.started) return;

      let quota: MemoryExtractionQuotaView | undefined;
      try {
        quota = await this.#options.quota.acquire(completion.accountId, this.#now());
      } catch (error) {
        await this.#recordFailure(key, completion, fresh, error);
        return;
      }
      if (!quota) return;

      this.#options.logger?.info('memory extraction attempt started', {
        accountId: completion.accountId,
        conversation: completion.conversation,
        messages: batch.messages.length,
        throughSeq: batch.processedThroughSeq,
        quotaAccount: quota.accountUsed,
        quotaGlobal: quota.globalUsed
      });
      try {
        await this.#options.runner.run({
          completion,
          status: fresh,
          batch,
          signal: this.#controller.signal,
          isAdmitted: () => !this.#closed && !this.#controller.signal.aborted,
          now: () => this.#now()
        });
        // Only a completed attempt invalidates the safe prefix; failures keep it for the retry.
        this.#scanResumes.delete(key);
      } catch (error) {
        await this.#recordFailure(key, completion, fresh, error);
      }
    } catch (error) {
      await this.#recordFailure(key, completion, before, error);
    } finally {
      release();
    }
  }

  #resumeFor(key: string, status: MemoryExtractionStatusView): ExtractionScanResume | undefined {
    const cached = this.#scanResumes.get(key);
    if (!cached) return undefined;
    if (cached.scopeToken === status.scopeToken
      && cached.generation === status.generation
      && cached.throughSeq === status.extraction.throughSeq) {
      return cached.resume;
    }
    this.#scanResumes.delete(key);
    return undefined;
  }

  #rememberScan(key: string, status: MemoryExtractionStatusView, resume: ExtractionScanResume): void {
    if (!this.#scanResumes.has(key) && this.#scanResumes.size >= this.#limits.maxPendingScopes) {
      const oldest = this.#scanResumes.keys().next().value;
      if (oldest !== undefined) this.#scanResumes.delete(oldest);
    }
    this.#scanResumes.set(key, {
      scopeToken: status.scopeToken,
      generation: status.generation,
      throughSeq: status.extraction.throughSeq,
      resume
    });
  }

  async #advance(
    completion: ExtractionTurnCompletion,
    status: MemoryExtractionStatusView,
    processedThroughSeq: number
  ): Promise<void> {
    try {
      await this.#options.enqueue(completion, async () => {
        if (this.#closed) return;
        await this.#options.memories.advance(completion.conversation, {
          expectedScope: status.scopeToken,
          expectedGeneration: status.generation,
          expectedThroughSeq: status.extraction.throughSeq,
          processedThroughSeq,
          now: this.#now()
        });
      });
    } catch (error) {
      if (this.#closed) return;
      this.#options.logger?.warn('memory extraction scan advance failed', {
        accountId: completion.accountId,
        conversation: completion.conversation,
        fromSeq: status.extraction.throughSeq,
        throughSeq: processedThroughSeq,
        message: safeMessage(error)
      });
    }
  }

  async #recordFailure(
    key: string,
    completion: ExtractionTurnCompletion,
    status: MemoryExtractionStatusView,
    error: unknown
  ): Promise<void> {
    if (this.#closed) return;
    const failure = classifyFailure(error);
    if (failure.benign) return;
    try {
      const recorded = await this.#options.memories.recordFailure(
        completion.conversation,
        status.scopeToken,
        status.generation,
        {
          code: failure.code,
          at: this.#now(),
          ...(failure.fatal
            ? { fatal: true }
            : { cooldownUntil: this.#now() + this.#limits.failureCooldownMs })
        }
      );
      if (!recorded) return;
      if (failure.breaker) this.#breakers.set(key, { scopeToken: status.scopeToken, generation: status.generation });
    } catch {
      // Even the failure metadata could not be persisted: fail closed in-process until generation changes.
      this.#breakers.set(key, { scopeToken: status.scopeToken, generation: status.generation });
    }
  }

  async #acquire(): Promise<() => void> {
    const signal = this.#controller.signal;
    if (signal.aborted) throw abortError(signal);
    const lease = this.#semaphore.acquire();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = (): void => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([lease, aborted]);
    } catch (error) {
      // The semaphore lease is not abortable; release it whenever it finally resolves.
      void lease.then(release => release()).catch(() => {});
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}

function classifyFailure(error: unknown): { code: string; fatal: boolean; breaker: boolean; benign: boolean } {
  if (error instanceof ExtractionAttemptError) {
    return {
      code: safeCode(error.code),
      fatal: error.fatal,
      breaker: !error.benign && (error.fatal || error.code === 'memory_io_error'
        || error.code === 'memory_extraction_quota_unavailable' || error.code === 'memory_capacity'),
      benign: error.benign
    };
  }
  if (error instanceof AccompanyError) {
    if (error.code === 'memory_conflict' || error.code === 'core_stopped') {
      return { code: safeCode(error.code), fatal: false, breaker: false, benign: true };
    }
    return {
      code: safeCode(error.code),
      fatal: false,
      breaker: error.code === 'memory_io_error' || error.code === 'memory_extraction_quota_unavailable'
        || error.code === 'memory_capacity',
      benign: false
    };
  }
  return { code: 'extraction_failed', fatal: false, breaker: false, benign: false };
}

function safeCode(code: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'extraction_failed';
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AccompanyError('core_stopped', 'memory extraction coordinator stopped');
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AccompanyError('invalid_spec', `extraction coordinator ${label} must be a positive integer`);
  }
}
