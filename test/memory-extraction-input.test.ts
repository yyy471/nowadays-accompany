import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  EXTRACTION_INPUT_LIMITS,
  EXTRACTION_PROMPT_VERSION,
  buildExtractionInput,
  extractionSourceKey,
  type ExtractionInputBatch,
  type ExtractionScanResume,
  type ExtractionSourceIdentity
} from '../src/application/memory/extraction/input.js';
import { JsonlStore } from '../src/storage/jsonl-store.js';
import type { ConversationRef } from '../src/routing/identity.js';
import type { MessageSegment } from '../src/routing/message.js';

const roots: string[] = [];
const stores: JsonlStore[] = [];
afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map(store => store.dispose()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-extraction-input-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const conversation: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };
const scope = { contextEpoch: 'epoch-a' };

async function setup(segmentRecords = 7) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-input-'));
  roots.push(root);
  const store = new JsonlStore({ root: path.join(root, 'messages'), accountId: '10001', segmentRecords });
  stores.push(store);
  let index = 0;
  const append = async (options: {
    text?: string;
    segments?: MessageSegment[];
    direction?: 'in' | 'out';
    contextEpoch?: string;
    senderId?: string;
    ref?: ConversationRef;
  } = {}) => {
    index += 1;
    return store.append(options.ref ?? conversation, {
      id: `m-${index}`,
      at: 1_700_000_000_000 + index,
      direction: options.direction ?? 'in',
      ...(options.senderId ? { senderId: options.senderId } : {}),
      ...(options.contextEpoch ? { contextEpoch: options.contextEpoch } : { contextEpoch: 'epoch-a' }),
      segments: options.segments ?? [{ type: 'text', data: { text: options.text ?? `message-${index}` } }]
    });
  };
  return { root, store, append };
}

function build(store: JsonlStore, afterSeq: number, throughSeq: number, admissionTexts?: number) {
  return buildExtractionInput({
    store,
    conversation,
    scope,
    afterSeq,
    throughSeq,
    ...(admissionTexts !== undefined ? { admissionTexts } : {})
  });
}

const identity: ExtractionSourceIdentity = {
  scopeToken: 'a'.repeat(64),
  activationBoundary: 10,
  generation: 3,
  modelIdentity: 'fake-chat:tool-model:json-v1'
};

