import fs from 'node:fs/promises';
import path from 'node:path';
import { AccompanyError } from './errors.js';
import type { Logger } from './logger.js';

interface LockPayload {
  pid: number;
  startedAt: number;
}

/** 一个 dataRoot 同时只允许一个写者，避免跨进程 JSONL/状态互相覆盖。 */
export class DataRootLock {
  readonly #file: string;
  #released = false;

  private constructor(file: string) {
    this.#file = file;
  }

  static async acquire(dataRoot: string, logger?: Logger): Promise<DataRootLock> {
    await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const file = path.join(dataRoot, '.accompany.lock');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        const payload: LockPayload = { pid: process.pid, startedAt: Date.now() };
        await handle.writeFile(JSON.stringify(payload));
        await handle.close();
        return new DataRootLock(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await isStale(file))) {
          throw new AccompanyError('data_root_locked', `data root is already locked by another process: ${dataRoot}`);
        }
        logger?.warn('removing stale data root lock', { file });
        await fs.unlink(file).catch(() => {});
      }
    }
    throw new AccompanyError('data_root_locked', `failed to acquire data root lock: ${dataRoot}`);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const payload = await readPayload(this.#file);
    if (payload && payload.pid !== process.pid) return;
    await fs.unlink(this.#file).catch(() => {});
  }
}

async function readPayload(file: string): Promise<LockPayload | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as LockPayload;
  } catch {
    return undefined;
  }
}

async function isStale(file: string): Promise<boolean> {
  const payload = await readPayload(file);
  if (!payload || !Number.isInteger(payload.pid) || payload.pid <= 0) return true;
  if (payload.pid === process.pid) return false;
  try {
    process.kill(payload.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
