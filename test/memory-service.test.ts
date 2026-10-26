import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryService } from '../src/application/memory/memory-service.js';
import { MemoryStore } from '../src/memory/store.js';
import { AccompanyError } from '../src/core/errors.js';
import { statusForError } from '../src/service/http/errors.js';
import { defaultMemoryState, memoryNamespace } from '../src/memory/schema.js';
import { DEFAULT_MEMORY_SETTINGS, MEMORY_LIMITS, MEMORY_DEFAULT_REVISION, type MemoryRecord, type MemoryScope, type MemoryState } from '../src/memory/types.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-memory-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const privateConv: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };

function epochFor(conversation: ConversationRef = privateConv, epoch = 'epoch-a'): string {
  return `${conversation.accountId}:${conversation.kind}:${conversation.peerId}:${epoch}`;
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-memory-'));
  roots.push(root);
  let epoch = 'epoch-a';
  let now = 1_700_000_000_000;
  const service = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => conversation.peerId === '999' ? undefined
      : epochFor({ ...conversation, accountId }, epoch) },
    accountDir: accountId => path.join(root, 'accounts', accountId),
    now: () => now
  });
  return { root, service, setEpoch: (value: string) => { epoch = value; }, tick: (ms = 1) => { now += ms; } };
}

function scopeFor(conversation: ConversationRef = privateConv, epoch = 'epoch-a'): MemoryScope {
  return { ...conversation, contextEpoch: epochFor(conversation, epoch) };
}

async function createRecord(service: MemoryService, conversation: ConversationRef = privateConv, content = '喜欢银杏', extra: Record<string, unknown> = {}, requestId = `req-${Math.random().toString(36).slice(2)}`) {
  const view = await service.settings(conversation);
  return service.createRecord(conversation, {
    requestId,
    expectedScope: view.scopeToken,
    expectedRevision: view.revision,
    record: { content, keys: ['银杏'], ...extra }
  });
}

async function seedState(root: string, records: MemoryRecord[], overrides: Partial<MemoryState> = {}, conversation: ConversationRef = privateConv, epoch = 'epoch-a') {
  const scope = scopeFor(conversation, epoch);
  const namespace = memoryNamespace(scope);
  const state: MemoryState = {
    ...defaultMemoryState(scope),
    revision: 'seed-r1',
    generation: 5,
    records,
    ...overrides
  };
  const file = path.join(root, 'accounts', conversation.accountId, 'memory', namespace, 'state.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state));
  return { scope, namespace, state, file };
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
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    ...overrides
  };
}

