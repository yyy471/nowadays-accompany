import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryService } from '../src/application/memory/memory-service.js';
import { MemoryStore } from '../src/memory/store.js';
import { JsonlStore } from '../src/storage/jsonl-store.js';
import { defaultMemoryState, memoryNamespace, memoryPayloadDigest } from '../src/memory/schema.js';
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_DEFAULT_REVISION,
  MEMORY_LIMITS,
  type MemoryRecord,
  type MemoryScope,
  type MemoryState
} from '../src/memory/types.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-extraction-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const privateConv: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };

function epochFor(conversation: ConversationRef = privateConv, epoch = 'epoch-a'): string {
  return `${conversation.accountId}:${conversation.kind}:${conversation.peerId}:${epoch}`;
}

function scopeFor(conversation: ConversationRef = privateConv, epoch = 'epoch-a'): MemoryScope {
  return { ...conversation, contextEpoch: epochFor(conversation, epoch) };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-'));
  roots.push(root);
  const messages = { seq: 0, calls: 0 };
  let now = 1_700_000_000_000;
  const service = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => epochFor({ ...conversation, accountId }) },
    accountDir: accountId => path.join(root, 'accounts', accountId),
    messages: {
      lastSeq: async () => {
        messages.calls += 1;
        return messages.seq;
      }
    },
    now: () => now
  });
  return { root, service, messages, tick: (ms = 1) => { now += ms; } };
}

function recordAt(index: number, content = `记录${index}`, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `r-seed-${index}`,
    revision: `rr-${index}`,
    type: 'fact',
    content,
    keys: [],
    pinned: false,
    origin: 'user',
    createdAt: 1_600_000_000_000 + index,
    updatedAt: 1_600_000_000_000 + index,
    ...overrides
  };
}

const activeSettings = { enabled: true, autoExtract: true, budgetChars: 1500, maxSelected: 8 };
const confirmed = { startFrom: 'now', confirmModelUse: true };

async function seedState(
  root: string,
  records: MemoryRecord[],
  overrides: Partial<MemoryState> = {},
  conversation: ConversationRef = privateConv
) {
  const scope = scopeFor(conversation);
  const state: MemoryState = {
    ...defaultMemoryState(scope),
    revision: 'seed-r1',
    generation: 5,
    records,
    ...overrides
  };
  const file = stateFile(root, conversation);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state));
  return { scope, file, state };
}

function stateFile(root: string, conversation: ConversationRef = privateConv, epoch = 'epoch-a'): string {
  return path.join(root, 'accounts', conversation.accountId, 'memory', memoryNamespace(scopeFor(conversation, epoch)), 'state.json');
}

async function enableMemory(service: MemoryService, conversation: ConversationRef = privateConv, autoExtract = false) {
  const view = await service.settings(conversation);
  return service.saveSettings(conversation, {
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true, autoExtract },
    expectedScope: view.scopeToken,
    expectedRevision: view.revision
  });
}

async function activate(service: MemoryService, conversation: ConversationRef = privateConv) {
  const view = await service.settings(conversation);
  return service.activateExtraction(conversation, { ...confirmed, expectedScope: view.scopeToken, expectedRevision: view.revision });
}

async function createRecord(service: MemoryService, content = '喜欢银杏', conversation: ConversationRef = privateConv) {
  const view = await service.settings(conversation);
  return service.createRecord(conversation, {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    expectedScope: view.scopeToken,
    expectedRevision: view.revision,
    record: { content, keys: [] }
  });
}

it('A01: a legacy autoExtract=true file needs explicit confirmation and keeps no activation metadata', async () => {
  const { root, service, messages } = await setup();
  const { file } = await seedState(root, [recordAt(1)], {
    settings: { ...activeSettings, autoExtract: true }
  });
  const before = await fs.readFile(file, 'utf8');

  const status = await service.extractionStatus(privateConv);
  expect(status.extraction).toMatchObject({
    effectiveStatus: 'needs-confirmation',
    autoExtract: true,
    throughSeq: 0,
    recentResultCount: 0
  });
  expect(status.extraction.activationVersion).toBeUndefined();
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect(messages.calls).toBe(0);

  const restarted = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => epochFor({ ...conversation, accountId }) },
    accountDir: accountId => path.join(root, 'accounts', accountId),
    messages: { lastSeq: async () => messages.seq }
  });
  expect((await restarted.extractionStatus(privateConv)).extraction.effectiveStatus).toBe('needs-confirmation');

  const resaved = await restarted.saveSettings(privateConv, {
    settings: { ...activeSettings },
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1'
  });
  expect(resaved.extraction.effectiveStatus).toBe('needs-confirmation');
  expect(resaved.extraction.activationVersion).toBeUndefined();
  expect(JSON.parse(await fs.readFile(file, 'utf8')).extraction?.activationVersion).toBeUndefined();
  expect(messages.calls).toBe(0);
});

