import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestCore } from './helpers.js';
import { accountPolicy, bind, fakeMediaProvider, fakeToolChatProvider, textInbound, waitFor, writePhase1Config } from './phase1-helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { MediaJobService } from '../src/jobs/service.js';
import type { JobSubmitInput } from '../src/jobs/types.js';
import { DEFAULT_MEMORY_SETTINGS } from '../src/memory/types.js';
import type { Core } from '../src/core/core.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [], cores: Core[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-memory-tools-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const privateConv: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };
const groupConv: ConversationRef = { ...privateConv, kind: 'group', peerId: '777' };

type ToolKind = 'image' | 'audio';

async function setupTool(kind: ToolKind) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-memory-tools-'));
  roots.push(root);
  const toolCall = kind === 'image'
    ? { name: 'generate_image', arguments: { prompt: 'tool cat' } }
    : { name: 'generate_speech', arguments: { text: 'tool voice' } };
  await writePhase1Config(root, {
    providers: [
      fakeToolChatProvider('fake-chat', { chatText: '', toolCall }),
      fakeMediaProvider('fake-media')
    ],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['fake-chat', 'fake-media'],
        enabledTools: [kind === 'image' ? 'builtin.image.generate' : 'builtin.audio.generate'],
        bindings: {
          chat: bind('fake-chat', 'tool-model'),
          ...(kind === 'image'
            ? { 'image.generate': bind('fake-media', 'image-model') }
            : { 'audio.generate': bind('fake-media', 'audio-model') })
        }
      })
    }
  });
  const channels = new Map<string, FakeChannel>();
  const adapter = new FakeProviderAdapter();
  const core = await createTestCore({
    dataRoot: root,
    instances: [{ id: 'a', backend: 'fake', accountId: '10001' }],
    channelFactory: context => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      channels.set(context.instanceId, channel);
      return channel;
    },
    providerAdapters: [adapter],
    limits: { hostTimeoutMs: 5000 },
    logger: silentLogger()
  }, ['10001']);
  cores.push(core);
  for (const ref of [privateConv, groupConv]) {
    await core.setConversationRoleBinding(ref, { source: 'public', id: 'default', revision: 'r1' });
  }
  await core.start();
  await waitFor(() => core.status().instances.every(status => status.state === 'online'));

  const enableMemory = async (ref: ConversationRef) => {
    const view = await core.memorySettings(ref);
    return core.saveMemorySettings(ref, {
      settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true },
      expectedScope: view.scopeToken,
      expectedRevision: view.revision
    });
  };
  const addMemory = async (ref: ConversationRef, content: string, keys: string[], extra: Record<string, unknown> = {}) => {
    const view = await core.memorySettings(ref);
    return core.createMemoryRecord(ref, {
      requestId: `tool-${Math.random().toString(36).slice(2)}`,
      expectedScope: view.scopeToken,
      expectedRevision: view.revision,
      record: { content, keys, ...extra }
    });
  };

  const seedView = await enableMemory(privateConv);
  const seedPayload = { content: 'TOOL_MEMORY', keys: ['draw'], pinned: true };
  const seed = await core.createMemoryRecord(privateConv, {
    requestId: 'tool-memory-seed',
    expectedScope: seedView.scopeToken,
    expectedRevision: seedView.revision,
    record: seedPayload
  });
  const deleteSeed = async () => {
    const detail = await core.getMemoryRecord(privateConv, seed.record.id);
    await core.deleteMemoryRecord(privateConv, seed.record.id, {
      expectedScope: detail.scopeToken,
      expectedRevision: detail.revision,
      recordRevision: detail.record.revision
    });
  };
  const disableMemory = async () => {
    const view = await core.memorySettings(privateConv);
    await core.saveMemorySettings(privateConv, {
      settings: { ...view.settings, enabled: false },
      expectedScope: view.scopeToken,
      expectedRevision: view.revision
    });
  };
  return {
    core, channels, adapter, seed, seedRequest: {
      requestId: 'tool-memory-seed',
      expectedScope: seedView.scopeToken,
      expectedRevision: seedView.revision,
      record: seedPayload
    },
    enableMemory, addMemory, deleteSeed, disableMemory
  };
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

function gateNextGeneration(adapter: FakeProviderAdapter, kind: ToolKind): { entered: Promise<void>; release: () => void } {
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (kind === 'image') {
    const original = adapter.imageGenerate.bind(adapter);
    vi.spyOn(adapter, 'imageGenerate').mockImplementationOnce(async (context, request) => {
      announce();
      await gate;
      return original(context, request);
    });
  } else {
    const original = adapter.audioGenerate.bind(adapter);
    vi.spyOn(adapter, 'audioGenerate').mockImplementationOnce(async (context, request) => {
      announce();
      await gate;
      return original(context, request);
    });
  }
  return { entered, release };
}

