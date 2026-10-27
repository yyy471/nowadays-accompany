import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestCore } from './helpers.js';
import { accountPolicy, bind, fakeProvider, textInbound, waitFor, writePhase1Config } from './phase1-helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { TavernCardImportService } from '../src/application/artifacts/tavern-card-import-service.js';
import type { Core } from '../src/core/core.js';
import { buildChatContext } from '../src/agent/context.js';
import { parseWorldbook } from '../src/worldbook/schema.js';
import { ConversationRoleBindingStore } from '../src/profiles/role-bindings.js';
import { LocalArtifactStore } from '../src/artifacts/local.js';

const roots: string[] = [], cores: Core[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(await fs.realpath(os.tmpdir())) || !path.basename(root).startsWith('nowadays-worldbook-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});
const conversation = { accountId: '10001', kind: 'private' as const, peerId: '555' };
const enabled = { enabled: true, scanDepth: 4, budgetChars: 2000 };
async function setup(runtime = false) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nowadays-worldbook-')); roots.push(root);
  const source = path.join(root, 'role.json');
  await fs.writeFile(source, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'World role', description: 'BASE_ROLE', character_book: { scan_depth: 3, entries: [{ id: 'orchard', keys: ['orchard'], content: 'PRIVATE_ORCHARD_LORE', enabled: true, insertion_order: 0 }] } } }));
  const card = await new TavernCardImportService({ publicRoot: path.join(root, 'public') }).import(source);
  await writePhase1Config(root, { providers: [fakeProvider('fake-chat', { chatText: 'ok' })], accountPolicies: Object.fromEntries(['10001', '10002'].map(id => [id, accountPolicy({ allowedProviders: ['fake-chat'], bindings: { chat: bind('fake-chat', 'text-model') } })])) });
  const channels = new Map<string, FakeChannel>(), adapter = new FakeProviderAdapter();
  const core = await createTestCore({ dataRoot: root, instances: runtime ? [{ id: 'a', backend: 'fake', accountId: '10001' }, { id: 'b', backend: 'fake', accountId: '10002' }] : [],
    channelFactory: context => { const channel = new FakeChannel(context, { selfId: context.spec.accountId }); channels.set(context.instanceId, channel); return channel; },
    providerAdapters: [adapter], api: { enabled: true, port: 0, token: 'worldbook-fixture' }, limits: { hostTimeoutMs: 5000 }, logger: silentLogger() }, ['10001', '10002']);
  cores.push(core);
  for (const ref of [conversation, { ...conversation, kind: 'group' as const, peerId: '777' }, { ...conversation, accountId: '10002' }]) {
    await core.setConversationRoleBinding(ref, { source: 'public', id: card.id, revision: card.revision });
  }
  await core.start();
  if (runtime) await waitFor(() => core.status().instances.every(status => status.state === 'online'));
  const latest = async (ref = conversation) => (await core.listConversationRoleBindings(ref.accountId)).find(item => item.kind === ref.kind && item.peerId === ref.peerId)!;
  const configure = async (ref = conversation, options = enabled) => core.configureConversationWorldbook(ref, options, (await latest(ref)).revision);
  const url = `${core.status().apiUrl}/accounts/10001/role-bindings/private/555/worldbook`;
  const headers = { authorization: 'Bearer worldbook-fixture', 'content-type': 'application/json' };
  return { root, core, card, channels, adapter, latest, configure, url, headers };
}

it('requires explicit enablement, previews read-only with auth and rejects stale concurrent settings', async () => {
  const { root, core, latest, configure, url, headers } = await setup();
  const original = await latest();
  expect(original).toMatchObject({ worldbookEntryCount: 1, worldbookDefaults: { scanDepth: 3, budgetChars: 2000 } });
  expect(original.worldbook).toBeUndefined();
  const preview = () => fetch(`${url}/preview`, { method: 'POST', headers, body: JSON.stringify({ text: 'orchard' }) });
  expect((await fetch(`${url}/preview`, { method: 'POST', body: '{}' })).status).toBe(401);
  expect(await (await preview()).json()).toMatchObject({ evaluation: { selectedIds: [], usedChars: 0 } });
  const updated = await configure();
  expect(updated.roleCard).toEqual(original.roleCard); expect(updated.revision).not.toBe(original.revision);
  const file = path.join(root, 'accounts/10001/role-bindings.json'); const before = await fs.readFile(file, 'utf8');
  expect(await (await preview()).json()).toMatchObject({ evaluation: { selectedIds: ['orchard'] } });
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  const results = await Promise.all([2100, 2200].map(budgetChars => fetch(url, { method: 'PUT', headers, body: JSON.stringify({ worldbook: { ...enabled, budgetChars }, expectedRevision: updated.revision }) })));
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect((await latest()).roleCard).toEqual(original.roleCard);
  await expect(core.configureConversationWorldbook(conversation, { ...enabled, budgetChars: 9000 }, (await latest()).revision)).rejects.toThrow();
});