it('returns closed defaults without creating a file and persists settings and records across instances', async () => {
  const { root, service } = await setup();
  const view = await service.settings(privateConv);
  expect(view).toMatchObject({ scopeToken: memoryNamespace(scopeFor()), revision: MEMORY_DEFAULT_REVISION, generation: 0,
    recordCount: 0, settings: DEFAULT_MEMORY_SETTINGS });
  await expect(fs.stat(path.join(root, 'accounts/10001/memory'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await service.listRecords(privateConv)).toMatchObject({ total: 0, items: [] });

  const saved = await service.saveSettings(privateConv, {
    settings: { enabled: true, autoExtract: true, budgetChars: 3200, maxSelected: 6 },
    expectedScope: view.scopeToken,
    expectedRevision: view.revision
  });
  expect(saved).toMatchObject({ generation: 1, settings: { enabled: true, autoExtract: true, budgetChars: 3200, maxSelected: 6 } });
  const created = await createRecord(service, privateConv, '喜欢银杏', { pinned: true }, 'req-persist');
  expect(created.record).toMatchObject({ type: 'fact', origin: 'user', content: '喜欢银杏', keys: ['银杏'], pinned: true });
  expect(created.record.id).toMatch(/^r-[0-9a-f-]{36}$/);
  expect(created.record.createdAt).toBe(1_700_000_000_000);
  expect(created.generation).toBe(2);

  const restarted = new MemoryService({
    roles: { contextEpoch: async () => epochFor() },
    accountDir: accountId => path.join(root, 'accounts', accountId)
  });
  const after = await restarted.settings(privateConv);
  expect(after).toMatchObject({ generation: 2, recordCount: 1, settings: { enabled: true, autoExtract: true } });
  expect((await restarted.getRecord(privateConv, created.record.id)).record.content).toBe('喜欢银杏');
});

it('isolates accounts, chat kinds and role epochs and rejects old scope tokens', async () => {
  const { service, setEpoch } = await setup();
  const groupConv = { ...privateConv, kind: 'group' as const };
  const otherAccount = { ...privateConv, accountId: '10002' };
  const first = await createRecord(service, privateConv, '私聊记忆', {}, 'req-1');
  const group = await createRecord(service, groupConv, '群聊记忆', {}, 'req-2');
  const other = await createRecord(service, otherAccount, '另一账号', {}, 'req-3');
  expect((await service.listRecords(privateConv)).items.map(item => item.id)).toEqual([first.record.id]);
  expect((await service.listRecords(groupConv)).items.map(item => item.id)).toEqual([group.record.id]);
  expect((await service.listRecords(otherAccount)).items.map(item => item.id)).toEqual([other.record.id]);
  expect(new Set([first.scopeToken, group.scopeToken, other.scopeToken]).size).toBe(3);

  const beforeSwitch = await service.settings(privateConv);
  setEpoch('epoch-b');
  expect((await service.settings(privateConv)).revision).toBe(MEMORY_DEFAULT_REVISION);
  expect((await service.listRecords(privateConv)).total).toBe(0);
  await expect(service.saveSettings(privateConv, {
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true },
    expectedScope: beforeSwitch.scopeToken,
    expectedRevision: beforeSwitch.revision
  })).rejects.toMatchObject({ code: 'memory_conflict' });
  expect((await service.listRecords(privateConv)).total).toBe(0);

  setEpoch('epoch-a');
  expect((await service.listRecords(privateConv)).items[0]?.id).toBe(first.record.id);
  await expect(service.settings({ ...privateConv, peerId: '999' })).rejects.toMatchObject({ code: 'memory_scope_missing' });
});

it('serializes same-scope compare-and-set while independent scopes proceed', async () => {
  const { service } = await setup();
  const created = await createRecord(service, privateConv);
  const groupConv = { ...privateConv, kind: 'group' as const };
  const group = await createRecord(service, groupConv);
  const settings = (budgetChars: number) => ({ enabled: true, autoExtract: false, budgetChars, maxSelected: 8 });
  const [left, right] = await Promise.allSettled([
    service.saveSettings(privateConv, { settings: settings(2100), expectedScope: created.scopeToken, expectedRevision: created.revision }),
    service.saveSettings(privateConv, { settings: settings(2200), expectedScope: created.scopeToken, expectedRevision: created.revision })
  ]);
  expect([left.status, right.status].sort()).toEqual(['fulfilled', 'rejected']);
  const rejected = [left, right].find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: 'memory_conflict' });
  const after = await service.settings(privateConv);
  expect(after.generation).toBe(created.generation + 1);

  const [groupSave, privateSave] = await Promise.all([
    service.saveSettings(groupConv, { settings: settings(2400), expectedScope: group.scopeToken, expectedRevision: group.revision }),
    service.saveSettings(privateConv, { settings: settings(2500), expectedScope: after.scopeToken, expectedRevision: after.revision })
  ]);
  expect(groupSave.settings.budgetChars).toBe(2400);
  expect(privateSave.settings.budgetChars).toBe(2500);

  const [firstCreate, secondCreate] = await Promise.allSettled([
    service.createRecord(privateConv, { requestId: 'parallel-a', expectedScope: privateSave.scopeToken, expectedRevision: privateSave.revision,
      record: { content: '并发A', keys: [] } }),
    service.createRecord(privateConv, { requestId: 'parallel-b', expectedScope: privateSave.scopeToken, expectedRevision: privateSave.revision,
      record: { content: '并发B', keys: [] } })
  ]);
  expect([firstCreate.status, secondCreate.status].sort()).toEqual(['fulfilled', 'rejected']);
  const latest = await service.settings(privateConv);
  const retry = await service.createRecord(privateConv, { requestId: 'parallel-retry', expectedScope: latest.scopeToken,
    expectedRevision: latest.revision, record: { content: firstCreate.status === 'fulfilled' ? '并发B' : '并发A', keys: [] } });
  expect(retry.recordCount).toBe(3);
});

