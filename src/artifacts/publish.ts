import fs from 'node:fs/promises';
import path from 'node:path';
import { AccompanyError, InvalidSpecError } from '../core/errors.js';
import { assertNoLinks, ensureDirectories } from './source-file.js';

/** Publish one fully prepared directory. Cooperative target lock and rename are shared by all importers. */
export async function publishArtifactRevision(root: string, target: string, prepare: (temporary: string) => Promise<void>): Promise<void> {
  root = path.resolve(root); target = path.resolve(target);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new InvalidSpecError('制品目标超出公共目录。');
  await ensureDirectories(path.dirname(target));
  const lock = path.join(path.dirname(target), `.import-${path.basename(target)}.lock`);
  try { await fs.mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AccompanyError('worldbook_conflict', '相同 revision 正在导入或已有导入锁，请稍后重试。');
    throw error;
  }
  let temporary: string | undefined;
  try {
    await assertAbsent(target);
    temporary = await fs.mkdtemp(path.join(root, '.artifact-import-'));
    await prepare(temporary);
    await assertNoLinks(path.dirname(target), false);
    await assertAbsent(target);
    await fs.rename(temporary, target);
    temporary = undefined;
  } finally {
    if (temporary && path.dirname(path.resolve(temporary)) === root && path.basename(temporary).startsWith('.artifact-import-')) await fs.rm(temporary, { recursive: true, force: true });
    await fs.rmdir(lock);
  }
}

async function assertAbsent(target: string): Promise<void> {
  try { await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new AccompanyError('worldbook_conflict', '此 id / revision 已存在，不能覆盖已有制品。');
}
