import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestCore } from './helpers.js';
import {
  accountPolicy,
  bind,
  fakeMediaProvider,
  fakeProvider,
  fakeToolChatProvider,
  imageSegment,
  inbound,
  textInbound,
  waitFor,
  writePhase1Config
} from './phase1-helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { textMessage } from '../src/routing/message.js';
import { DEFAULT_MEMORY_SETTINGS } from '../src/memory/types.js';
import type { ExtractionTurnCompletion } from '../src/core/extraction-events.js';
import type { AgentHost } from '../src/host/contract.js';
import type { Core } from '../src/core/core.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [], cores: Core[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-extraction-trigger-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const privateConv: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };
const groupConv: ConversationRef = { ...privateConv, kind: 'group', peerId: '777' };
const otherAccount: ConversationRef = { ...privateConv, accountId: '10002' };

interface FixtureOptions {
  host?: AgentHost;
  media?: boolean;
  tool?: 'image';
  failOnSend?: boolean;
}

async function setup(options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-trigger-'));
  roots.push(root);
  const providers = options.tool === 'image'
    ? [
        fakeToolChatProvider('fake-chat', { chatText: '', toolCall: { name: 'generate_image', arguments: { prompt: 'tool cat' } } }),
        fakeMediaProvider('fake-media')
      ]
    : options.media
      ? [fakeProvider('fake-chat', { chatText: 'reply' }), fakeMediaProvider('fake-media', { observation: 'MEDIA_OBSERVATION' })]
      : [fakeProvider('fake-chat', { chatText: 'reply' })];
  const policy = accountPolicy({
    allowedProviders: options.tool || options.media ? ['fake-chat', 'fake-media'] : ['fake-chat'],
    ...(options.tool ? { enabledTools: ['builtin.image.generate'] } : {}),
    bindings: {
      chat: bind('fake-chat', options.tool ? 'tool-model' : 'text-model'),
      ...(options.media ? { 'image.understand': bind('fake-media', 'vision-model') } : {}),
      ...(options.tool ? { 'image.generate': bind('fake-media', 'image-model') } : {})
    }
  });
  await writePhase1Config(root, {
    providers,
    accountPolicies: { '10001': policy, '10002': policy }
  });
  const channels = new Map<string, FakeChannel>();
  const adapter = new FakeProviderAdapter();
  const core = await createTestCore({
    dataRoot: root,
    instances: [{ id: 'a', backend: 'fake', accountId: '10001' }, { id: 'b', backend: 'fake', accountId: '10002' }],
    channelFactory: context => {
      const channel = new FakeChannel(context, {
        selfId: context.spec.accountId,
        ...(options.failOnSend ? { failOnSend: true } : {})
      });
      channels.set(context.instanceId, channel);
      return channel;
    },
    providerAdapters: [adapter],
    ...(options.host ? { host: options.host } : {}),
    limits: { hostTimeoutMs: 5000 },
    logger: silentLogger()
  }, ['10001', '10002']);
  cores.push(core);
  for (const ref of [privateConv, groupConv, otherAccount]) {
    await core.setConversationRoleBinding(ref, { source: 'public', id: 'default', revision: 'r1' });
  }
  await core.start();
  await waitFor(() => core.status().instances.every(status => status.state === 'online'));

  const events: ExtractionTurnCompletion[] = [];
  core.bus.on('memory:extraction-candidate', event => { events.push(event); });
  const enableMemory = async (ref: ConversationRef) => {
    const view = await core.memorySettings(ref);
    return core.saveMemorySettings(ref, {
      settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true },
      expectedScope: view.scopeToken,
      expectedRevision: view.revision
    });
  };
  const emit = (instanceId: string, ref: ConversationRef, messageId: string, text: string) =>
    channels.get(instanceId)!.emitInbound(textInbound(instanceId, ref.accountId, ref.peerId, messageId, text, ref.kind));
  return { root, core, channels, adapter, events, enableMemory, emit };
}

async function seedSecondRole(root: string): Promise<void> {
  const dir = path.join(root, 'public', 'artifacts', 'role-card', 'second', 'r1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'second', kind: 'role-card', revision: 'r1', content: 'Second role'
  }));
}

it('I01: a persisted pure-text reply emits exactly one candidate with stable seqs and the captured guard', async () => {
  const { core, channels, adapter, events, enableMemory, emit } = await setup();
  await enableMemory(privateConv);
  emit('a', privateConv, 'i01', 'hello');
  await waitFor(() => events.length === 1);

  const event = events[0]!;
  expect(event).toMatchObject({
    instanceId: 'a',
    accountId: '10001',
    conversation: privateConv,
    sessionEpoch: expect.any(Number),
    memoryGuard: expect.stringMatching(/^[a-f0-9]{64}$/),
    at: expect.any(Number)
  });
  expect(event.turnId).toMatch(/^turn-/);
  const stored = await core.readMessages('10001', privateConv, { limit: 10 });
  const inbound = stored.find(message => message.seq === event.inboundSeq);
  const outbound = stored.find(message => message.seq === event.outboundSeq);
  expect(inbound).toMatchObject({ direction: 'in', messageId: 'i01' });
  expect(outbound).toMatchObject({ direction: 'out' });
  expect(event.outboundSeq).toBeGreaterThan(event.inboundSeq);
  const binding = await core.resolveConversationRoleBinding('10001', privateConv);
  const memory = await core.resolveConversationMemory('10001', privateConv);
  expect(event.contextEpoch).toBe(binding?.contextEpoch);
  expect(event.memoryGuard).toBe(memory?.memory.guard);
  expect(adapter.calls.filter(call => call.capability === 'chat')).toHaveLength(1);
  expect(channels.get('a')!.sent).toHaveLength(1);
  expect(event).not.toHaveProperty('text');
  expect(event).not.toHaveProperty('content');
  expect(event).not.toHaveProperty('source');
});