it('does not report success or advance state when the atomic rename fails, and recovers with the same request', async () => {
  const { service, tick } = await setup();
  const before = await service.settings(privateConv);
  const target = path.join('accounts', '10001', 'memory', memoryNamespace(scopeFor()), 'state.json');
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith(target)) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await expect(service.createRecord(privateConv, { requestId: 'req-fail', expectedScope: before.scopeToken,
    expectedRevision: before.revision, record: { content: '不应落盘', keys: [] } })).rejects.toMatchObject({ code: 'memory_io_error' });
  vi.restoreAllMocks();
  expect(await service.settings(privateConv)).toMatchObject({ revision: before.revision, generation: 0, recordCount: 0 });
  tick();
  const recovered = await service.createRecord(privateConv, { requestId: 'req-fail', expectedScope: before.scopeToken,
    expectedRevision: before.revision, record: { content: '不应落盘', keys: [] } });
  expect(recovered.record.content).toBe('不应落盘');

  const writeFile = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
    if (String(file).includes('state.json.')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return writeFile(file, data, options);
  });
  await expect(service.deleteRecord(privateConv, recovered.record.id, { expectedScope: recovered.scopeToken,
    expectedRevision: recovered.revision, recordRevision: recovered.record.revision })).rejects.toMatchObject({ code: 'memory_io_error' });
  vi.restoreAllMocks();
  expect((await service.listRecords(privateConv)).items.map(item => item.id)).toEqual([recovered.record.id]);
});

it('refuses corrupt, scope-mismatched or oversized state files instead of treating them as empty', async () => {
  const { root, service } = await setup();
  const created = await createRecord(service, privateConv);
  const scope = scopeFor();
  const file = path.join(root, 'accounts/10001/memory', memoryNamespace(scope), 'state.json');
  const original = await fs.readFile(file, 'utf8');

  await fs.writeFile(file, 'not json');
  await expect(service.settings(privateConv)).rejects.toMatchObject({ code: 'memory_io_error', message: expect.not.stringContaining(root) });
  expect(await fs.readFile(file, 'utf8')).toBe('not json');

  const foreign = await seedState(root, [], {}, { ...privateConv, accountId: '10002' }, 'epoch-a');
  await fs.writeFile(file, await fs.readFile(foreign.file));
  await expect(service.settings(privateConv)).rejects.toMatchObject({ code: 'memory_io_error' });

  await fs.writeFile(file, original);
  const handle = await fs.open(file, 'r+');
  await handle.truncate(MEMORY_LIMITS.maxStateFileBytes + 1);
  await handle.close();
  await expect(service.settings(privateConv)).rejects.toMatchObject({ code: 'memory_io_error' });
  expect(created.recordCount).toBe(1);
});

it('recovers a lost create response from the committed receipt and keeps unknown requests strict', async () => {
  const { service } = await setup();
  const before = await service.settings(privateConv);
  const request = { requestId: 'stable-request', expectedScope: before.scopeToken, expectedRevision: before.revision,
    record: { content: '稳定内容', keys: ['银杏'] } };
  const first = await service.createRecord(privateConv, request);
  const retried = await service.createRecord(privateConv, request);
  expect(retried).toMatchObject({ created: false, revision: first.revision, generation: first.generation });
  expect(retried.record.id).toBe(first.record.id);

  const settings = await service.saveSettings(privateConv, { settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true },
    expectedScope: before.scopeToken, expectedRevision: first.revision });
  const afterWrite = await service.createRecord(privateConv, request);
  expect(afterWrite).toMatchObject({ created: false, revision: settings.revision, generation: settings.generation });
  expect(afterWrite.record.id).toBe(first.record.id);

  await expect(service.createRecord(privateConv, { ...request, record: { content: '不同内容', keys: ['银杏'] } }))
    .rejects.toMatchObject({ code: 'memory_conflict' });

  await service.deleteRecord(privateConv, first.record.id, { expectedScope: before.scopeToken, expectedRevision: settings.revision,
    recordRevision: first.record.revision });
  await expect(service.createRecord(privateConv, request)).rejects.toMatchObject({ code: 'memory_conflict' });
  const fresh = await service.settings(privateConv);
  await expect(service.createRecord(privateConv, { ...request, expectedRevision: fresh.revision }))
    .rejects.toMatchObject({ code: 'memory_conflict' });
  expect((await service.listRecords(privateConv)).total).toBe(0);
});

