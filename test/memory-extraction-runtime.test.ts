import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestCore } from './helpers.js';
import {
  accountPolicy,
  bind,
  fakeProvider,
  textInbound,
  waitFor,
  writePhase1Config
} from './phase1-helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { textMessage } from '../src/routing/message.js';
import { DEFAULT_MEMORY_SETTINGS } from '../src/memory/types.js';
import type { ChatRequest, ChatResponse, ProviderCallContext } from '../src/providers/contract.js';
import type { AgentHost } from '../src/host/contract.js';
import type { Core } from '../src/core/core.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [], cores: Core[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-extraction-runtime-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const conversation: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };

function isExtractionRequest(request: ChatRequest): boolean {
  return request.messages.some(message =>
    message.role === 'system'
    && message.content.some(part => part.type === 'text' && part.text.includes('长期事实提取器'))
  );
}

function messagePayload(request: ChatRequest): Array<{ seq: number; text: string }> {
  const part = request.messages[1]!.content.find(item => item.type === 'text');
  const raw = part && part.type === 'text' ? part.text : '';
  return (JSON.parse(raw.slice(raw.indexOf('{'))) as { messages: Array<{ seq: number; text: string }> }).messages;
}

function messageSeqs(request: ChatRequest): number[] {
  return messagePayload(request).map(message => message.seq);
}

class ExtractionAdapter extends FakeProviderAdapter {
  readonly extractionRequests: ChatRequest[] = [];
  responder: (request: ChatRequest) => Promise<ChatResponse> = async () => ({
    text: JSON.stringify({ facts: [] })
  });

  override async chat(context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    if (!isExtractionRequest(request)) return super.chat(context, request);
    this.extractionRequests.push(request);
    return this.responder(request);
  }
}

interface FixtureOptions {
  host?: AgentHost;
  responder?: (request: ChatRequest) => Promise<ChatResponse>;
}

async function setup(options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-runtime-'));
  roots.push(root);
  let clock = 1_700_000_000_000;
  await writePhase1Config(root, {
    providers: [fakeProvider('fake-chat', { chatText: 'AGENT_REPLY' })],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['fake-chat'],
        bindings: { chat: bind('fake-chat', 'text-model') }
      })
    }
  });
  const channels = new Map<string, FakeChannel>();
  const adapter = new ExtractionAdapter();
  if (options.responder) adapter.responder = options.responder;
  const core = await createTestCore({
    dataRoot: root,
    instances: [{ id: 'a', backend: 'fake', accountId: '10001' }],
    channelFactory: context => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      channels.set(context.instanceId, channel);
      return channel;
    },
    providerAdapters: [adapter],
    ...(options.host ? { host: options.host } : {}),
    limits: { hostTimeoutMs: 5_000 },
    now: () => clock,
    logger: silentLogger()
  }, ['10001']);
  cores.push(core);
  await core.setConversationRoleBinding(conversation, { source: 'public', id: 'default', revision: 'r1' });
  await core.start();
  await waitFor(() => core.status().instances.every(status => status.state === 'online'));

  const settings = await core.memorySettings(conversation);
  await core.saveMemorySettings(conversation, {
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true },
    expectedScope: settings.scopeToken,
    expectedRevision: settings.revision
  });
  const status = await core.memoryExtraction(conversation);
  await core.activateMemoryExtraction(conversation, {
    expectedScope: status.scopeToken,
    expectedRevision: status.revision,
    startFrom: 'now',
    confirmModelUse: true
  });
  const active = await core.memoryExtraction(conversation);
  expect(active.extraction.effectiveStatus).toBe('active');

  const channel = channels.get('a')!;
  let turns = 0;
  const emit = (text: string): void => {
    turns += 1;
    channel.emitInbound(textInbound('a', '10001', '555', `m-${turns}`, text));
  };
  const turn = async (text: string): Promise<void> => {
    const before = channel.sent.length;
    emit(text);
    await waitFor(() => channel.sent.length === before + 1);
  };
  return {
    root,
    core,
    adapter,
    channel,
    emit,
    turn,
    advance: (ms: number) => { clock += ms; }
  };
}

