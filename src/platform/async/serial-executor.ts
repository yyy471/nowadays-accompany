import { AccompanyError } from '../../core/errors.js';

export interface SerialExecutorOptions {
  /** 等待执行的最大任务数；运行中的任务不计入。 */
  maxPending?: number;
}

interface QueuedTask {
  task: () => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * 单资源串行域。任务按提交顺序执行，失败不会毒化后续任务。
 * 调用方负责决定资源键；这里不包含任何业务规则。
 */
export class SerialExecutor {
  readonly #maxPending: number;
  readonly #queue: QueuedTask[] = [];
  readonly #idle: Array<() => void> = [];
  #active = false;
  #closed = false;

  constructor(options: SerialExecutorOptions = {}) {
    const maxPending = options.maxPending ?? 256;
    if (!Number.isInteger(maxPending) || maxPending < 0) {
      throw new AccompanyError('invalid_limit', `serial executor maxPending must be >= 0 (got ${maxPending})`);
    }
    this.#maxPending = maxPending;
  }

  get active(): boolean {
    return this.#active;
  }

  get pending(): number {
    return this.#queue.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  run<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new AccompanyError('serial_executor_closed', 'serial executor has been closed'));
    }
    if (this.#active && this.#queue.length >= this.#maxPending) {
      return Promise.reject(
        new AccompanyError('serial_executor_full', `serial executor queue is full (max ${this.#maxPending})`)
      );
    }
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        task: task as () => unknown,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.#pump();
    });
  }

  /** 等待当前已接受的任务全部完成；期间新提交的任务也会被计入。 */
  async drain(): Promise<void> {
    if (!this.#active && this.#queue.length === 0) return;
    await new Promise<void>((resolve) => this.#idle.push(resolve));
  }

  /** 拒绝新任务，并等待已接受的任务完成。 */
  async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
  }

  #pump(): void {
    if (this.#active) return;
    const next = this.#queue.shift();
    if (!next) {
      this.#settleIdle();
      return;
    }
    this.#active = true;
    // Call the task from inside the chain so synchronous throws follow the same
    // rejection and cleanup path as returned rejected promises.
    void Promise.resolve().then(() => next.task()).then(next.resolve, next.reject).finally(() => {
      this.#active = false;
      this.#pump();
    });
  }

  #settleIdle(): void {
    for (const resolve of this.#idle.splice(0)) resolve();
  }
}
