import { AccompanyError } from '../../core/errors.js';
import { SerialExecutor, type SerialExecutorOptions } from './serial-executor.js';

export interface KeyedSerialExecutorOptions {
  maxPendingPerKey?: number;
  /** 同时存在的资源键上限，防止无限增长。 */
  maxKeys?: number;
}

interface KeyEntry {
  executor: SerialExecutor;
  active: number;
}

/** 按键隔离的串行域；空闲键立即回收，不保留模块级状态。 */
export class KeyedSerialExecutor {
  readonly #maxKeys: number;
  readonly #executorOptions: SerialExecutorOptions;
  readonly #entries = new Map<string, KeyEntry>();
  #closed = false;

  constructor(options: KeyedSerialExecutorOptions = {}) {
    const maxKeys = options.maxKeys ?? 1024;
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new AccompanyError('invalid_limit', `keyed serial executor maxKeys must be >= 1 (got ${maxKeys})`);
    }
    this.#maxKeys = maxKeys;
    this.#executorOptions = { maxPending: options.maxPendingPerKey };
  }

  get size(): number {
    return this.#entries.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new AccompanyError('serial_executor_closed', 'serial executor has been closed'));
    }
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.#maxKeys) {
        return Promise.reject(
          new AccompanyError('serial_executor_full', `too many serial executor keys (max ${this.#maxKeys})`)
        );
      }
      entry = { executor: new SerialExecutor(this.#executorOptions), active: 0 };
      this.#entries.set(key, entry);
    }
    entry.active += 1;
    return entry.executor.run(task).finally(() => {
      entry!.active -= 1;
      // 最后一个调用者结束时任务已经完成；内部 active 可能还要等一个微任务才复位。
      if (entry!.active === 0 && entry!.executor.pending === 0) {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      }
    });
  }

  /** 等待当前所有键上的已接受任务完成；期间新提交的任务也会被计入。 */
  async drain(): Promise<void> {
    while (this.#entries.size > 0) {
      await Promise.all([...this.#entries.values()].map((entry) => entry.executor.drain()));
    }
  }

  /** 拒绝新任务，并等待已接受的任务完成。 */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries.values()].map((entry) => entry.executor.close()));
    this.#entries.clear();
  }
}