async function seedSecondRole(root: string): Promise<void> {
  const dir = path.join(root, 'public', 'artifacts', 'role-card', 'second', 'r1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'second', kind: 'role-card', revision: 'r1', content: 'Second role'
  }));
}

it('O09: an extraction commit waits behind the active text turn and does not corrupt its send', async () => {
  let seventhEntered!: () => void;
  const enteredSeventh = new Promise<void>(resolve => { seventhEntered = resolve; });
  let releaseSeventh!: () => void;
  const seventhGate = new Promise<void>(resolve => { releaseSeventh = resolve; });
  let hold = false;
  const host: AgentHost = {
    async onMessage(context) {
      context.markExtractable?.();
      if (hold) {
        seventhEntered();
        await seventhGate;
      }
      return textMessage('HOST_REPLY');
    }
  };
  let extractionEntered!: () => void;
  const enteredExtraction = new Promise<void>(resolve => { extractionEntered = resolve; });
  let extractionReturned!: () => void;
  const returnedExtraction = new Promise<void>(resolve => { extractionReturned = resolve; });
  let releaseExtraction!: () => void;
  const extractionGate = new Promise<void>(resolve => { releaseExtraction = resolve; });

  const { core, adapter, channel, emit, turn } = await setup({
    host,
    responder: async request => {
      extractionEntered();
      await extractionGate;
      const seqs = messageSeqs(request);
      const response = {
        text: JSON.stringify({ facts: [{ content: 'PREFERS_TEA', keys: ['tea'], evidenceSeqs: [seqs[0]] }] })
      };
      extractionReturned();
      return response;
    }
  });

  for (let index = 0; index < 6; index += 1) await turn(`message-${index + 1}`);
  await enteredExtraction;

  hold = true;
  emit('seventh-turn');
  await enteredSeventh;
  expect(channel.sent).toHaveLength(6);

  releaseExtraction();
  await returnedExtraction;
  await new Promise(resolve => setTimeout(resolve, 100));
  expect((await core.listMemoryRecords(conversation)).total).toBe(0);
  expect((await core.memoryExtraction(conversation)).extraction.throughSeq).toBe(0);

  releaseSeventh();
  await waitFor(() => channel.sent.length === 7);
  expect(channel.sent[6]!.message.segments).toEqual([{ type: 'text', data: { text: 'HOST_REPLY' } }]);
  expect(core.metrics.get('auto_reply.suppressed', { instance: 'a' })).toBe(0);

  await waitFor(async () => (await core.memoryExtraction(conversation)).extraction.throughSeq === 11);
  const records = await core.listMemoryRecords(conversation);
  expect(records.total).toBe(1);
  expect(records.items[0]!.origin).toBe('model');
  const detail = await core.getMemoryRecord(conversation, records.items[0]!.id);
  expect(detail.record.content).toBe('PREFERS_TEA');
  expect(adapter.extractionRequests).toHaveLength(1);
});

it('O05: pausing during the provider call rejects the old result without records or watermark', async () => {
  let extractionEntered!: () => void;
  const entered = new Promise<void>(resolve => { extractionEntered = resolve; });
  let releaseExtraction!: () => void;
  const gate = new Promise<void>(resolve => { releaseExtraction = resolve; });

  const { core, adapter, turn } = await setup({
    responder: async request => {
      extractionEntered();
      await gate;
      return {
        text: JSON.stringify({ facts: [{ content: 'STALE_FACT', keys: [], evidenceSeqs: [messageSeqs(request)[0]] }] })
      };
    }
  });

  for (let index = 0; index < 6; index += 1) await turn(`pause-${index + 1}`);
  await entered;
  const status = await core.memoryExtraction(conversation);
  await core.pauseMemoryExtraction(conversation, {
    expectedScope: status.scopeToken,
    expectedRevision: status.revision
  });
  releaseExtraction();

  await waitFor(async () => (await core.memoryExtraction(conversation)).runtime?.running === false);
  const after = await core.memoryExtraction(conversation);
  expect(after.extraction.effectiveStatus).toBe('paused');
  expect(after.extraction.throughSeq).toBe(0);
  expect(after.quota).toMatchObject({ accountUsed: 1 });
  expect((await core.listMemoryRecords(conversation)).total).toBe(0);
  expect(adapter.extractionRequests).toHaveLength(1);
});

