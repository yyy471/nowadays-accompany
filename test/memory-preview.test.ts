import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryService } from '../src/application/memory/memory-service.js';
import { memoryNamespace } from '../src/memory/schema.js';
import { selectMemory } from '../src/memory/selector.js';
import { DEFAULT_MEMORY_SETTINGS, type MemoryRecord, type MemorySettings } from '../src/memory/types.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-memory-preview-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const privateConv: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };
const groupConv: ConversationRef = { ...privateConv, kind: 'group' };

function epochFor(conversation: ConversationRef = privateConv, epoch = 'epoch-a'): string {
  return `${conversation.accountId}:${conversation.kind}:${conversation.peerId}:${epoch}`;
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-memory-preview-'));
  roots.push(root);
  const service = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => conversation.peerId === '999' ? undefined
      : epochFor({ ...conversation, accountId }) },
    accountDir: accountId => path.join(root, 'accounts', accountId)
  });
  const stateFile = (conversation: ConversationRef = privateConv) => path.join(
    root, 'accounts', conversation.accountId, 'memory', memoryNamespace({ ...conversation, contextEpoch: epochFor(conversation) }), 'state.json'
  );
  return { root, service, stateFile };
}

async function enable(service: MemoryService, overrides: Partial<MemorySettings> = {}, conversation: ConversationRef = privateConv) {
  const view = await service.settings(conversation);
  return service.saveSettings(conversation, {
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true, ...overrides },
    expectedScope: view.scopeToken,
    expectedRevision: view.revision
  });
}

async function add(service: MemoryService, content: string, keys: string[], extra: Record<string, unknown> = {},
  conversation: ConversationRef = privateConv) {
  const view = await service.settings(conversation);
  return service.createRecord(conversation, {
    requestId: `preview-${Math.random().toString(36).slice(2)}`,
    expectedScope: view.scopeToken,
    expectedRevision: view.revision,
    record: { content, keys, ...extra }
  });
}

it('P01 previews only the explicit current scope and rejects forged or cross-scope tokens', async () => {
  const { service } = await setup();
  await enable(service);
  const privateRecord = await add(service, '私聊秘密', ['秘密']);
  await enable(service, {}, groupConv);
  const groupRecord = await add(service, '群聊秘密', ['秘密'], {}, groupConv);

  const groupView = await service.settings(groupConv);
  const groupPreview = await service.preview(groupConv, { text: '秘密', expectedScope: groupView.scopeToken });
  expect(groupPreview.evaluation.selectedIds).toEqual([groupRecord.record.id]);
  expect(groupPreview.evaluation.content).toContain('群聊秘密');
  expect(groupPreview.evaluation.content).not.toContain('私聊秘密');

  const privateView = await service.settings(privateConv);
  await expect(service.preview(groupConv, { text: '秘密', expectedScope: privateView.scopeToken }))
    .rejects.toMatchObject({ code: 'memory_conflict' });
  await expect(service.preview({ ...privateConv, peerId: '999' }, { text: '秘密', expectedScope: privateView.scopeToken }))
    .rejects.toMatchObject({ code: 'memory_scope_missing' });
  expect(privateView.recordCount).toBe(1);
  expect(privateRecord.record.id).toMatch(/^r-/);
});

it('P02 rejects unknown fields, overrides and oversized text without touching state', async () => {
  const { service, stateFile } = await setup();
  await enable(service);
  await add(service, '银杏', ['银杏']);
  const before = await fs.readFile(stateFile(), 'utf8');
  const view = await service.settings(privateConv);

  const invalidBodies: unknown[] = [
    { text: 'x' },
    { text: 'x', expectedScope: view.scopeToken, budgetChars: 9999 },
    { text: 'x', expectedScope: view.scopeToken, records: [] },
    { text: 'x', expectedScope: view.scopeToken, history: [] },
    { text: 42, expectedScope: view.scopeToken },
    { text: 'x', expectedScope: 'not-a-token' },
    { text: 'x'.repeat(16001), expectedScope: view.scopeToken }
  ];
  for (const body of invalidBodies) {
    await expect(service.preview(privateConv, body)).rejects.toMatchObject({ code: 'invalid_spec' });
  }
  const exact = await service.preview(privateConv, { text: 'x'.repeat(16000), expectedScope: view.scopeToken });
  expect(exact.evaluation.content).toBe('');
  expect(await fs.readFile(stateFile(), 'utf8')).toBe(before);
});

it('P03 reads the saved file only, without writes, receipts, watermarks, audit or model calls', async () => {
  const { service, stateFile } = await setup();
  await enable(service);
  await add(service, '喜欢银杏', ['银杏']);
  await add(service, '固定偏好', [], { pinned: true });
  const file = stateFile();
  const before = await fs.readFile(file, 'utf8');
  const dirsBefore = await fs.readdir(path.dirname(file), { recursive: true });
  const view = await service.settings(privateConv);

  const result = await service.preview(privateConv, { text: '银杏', expectedScope: view.scopeToken });
  expect(result).toMatchObject({ budgetBasis: 'memory-only' });
  expect(result.notice).toContain('真实对话');
  expect(result.evaluation.content).toContain('喜欢银杏');
  expect(result.evaluation.content).toContain('固定偏好');

  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect(await fs.readdir(path.dirname(file), { recursive: true })).toEqual(dirsBefore);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(persisted.receipts).toHaveLength(2);
  expect(persisted.generation).toBe(view.generation);
  expect(persisted.revision).toBe(view.revision);
});