it('I01: marking a turn is not completion; the candidate appears only after send and persistence', async () => {
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const host: AgentHost = {
    async onMessage(context) {
      context.markExtractable?.();
      announce();
      await gate;
      return textMessage('custom reply');
    }
  };
  const { events, enableMemory, emit, channels } = await setup({ host });
  await enableMemory(privateConv);
  emit('a', privateConv, 'i01b', 'hello');
  await entered;
  expect(events).toHaveLength(0);
  expect(channels.get('a')!.sent).toHaveLength(0);
  release();
  await waitFor(() => events.length === 1);
  expect(channels.get('a')!.sent).toHaveLength(1);
});

it('I02: manual sends, failed sends, tool confirmations and media observation turns never notify', async () => {
  const manual = await setup();
  await manual.enableMemory(privateConv);
  await manual.core.send('a', privateConv, textMessage('manual'));
  await waitFor(() => manual.channels.get('a')!.sent.length === 1);
  expect(manual.events).toHaveLength(0);

  const failed = await setup({ failOnSend: true });
  await failed.enableMemory(privateConv);
  let hostFailed = 0;
  failed.core.bus.on('instance:error', event => { if (event.code === 'host_failed') hostFailed += 1; });
  failed.emit('a', privateConv, 'i02-fail', 'hello');
  await waitFor(() => hostFailed > 0);
  expect(failed.events).toHaveLength(0);
  expect(failed.channels.get('a')!.sent).toHaveLength(0);

  const tool = await setup({ tool: 'image' });
  tool.emit('a', privateConv, 'i02-tool', 'draw a cat');
  await waitFor(() => tool.channels.get('a')!.sent.length >= 1);
  expect(tool.events).toHaveLength(0);
  expect(tool.channels.get('a')!.sent[0]!.message.segments).toEqual([
    { type: 'text', data: { text: '正在生成图片，完成后会发送。' } }
  ]);

  const media = await setup({ media: true });
  media.channels.get('a')!.emitInbound(inbound('a', '10001', '555', 'i02-media', [
    imageSegment(),
    { type: 'text', data: { text: 'what is this' } }
  ]));
  await waitFor(() => media.channels.get('a')!.sent.length >= 1);
  expect(media.events).toHaveLength(0);
});

it('I02: a guard-suppressed reply sends nothing and emits no candidate', async () => {
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const host: AgentHost = {
    async onMessage(context) {
      context.markExtractable?.();
      announce();
      await gate;
      return textMessage('must not send');
    }
  };
  const { root, core, channels, events, enableMemory, emit } = await setup({ host });
  await seedSecondRole(root);
  await enableMemory(privateConv);
  emit('a', privateConv, 'i02-suppressed', 'hello');
  await entered;
  await core.setConversationRoleBinding(privateConv, { source: 'public', id: 'second', revision: 'r1' });
  const suppressedBefore = core.metrics.get('auto_reply.suppressed', { instance: 'a' });
  release();
  await waitFor(() => core.metrics.get('auto_reply.suppressed', { instance: 'a' }) > suppressedBefore);
  expect(events).toHaveLength(0);
  expect(channels.get('a')!.sent).toHaveLength(0);
});

it('I02: plugin direct sends do not become completion candidates', async () => {
  const host: AgentHost = {
    async onMessage(context) {
      await context.send(textMessage('plugin line'));
    }
  };
  const { channels, events, emit } = await setup({ host });
  emit('a', privateConv, 'i02-plugin', 'hello');
  await waitFor(() => channels.get('a')!.sent.length === 1);
  expect(events).toHaveLength(0);
});

it('I03: account, group and role epochs stay separate even when seq numbers coincide', async () => {
  const { root, core, events, enableMemory, emit } = await setup();
  await seedSecondRole(root);
  await enableMemory(privateConv);
  await enableMemory(groupConv);
  await enableMemory(otherAccount);

  emit('a', privateConv, 'i03-private', 'private');
  emit('a', groupConv, 'i03-group', 'group');
  emit('b', otherAccount, 'i03-other', 'other');
  await waitFor(() => events.length === 3);
  expect(events.map(event => [event.accountId, event.conversation.kind, event.conversation.peerId]).sort()).toEqual([
    ['10001', 'group', '777'],
    ['10001', 'private', '555'],
    ['10002', 'private', '555']
  ]);
  expect(new Set(events.map(event => event.inboundSeq)).size).toBe(1);
  expect(events.every(event => !('text' in event) && !('content' in event) && !('source' in event))).toBe(true);

  const beforeSwitch = events[0]!;
  await core.setConversationRoleBinding(privateConv, { source: 'public', id: 'second', revision: 'r1' });
  emit('a', privateConv, 'i03-private-new-role', 'new role');
  await waitFor(() => events.length === 4);
  const afterSwitch = events[3]!;
  expect(afterSwitch.conversation).toEqual(privateConv);
  expect(afterSwitch.contextEpoch).not.toBe(beforeSwitch.contextEpoch);
});

it('I07: a duplicate inbound message cannot emit a second candidate for the same turn', async () => {
  const { core, adapter, events, enableMemory, emit } = await setup();
  await enableMemory(privateConv);
  emit('a', privateConv, 'i07-dup', 'hello');
  await waitFor(() => events.length === 1);
  const duplicateBefore = core.metrics.get('inbound.duplicate', { instance: 'a' });
  emit('a', privateConv, 'i07-dup', 'hello');
  await waitFor(() => core.metrics.get('inbound.duplicate', { instance: 'a' }) > duplicateBefore);
  expect(events).toHaveLength(1);
  expect(adapter.calls.filter(call => call.capability === 'chat')).toHaveLength(1);
});