it('treats concurrent identical creates as one commit even with the original revision', async () => {
  const { service } = await setup();
  const before = await service.settings(privateConv);
  const request = { requestId: 'concurrent-same', expectedScope: before.scopeToken, expectedRevision: before.revision,
    record: { content: '并发同请求', keys: [] } };
  const results = await Promise.all([service.createRecord(privateConv, request), service.createRecord(privateConv, request)]);
  expect(results.map(item => item.created).sort()).toEqual([false, true]);
  expect(results[0]!.record.id).toBe(results[1]!.record.id);
  expect((await service.settings(privateConv)).recordCount).toBe(1);
});

it('keeps request receipts bounded and documents expired retries', async () => {
  const { root, service } = await setup();
  let view = await service.settings(privateConv);
  for (let index = 0; index <= MEMORY_LIMITS.receiptLimit; index++) {
    view = await service.createRecord(privateConv, { requestId: `receipt-${index}`, expectedScope: view.scopeToken,
      expectedRevision: view.revision, record: { content: `回执${index}`, keys: [] } });
  }
  const file = path.join(root, 'accounts/10001/memory', memoryNamespace(scopeFor()), 'state.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(state.receipts).toHaveLength(MEMORY_LIMITS.receiptLimit);
  expect(state.receipts.some((receipt: { requestId: string }) => receipt.requestId === 'receipt-0')).toBe(false);
  const replay = await service.createRecord(privateConv, { requestId: 'receipt-0', expectedScope: view.scopeToken,
    expectedRevision: view.revision, record: { content: '回执0', keys: [] } });
  expect(replay.created).toBe(true);
  expect((await service.listRecords(privateConv)).total).toBe(MEMORY_LIMITS.receiptLimit + 2);
});

it('enforces record, content, key and total limits', async () => {
  const { root, service } = await setup();
  await expect(createRecord(service, privateConv, 'x'.repeat(MEMORY_LIMITS.maxContentChars + 1))).rejects.toMatchObject({ code: 'invalid_spec' });
  const boundary = await createRecord(service, privateConv, 'x'.repeat(MEMORY_LIMITS.maxContentChars));
  expect(boundary.record.content).toHaveLength(MEMORY_LIMITS.maxContentChars);
  const keys = Array.from({ length: MEMORY_LIMITS.maxKeys }, (_, index) => `词${index}`);
  const keyed = await service.updateRecord(privateConv, boundary.record.id, { expectedScope: boundary.scopeToken,
    expectedRevision: boundary.revision, recordRevision: boundary.record.revision, keys });
  expect(keyed.record.keys).toHaveLength(MEMORY_LIMITS.maxKeys);
  await expect(service.updateRecord(privateConv, keyed.record.id, { expectedScope: keyed.scopeToken, expectedRevision: keyed.revision,
    recordRevision: keyed.record.revision, keys: [...keys, '多余'] })).rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.updateRecord(privateConv, keyed.record.id, { expectedScope: keyed.scopeToken, expectedRevision: keyed.revision,
    recordRevision: keyed.record.revision, keys: ['k'.repeat(MEMORY_LIMITS.maxKeyChars + 1)] })).rejects.toMatchObject({ code: 'invalid_spec' });

  const full = await seedState(root, Array.from({ length: MEMORY_LIMITS.maxRecords }, (_, index) => recordAt(index)));
  const fullView = await service.settings(privateConv);
  expect(fullView.recordCount).toBe(MEMORY_LIMITS.maxRecords);
  await expect(service.createRecord(privateConv, { requestId: 'over-limit', expectedScope: fullView.scopeToken,
    expectedRevision: full.state.revision, record: { content: '第1001条', keys: [] } })).rejects.toMatchObject({ code: 'invalid_spec' });

  const hugeContent = 'x'.repeat(MEMORY_LIMITS.maxContentChars);
  const contentRecords = Array.from({ length: Math.floor(MEMORY_LIMITS.maxTotalContentChars / hugeContent.length) },
    (_, index) => recordAt(index, hugeContent));
  const contentState = await seedState(root, contentRecords);
  const contentView = await service.settings(privateConv);
  await expect(service.createRecord(privateConv, { requestId: 'total-over', expectedScope: contentView.scopeToken,
    expectedRevision: contentState.state.revision, record: { content: hugeContent, keys: [] } })).rejects.toMatchObject({ code: 'invalid_spec' });
  const remainder = MEMORY_LIMITS.maxTotalContentChars - contentView.recordCount * hugeContent.length;
  const exact = await service.createRecord(privateConv, { requestId: 'total-exact', expectedScope: contentView.scopeToken,
    expectedRevision: contentState.state.revision, record: { content: 'y'.repeat(remainder), keys: [] } });
  expect(exact.recordCount).toBe(contentView.recordCount + 1);
});

