import { expect, it } from 'vitest';
import {
  MemoryExtractionRunner,
  buildExtractionMessages,
  type ExtractionChatPort,
  type ExtractionChatRequest,
  type ExtractionChatResolution,
  type ExtractionChatResult
} from '../src/application/memory/extraction/runner.js';
import type { ExtractionInputBatch } from '../src/application/memory/extraction/input.js';
import type { ExtractionRunInput } from '../src/application/memory/extraction/coordinator.js';
import { ProviderError, CapabilityUnavailableError } from '../src/providers/errors.js';
import { AccompanyError } from '../src/core/errors.js';
import type { ExtractionCommitInput, ExtractionCommitResult } from '../src/application/memory/memory-service.js';
import type { MemoryExtractionStatusView } from '../src/contracts/memory.js';
import type { ExtractionTurnCompletion } from '../src/core/extraction-events.js';
import type { ConversationRef } from '../src/routing/identity.js';

const conversation: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };
const scopeToken = 'a'.repeat(64);
const batch: ExtractionInputBatch = {
  messages: Array.from({ length: 6 }, (_, index) => ({ seq: index + 7, text: `message-${index + 7}` })),
  fromSeq: 7,
  throughSeq: 12,
  processedThroughSeq: 12,
  inspected: 6,
  skipped: { outbound: 0, otherEpoch: 0, emptyText: 0, overlong: 0 },
  reachedTrigger: true,
  eligibleTexts: 6
};

function status(overrides: Partial<MemoryExtractionStatusView> = {}): MemoryExtractionStatusView {
  return {
    scopeToken,
    revision: 'r1',
    generation: 5,
    extraction: {
      effectiveStatus: 'active',
      autoExtract: true,
      activationVersion: 1,
      activatedAfterSeq: 6,
      throughSeq: 6,
      recentResultCount: 0,
      lastAttemptAt: 1_700_000_000_000
    },
    ...overrides
  };
}

function completion(): ExtractionTurnCompletion {
  return {
    instanceId: 'a',
    accountId: '10001',
    conversation,
    contextEpoch: 'epoch-a',
    turnId: 'turn-1',
    inboundSeq: 12,
    outboundSeq: 13,
    sessionEpoch: 1,
    memoryGuard: 'b'.repeat(64),
    at: 1_700_000_000_000
  };
}

function runInput(overrides: Partial<ExtractionRunInput> = {}): ExtractionRunInput {
  return {
    completion: completion(),
    status: status(),
    batch,
    signal: new AbortController().signal,
    isAdmitted: () => true,
    now: () => 1_700_000_900_000,
    ...overrides
  };
}

class FakeChat implements ExtractionChatPort {
  resolution: ExtractionChatResolution = { enabled: true, providerId: 'fake', modelId: 'model-1' };
  response: ExtractionChatResult = {
    text: '{"facts":[]}',
    used: { providerId: 'fake', modelId: 'model-1' }
  };
  failure?: Error;
  requests: ExtractionChatRequest[] = [];

  resolve(): { enabled: boolean; providerId?: string; modelId?: string } {
    return this.resolution;
  }

  async chat(input: ExtractionChatRequest): Promise<ExtractionChatResult> {
    this.requests.push(input);
    if (!(await input.isStillAllowed())) {
      throw new CapabilityUnavailableError('chat', 'role_binding_changed', 'role changed');
    }
    if (this.failure) throw this.failure;
    return this.response;
  }
}

class FakeMemory {
  readonly statusView: MemoryExtractionStatusView;
  commitInputs: ExtractionCommitInput[] = [];
  result: ExtractionCommitResult = {
    committed: true,
    duplicate: false,
    added: 0,
    capacityPaused: false,
    revision: 'r2',
    generation: 6,
    throughSeq: 12
  };
  failure?: Error;

  constructor(view = status()) {
    this.statusView = view;
  }

  async extractionStatus(): Promise<MemoryExtractionStatusView> {
    return this.statusView;
  }

