import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestCore } from './helpers.js';
import { accountPolicy, bind, fakeMediaProvider, fakeProvider, imageSegment, inbound, textInbound, waitFor, writePhase1Config } from './phase1-helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { memoryNamespace } from '../src/memory/schema.js';
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from '../src/memory/types.js';
import { TokenBucket } from '../src/work/rate-limiter.js';
import { textMessage } from '../src/routing/message.js';
import type { AgentHost, AgentMessageContext } from '../src/host/contract.js';
import type { Core } from '../src/core/core.js';
import type { ConversationRef } from '../src/routing/identity.js';
import type { Limits } from '../src/core/limits.js';

const roots: string[] = [], cores: Core[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(await fs.realpath(os.tmpdir())) || !path.basename(root).startsWith('nowadays-memory-runtime-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const privateConv: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };
const groupConv: ConversationRef = { ...privateConv, kind: 'group', peerId: '777' };
const otherAccount: ConversationRef = { ...privateConv, accountId: '10002' };

interface FixtureOptions {
  host?: AgentHost;
  limits?: Partial<Limits>;
  media?: boolean;
}

async function setup(options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nowadays-memory-runtime-'));
  roots.push(root);
  await writePhase1Config(root, {
    providers: [
      fakeProvider('fake-chat', { chatText: 'reply' }),
      ...(options.media ? [fakeMediaProvider('fake-media', { observation: 'MEDIA_OBSERVATION' })] : [])
    ],
    accountPolicies: Object.fromEntries(['10001', '10002'].map(id => [id, accountPolicy({
      allowedProviders: options.media ? ['fake-chat', 'fake-media'] : ['fake-chat'],
      bindings: {
        chat: bind('fake-chat', 'text-model'),
        ...(options.media ? { 'image.understand': bind('fake-media', 'vision-model') } : {})
      }
    })]))
  });
  const channels = new Map<string, FakeChannel>();
  const adapter = new FakeProviderAdapter();
  const core = await createTestCore({
    dataRoot: root,
    instances: [{ id: 'a', backend: 'fake', accountId: '10001' }, { id: 'b', backend: 'fake', accountId: '10002' }],
    channelFactory: context => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      channels.set(context.instanceId, channel);
      return channel;
    },
    providerAdapters: [adapter],
    ...(options.host ? { host: options.host } : {}),
    limits: { hostTimeoutMs: 5000, ...options.limits },
    logger: silentLogger()
  }, ['10001', '10002']);
  cores.push(core);
  for (const ref of [privateConv, groupConv, otherAccount]) {
    await core.setConversationRoleBinding(ref, { source: 'public', id: 'default', revision: 'r1' });
  }
  await core.start();
  await waitFor(() => core.status().instances.every(status => status.state === 'online'));

  const memory = async (ref: ConversationRef, overrides: Partial<MemorySettings> = {}) => {
    const view = await core.memorySettings(ref);
    return core.saveMemorySettings(ref, {
      settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true, ...overrides },
      expectedScope: view.scopeToken,
      expectedRevision: view.revision
    });
  };
  const add = async (ref: ConversationRef, content: string, keys: string[], extra: Record<string, unknown> = {}) => {
    const view = await core.memorySettings(ref);
    return core.createMemoryRecord(ref, {
      requestId: `runtime-${Math.random().toString(36).slice(2)}`,
      expectedScope: view.scopeToken,
      expectedRevision: view.revision,
      record: { content, keys, ...extra }
    });
  };
  const stateFile = async (ref: ConversationRef = privateConv) => {
    const binding = await core.resolveConversationRoleBinding(ref.accountId, ref);
    return path.join(root, 'accounts', ref.accountId, 'memory',
      memoryNamespace({ ...ref, contextEpoch: binding!.contextEpoch! }), 'state.json');
  };
  const emit = (instanceId: string, ref: ConversationRef, messageId: string, text: string) =>
    channels.get(instanceId)!.emitInbound(textInbound(instanceId, ref.accountId, ref.peerId, messageId, text, ref.kind));
  return { root, core, channels, adapter, memory, add, stateFile, emit };
}

