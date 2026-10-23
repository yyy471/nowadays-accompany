import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface AtomicWriteOptions {
  mode?: number;
}

/** 同目录临时文件 + rename，避免进程中断后留下半截文件。 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const target = path.resolve(filePath);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    if (typeof data === 'string') {
      await fs.writeFile(temporary, data, { encoding: 'utf8', mode: options.mode ?? 0o600 });
    } else {
      await fs.writeFile(temporary, data, { mode: options.mode ?? 0o600 });
    }
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): Promise<void> {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
