import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { bindTestConversation, createTestCore as createCore } from './helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import type { CoreEvents } from '../src/core/events.js';
import type { CoreOptions } from '../src/core/options.js';
import type { AgentHost } from '../src/host/contract.js';
import { textMessage } from '../src/routing/message.js';
import { JsonlStore } from '../src/storage/jsonl-store.js';
import type { MessageStore } from '../src/storage/contract.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met in time');
}

async function setup(
  host: AgentHost,
  options: { storeFactory?: CoreOptions['storeFactory'] } = {}
): Promise<{ core: Core; channels: Map<string, FakeChannel>; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-host-'));
  roots.push(root);
  const channels = new Map<string, FakeChannel>();
  const core = await createCore({
    dataRoot: root,
    instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
    ...(options.storeFactory ? { storeFactory: options.storeFactory } : {}),
    channelFactory: (context) => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      channels.set(context.instanceId, channel);
      return channel;
    },
    host,
    logger: silentLogger('host-test')
  });
  cores.push(core);
  await bindTestConversation(core, '10001', 'private', '555');
  await core.start();
  return { core, channels, root };
}

describe('AgentHost', () => {
  it('receives persisted inbound messages and sends returned replies through the session', async () => {
    const lifecycle: string[] = [];
    const host: AgentHost = {
      onSessionStart: (context) => {
        lifecycle.push(`start:${context.accountId}`);
      },
      onSessionStop: () => {
        lifecycle.push('stop');
      },
      onMessage: (context, event) => {
        lifecycle.push(`message:${context.conversation.peerId}:${event.messageId}`);
        return textMessage('pong');
      },
      dispose: () => {
        lifecycle.push('dispose');
      }
    };
    const { core, channels, root } = await setup(host);
    await waitFor(() => lifecycle.includes('start:10001'));

    channels.get('main')?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: '42',
      at: 1,
      segments: [{ type: 'text', data: { text: 'ping' } }],
      selfEcho: false
    });

    let outboundSeq: number | undefined;
    const offOutbound = core.bus.on('channel:outbound', (event) => {
      if (event.conversation.kind === 'private' && event.conversation.peerId === '555' && event.seq !== undefined) {
        outboundSeq = event.seq;
      }
    });
    await waitFor(() => (channels.get('main')?.sent.length ?? 0) === 1 && outboundSeq !== undefined);
    offOutbound();
    expect(outboundSeq).toBeGreaterThan(0);
    expect(lifecycle).toContain('message:555:42');
    expect(channels.get('main')?.sent[0]?.conversation).toEqual({
      accountId: '10001',
      kind: 'private',
      peerId: '555'
    });
    expect(channels.get('main')?.sent[0]?.message.segments).toEqual([{ type: 'text', data: { text: 'pong' } }]);

    const file = path.join(root, 'accounts', '10001', 'messages', 'private', '555', '000001.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).direction).sort()).toEqual(['in', 'out']);

    await core.stop();
    expect(core.status().instances[0]?.state).toBe('stopped');
    expect(lifecycle).toContain('stop');
    expect(lifecycle).toContain('dispose');
  });

  it('does not expose outbound history before the store append settles', async () => {
    const conversation = { accountId: '10001', kind: 'private' as const, peerId: '555' };
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let appendStarted!: () => void;
    const appendStartedPromise = new Promise<void>((resolve) => { appendStarted = resolve; });
    const host: AgentHost = { onMessage: () => textMessage('pong') };
    const { core, channels } = await setup(host, {
      storeFactory: (_spec, accountDir): MessageStore => {
        const inner = new JsonlStore({
          root: path.join(accountDir, 'messages'),
          accountId: '10001',
          logger: silentLogger('host-gated-store')
        });
        return {
          async append(target, message) {
            if (message.direction === 'out') {
              appendStarted();
              await appendGate;
            }
            return inner.append(target, message);
          },
          read: (target, readOptions) => inner.read(target, readOptions),
          lastSeq: (target) => inner.lastSeq(target),
          readRange: (target, rangeOptions) => inner.readRange(target, rangeOptions),
          dispose: () => inner.dispose()
        };
      }
    });
    let outboundSeq: number | undefined;
    core.bus.on('channel:outbound', (event) => { outboundSeq = event.seq; });

    channels.get('main')?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: 'gated-1',
      at: 1,
      segments: [{ type: 'text', data: { text: 'ping' } }],
      selfEcho: false
    });
    await appendStartedPromise;
    expect(channels.get('main')?.sent).toHaveLength(1);
    expect(outboundSeq).toBeUndefined();
    expect((await core.readMessages('10001', conversation)).map((message) => message.direction)).toEqual(['in']);

    releaseAppend();
    await waitFor(async () => outboundSeq !== undefined
      && (await core.readMessages('10001', conversation)).some((message) => message.direction === 'out'));
    expect((await core.readMessages('10001', conversation)).map((message) => message.direction)).toEqual(['in', 'out']);
  });

  it('does not treat a pending asynchronous predicate as satisfied', async () => {
    let ready = false;
    let checks = 0;
    let settled = false;
    const pending = waitFor(async () => {
      checks += 1;
      return ready;
    }, 1_000);
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checks).toBeGreaterThan(0);
    expect(settled).toBe(false);
    ready = true;
    await pending;
    expect(settled).toBe(true);
  });

  it('times out a hung host call without failing the session', async () => {
    const host: AgentHost = {
      onMessage: () => new Promise(() => {})
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-host-timeout-'));
    roots.push(root);
    const channels = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: (context) => {
        const channel = new FakeChannel(context, { selfId: context.spec.accountId });
        channels.set(context.instanceId, channel);
        return channel;
      },
      host,
      limits: { hostTimeoutMs: 20 },
      logger: silentLogger('host-test')
    });
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await core.start();
    const errors: CoreEvents['instance:error'][] = [];
    core.bus.on('instance:error', (event) => errors.push(event));

    channels.get('main')?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: '44',
      at: 1,
      segments: [{ type: 'text', data: { text: 'ping' } }],
      selfEcho: false
    });

    await waitFor(() => errors.some((event) => event.code === 'host_timeout'));
    expect(core.status().instances[0]?.state).toBe('online');
  });

  it('isolates host failures from the session state', async () => {
    const host: AgentHost = {
      onMessage: () => {
        throw new Error('host exploded');
      }
    };
    const { core, channels } = await setup(host);
    const errors: CoreEvents['instance:error'][] = [];
    core.bus.on('instance:error', (event) => errors.push(event));

    channels.get('main')?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: '43',
      at: 1,
      segments: [{ type: 'text', data: { text: 'ping' } }],
      selfEcho: false
    });

    await waitFor(() => errors.some((event) => event.code === 'host_failed'));
    expect(core.status().instances[0]?.state).toBe('online');
    expect(channels.get('main')?.sent).toHaveLength(0);
  });
});
