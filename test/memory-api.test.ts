import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestCore } from './helpers.js';
import { silentLogger } from '../src/core/logger.js';
import { memoryNamespace } from '../src/memory/schema.js';
import type { ConversationRef } from '../src/routing/identity.js';
import type { Core } from '../src/core/core.js';

const roots: string[] = [], cores: Core[] = [];
const conversation: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };
const group: ConversationRef = { ...conversation, kind: 'group' };
const other: ConversationRef = { ...conversation, accountId: '10002' };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-memory-api-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function seedSecondRole(root: string): Promise<void> {
  const dir = path.join(root, 'public', 'artifacts', 'role-card', 'second', 'r1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'second', kind: 'role-card', revision: 'r1', content: 'Second role'
  }));
}

interface FixtureOptions { maxBodyBytes?: number }

async function setup(options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-memory-api-'));
  roots.push(root);
  const core = await createTestCore({
    dataRoot: root,
    instances: [],
    api: { enabled: true, port: 0, token: 'memory-fixture',
      ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}) },
    logger: silentLogger()
  }, ['10001', '10002']);
  cores.push(core);
  for (const ref of [conversation, group, other]) {
    await core.setConversationRoleBinding(ref, { source: 'public', id: 'default', revision: 'r1' });
  }
  await core.start();
  const headers = { authorization: 'Bearer memory-fixture', 'content-type': 'application/json' };
  const base = (ref = conversation) => `${core.status().apiUrl}/accounts/${ref.accountId}/memory/${ref.kind}/${ref.peerId}`;
  return { root, core, headers, base };
}

async function json(response: Response) {
  return response.json() as Promise<any>;
}

async function getSettings(base: string, headers: Record<string, string>) {
  return json(await fetch(`${base}/settings`, { headers }));
}

async function putSettings(base: string, headers: Record<string, string>, settings: Record<string, unknown>) {
  const state = await getSettings(base, headers);
  return fetch(`${base}/settings`, { method: 'PUT', headers, body: JSON.stringify({
    settings, expectedScope: state.scopeToken, expectedRevision: state.revision
  }) });
}

async function createAt(base: string, headers: Record<string, string>, requestId: string, content: string, keys: string[] = []) {
  const state = await getSettings(base, headers);
  const response = await fetch(`${base}/records`, { method: 'POST', headers, body: JSON.stringify({
    requestId, expectedScope: state.scopeToken, expectedRevision: state.revision, record: { content, keys }
  }) });
  return { status: response.status, body: await json(response) };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}

it('serves closed defaults, requires auth and a role binding, and does not create state on reads', async () => {
  const { root, base, headers } = await setup();
  expect((await fetch(`${base()}/settings`)).status).toBe(401);
  const settings = await getSettings(base(), headers);
  expect(settings).toMatchObject({
    ok: true, accountId: '10001', kind: 'private', peerId: '555',
    revision: 'r0', generation: 0, recordCount: 0,
    settings: { enabled: false, autoExtract: false, budgetChars: 1500, maxSelected: 8 }
  });
  expect(settings.scopeToken).toMatch(/^[0-9a-f]{64}$/);
  expect(await json(await fetch(`${base()}/records`, { headers }))).toMatchObject({ total: 0, items: [] });
  await expect(fs.stat(path.join(root, 'accounts/10001/memory'))).rejects.toMatchObject({ code: 'ENOENT' });

  const missing = await fetch(`${base({ ...conversation, peerId: '999' })}/settings`, { headers });
  expect(missing.status).toBe(404);
  expect(await json(missing)).toMatchObject({ code: 'memory_scope_missing' });
  expect((await fetch(`${base()}/unknown`, { headers })).status).toBe(404);
});