function gateNextSubmit(): { entered: Promise<void>; release: () => void } {
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const original = MediaJobService.prototype.submit;
  vi.spyOn(MediaJobService.prototype, 'submit').mockImplementation(async function (this: MediaJobService, input: JobSubmitInput) {
    calls += 1;
    if (calls === 1) {
      announce();
      await gate;
    }
    return original.call(this, input);
  });
  return { entered, release };
}

it('does not execute a stale image tool call after the memory snapshot changes during chat', async () => {
  const { core, channels, adapter, deleteSeed } = await setupTool('image');
  const gate = gateNextChat(adapter);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'stale-image', 'draw'));
  await gate.entered;
  await deleteSeed();
  gate.release();

  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'fresh-image', 'draw again'));
  await waitFor(() => channels.get('a')!.sent.length === 2, 6_000);
  await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent');
  expect(adapter.calls.filter(call => call.capability === 'image.generate')).toHaveLength(1);
  expect(await core.listJobs('10001')).toHaveLength(1);
  expect(channels.get('a')!.sent[1]!.message.segments[0]?.type).toBe('image');
});

it('does not execute a stale speech tool call after memory is disabled during chat', async () => {
  const { core, channels, adapter, disableMemory } = await setupTool('audio');
  const gate = gateNextChat(adapter);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'stale-audio', 'speak'));
  await gate.entered;
  await disableMemory();
  gate.release();

  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'fresh-audio', 'speak again'));
  await waitFor(() => channels.get('a')!.sent.length === 2, 6_000);
  await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent');
  expect(adapter.calls.filter(call => call.capability === 'audio.generate')).toHaveLength(1);
  expect(await core.listJobs('10001')).toHaveLength(1);
  expect(channels.get('a')!.sent[1]!.message.segments[0]?.type).toBe('record');
  expect(await core.listMedia('10001')).toMatchObject([{ kind: 'audio' }]);
});

it('rejects a queued media job before its provider call when memory changes', async () => {
  const { core, channels, adapter, deleteSeed } = await setupTool('image');
  const submit = gateNextSubmit();
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'queued-job', 'draw'));
  await submit.entered;
  await deleteSeed();
  submit.release();

  await waitFor(async () => (await core.listJobs('10001'))[0]?.state === 'failed');
  expect(adapter.calls.filter(call => call.capability === 'image.generate')).toHaveLength(0);
  expect(channels.get('a')!.sent).toHaveLength(0);
  expect(await core.listJobs('10001')).toMatchObject([{ state: 'failed', delivery: 'skipped' }]);
});

it('does not deliver a provider result that started before memory changed and keeps the next turn working', async () => {
  const { core, channels, adapter, deleteSeed } = await setupTool('image');
  const gate = gateNextGeneration(adapter, 'image');
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'started-provider', 'draw'));
  await gate.entered;
  await waitFor(() => channels.get('a')!.sent.length === 1);
  await deleteSeed();
  gate.release();

  await waitFor(async () => (await core.listJobs('10001'))[0]?.state === 'failed');
  expect(channels.get('a')!.sent).toHaveLength(1);
  expect(adapter.calls.filter(call => call.capability === 'image.generate')).toHaveLength(1);
  expect(await core.listMedia('10001')).toHaveLength(0);

  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'after-change', 'draw again'));
  await waitFor(() => channels.get('a')!.sent.length === 3, 6_000);
  await waitFor(async () => (await core.listJobs('10001')).length === 2
    && (await core.listJobs('10001')).some(job => job.state === 'succeeded' && job.delivery === 'sent'));
  const jobs = await core.listJobs('10001');
  expect(jobs.filter(job => job.state === 'failed')).toHaveLength(1);
  expect(jobs.filter(job => job.state === 'succeeded')).toHaveLength(1);
  expect(adapter.calls.filter(call => call.capability === 'image.generate')).toHaveLength(2);
  expect(channels.get('a')!.sent[2]!.message.segments[0]?.type).toBe('image');
});

it('keeps the current tool turn for other-scope changes and idempotent memory retries', async () => {
  const { core, channels, adapter, seedRequest, enableMemory, addMemory } = await setupTool('image');
  const before = await core.memorySettings(privateConv);
  const gate = gateNextChat(adapter);
  channels.get('a')!.emitInbound(textInbound('a', '10001', '555', 'unaffected-tool', 'draw'));
  await gate.entered;

  await enableMemory(groupConv);
  await addMemory(groupConv, 'GROUP_ONLY', ['group']);
  const replay = await core.createMemoryRecord(privateConv, seedRequest);
  expect(replay.created).toBe(false);
  expect(replay.record.id).toBeTruthy();

  gate.release();
  await waitFor(() => channels.get('a')!.sent.length === 2, 6_000);
  await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent');
  expect(adapter.calls.filter(call => call.capability === 'image.generate')).toHaveLength(1);
  const after = await core.memorySettings(privateConv);
  expect(after).toMatchObject({ revision: before.revision, generation: before.generation });
});
