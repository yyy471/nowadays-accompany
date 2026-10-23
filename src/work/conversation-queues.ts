import { AccompanyError, BackpressureError } from '../core/errors.js';

export interface ConversationQueueOptions {
  maxPending: number;
  maxPerConversation: number;
  onHighWater?: () => void;
  onLowWater?: () => void;
  highWaterRatio?: number;
  lowWaterRatio?: number;
  onOverflow?: (key: string) => void;
}

/**
 * 每会话一条串行链，跨会话并行。
 * 只保留有界 pending；满时由调用方决定暂停上游还是返回 429。
 */
export class ConversationQueues {
  readonly #maxPending: number;
  readonly #maxPerConversation: number;
  readonly #chains = new Map<string, Promise<void>>();
  readonly #pendingByKey = new Map<string, number>();
  readonly #options: ConversationQueueOptions;
  #pending = 0;
  #high = false;
  #disposed = false;

  constructor(options: ConversationQueueOptions) {
    if (options.maxPending < 1 || options.maxPerConversation < 1) {
      throw new AccompanyError('invalid_limit', 'conversation queue limits must be >= 1');
    }
    this.#maxPending = options.maxPending;
    this.#maxPerConversation = options.maxPerConversation;
    this.#options = options;
  }

  get pending(): number {
    return this.#pending;
  }

  pendingFor(key: string): number {
    return this.#pendingByKey.get(key) ?? 0;
  }

  tryEnqueue(key: string, task: () => Promise<void>): boolean {
    if (!this.#admit(key)) return false;
    void this.#enqueue(key, task);
    return true;
  }

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (!this.#admit(key)) {
      return Promise.reject(new BackpressureError(`queue for ${key} is full`));
    }
    return this.#enqueue(key, task);
  }

  async drain(): Promise<void> {
    while (this.#chains.size > 0) {
      await Promise.allSettled([...this.#chains.values()]);
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.drain();
  }

  #admit(key: string): boolean {
    if (this.#disposed) return false;
    const perKey = this.#pendingByKey.get(key) ?? 0;
    if (this.#pending >= this.#maxPending || perKey >= this.#maxPerConversation) {
      this.#options.onOverflow?.(key);
      return false;
    }
    this.#pending += 1;
    this.#pendingByKey.set(key, perKey + 1);
    this.#checkWatermarks();
    return true;
  }

  #enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => task(),
      () => task()
    );
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.#chains.set(key, settled);
    void settled.then(() => {
      this.#pending = Math.max(0, this.#pending - 1);
      const remaining = (this.#pendingByKey.get(key) ?? 1) - 1;
      if (remaining <= 0) this.#pendingByKey.delete(key);
      else this.#pendingByKey.set(key, remaining);
      if (this.#chains.get(key) === settled) this.#chains.delete(key);
      this.#checkWatermarks();
    });
    return run;
  }

  #checkWatermarks(): void {
    const highAt = Math.ceil(this.#maxPending * (this.#options.highWaterRatio ?? 0.8));
    const lowAt = Math.floor(this.#maxPending * (this.#options.lowWaterRatio ?? 0.5));
    if (!this.#high && this.#pending >= highAt) {
      this.#high = true;
      this.#options.onHighWater?.();
      return;
    }
    if (this.#high && this.#pending <= lowAt) {
      this.#high = false;
      this.#options.onLowWater?.();
    }
  }
}
