import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, writeJsonAtomic } from '../src/storage/atomic-write.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-atomic-'));
  roots.push(root);
  return root;
}

describe('atomic write', () => {
  it('writes JSON with a trailing newline and replaces the previous file', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'nested', 'state.json');
    await writeJsonAtomic(file, { version: 1, name: 'first' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, name: 'first' });
    expect(await fs.readFile(file, 'utf8')).toMatch(/\n$/);

    await writeJsonAtomic(file, { version: 1, name: 'second' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, name: 'second' });
    const leftovers = (await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('writes binary payloads', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'blob.bin');
    await writeFileAtomic(file, Buffer.from([1, 2, 3]));
    expect([...await fs.readFile(file)]).toEqual([1, 2, 3]);
  });

  it('cleans up the temporary file when the rename fails', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'occupied');
    await fs.mkdir(target);
    await expect(writeJsonAtomic(target, { version: 1 })).rejects.toThrow();
    const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('keeps one complete document under concurrent writes', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'state.json');
    await Promise.all([
      writeJsonAtomic(file, { writer: 'a', values: Array.from({ length: 200 }, (_, index) => index) }),
      writeJsonAtomic(file, { writer: 'b', values: Array.from({ length: 200 }, (_, index) => index) })
    ]);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { writer: string; values: number[] };
    expect(['a', 'b']).toContain(parsed.writer);
    expect(parsed.values).toHaveLength(200);
  });
});
