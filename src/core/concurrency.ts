import { AccompanyError } from './errors.js';

export class Semaphore {
  readonly #limit: number;
  readonly #waiters: Array<() => void> = [];
  #active = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new AccompanyError('invalid_limit', `semaphore limit must be >= 1 (got ${limit})`);
    this.#limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.#active < this.#limit && this.#waiters.length === 0) {
      this.#active += 1;
      return this.#lease();
    }
    // 名额由释放者直接交接：等待者被唤醒时 active 已经计入它，
    // 避免新请求在唤醒与自增之间看到空位而突破上限。
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    return this.#lease();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  #lease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#active = Math.max(0, this.#active - 1);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new AccompanyError('timeout', message)), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
