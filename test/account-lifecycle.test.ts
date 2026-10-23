import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { bindTestConversation, createTestCore as createCore } from './helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import type { CoreEvents } from '../src/core/events.js';
import type { AgentHost } from '../src/host/contract.js';
import { textMessage } from '../src/routing/message.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function mutableChannels(
  selfIds: Map<string, string>,
  bucket: Map<string, FakeChannel>
): ChannelFactory {
  return (context) => {
    const channel = new FakeChannel(context, { selfId: selfIds.get(context.instanceId) });
    bucket.set(context.instanceId, channel);
    return channel;
  };
}

function inbound(instanceId: string, selfId: string, peerId: string, messageId: string) {
  return {
    type: 'message' as const,
    instanceId,
    selfId,
    kind: 'private' as const,
    peerId,
    senderId: peerId,
    messageId,
    at: 1,
    segments: [{ type: 'text' as const, data: { text: 'ping' } }],
    selfEcho: false
  };
}

describe('account lifecycle', () => {
  it('rebinds a stopped slot to another QQ and keeps account data apart', async () => {
    const root = await tempRoot('accompany-switch-');
    const selfIds = new Map([['main', '10001']]);
    const channels = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake' }],
      channelFactory: mutableChannels(selfIds, channels),
      logger: silentLogger()
    }, ['10001', '10002']);
    cores.push(core);

    await core.start();
    expect(core.status().instances[0]).toMatchObject({ accountId: '10001', state: 'online' });
    await core.send('main', { accountId: '10001', kind: 'private', peerId: '555' }, textMessage('as 10001'));

    await core.stopInstance('main');
    expect(core.status().instances[0]).toMatchObject({ state: 'stopped' });
    expect(core.status().instances[0]?.accountId).toBeUndefined();

    selfIds.set('main', '10002');
    await core.startInstance('main');
    expect(core.status().instances[0]).toMatchObject({ accountId: '10002', state: 'online' });
    await core.send('main', { accountId: '10002', kind: 'private', peerId: '555' }, textMessage('as 10002'));

    const fileA = path.join(root, 'accounts', '10001', 'messages', 'private', '555', '000001.jsonl');
    const fileB = path.join(root, 'accounts', '10002', 'messages', 'private', '555', '000001.jsonl');
    expect(JSON.parse((await fs.readFile(fileA, 'utf8')).trim())).toMatchObject({
      direction: 'out',
      segments: [{ type: 'text', data: { text: 'as 10001' } }]
    });
    expect(JSON.parse((await fs.readFile(fileB, 'utf8')).trim())).toMatchObject({
      direction: 'out',
      segments: [{ type: 'text', data: { text: 'as 10002' } }]
    });
  });

  it('releases the account lease on stop so another slot can bind it', async () => {
    const root = await tempRoot('accompany-lease-');
    const selfIds = new Map([
      ['a', '10001'],
      ['b', '10002']
    ]);
    const channels = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [
        { id: 'a', backend: 'fake' },
        { id: 'b', backend: 'fake' }
      ],
      channelFactory: mutableChannels(selfIds, channels),
      logger: silentLogger()
    }, ['10001', '10002']);
    cores.push(core);

    await core.stopInstance('b');
    await core.start();
    expect(core.status().instances.find((item) => item.id === 'a')).toMatchObject({
      accountId: '10001',
      state: 'online'
    });

    await core.stopInstance('a');
    selfIds.set('b', '10001');
    await core.startInstance('b');
    expect(core.status().instances.find((item) => item.id === 'b')).toMatchObject({
      accountId: '10001',
      state: 'online'
    });
    await core.send('b', { accountId: '10001', kind: 'private', peerId: '777' }, textMessage('takeover'));
  });

  it('drains queued inbound work and lets the host reply before disconnect', async () => {
    const root = await tempRoot('accompany-drain-');
    const selfIds = new Map([['main', '10001']]);
    const channels = new Map<string, FakeChannel>();
    let hostRan = false;
    const host: AgentHost = {
      onMessage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        hostRan = true;
        return textMessage('drained');
      }
    };
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake' }],
      channelFactory: mutableChannels(selfIds, channels),
      host,
      logger: silentLogger()
    }, ['10001']);
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await core.start();

    const channel = channels.get('main');
    channel?.emitInbound(inbound('main', '10001', '555', 'drain-1'));
    await core.stopInstance('main');

    expect(hostRan).toBe(true);
    expect(channel?.sent).toHaveLength(1);
    const file = path.join(root, 'accounts', '10001', 'messages', 'private', '555', '000001.jsonl');
    const directions = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).direction)
      .sort();
    expect(directions).toEqual(['in', 'out']);
    expect(core.status().instances[0]?.state).toBe('stopped');
  });

  it('bounds the drain and reports discarded work when the host hangs', async () => {
    const root = await tempRoot('accompany-drain-timeout-');
    const selfIds = new Map([['main', '10001']]);
    const channels = new Map<string, FakeChannel>();
    const host: AgentHost = {
      onMessage: () => new Promise(() => {})
    };
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake' }],
      channelFactory: mutableChannels(selfIds, channels),
      host,
      limits: { drainTimeoutMs: 20, hostTimeoutMs: 5_000 },
      logger: silentLogger()
    }, ['10001']);
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await core.start();

    const errors: CoreEvents['instance:error'][] = [];
    core.bus.on('instance:error', (event) => errors.push(event));
    channels.get('main')?.emitInbound(inbound('main', '10001', '555', 'drain-timeout-1'));

    const startedAt = Date.now();
    await core.stopInstance('main');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(errors.some((event) => event.code === 'drain_timeout')).toBe(true);
    expect(core.status().instances[0]?.state).toBe('stopped');
  });
});
