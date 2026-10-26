import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryService } from '../src/application/memory/memory-service.js';
import { ConversationMemoryContextService } from '../src/application/memory/conversation-memory-context.js';
import { defaultMemoryState, memoryNamespace } from '../src/memory/schema.js';
import { DEFAULT_MEMORY_SETTINGS, MEMORY_DEFAULT_REVISION, type MemoryRecord, type MemoryScope, type MemoryState } from '../src/memory/types.js';
import type { ResolvedConversationRoleBinding } from '../src/profiles/role-bindings.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-memory-snapshot-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const conversation: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };

function record(index: number, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `r-${index}`,
    revision: `rr-${index}`,
    type: 'fact',
    content: `记忆${index}`,
    keys: [`键${index}`],
    pinned: false,
    origin: 'user',
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    ...overrides
  };
}

async function setup(records: MemoryRecord[] = [record(1)], settings = { enabled: true, autoExtract: false, budgetChars: 500, maxSelected: 5 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-memory-snapshot-'));
  roots.push(root);
  const scope: MemoryScope = { ...conversation, contextEpoch: 'epoch-a' };
  const state: MemoryState = {
    ...defaultMemoryState(scope),
    revision: 'state-r2',
    generation: 4,
    settings,
    records
  };
  const file = path.join(root, 'accounts/10001/memory', memoryNamespace(scope), 'state.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state));
  const rolesThatMustNotRun = new MemoryService({
    roles: { contextEpoch: async () => { throw new Error('runtimeSnapshot must not re-resolve roles'); } },
    accountDir: accountId => path.join(root, 'accounts', accountId)
  });
  const service = new MemoryService({
    roles: { contextEpoch: async () => scope.contextEpoch },
    accountDir: accountId => path.join(root, 'accounts', accountId)
  });
  return { root, file, state, service, rolesThatMustNotRun };
}

it('captures a missing scope as a deterministic disabled snapshot without creating a file', async () => {
  const { root, rolesThatMustNotRun } = await setup();
  const first = await rolesThatMustNotRun.runtimeSnapshot('10001', conversation, 'epoch-missing');
  const second = await rolesThatMustNotRun.runtimeSnapshot('10001', conversation, 'epoch-missing');
  expect(first).toMatchObject({
    revision: MEMORY_DEFAULT_REVISION, generation: 0, state: 'ready', settings: DEFAULT_MEMORY_SETTINGS, records: []
  });
  expect(first.guard).toBe(second.guard);
  expect(first.scopeToken).toBe(memoryNamespace({ ...conversation, contextEpoch: 'epoch-missing' }));
  await expect(fs.stat(path.join(root, 'accounts/10001/memory', memoryNamespace({ ...conversation, contextEpoch: 'epoch-missing' }))))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it('returns a deep-cloned frozen snapshot that cannot mutate the store or another turn', async () => {
  const { file, service } = await setup([record(1, { keys: ['银杏'], content: '喜欢银杏' })]);
  const before = await fs.readFile(file, 'utf8');
  const snapshot = await service.runtimeSnapshot('10001', conversation, 'epoch-a');
  expect(snapshot).toMatchObject({ state: 'ready', revision: 'state-r2', generation: 4, settings: { enabled: true, budgetChars: 500 } });
  expect(snapshot.records[0]).toMatchObject({ content: '喜欢银杏', keys: ['银杏'] });

  expect(() => { (snapshot.records[0] as MemoryRecord).content = '被插件改写'; }).toThrow(TypeError);
  expect(() => { (snapshot.records[0] as MemoryRecord).keys.push('新键'); }).toThrow(TypeError);
  expect(() => { (snapshot.settings as { enabled: boolean }).enabled = false; }).toThrow(TypeError);
  expect(await fs.readFile(file, 'utf8')).toBe(before);

  const next = await service.runtimeSnapshot('10001', conversation, 'epoch-a');
  expect(next).not.toBe(snapshot);
  expect(next.records[0]!.content).toBe('喜欢银杏');
  expect(next.guard).toBe(snapshot.guard);
});

it('changes the guard when persisted bytes change under the same revision and generation', async () => {
  const { file, state, service } = await setup();
  const first = await service.runtimeSnapshot('10001', conversation, 'epoch-a');
  expect(await service.runtimeSnapshot('10001', conversation, 'epoch-a')).toMatchObject({ guard: first.guard });

  const rewritten: MemoryState = { ...state, records: [{ ...state.records[0]!, content: '外部改写' }] };
  expect(rewritten.revision).toBe(first.revision);
  expect(rewritten.generation).toBe(first.generation);
  await fs.writeFile(file, JSON.stringify(rewritten));
  const changed = await service.runtimeSnapshot('10001', conversation, 'epoch-a');
  expect(changed.revision).toBe(first.revision);
  expect(changed.generation).toBe(first.generation);
  expect(changed.records[0]!.content).toBe('外部改写');
  expect(changed.guard).not.toBe(first.guard);

  await fs.writeFile(file, JSON.stringify(state));
  expect((await service.runtimeSnapshot('10001', conversation, 'epoch-a')).guard).toBe(first.guard);
});

it('fails closed to an unavailable snapshot without leaking the path or record text', async () => {
  const { file, service } = await setup([record(1, { content: '不应泄漏的正文' })]);
  await fs.writeFile(file, '{broken');
  const snapshot = await service.runtimeSnapshot('10001', conversation, 'epoch-a');
  expect(snapshot.state).toBe('unavailable');
  expect(snapshot.records).toEqual([]);
  expect(snapshot.error).toContain('memory_io_error');
  expect(snapshot.error).not.toContain(file);
  expect(snapshot.error).not.toContain('不应泄漏');
  expect(snapshot.guard).toMatch(/^[a-f0-9]{64}$/);
  expect((await service.runtimeSnapshot('10001', conversation, 'epoch-a')).guard).toBe(snapshot.guard);
});

it('captures role and memory from one epoch without re-resolving or mixing a new role', async () => {
  const { file, service, state } = await setup();
  let resolveCalls = 0;
  const role = (epoch: string): ResolvedConversationRoleBinding => ({
    ...conversation,
    roleCard: { source: 'public', id: 'role', revision: 'r1' },
    revision: 'role-revision',
    updatedAt: 1,
    contextEpoch: epoch,
    card: { ref: { source: 'public', id: 'role', revision: 'r1' }, manifest: { id: 'role', kind: 'role-card', revision: 'r1', content: 'ROLE' } } as ResolvedConversationRoleBinding['card']
  });
  const capture = new ConversationMemoryContextService({
    memories: service,
    roles: { resolve: async () => { resolveCalls += 1; return role('epoch-a'); } }
  });
  const captured = await capture.capture('10001', conversation);
  expect(resolveCalls).toBe(1);
  expect(captured?.roleBinding.contextEpoch).toBe('epoch-a');
  expect(captured?.memory.scopeToken).toBe(memoryNamespace({ ...conversation, contextEpoch: 'epoch-a' }));
  expect(captured?.memory.revision).toBe(state.revision);
  expect(captured?.memory.records[0]!.content).toBe(state.records[0]!.content);
  expect(await fs.readFile(file, 'utf8')).toContain(state.records[0]!.content);
});

it('G06 keeps the guard stable across an idempotent receipt retry and changes it on settings or new records', async () => {
  const { service } = await setup([], { enabled: true, autoExtract: false, budgetChars: 500, maxSelected: 5 });
  const view = await service.settings(conversation);
  const first = await service.createRecord(conversation, {
    requestId: 'g06-retry',
    expectedScope: view.scopeToken,
    expectedRevision: view.revision,
    record: { content: '幂等记忆', keys: ['幂等'], pinned: false }
  });
  const snapshot = await service.runtimeSnapshot('10001', conversation, 'epoch-a');
  expect(snapshot.generation).toBe(first.generation);

  const retried = await service.createRecord(conversation, {
    requestId: 'g06-retry',
    expectedScope: view.scopeToken,
    expectedRevision: view.revision,
    record: { content: '幂等记忆', keys: ['幂等'], pinned: false }
  });
  expect(retried.created).toBe(false);
  expect(retried.record.id).toBe(first.record.id);
  expect(await service.runtimeSnapshot('10001', conversation, 'epoch-a')).toMatchObject({
    guard: snapshot.guard, revision: snapshot.revision, generation: snapshot.generation
  });

  const added = await service.createRecord(conversation, {
    requestId: 'g06-add',
    expectedScope: retried.scopeToken,
    expectedRevision: retried.revision,
    record: { content: '新增记忆', keys: ['新增'], pinned: false }
  });
  const afterAdd = await service.runtimeSnapshot('10001', conversation, 'epoch-a');
  expect(afterAdd.generation).toBe(added.generation);
  expect(afterAdd.guard).not.toBe(snapshot.guard);

  const settingsView = await service.settings(conversation);
  await service.saveSettings(conversation, {
    settings: { ...settingsView.settings, budgetChars: 700 },
    expectedScope: settingsView.scopeToken,
    expectedRevision: settingsView.revision
  });
  expect((await service.runtimeSnapshot('10001', conversation, 'epoch-a')).guard).not.toBe(afterAdd.guard);
});