it('I04: caps a batch at 50 messages and continues from the last inspected seq without jumping to the trigger', async () => {
  const { store, append } = await setup();
  for (let index = 0; index < 60; index++) await append({ text: `msg-${index}` });

  const first = await build(store, 0, 60);
  expect(first.messages).toHaveLength(EXTRACTION_INPUT_LIMITS.maxBatchMessages);
  expect(first.messages.map(message => message.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  expect(first.processedThroughSeq).toBe(50);
  expect(first.reachedTrigger).toBe(false);
  expect(first.fromSeq).toBe(1);
  expect(first.throughSeq).toBe(50);
  expect(first.skipped).toEqual({ outbound: 0, otherEpoch: 0, emptyText: 0, overlong: 0 });

  const second = await build(store, first.processedThroughSeq, 60);
  expect(second.messages.map(message => message.seq)).toEqual(Array.from({ length: 10 }, (_, index) => index + 51));
  expect(second.processedThroughSeq).toBe(60);
  expect(second.reachedTrigger).toBe(true);
  expect(new Set([...first.messages, ...second.messages].map(message => message.seq)).size).toBe(60);
});

it('I04: stops at the first message that does not fit the character budget and resumes without loss across pages', async () => {
  const { store, append } = await setup(7);
  for (let index = 0; index < 60; index++) await append({ text: 'x'.repeat(500) });

  const first = await build(store, 0, 60);
  expect(first.messages).toHaveLength(48);
  expect(first.messages.reduce((sum, message) => sum + message.text.length, 0)).toBe(24_000);
  expect(first.processedThroughSeq).toBe(48);
  expect(first.reachedTrigger).toBe(false);

  const second = await build(store, first.processedThroughSeq, 60);
  expect(second.messages).toHaveLength(12);
  expect(second.messages.map(message => message.seq)).toEqual(Array.from({ length: 12 }, (_, index) => index + 49));
  expect(second.processedThroughSeq).toBe(60);

  let after = 0;
  const scanned: number[] = [];
  for (;;) {
    const page = await store.readRange(conversation, { afterSeq: after, throughSeq: 60, limit: 3 });
    scanned.push(...page.records.map(record => record.seq!));
    after = page.scannedThroughSeq;
    if (page.exhausted) break;
  }
  expect(scanned).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
});

it('I04: admission counting is separate from the character-bounded batch', async () => {
  const { store, append } = await setup();
  for (let index = 0; index < 6; index++) await append({ text: `${index}-${'x'.repeat(13_000)}` });

  const first = await build(store, 0, 6, 6);
  expect(first.messages).toHaveLength(1);
  expect(first.eligibleTexts).toBe(6);
  expect(first.processedThroughSeq).toBe(1);
  expect(first.fromSeq).toBe(1);
  expect(first.throughSeq).toBe(1);

  const second = await build(store, 1, 6, 6);
  expect(second.messages).toHaveLength(1);
  expect(second.messages[0]!.seq).toBe(2);
  expect(second.eligibleTexts).toBe(5);
  expect(second.processedThroughSeq).toBe(2);
  expect(second.reachedTrigger).toBe(true);
});

it('I05: a capped admission scan resumes after the last inspected record without re-reading', async () => {
  const { store, append } = await setup();
  for (let index = 0; index < 6; index++) await append({ text: `${index}-${'x'.repeat(13_000)}` });
  const reads: number[] = [];
  const original = store.readRange.bind(store);
  vi.spyOn(store, 'readRange').mockImplementation(async (ref, range) => {
    reads.push(range.afterSeq);
    return original(ref, range);
  });

  const batches: ExtractionInputBatch[] = [];
  let resume: ExtractionScanResume | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const batch = await buildExtractionInput({
      store,
      conversation,
      scope,
      afterSeq: 0,
      throughSeq: 6,
      admissionTexts: 6,
      scanLimit: 2,
      ...(resume ? { resume } : {})
    });
    batches.push(batch);
    resume = batch.scan
      ? {
        afterSeq: batch.scan.afterSeq,
        messages: batch.messages,
        processedThroughSeq: batch.processedThroughSeq,
        eligibleTexts: batch.eligibleTexts,
        batchClosed: batch.scan.batchClosed
      }
      : undefined;
  }

  // Each trigger reads only the next record budget; the seeded prefix is never read again.
  expect(reads).toEqual([0, 2, 4]);
  expect(batches[0]).toMatchObject({ eligibleTexts: 2, processedThroughSeq: 1 });
  expect(batches[0]!.messages.map(message => message.seq)).toEqual([1]);
  expect(batches[0]!.scan).toEqual({ afterSeq: 2, batchClosed: true });
  expect(batches[1]).toMatchObject({ eligibleTexts: 4, processedThroughSeq: 1 });
  expect(batches[1]!.messages.map(message => message.seq)).toEqual([1]);
  expect(batches[1]!.scan).toEqual({ afterSeq: 4, batchClosed: true });
  expect(batches[2]).toMatchObject({ eligibleTexts: 6, processedThroughSeq: 1 });
  expect(batches[2]!.messages.map(message => message.seq)).toEqual([1]);
  expect(batches[2]!.scan).toBeUndefined();
});

it('I05: skips outbound, other-epoch, empty, media-only and overlong records while advancing the cursor', async () => {
  const { store, append } = await setup();
  await append({ direction: 'out', text: 'assistant text' });
  await append({ text: 'old role text', contextEpoch: 'epoch-old' });
  await append({ text: '   ' });
  await append({ segments: [{ type: 'image', data: { file: 'a.png' } }] });
  await append({ text: 'x'.repeat(EXTRACTION_INPUT_LIMITS.maxBatchChars + 1) });
  for (let index = 0; index < 5; index++) await append({ text: `kept-${index}` });

  const batch = await build(store, 0, 10);
  expect(batch.messages.map(message => message.text)).toEqual(Array.from({ length: 5 }, (_, index) => `kept-${index}`));
  expect(batch.fromSeq).toBe(6);
  expect(batch.throughSeq).toBe(10);
  expect(batch.processedThroughSeq).toBe(10);
  expect(batch.reachedTrigger).toBe(true);
  expect(batch.skipped).toEqual({ outbound: 1, otherEpoch: 1, emptyText: 2, overlong: 1 });
});

it('I05: a large but individually valid message is deferred to the next batch instead of being dropped', async () => {
  const { store, append } = await setup();
  for (let index = 0; index < 10; index++) await append({ text: 'x'.repeat(10) });
  await append({ text: 'y'.repeat(20_000) });
  const last = await append({ text: 'z'.repeat(5_000) });

  const first = await build(store, 0, 12);
  expect(first.messages).toHaveLength(11);
  expect(first.messages.at(-1)?.text).toHaveLength(20_000);
  expect(first.processedThroughSeq).toBe(11);
  expect(first.eligibleTexts).toBe(6);
  expect(first.reachedTrigger).toBe(true);
  expect(first.skipped.overlong).toBe(0);

  const second = await build(store, first.processedThroughSeq, last.seq);
  expect(second.messages.map(message => message.text)).toEqual(['z'.repeat(5_000)]);
  expect(second.processedThroughSeq).toBe(12);
  expect(second.reachedTrigger).toBe(true);
});

it('I06: uses only current-epoch inbound user text and preserves the group sender', async () => {
  const { store, append } = await setup();
  await append({ direction: 'out', text: 'ASSISTANT_REPLY' });
  await append({ text: 'OTHER_EPOCH_USER', contextEpoch: 'epoch-old' });
  await append({ text: 'CURRENT_USER', senderId: 'alice' });
  await append({ segments: [{ type: 'image', data: { file: 'b.png' } }], senderId: 'bob' });

  const batch = await build(store, 0, 4);
  expect(batch.messages).toEqual([{ seq: 3, text: 'CURRENT_USER', senderId: 'alice' }]);
  const serialized = JSON.stringify(batch);
  expect(serialized).not.toContain('ASSISTANT_REPLY');
  expect(serialized).not.toContain('OTHER_EPOCH_USER');
  expect(serialized).not.toContain('bob');
});

it('I07: source keys are deterministic per evidence/identity and change with model, prompt, generation or boundary', async () => {
  const { store, append } = await setup();
  for (let index = 0; index < 3; index++) await append({ text: `fact-${index}` });
  const batch = await build(store, 0, 3);
  const key = extractionSourceKey(batch, identity);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(extractionSourceKey(batch, identity)).toBe(key);
  expect(extractionSourceKey(await build(store, 0, 3), identity)).toBe(key);
  expect(extractionSourceKey(batch, { ...identity, modelIdentity: 'other-model' })).not.toBe(key);
  expect(extractionSourceKey(batch, { ...identity, promptVersion: 'v2' })).not.toBe(key);
  expect(extractionSourceKey(batch, { ...identity, generation: 4 })).not.toBe(key);
  expect(extractionSourceKey(batch, { ...identity, activationBoundary: 11 })).not.toBe(key);
  expect(key).not.toContain('fact-0');
  expect(EXTRACTION_PROMPT_VERSION).toBe('fact-extraction-v1');

  const different = await buildExtractionInput({
    store,
    conversation,
    scope: { contextEpoch: 'epoch-a' },
    afterSeq: 1,
    throughSeq: 3
  });
  expect(extractionSourceKey(different, identity)).not.toBe(key);
});

it('I03: a per-account store refuses another account conversation and does not leak its messages', async () => {
  const { store, append } = await setup();
  await append({ text: 'ACCOUNT_10001_SECRET' });
  const foreign: ConversationRef = { accountId: '10002', kind: 'private', peerId: '555' };
  await expect(store.readRange(foreign, { afterSeq: 0, throughSeq: 1, limit: 10 })).rejects.toMatchObject({
    code: 'isolation_violation'
  });
  await expect(store.lastSeq(foreign)).rejects.toMatchObject({ code: 'isolation_violation' });
});

it('readRange honours the exclusive lower and inclusive upper bounds and empty ranges', async () => {
  const { store, append } = await setup(2);
  for (let index = 0; index < 5; index++) await append({ text: `m${index}` });
  const page = await store.readRange(conversation, { afterSeq: 1, throughSeq: 4, limit: 10 });
  expect(page.records.map(record => record.seq)).toEqual([2, 3, 4]);
  expect(page.scannedThroughSeq).toBe(4);
  expect(page.exhausted).toBe(true);
  const empty = await store.readRange(conversation, { afterSeq: 3, throughSeq: 3, limit: 10 });
  expect(empty).toEqual({ records: [], scannedThroughSeq: 3, exhausted: true });
  const beyond = await store.readRange(conversation, { afterSeq: 5, throughSeq: 9, limit: 10 });
  expect(beyond).toEqual({ records: [], scannedThroughSeq: 9, exhausted: true });
});

it('readRange keeps a surviving segment when retention prunes the oldest segment during the read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-input-'));
  roots.push(root);
  const store = new JsonlStore({
    root: path.join(root, 'messages'),
    accountId: '10001',
    segmentRecords: 2,
    maxRecordsPerConversation: 6
  });
  stores.push(store);
  let index = 0;
  const append = (text: string): Promise<unknown> => {
    index += 1;
    return store.append(conversation, {
      id: `m-${index}`,
      at: 1_700_000_000_000 + index,
      direction: 'in',
      contextEpoch: 'epoch-a',
      segments: [{ type: 'text', data: { text } }]
    });
  };
  for (const text of ['a', 'b', 'c', 'd', 'e', 'f']) await append(text);

  const target = path.join(root, 'messages', 'private', '555', '000001.jsonl');
  let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = fs.readFile.bind(fs);
  let blocked = false;
  vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
    if (!blocked && String(file) === target) {
      blocked = true;
      reached();
      await gate;
    }
    return original(file, options);
  });

  const pending = store.readRange(conversation, { afterSeq: 0, throughSeq: 6, limit: 10 });
  await entered;
  // One flush batch makes the next prune remove two whole segments at once.
  await Promise.all([append('g'), append('h'), append('i')]);
  release();
  const page = await pending;
  vi.restoreAllMocks();

  expect(page.records.map(record => record.seq)).toEqual([4, 5, 6]);
  expect(page.scannedThroughSeq).toBe(6);
  expect(page.exhausted).toBe(true);
  const remaining = await store.readRange(conversation, { afterSeq: 0, throughSeq: 9, limit: 10 });
  expect(remaining.records.map(record => record.seq)).toEqual([4, 5, 6, 7, 8, 9]);
});
