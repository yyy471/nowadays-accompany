import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../core/logger.js';

export type DesiredInstanceState = 'running' | 'stopped';

interface StateFile {
  version: 1;
  instances: Record<string, DesiredInstanceState>;
}

/** 期望状态是运维意图，不是运行时观测；进程重启后据此恢复。 */
export class DesiredStateStore {
  readonly #filePath?: string;
  readonly #logger?: Logger;
  readonly #instances = new Map<string, DesiredInstanceState>();
  #writeChain: Promise<void> = Promise.resolve();
  #disposed = false;

  private constructor(filePath: string | undefined, logger?: Logger) {
    this.#filePath = filePath;
    this.#logger = logger;
  }

  static async load(filePath: string, logger?: Logger): Promise<DesiredStateStore> {
    const store = new DesiredStateStore(filePath, logger);
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<StateFile>;
      for (const [id, state] of Object.entries(raw.instances ?? {})) {
        if (state === 'running' || state === 'stopped') store.#instances.set(id, state);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger?.warn('desired state unreadable, starting empty', { filePath });
      }
    }
    return store;
  }

  get(id: string): DesiredInstanceState | undefined {
    return this.#instances.get(id);
  }

  snapshot(): Record<string, DesiredInstanceState> {
    return Object.fromEntries(this.#instances);
  }

  async set(id: string, state: DesiredInstanceState): Promise<void> {
    if (this.#instances.get(id) === state) return;
    this.#instances.set(id, state);
    await this.#persist();
  }

  async delete(id: string): Promise<void> {
    if (!this.#instances.delete(id)) return;
    await this.#persist();
  }

  async flush(): Promise<void> {
    await this.#writeChain;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#writeChain.catch(() => {});
  }

  async #persist(): Promise<void> {
    if (!this.#filePath || this.#disposed) return;
    const filePath = this.#filePath;
    const payload: StateFile = {
      version: 1,
      instances: Object.fromEntries([...this.#instances.entries()].sort(([left], [right]) => left.localeCompare(right)))
    };
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const task = this.#writeChain.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, filePath);
    });
    this.#writeChain = task;
    try {
      await task;
    } catch (error) {
      this.#logger?.error('desired state persist failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