it('isolates accounts, chat kinds and role epochs over HTTP', async () => {
  const { root, core, base, headers } = await setup();
  await seedSecondRole(root);
  const privateCreated = await createAt(base(), headers, 'private-1', '私聊记忆');
  expect(privateCreated.status).toBe(201);
  expect((await createAt(base(group), headers, 'group-1', '群聊记忆')).status).toBe(201);
  expect((await createAt(base(other), headers, 'other-1', '另一账号')).status).toBe(201);
  expect((await json(await fetch(`${base()}/records`, { headers }))).total).toBe(1);
  expect((await json(await fetch(`${base(group)}/records`, { headers }))).total).toBe(1);
  expect((await json(await fetch(`${base(other)}/records`, { headers }))).total).toBe(1);

  const before = await getSettings(base(), headers);
  const oldFile = path.join(root, 'accounts/10001/memory', before.scopeToken, 'state.json');
  const oldState = await fs.readFile(oldFile, 'utf8');
  expect(JSON.parse(oldState).records).toHaveLength(1);
  await core.setConversationRoleBinding(conversation, { source: 'public', id: 'second', revision: 'r1' });
  const after = await getSettings(base(), headers);
  expect(after.scopeToken).not.toBe(before.scopeToken);
  expect(after).toMatchObject({ recordCount: 0, revision: 'r0' });
  expect((await json(await fetch(`${base()}/records`, { headers }))).total).toBe(0);
  const stale = await fetch(`${base()}/records`, { method: 'POST', headers, body: JSON.stringify({
    requestId: 'stale-page', expectedScope: before.scopeToken, expectedRevision: before.revision,
    record: { content: '旧页面写入', keys: [] }
  }) });
  expect(stale.status).toBe(409);
  expect(await json(stale)).toMatchObject({ code: 'memory_conflict' });
  expect(await fs.readFile(oldFile, 'utf8')).toBe(oldState);
  expect(privateCreated.body.record.content).toBe('私聊记忆');
  expect((await createAt(base(), headers, 'second-role-1', '新角色记忆')).status).toBe(201);
});

it('rejects a write that was waiting when the role changed before commit', async () => {
  const { root, core, base, headers } = await setup();
  await seedSecondRole(root);
  const state = await getSettings(base(), headers);
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
  const pending = core.createMemoryRecord(conversation, { requestId: 'role-race', expectedScope: state.scopeToken,
    expectedRevision: state.revision, record: { content: '不应提交', keys: [] } });
  await waitFor(() => blocked);
  await core.setConversationRoleBinding(conversation, { source: 'public', id: 'second', revision: 'r1' });
  release();
  await expect(pending).rejects.toMatchObject({ code: 'memory_conflict' });
  vi.restoreAllMocks();
  const after = await getSettings(base(), headers);
  expect(after.scopeToken).not.toBe(state.scopeToken);
  expect(after.recordCount).toBe(0);
  expect((await json(await fetch(`${base()}/records`, { headers }))).total).toBe(0);
  await expect(fs.stat(path.join(root, 'accounts/10001/memory', state.scopeToken, 'state.json')))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps the memory namespace when only worldbook settings change', async () => {
  const { core, base, headers } = await setup();
  const created = await createAt(base(), headers, 'book-scope', '世界书无关');
  const before = await getSettings(base(), headers);
  const binding = (await core.listConversationRoleBindings('10001'))
    .find(item => item.kind === 'private' && item.peerId === '555')!;
  await core.saveWorldbook({ requestId: 'wb-memory', manifest: { id: 'wb', kind: 'worldbook', revision: 'r1',
    worldbook: { version: 1, entries: [{ id: 'e', keys: ['k'], content: 'c' }] } } });
  await core.configureConversationWorldbook(conversation, { enabled: false, scanDepth: 4, budgetChars: 2000 }, binding.revision);
  const after = await getSettings(base(), headers);
  expect(after.scopeToken).toBe(before.scopeToken);
  expect(after.recordCount).toBe(1);
  expect((await json(await fetch(`${base()}/records`, { headers }))).items[0].id).toBe(created.body.record.id);
});

