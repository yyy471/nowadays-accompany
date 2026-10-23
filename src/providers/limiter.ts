import { BackpressureError } from '../core/errors.js';
import { abortReason } from './contract.js';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface EndpointLimitSnapshot {
  key: string;
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueue: number;
}

/** 端点级并发闸门：多个 provider/账号命中同一 baseUrl 时共用 active/queued。 */
export class EndpointLimiter {
  readonly key: string;
  #active = 0;
  #maxConcurrent = 1;
  #maxQueue = 0;
  readonly #queue: Waiter[] = [];

  constructor(key: string) {
    this.key = key;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  updateLimits(maxConcurrent: number, maxQueue: number): void {
    this.#maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    this.#maxQueue = Math.max(0, Math.floor(maxQueue));
    this.#grant();
  }

  snapshot(): EndpointLimitSnapshot {
    return {
      key: this.key,
      active: this.#active,
      queued: this.#queue.length,
      maxConcurrent: this.#maxConcurrent,
      maxQueue: this.#maxQueue
    };
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.#queue.length === 0 && this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return this.#releaser();
    }
    if (this.#queue.length >= this.#maxQueue) {
      throw new BackpressureError(`provider endpoint ${this.key} queue is full`);
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
    while (this.#active < this.#maxConcurrent && this.#queue.length > 0) {
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

export function endpointKeyFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return baseUrl;
  }
}