async function seedSecondRole(root: string): Promise<void> {
  const dir = path.join(root, 'public', 'artifacts', 'role-card', 'second', 'r1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'second', kind: 'role-card', revision: 'r1', content: 'Second role'
  }));
}

async function currentRecord(core: Core, ref: ConversationRef, id: string) {
  return core.getMemoryRecord(ref, id);
}

async function deleteRecord(core: Core, ref: ConversationRef, id: string): Promise<void> {
  const detail = await currentRecord(core, ref, id);
  await core.deleteMemoryRecord(ref, id, {
    expectedScope: detail.scopeToken,
    expectedRevision: detail.revision,
    recordRevision: detail.record.revision
  });
}

async function saveSettings(core: Core, ref: ConversationRef, patch: Partial<MemorySettings>): Promise<void> {
  const view = await core.memorySettings(ref);
  await core.saveMemorySettings(ref, {
    settings: { ...view.settings, ...patch },
    expectedScope: view.scopeToken,
    expectedRevision: view.revision
  });
}

async function clearMemory(core: Core, ref: ConversationRef): Promise<void> {
  const view = await core.memorySettings(ref);
  await core.clearMemoryRecords(ref, { expectedScope: view.scopeToken, expectedRevision: view.revision });
}

function gateNextChat(adapter: FakeProviderAdapter): { entered: Promise<void>; release: () => void } {
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = adapter.chat.bind(adapter);
  vi.spyOn(adapter, 'chat').mockImplementationOnce(async (context, request) => {
    announce();
    await gate;
    return original(context, request);
  });
  return { entered, release };
}

function gateNextAcquire(): { entered: Promise<void>; release: () => void } {
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const original = TokenBucket.prototype.acquire;
  vi.spyOn(TokenBucket.prototype, 'acquire').mockImplementation(async function (this: TokenBucket, signal?: AbortSignal) {
    calls += 1;
    if (calls === 1) {
      announce();
      await gate;
    }
    return original.call(this, signal);
  });
  return { entered, release };
}

it('C01 keeps prompts inside the explicit account, chat kind and role scope', async () => {
  const { root, core, channels, adapter, memory, add, stateFile, emit } = await setup();
  await memory(privateConv);
  const privateRecord = await add(privateConv, 'PRIVATE_555', ['scope-private']);
  await memory(groupConv);
  await add(groupConv, 'GROUP_777', ['scope-group']);
  await memory(otherAccount);
  await add(otherAccount, 'OTHER_10002', ['scope-other']);

  emit('a', privateConv, 'c01-p', 'scope-private');
  await waitFor(() => adapter.calls.length === 1);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(channels.get('a')!.sent).toHaveLength(1);
  expect(adapter.calls[0]!.requestText).toContain('PRIVATE_555');
  expect(adapter.calls[0]!.requestText).not.toContain('GROUP_777');
  expect(adapter.calls[0]!.requestText).not.toContain('OTHER_10002');

  emit('a', groupConv, 'c01-g', 'scope-group');
  await waitFor(() => adapter.calls.length === 2);
  await waitFor(() => channels.get('a')!.sent.length === 2);
  expect(channels.get('a')!.sent).toHaveLength(2);
  expect(adapter.calls[1]!.requestText).toContain('GROUP_777');
  expect(adapter.calls[1]!.requestText).not.toContain('PRIVATE_555');

  emit('b', otherAccount, 'c01-o', 'scope-other');
  await waitFor(() => adapter.calls.length === 3);
  await waitFor(() => channels.get('b')!.sent.length === 1);
  expect(channels.get('b')!.sent).toHaveLength(1);
  expect(adapter.calls[2]!.requestText).toContain('OTHER_10002');
  expect(adapter.calls[2]!.requestText).not.toContain('PRIVATE_555');

  await seedSecondRole(root);
  const oldFile = await stateFile();
  const oldState = await fs.readFile(oldFile, 'utf8');
  await core.setConversationRoleBinding(privateConv, { source: 'public', id: 'second', revision: 'r1' });
  await memory(privateConv);
  await add(privateConv, 'SECOND_ROLE_FACT', ['scope-second']);
  emit('a', privateConv, 'c01-role', 'scope-second');
  await waitFor(() => adapter.calls.length === 4);
  await waitFor(() => channels.get('a')!.sent.length === 3);
  expect(channels.get('a')!.sent).toHaveLength(3);
  expect(adapter.calls[3]!.requestText).toContain('SECOND_ROLE_FACT');
  expect(adapter.calls[3]!.requestText).not.toContain('PRIVATE_555');
  expect(await fs.readFile(oldFile, 'utf8')).toBe(oldState);
  expect(privateRecord.record.content).toBe('PRIVATE_555');
});

