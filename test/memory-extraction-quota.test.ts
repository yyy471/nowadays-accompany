import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExtractionQuotaStore } from '../src/application/memory/extraction/quota.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-extraction-quota-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const HOUR = 3_600_000;
const windowStart = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
const limits = { perAccountPerHour: 2, globalPerHour: 3 };

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-quota-'));
  roots.push(root);
  let now = windowStart + 1_000;
  const file = path.join(root, 'state', 'quota.json');
  const store = await ExtractionQuotaStore.load(file, { now: () => now, limits });
  return { root, file, store, now: () => now, setNow: (value: number) => { now = value; } };
}

it('enforces per-account and global hourly limits and reports a bounded snapshot', async () => {
  const { store } = await setup();
  expect(await store.acquire('10001')).toMatchObject({
    windowStart,
    resetAt: windowStart + HOUR,
    accountUsed: 1,
    accountLimit: 2,
    globalUsed: 1,
    globalLimit: 3
  });
  expect(await store.acquire('10001')).toMatchObject({ accountUsed: 2, globalUsed: 2 });
  expect(await store.acquire('10001')).toBeUndefined();
  expect(await store.acquire('10002')).toMatchObject({ accountUsed: 1, globalUsed: 3 });
  expect(await store.acquire('10003')).toBeUndefined();
  expect(store.snapshot('10002')).toMatchObject({ accountUsed: 1, globalUsed: 3 });
  expect(store.snapshot('10003')).toMatchObject({ accountUsed: 0, globalUsed: 3 });
  await store.dispose();
});

it('persists counts across a store restart and resets only when the hour changes', async () => {
  const { file, store, now, setNow } = await setup();
  await store.acquire('10001');
  await store.acquire('10001');
  await store.acquire('10002');
  await store.dispose();

  const restarted = await ExtractionQuotaStore.load(file, { now, limits });
  expect(await restarted.acquire('10001')).toBeUndefined();
  expect(await restarted.acquire('10003')).toBeUndefined();
  setNow(windowStart + HOUR + 1);
  expect(await restarted.acquire('10003')).toMatchObject({
    accountUsed: 1,
    globalUsed: 1,
    windowStart: windowStart + HOUR
  });
  await restarted.dispose();
});

it('fails closed on a corrupt or oversized quota file instead of starting from zero', async () => {
  const { file } = await setup();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{broken');
  const corrupt = await ExtractionQuotaStore.load(file, { now: () => windowStart + 1, limits });
  await expect(corrupt.acquire('10001')).rejects.toMatchObject({ code: 'memory_extraction_quota_unavailable' });
  await corrupt.dispose();

  await fs.writeFile(file, 'x'.repeat(300 * 1024));
  const oversized = await ExtractionQuotaStore.load(file, { now: () => windowStart + 1, limits });
  await expect(oversized.acquire('10001')).rejects.toMatchObject({ code: 'memory_extraction_quota_unavailable' });
  await oversized.dispose();
});

it('does not count an attempt when the quota file cannot be written', async () => {
  const { store } = await setup();
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('quota.json')) throw Object.assign(new Error('disk full'), { code: 'EIO' });
    return rename(from, to);
  });
  await expect(store.acquire('10001')).rejects.toMatchObject({ code: 'memory_extraction_quota_unavailable' });
  vi.restoreAllMocks();
  expect(store.snapshot('10001')).toMatchObject({ accountUsed: 0, globalUsed: 0 });
  expect(await store.acquire('10001')).toMatchObject({ accountUsed: 1, globalUsed: 1 });
  await store.dispose();
});