it('rejects a write whose exact serialized bytes exceed the store limit and keeps the old state readable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-memory-'));
  roots.push(root);
  const service = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => epochFor({ ...conversation, accountId }) },
    accountDir: accountId => path.join(root, 'accounts', accountId),
    store: new MemoryStore({ maxStateFileBytes: 1800 })
  });
  const first = await createRecord(service, privateConv, '短记忆', {}, 'byte-small');
  const file = path.join(root, 'accounts/10001/memory', memoryNamespace(scopeFor()), 'state.json');
  const before = await fs.readFile(file, 'utf8');
  expect(Buffer.byteLength(before, 'utf8')).toBeLessThanOrEqual(1800);
  const oversized = '中😀"\\'.repeat(120);
  expect(oversized.length).toBeLessThanOrEqual(MEMORY_LIMITS.maxContentChars);
  await expect(service.createRecord(privateConv, { requestId: 'byte-over', expectedScope: first.scopeToken,
    expectedRevision: first.revision, record: { content: oversized, keys: ['关键词'] } }))
    .rejects.toMatchObject({ code: 'memory_capacity' });
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect((await service.settings(privateConv)).recordCount).toBe(1);
  const updated = await service.updateRecord(privateConv, first.record.id, { expectedScope: first.scopeToken,
    expectedRevision: first.revision, recordRevision: first.record.revision, content: '文件仍可编辑' });
  expect(updated.record.content).toBe('文件仍可编辑');
});

it('clear keeps settings and the state file, disables extraction and conflicts with waiting writes', async () => {
  const { root, service } = await setup();
  const initial = await service.saveSettings(privateConv, { settings: { enabled: true, autoExtract: true, budgetChars: 2000, maxSelected: 8 },
    expectedScope: (await service.settings(privateConv)).scopeToken, expectedRevision: MEMORY_DEFAULT_REVISION });
  const created = await createRecord(service, privateConv);
  const file = path.join(root, 'accounts/10001/memory', memoryNamespace(scopeFor()), 'state.json');
  const [cleared, write] = await Promise.allSettled([
    service.clear(privateConv, { expectedScope: created.scopeToken, expectedRevision: created.revision }),
    service.createRecord(privateConv, { requestId: 'waiting-write', expectedScope: created.scopeToken,
      expectedRevision: created.revision, record: { content: '等待中的写', keys: [] } })
  ]);
  expect([cleared.status, write.status].sort()).toEqual(['fulfilled', 'rejected']);
  const after = await service.settings(privateConv);
  expect(after.recordCount).toBe(cleared.status === 'fulfilled' ? 0 : 1);
  expect(after.generation).toBe(initial.generation + 2);
  expect(await fs.stat(file)).toBeDefined();
  if (cleared.status === 'fulfilled') {
    expect(cleared.value).toMatchObject({ settings: { enabled: true, autoExtract: false }, recordCount: 0 });
    expect((await service.listRecords(privateConv)).total).toBe(0);
  }

  const latest = await service.settings(privateConv);
  const disabled = await service.saveSettings(privateConv, { settings: { ...latest.settings, enabled: false },
    expectedScope: latest.scopeToken, expectedRevision: latest.revision });
  expect(disabled.settings.enabled).toBe(false);
  expect(disabled.recordCount).toBe(after.recordCount);
  await createRecord(service, privateConv, '关闭后仍可手工维护');
});

it('maps capacity limits to 413 while real I/O failures stay 503', () => {
  expect(statusForError(new AccompanyError('memory_capacity', 'over'))).toBe(413);
  expect(statusForError(new AccompanyError('memory_io_error', 'failed'))).toBe(503);
  expect(statusForError(new AccompanyError('memory_extraction_disabled', 'off'))).toBe(409);
  expect(statusForError(new AccompanyError('memory_extraction_unavailable', 'missing store'))).toBe(409);
});