it('rejects invalid source writes without changing the saved binding or opt-in', async () => {
  const { root, url, headers, latest } = await setup();
  const original = await latest();
  const file = path.join(root, 'accounts/10001/role-bindings.json');
  const before = await fs.readFile(file, 'utf8');
  for (const source of [{ kind: 'artifact', ref: { source: 'public', id: 'missing', revision: 'r1' } }, null]) {
    const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ worldbook: enabled, expectedRevision: original.revision, source }) });
    expect([400, 404]).toContain(response.status);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await latest()).revision).toBe(original.revision);
  }
});

const standaloneSource = (revision = 'r1') => ({ kind: 'artifact' as const, ref: { source: 'public' as const, id: 'standalone', revision } });
async function standalone(core: Core, revision = 'r1', content = 'EXTERNAL_WORLD') {
  return core.saveWorldbook({ requestId: `standalone-${revision}`, manifest: { id: 'standalone', kind: 'worldbook', revision,
    worldbook: { version: 1, entries: [{ id: 'external', keys: ['orchard'], content }] } } });
}

it('persists source changes only after a successful commit and refuses unknown persisted source kinds', async () => {
  const { root, core, latest } = await setup(); await standalone(core);
  const previous = await latest(), file = path.join(root, 'accounts/10001/role-bindings.json');
  const before = await fs.readFile(file, 'utf8');
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, target) => {
    if (String(target) === file) throw Object.assign(new Error('test write failure'), { code: 'EIO' });
    return rename(from, target);
  });
  await expect(core.configureConversationWorldbook(conversation, enabled, previous.revision, standaloneSource())).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  vi.restoreAllMocks();
  const parsed = JSON.parse(before);
  for (const binding of Object.values(parsed.bindings) as Array<Record<string, unknown>>) binding.worldbookSource = { kind: 'unknown' };
  await fs.writeFile(file, JSON.stringify(parsed));
  await expect(core.listConversationRoleBindings('10001')).rejects.toThrow('kind');
});

it('isolates a broken book, allows manual send and explicit disabling, and avoids disabled runtime book reads', async () => {
  const { root, core, channels, adapter, latest, url, headers } = await setup(true); await standalone(core);
  await core.configureConversationWorldbook(conversation, enabled, (await latest()).revision, standaloneSource());
  const epoch = (await core.resolveConversationRoleBinding('10001', conversation))!.contextEpoch;
  await fs.unlink(path.join(root, 'public/artifacts/worldbook/standalone/r1/manifest.json'));
  const view = await latest();
  expect(view.effectiveWorldbook).toMatchObject({ state: 'missing', source: standaloneSource() });
  const preview = await fetch(`${url}/preview`, { method: 'POST', headers, body: JSON.stringify({ text: 'orchard' }) });
  expect(preview.status).toBe(409);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'broken', 'orchard'));
  await waitFor(async () => (await core.readMessages('10001', conversation)).some(message => message.messageId === 'broken'));
  expect(adapter.calls).toHaveLength(0);
  await core.send('a', conversation, { segments: [{ type: 'text', data: { text: 'manual' } }] });
  expect(channels.get('a')!.sent).toHaveLength(1);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '777', 'unaffected', 'hi', 'group'));
  await waitFor(() => channels.get('a')!.sent.length === 2);
  expect(adapter.calls).toHaveLength(1);
  await core.configureConversationWorldbook(conversation, { ...enabled, enabled: false }, view.revision, standaloneSource());
  const read = vi.spyOn(LocalArtifactStore.prototype, 'resolveWorldbook');
  const disabled = await core.resolveConversationRoleBinding('10001', conversation);
  expect(read).not.toHaveBeenCalled(); expect(disabled!.contextEpoch).toBe(epoch);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'recovered', 'continue'));
  await waitFor(() => channels.get('a')!.sent.length === 3);
  expect(adapter.calls[1]!.requestText).not.toContain('EXTERNAL_WORLD');
  expect(adapter.calls[1]!.requestText).not.toContain('PRIVATE_ORCHARD_LORE');
});