it('C03 rejects an old-role turn when the role changes during a slow memory read', async () => {
  const { root, core, channels, adapter, memory, add, stateFile, emit } = await setup();
  await seedSecondRole(root);
  await memory(privateConv);
  await add(privateConv, 'OLD_CAPTURE', ['capture-old']);
  const oldBinding = (await core.resolveConversationRoleBinding('10001', privateConv))!;
  const oldFile = await stateFile();

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation((async (file: unknown, flags: unknown, mode: unknown) => {
    if (String(file) === oldFile) {
      blocked = true;
      await gate;
    }
    return open(file as string, flags as 'r', mode as number | undefined);
  }) as typeof fs.open);

  const suppressedBefore = core.metrics.get('auto_reply.suppressed', { instance: 'a' });
  emit('a', privateConv, 'c03-old', 'capture-old');
  await waitFor(() => blocked);
  await core.setConversationRoleBinding(privateConv, { source: 'public', id: 'second', revision: 'r1' });
  release();
  vi.restoreAllMocks();
  await waitFor(async () => (await core.readMessages('10001', privateConv)).some(message => message.messageId === 'c03-old'));
  await waitFor(() => core.metrics.get('auto_reply.suppressed', { instance: 'a' }) > suppressedBefore);
  expect(adapter.calls).toHaveLength(0);
  expect(channels.get('a')!.sent).toHaveLength(0);
  const stored = (await core.readMessages('10001', privateConv)).find(message => message.messageId === 'c03-old')!;
  expect(stored.contextEpoch).toBe(oldBinding.contextEpoch);

  await memory(privateConv);
  await add(privateConv, 'NEW_CAPTURE', ['capture-new']);
  emit('a', privateConv, 'c03-new', 'capture-new');
  await waitFor(() => adapter.calls.length === 1);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(adapter.calls[0]!.requestText).toContain('NEW_CAPTURE');
  expect(adapter.calls[0]!.requestText).not.toContain('OLD_CAPTURE');
});

it('C04 injects worldbook then memory into the real agent and enforces the saved memory budget', async () => {
  const { core, channels, adapter, memory, add, emit } = await setup();
  await core.saveWorldbook({ requestId: 'c04-book', manifest: {
    id: 'c04-book', kind: 'worldbook', revision: 'r1',
    worldbook: { version: 1, entries: [{ id: 'w', keys: ['worldkey'], content: 'WORLD_SECTION' }] }
  } });
  const binding = (await core.listConversationRoleBindings('10001')).find(item => item.kind === 'private' && item.peerId === '555')!;
  await core.configureConversationWorldbook(privateConv, { enabled: true, scanDepth: 4, budgetChars: 1000 }, binding.revision,
    { kind: 'artifact', ref: { source: 'public', id: 'c04-book', revision: 'r1' } });
  await memory(privateConv, { budgetChars: 40 });
  await add(privateConv, `MEMORY_LONG_${'m'.repeat(100)}`, ['worldkey']);

  emit('a', privateConv, 'c04-small', 'worldkey');
  await waitFor(() => adapter.calls.length === 1);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(adapter.calls[0]!.requestText).toContain('WORLD_SECTION');
  expect(adapter.calls[0]!.requestText).not.toContain('MEMORY_LONG_');

  await saveSettings(core, privateConv, { budgetChars: 300 });
  emit('a', privateConv, 'c04-large', 'worldkey');
  await waitFor(() => adapter.calls.length === 2);
  await waitFor(() => channels.get('a')!.sent.length === 2);
  const text = adapter.calls[1]!.requestText!;
  expect(text).toContain('WORLD_SECTION');
  expect(text).toContain('MEMORY_LONG_');
  expect(text.indexOf('WORLD_SECTION')).toBeLessThan(text.indexOf('## 长期记忆（会话数据）'));
});

