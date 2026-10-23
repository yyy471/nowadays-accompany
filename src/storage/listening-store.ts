import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { writeFileAtomic } from './atomic-write.js';

export interface ListeningRecord {
  slotId: string;
  accountId: string;
  runtimeDir: string;
}

interface StateFile {
  version: 1;
  listening: ListeningRecord[];
}

/**
 * 上次仍在监听的账号槽位。动态槽位本身不写入 slots.json，
 * 因此需要这份记录在应用重启后重建槽位并提示恢复。
 */
export class ListeningStore {
  readonly #filePath: string;
  readonly #logger?: Logger;
  readonly #records = new Map<string, ListeningRecord>();
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, logger?: Logger) {
    this.#filePath = filePath;
    this.#logger = logger;
  }

  static async load(filePath: string, logger?: Logger): Promise<ListeningStore> {
    const resolved = path.resolve(filePath);
    const store = new ListeningStore(resolved, logger);
    try {
      const raw = JSON.parse(await fs.readFile(resolved, 'utf8')) as Partial<StateFile>;
      for (const entry of Array.isArray(raw.listening) ? raw.listening : []) {
        const record = parseRecord(entry);
        if (record) store.#records.set(record.slotId, record);
        else logger?.warn('listening record skipped', { filePath: resolved });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger?.warn('listening records unreadable, starting empty', { filePath: resolved });
      }
    }
    return store;
  }

  list(): ListeningRecord[] {
    return [...this.#records.values()].map((record) => ({ ...record }));
  }

  async remember(record: ListeningRecord): Promise<void> {
    const parsed = parseRecord(record);
    if (!parsed) return;
    const previous = this.#records.get(parsed.slotId);
    if (previous && previous.accountId === parsed.accountId && previous.runtimeDir === parsed.runtimeDir) return;
    this.#records.set(parsed.slotId, parsed);
    await this.#persist();
  }

  async forget(slotId: string): Promise<void> {
    if (!this.#records.delete(slotId)) return;
    await this.#persist();
  }

  async dispose(): Promise<void> {
    await this.#writeChain.catch(() => {});
  }

  async #persist(): Promise<void> {
    const payload: StateFile = {
      version: 1,
      listening: [...this.#records.values()].sort((left, right) => left.slotId.localeCompare(right.slotId))
    };
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const task = this.#writeChain.catch(() => {}).then(() => writeFileAtomic(this.#filePath, body));
    this.#writeChain = task;
    try {
      await task;
    } catch (error) {
      this.#logger?.error('listening records persist failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}

function parseRecord(raw: unknown): ListeningRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const { slotId, accountId, runtimeDir } = value;
  if (typeof slotId !== 'string' || !slotId.trim() || slotId.length > 128) return undefined;
  if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 128) return undefined;
  if (typeof runtimeDir !== 'string' || !runtimeDir.trim() || runtimeDir.length > 4096) return undefined;
  return { slotId, accountId, runtimeDir: path.resolve(runtimeDir) };
}
