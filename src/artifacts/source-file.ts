import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InvalidSpecError } from '../core/errors.js';

function isCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code); }

/** Check every existing ancestor, rejecting symlinks/junctions even above the selected root. */
export async function assertNoLinks(target: string, allowMissing: boolean): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new InvalidSpecError(`制品路径不允许符号链接或目录联接：${current}`); }
    catch (error) { if (allowMissing && isCode(error, 'ENOENT')) return; throw error; }
  }
}

/** File-card import shares the exact link, identity and size checks used by directory import. */
export async function readArtifactSourceFile(file: string, limit: number): Promise<Buffer> {
  return (await readFileBounded(file, limit, undefined, false, true)).buffer!;
}

export async function readFileBounded(file: string, limit: number, destination?: string, includeText = false, includeBuffer = false): Promise<{ digest: string; bytes: number; text?: string; buffer?: Buffer }> {
  await assertNoLinks(file, false);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new InvalidSpecError('制品不允许符号链接或特殊文件。');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit) throw new InvalidSpecError('源文件发生变化或大小超过限制。');
    if (destination) output = await fs.open(destination, 'wx');
    const hash = createHash('sha256'); const chunks: Buffer[] = []; const buffer = Buffer.alloc(65536); let bytes = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, limit - bytes + 1), null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > limit) throw new InvalidSpecError('源文件大小超过导入限制。');
      const chunk = buffer.subarray(0, result.bytesRead); hash.update(chunk);
      if (includeText || includeBuffer) chunks.push(Buffer.from(chunk));
      if (output) await output.writeFile(chunk);
    }
    const after = await handle.stat();
    if (after.size !== bytes || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new InvalidSpecError('读取期间源文件发生变化。');
    if ((await fs.lstat(file)).isSymbolicLink()) throw new InvalidSpecError('制品不允许符号链接。');
    return { digest: hash.digest('hex'), bytes, ...(includeText ? { text: Buffer.concat(chunks).toString('utf8') } : {}), ...(includeBuffer ? { buffer: Buffer.concat(chunks) } : {}) };
  } finally { await output?.close(); await handle.close(); }
}

export async function ensureDirectories(directory: string): Promise<void> {
  await assertNoLinks(directory, true);
  const parent = path.dirname(directory);
  if (parent !== directory) {
    try { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InvalidSpecError('目标目录无效或包含符号链接。'); return; }
    catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
    await ensureDirectories(parent);
    try { await fs.mkdir(directory); } catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
    await assertNoLinks(directory, false);
    if (!(await fs.lstat(directory)).isDirectory()) throw new InvalidSpecError('目标路径不是目录。');
  }
}
