import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ListeningStore } from '../src/storage/listening-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-listening-'));
  roots.push(root);
  return path.join(root, 'state', 'listening.json');
}

describe('listening store', () => {
  it('persists and reloads listening accounts', async () => {
    const file = await tempFile();
    const store = await ListeningStore.load(file);
    await store.remember({ slotId: 'qq-10001', accountId: '10001', runtimeDir: 'D:/SnowLuma' });
    await store.remember({ slotId: 'qq-10002', accountId: '10002', runtimeDir: 'D:/SnowLuma' });
    await store.dispose();

    const reopened = await ListeningStore.load(file);
    expect(reopened.list()).toEqual([
      { slotId: 'qq-10001', accountId: '10001', runtimeDir: path.resolve('D:/SnowLuma') },
      { slotId: 'qq-10002', accountId: '10002', runtimeDir: path.resolve('D:/SnowLuma') }
    ]);
    await reopened.forget('qq-10001');
    await reopened.dispose();

    const third = await ListeningStore.load(file);
    expect(third.list().map((record) => record.slotId)).toEqual(['qq-10002']);
    await third.dispose();
  });

  it('skips malformed records instead of failing startup', async () => {
    const file = await tempFile();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify({
      version: 1,
      listening: [
        { slotId: 'qq-10001', accountId: '10001', runtimeDir: 'D:/SnowLuma' },
        { slotId: '', accountId: '10002', runtimeDir: 'D:/SnowLuma' },
        { slotId: 'qq-10003', runtimeDir: 'D:/SnowLuma' },
        'not-a-record'
      ]
    })}\n`, { encoding: 'utf8', mode: 0o600 });

    const store = await ListeningStore.load(file);
    expect(store.list().map((record) => record.slotId)).toEqual(['qq-10001']);
    await store.dispose();
  });
});