it('atomically saves the fixed source, reuses it for preview and preserves it for legacy parameter writes', async () => {
  const { root, core, latest, url, headers } = await setup();
  await standalone(core);
  const original = await latest();
  const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ worldbook: enabled, source: standaloneSource(), expectedRevision: original.revision }) });
  expect(response.status).toBe(200);
  expect((await latest()).worldbookSource).toEqual(standaloneSource());
  expect((await new ConversationRoleBindingStore().get(path.join(root, 'accounts/10001'), conversation))!.worldbookSource).toEqual(standaloneSource());
  expect((await latest()).roleCard).toEqual(original.roleCard);
  const file = path.join(root, 'accounts/10001/role-bindings.json'); const before = await fs.readFile(file, 'utf8');
  expect(await core.previewConversationWorldbook(conversation, 'orchard')).toMatchObject({ selectedIds: ['external'], afterRole: expect.stringContaining('EXTERNAL_WORLD') });
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  await core.configureConversationWorldbook(conversation, { ...enabled, budgetChars: 2200 }, (await latest()).revision);
  expect((await latest()).worldbookSource).toEqual(standaloneSource());
  const back = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ worldbook: enabled, source: { kind: 'role-card' }, expectedRevision: (await latest()).revision }) });
  expect(back.status).toBe(200);
  expect((await core.previewConversationWorldbook(conversation, 'orchard')).selectedIds).toEqual(['orchard']);
  await core.setConversationRoleBinding(conversation, original.roleCard);
  expect((await latest()).worldbookSource).toBeUndefined(); expect((await latest()).worldbook).toBeUndefined();
});

it('CAS guards source changes and serializes updates to separate conversations without lost writes', async () => {
  const { core, latest } = await setup(); await standalone(core); await standalone(core, 'r2', 'SECOND');
  const revision = (await latest()).revision;
  const competing = await Promise.allSettled(['r1','r2'].map(version => core.configureConversationWorldbook(conversation, enabled, revision, standaloneSource(version))));
  expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(competing.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'worldbook_conflict' } });
  const group = { ...conversation, kind: 'group' as const, peerId: '777' };
  const groupRevision = (await core.listConversationRoleBindings('10001')).find(item => item.kind === 'group')!.revision;
  await Promise.all([core.configureConversationWorldbook(conversation, enabled, (await latest()).revision, standaloneSource()),
    core.configureConversationWorldbook(group, enabled, groupRevision, standaloneSource('r2'))]);
  expect((await latest()).worldbookSource).toEqual(standaloneSource());
  expect((await core.listConversationRoleBindings('10001')).find(item => item.kind === 'group')!.worldbookSource).toEqual(standaloneSource('r2'));
});

