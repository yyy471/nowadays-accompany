import { BackpressureError } from '../core/errors.js';
import { abortReason } from '../providers/contract.js';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class BoundedGate {
  readonly #limit: number;
  readonly #maxQueue: number;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(limit: number, maxQueue: number) {
    this.#limit = Math.max(1, limit);
    this.#maxQueue = Math.max(0, maxQueue);
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.#queue.length === 0 && this.#active < this.#limit) {
      this.#active += 1;
      return this.#releaser();
    }
    if (this.#queue.length >= this.#maxQueue) {
      throw new BackpressureError('turn queue is full');
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = (): void => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  #grant(): void {
    while (this.#active < this.#limit && this.#queue.length > 0) {
      const waiter = this.#queue.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason instanceof Error ? waiter.signal.reason : new Error('aborted'));
        continue;
      }
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.#active += 1;
      waiter.resolve(this.#releaser());
    }
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active = Math.max(0, this.#active - 1);
      this.#grant();
    };
  }
}

export interface TurnSchedulerOptions {
  maxGlobal: number;
  maxPerAccount: number;
  maxPending: number;
}

export interface TurnSchedulerSnapshot {
  active: number;
  pending: number;
  accounts: Array<{ accountId: string; active: number; pending: number }>;
}

/**
 * 对话 turn 的全局/账号并发闸门。同会话顺序由 QqInstance 的会话链保证；
 * 这里只限制跨会话并发与排队上限。媒体任务使用独立队列，不占这里的槽位。
 */
export class TurnScheduler {
  readonly #global: BoundedGate;
  readonly #maxPerAccount: number;
  readonly #maxPending: number;
  readonly #accounts = new Map<string, BoundedGate>();

  constructor(options: TurnSchedulerOptions) {
    this.#global = new BoundedGate(options.maxGlobal, options.maxPending);
    this.#maxPerAccount = Math.max(1, options.maxPerAccount);
    this.#maxPending = Math.max(1, options.maxPending);
  }

  async run<T>(accountId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const accountGate = this.#accountGate(accountId);
    const releaseAccount = await accountGate.acquire(signal);
    let releaseGlobal: (() => void) | undefined;
    try {
      releaseGlobal = await this.#global.acquire(signal);
      return await task();
    } finally {
      releaseGlobal?.();
      releaseAccount();
    }
  }

  snapshot(): TurnSchedulerSnapshot {
    return {
      active: this.#global.active,
      pending: this.#global.pending,
      accounts: [...this.#accounts.entries()].map(([accountId, gate]) => ({
        accountId,
        active: gate.active,
        pending: gate.pending
      }))
    };
  }

  #accountGate(accountId: string): BoundedGate {
    const existing = this.#accounts.get(accountId);
    if (existing) return existing;
    const gate = new BoundedGate(this.#maxPerAccount, this.#maxPending);
    this.#accounts.set(accountId, gate);
    return gate;
  }
}
