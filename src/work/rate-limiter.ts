import { sleep } from '../core/concurrency.js';

export class TokenBucket {
  readonly #ratePerSecond: number;
  readonly #burst: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefill: number;

  constructor(ratePerSecond: number, burst: number, now: () => number = Date.now) {
    this.#ratePerSecond = Math.max(0, ratePerSecond);
    this.#burst = Math.max(1, burst);
    this.#now = now;
    this.#tokens = this.#burst;
    this.#lastRefill = now();
  }

  get available(): number {
    this.#refill();
    return this.#tokens;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.#ratePerSecond <= 0) return;
    while (true) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil(((1 - this.#tokens) / this.#ratePerSecond) * 1_000));
      await sleep(waitMs, signal);
    }
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#lastRefill) / 1_000;
    this.#lastRefill = now;
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsed * this.#ratePerSecond);
  }
}
