import { AccompanyError } from '../../core/errors.js';
import { abortReason } from '../../providers/contract.js';

export const TOOL_CONCURRENCY_LIMITS = {
  global: 4,
  perAccount: 2,
  queue: 32
} as const;

export interface ToolConcurrencyLimits {
  global?: number;
  perAccount?: number;
  queue?: number;
}

interface Waiter {
  accountId: string;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Bounded global/account concurrency for actual tool execution. Queueing never counts as running;
 * callers must revalidate authorization and guards after acquiring a slot.
 */
export class ToolConcurrencyLimiter {
  readonly #global: number;
  readonly #perAccount: number;
  readonly #queueLimit: number;
  readonly #waiters: Waiter[] = [];
  readonly #idleWaiters: Array<() => void> = [];
  readonly #active = new Map<string, number>();
  #running = 0;
  #closed = false;

  constructor(limits: ToolConcurrencyLimits = {}) {
    this.#global = positiveInt(limits.global, TOOL_CONCURRENCY_LIMITS.global, 'global');
    this.#perAccount = positiveInt(limits.perAccount, TOOL_CONCURRENCY_LIMITS.perAccount, 'perAccount');
    this.#queueLimit = nonNegativeInt(limits.queue, TOOL_CONCURRENCY_LIMITS.queue, 'queue');
  }

  get running(): number {
    return this.#running;
  }

  get pending(): number {
    return this.#waiters.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async acquire(accountId: string, signal?: AbortSignal): Promise<() => void> {
    if (this.#closed) throw new AccompanyError('tool_executor_closed', 'tool executor is closed');
    if (signal?.aborted) throw abortReason(signal);
    const active = this.#active.get(accountId) ?? 0;
    if (this.#running < this.#global && active < this.#perAccount && this.#waiters.length === 0) {
      return this.#lease(accountId);
    }
    if (this.#waiters.length >= this.#queueLimit) {
      throw new AccompanyError('tool_queue_full', 'tool execution queue is full');
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { accountId, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortReason(signal));
          this.#pump();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  /** Rejects all queued waiters and prevents new admissions. Running tools are not cancelled here. */
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      detach(waiter);
      waiter.reject(new AccompanyError('tool_executor_closed', 'tool executor is closed'));
    }
    this.#settleIdle();
  }

  async idle(): Promise<void> {
    if (this.#running === 0 && this.#waiters.length === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  #lease(accountId: string): () => void {
    this.#running += 1;
    this.#active.set(accountId, (this.#active.get(accountId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running = Math.max(0, this.#running - 1);
      const active = (this.#active.get(accountId) ?? 1) - 1;
      if (active > 0) this.#active.set(accountId, active);
      else this.#active.delete(accountId);
      this.#pump();
    };
  }

  #pump(): void {
    while (this.#running < this.#global && this.#waiters.length > 0) {
      const index = this.#waiters.findIndex((waiter) => (this.#active.get(waiter.accountId) ?? 0) < this.#perAccount);
      if (index < 0) return;
      const [waiter] = this.#waiters.splice(index, 1);
      detach(waiter);
      waiter.resolve(this.#lease(waiter.accountId));
    }
    this.#settleIdle();
  }

  #settleIdle(): void {
    if (this.#running > 0 || this.#waiters.length > 0) return;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}

function detach(waiter: Waiter): void {
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
}

function positiveInt(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new AccompanyError('invalid_limit', `tool ${label} concurrency must be >= 1`);
  }
  return resolved;
}

function nonNegativeInt(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new AccompanyError('invalid_limit', `tool ${label} queue must be >= 0`);
  }
  return resolved;
}