it('O05: deleting a record during the provider call pauses extraction and leaves the old batch uncommitted', async () => {
  let extractionEntered!: () => void;
  const entered = new Promise<void>(resolve => { extractionEntered = resolve; });
  let releaseExtraction!: () => void;
  const gate = new Promise<void>(resolve => { releaseExtraction = resolve; });

  const { core, adapter, turn } = await setup({
    responder: async request => {
      extractionEntered();
      await gate;
      return {
        text: JSON.stringify({ facts: [{ content: 'DELETED_STALE', keys: [], evidenceSeqs: [messageSeqs(request)[0]] }] })
      };
    }
  });

  const beforeSeed = await core.memoryExtraction(conversation);
  const seeded = await core.createMemoryRecord(conversation, {
    requestId: 'seed-delete',
    expectedScope: beforeSeed.scopeToken,
    expectedRevision: beforeSeed.revision,
    record: { content: 'SEED_TO_DELETE', keys: [] }
  });

  for (let index = 0; index < 6; index += 1) await turn(`delete-${index + 1}`);
  await entered;
  const status = await core.memoryExtraction(conversation);
  await core.deleteMemoryRecord(conversation, seeded.record.id, {
    expectedScope: status.scopeToken,
    expectedRevision: status.revision,
    recordRevision: seeded.record.revision
  });
  releaseExtraction();

  await waitFor(async () => (await core.memoryExtraction(conversation)).runtime?.running === false);
  const after = await core.memoryExtraction(conversation);
  expect(after.extraction.effectiveStatus).toBe('paused');
  expect(after.extraction.pausedReason).toBe('deleted');
  expect(after.extraction.throughSeq).toBe(0);
  expect(after.quota).toMatchObject({ accountUsed: 1 });
  expect((await core.listMemoryRecords(conversation)).total).toBe(0);
  expect(adapter.extractionRequests).toHaveLength(1);
});

it('O05: a role change during the provider call cannot write into the previous scope', async () => {
  let extractionEntered!: () => void;
  const entered = new Promise<void>(resolve => { extractionEntered = resolve; });
  let releaseExtraction!: () => void;
  const gate = new Promise<void>(resolve => { releaseExtraction = resolve; });

  const { root, core, adapter, turn } = await setup({
    responder: async request => {
      extractionEntered();
      await gate;
      return {
        text: JSON.stringify({ facts: [{ content: 'OLD_SCOPE_FACT', keys: [], evidenceSeqs: [messageSeqs(request)[0]] }] })
      };
    }
  });
  await seedSecondRole(root);
  const oldScope = (await core.memoryExtraction(conversation)).scopeToken;

  for (let index = 0; index < 6; index += 1) await turn(`role-${index + 1}`);
  await entered;
  await core.setConversationRoleBinding(conversation, { source: 'public', id: 'second', revision: 'r1' });
  releaseExtraction();

  await waitFor(async () => (await core.memoryExtraction(conversation)).runtime?.running === false);
  const after = await core.memoryExtraction(conversation);
  expect(after.scopeToken).not.toBe(oldScope);
  expect(after.extraction.effectiveStatus).toBe('disabled');
  const persisted = JSON.parse(await fs.readFile(
    path.join(root, 'accounts', '10001', 'memory', oldScope, 'state.json'),
    'utf8'
  )) as { records: unknown[]; extraction: { throughSeq: number } };
  expect(persisted.records).toEqual([]);
  expect(persisted.extraction.throughSeq).toBe(0);
  expect(adapter.extractionRequests).toHaveLength(1);
});

