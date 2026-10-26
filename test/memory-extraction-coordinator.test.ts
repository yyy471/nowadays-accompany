import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ExtractionCoordinator,
  type ExtractionCoordinatorLimits,
  type ExtractionMemoryPort,
  type ExtractionRunInput,
  type ExtractionRunner
} from '../src/application/memory/extraction/coordinator.js';
import { ExtractionAttemptError } from '../src/application/memory/extraction/errors.js';
import { ExtractionQuotaStore } from '../src/application/memory/extraction/quota.js';
import type { ExtractionAdvanceInput } from '../src/application/memory/memory-service.js';
import { JsonlStore } from '../src/storage/jsonl-store.js';
import { waitFor } from './phase1-helpers.js';
import type { ExtractionTurnCompletion } from '../src/core/extraction-events.js';
import type {
  MemoryExtractionQuotaView,
  MemoryExtractionStatusView,
  MemoryExtractionView
} from '../src/contracts/memory.js';
import type { ConversationRef } from '../src/routing/identity.js';
import { conversationKey } from '../src/routing/identity.js';
import type { MessageSegment } from '../src/routing/message.js';

const roots: string[] = [];
const stores: JsonlStore[] = [];
const quotas: ExtractionQuotaStore[] = [];
const coordinators: ExtractionCoordinator[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    coordinator.close();
    await coordinator.drain();
  }
  await Promise.allSettled(quotas.splice(0).map(quota => quota.dispose()));
  await Promise.allSettled(stores.splice(0).map(store => store.dispose()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-extraction-coordinator-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const accountId = '10001';
const conversation: ConversationRef = { accountId, kind: 'private', peerId: '555' };
const scopeToken = 'a'.repeat(64);
const epoch = 'epoch-a';

interface FakeExtractionState {
  enabled: boolean;
  autoExtract: boolean;
  activationVersion?: 1;
  throughSeq: number;
  generation: number;
  revision: string;
  pausedReason?: MemoryExtractionView['pausedReason'];
  cooldownUntil?: number;
  lastFailure?: MemoryExtractionView['lastFailure'];
  lastAttemptAt?: number;
}

class FakeMemory implements ExtractionMemoryPort {
  attempts = 0;
  failures: Array<{ code: string; at: number; cooldownUntil?: number; fatal?: boolean }> = [];
  advances: Array<{ fromSeq: number; throughSeq: number }> = [];
  readonly #now: () => number;
  readonly #states = new Map<string, FakeExtractionState>();

  constructor(now: () => number) {
    this.#now = now;
    this.#stateFor(conversation);
  }

  get state(): FakeExtractionState {
    return this.#stateFor(conversation);
  }

  stateFor(ref: ConversationRef): FakeExtractionState {
    return this.#stateFor(ref);
  }

  #stateFor(ref: ConversationRef): FakeExtractionState {
    const key = conversationKey(ref);
    let state = this.#states.get(key);
    if (!state) {
      state = {
        enabled: true,
        autoExtract: true,
        activationVersion: 1,
        throughSeq: 0,
        generation: 1,
        revision: 'r1'
      };
      this.#states.set(key, state);
    }
    return state;
  }

  view(state = this.state): MemoryExtractionView {
    let effectiveStatus: MemoryExtractionView['effectiveStatus'];
    if (!state.enabled) effectiveStatus = 'disabled';
    else if (!state.autoExtract) effectiveStatus = state.pausedReason ? 'paused' : 'disabled';
    else if (state.activationVersion !== 1) effectiveStatus = 'needs-confirmation';
    else if (state.pausedReason) effectiveStatus = 'paused';
    else if (state.lastFailure?.fatal) effectiveStatus = 'failed';
    else if (state.cooldownUntil !== undefined && state.cooldownUntil > this.#now()) effectiveStatus = 'cooldown';
    else effectiveStatus = 'active';
    return {
      effectiveStatus,
      autoExtract: state.autoExtract,
      ...(state.activationVersion === 1 ? { activationVersion: 1 as const } : {}),
      throughSeq: state.throughSeq,
      recentResultCount: 0,
      ...(state.lastAttemptAt !== undefined ? { lastAttemptAt: state.lastAttemptAt } : {}),
      ...(state.cooldownUntil !== undefined ? { cooldownUntil: state.cooldownUntil } : {}),
      ...(state.pausedReason !== undefined ? { pausedReason: state.pausedReason } : {}),
      ...(state.lastFailure !== undefined ? { lastFailure: state.lastFailure } : {})
    };
  }

  async status(ref: ConversationRef): Promise<MemoryExtractionStatusView> {
    const state = this.#stateFor(ref);
    return {
      scopeToken,
      revision: state.revision,
      generation: state.generation,
      extraction: this.view(state)
    };
  }

  async beginAttempt(
    ref: ConversationRef,
    expectedScope: string,
    expectedGeneration: number,
    expectedThroughSeq: number,
    now: number
  ): Promise<{ started: boolean; reason?: string }> {
    const state = this.#stateFor(ref);
    if (expectedScope !== scopeToken) return { started: false, reason: 'scope_changed' };
    if (expectedGeneration !== state.generation) return { started: false, reason: 'generation_changed' };
    if (expectedThroughSeq !== state.throughSeq) return { started: false, reason: 'watermark_changed' };
    const status = this.view(state).effectiveStatus;
    if (status !== 'active') return { started: false, reason: status };
    this.attempts += 1;
    state.lastAttemptAt = now;
    return { started: true };
  }

  async recordFailure(
    ref: ConversationRef,
    expectedScope: string,
    expectedGeneration: number,
    failure: { code: string; at: number; cooldownUntil?: number; fatal?: boolean }
  ): Promise<boolean> {
    const state = this.#stateFor(ref);
    if (expectedScope !== scopeToken || expectedGeneration !== state.generation) return false;
    this.failures.push(failure);
    state.lastFailure = {
      code: failure.code,
      at: failure.at,
      ...(failure.fatal ? { fatal: true } : {})
    };
    if (failure.cooldownUntil !== undefined) state.cooldownUntil = failure.cooldownUntil;
    return true;
  }

  async advance(ref: ConversationRef, input: ExtractionAdvanceInput): Promise<boolean> {
    const state = this.#stateFor(ref);
    if (input.expectedScope !== scopeToken || input.expectedGeneration !== state.generation) return false;
    if (input.expectedThroughSeq !== state.throughSeq) return false;
    if (this.view(state).effectiveStatus !== 'active') return false;
    if (input.processedThroughSeq <= state.throughSeq) return false;
    this.advances.push({ fromSeq: state.throughSeq, throughSeq: input.processedThroughSeq });
    state.throughSeq = input.processedThroughSeq;
    state.generation += 1;
    state.revision = `r${state.generation}`;
    return true;
  }

  commit(input: ExtractionRunInput): void {
    const state = this.#stateFor(input.completion.conversation);
    state.throughSeq = Math.max(state.throughSeq, input.batch.processedThroughSeq);
    state.generation += 1;
    state.revision = `r${state.generation}`;
  }
}

function completion(inboundSeq: number, ref: ConversationRef = conversation): ExtractionTurnCompletion {
  return {
    instanceId: 'a',
    accountId: ref.accountId,
    conversation: ref,
    contextEpoch: epoch,
    turnId: `turn-${inboundSeq}`,
    inboundSeq,
    outboundSeq: inboundSeq + 1,
    sessionEpoch: 1,
    memoryGuard: 'b'.repeat(64),
    at: 1_700_000_000_000
  };
}

async function setup(options: {
  onRun?: (input: ExtractionRunInput) => Promise<void>;
  limits?: Partial<ExtractionCoordinatorLimits>;
  quotaLimits?: { perAccountPerHour: number; globalPerHour: number };
  epoch?: string | (() => string | undefined);
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-coordinator-'));
  roots.push(root);
  let now = 1_700_000_000_000;
  const store = new JsonlStore({ root: path.join(root, 'messages'), accountId, segmentRecords: 20 });
  stores.push(store);
  const memory = new FakeMemory(() => now);
  const quota = await ExtractionQuotaStore.load(path.join(root, 'state', 'quota.json'), {
    now: () => now,
    limits: options.quotaLimits ?? { perAccountPerHour: 12, globalPerHour: 30 }
  });
  quotas.push(quota);
  const calls: ExtractionRunInput[] = [];
  const runner: ExtractionRunner = {
    run: async input => {
      calls.push(input);
      await options.onRun?.(input);
    }
  };
  const epochValue = options.epoch ?? epoch;
  const coordinator = new ExtractionCoordinator({
    memories: memory,
    quota,
    store: () => store,
    contextEpoch: async () => typeof epochValue === 'function' ? epochValue() : epochValue,
    runner,
    enqueue: async (_completion, task) => { await task(); },
    now: () => now,
    ...(options.limits ? { limits: options.limits } : {})
  });
  coordinators.push(coordinator);
  let messageIndex = 0;
  const append = async (count = 1, ref: ConversationRef = conversation): Promise<number> => {
    let seq = 0;
    for (let index = 0; index < count; index++) {
      messageIndex += 1;
      const result = await store.append(ref, {
        id: `m-${messageIndex}`,
        at: 1_700_000_000_000 + messageIndex,
        direction: 'in',
        contextEpoch: epoch,
        senderId: ref.peerId,
        segments: [{ type: 'text', data: { text: `message-${messageIndex}` } }] as MessageSegment[]
      });
      seq = result.seq;
    }
    return seq;
  };
  return {
    root,
    store,
    memory,
    quota,
    coordinator,
    calls,
    append,
    now: () => now,
    setNow: (value: number) => { now = value; },
    advance: (ms: number) => { now += ms; }
  };
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 30));
}

it('Q01: waits for six new text messages and five minutes, without timer wakeups', async () => {
  const { coordinator, memory, calls, append, advance } = await setup();
  const five = await append(5);
  coordinator.notify(completion(five));
  await settle();
  expect(calls).toHaveLength(0);
  expect(memory.attempts).toBe(0);

  const six = await append(1);
  coordinator.notify(completion(six));
  await waitFor(() => calls.length === 1);
  const chat = calls[0]!;
  expect(chat.batch.messages.map(message => message.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  memory.commit(chat);

  const nextBatch = await append(6);
  advance(60_000);
  coordinator.notify(completion(nextBatch));
  await settle();
  expect(calls).toHaveLength(1);

  advance(5 * 60_000);
  coordinator.notify(completion(nextBatch));
  await waitFor(() => calls.length === 2);
  expect(calls[1]!.batch.messages.map(message => message.seq)).toEqual([7, 8, 9, 10, 11, 12]);

  await settle();
  expect(calls).toHaveLength(2);
});

it('Q02: bounds global concurrency and merges same-scope notifications while running', async () => {
  let released = false;
  const waiters: Array<() => void> = [];
  const waitForRelease = (): Promise<void> => new Promise<void>(resolve => {
    if (released) resolve();
    else waiters.push(resolve);
  });
  const releaseAll = (): void => {
    released = true;
    for (const resolve of waiters.splice(0)) resolve();
  };
  const active = new Map<string, number>();
  const maxActive = new Map<string, number>();
  let globalActive = 0;
  let maxGlobal = 0;
  const { coordinator, memory, calls, append, advance } = await setup({
    limits: { globalConcurrency: 2, minIntervalMs: 1 },
    onRun: async input => {
      const key = input.completion.conversation.peerId;
      active.set(key, (active.get(key) ?? 0) + 1);
      maxActive.set(key, Math.max(maxActive.get(key) ?? 0, active.get(key)!));
      globalActive += 1;
      maxGlobal = Math.max(maxGlobal, globalActive);
      await waitForRelease();
      active.set(key, active.get(key)! - 1);
      globalActive -= 1;
      memory.commit(input);
    }
  });
  const scopes: ConversationRef[] = ['p1', 'p2', 'p3'].map(peerId => ({ accountId, kind: 'private', peerId }));
  const firstSeq = await append(6, scopes[0]!);
  coordinator.notify(completion(firstSeq, scopes[0]!));
  await waitFor(() => active.has('p1'));
  const secondSeq = await append(6, scopes[1]!);
  coordinator.notify(completion(secondSeq, scopes[1]!));
  await waitFor(() => active.has('p2'));
  const thirdSeq = await append(6, scopes[2]!);
  coordinator.notify(completion(thirdSeq, scopes[2]!));
  await settle();
  expect(maxGlobal).toBe(2);
  expect(calls).toHaveLength(2);
  expect(active.get('p3')).toBeUndefined();

  const more = await append(6, scopes[0]!);
  advance(1);
  coordinator.notify(completion(more, scopes[0]!));
  coordinator.notify(completion(more, scopes[0]!));
  await settle();
  expect(maxActive.get('p1')).toBe(1);

  releaseAll();
  await waitFor(() => calls.length === 4);
  await settle();
  expect(calls).toHaveLength(4);
  expect(maxGlobal).toBe(2);
  expect(maxActive.get('p1')).toBe(1);
  expect(memory.attempts).toBe(4);
});

it('Q02b: drops new scopes beyond the pending bound', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { coordinator, append } = await setup({
    limits: { globalConcurrency: 1, maxPendingScopes: 2 },
    onRun: async () => { await gate; }
  });
  const scopes: ConversationRef[] = ['p1', 'p2', 'p3'].map(peerId => ({ accountId, kind: 'private', peerId }));
  for (const scope of scopes) {
    const seq = await append(6, scope);
    coordinator.notify(completion(seq, scope));
  }
  await settle();
  expect(coordinator.status(scopes[1]!).runtime.running).toBe(true);
  expect(coordinator.status(scopes[2]!).runtime).toEqual({ running: false, pending: false, circuitOpen: false });
  release();
  await settle();
});

it('Q03/Q04: counts attempts before the call, keeps failures counted and persists quota across coordinators', async () => {
  const first = await setup({
    quotaLimits: { perAccountPerHour: 1, globalPerHour: 1 },
    limits: { minIntervalMs: 1 },
    onRun: async () => { throw new ExtractionAttemptError('provider_timeout', 'timed out'); }
  });
  const seq = await first.append(6);
  first.coordinator.notify(completion(seq));
  await waitFor(() => first.memory.failures.length === 1);
  expect(first.calls).toHaveLength(1);
  expect(first.memory.failures[0]).toMatchObject({ code: 'provider_timeout', cooldownUntil: first.now() + 600_000 });
  expect(first.memory.state.throughSeq).toBe(0);
  expect(first.quota.snapshot(accountId).accountUsed).toBe(1);

  const next = await first.append(6);
  first.advance(11 * 60_000);
  first.coordinator.notify(completion(next));
  await settle();
  expect(first.calls).toHaveLength(1);
  expect(first.memory.attempts).toBe(2);

  const secondMemory = new FakeMemory(first.now);
  Object.assign(secondMemory.state, {
    ...first.memory.state,
    generation: 1,
    revision: 'r1',
    lastAttemptAt: undefined,
    cooldownUntil: undefined,
    lastFailure: undefined
  });
  const secondQuota = await ExtractionQuotaStore.load(path.join(first.root, 'state', 'quota.json'), {
    now: first.now,
    limits: { perAccountPerHour: 1, globalPerHour: 1 }
  });
  quotas.push(secondQuota);
  const secondCalls: ExtractionRunInput[] = [];
  const second = new ExtractionCoordinator({
    memories: secondMemory,
    quota: secondQuota,
    store: () => first.store,
    contextEpoch: async () => epoch,
    runner: { run: async input => { secondCalls.push(input); } },
    enqueue: async (_completion, task) => { await task(); },
    now: first.now
  });
  coordinators.push(second);
  await settle();
  expect(secondCalls).toHaveLength(0);
  second.notify(completion(next));
  await settle();
  expect(secondCalls).toHaveLength(0);
  expect(secondMemory.attempts).toBe(1);
});

it('I05: admission counting crosses a non-text prefix in one scan', async () => {
  const { coordinator, memory, calls, store, append } = await setup();
  for (let index = 0; index < 1000; index += 1) {
    await store.append(conversation, {
      id: `out-${index}`,
      at: 1_700_000_000_000 + index,
      direction: 'out',
      contextEpoch: epoch,
      segments: [{ type: 'text', data: { text: `assistant-${index}` } }] as MessageSegment[]
    });
  }
  const six = await append(6);
  coordinator.notify(completion(six));
  await waitFor(() => calls.length === 1);
  expect(memory.advances).toHaveLength(0);
  expect(calls[0]!.batch.messages.map(message => message.seq)).toEqual([1001, 1002, 1003, 1004, 1005, 1006]);
});

it('I05: an all-skipped prefix advances so the next scan starts after it', async () => {
  const { coordinator, memory, calls, store, append } = await setup();
  for (let index = 0; index < 1000; index += 1) {
    await store.append(conversation, {
      id: `media-${index}`,
      at: 1_700_000_000_000 + index,
      direction: 'out',
      contextEpoch: epoch,
      segments: [{ type: 'text', data: { text: `assistant-${index}` } }] as MessageSegment[]
    });
  }
  coordinator.notify(completion(1000));
  await waitFor(() => memory.advances.length === 1);
  expect(memory.advances[0]).toEqual({ fromSeq: 0, throughSeq: 1000 });
  expect(memory.state.throughSeq).toBe(1000);
  expect(calls).toHaveLength(0);

  const six = await append(6);
  coordinator.notify(completion(six));
  await waitFor(() => calls.length === 1);
  expect(calls[0]!.batch.messages.map(message => message.seq)).toEqual([1001, 1002, 1003, 1004, 1005, 1006]);
});

it('I05: a capped scan resumes on later triggers instead of rescanning the prefix', async () => {
  const { coordinator, memory, calls, store, append } = await setup({
    limits: { scanRecordsPerScan: 2, minIntervalMs: 1 }
  });
  const readStarts: number[] = [];
  const original = store.readRange.bind(store);
  vi.spyOn(store, 'readRange').mockImplementation(async (ref, range) => {
    readStarts.push(range.afterSeq);
    return original(ref, range);
  });

  const triggers: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    triggers.push(await append(1));
    if (index < 5) {
      await store.append(conversation, {
        id: `out-${index}`,
        at: 1_700_000_000_000 + index,
        direction: 'out',
        contextEpoch: epoch,
        segments: [{ type: 'text', data: { text: `assistant-${index}` } }] as MessageSegment[]
      });
    }
  }

  for (const [index, trigger] of triggers.entries()) {
    coordinator.notify(completion(trigger));
    await waitFor(() => readStarts.length === index + 1);
    await waitFor(() => coordinator.status(conversation).runtime.running === false);
    if (index < triggers.length - 1) {
      expect(calls).toHaveLength(0);
      expect(memory.advances).toHaveLength(0);
    }
  }

  await waitFor(() => calls.length === 1);
  expect(calls[0]!.batch.messages.map(message => message.seq)).toEqual([1, 3, 5, 7, 9, 11]);
  expect(calls[0]!.batch.processedThroughSeq).toBe(11);
  // Each trigger resumes after the last inspected seq; only the first scan is trigger-bounded.
  expect(readStarts).toEqual([0, 1, 3, 5, 7, 9]);
  expect(memory.advances).toHaveLength(0);
  expect(memory.state.throughSeq).toBe(0);
});

it('Q05: failure cooldown blocks retries and does not advance the watermark', async () => {
  const { coordinator, memory, calls, append, advance } = await setup({
    limits: { minIntervalMs: 1 },
    onRun: async () => { throw new ExtractionAttemptError('provider_auth', 'unauthorized'); }
  });
  const seq = await append(6);
  coordinator.notify(completion(seq));
  await waitFor(() => memory.failures.length === 1);
  expect(memory.state.throughSeq).toBe(0);

  const next = await append(6);
  advance(60_000);
  coordinator.notify(completion(next));
  await settle();
  expect(calls).toHaveLength(1);

  advance(10 * 60_000);
  coordinator.notify(completion(next));
  await waitFor(() => calls.length === 2);
  expect(calls[1]!.batch.messages[0]!.seq).toBe(1);
});

it('Q06: drops role mismatch, paused, unactivated and cooldown states before any attempt', async () => {
  const mismatch = await setup({ epoch: 'epoch-other' });
  const seq = await mismatch.append(6);
  mismatch.coordinator.notify(completion(seq));
  await settle();
  expect(mismatch.memory.attempts).toBe(0);
  expect(mismatch.calls).toHaveLength(0);

  for (const patch of [
    { autoExtract: false, pausedReason: 'user' as const },
    { activationVersion: undefined },
    { enabled: false },
    { cooldownUntil: 1_700_000_600_000 }
  ]) {
    const fixture = await setup();
    Object.assign(fixture.memory.state, patch);
    const trigger = await fixture.append(6);
    fixture.coordinator.notify(completion(trigger));
    await settle();
    expect(fixture.memory.attempts).toBe(0);
    expect(fixture.calls).toHaveLength(0);
  }
});

it('Q06b: pausing a queued scope prevents its provider call after the semaphore is released', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { coordinator, memory, calls, append } = await setup({
    limits: { globalConcurrency: 1, minIntervalMs: 1 },
    onRun: async input => {
      await gate;
      memory.commit(input);
    }
  });
  const first: ConversationRef = { accountId, kind: 'private', peerId: 'p1' };
  const second: ConversationRef = { accountId, kind: 'private', peerId: 'p2' };
  const firstSeq = await append(6, first);
  coordinator.notify(completion(firstSeq, first));
  await waitFor(() => calls.length === 1);

  const secondSeq = await append(6, second);
  coordinator.notify(completion(secondSeq, second));
  await settle();
  const queued = memory.stateFor(second);
  queued.autoExtract = false;
  queued.pausedReason = 'user';
  queued.generation += 1;
  queued.revision = `r${queued.generation}`;

  release();
  await waitFor(() => coordinator.status(first).runtime.running === false);
  await settle();
  expect(calls).toHaveLength(1);
  expect(memory.attempts).toBe(1);
  expect(memory.stateFor(second).throughSeq).toBe(0);
});

it('Q07: close aborts local waits, bounds drain and prevents late results from being admitted', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let admittedAfterRelease: boolean | undefined;
  const { coordinator, append } = await setup({
    limits: { shutdownTimeoutMs: 80 },
    onRun: async input => {
      entered();
      await gate;
      admittedAfterRelease = input.isAdmitted();
    }
  });
  const seq = await append(6);
  coordinator.notify(completion(seq));
  await enteredPromise;
  coordinator.close();
  const started = Date.now();
  await coordinator.drain();
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(coordinator.closed).toBe(true);
  release();
  await waitFor(() => admittedAfterRelease !== undefined);
  expect(admittedAfterRelease).toBe(false);
});