it('C02 keeps the memory namespace and same-role history across a worldbook change and uses edited memory next turn', async () => {
  const { core, channels, adapter, memory, add, stateFile, emit } = await setup();
  await memory(privateConv);
  const created = await add(privateConv, 'C02_BEFORE', ['c02']);
  const before = await core.memorySettings(privateConv);
  const file = await stateFile();
  const beforeBytes = await fs.readFile(file, 'utf8');

  emit('a', privateConv, 'c02-1', 'c02');
  await waitFor(() => adapter.calls.length === 1);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(adapter.calls[0]!.requestText).toContain('C02_BEFORE');

  await core.saveWorldbook({ requestId: 'c02-book', manifest: {
    id: 'c02-book', kind: 'worldbook', revision: 'r1',
    worldbook: { version: 1, entries: [{ id: 'w', keys: ['c02book'], content: 'C02_WORLD' }] }
  } });
  const binding = (await core.listConversationRoleBindings('10001')).find(item => item.kind === 'private' && item.peerId === '555')!;
  await core.configureConversationWorldbook(privateConv, { enabled: true, scanDepth: 4, budgetChars: 500 }, binding.revision,
    { kind: 'artifact', ref: { source: 'public', id: 'c02-book', revision: 'r1' } });
  const afterConfig = await core.memorySettings(privateConv);
  expect(afterConfig.scopeToken).toBe(before.scopeToken);
  expect(afterConfig.revision).toBe(before.revision);
  expect(await fs.readFile(file, 'utf8')).toBe(beforeBytes);

  emit('a', privateConv, 'c02-2', 'c02');
  await waitFor(() => adapter.calls.length === 2);
  await waitFor(() => channels.get('a')!.sent.length === 2);
  expect(adapter.calls[1]!.requestText).toContain('C02_BEFORE');
  expect(adapter.calls[1]!.requestText).toContain('c02');
  expect(adapter.calls[1]!.requestText).not.toContain('C02_WORLD');

  const detail = await currentRecord(core, privateConv, created.record.id);
  await core.updateMemoryRecord(privateConv, created.record.id, {
    expectedScope: detail.scopeToken,
    expectedRevision: detail.revision,
    recordRevision: detail.record.revision,
    content: 'C02_AFTER',
    keys: ['c02']
  });
  emit('a', privateConv, 'c02-3', 'c02');
  await waitFor(() => adapter.calls.length === 3);
  await waitFor(() => channels.get('a')!.sent.length === 3);
  expect(adapter.calls[2]!.requestText).toContain('C02_AFTER');
  expect(adapter.calls[2]!.requestText).not.toContain('C02_BEFORE');
  expect(adapter.calls[2]!.requestText).toContain('reply');
});