it('runs manual fact CRUD with double expectations, bounded lists and safe audit logs', async () => {
  const { core, base, headers } = await setup();
  const initial = await getSettings(base(), headers);
  const saved = await fetch(`${base()}/settings`, { method: 'PUT', headers, body: JSON.stringify({
    settings: { enabled: true, autoExtract: false, budgetChars: 2500, maxSelected: 6 },
    expectedScope: initial.scopeToken, expectedRevision: initial.revision
  }) });
  expect(saved.status).toBe(200);
  const settings = await json(saved);
  expect(settings).toMatchObject({ generation: 1, settings: { enabled: true, budgetChars: 2500, maxSelected: 6 } });

  const created: Array<{ status: number; body: any }> = [];
  for (const [index, content] of ['第一记忆', '第二记忆', '第三记忆'].entries()) {
    created.push(await createAt(base(), headers, `crud-${index}`, content, index === 0 ? ['秘密关键词'] : []));
  }
  expect(created.map(item => item.status)).toEqual([201, 201, 201]);
  expect(created[0]!.body.record).toMatchObject({ type: 'fact', origin: 'user', content: '第一记忆', keys: ['秘密关键词'] });
  expect((core.auditLog.recent(20).length)).toBeGreaterThanOrEqual(3);
  const audited = JSON.stringify(core.auditLog.recent(20));
  expect(audited).toContain('create_memory_record');
  expect(audited).toContain('10001/private/555');
  expect(audited).not.toContain('第一记忆');
  expect(audited).not.toContain('秘密关键词');

  const page = await json(await fetch(`${base()}/records?limit=2`, { headers }));
  expect(page.total).toBe(3);
  expect(page.items).toHaveLength(2);
  expect(page.items[0]).not.toHaveProperty('content');
  expect(page.nextOffset).toBe(2);
  const rest = await json(await fetch(`${base()}/records?offset=${page.nextOffset}&limit=2`, { headers }));
  expect(rest.items).toHaveLength(1);
  expect(rest.nextOffset).toBeUndefined();

  const first = created[0]!.body.record;
  const current = await getSettings(base(), headers);
  const detail = await json(await fetch(`${base()}/records/${first.id}`, { headers }));
  expect(detail).toMatchObject({ record: { id: first.id, content: '第一记忆' }, revision: current.revision });

  const staleUpdate = await fetch(`${base()}/records/${first.id}`, { method: 'PUT', headers, body: JSON.stringify({
    expectedScope: current.scopeToken, expectedRevision: current.revision, recordRevision: 'stale',
    content: '不应写入'
  }) });
  expect(staleUpdate.status).toBe(409);
  const updated = await fetch(`${base()}/records/${first.id}`, { method: 'PUT', headers, body: JSON.stringify({
    expectedScope: current.scopeToken, expectedRevision: current.revision, recordRevision: first.revision,
    content: '第一记忆已修改', pinned: true
  }) });
  expect(updated.status).toBe(200);
  const updatedBody = await json(updated);
  expect(updatedBody.record).toMatchObject({ content: '第一记忆已修改', pinned: true, origin: 'user' });
  expect(updatedBody.record.revision).not.toBe(first.revision);

  const removed = await fetch(`${base()}/records/${first.id}`, { method: 'DELETE', headers, body: JSON.stringify({
    expectedScope: updatedBody.scopeToken, expectedRevision: updatedBody.revision, recordRevision: updatedBody.record.revision
  }) });
  expect(removed.status).toBe(200);
  expect(await json(removed)).toMatchObject({ deleted: first.id, recordCount: 2 });
  expect((await fetch(`${base()}/records/${first.id}`, { headers })).status).toBe(404);

  const latest = await getSettings(base(), headers);
  const staleSettings = await fetch(`${base()}/settings`, { method: 'PUT', headers, body: JSON.stringify({
    settings: { enabled: false, autoExtract: false, budgetChars: 100, maxSelected: 8 },
    expectedScope: initial.scopeToken, expectedRevision: initial.revision
  }) });
  expect(staleSettings.status).toBe(409);
  const cleared = await fetch(`${base()}/clear`, { method: 'POST', headers, body: JSON.stringify({
    expectedScope: latest.scopeToken, expectedRevision: latest.revision
  }) });
  expect(cleared.status).toBe(200);
  const clearedBody = await json(cleared);
  expect(clearedBody).toMatchObject({ recordCount: 0, settings: { enabled: true, autoExtract: false } });
  expect(clearedBody.generation).toBe(latest.generation + 1);
  expect((await json(await fetch(`${base()}/records`, { headers }))).total).toBe(0);
});