it('A02: activation rejects missing confirmation, backfill, stale expectations and disabled memory', async () => {
  const { root, service, messages } = await setup();
  const initial = await service.settings(privateConv);
  const base = { expectedScope: initial.scopeToken, expectedRevision: initial.revision };

  await expect(service.activateExtraction(privateConv, { ...base, startFrom: 'now' })).rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.activateExtraction(privateConv, { ...base, startFrom: 'now', confirmModelUse: false }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.activateExtraction(privateConv, { ...base, startFrom: 'history', confirmModelUse: true }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.activateExtraction(privateConv, { ...base, startFrom: 'now', confirmModelUse: true, backfill: true }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.activateExtraction(privateConv, { ...base, startFrom: 'now', confirmModelUse: true, expectedRevision: 'stale' }))
    .rejects.toMatchObject({ code: 'memory_conflict' });
  await expect(service.activateExtraction(privateConv, { ...base, startFrom: 'now', confirmModelUse: true, expectedScope: 'f'.repeat(64) }))
    .rejects.toMatchObject({ code: 'memory_conflict' });

  await expect(service.activateExtraction(privateConv, { ...base, ...confirmed }))
    .rejects.toMatchObject({ code: 'memory_extraction_disabled' });
  expect(messages.calls).toBe(0);
  await expect(fs.stat(path.join(root, 'accounts/10001/memory'))).rejects.toMatchObject({ code: 'ENOENT' });

  const enabled = await enableMemory(service);
  const withoutMessages = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => epochFor({ ...conversation, accountId }) },
    accountDir: accountId => path.join(root, 'accounts', accountId)
  });
  await expect(withoutMessages.activateExtraction(privateConv, {
    expectedScope: enabled.scopeToken,
    expectedRevision: enabled.revision,
    ...confirmed
  })).rejects.toMatchObject({ code: 'memory_extraction_unavailable' });
});

it('A03: activation freezes the stable latest seq as the boundary without touching history', async () => {
  const { root, service, messages } = await setup();
  await enableMemory(service);
  const created = await createRecord(service);
  messages.seq = 7;

  const activated = await activate(service);
  expect(activated.settings.autoExtract).toBe(true);
  expect(activated.extraction).toMatchObject({
    effectiveStatus: 'active',
    autoExtract: true,
    activationVersion: 1,
    activatedAfterSeq: 7,
    throughSeq: 7
  });
  expect(activated.generation).toBe(created.generation + 1);
  expect(messages.calls).toBe(1);
  expect((await service.listRecords(privateConv)).items.map(item => item.id)).toEqual([created.record.id]);
  expect(JSON.parse(await fs.readFile(stateFile(root), 'utf8')).extraction).toMatchObject({ throughSeq: 7, activatedAfterSeq: 7 });

  const idle = { ...privateConv, peerId: '556' };
  await enableMemory(service, idle);
  messages.seq = 0;
  const idleActivated = await activate(service, idle);
  expect(idleActivated.extraction).toMatchObject({ effectiveStatus: 'active', throughSeq: 0, activatedAfterSeq: 0 });
});