it('C04c places a real media observation, worldbook and memory in one agent turn', async () => {
  const { core, channels, adapter, memory, add } = await setup({ media: true });
  await core.saveWorldbook({ requestId: 'c04-media-book', manifest: {
    id: 'c04-media-book', kind: 'worldbook', revision: 'r1',
    worldbook: { version: 1, entries: [{ id: 'w', keys: ['mediakey'], content: 'MEDIA_WORLD' }] }
  } });
  const binding = (await core.listConversationRoleBindings('10001')).find(item => item.kind === 'private' && item.peerId === '555')!;
  await core.configureConversationWorldbook(privateConv, { enabled: true, scanDepth: 4, budgetChars: 500 }, binding.revision,
    { kind: 'artifact', ref: { source: 'public', id: 'c04-media-book', revision: 'r1' } });
  await memory(privateConv, { budgetChars: 300 });
  await add(privateConv, 'MEDIA_MEMORY', ['mediakey']);

  channels.get('a')!.emitInbound(inbound('a', '10001', '555', 'c04-media', [
    imageSegment(),
    { type: 'text', data: { text: 'mediakey' } }
  ]));
  await waitFor(() => adapter.calls.some(call => call.capability === 'chat'));
  await waitFor(() => channels.get('a')!.sent.length === 1);
  const chat = adapter.calls.find(call => call.capability === 'chat')!;
  const text = chat.requestText!;
  expect(text).toContain('MEDIA_OBSERVATION');
  expect(text).toContain('MEDIA_WORLD');
  expect(text).toContain('MEDIA_MEMORY');
  expect(text.indexOf('MEDIA_WORLD')).toBeLessThan(text.indexOf('## 长期记忆（会话数据）'));
  expect(text.indexOf('## 长期记忆（会话数据）')).toBeLessThan(text.indexOf('MEDIA_OBSERVATION'));
});

it('C07 fails closed for a corrupt scope while inbound, manual send and another scope still work', async () => {
  const { core, channels, adapter, memory, add, stateFile, emit } = await setup();
  await memory(privateConv);
  await add(privateConv, 'CORRUPT_SCOPE', ['corrupt']);
  await memory(groupConv);
  await add(groupConv, 'GROUP_HEALTHY', ['corrupt']);
  await fs.writeFile(await stateFile(), '{broken');

  const suppressedBefore = core.metrics.get('auto_reply.suppressed', { instance: 'a' });
  emit('a', privateConv, 'c07-bad', 'corrupt');
  await waitFor(async () => (await core.readMessages('10001', privateConv)).some(message => message.messageId === 'c07-bad'));
  await waitFor(() => core.metrics.get('auto_reply.suppressed', { instance: 'a' }) > suppressedBefore);
  expect(adapter.calls).toHaveLength(0);
  expect(channels.get('a')!.sent).toHaveLength(0);

  await core.send('a', privateConv, textMessage('manual unaffected'));
  await waitFor(() => channels.get('a')!.sent.length === 1);

  emit('a', groupConv, 'c07-group', 'corrupt');
  await waitFor(() => adapter.calls.length === 1);
  await waitFor(() => channels.get('a')!.sent.length === 2);
  expect(adapter.calls[0]!.requestText).toContain('GROUP_HEALTHY');
  expect(adapter.calls[0]!.requestText).not.toContain('CORRUPT_SCOPE');
});

it('C09 detects an external same-revision rewrite before sending and uses the new text next turn', async () => {
  const { core, channels, adapter, memory, add, stateFile, emit } = await setup();
  await memory(privateConv);
  await add(privateConv, 'ORIGINAL_FACT', ['rewrite']);
  const file = await stateFile();
  const gate = gateNextChat(adapter);

  emit('a', privateConv, 'c09-old', 'rewrite');
  await gate.entered;
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.records[0].content = 'EDITED_EXTERNAL';
  await fs.writeFile(file, JSON.stringify(state));
  gate.release();

  emit('a', privateConv, 'c09-new', 'rewrite');
  await waitFor(() => adapter.calls.length === 2);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(channels.get('a')!.sent).toHaveLength(1);
  expect(adapter.calls[1]!.requestText).toContain('EDITED_EXTERNAL');
  expect(adapter.calls[1]!.requestText).not.toContain('ORIGINAL_FACT');
});

it.each(['delete', 'disable'] as const)('G01/G02 rejects a reply generated before memory %s', async action => {
  const { core, channels, adapter, memory, add, emit } = await setup();
  await memory(privateConv);
  const created = await add(privateConv, 'ACTION_FACT', ['action']);
  const gate = gateNextChat(adapter);

  emit('a', privateConv, `gen-${action}`, 'action');
  await gate.entered;
  if (action === 'delete') await deleteRecord(core, privateConv, created.record.id);
  else await saveSettings(core, privateConv, { enabled: false });
  gate.release();

  emit('a', privateConv, `next-${action}`, 'action');
  await waitFor(() => adapter.calls.length === 2);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(channels.get('a')!.sent).toHaveLength(1);
  expect(adapter.calls[1]!.requestText).not.toContain('ACTION_FACT');
});

