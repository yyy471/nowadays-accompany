import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlStore } from '../src/storage/jsonl-store.js';
import { safePathSegment, type ConversationRef } from '../src/routing/identity.js';
import { silentLogger } from '../src/core/logger.js';

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const privateChat: ConversationRef = { accountId: '10001', kind: 'private', peerId: '2434944654' };
const groupChat: ConversationRef = { accountId: '10001', kind: 'group', peerId: '907906577' };

function record(index: number, extra: Partial<Parameters<JsonlStore['append']>[1]> = {}): Parameters<JsonlStore['append']>[1] {
  return {
    id: String(index),
    at: index,
    direction: 'in',
    senderId: '5555',
    segments: [{ type: 'text', data: { text: `m${index}` } }],
    ...extra
  };
}

describe('JsonlStore', () => {
  it('appends concurrently in call order without rewriting the file', async () => {
    const root = await tempRoot('accompany-store-');
    const store = new JsonlStore({ root, logger: silentLogger() });
    const tasks = Array.from({ length: 50 }, (_, index) => store.append(privateChat, record(index)));
    await Promise.all(tasks);

    const records = await store.read(privateChat);
    expect(records.map((item) => item.id)).toEqual(Array.from({ length: 50 }, (_, index) => String(index)));

    const file = path.join(root, '10001', 'private', '2434944654', '000001.jsonl');
    const text = await fs.readFile(file, 'utf8');
    expect(text.trim().split('\n')).toHaveLength(50);
    await store.dispose();
  });

  it('keeps conversations apart', async () => {
    const root = await tempRoot('accompany-store-');
    const store = new JsonlStore({ root, logger: silentLogger() });
    await store.append(privateChat, record(1));
    await store.append(groupChat, record(2));

    expect((await store.read(privateChat)).map((item) => item.id)).toEqual(['1']);
    expect((await store.read(groupChat)).map((item) => item.id)).toEqual(['2']);
    await store.dispose();
  });

  it('trims to the configured maximum, keeping the newest records', async () => {
    const root = await tempRoot('accompany-store-');
    const store = new JsonlStore({ root, maxRecordsPerConversation: 5, logger: silentLogger() });
    for (let index = 0; index < 12; index += 1) await store.append(privateChat, record(index));

    const records = await store.read(privateChat);
    expect(records.map((item) => item.id)).toEqual(['7', '8', '9', '10', '11']);
    await store.dispose();
  });

  it('supports tail reads and skips corrupt lines', async () => {
    const root = await tempRoot('accompany-store-');
    const store = new JsonlStore({ root, logger: silentLogger() });
    for (let index = 0; index < 6; index += 1) await store.append(privateChat, record(index));
    const file = path.join(root, '10001', 'private', '2434944654', '000001.jsonl');
    await fs.appendFile(file, '{"broken":\n', 'utf8');

    const tail = await store.read(privateChat, { limit: 2 });
    expect(tail.map((item) => item.id)).toEqual(['4', '5']);
    await store.dispose();
  });

  it('isolates roots so two cores never share files', async () => {
    const rootA = await tempRoot('accompany-a-');
    const rootB = await tempRoot('accompany-b-');
    const a = new JsonlStore({ root: rootA, logger: silentLogger() });
    const b = new JsonlStore({ root: rootB, logger: silentLogger() });

    await a.append(privateChat, record(1));
    expect(await b.read(privateChat)).toEqual([]);
    await b.append(privateChat, record(2));
    expect((await a.read(privateChat)).map((item) => item.id)).toEqual(['1']);
    expect((await b.read(privateChat)).map((item) => item.id)).toEqual(['2']);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('assigns a conversation-local seq and supports seq range reads', async () => {
    const root = await tempRoot('accompany-store-');
    const store = new JsonlStore({ root, logger: silentLogger() });
    for (let index = 0; index < 5; index += 1) await store.append(privateChat, record(index));

    const all = await store.read(privateChat);
    expect(all.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await store.read(privateChat, { afterSeq: 2 })).map((item) => item.id)).toEqual(['2', '3', '4']);
    expect((await store.read(privateChat, { beforeSeq: 3 })).map((item) => item.id)).toEqual(['0', '1']);
    await store.dispose();
  });

  it('deduplicates messageId across appends and across reopen', async () => {
    const root = await tempRoot('accompany-store-');
    const first = new JsonlStore({ root, logger: silentLogger() });
    const one = await first.append(privateChat, record(1, { messageId: 'm-1' }));
    const duplicate = await first.append(privateChat, record(2, { messageId: 'm-1' }));
    expect(duplicate).toEqual({ seq: one.seq, duplicate: true });
    expect(await first.read(privateChat)).toHaveLength(1);
    await first.dispose();

    const second = new JsonlStore({ root, logger: silentLogger() });
    const reopened = await second.append(privateChat, record(3, { messageId: 'm-1' }));
    expect(reopened).toEqual({ seq: one.seq, duplicate: true });
    expect(await second.read(privateChat)).toHaveLength(1);
    await second.dispose();
  });

  it('rotates segments and keeps the newest records without rewriting the whole conversation', async () => {
    const root = await tempRoot('accompany-store-');
    const store = new JsonlStore({
      root,
      maxRecordsPerConversation: 10,
      segmentRecords: 3,
      logger: silentLogger()
    });
    for (let index = 1; index <= 12; index += 1) await store.append(privateChat, record(index));

    const records = await store.read(privateChat);
    expect(records.map((item) => item.id)).toEqual(['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(records.map((item) => item.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const files = await fs.readdir(path.join(root, '10001', 'private', '2434944654'));
    expect(files.length).toBeGreaterThan(1);
    await store.dispose();
  });

  it('discovers conversations under the account namespace', async () => {
    const root = await tempRoot('accompany-store-');
    const store = new JsonlStore({ root, logger: silentLogger() });
    await store.append(privateChat, record(1));
    await store.append(groupChat, record(2));
    const conversations = await store.listConversations?.('10001');
    expect(conversations).toEqual(
      expect.arrayContaining([
        { accountId: '10001', kind: 'private', peerId: '2434944654' },
        { accountId: '10001', kind: 'group', peerId: '907906577' }
      ])
    );
    await store.dispose();
  });

  it('scopes an account store root and rejects conversations for other accounts', async () => {
    const root = await tempRoot('accompany-store-account-');
    const accountRoot = path.join(root, '10001');
    const store = new JsonlStore({
      root: path.join(accountRoot, 'messages'),
      accountId: '10001',
      logger: silentLogger()
    });
    await store.append(privateChat, record(1));

    const file = path.join(accountRoot, 'messages', 'private', '2434944654', '000001.jsonl');
    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await store.listConversations()).toEqual([privateChat]);
    expect(await store.listConversations('20002')).toEqual([]);
    await expect(
      store.append({ accountId: '20002', kind: 'private', peerId: '2434944654' }, record(2))
    ).rejects.toThrow(/refused conversation/);
    await store.dispose();
  });

  it('never lets a conversation escape the root', async () => {
    expect(safePathSegment('..')).toBe('__');
    expect(safePathSegment('../../evil')).toBe('______evil');
    const root = await tempRoot('accompany-store-');
    const store = new JsonlStore({ root, logger: silentLogger() });
    await store.append({ accountId: '10001', kind: 'private', peerId: '..' }, record(1));
    expect((await store.read({ accountId: '10001', kind: 'private', peerId: '..' })).length).toBe(1);
    const files = await fs.readdir(root, { recursive: true });
    expect(files.some((file) => String(file).includes('evil'))).toBe(false);
    await store.dispose();
  });
});