it('E2E: extracted model facts reach the next agent prompt after the watermark advances', async () => {
  const { core, adapter, turn } = await setup({
    responder: async request => ({
      text: JSON.stringify({
        facts: [{ content: '用户喜欢喝乌龙茶', keys: ['乌龙茶'], evidenceSeqs: [messageSeqs(request)[0]] }]
      })
    })
  });

  for (let index = 0; index < 6; index += 1) await turn(`preference-${index + 1}`);
  await waitFor(async () => (await core.memoryExtraction(conversation)).extraction.throughSeq === 11);
  const records = await core.listMemoryRecords(conversation);
  expect(records.total).toBe(1);
  expect(records.items[0]).toMatchObject({ origin: 'model', keys: ['乌龙茶'] });

  const extractionRequest = adapter.extractionRequests[0]!;
  expect(extractionRequest).not.toHaveProperty('tools');
  expect(extractionRequest.messages.map(message => message.role)).toEqual(['system', 'user']);
  const extractionText = JSON.stringify(extractionRequest.messages);
  expect(extractionText).toContain('preference-1');
  expect(extractionText).not.toContain('AGENT_REPLY');

  const before = adapter.calls.length;
  await turn('我想喝点乌龙茶');
  const nextAgent = adapter.calls.slice(before).filter(call => call.capability === 'chat');
  expect(nextAgent).toHaveLength(1);
  expect(nextAgent[0]!.requestText).toContain('用户喜欢喝乌龙茶');

  const status = await core.memoryExtraction(conversation);
  expect(status.extraction.throughSeq).toBe(11);
  expect(adapter.extractionRequests).toHaveLength(1);
});

it('E2E: stopping while the provider call is in flight never persists the started extraction', async () => {
  let extractionEntered!: () => void;
  const entered = new Promise<void>(resolve => { extractionEntered = resolve; });
  let releaseExtraction!: () => void;
  const gate = new Promise<void>(resolve => { releaseExtraction = resolve; });

  const { root, core, adapter, turn } = await setup({
    responder: async request => {
      extractionEntered();
      await gate;
      return {
        text: JSON.stringify({ facts: [{ content: 'SHUTDOWN_FACT', keys: [], evidenceSeqs: [messageSeqs(request)[0]] }] })
      };
    }
  });
  const scope = (await core.memoryExtraction(conversation)).scopeToken;

  for (let index = 0; index < 6; index += 1) await turn(`shutdown-${index + 1}`);
  await entered;
  const stopping = core.stop();
  releaseExtraction();
  await stopping;

  const persisted = JSON.parse(await fs.readFile(
    path.join(root, 'accounts', '10001', 'memory', scope, 'state.json'),
    'utf8'
  )) as { records: unknown[]; extraction: { throughSeq: number } };
  expect(persisted.records).toEqual([]);
  expect(persisted.extraction.throughSeq).toBe(0);
  expect(adapter.extractionRequests).toHaveLength(1);
});

it('E2E: delete pauses extraction and re-activation only processes messages after the new boundary', async () => {
  const { core, adapter, turn, advance } = await setup({
    responder: async request => {
      const seq = messageSeqs(request)[0]!;
      return { text: JSON.stringify({ facts: [{ content: `FACT_${seq}`, keys: [], evidenceSeqs: [seq] }] }) };
    }
  });

  for (let index = 0; index < 6; index += 1) await turn(`old-${index + 1}`);
  await waitFor(async () => (await core.memoryExtraction(conversation)).extraction.throughSeq === 11);
  const first = await core.listMemoryRecords(conversation);
  expect(first.total).toBe(1);
  expect((await core.getMemoryRecord(conversation, first.items[0]!.id)).record.content).toBe('FACT_1');

  const status = await core.memoryExtraction(conversation);
  await core.deleteMemoryRecord(conversation, first.items[0]!.id, {
    expectedScope: status.scopeToken,
    expectedRevision: status.revision,
    recordRevision: first.items[0]!.revision
  });
  const paused = await core.memoryExtraction(conversation);
  expect(paused.extraction.effectiveStatus).toBe('paused');
  expect(paused.extraction.pausedReason).toBe('deleted');
  expect(paused.extraction.throughSeq).toBe(11);

  await core.activateMemoryExtraction(conversation, {
    expectedScope: paused.scopeToken,
    expectedRevision: paused.revision,
    startFrom: 'now',
    confirmModelUse: true
  });
  const active = await core.memoryExtraction(conversation);
  expect(active.extraction.effectiveStatus).toBe('active');
  expect(active.extraction.activatedAfterSeq).toBe(12);
  expect(active.extraction.throughSeq).toBe(12);
  advance(6 * 60_000);

  for (let index = 0; index < 5; index += 1) await turn(`new-${index + 1}`);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(adapter.extractionRequests).toHaveLength(1);

  await turn('new-6');
  await waitFor(() => adapter.extractionRequests.length === 2);
  await waitFor(async () => (await core.memoryExtraction(conversation)).extraction.throughSeq === 23);
  expect(messageSeqs(adapter.extractionRequests[1]!)).toEqual([13, 15, 17, 19, 21, 23]);
  expect(JSON.stringify(adapter.extractionRequests[1]!.messages)).not.toContain('old-1');
  const second = await core.listMemoryRecords(conversation);
  expect(second.total).toBe(1);
  expect((await core.getMemoryRecord(conversation, second.items[0]!.id)).record.content).toBe('FACT_13');
});