it('A03b: activation and pause revalidate the role epoch before the commit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-'));
  roots.push(root);
  let epoch = 'epoch-a';
  let calls = 0;
  let armed = false;
  const service = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => {
      const current = epoch;
      calls += 1;
      if (armed && calls === 1) epoch = 'epoch-b';
      return epochFor({ ...conversation, accountId }, current);
    } },
    accountDir: accountId => path.join(root, 'accounts', accountId),
    messages: { lastSeq: async () => 3 }
  });
  const enabled = await enableMemory(service);
  const file = stateFile(root, privateConv, 'epoch-a');
  const before = await fs.readFile(file, 'utf8');
  const reset = (): void => { epoch = 'epoch-a'; calls = 0; armed = false; };

  armed = true;
  calls = 0;
  await expect(service.activateExtraction(privateConv, {
    expectedScope: enabled.scopeToken,
    expectedRevision: enabled.revision,
    ...confirmed
  })).rejects.toMatchObject({ code: 'memory_conflict' });
  reset();
  expect(await fs.readFile(file, 'utf8')).toBe(before);

  const activated = await activate(service);
  const activeBytes = await fs.readFile(file, 'utf8');
  armed = true;
  calls = 0;
  await expect(service.pauseExtraction(privateConv, {
    expectedScope: activated.scopeToken,
    expectedRevision: activated.revision
  })).rejects.toMatchObject({ code: 'memory_conflict' });
  reset();
  expect(await fs.readFile(file, 'utf8')).toBe(activeBytes);
  await expect(fs.stat(stateFile(root, privateConv, 'epoch-b'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('C01: an attempt reservation keeps generation stable; failure cooldown blocks new starts without touching content revision', async () => {
  const { root, service } = await setup();
  await seedState(root, [recordAt(1)], {
    settings: activeSettings,
    extraction: { throughSeq: 4, activationVersion: 1, activatedAfterSeq: 4 }
  });
  const scopeToken = memoryNamespace(scopeFor());
  expect(await service.beginExtractionAttempt(privateConv, scopeToken, 5, 4, 1_700_000_100_000))
    .toEqual({ started: true });
  let status = await service.extractionStatus(privateConv);
  expect(status).toMatchObject({
    revision: 'seed-r1',
    generation: 5,
    extraction: { effectiveStatus: 'active', throughSeq: 4, lastAttemptAt: 1_700_000_100_000 }
  });

  expect(await service.beginExtractionAttempt(privateConv, scopeToken, 4, 4, 1_700_000_100_000))
    .toEqual({ started: false, reason: 'generation_changed' });
  expect(await service.beginExtractionAttempt(privateConv, scopeToken, 5, 3, 1_700_000_100_000))
    .toEqual({ started: false, reason: 'watermark_changed' });
  expect(await service.beginExtractionAttempt(privateConv, 'f'.repeat(64), 5, 4, 1_700_000_100_000))
    .toEqual({ started: false, reason: 'scope_changed' });

  expect(await service.recordExtractionFailure(privateConv, scopeToken, 5, {
    code: 'provider_timeout',
    at: 1_700_000_200_000,
    cooldownUntil: 1_700_000_800_000
  })).toBe(true);
  status = await service.extractionStatus(privateConv);
  expect(status).toMatchObject({
    revision: 'seed-r1',
    generation: 5,
    extraction: {
      effectiveStatus: 'cooldown',
      lastAttemptAt: 1_700_000_100_000,
      cooldownUntil: 1_700_000_800_000,
      lastFailure: { code: 'provider_timeout', at: 1_700_000_200_000 }
    }
  });
  expect(await service.beginExtractionAttempt(privateConv, scopeToken, 5, 4, 1_700_000_300_000))
    .toEqual({ started: false, reason: 'cooldown' });
  expect(await service.beginExtractionAttempt(privateConv, scopeToken, 5, 4, 1_700_000_800_001))
    .toEqual({ started: true });

  expect(await service.recordExtractionFailure(privateConv, scopeToken, 4, {
    code: 'late_old_job',
    at: 1_700_000_900_000,
    cooldownUntil: 1_700_001_500_000
  })).toBe(false);
  const persisted = JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
  expect(persisted.revision).toBe('seed-r1');
  expect(persisted.generation).toBe(5);
  expect(persisted.extraction.lastFailure.code).toBe('provider_timeout');
});

it('C01b: fatal failure reports failed, and only an explicit activation clears it', async () => {
  const { root, service } = await setup();
  await seedState(root, [recordAt(1)], {
    settings: activeSettings,
    extraction: { throughSeq: 4, activationVersion: 1, activatedAfterSeq: 4, lastAttemptAt: 1_700_000_100_000 }
  });
  const scopeToken = memoryNamespace(scopeFor());
  expect(await service.recordExtractionFailure(privateConv, scopeToken, 5, {
    code: 'commit_io_error',
    fatal: true,
    at: 1_700_000_200_000
  })).toBe(true);
  let status = await service.extractionStatus(privateConv);
  expect(status.extraction).toMatchObject({
    effectiveStatus: 'failed',
    autoExtract: true,
    lastFailure: { code: 'commit_io_error', fatal: true }
  });
  expect(await service.beginExtractionAttempt(privateConv, scopeToken, 5, 4, 1_700_000_300_000))
    .toEqual({ started: false, reason: 'failed' });

  const reactivated = await service.activateExtraction(privateConv, {
    expectedScope: scopeToken,
    expectedRevision: status.revision,
    ...confirmed
  });
  expect(reactivated.extraction).toMatchObject({ effectiveStatus: 'active', throughSeq: 4 });
  expect(reactivated.extraction.lastFailure).toBeUndefined();
  expect(reactivated.extraction.cooldownUntil).toBeUndefined();
  expect(reactivated.generation).toBe(6);
});

it('C01c: attempt and failure writes revalidate the role epoch before commit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-'));
  roots.push(root);
  let epoch = 'epoch-a';
  let calls = 0;
  let armed = false;
  const service = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => {
      const current = epoch;
      calls += 1;
      if (armed && calls === 1) epoch = 'epoch-b';
      return epochFor({ ...conversation, accountId }, current);
    } },
    accountDir: accountId => path.join(root, 'accounts', accountId),
    messages: { lastSeq: async () => 4 }
  });
  await seedState(root, [recordAt(1)], {
    settings: activeSettings,
    extraction: { throughSeq: 4, activationVersion: 1, activatedAfterSeq: 4 }
  });
  const scopeToken = memoryNamespace(scopeFor());
  const file = stateFile(root);
  const before = await fs.readFile(file, 'utf8');
  armed = true;
  calls = 0;
  await expect(service.beginExtractionAttempt(privateConv, scopeToken, 5, 4, 1_700_000_100_000))
    .rejects.toMatchObject({ code: 'memory_conflict' });
  epoch = 'epoch-a';
  armed = false;
  calls = 0;
  expect(await fs.readFile(file, 'utf8')).toBe(before);

  await service.beginExtractionAttempt(privateConv, scopeToken, 5, 4, 1_700_000_100_000);
  const attempted = await fs.readFile(file, 'utf8');
  armed = true;
  calls = 0;
  await expect(service.recordExtractionFailure(privateConv, scopeToken, 5, {
    code: 'provider_timeout',
    at: 1_700_000_200_000,
    cooldownUntil: 1_700_000_800_000
  })).rejects.toMatchObject({ code: 'memory_conflict' });
  epoch = 'epoch-a';
  armed = false;
  expect(await fs.readFile(file, 'utf8')).toBe(attempted);
});