it('refuses every management write when the role changes before commit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-memory-'));
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
    accountDir: accountId => path.join(root, 'accounts', accountId)
  });
  const arm = (): void => { epoch = 'epoch-a'; calls = 0; armed = true; };
  const disarm = (): void => { epoch = 'epoch-a'; calls = 0; armed = false; };
  const created = await createRecord(service, privateConv, '基础记忆');
  const file = path.join(root, 'accounts/10001/memory', memoryNamespace(scopeFor()), 'state.json');
  const before = await fs.readFile(file, 'utf8');
  const settings = { ...DEFAULT_MEMORY_SETTINGS, budgetChars: 2600 };
  const operations: Array<[string, () => Promise<unknown>, () => Promise<void>]> = [
    ['settings', () => service.saveSettings(privateConv, { settings, expectedScope: created.scopeToken,
      expectedRevision: created.revision }),
    async () => { expect((await service.settings(privateConv)).settings.budgetChars).toBe(DEFAULT_MEMORY_SETTINGS.budgetChars); }],
    ['create', () => service.createRecord(privateConv, { requestId: 'role-race-create', expectedScope: created.scopeToken,
      expectedRevision: created.revision, record: { content: '不应写入', keys: [] } }),
    async () => { expect((await service.listRecords(privateConv)).total).toBe(1); }],
    ['update', () => service.updateRecord(privateConv, created.record.id, { expectedScope: created.scopeToken,
      expectedRevision: created.revision, recordRevision: created.record.revision, content: '不应修改' }),
    async () => { expect((await service.getRecord(privateConv, created.record.id)).record.content).toBe('基础记忆'); }],
    ['delete', () => service.deleteRecord(privateConv, created.record.id, { expectedScope: created.scopeToken,
      expectedRevision: created.revision, recordRevision: created.record.revision }),
    async () => { expect((await service.listRecords(privateConv)).total).toBe(1); }],
    ['clear', () => service.clear(privateConv, { expectedScope: created.scopeToken, expectedRevision: created.revision }),
    async () => { expect((await service.listRecords(privateConv)).total).toBe(1); }]
  ];
  for (const [label, operation, verify] of operations) {
    arm();
    await expect(operation(), label).rejects.toMatchObject({ code: 'memory_conflict' });
    disarm();
    await verify();
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  }
  const newScopeFile = path.join(root, 'accounts/10001/memory', memoryNamespace(scopeFor(privateConv, 'epoch-b')), 'state.json');
  await expect(fs.stat(newScopeFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects forged identity, model summaries, timestamps and unknown fields', async () => {
  const { service } = await setup();
  const view = await service.settings(privateConv);
  const base = { requestId: 'forged', expectedScope: view.scopeToken, expectedRevision: view.revision };
  await expect(service.createRecord(privateConv, { ...base, record: { type: 'summary', content: '摘要', keys: [] } }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.createRecord(privateConv, { ...base, record: { content: '正文', keys: [], origin: 'model' } }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.createRecord(privateConv, { ...base, record: { content: '正文', keys: [], id: 'r-forged' } }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.createRecord(privateConv, { ...base, record: { content: '正文', keys: [], createdAt: 1 } }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.createRecord(privateConv, { ...base, record: { content: '正文', keys: [] }, createdAt: 1 }))
    .rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.getRecord(privateConv, '../escape')).rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.listRecords(privateConv, { limit: 101 })).rejects.toMatchObject({ code: 'invalid_spec' });
  await expect(service.settings({ ...privateConv, accountId: '../10001' })).rejects.toMatchObject({ code: 'invalid_spec' });
});

it('returns bounded summaries, pages and explicit not-found errors', async () => {
  const { service } = await setup();
  const first = await createRecord(service, privateConv, '第一条记忆');
  const second = await service.createRecord(privateConv, { requestId: 'second', expectedScope: first.scopeToken,
    expectedRevision: first.revision, record: { content: '第二条记忆', keys: [] } });
  const page = await service.listRecords(privateConv, { limit: 1 });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).not.toHaveProperty('content');
  expect(page.items[0]?.contentLength).toBeGreaterThan(0);
  expect(page.nextOffset).toBe(1);
  const rest = await service.listRecords(privateConv, { offset: page.nextOffset, limit: 1 });
  expect(rest.items).toHaveLength(1);
  expect(rest.nextOffset).toBeUndefined();
  await expect(service.getRecord(privateConv, 'r-missing')).rejects.toMatchObject({ code: 'memory_record_not_found' });
  await expect(service.deleteRecord(privateConv, second.record.id, { expectedScope: second.scopeToken,
    expectedRevision: second.revision, recordRevision: 'stale' })).rejects.toMatchObject({ code: 'memory_conflict' });
});
