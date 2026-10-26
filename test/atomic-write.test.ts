import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as concurrency from '../src/core/concurrency.js';
import { writeFileAtomic, writeJsonAtomic } from '../src/storage/atomic-write.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-atomic-'));
  roots.push(root);
  return root;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withPlatform<T>(platform: NodeJS.Platform, task: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor?.configurable) throw new Error('process.platform is not configurable in this runtime');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await task();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
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

  it('retries a rename blocked by another reader and still lands the document', async () => {
    await withPlatform('win32', async () => {
      const root = await tempRoot();
      const file = path.join(root, 'state.json');
      await writeJsonAtomic(file, { version: 1, name: 'first' });
      const original = fs.rename.bind(fs);
      const rename = vi.spyOn(fs, 'rename');
      rename.mockRejectedValueOnce(Object.assign(new Error('shared violation'), { code: 'EPERM' }));
      rename.mockImplementationOnce((temporary, target) => original(temporary, target));

      await writeJsonAtomic(file, { version: 2, name: 'second' });

      expect(rename).toHaveBeenCalledTimes(2);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 2, name: 'second' });
      expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  it('gives up after a bounded number of shared-conflict retries', async () => {
    await withPlatform('win32', async () => {
      const root = await tempRoot();
      const file = path.join(root, 'state.json');
      await writeJsonAtomic(file, { version: 1, name: 'first' });
      const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('shared violation'), { code: 'EPERM' }));

      await expect(writeJsonAtomic(file, { version: 2, name: 'second' })).rejects.toThrow('shared violation');

      expect(rename).toHaveBeenCalledTimes(4);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, name: 'first' });
      expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  it('rechecks authorization after a shared-conflict backoff before retrying rename', async () => {
    await withPlatform('win32', async () => {
      const root = await tempRoot();
      const file = path.join(root, 'state.json');
      await writeJsonAtomic(file, { version: 1, name: 'first' });

      const sleepEntered = deferred<void>();
      const releaseSleep = deferred<void>();
      vi.spyOn(concurrency, 'sleep').mockImplementation(async () => {
        sleepEntered.resolve();
        await releaseSleep.promise;
      });
      const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
        Object.assign(new Error('shared violation'), { code: 'EPERM' })
      );
      let authorized = true;
      let guardCalls = 0;
      const write = writeJsonAtomic(file, { version: 2, name: 'revoked' }, {
        beforeCommit: () => {
          guardCalls += 1;
          return authorized;
        }
      });

      await sleepEntered.promise;
      authorized = false;
      releaseSleep.resolve();
      await expect(write).rejects.toMatchObject({ code: 'write_guard_changed' });

      expect(guardCalls).toBe(2);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, name: 'first' });
      expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

      await writeJsonAtomic(file, { version: 3, name: 'next' });
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 3, name: 'next' });
      expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  it('does not retry Windows sharing error codes on non-Windows platforms', async () => {
    await withPlatform('linux', async () => {
      const root = await tempRoot();
      const file = path.join(root, 'state.json');
      await writeJsonAtomic(file, { version: 1, name: 'first' });
      const rename = vi.spyOn(fs, 'rename').mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EPERM' })
      );

      await expect(writeJsonAtomic(file, { version: 2, name: 'second' })).rejects.toThrow('permission denied');

      expect(rename).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, name: 'first' });
      expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
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

  it('continues a queued write after a failed replacement and cleans temporary files', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'state.json');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('blocked replacement'), { code: 'EXDEV' }));
    const results = await Promise.allSettled([
      writeJsonAtomic(file, { writer: 'failed' }),
      writeJsonAtomic(path.join(root, 'nested', '..', 'state.json'), { writer: 'next' })
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ writer: 'next' });
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    // An idle key must also accept a later write.
    await writeJsonAtomic(file, { writer: 'later' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ writer: 'later' });
  });
});