it('keeps validation, not-found and body-limit errors explicit', async () => {
  const { base, headers } = await setup({ maxBodyBytes: 8192 });
  const state = await getSettings(base(), headers);
  const invalid = async (body: unknown, suffix = '/records', method = 'POST') =>
    fetch(`${base()}${suffix}`, { method, headers, body: JSON.stringify(body) });

  expect((await invalid({ requestId: 'x', expectedScope: state.scopeToken, expectedRevision: state.revision,
    record: { content: '正文', keys: [], origin: 'model' } })).status).toBe(400);
  expect((await invalid({ requestId: 'x', expectedScope: state.scopeToken, expectedRevision: state.revision,
    record: { type: 'summary', content: '摘要', keys: [] } })).status).toBe(400);
  expect((await invalid({ requestId: 'x', expectedScope: state.scopeToken, expectedRevision: state.revision,
    record: { content: 'x'.repeat(4001), keys: [] } })).status).toBe(400);
  expect((await invalid({ requestId: 'x', expectedScope: 'not-a-token', expectedRevision: state.revision,
    record: { content: '正文', keys: [] } })).status).toBe(400);
  expect((await fetch(`${base()}/records?limit=101`, { headers })).status).toBe(400);
  expect((await fetch(`${base()}/records/r-missing`, { headers })).status).toBe(404);
  expect((await invalid({ requestId: 'x', expectedScope: state.scopeToken, expectedRevision: state.revision,
    record: { content: 'x'.repeat(9000), keys: [] } })).status).toBe(413);
  expect((await invalid({ text: 'x'.repeat(16000), expectedScope: state.scopeToken }, '/preview')).status).toBe(413);

  const missingScope = await fetch(`${base()}/settings`, { method: 'PUT', headers, body: JSON.stringify({
    settings: { enabled: false, autoExtract: false, budgetChars: 100, maxSelected: 8 }
  }) });
  expect(missingScope.status).toBe(400);
});

it('persists settings and records across a Core restart', async () => {
  const { root, core, base, headers } = await setup();
  const state = await getSettings(base(), headers);
  const saved = await json(await fetch(`${base()}/settings`, { method: 'PUT', headers, body: JSON.stringify({
    settings: { enabled: true, autoExtract: true, budgetChars: 1800, maxSelected: 5 },
    expectedScope: state.scopeToken, expectedRevision: state.revision
  }) }));
  const created = await fetch(`${base()}/records`, { method: 'POST', headers, body: JSON.stringify({
    requestId: 'restart-record', expectedScope: saved.scopeToken, expectedRevision: saved.revision,
    record: { content: '重启后仍在', keys: ['重启'] }
  }) });
  expect(created.status).toBe(201);
  await core.stop();

  const restarted = await createTestCore({
    dataRoot: root, instances: [], api: { enabled: true, port: 0, token: 'memory-fixture' }, logger: silentLogger()
  }, ['10001', '10002']);
  cores.push(restarted);
  await restarted.start();
  const restartedBase = `${restarted.status().apiUrl}/accounts/10001/memory/private/555`;
  const after = await getSettings(restartedBase, headers);
  expect(after).toMatchObject({ recordCount: 1, settings: { enabled: true, autoExtract: true, budgetChars: 1800, maxSelected: 5 } });
  const list = await json(await fetch(`${restartedBase}/records`, { headers }));
  expect(list.total).toBe(1);
  const detail = await json(await fetch(`${restartedBase}/records/${list.items[0].id}`, { headers }));
  expect(detail.record.content).toBe('重启后仍在');
  expect(detail.record.keys).toEqual(['重启']);
});