it('D01: commits model facts, watermark, receipt and revision atomically with server-owned fields', async () => {
  const { root, service } = await setup();
  await seedState(root, [recordAt(1, '已有事实')], {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const sourceKey = 'c'.repeat(64);
  const result = await service.commitExtraction(privateConv, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 8,
    sourceKey,
    facts: [
      { content: '喜欢银杏', keys: ['银杏'], fromSeq: 7, throughSeq: 7 },
      { content: '住在杭州', keys: ['杭州'], fromSeq: 8, throughSeq: 8 }
    ],
    now: 1_700_000_900_000
  });
  expect(result).toMatchObject({
    committed: true,
    duplicate: false,
    added: 2,
    capacityPaused: false,
    generation: 6,
    throughSeq: 8
  });
  expect(result.revision).not.toBe('seed-r1');

  const persisted = JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
  expect(persisted.revision).toBe(result.revision);
  expect(persisted.generation).toBe(6);
  expect(persisted.records).toHaveLength(3);
  const added = (persisted.records as Array<Record<string, unknown>>)
    .filter(record => record.origin === 'model');
  expect(added).toHaveLength(2);
  expect(added).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'fact', origin: 'model', pinned: false, content: '住在杭州', keys: ['杭州'], source: { fromSeq: 8, throughSeq: 8 } }),
    expect.objectContaining({ type: 'fact', origin: 'model', pinned: false, content: '喜欢银杏', keys: ['银杏'], source: { fromSeq: 7, throughSeq: 7 } })
  ]));
  expect(added.every(record => typeof record.id === 'string' && record.id !== ''
    && typeof record.revision === 'string' && record.createdAt === 1_700_000_900_000)).toBe(true);
  expect(persisted.extraction).toMatchObject({
    throughSeq: 8,
    activationVersion: 1,
    lastCompletedSourceKey: sourceKey,
    lastSuccessAt: 1_700_000_900_000,
    recentResults: [{ sourceKey, throughSeq: 8, at: 1_700_000_900_000 }]
  });
  expect(persisted.extraction.lastFailure).toBeUndefined();
  expect(persisted.extraction.cooldownUntil).toBeUndefined();
  const view = await service.extractionStatus(privateConv);
  expect(view).toMatchObject({ generation: 6, extraction: { effectiveStatus: 'active', throughSeq: 8 } });
});