it('uses independent books in the real agent, pins revisions and retains same-role history while isolating peers', async () => {
  const { core, channels, adapter, latest } = await setup(true); await standalone(core);
  await core.configureConversationWorldbook(conversation, enabled, (await latest()).revision, standaloneSource());
  const old = await core.resolveConversationRoleBinding('10001', conversation);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'ex1', 'orchard'));
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(adapter.calls[0]!.requestText).toContain('EXTERNAL_WORLD');
  expect(adapter.calls[0]!.requestText).not.toContain('PRIVATE_ORCHARD_LORE');
  await standalone(core, 'r2', 'SECOND_WORLD');
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'ex2', 'no keyword'));
  await waitFor(() => channels.get('a')!.sent.length === 2);
  expect(adapter.calls[1]!.requestText).toContain('EXTERNAL_WORLD');
  expect(adapter.calls[1]!.requestText).not.toContain('SECOND_WORLD');
  await core.configureConversationWorldbook(conversation, enabled, (await latest()).revision, standaloneSource('r2'));
  const current = await core.resolveConversationRoleBinding('10001', conversation);
  expect(current!.contextEpoch).toBe(old!.contextEpoch); expect(current!.revision).not.toBe(old!.revision);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'ex3', 'no keyword again'));
  await waitFor(() => channels.get('a')!.sent.length === 3);
  expect(adapter.calls[2]!.requestText).toContain('SECOND_WORLD');
  expect(adapter.calls[2]!.requestText).not.toContain('EXTERNAL_WORLD');
  const group = { ...conversation, kind: 'group' as const, peerId: '777' };
  await core.configureConversationWorldbook(group, enabled, (await core.listConversationRoleBindings('10001')).find(item => item.kind === 'group')!.revision, standaloneSource('r2'));
  channels.get('a')!.emitInbound(textInbound('a', '10001', '777', 'ex4', 'no keyword', 'group'));
  await waitFor(() => channels.get('a')!.sent.length === 4);
  expect(adapter.calls[3]!.requestText).not.toContain('SECOND_WORLD');
  const other = { ...conversation, accountId: '10002' };
  await core.configureConversationWorldbook(other, enabled, (await core.listConversationRoleBindings('10002'))[0]!.revision, standaloneSource('r2'));
  channels.get('b')!.emitInbound(textInbound('b', '10002', '555', 'ex5', 'no keyword'));
  await waitFor(() => channels.get('b')!.sent.length === 1);
  expect(adapter.calls[4]!.requestText).not.toContain('SECOND_WORLD');
});

it.each(['switch', 'rewrite', 'missing', 'invalid'] as const)('rejects queued old replies after independent book %s', async mode => {
  const { core, root, channels, adapter, latest } = await setup(true); await standalone(core); await standalone(core, 'r2', 'SECOND_WORLD');
  await core.configureConversationWorldbook(conversation, enabled, (await latest()).revision, standaloneSource());
  let announce!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = adapter.chat.bind(adapter);
  vi.spyOn(adapter, 'chat').mockImplementationOnce(async (context, request) => { announce(); await gate; return original(context, request); });
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'late1', 'orchard')); await entered;
  const file = path.join(root, 'public/artifacts/worldbook/standalone/r1/manifest.json');
  if (mode === 'switch') await core.configureConversationWorldbook(conversation, enabled, (await latest()).revision, standaloneSource('r2'));
  if (mode === 'missing') await fs.unlink(file);
  if (mode === 'invalid') await fs.writeFile(file, '{broken');
  if (mode === 'rewrite') { const data = JSON.parse(await fs.readFile(file, 'utf8')); data.worldbook.entries[0].content = 'REWRITTEN'; await fs.writeFile(file, JSON.stringify(data)); }
  release();
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'late2', 'orchard'));
  await waitFor(async () => (await core.readMessages('10001', conversation)).some(message => message.messageId === 'late2'));
  if (mode === 'missing' || mode === 'invalid') {
    expect((await core.resolveConversationRoleBinding('10001', conversation))!.worldbookUnavailable).toBe(true);
    await core.configureConversationWorldbook(conversation, { ...enabled, enabled: false }, (await latest()).revision);
    channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'late3', 'continue'));
  }
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(adapter.calls).toHaveLength(2);
  if (mode === 'switch') expect(adapter.calls[1]!.requestText).toContain('SECOND_WORLD');
  if (mode === 'rewrite') expect(adapter.calls[1]!.requestText).toContain('REWRITTEN');
  if (mode === 'missing' || mode === 'invalid') expect(adapter.calls[1]!.requestText).not.toContain('PRIVATE_ORCHARD_LORE');
});

it('updates separate conversations without lost writes and rebind resets the worldbook opt-in', async () => {
  const { core, latest, configure } = await setup();
  const group = { ...conversation, kind: 'group' as const, peerId: '777' };
  await Promise.all([configure(), core.configureConversationWorldbook(group, { ...enabled, budgetChars: 1000 }, (await core.listConversationRoleBindings('10001')).find(item => item.kind === 'group')!.revision)]);
  const bindings = await core.listConversationRoleBindings('10001');
  expect(bindings.find(item => item.kind === 'private')?.worldbook?.enabled).toBe(true);
  expect(bindings.find(item => item.kind === 'group')?.worldbook?.budgetChars).toBe(1000);
  const previous = await latest();
  await core.setConversationRoleBinding(conversation, previous.roleCard);
  expect((await latest()).worldbook).toBeUndefined();
  await core.setConversationRoleBinding(conversation, { source: 'public', id: 'default' });
  await expect(configure()).rejects.toThrow('没有可用世界书');
});