it('G03 rejects a reply generated before the fact body was edited and uses the edit next turn', async () => {
  const { core, channels, adapter, memory, add, emit } = await setup();
  await memory(privateConv);
  const created = await add(privateConv, 'BEFORE_EDIT', ['edit']);
  const gate = gateNextChat(adapter);

  emit('a', privateConv, 'g03-old', 'edit');
  await gate.entered;
  const detail = await currentRecord(core, privateConv, created.record.id);
  await core.updateMemoryRecord(privateConv, created.record.id, {
    expectedScope: detail.scopeToken,
    expectedRevision: detail.revision,
    recordRevision: detail.record.revision,
    content: 'AFTER_EDIT',
    keys: ['edit']
  });
  gate.release();

  emit('a', privateConv, 'g03-new', 'edit');
  await waitFor(() => adapter.calls.length === 2);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(channels.get('a')!.sent).toHaveLength(1);
  expect(adapter.calls[1]!.requestText).toContain('AFTER_EDIT');
  expect(adapter.calls[1]!.requestText).not.toContain('BEFORE_EDIT');
});

it.each(['delete', 'disable', 'clear', 'budget'] as const)('rejects a reply waiting in the rate queue after memory %s', async action => {
  const { core, channels, adapter, memory, add, emit } = await setup();
  await memory(privateConv);
  const created = await add(privateConv, 'QUEUED_FACT', ['queued']);

  emit('a', privateConv, 'q1', 'queued');
  await waitFor(() => adapter.calls.length === 1);
  await waitFor(() => channels.get('a')!.sent.length === 1);

  const rate = gateNextAcquire();
  const failedBefore = core.metrics.get('host.failed', { instance: 'a' });
  emit('a', privateConv, 'q2', 'queued');
  await waitFor(() => adapter.calls.length === 2);
  await rate.entered;

  if (action === 'delete') await deleteRecord(core, privateConv, created.record.id);
  else if (action === 'disable') await saveSettings(core, privateConv, { enabled: false });
  else if (action === 'clear') await clearMemory(core, privateConv);
  else await saveSettings(core, privateConv, { budgetChars: 0 });

  rate.release();
  await waitFor(() => core.metrics.get('host.failed', { instance: 'a' }) > failedBefore);
  expect(channels.get('a')!.sent).toHaveLength(1);

  emit('a', privateConv, 'q3', 'queued');
  await waitFor(() => adapter.calls.length === 3);
  await waitFor(() => channels.get('a')!.sent.length === 2);
  expect(adapter.calls[2]!.requestText).not.toContain('QUEUED_FACT');
});

it('G04 rejects a role change during generation, keeps manual send, and suppresses an unbound conversation', async () => {
  const { root, core, channels, adapter, memory, add, emit } = await setup();
  await seedSecondRole(root);
  await memory(privateConv);
  await add(privateConv, 'OLD_ROLE_FACT', ['role']);
  const gate = gateNextChat(adapter);

  emit('a', privateConv, 'g04-old', 'role');
  await gate.entered;
  await core.setConversationRoleBinding(privateConv, { source: 'public', id: 'second', revision: 'r1' });
  gate.release();

  emit('a', privateConv, 'g04-new', 'role');
  await waitFor(() => adapter.calls.length === 2);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(channels.get('a')!.sent).toHaveLength(1);
  expect(adapter.calls[1]!.requestText).not.toContain('OLD_ROLE_FACT');

  await core.send('a', privateConv, textMessage('manual after rebind'));
  await waitFor(() => channels.get('a')!.sent.length === 2);

  await core.setConversationRoleBinding(privateConv, null);
  const beforeUnbound = core.metrics.get('auto_reply.suppressed', { instance: 'a' });
  emit('a', privateConv, 'g04-unbound', 'role');
  await waitFor(async () => (await core.readMessages('10001', privateConv)).some(message => message.messageId === 'g04-unbound'));
  await waitFor(() => core.metrics.get('auto_reply.suppressed', { instance: 'a' }) > beforeUnbound);
  expect(adapter.calls).toHaveLength(2);
  await core.send('a', privateConv, textMessage('manual while unbound'));
  await waitFor(() => channels.get('a')!.sent.length === 3);
});

