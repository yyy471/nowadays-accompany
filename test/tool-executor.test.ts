import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccompanyError } from '../src/core/errors.js';
import { silentLogger } from '../src/core/logger.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { validateToolArguments } from '../src/extensions/schema.js';
import {
  ToolExecutor,
  ToolExecutionError,
  type ToolBatchContext,
  type ToolCallRequest,
  type ToolHandler
} from '../src/extensions/execution/executor.js';
import {
  TOOL_LEDGER_LIMITS,
  ToolInvocationStore,
  toolArgumentDigest,
  toolInvocationKey,
  toolLedgerPath
} from '../src/extensions/execution/ledger.js';
import { ToolConcurrencyLimiter } from '../src/extensions/execution/limiter.js';

const roots: string[] = [];
const executors: ToolExecutor[] = [];

afterEach(async () => {
  await Promise.allSettled(executors.splice(0).map((executor) => executor.close()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function registry(): ExtensionRegistry {
  const result = new ExtensionRegistry();
  result.registerTool({
    id: 'builtin.echo',
    name: 'echo_tool',
    description: 'Echo a bounded value.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    },
    effect: 'read'
  });
  result.registerTool({
    id: 'builtin.action',
    name: 'action_tool',
    description: 'Perform a test action.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    },
    effect: 'action'
  });
  result.registerTool({
    id: 'builtin.slow',
    name: 'slow_tool',
    description: 'Slow test action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'action',
    timeoutMs: 100
  });
  result.registerTool({
    id: 'builtin.big',
    name: 'big_tool',
    description: 'Return a large result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'read',
    maxResultBytes: 8 * 1024
  });
  return result;
}

function mapping(): Map<string, string> {
  return new Map([
    ['echo_tool', 'builtin.echo'],
    ['action_tool', 'builtin.action'],
    ['slow_tool', 'builtin.slow'],
    ['big_tool', 'builtin.big']
  ]);
}

function context(overrides: Partial<ToolBatchContext> = {}): ToolBatchContext {
  return {
    accountId: '10001',
    conversation: { accountId: '10001', kind: 'private', peerId: '42' },
    messageId: 'm1',
    turn: 0,
    toolIdsByModelName: mapping(),
    signal: new AbortController().signal,
    ...overrides
  };
}

interface SetupOptions {
  authorized?: string[];
  handlers?: Partial<Record<string, ToolHandler>>;
  limits?: ConstructorParameters<typeof ToolExecutor>[0]['limits'];
  storeFactory?: ConstructorParameters<typeof ToolExecutor>[0]['storeFactory'];
  now?: () => number;
}

async function setup(options: SetupOptions = {}): Promise<{
  root: string;
  accountDir: string;
  executor: ToolExecutor;
  calls: Array<{ toolId: string; args: Record<string, unknown> }>;
  registry: ExtensionRegistry;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-tool-exec-'));
  roots.push(root);
  const accountDir = path.join(root, 'accounts', '10001');
  const reg = registry();
  const calls: Array<{ toolId: string; args: Record<string, unknown> }> = [];
  const handlers: Partial<Record<string, ToolHandler>> = {
    'builtin.echo': (args) => {
      calls.push({ toolId: 'builtin.echo', args });
      return { status: 'ok', text: String(args.value) };
    },
    'builtin.action': (args) => {
      calls.push({ toolId: 'builtin.action', args });
      return { status: 'ok', text: 'done' };
    },
    'builtin.big': () => {
      calls.push({ toolId: 'builtin.big', args: {} });
      return { status: 'ok', text: 'x'.repeat(20_000), data: { big: 'y'.repeat(20_000) } };
    },
    ...options.handlers
  };
  const executor = new ToolExecutor({
    view: () => ({
      tools: reg.listTools(),
      authorized: new Set(options.authorized ?? ['builtin.echo', 'builtin.action', 'builtin.slow', 'builtin.big'])
    }),
    handlers: (toolId) => {
      const handler = handlers[toolId as keyof typeof handlers];
      return handler ? { generation: 'g1', handler } : undefined;
    },
    accountDir: (accountId) => path.join(root, 'accounts', accountId),
    logger: silentLogger('tool-executor-test'),
    ...(options.limits ? { limits: options.limits } : { drainTimeoutMs: 50 }),
    ...(options.storeFactory ? { storeFactory: options.storeFactory } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  executors.push(executor);
  return { root, accountDir, executor, calls, registry: reg };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met in time');
}

function call(name: string, args: Record<string, unknown>, callId?: string): ToolCallRequest {
  return { ...(callId ? { callId } : {}), name, arguments: args };
}

describe('tool argument validation', () => {
  const schema = {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 8 },
      mode: { type: 'string', enum: ['a', 'b'] },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }
    },
    required: ['text'],
    additionalProperties: false
  };

  it('accepts values inside the bounded subset', () => {
    expect(() => validateToolArguments(schema, { text: 'ok', mode: 'a', count: 2, tags: ['x'] })).not.toThrow();
  });

  it('rejects missing required, extra fields, enums and ranges', () => {
    expect(() => validateToolArguments(schema, {})).toThrow(/required|必填/);
    expect(() => validateToolArguments(schema, { text: 'ok', extra: true })).toThrow(/未声明字段/);
    expect(() => validateToolArguments(schema, { text: 'ok', mode: 'c' })).toThrow(/枚举/);
    expect(() => validateToolArguments(schema, { text: 'ok', count: 9 })).toThrow(/最大值/);
    expect(() => validateToolArguments(schema, { text: 'ok', tags: [] })).toThrow(/下限/);
    expect(() => validateToolArguments(schema, { text: 'ok', tags: ['a', 'b', 'c'] })).toThrow(/上限/);
  });

  it('rejects reserved keys and excessive nesting without echoing values', () => {
    expect(() => validateToolArguments(schema, JSON.parse('{"text":"ok","__proto__":{"bad":true}}'))).toThrow(/字段名/);
    let deep: unknown = { text: 'ok' };
    for (let index = 0; index < 12; index += 1) deep = { nested: deep };
    expect(() => validateToolArguments(schema, deep)).toThrow(/嵌套深度/);
  });
});

describe('tool batch preflight', () => {
  it('rejects the whole batch before side effects for unauthorized tools', async () => {
    const { executor, calls } = await setup({ authorized: ['builtin.echo'] });
    const result = await executor.executeBatch([
      call('echo_tool', { value: 'x' }, 'c1'),
      call('action_tool', { value: 'y' }, 'c2')
    ], context());
    expect(result.preflightFailed).toBe(true);
    expect(result.results[0]).toMatchObject({ invocationId: 'c1', status: 'error', errorCode: 'batch_rejected' });
    expect(result.results[1]).toMatchObject({ invocationId: 'c2', status: 'error', errorCode: 'tool_not_authorized' });
    expect(calls).toHaveLength(0);
  });

  it('requires explicit authorization even for capability-less tools', async () => {
    const { executor, calls } = await setup({ authorized: [] });
    const result = await executor.executeBatch([call('echo_tool', { value: 'x' }, 'c1')], context());
    expect(result.results[0]).toMatchObject({ status: 'error', errorCode: 'tool_not_authorized' });
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown tools, duplicate ids, malformed arguments and missing handlers', async () => {
    const { executor, calls } = await setup({
      handlers: { 'builtin.action': undefined }
    });
    const unknown = await executor.executeBatch([call('missing_tool', {}, 'c1')], context());
    expect(unknown.results[0]?.errorCode).toBe('unknown_tool');

    const duplicate = await executor.executeBatch([
      call('echo_tool', { value: 'a' }, 'same'),
      call('echo_tool', { value: 'b' }, 'same')
    ], context());
    expect(duplicate.results.map((entry) => entry.errorCode)).toEqual(['duplicate_call_id', 'duplicate_call_id']);

    const malformed = await executor.executeBatch([call('echo_tool', { value: 7 }, 'c1')], context());
    expect(malformed.results[0]?.errorCode).toBe('invalid_arguments');

    const stringArgs = await executor.executeBatch([{ callId: 'c1', name: 'echo_tool', arguments: '{"value":"x"}' }], context());
    expect(stringArgs.results[0]?.errorCode).toBe('invalid_arguments');

    const missingHandler = await executor.executeBatch([call('action_tool', { value: 'x' }, 'c1')], context());
    expect(missingHandler.results[0]?.errorCode).toBe('handler_not_ready');
    expect(calls).toHaveLength(0);
  });

  it('rejects over-budget batches and oversized arguments without executing', async () => {
    const { executor, calls } = await setup();
    const over = await executor.executeBatch([
      call('echo_tool', { value: 'a' }, '1'),
      call('echo_tool', { value: 'b' }, '2'),
      call('echo_tool', { value: 'c' }, '3'),
      call('echo_tool', { value: 'd' }, '4'),
      call('echo_tool', { value: 'e' }, '5')
    ], context());
    expect(over.results.every((entry) => entry.errorCode === 'tool_call_limit')).toBe(true);

    const oversized = await executor.executeBatch([call('echo_tool', { value: 'x'.repeat(17_000) }, '1')], context());
    expect(oversized.results[0]?.errorCode).toBe('arguments_too_large');
    expect(calls).toHaveLength(0);
  });
});

describe('tool batch execution', () => {
  it('executes admitted calls in order and pairs every result', async () => {
    const { executor, calls } = await setup();
    const result = await executor.executeBatch([
      call('echo_tool', { value: 'one' }, 'c1'),
      call('echo_tool', { value: 'two' }, 'c2')
    ], context());
    expect(result.executed).toBe(2);
    expect(result.results).toMatchObject([
      { invocationId: 'c1', status: 'ok', text: 'one' },
      { invocationId: 'c2', status: 'ok', text: 'two' }
    ]);
    expect(calls.map((entry) => entry.args.value)).toEqual(['one', 'two']);
  });

  it('keeps later failures truthful after an earlier action succeeded', async () => {
    let actionAttempts = 0;
    const { executor, calls } = await setup({
      handlers: {
        'builtin.action': () => {
          actionAttempts += 1;
          throw new ToolExecutionError('action_failed', '动作失败');
        }
      }
    });
    const result = await executor.executeBatch([
      call('echo_tool', { value: 'first' }, 'c1'),
      call('action_tool', { value: 'second' }, 'c2')
    ], context());
    expect(result.preflightFailed).toBe(false);
    expect(result.results[0]).toMatchObject({ status: 'ok', text: 'first' });
    expect(result.results[1]).toMatchObject({ status: 'error', errorCode: 'action_failed' });
    expect(result.executed).toBe(2);
    expect(actionAttempts).toBe(1);
    expect(calls.map((entry) => entry.toolId)).toEqual(['builtin.echo']);
  });

  it('bounds per-call results and stops before side effects when the round budget is gone', async () => {
    const { executor, calls } = await setup();
    const bounded = await executor.executeBatch([call('big_tool', {}, 'c1')], context());
    expect(bounded.results[0]?.status).toBe('ok');
    expect(bounded.results[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.results[0]?.text ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024);

    const second = await executor.executeBatch([
      call('big_tool', {}, 'c1'),
      call('echo_tool', { value: 'after' }, 'c2')
    ], context({ messageId: 'm2', remainingResultBytes: 1_000 }));
    expect(second.results[0]?.truncated).toBe(true);
    expect(second.results[1]?.errorCode).toBe('round_budget_exhausted');
    const echoCalls = calls.filter((entry) => entry.toolId === 'builtin.echo');
    expect(echoCalls).toHaveLength(0);
  });
});

describe('tool action ledger', () => {
  it('writes intent before running and replays the terminal result', async () => {
    const { executor, accountDir, calls } = await setup();
    const batch = [call('action_tool', { value: 'ARG_SECRET_7f' }, 'a1')];
    const first = await executor.executeBatch(batch, context());
    expect(first.results[0]).toMatchObject({ status: 'ok', text: 'done' });
    expect(calls).toHaveLength(1);

    const replay = await executor.executeBatch(batch, context());
    expect(replay.replayed).toBe(1);
    expect(replay.executed).toBe(0);
    expect(replay.results[0]).toMatchObject({ status: 'ok', text: 'done' });
    expect(calls).toHaveLength(1);

    const conflict = await executor.executeBatch([call('action_tool', { value: 'two' }, 'a1')], context());
    expect(conflict.results[0]?.errorCode).toBe('invocation_conflict');
    expect(calls).toHaveLength(1);

    await executor.drain();
    const ledger = JSON.parse(await fs.readFile(toolLedgerPath(accountDir), 'utf8')) as { entries: unknown[] };
    expect(ledger.entries).toHaveLength(1);
    expect(JSON.stringify(ledger)).not.toContain('ARG_SECRET_7f');
    expect(JSON.stringify(ledger)).toContain(toolArgumentDigest({ value: 'ARG_SECRET_7f' }));
  });

  it('replays from disk after a restart without rerunning the action', async () => {
    const first = await setup();
    const batch = [call('action_tool', { value: 'one' }, 'a1')];
    await first.executor.executeBatch(batch, context());
    await first.executor.close();
    executors.splice(executors.indexOf(first.executor), 1);

    const second = new ToolExecutor({
      view: () => ({ tools: first.registry.listTools(), authorized: new Set(['builtin.action']) }),
      handlers: () => ({ generation: 'g1', handler: () => ({ status: 'ok', text: 'should-not-run' }) }),
      accountDir: () => first.accountDir,
      logger: silentLogger('tool-executor-test'),
      limits: { drainTimeoutMs: 50 }
    });
    executors.push(second);
    const replay = await second.executeBatch(batch, context());
    expect(replay.replayed).toBe(1);
    expect(replay.results[0]).toMatchObject({ status: 'ok', text: 'done' });
  });

  it('fails closed when the started intent cannot be written', async () => {
    const failingStore = {
      begin: async () => { throw new AccompanyError('tool_ledger_full', 'ledger full'); },
      complete: async () => { throw new Error('unexpected complete'); },
      markUnknown: async () => {},
      close: async () => {},
      drain: async () => {}
    } as unknown as ToolInvocationStore;
    const { executor, calls } = await setup({ storeFactory: async () => failingStore });
    const result = await executor.executeBatch([call('action_tool', { value: 'x' }, 'a1')], context());
    expect(result.results[0]).toMatchObject({ status: 'error', errorCode: 'tool_ledger_full' });
    expect(calls).toHaveLength(0);
  });

  it('treats an unreadable ledger as unavailable', async () => {
    const { executor, accountDir, calls } = await setup();
    await fs.mkdir(path.dirname(toolLedgerPath(accountDir)), { recursive: true });
    await fs.writeFile(toolLedgerPath(accountDir), '{not-json', 'utf8');
    const result = await executor.executeBatch([call('action_tool', { value: 'x' }, 'a1')], context());
    expect(result.results[0]?.errorCode).toBe('tool_ledger_corrupt');
    expect(calls).toHaveLength(0);
  });

  it('recovers interrupted actions as unknown and never reruns them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-tool-ledger-'));
    roots.push(root);
    const file = toolLedgerPath(root);
    const key = toolInvocationKey({
      accountId: '10001',
      kind: 'private',
      peerId: '42',
      messageId: 'm1',
      turn: 0,
      index: 0,
      callId: 'a1',
      toolId: 'builtin.action'
    });
    const started = {
      version: 1,
      entries: [{
        key,
        invocationId: 'a1',
        accountId: '10001',
        kind: 'private',
        peerId: '42',
        messageId: 'm1',
        turn: 0,
        index: 0,
        toolId: 'builtin.action',
        effect: 'action',
        handlerGeneration: 'g1',
        argumentDigest: toolArgumentDigest({ value: 'one' }),
        status: 'started',
        startedAt: 1,
        updatedAt: 1
      }]
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(started), 'utf8');
    const store = await ToolInvocationStore.load(file, silentLogger(), () => 2);
    const begin = await store.begin({
      key,
      invocationId: 'a1',
      scope: { accountId: '10001', kind: 'private', peerId: '42', messageId: 'm1', turn: 0, index: 0 },
      toolId: 'builtin.action',
      effect: 'action',
      handlerGeneration: 'g1',
      argumentDigest: toolArgumentDigest({ value: 'one' }),
      at: 2
    });
    expect(begin.kind).toBe('unknown');
    expect(store.snapshot()[0]).toMatchObject({ status: 'unknown', result: { errorCode: 'interrupted' } });
    await store.close();
  });

  it('retains only bounded terminal receipts and keeps unknown actions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-tool-ledger-'));
    roots.push(root);
    const file = toolLedgerPath(root);
    let now = 1_000;
    const store = await ToolInvocationStore.load(file, silentLogger(), () => now);
    const insert = async (index: number, effect: 'read' | 'action', complete: boolean): Promise<string> => {
      const key = toolInvocationKey({
        accountId: '10001',
        kind: 'private',
        peerId: '42',
        messageId: 'm1',
        turn: 0,
        index,
        callId: `c${index}`,
        toolId: effect === 'action' ? 'builtin.action' : 'builtin.echo'
      });
      await store.begin({
        key,
        invocationId: `c${index}`,
        scope: { accountId: '10001', kind: 'private', peerId: '42', messageId: 'm1', turn: 0, index },
        toolId: effect === 'action' ? 'builtin.action' : 'builtin.echo',
        effect,
        handlerGeneration: 'g1',
        argumentDigest: toolArgumentDigest({ index }),
        at: now
      });
      if (complete) {
        await store.complete(key, { invocationId: `c${index}`, status: 'ok', text: 'ok' }, now);
      }
      return key;
    };

    const unknownKey = await insert(0, 'action', false);
    for (let index = 1; index <= 260; index += 1) await insert(index, 'read', true);
    const snapshot = store.snapshot();
    expect(snapshot.filter((entry) => entry.status === 'ok')).toHaveLength(256);
    expect(snapshot.find((entry) => entry.key === unknownKey)?.status).toBe('started');

    now += 8 * 24 * 60 * 60 * 1_000;
    await store.close();
    const reloaded = await ToolInvocationStore.load(file, silentLogger(), () => now);
    expect(reloaded.snapshot().filter((entry) => entry.status === 'ok')).toHaveLength(0);
    expect(reloaded.snapshot().find((entry) => entry.key === unknownKey)?.status).toBe('unknown');
    await reloaded.close();
  });

  it('isolates the same invocation identity across accounts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-tool-exec-'));
    roots.push(root);
    const reg = registry();
    let count = 0;
    const executor = new ToolExecutor({
      view: () => ({ tools: reg.listTools(), authorized: new Set(['builtin.action']) }),
      handlers: () => ({ generation: 'g1', handler: () => { count += 1; return { status: 'ok', text: 'done' }; } }),
      accountDir: (accountId) => path.join(root, 'accounts', accountId),
      logger: silentLogger('tool-executor-test'),
      limits: { drainTimeoutMs: 50 }
    });
    executors.push(executor);
    const batch = [call('action_tool', { value: 'one' }, 'a1')];
    await executor.executeBatch(batch, context({ accountId: '10001', conversation: { accountId: '10001', kind: 'private', peerId: '42' } }));
    await executor.executeBatch(batch, context({ accountId: '10002', conversation: { accountId: '10002', kind: 'private', peerId: '42' } }));
    expect(count).toBe(2);
  });
});