it('P04/P05 returns empty evaluations when disabled or the budget is zero', async () => {
  const { service } = await setup();
  await enable(service);
  await add(service, '固定', [], { pinned: true });
  await add(service, '关键词', ['关键词']);
  const enabled = await service.settings(privateConv);
  const closed = await service.saveSettings(privateConv, {
    settings: { ...enabled.settings, enabled: false },
    expectedScope: enabled.scopeToken,
    expectedRevision: enabled.revision
  });
  const disabled = await service.preview(privateConv, { text: '关键词', expectedScope: closed.scopeToken });
  expect(disabled.evaluation).toMatchObject({ content: '', selectedIds: [], usedChars: 0 });
  expect(disabled.evaluation.budgetSkippedIds).toEqual([]);
  expect(disabled.evaluation.countSkippedIds).toEqual([]);

  const zero = await service.saveSettings(privateConv, {
    settings: { ...closed.settings, enabled: true, budgetChars: 0 },
    expectedScope: closed.scopeToken,
    expectedRevision: closed.revision
  });
  const empty = await service.preview(privateConv, { text: '关键词', expectedScope: zero.scopeToken });
  expect(empty.evaluation).toMatchObject({ content: '', selectedIds: [], usedChars: 0 });
  expect(empty.evaluation.content).not.toContain('长期记忆');
});

it('P06 rejects a role change that happens while the state file is being read', async () => {
  const { root, service, stateFile } = await setup();
  await enable(service);
  await add(service, '旧角色记忆', ['记忆']);
  const view = await service.settings(privateConv);
  expect(stateFile()).toBe(path.join(root, 'accounts/10001/memory', view.scopeToken, 'state.json'));

  let epoch = 'epoch-a';
  const flaky = new MemoryService({
    roles: { contextEpoch: async (accountId, conversation) => epochFor({ ...conversation, accountId }, epoch) },
    accountDir: accountId => path.join(root, 'accounts', accountId)
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation((async (file: unknown, flags: unknown, mode: unknown) => {
    if (String(file).endsWith('state.json')) {
      blocked = true;
      await gate;
    }
    return open(file as string, flags as 'r', mode as number | undefined);
  }) as typeof fs.open);

  const pending = flaky.preview(privateConv, { text: '记忆', expectedScope: view.scopeToken });
  await waitFor(() => blocked);
  epoch = 'epoch-b';
  release();
  await expect(pending).rejects.toMatchObject({ code: 'memory_conflict' });
  vi.restoreAllMocks();
});

it('P07 matches the runtime selector exactly for identical records, text and effective budget', async () => {
  const { service, stateFile } = await setup();
  await enable(service, { budgetChars: 200, maxSelected: 2 });
  await add(service, '第一条', ['银杏']);
  await add(service, '固定的', [], { pinned: true });
  await add(service, '第三条', ['银杏']);
  const view = await service.settings(privateConv);
  const text = '今天去看银杏';
  const preview = await service.preview(privateConv, { text: `  ${text}  `, expectedScope: view.scopeToken });

  const persisted = JSON.parse(await fs.readFile(stateFile(), 'utf8'));
  const direct = selectMemory({
    records: persisted.records as MemoryRecord[],
    currentText: text,
    enabled: persisted.settings.enabled,
    budgetChars: persisted.settings.budgetChars,
    maxSelected: persisted.settings.maxSelected
  });
  expect(preview.evaluation).toEqual(direct);
  expect(preview).toMatchObject({ revision: persisted.revision, generation: persisted.generation, budgetBasis: 'memory-only' });
});

it('P08 fails closed for corrupt or unreadable state without leaking paths or content', async () => {
  const { service, stateFile } = await setup();
  await enable(service);
  await add(service, '不应泄漏的正文', ['银杏']);
  const view = await service.settings(privateConv);
  const file = stateFile();
  await fs.writeFile(file, '{not-json');

  const corrupt = await boundaryError(() => service.preview(privateConv, { text: '银杏', expectedScope: view.scopeToken }));
  expect(corrupt.code).toBe('memory_io_error');
  expect(corrupt.message).not.toContain(file);
  expect(corrupt.message).not.toContain('不应泄漏');

  await fs.writeFile(file, JSON.stringify({
    version: 1,
    scope: { ...privateConv, contextEpoch: epochFor() },
    revision: 'r1',
    generation: 1,
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true },
    records: [],
    receipts: []
  }));
  vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
  const unreadable = await boundaryError(() => service.preview(privateConv, { text: '银杏', expectedScope: view.scopeToken }));
  expect(unreadable.code).toBe('memory_io_error');
  expect(unreadable.message).not.toContain(file);
});

async function boundaryError(task: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await task();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected rejection');
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}
