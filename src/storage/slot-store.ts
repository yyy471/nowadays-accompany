import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { writeFileAtomic } from './atomic-write.js';
import type { InstanceSpec } from '../instances/spec.js';

interface SlotFile {
  version: 1;
  slots: InstanceSpec[];
}

/**
 * 槽位规格不是运维意图，而是“这台机器上有哪些运行槽”。
 * 与 desired.json 分开：移除槽位会删除意图，但规格文件自己保留剩余槽位。
 */
export class SlotStore {
  readonly #filePath: string;
  readonly #logger?: Logger;
  readonly #slots: InstanceSpec[] = [];
  #loaded = false;
  #writeChain: Promise<void> = Promise.resolve();
  #disposed = false;

  private constructor(filePath: string, logger?: Logger) {
    this.#filePath = filePath;
    this.#logger = logger;
  }

  static async load(filePath: string, logger?: Logger): Promise<SlotStore> {
    const store = new SlotStore(filePath, logger);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger?.warn('slot specs unreadable, starting empty', { filePath });
        store.#loaded = true;
      }
      return store;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      logger?.warn('slot specs have an invalid shape, starting empty', { filePath });
      store.#loaded = true;
      return store;
    }
    const slots = (raw as Partial<SlotFile>).slots;
    if (Array.isArray(slots)) {
      for (const slot of slots) {
        if (slot && typeof slot === 'object' && !Array.isArray(slot) && typeof slot.id === 'string') {
          store.#slots.push(slot as InstanceSpec);
        } else {
          logger?.warn('skipping invalid slot spec', { filePath });
        }
      }
    }
    store.#loaded = true;
    return store;
  }

  /** 文件不存在时为 false：调用方可以据此决定是否用启动参数做首次播种。 */
  get loaded(): boolean {
    return this.#loaded;
  }

  list(): InstanceSpec[] {
    return this.#slots.map((slot) => structuredClone(slot));
  }

  async save(slots: InstanceSpec[]): Promise<void> {
    this.#slots.splice(0, this.#slots.length, ...slots.map((slot) => structuredClone(slot)));
    this.#loaded = true;
    await this.#persist();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#writeChain.catch(() => {});
  }

  async #persist(): Promise<void> {
    if (this.#disposed) return;
    const payload: SlotFile = {
      version: 1,
      slots: this.#slots
    };
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const task = this.#writeChain.catch(() => {}).then(() => writeFileAtomic(this.#filePath, body));
    this.#writeChain = task;
    try {
      await task;
    } catch (error) {
      this.#logger?.error('slot specs persist failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