describe('tool guards, timeout and shutdown', () => {
  it('revalidates guards after the action intent and performs zero side effects', async () => {
    const sequence = [true, true, false];
    const { executor, calls } = await setup();
    const result = await executor.executeBatch([call('action_tool', { value: 'x' }, 'a1')], context({
      guard: () => sequence.shift() ?? false
    }));
    expect(result.results[0]).toMatchObject({ status: 'error', errorCode: 'guard_changed' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a call when the handler generation changes after preflight', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-tool-exec-'));
    roots.push(root);
    const reg = registry();
    let resolverCalls = 0;
    let executed = 0;
    const executor = new ToolExecutor({
      view: () => ({ tools: reg.listTools(), authorized: new Set(['builtin.action']) }),
      handlers: () => {
        resolverCalls += 1;
        return {
          generation: resolverCalls === 1 ? 'g1' : 'g2',
          handler: () => { executed += 1; return { status: 'ok', text: 'done' }; }
        };
      },
      accountDir: (accountId) => path.join(root, 'accounts', accountId),
      logger: silentLogger('tool-executor-test'),
      limits: { drainTimeoutMs: 50 }
    });
    executors.push(executor);
    const result = await executor.executeBatch([call('action_tool', { value: 'x' }, 'a1')], context());
    expect(result.results[0]?.errorCode).toBe('handler_changed');
    expect(executed).toBe(0);
  });

  it('rejects a replay when the role epoch changed', async () => {
    const { executor, calls } = await setup();
    const batch = [call('action_tool', { value: 'x' }, 'a1')];
    const first = await executor.executeBatch(batch, context({ contextEpoch: 'role:public:demo:1' }));
    expect(first.results[0]?.status).toBe('ok');
    const stale = await executor.executeBatch(batch, context({ contextEpoch: 'role:public:demo:2' }));
    expect(stale.results[0]?.errorCode).toBe('invocation_conflict');
    expect(calls).toHaveLength(1);
  });

  it('refuses a new action before execution when the ledger file is full', async () => {
    const original = TOOL_LEDGER_LIMITS.maxFileBytes;
    (TOOL_LEDGER_LIMITS as { maxFileBytes: number }).maxFileBytes = 64;
    try {
      const { executor, calls } = await setup();
      const result = await executor.executeBatch([call('action_tool', { value: 'x' }, 'a1')], context());
      expect(result.results[0]).toMatchObject({ status: 'error', errorCode: 'tool_ledger_full' });
      expect(calls).toHaveLength(0);
    } finally {
      (TOOL_LEDGER_LIMITS as { maxFileBytes: number }).maxFileBytes = original;
    }
  });

  it('does not expose arbitrary handler errors', async () => {
    const { executor } = await setup({
      handlers: {
        'builtin.action': () => { throw new Error('secret path /Users/me/token Bearer abc123'); }
      }
    });
    const result = await executor.executeBatch([call('action_tool', { value: 'x' }, 'a1')], context());
    expect(result.results[0]).toMatchObject({ status: 'error', errorCode: 'tool_failed', text: '工具执行失败。' });
  });

  it('marks timed-out actions unknown and never replays them', async () => {
    let slowCalls = 0;
    const { executor } = await setup({
      handlers: {
        'builtin.slow': () => {
          slowCalls += 1;
          return new Promise(() => {});
        }
      },
      limits: { toolTimeoutMs: 100, drainTimeoutMs: 20 }
    });
    const batch = [call('slow_tool', {}, 's1')];
    const first = await executor.executeBatch(batch, context());
    expect(first.results[0]).toMatchObject({ status: 'unknown', errorCode: 'tool_timeout' });
    expect(slowCalls).toBe(1);
    const replay = await executor.executeBatch(batch, context());
    expect(replay.results[0]?.errorCode).toBe('invocation_unknown');
    expect(slowCalls).toBe(1);
  });

  it('stops admissions on close and ignores a late action success', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: { status: 'ok'; text: string }) => void;
    const late = new Promise<{ status: 'ok'; text: string }>((resolve) => { finish = resolve; });
    const { executor, accountDir } = await setup({
      handlers: {
        'builtin.slow': () => {
          started();
          return late;
        }
      },
      limits: { drainTimeoutMs: 20 }
    });
    const pending = executor.executeBatch([call('slow_tool', {}, 's1')], context());
    await entered;
    await executor.close();
    executors.splice(executors.indexOf(executor), 1);
    const result = await pending;
    expect(result.results[0]).toMatchObject({ status: 'unknown', errorCode: 'executor_closed' });

    finish({ status: 'ok', text: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const ledger = JSON.parse(await fs.readFile(toolLedgerPath(accountDir), 'utf8')) as {
      entries: Array<{ status: string }>;
    };
    expect(ledger.entries[0]?.status).toBe('unknown');

    const closed = await executor.executeBatch([call('slow_tool', {}, 's2')], context());
    expect(closed.results[0]?.errorCode).toBe('executor_closed');
  });

  it('bounds global/account concurrency and rejects a full queue', async () => {
    const limiter = new ToolConcurrencyLimiter({ global: 2, perAccount: 1, queue: 1 });
    const releaseA = await limiter.acquire('a');
    const releaseB = await limiter.acquire('b');
    const queued = limiter.acquire('a');
    await expect(limiter.acquire('c')).rejects.toMatchObject({ code: 'tool_queue_full' });
    releaseA();
    const releaseA2 = await queued;
    releaseA2();
    releaseB();
    await limiter.idle();

    const releaseC = await limiter.acquire('c');
    const controller = new AbortController();
    const queuedAbort = limiter.acquire('c', controller.signal);
    controller.abort();
    await expect(queuedAbort).rejects.toBeTruthy();
    releaseC();
    limiter.close();
  });
});

describe('ledger result preview', () => {
  it('keeps a bounded replay preview without unbounded data', async () => {
    const { executor, accountDir } = await setup();
    const batch = [call('big_tool', {}, 'b1')];
    await executor.executeBatch(batch, context());
    await executor.drain();
    const raw = await fs.readFile(toolLedgerPath(accountDir), 'utf8');
    const parsed = JSON.parse(raw) as { entries: Array<{ result?: { text?: string; data?: unknown; truncated?: boolean } }> };
    const stored = parsed.entries[0]?.result;
    expect(stored?.truncated).toBe(true);
    expect(Buffer.byteLength(stored?.text ?? '', 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(stored?.data).toBeUndefined();

    const replay = await executor.executeBatch(batch, context());
    expect(replay.results[0]?.status).toBe('ok');
    expect(replay.results[0]?.truncated).toBe(true);
  });
});