it('G05 refuses delayed delivery that captured an older memory guard', async () => {
  const contexts: AgentMessageContext[] = [];
  const host: AgentHost = {
    onMessage: context => { contexts.push(context); }
  };
  const { core, channels, memory, add, emit } = await setup({ host });
  await memory(privateConv);
  const created = await add(privateConv, 'DELIVER_FACT', ['deliver']);

  emit('a', privateConv, 'g05-capture', 'deliver');
  await waitFor(() => contexts.length === 1);
  const first = contexts[0]!;
  expect(first.memory?.state).toBe('ready');
  expect(first.memory?.records[0]?.content).toBe('DELIVER_FACT');
  await first.deliver(textMessage('first delivery'));
  await waitFor(() => channels.get('a')!.sent.length === 1);

  const detail = await currentRecord(core, privateConv, created.record.id);
  await core.updateMemoryRecord(privateConv, created.record.id, {
    expectedScope: detail.scopeToken,
    expectedRevision: detail.revision,
    recordRevision: detail.record.revision,
    content: 'DELIVER_EDITED'
  });
  await expect(first.deliver(textMessage('stale delivery'))).rejects.toMatchObject({ code: 'auto_reply_paused' });
  expect(channels.get('a')!.sent).toHaveLength(1);
  expect(await first.send(textMessage('stale send'))).toMatchObject({ duplicate: true });

  emit('a', privateConv, 'g05-next', 'deliver');
  await waitFor(() => contexts.length === 2);
  await contexts[1]!.deliver(textMessage('fresh delivery'));
  await waitFor(() => channels.get('a')!.sent.length === 2);
  expect(contexts[1]!.memory?.records[0]?.content).toBe('DELIVER_EDITED');
});

it('does not start MEM03 extraction even when autoExtract is enabled', async () => {
  const { core, channels, adapter, memory, add, emit } = await setup();
  await memory(privateConv, { autoExtract: true });
  const created = await add(privateConv, 'MANUAL_FACT', ['manual']);
  const before = await core.memorySettings(privateConv);

  emit('a', privateConv, 'no-extract', 'manual');
  await waitFor(() => adapter.calls.length === 1);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(adapter.calls.every(call => call.capability === 'chat')).toBe(true);
  const after = await core.memorySettings(privateConv);
  expect(after).toMatchObject({ revision: before.revision, generation: before.generation, recordCount: 1 });
  expect((await core.getMemoryRecord(privateConv, created.record.id)).record.content).toBe('MANUAL_FACT');
});

it('G07 keeps an in-flight reply when another scope changes its memory', async () => {  const { core, channels, adapter, memory, add, emit } = await setup();
  await memory(privateConv);
  await add(privateConv, 'PRIVATE_INFLIGHT', ['inflight']);
  await memory(groupConv);
  const gate = gateNextChat(adapter);
  const suppressedBefore = core.metrics.get('auto_reply.suppressed', { instance: 'a' });

  emit('a', privateConv, 'g07-main', 'inflight');
  await gate.entered;
  await add(groupConv, 'GROUP_CHANGED', ['inflight']);
  await saveSettings(core, groupConv, { budgetChars: 200 });
  gate.release();
  await waitFor(() => adapter.calls.length === 1);
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(core.metrics.get('auto_reply.suppressed', { instance: 'a' })).toBe(suppressedBefore);
  expect(adapter.calls[0]!.requestText).toContain('PRIVATE_INFLIGHT');
  expect(adapter.calls[0]!.requestText).not.toContain('GROUP_CHANGED');
});
