import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { bindTestConversation, createTestCore as createCore } from './helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import type { CoreEvents } from '../src/core/events.js';
import type { AgentHost } from '../src/host/contract.js';
import { textMessage } from '../src/routing/message.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met in time');
}

async function setup(host: AgentHost): Promise<{ core: Core; channels: Map<string, FakeChannel>; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-host-'));
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

    await waitFor(() => (channels.get('main')?.sent.length ?? 0) === 1);
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