it('forwards opt-in to the actual agent and retains same-role history across worldbook changes', async () => {
  const { core, channels, adapter, configure } = await setup(true);
  await configure();
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'm1', 'orchard'));
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(adapter.calls[0]!.requestText).toContain('PRIVATE_ORCHARD_LORE');
  const before = await core.resolveConversationRoleBinding('10001', conversation);
  await configure(conversation, { ...enabled, budgetChars: 2100 });
  const after = await core.resolveConversationRoleBinding('10001', conversation);
  expect(after!.revision).not.toBe(before!.revision); expect(after!.contextEpoch).toBe(before!.contextEpoch);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'm2', 'no keyword here'));
  await waitFor(() => channels.get('a')!.sent.length === 2);
  expect(adapter.calls[1]!.requestText).toContain('PRIVATE_ORCHARD_LORE');
  expect((await core.previewConversationWorldbook(conversation, 'no keyword here')).selectedIds).toEqual([]);
  const group = { ...conversation, kind: 'group' as const, peerId: '777' };
  await core.configureConversationWorldbook(group, enabled, (await core.listConversationRoleBindings('10001')).find(item => item.kind === 'group')!.revision);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '777', 'g1', 'no keyword here', 'group'));
  await waitFor(() => channels.get('a')!.sent.length === 3);
  expect(adapter.calls[2]!.requestText).not.toContain('PRIVATE_ORCHARD_LORE');
  const other = { ...conversation, accountId: '10002' };
  await core.configureConversationWorldbook(other, enabled, (await core.listConversationRoleBindings('10002'))[0]!.revision);
  channels.get('b')!.emitInbound(textInbound('b', '10002', '555', 'b1', 'no keyword here'));
  await waitFor(() => channels.get('b')!.sent.length === 1);
  expect(adapter.calls[3]!.requestText).not.toContain('PRIVATE_ORCHARD_LORE');
});

it('rejects a late reply after the worldbook configuration changes', async () => {
  const { channels, adapter, configure } = await setup(true);
  await configure();
  let announce!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = adapter.chat.bind(adapter);
  vi.spyOn(adapter, 'chat').mockImplementationOnce(async (context, request) => { announce(); await gate; return original(context, request); });
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'm1', 'orchard'));
  await entered;
  await configure(conversation, { ...enabled, enabled: false });
  release();
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'm2', 'next turn'));
  await waitFor(() => adapter.calls.length === 2 && channels.get('a')!.sent.length === 1);
  expect(adapter.calls[1]!.requestText).not.toContain('PRIVATE_ORCHARD_LORE');
});

it('accounts for exact injected separators, places sections and respects remaining context space', () => {
  const book = parseWorldbook({ version: 1, entries: [
    { id: 'before', keys: ['go'], content: 'BEFORE', position: 'before-role' },
    { id: 'after', keys: ['go'], content: 'AFTER', position: 'after-role' }
  ] });
  const input = { roleCard: 'BASE_ROLE', currentText: 'go', skills: [], history: [], kind: 'private' as const, observations: [], maxHistoryMessages: 5, maxHistoryChars: 3000 };
  const baseline = buildChatContext(input), built = buildChatContext({ ...input, worldbook: book, worldbookOptions: enabled });
  const text = (value: typeof built) => JSON.stringify(value.messages[0]!.content).length;
  const system = built.messages[0]!.content[0]!;
  expect(system.type === 'text' && system.text.indexOf('BEFORE') < system.text.indexOf('BASE_ROLE')).toBe(true);
  expect(system.type === 'text' && system.text.indexOf('AFTER') > system.text.indexOf('BASE_ROLE')).toBe(true);
  const plain = (value: typeof built) => value.messages[0]!.content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 0), 0);
  expect(plain(built) - plain(baseline)).toBe(built.worldbook!.usedChars);
  expect(text(built)).toBeGreaterThan(text(baseline));
  expect(buildChatContext({ ...input, maxHistoryChars: 1, worldbook: book, worldbookOptions: enabled }).worldbook!.usedChars).toBe(0);
  expect(buildChatContext({ ...input, worldbook: book }).worldbook!.usedChars).toBe(0);
});