it('D02: replays the same sourceKey before stale revision checks, including after a later delete', async () => {
  const { root, service } = await setup();
  await seedState(root, [], {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const sourceKey = 'd'.repeat(64);
  const input = {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 8,
    sourceKey,
    facts: [{ content: '可重放事实', keys: [], fromSeq: 7, throughSeq: 8 }],
    now: 1_700_000_900_000
  };
  const first = await service.commitExtraction(privateConv, input);
  expect(first).toMatchObject({ committed: true, added: 1, generation: 6 });
  const replay = await service.commitExtraction(privateConv, input);
  expect(replay).toMatchObject({
    committed: false,
    duplicate: true,
    added: 0,
    revision: first.revision,
    generation: first.generation,
    throughSeq: 8
  });
  expect(JSON.parse(await fs.readFile(stateFile(root), 'utf8')).records).toHaveLength(1);

  const persisted = JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
  const added = persisted.records[0];
  const deleted = await service.deleteRecord(privateConv, added.id, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: first.revision,
    recordRevision: added.revision
  });
  expect(deleted.recordCount).toBe(0);
  const afterDelete = await service.commitExtraction(privateConv, input);
  expect(afterDelete).toMatchObject({ committed: false, duplicate: true, added: 0, revision: deleted.revision });
  expect(JSON.parse(await fs.readFile(stateFile(root), 'utf8')).records).toHaveLength(0);
});

it('D03: rejects stale, paused, invalid-range and invalid-source commits without side effects', async () => {
  const { root, service } = await setup();
  await seedState(root, [], {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const file = stateFile(root);
  const before = await fs.readFile(file, 'utf8');
  const base = {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 8,
    sourceKey: 'e'.repeat(64),
    facts: [{ content: '事实', keys: [], fromSeq: 7, throughSeq: 7 }],
    now: 1_700_000_900_000
  };
  await expect(service.commitExtraction(privateConv, { ...base, expectedGeneration: 4 }))
    .rejects.toMatchObject({ code: 'memory_conflict' });
  await expect(service.commitExtraction(privateConv, { ...base, expectedRevision: 'stale' }))
    .rejects.toMatchObject({ code: 'memory_conflict' });
  await expect(service.commitExtraction(privateConv, { ...base, expectedThroughSeq: 5 }))
    .rejects.toMatchObject({ code: 'memory_conflict' });
  await expect(service.commitExtraction(privateConv, { ...base, sourceKey: 'not-a-source' }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.commitExtraction(privateConv, { ...base, processedThroughSeq: 5 }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.commitExtraction(privateConv, { ...base,
    facts: [{ content: '事实', keys: [], fromSeq: 6, throughSeq: 7 }] }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.commitExtraction(privateConv, { ...base,
    facts: Array.from({ length: 9 }, (_, index) => ({ content: `事实${index}`, keys: [], fromSeq: 7, throughSeq: 7 })) }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.commitExtraction(privateConv, { ...base,
    facts: [{ content: 'x'.repeat(1_001), keys: [], fromSeq: 7, throughSeq: 7 }] }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.commitExtraction(privateConv, { ...base,
    facts: [{ content: '事实', keys: ['k'.repeat(65)], fromSeq: 7, throughSeq: 7 }] }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  expect(await fs.readFile(file, 'utf8')).toBe(before);

  const paused = await service.saveSettings(privateConv, {
    settings: { ...activeSettings, autoExtract: false },
    expectedScope: base.expectedScope,
    expectedRevision: base.expectedRevision
  });
  await expect(service.commitExtraction(privateConv, { ...base, expectedRevision: paused.revision,
    expectedGeneration: paused.generation })).rejects.toMatchObject({ code: 'memory_conflict' });
});

it('D04: skips exact duplicates against existing records and within the batch, still advancing the watermark', async () => {
  const { root, service } = await setup();
  await seedState(root, [recordAt(1, '喜欢银杏')], {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const result = await service.commitExtraction(privateConv, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 8,
    sourceKey: 'f'.repeat(64),
    facts: [
      { content: '  喜欢银杏 ', keys: [], fromSeq: 7, throughSeq: 7 },
      { content: '住在杭州', keys: [], fromSeq: 7, throughSeq: 7 },
      { content: ' 住在杭州 ', keys: [], fromSeq: 8, throughSeq: 8 }
    ],
    now: 1_700_000_900_000
  });
  expect(result).toMatchObject({ committed: true, added: 1, throughSeq: 8 });
  const persisted = JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
  expect(persisted.records).toHaveLength(2);
  expect(persisted.extraction.throughSeq).toBe(8);

  const empty = await service.commitExtraction(privateConv, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: result.revision,
    expectedGeneration: result.generation,
    expectedThroughSeq: 8,
    processedThroughSeq: 9,
    sourceKey: '1'.repeat(64),
    facts: [],
    now: 1_700_001_000_000
  });
  expect(empty).toMatchObject({ committed: true, added: 0, throughSeq: 9 });
  expect(JSON.parse(await fs.readFile(stateFile(root), 'utf8')).extraction.throughSeq).toBe(9);
});

it('O06: model suggestions never update or overwrite manual facts', async () => {
  const { root, service } = await setup();
  const manual = recordAt(1, '喜欢咖啡', { pinned: true, keys: ['咖啡'], origin: 'user' });
  await seedState(root, [manual], {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const result = await service.commitExtraction(privateConv, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 8,
    sourceKey: 'a1'.repeat(32),
    facts: [
      { content: '喜欢咖啡', keys: ['模型改写'], fromSeq: 7, throughSeq: 7 },
      { content: '也喜欢茶', keys: ['茶'], fromSeq: 8, throughSeq: 8 }
    ],
    now: 1_700_000_900_000
  });
  expect(result).toMatchObject({ committed: true, added: 1, throughSeq: 8 });
  const persisted = JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
  expect(persisted.records).toHaveLength(2);
  expect(persisted.records[0]).toEqual(manual);
  expect(persisted.records[1]).toMatchObject({ content: '也喜欢茶', origin: 'model', pinned: false });
  expect(persisted.records.some((record: MemoryRecord) => record.origin === 'model' && record.content === '喜欢咖啡')).toBe(false);
});

it('O07: a failed state write leaves records, watermark and receipt untouched for a safe retry', async () => {
  const { root, service } = await setup();
  await seedState(root, [], {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const before = await fs.readFile(stateFile(root), 'utf8');
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('state.json')) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    return rename(from, to);
  });
  const input = {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 8,
    sourceKey: 'b2'.repeat(32),
    facts: [{ content: '写入失败后重试', keys: [], fromSeq: 7, throughSeq: 7 }],
    now: 1_700_000_900_000
  };
  await expect(service.commitExtraction(privateConv, input)).rejects.toMatchObject({ code: 'memory_io_error' });
  vi.restoreAllMocks();

  expect(await fs.readFile(stateFile(root), 'utf8')).toBe(before);
  const after = await service.extractionStatus(privateConv);
  expect(after.extraction).toMatchObject({ throughSeq: 6, effectiveStatus: 'active' });
  expect(after.extraction.lastCompletedSourceKey).toBeUndefined();
  expect((await service.listRecords(privateConv)).total).toBe(0);

  const retried = await service.commitExtraction(privateConv, input);
  expect(retried).toMatchObject({ committed: true, added: 1, throughSeq: 8 });
});

it('D05: capacity rejects the whole batch and atomically pauses without advancing the watermark', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-'));
  roots.push(root);
  const service = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => epochFor({ ...conversation, accountId }) },
    accountDir: accountId => path.join(root, 'accounts', accountId),
    store: new MemoryStore({ maxStateFileBytes: 4_096 })
  });
  await seedState(root, [], {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const result = await service.commitExtraction(privateConv, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 8,
    sourceKey: '2'.repeat(64),
    facts: Array.from({ length: 4 }, (_, index) => ({
      content: `${index}-${'x'.repeat(900)}`,
      keys: ['容量'],
      fromSeq: 7,
      throughSeq: 8
    })),
    now: 1_700_000_900_000
  });
  expect(result).toMatchObject({
    committed: false,
    duplicate: false,
    added: 0,
    capacityPaused: true,
    generation: 6,
    throughSeq: 6
  });
  const persisted = JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
  expect(persisted.records).toEqual([]);
  expect(persisted.settings.autoExtract).toBe(false);
  expect(persisted.extraction).toMatchObject({ throughSeq: 6, pausedReason: 'capacity' });
  expect(persisted.extraction.activationVersion).toBeUndefined();
  expect(persisted.extraction.recentResults).toBeUndefined();
  expect(persisted.extraction.lastSuccessAt).toBeUndefined();
  expect(Buffer.byteLength(await fs.readFile(stateFile(root), 'utf8'), 'utf8')).toBeLessThanOrEqual(4_096);
  expect((await service.extractionStatus(privateConv)).extraction).toMatchObject({
    effectiveStatus: 'paused',
    pausedReason: 'capacity',
    throughSeq: 6
  });
});

it('O08: the record-count limit rejects the whole batch and pauses with a clear reason', async () => {
  const { root, service } = await setup();
  const records = Array.from({ length: MEMORY_LIMITS.maxRecords }, (_, index) =>
    recordAt(index + 1, `已有记录${index + 1}`));
  await seedState(root, records, {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const result = await service.commitExtraction(privateConv, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 7,
    sourceKey: 'c3'.repeat(32),
    facts: [{ content: '超过记录上限', keys: [], fromSeq: 7, throughSeq: 7 }],
    now: 1_700_000_900_000
  });
  expect(result).toMatchObject({
    committed: false,
    added: 0,
    capacityPaused: true,
    throughSeq: 6
  });
  const persisted = JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
  expect(persisted.records).toHaveLength(MEMORY_LIMITS.maxRecords);
  expect(persisted.extraction).toMatchObject({
    throughSeq: 6,
    pausedReason: 'capacity'
  });
  expect(persisted.settings.autoExtract).toBe(false);
});

it('I05: scan advance moves only over a no-text prefix and rechecks activation and watermark', async () => {
  const { root, service } = await setup();
  await seedState(root, [recordAt(1, '保留的记录')], {
    settings: activeSettings,
    extraction: { throughSeq: 6, activationVersion: 1, activatedAfterSeq: 6 }
  });
  const scope = memoryNamespace(scopeFor());
  const base = {
    expectedScope: scope,
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 1_000,
    now: 1_700_000_900_000
  };
  expect(await service.advanceExtraction(privateConv, base)).toBe(true);
  const advanced = await service.extractionStatus(privateConv);
  expect(advanced).toMatchObject({ generation: 6, extraction: { throughSeq: 1_000, effectiveStatus: 'active' } });
  expect(advanced.extraction.lastCompletedSourceKey).toBeUndefined();
  expect((await service.listRecords(privateConv)).total).toBe(1);

  expect(await service.advanceExtraction(privateConv, base)).toBe(false);
  expect(await service.advanceExtraction(privateConv, { ...base, expectedGeneration: 6, expectedThroughSeq: 1_000,
    processedThroughSeq: 999 })).toBe(false);

  const paused = await service.pauseExtraction(privateConv, {
    expectedScope: advanced.scopeToken,
    expectedRevision: advanced.revision
  });
  expect(await service.advanceExtraction(privateConv, {
    ...base,
    expectedGeneration: paused.generation,
    expectedThroughSeq: 1_000,
    processedThroughSeq: 2_000
  })).toBe(false);
  expect((await service.extractionStatus(privateConv)).extraction.throughSeq).toBe(1_000);
});

it('A04: deleting a fact pauses extraction and invalidates prior revisions in the same commit', async () => {
  const { root, service } = await setup();
  const sourceKey = 'a'.repeat(64);
  const { file } = await seedState(root, [
    recordAt(1, '模型事实', { origin: 'model' }),
    recordAt(2, '用户事实')
  ], {
    settings: activeSettings,
    extraction: {
      throughSeq: 4,
      activationVersion: 1,
      activatedAfterSeq: 2,
      lastCompletedSourceKey: sourceKey,
      lastSuccessAt: 1_700_000_000_000,
      recentResults: [{ sourceKey: 'b'.repeat(64), throughSeq: 4, at: 1_700_000_000_000 }]
    }
  });
  const before = JSON.parse(await fs.readFile(file, 'utf8'));
  const deleted = await service.deleteRecord(privateConv, 'r-seed-1', {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    recordRevision: 'rr-1'
  });

  expect(deleted).toMatchObject({
    recordCount: 1,
    deleted: 'r-seed-1',
    generation: 6,
    extraction: {
      effectiveStatus: 'paused',
      autoExtract: false,
      throughSeq: 4,
      pausedReason: 'deleted',
      recentResultCount: 1,
      lastCompletedSourceKey: sourceKey
    }
  });
  expect(deleted.extraction.activationVersion).toBeUndefined();
  expect(deleted.extraction.activatedAfterSeq).toBeUndefined();
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(persisted.settings.autoExtract).toBe(false);
  expect(persisted.extraction).toMatchObject({ throughSeq: 4, pausedReason: 'deleted', lastCompletedSourceKey: sourceKey });
  expect(persisted.extraction.activationVersion).toBeUndefined();
  expect(before.records).toHaveLength(2);

  await expect(service.saveSettings(privateConv, {
    settings: activeSettings,
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1'
  })).rejects.toMatchObject({ code: 'memory_conflict' });
  expect(deleted.generation).toBeGreaterThan(before.generation);
  expect(deleted.revision).not.toBe(before.revision);
});

it('A05: clear, disable and model-fact correction pause extraction while user edits keep it active', async () => {
  const { root, service } = await setup();
  await seedState(root, [recordAt(1, '模型事实', { origin: 'model' }), recordAt(2, '用户事实')], {
    settings: activeSettings,
    extraction: { throughSeq: 3, activationVersion: 1, activatedAfterSeq: 3, lastSuccessAt: 1_700_000_000_000 }
  });

  const cleared = await service.clear(privateConv, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1'
  });
  expect(cleared).toMatchObject({
    recordCount: 0,
    settings: { enabled: true, autoExtract: false },
    extraction: { effectiveStatus: 'paused', pausedReason: 'cleared', throughSeq: 3 }
  });

  await expect(service.saveSettings(privateConv, {
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: false, autoExtract: true },
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: cleared.revision
  })).resolves.toMatchObject({
    settings: { enabled: false, autoExtract: false },
    extraction: { effectiveStatus: 'disabled', pausedReason: 'memory-disabled' }
  });

  const { service: fresh, root: freshRoot } = await setup();
  await seedState(freshRoot, [recordAt(1, '模型事实', { origin: 'model' })], {
    settings: activeSettings,
    extraction: { throughSeq: 3, activationVersion: 1, activatedAfterSeq: 3 }
  });
  const corrected = await fresh.updateRecord(privateConv, 'r-seed-1', {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    recordRevision: 'rr-1',
    content: '用户修正'
  });
  expect(corrected.record).toMatchObject({ content: '用户修正', origin: 'user' });
  expect(corrected).toMatchObject({
    settings: { enabled: true, autoExtract: false },
    extraction: { effectiveStatus: 'paused', autoExtract: false, pausedReason: 'user', throughSeq: 3 }
  });
  expect(corrected.extraction.activationVersion).toBeUndefined();

  const { service: userOnly, root: userRoot } = await setup();
  await seedState(userRoot, [recordAt(2, '用户事实')], {
    settings: activeSettings,
    extraction: { throughSeq: 3, activationVersion: 1, activatedAfterSeq: 3 }
  });
  const edited = await userOnly.updateRecord(privateConv, 'r-seed-2', {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    recordRevision: 'rr-2',
    keys: ['新关键词']
  });
  expect(edited).toMatchObject({ extraction: { effectiveStatus: 'active', autoExtract: true } });
  expect(edited.extraction.activationVersion).toBe(1);
});

it('A05b: a failed atomic write leaves delete, clear and settings side effects unapplied', async () => {
  const { root, service } = await setup();
  await seedState(root, [recordAt(1), recordAt(2)], {
    settings: activeSettings,
    extraction: { throughSeq: 3, activationVersion: 1, activatedAfterSeq: 3 }
  });
  const original = await fs.readFile(stateFile(root), 'utf8');
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('state.json')) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    return rename(from, to);
  });

  await expect(service.deleteRecord(privateConv, 'r-seed-1', {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    recordRevision: 'rr-1'
  })).rejects.toMatchObject({ code: 'memory_io_error' });
  await expect(service.clear(privateConv, {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1'
  })).rejects.toMatchObject({ code: 'memory_io_error' });
  await expect(service.saveSettings(privateConv, {
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: false },
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1'
  })).rejects.toMatchObject({ code: 'memory_io_error' });
  vi.restoreAllMocks();

  expect(await fs.readFile(stateFile(root), 'utf8')).toBe(original);
  const status = await service.extractionStatus(privateConv);
  expect(status).toMatchObject({
    revision: 'seed-r1',
    generation: 5,
    extraction: { effectiveStatus: 'active', throughSeq: 3 }
  });
  expect(status.extraction.pausedReason).toBeUndefined();
});

it('A06: re-activation after delete starts at a new boundary, never moves the watermark back and rotates identity', async () => {
  const { root, service, messages } = await setup();
  await seedState(root, [recordAt(1, '模型事实', { origin: 'model' }), recordAt(2, '用户事实')], {
    settings: activeSettings,
    extraction: {
      throughSeq: 4,
      activationVersion: 1,
      activatedAfterSeq: 2,
      lastCompletedSourceKey: 'c'.repeat(64),
      lastSuccessAt: 1_700_000_000_000,
      lastAttemptAt: 1_700_000_000_001
    }
  });
  const resaved = await service.saveSettings(privateConv, {
    settings: activeSettings,
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1'
  });
  expect(resaved.extraction.effectiveStatus).toBe('active');

  messages.seq = 9;
  const reactivated = await activate(service);
  expect(reactivated.extraction).toMatchObject({
    effectiveStatus: 'active',
    throughSeq: 9,
    activatedAfterSeq: 9,
    lastSuccessAt: 1_700_000_000_000,
    lastAttemptAt: 1_700_000_000_001,
    lastCompletedSourceKey: 'c'.repeat(64)
  });
  expect(reactivated.generation).toBe(resaved.generation + 1);

  messages.seq = 3;
  const noBacktrack = await activate(service);
  expect(noBacktrack.extraction).toMatchObject({ throughSeq: 9, activatedAfterSeq: 9 });
  expect(messages.calls).toBe(2);
});

it('A07: deleted content can be recreated and extraction metadata stores no fact text', async () => {
  const { root, service } = await setup();
  await seedState(root, [recordAt(1, '银杏'), recordAt(2, '模型记忆', { origin: 'model' })], {
    settings: activeSettings,
    extraction: {
      throughSeq: 4,
      activationVersion: 1,
      activatedAfterSeq: 4,
      recentResults: [{ sourceKey: 'd'.repeat(64), throughSeq: 4, at: 1_700_000_000_000 }]
    }
  });
  const file = stateFile(root);
  const raw = await fs.readFile(file, 'utf8');
  expect(JSON.stringify(JSON.parse(raw).extraction)).not.toContain('模型记忆');
  expect(JSON.stringify(JSON.parse(raw).extraction)).not.toContain('银杏');
  const deleted = await service.deleteRecord(privateConv, 'r-seed-2', {
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: 'seed-r1',
    recordRevision: 'rr-2'
  });
  const recreated = await service.createRecord(privateConv, {
    requestId: 'recreate-same-content',
    expectedScope: deleted.scopeToken,
    expectedRevision: deleted.revision,
    record: { content: '模型记忆', keys: [] }
  });
  expect(recreated.record).toMatchObject({ content: '模型记忆', origin: 'user' });
  expect(recreated.extraction.effectiveStatus).toBe('paused');
  expect(recreated.extraction.pausedReason).toBe('deleted');
});

it('A08: legacy state files stay readable and JsonlStore.lastSeq is stable across restarts and epoch filters', async () => {
  const { root } = await setup();
  const replayRecord = { type: 'fact' as const, content: '任意重放内容', keys: [], pinned: false };
  const receipt = {
    requestId: 'legacy-request',
    payload: memoryPayloadDigest(replayRecord),
    recordId: 'r-seed-1',
    at: 1_700_000_000_000
  };
  await seedState(root, [recordAt(1)], {
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true, autoExtract: true },
    receipts: [receipt]
  });
  const restarted = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => epochFor({ ...conversation, accountId }) },
    accountDir: accountId => path.join(root, 'accounts', accountId),
    messages: { lastSeq: async () => 0 }
  });
  expect(await restarted.extractionStatus(privateConv)).toMatchObject({
    revision: 'seed-r1',
    generation: 5,
    extraction: { effectiveStatus: 'needs-confirmation', throughSeq: 0 }
  });
  const replay = await restarted.createRecord(privateConv, {
    requestId: 'legacy-request',
    expectedScope: memoryNamespace(scopeFor()),
    expectedRevision: MEMORY_DEFAULT_REVISION,
    record: { content: '任意重放内容', keys: [] }
  });
  expect(replay).toMatchObject({ created: false, recordCount: 1 });
  expect(replay.record.id).toBe('r-seed-1');

  const storeRoot = path.join(root, 'accounts', '10001', 'messages');
  const store = new JsonlStore({ root: storeRoot, accountId: '10001' });
  const append = (messageId: string, contextEpoch?: string) => store.append(privateConv, {
    id: messageId,
    at: 1_700_000_000_000,
    direction: 'in',
    segments: [{ type: 'text', data: { text: messageId } }],
    ...(contextEpoch ? { contextEpoch } : {})
  });
  expect(await store.lastSeq(privateConv)).toBe(0);
  await append('m1', 'epoch-a');
  await append('m2', 'epoch-b');
  await append('m3', 'epoch-a');
  expect(await store.lastSeq(privateConv)).toBe(3);
  expect(await store.read(privateConv, { limit: 1, contextEpoch: 'epoch-missing' })).toEqual([]);
  expect(await store.lastSeq(privateConv)).toBe(3);
  await store.dispose();

  const reread = new JsonlStore({ root: storeRoot, accountId: '10001' });
  expect(await reread.lastSeq(privateConv)).toBe(3);
  const fourth = await reread.append(privateConv, {
    id: 'm4',
    at: 1_700_000_000_001,
    direction: 'out',
    segments: [{ type: 'text', data: { text: 'm4' } }]
  });
  expect(fourth.seq).toBe(4);
  expect(await reread.lastSeq(privateConv)).toBe(4);
  await reread.dispose();

  const empty = new JsonlStore({ root: storeRoot, accountId: '10001' });
  expect(await empty.lastSeq({ ...privateConv, peerId: 'absent' })).toBe(0);
  await empty.dispose();
});