  async commitExtraction(_conversation: ConversationRef, input: ExtractionCommitInput): Promise<ExtractionCommitResult> {
    this.commitInputs.push(input);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

function setup(options: { chat?: FakeChat; memory?: FakeMemory; epoch?: string; admitted?: () => boolean; guard?: () => string } = {}) {
  const chat = options.chat ?? new FakeChat();
  const memory = options.memory ?? new FakeMemory();
  let enqueued = 0;
  const runner = new MemoryExtractionRunner({
    memories: memory,
    chat,
    contextEpoch: async () => options.epoch ?? 'epoch-a',
    memoryGuard: async () => options.guard ? options.guard() : 'b'.repeat(64),
    enqueueCommit: async (_completion, task) => {
      enqueued += 1;
      await task();
    }
  });
  return { chat, memory, runner, enqueued: () => enqueued, admitted: options.admitted };
}

it('O01: sends a tools-free request and rejects provider tool calls without committing', async () => {
  const chat = new FakeChat();
  chat.response = { text: '{"facts":[]}', toolCalls: [{ name: 'generate_image' }], used: { providerId: 'fake', modelId: 'model-1' } };
  const { memory, runner } = setup({ chat });
  await expect(runner.run(runInput())).rejects.toMatchObject({ code: 'extraction_tool_call' });
  expect(chat.requests).toHaveLength(1);
  expect(chat.requests[0]!.messages.map(message => message.role)).toEqual(['system', 'user']);
  expect(chat.requests[0]).not.toHaveProperty('tools');
  expect(JSON.stringify(chat.requests[0]!.messages)).not.toContain('role-card');
  expect(memory.commitInputs).toHaveLength(0);
});

it('O02: rejects code fences, unknown fields and oversized output before any commit', async () => {
  for (const text of [
    '```json\n{"facts":[]}\n```',
    '{"facts":[],"extra":true}',
    '{"facts":[{"content":"x","keys":[],"evidenceSeqs":[7],"id":"r-x"}]}',
    'not json'
  ]) {
    const chat = new FakeChat();
    chat.response = { text, used: { providerId: 'fake', modelId: 'model-1' } };
    const { memory, runner } = setup({ chat });
    await expect(runner.run(runInput()), text).rejects.toMatchObject({ code: 'extraction_output_invalid' });
    expect(memory.commitInputs).toHaveLength(0);
  }
});

it('O03: only server-owned fields reach the commit input', async () => {
  const chat = new FakeChat();
  chat.response = {
    text: JSON.stringify({ facts: [
      { content: '喜欢银杏', keys: ['银杏'], evidenceSeqs: [7, 8] },
      { content: '住在杭州', keys: [], evidenceSeqs: [9] }
    ] }),
    used: { providerId: 'fake', modelId: 'model-1' }
  };
  const { memory, runner } = setup({ chat });
  await runner.run(runInput());
  expect(memory.commitInputs).toHaveLength(1);
  const input = memory.commitInputs[0]!;
  expect(input).toMatchObject({
    expectedScope: scopeToken,
    expectedRevision: 'r1',
    expectedGeneration: 5,
    expectedThroughSeq: 6,
    processedThroughSeq: 12,
    now: 1_700_000_900_000
  });
  expect(input.sourceKey).toMatch(/^[a-f0-9]{64}$/);
  expect(input.facts).toEqual([
    { content: '喜欢银杏', keys: ['银杏'], fromSeq: 7, throughSeq: 8 },
    { content: '住在杭州', keys: [], fromSeq: 9, throughSeq: 9 }
  ]);
  expect(JSON.stringify(input.facts)).not.toContain('origin');
  expect(JSON.stringify(input.facts)).not.toContain('pinned');
  expect(JSON.stringify(input.facts)).not.toContain('revision');
});

it('O04: empty facts is a successful commit with the processed watermark', async () => {
  const chat = new FakeChat();
  chat.response = { text: '{"facts":[]}', used: { providerId: 'fake', modelId: 'model-1' } };
  const { memory, runner } = setup({ chat });
  await runner.run(runInput());
  expect(memory.commitInputs).toHaveLength(1);
  expect(memory.commitInputs[0]!.facts).toEqual([]);
  expect(memory.commitInputs[0]!.processedThroughSeq).toBe(12);
});

it('O05: a guard failure before the request is benign and never commits', async () => {
  const chat = new FakeChat();
  const memory = new FakeMemory(status({ generation: 6 }));
  const { runner } = setup({ chat, memory });
  await expect(runner.run(runInput())).rejects.toMatchObject({ code: 'extraction_suppressed', benign: true });
  expect(chat.requests).toHaveLength(1);
  expect(memory.commitInputs).toHaveLength(0);
});

it('O05: a changed memory guard suppresses the attempt before and after the provider call', async () => {
  const chat = new FakeChat();
  const before = setup({ chat, guard: () => 'c'.repeat(64) });
  await expect(before.runner.run(runInput())).rejects.toMatchObject({ code: 'extraction_suppressed', benign: true });
  expect(before.memory.commitInputs).toHaveLength(0);

  let guard = 'b'.repeat(64);
  const after = setup({ chat, guard: () => guard });
  chat.response = { text: '{"facts":[]}', used: { providerId: 'fake', modelId: 'model-1' } };
  const originalChat = chat.chat.bind(chat);
  chat.chat = async input => {
    const result = await originalChat(input);
    guard = 'd'.repeat(64);
    return result;
  };
  await expect(after.runner.run(runInput())).rejects.toMatchObject({ code: 'extraction_suppressed', benign: true });
  expect(after.memory.commitInputs).toHaveLength(0);
});

it('drops when the account capability is unavailable or admission is closed, without a provider call', async () => {
  const disabled = new FakeChat();
  disabled.resolution = { enabled: false };
  const first = setup({ chat: disabled });
  await expect(first.runner.run(runInput())).rejects.toMatchObject({ code: 'extraction_suppressed', benign: true });
  expect(disabled.requests).toHaveLength(0);

  const second = setup();
  await expect(second.runner.run(runInput({ isAdmitted: () => false })))
    .rejects.toMatchObject({ code: 'extraction_suppressed', benign: true });
  expect(second.chat.requests).toHaveLength(0);
  expect(second.memory.commitInputs).toHaveLength(0);
});

it('propagates provider failures as non-benign and maps commit/session conflicts to benign suppression', async () => {
  const chat = new FakeChat();
  chat.failure = new ProviderError('provider_timeout', 'timed out', {
    providerId: 'fake', capability: 'chat', retryable: true
  });
  const provider = setup({ chat });
  const error = await provider.runner.run(runInput()).then(() => undefined, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).code).toBe('provider_timeout');
  expect((error as { benign?: boolean }).benign).not.toBe(true);
  expect(provider.memory.commitInputs).toHaveLength(0);

  const conflicted = new FakeChat();
  conflicted.response = { text: '{"facts":[]}', used: { providerId: 'fake', modelId: 'model-1' } };
  const memory = new FakeMemory();
  memory.failure = new AccompanyError('memory_conflict', 'state changed');
  const commit = setup({ chat: conflicted, memory });
  await expect(commit.runner.run(runInput())).rejects.toMatchObject({ code: 'extraction_suppressed', benign: true });
  expect(memory.commitInputs).toHaveLength(1);
});

it('uses the actual provider/model in the deterministic source key and routes the commit through the queue', async () => {
  const chat = new FakeChat();
  chat.response = {
    text: JSON.stringify({ facts: [{ content: '事实', keys: [], evidenceSeqs: [7] }] }),
    used: { providerId: 'fake', modelId: 'model-1' }
  };
  const first = setup({ chat });
  await first.runner.run(runInput());
  const second = setup({ chat });
  await second.runner.run(runInput());
  expect(second.memory.commitInputs[0]!.sourceKey).toBe(first.memory.commitInputs[0]!.sourceKey);
  expect(first.enqueued()).toBe(1);
  expect(second.enqueued()).toBe(1);

  chat.response = { text: '{"facts":[]}', used: { providerId: 'other', modelId: 'model-2' } };
  const third = setup({ chat });
  await third.runner.run(runInput());
  expect(third.memory.commitInputs[0]!.sourceKey).not.toBe(first.memory.commitInputs[0]!.sourceKey);
});

it('acknowledges a capacity pause without throwing', async () => {
  const memory = new FakeMemory();
  memory.result = {
    committed: false,
    duplicate: false,
    added: 0,
    capacityPaused: true,
    revision: 'r2',
    generation: 6,
    throughSeq: 6
  };
  const { runner } = setup({ memory });
  await expect(runner.run(runInput())).resolves.toBeUndefined();
  expect(memory.commitInputs).toHaveLength(1);
});

it('builds a two-message prompt with seq and sender data only', () => {
  const groupBatch: ExtractionInputBatch = {
    ...batch,
    messages: [{ seq: 7, text: 'GROUP_FACT', senderId: 'alice' }]
  };
  const messages = buildExtractionMessages(groupBatch, true);
  expect(messages.map(message => message.role)).toEqual(['system', 'user']);
  const system = messages[0]!.content[0] as { type: 'text'; text: string };
  const user = messages[1]!.content[0] as { type: 'text'; text: string };
  expect(system.text).toContain('evidenceSeqs');
  expect(system.text).toContain('senderId');
  expect(user.text).toContain('"seq":7');
  expect(user.text).toContain('"senderId":"alice"');
  expect(user.text).toContain('GROUP_FACT');
});