it('exposes extraction status and explicit activate/pause with double expectations and scope isolation', async () => {
  const { core, base, headers } = await setup();
  expect((await fetch(`${base()}/extraction`)).status).toBe(401);
  const initial = await getSettings(base(), headers);
  expect(initial.extraction).toMatchObject({
    effectiveStatus: 'disabled',
    autoExtract: false,
    throughSeq: 0,
    recentResultCount: 0
  });
  const extraction = async (ref = conversation) => json(await fetch(`${base(ref)}/extraction`, { headers }));
  expect(await extraction()).toMatchObject({
    quota: { accountUsed: 0, accountLimit: 12, globalUsed: 0, globalLimit: 30 },
    runtime: { running: false, pending: false, circuitOpen: false }
  });

  const enabled = await putSettings(base(), headers, { enabled: true, autoExtract: true, budgetChars: 1500, maxSelected: 8 });
  expect(enabled.status).toBe(200);
  const enabledBody = await json(enabled);
  expect(enabledBody.extraction).toMatchObject({ effectiveStatus: 'needs-confirmation', autoExtract: true });
  expect(await extraction()).toMatchObject({
    scopeToken: enabledBody.scopeToken,
    revision: enabledBody.revision,
    generation: enabledBody.generation,
    extraction: { effectiveStatus: 'needs-confirmation' }
  });

  const activate = (body: unknown) => fetch(`${base()}/extraction/activate`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect((await activate({ expectedScope: enabledBody.scopeToken, expectedRevision: enabledBody.revision, startFrom: 'now' })).status).toBe(400);
  expect((await activate({ expectedScope: enabledBody.scopeToken, expectedRevision: enabledBody.revision, startFrom: 'history', confirmModelUse: true })).status).toBe(400);
  expect((await activate({ expectedScope: enabledBody.scopeToken, expectedRevision: 'stale', startFrom: 'now', confirmModelUse: true })).status).toBe(409);
  const groupState = await getSettings(base(group), headers);
  const wrongScope = await activate({ expectedScope: groupState.scopeToken, expectedRevision: enabledBody.revision, startFrom: 'now', confirmModelUse: true });
  expect(wrongScope.status).toBe(409);
  const wrongScopeBody = await wrongScope.text();
  expect(wrongScopeBody).not.toContain(enabledBody.scopeToken);
  expect(wrongScopeBody).not.toContain('删除后暂停');

  const activated = await activate({ expectedScope: enabledBody.scopeToken, expectedRevision: enabledBody.revision, startFrom: 'now', confirmModelUse: true });
  expect(activated.status).toBe(200);
  const activeBody = await json(activated);
  expect(activeBody.extraction).toMatchObject({
    effectiveStatus: 'active',
    autoExtract: true,
    activationVersion: 1,
    activatedAfterSeq: 0,
    throughSeq: 0
  });
  expect((await extraction()).generation).toBe(activeBody.generation);

  const created = await createAt(base(), headers, 'extraction-delete', '删除后暂停');
  const current = await getSettings(base(), headers);
  const removed = await fetch(`${base()}/records/${created.body.record.id}`, { method: 'DELETE', headers, body: JSON.stringify({
    expectedScope: current.scopeToken,
    expectedRevision: current.revision,
    recordRevision: created.body.record.revision
  }) });
  expect(removed.status).toBe(200);
  const removedBody = await json(removed);
  expect(removedBody.extraction).toMatchObject({
    effectiveStatus: 'paused',
    autoExtract: false,
    pausedReason: 'deleted'
  });
  expect((await extraction()).extraction).toMatchObject({ effectiveStatus: 'paused', pausedReason: 'deleted' });

  const req = await getSettings(base(), headers);
  const reactivated = await activate({ expectedScope: req.scopeToken, expectedRevision: req.revision, startFrom: 'now', confirmModelUse: true });
  expect(reactivated.status).toBe(200);
  const reactivatedBody = await json(reactivated);
  expect(reactivatedBody.extraction).toMatchObject({ effectiveStatus: 'active', autoExtract: true });
  const pause = (revision: string, scope = reactivatedBody.scopeToken) => fetch(`${base()}/extraction/pause`, {
    method: 'POST', headers, body: JSON.stringify({ expectedScope: scope, expectedRevision: revision })
  });
  expect((await pause('stale')).status).toBe(409);
  const paused = await pause(reactivatedBody.revision);
  expect(paused.status).toBe(200);
  const pausedBody = await json(paused);
  expect(pausedBody.extraction).toMatchObject({ effectiveStatus: 'paused', pausedReason: 'user', autoExtract: false });
  expect(pausedBody.extraction.activationVersion).toBeUndefined();
  expect((await extraction()).extraction.effectiveStatus).toBe('paused');

  const otherState = await getSettings(base(other), headers);
  expect((await pause(otherState.revision, otherState.scopeToken)).status).toBe(409);

  const audited = JSON.stringify(core.auditLog.recent(50));
  expect(audited).toContain('activate_memory_extraction');
  expect(audited).toContain('pause_memory_extraction');
  expect(audited).not.toContain('删除后暂停');
});

it('serves read-only previews with scope isolation and no persisted side effects', async () => {
  const { root, core, base, headers } = await setup();
  const saved = await putSettings(base(), headers, { enabled: true, autoExtract: false, budgetChars: 1000, maxSelected: 5 });
  expect(saved.status).toBe(200);
  await putSettings(base(group), headers, { enabled: true, autoExtract: false, budgetChars: 1000, maxSelected: 5 });
  const privateCreated = await createAt(base(), headers, 'preview-private', '私聊银杏', ['银杏']);
  const groupCreated = await createAt(base(group), headers, 'preview-group', '群聊银杏', ['银杏']);
  const privateState = await getSettings(base(), headers);
  const groupState = await getSettings(base(group), headers);
  const privateFile = path.join(root, 'accounts/10001/memory', privateState.scopeToken, 'state.json');
  const before = await fs.readFile(privateFile, 'utf8');
  const auditBefore = core.auditLog.recent(100).length;

  const preview = (ref: ConversationRef, token: string, text = '银杏', extra: Record<string, unknown> = {}) =>
    fetch(`${base(ref)}/preview`, { method: 'POST', headers, body: JSON.stringify({ text, expectedScope: token, ...extra }) });

  expect((await fetch(`${base()}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    text: '银杏', expectedScope: privateState.scopeToken
  }) })).status).toBe(401);
  const ok = await preview(conversation, privateState.scopeToken);
  expect(ok.status).toBe(200);
  const body = await json(ok);
  expect(body).toMatchObject({ ok: true, revision: privateState.revision, budgetBasis: 'memory-only' });
  expect(body.notice).toContain('真实对话');
  expect(body.evaluation.selectedIds).toEqual([privateCreated.body.record.id]);
  expect(body.evaluation.content).toContain('私聊银杏');

  const crossKind = await preview(group, privateState.scopeToken);
  expect(crossKind.status).toBe(409);
  expect(await json(crossKind)).toMatchObject({ code: 'memory_conflict' });
  const crossAccount = await preview(other, privateState.scopeToken);
  expect(crossAccount.status).toBe(409);
  const missingRole = await preview({ ...conversation, peerId: '999' }, privateState.scopeToken);
  expect(missingRole.status).toBe(404);
  expect(await json(missingRole)).toMatchObject({ code: 'memory_scope_missing' });

  const groupBody = await json(await preview(group, groupState.scopeToken));
  expect(groupBody.evaluation.selectedIds).toEqual([groupCreated.body.record.id]);
  expect(groupBody.evaluation.content).toContain('群聊银杏');
  expect(groupBody.evaluation.content).not.toContain('私聊银杏');

  const emptyOther = await json(await preview(other, (await getSettings(base(other), headers)).scopeToken));
  expect(emptyOther.evaluation).toMatchObject({ content: '', selectedIds: [], usedChars: 0 });
  await expect(fs.stat(path.join(root, 'accounts/10002/memory'))).rejects.toMatchObject({ code: 'ENOENT' });

  expect((await preview(conversation, privateState.scopeToken, '银杏', { budgetChars: 9999 })).status).toBe(400);
  expect((await preview(conversation, privateState.scopeToken, 'x'.repeat(16001))).status).toBe(400);
  expect((await fetch(`${base()}/preview`, { headers })).status).toBe(404);

  expect(await fs.readFile(privateFile, 'utf8')).toBe(before);
  expect(core.auditLog.recent(100)).toHaveLength(auditBefore);
  expect(JSON.stringify(core.auditLog.recent(100))).not.toContain('私聊银杏');
});

it('drains an accepted preview and rejects new previews during shutdown', async () => {
  const { root, core, base, headers } = await setup();
  await putSettings(base(), headers, { enabled: true, autoExtract: false, budgetChars: 1000, maxSelected: 5 });
  await createAt(base(), headers, 'preview-drain', '退出前可预览', ['退出']);
  const state = await getSettings(base(), headers);
  const resolved = await core.resolveConversationRoleBinding('10001', conversation);
  const namespace = memoryNamespace({ ...conversation, contextEpoch: resolved!.contextEpoch! });
  expect(state.scopeToken).toBe(namespace);
  const stateFile = path.join(root, 'accounts/10001/memory', namespace, 'state.json');

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

  const pending = core.previewMemory(conversation, { text: '退出', expectedScope: state.scopeToken });
  await waitFor(() => blocked);
  const stopping = core.stop();
  await expect(core.previewMemory(conversation, { text: '退出', expectedScope: state.scopeToken }))
    .rejects.toMatchObject({ code: 'core_stopped' });
  release();
  const preview = await pending;
  expect(preview.evaluation.selectedIds).toHaveLength(1);
  await stopping;
  vi.restoreAllMocks();
  expect(JSON.parse(await fs.readFile(stateFile, 'utf8')).records).toHaveLength(1);
});

it('drains an accepted write and rejects new work during shutdown', async () => {
  const { root, core, base, headers } = await setup();
  const state = await getSettings(base(), headers);
  const resolved = await core.resolveConversationRoleBinding('10001', conversation);
  expect(resolved?.contextEpoch).toBeDefined();
  const namespace = memoryNamespace({ ...conversation, contextEpoch: resolved!.contextEpoch! });
  const stateFile = path.join(root, 'accounts/10001/memory', namespace, 'state.json');

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('state.json')) {
      blocked = true;
      await gate;
    }
    return rename(from, to);
  });

  const pending = core.createMemoryRecord(conversation, { requestId: 'shutdown-write', expectedScope: state.scopeToken,
    expectedRevision: state.revision, record: { content: '退出前已准入', keys: [] } });
  await waitFor(() => blocked);
  const stopping = core.stop();
  await expect(core.createMemoryRecord(conversation, { requestId: 'after-stop', expectedScope: state.scopeToken,
    expectedRevision: state.revision, record: { content: '不应写入', keys: [] } })).rejects.toMatchObject({ code: 'core_stopped' });
  release();
  const created = await pending;
  expect(created.record.content).toBe('退出前已准入');
  await stopping;
  vi.restoreAllMocks();

  const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  expect(persisted.records).toHaveLength(1);
  expect(persisted.records[0].content).toBe('退出前已准入');
});