it('R1: long messages do not block admission; each trigger processes a bounded prefix', async () => {
  const host: AgentHost = {
    async onMessage(context) {
      context.markExtractable?.();
      return textMessage('HOST_REPLY');
    }
  };
  const { core, adapter, channel, turn, advance } = await setup({
    host,
    responder: async () => ({ text: JSON.stringify({ facts: [] }) })
  });
  const watermark = async (): Promise<number> => (await core.memoryExtraction(conversation)).extraction.throughSeq;

  for (let index = 0; index < 6; index += 1) {
    await turn(`${index}-${'L'.repeat(13_000)}`);
  }
  await waitFor(() => adapter.extractionRequests.length === 1);
  await waitFor(async () => (await watermark()) === 2);
  expect(messageSeqs(adapter.extractionRequests[0]!)).toEqual([1]);

  const expected = [
    { batch: [3], throughSeq: 4 },
    { batch: [5], throughSeq: 6 },
    { batch: [7], throughSeq: 8 },
    { batch: [9], throughSeq: 10 },
    { batch: [11, 13, 15, 17, 19, 21], throughSeq: 21 }
  ];
  for (const [index, step] of expected.entries()) {
    advance(6 * 60_000);
    await turn(`short-${index + 1}`);
    await waitFor(() => adapter.extractionRequests.length === index + 2);
    await waitFor(async () => (await watermark()) === step.throughSeq);
    expect(messageSeqs(adapter.extractionRequests[index + 1]!)).toEqual(step.batch);
  }

  // Only one new eligible text: the batch prefix is not paid for again, and nothing is skipped.
  advance(6 * 60_000);
  await turn('short-6');
  await waitFor(async () => (await core.memoryExtraction(conversation)).runtime?.running === false);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(adapter.extractionRequests).toHaveLength(6);
  expect(await watermark()).toBe(21);

  for (let index = 7; index <= 10; index += 1) {
    advance(6 * 60_000);
    await turn(`short-${index}`);
    await waitFor(async () => (await core.memoryExtraction(conversation)).runtime?.running === false);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(adapter.extractionRequests).toHaveLength(6);
  expect(await watermark()).toBe(21);

  advance(6 * 60_000);
  await turn('short-11');
  await waitFor(() => adapter.extractionRequests.length === 7);
  await waitFor(async () => (await watermark()) === 33);
  expect(messageSeqs(adapter.extractionRequests[6]!)).toEqual([23, 25, 27, 29, 31, 33]);

  // Every eligible user text was processed exactly once, including the long prefix.
  expect(adapter.extractionRequests.flatMap(messageSeqs)).toEqual(
    Array.from({ length: 17 }, (_, index) => index * 2 + 1)
  );
  const charCounts = adapter.extractionRequests.map(request =>
    messagePayload(request).reduce((sum, message) => sum + message.text.length, 0));
  expect(charCounts).toEqual([13_002, 13_002, 13_002, 13_002, 13_002, 13_037, 44]);
  expect(channel.sent).toHaveLength(17);
  const status = await core.memoryExtraction(conversation);
  expect(status.extraction.effectiveStatus).toBe('active');
  expect(status.extraction.throughSeq).toBe(33);
  expect(status.quota?.accountUsed).toBeGreaterThanOrEqual(1);
  expect((await core.listMemoryRecords(conversation)).total).toBe(0);
});
