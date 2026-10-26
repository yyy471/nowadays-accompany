import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep } from '../core/concurrency.js';
import { KeyedSerialExecutor } from '../platform/async/keyed-serial-executor.js';

// All stores share one process-wide domain; idle path keys are reclaimed by the executor.
const writes = new KeyedSerialExecutor();

export interface AtomicWriteOptions {
  mode?: number;
  /** Revalidate caller authorization at the atomic rename boundary. */
  beforeCommit?: () => boolean | Promise<boolean>;
}

/** 同目录临时文件 + rename，避免进程中断后留下半截文件。 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const target = path.resolve(filePath);
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  return writes.run(key, () => writeResolvedFileAtomic(target, data, options));
}

async function writeResolvedFileAtomic(target: string, data: string | Uint8Array, options: AtomicWriteOptions): Promise<void> {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    if (typeof data === 'string') {
      await fs.writeFile(temporary, data, { encoding: 'utf8', mode: options.mode ?? 0o600 });
    } else {
      await fs.writeFile(temporary, data, { mode: options.mode ?? 0o600 });
    }
    await renameWithRetry(temporary, target, options.beforeCommit);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

const SHARE_CONFLICT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Windows 上另一个读者持有目标文件句柄时，rename 覆盖会以共享冲突失败；
 * 写者已把完整内容放进临时文件，所以只对这类错误做有界重试，其他错误原样抛出。
 */
async function renameWithRetry(
  temporary: string,
  target: string,
  beforeCommit?: AtomicWriteOptions['beforeCommit']
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    if (beforeCommit && !(await beforeCommit())) {
      const error = new Error('atomic write commit guard rejected the write');
      Object.assign(error, { code: 'write_guard_changed' });
      throw error;
    }

    try {
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !code || !SHARE_CONFLICT_CODES.has(code) || attempt >= 4) throw error;
      await sleep(attempt * 20);
    }
  }
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): Promise<void> {
  return writeFileAtomic(filePath, serializeJson(value), options);
}
