import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { createTestCore as createCore } from './helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { IsolationError } from '../src/core/errors.js';
import { textMessage } from '../src/routing/message.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import type { CoreEvents } from '../src/core/events.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met in time');
}

function captureChannels(bucket: Map<string, FakeChannel>): ChannelFactory {
  return (context) => {
    const channel = new FakeChannel(context, { selfId: context.spec.accountId });
    bucket.set(context.instanceId, channel);
    return channel;
  };
}

async function makeCore(options: {
  dataRoot: string;
  instances: Array<{ id: string; accountId: string }>;
  channels: Map<string, FakeChannel>;
}): Promise<Core> {
  const core = await createCore({
    dataRoot: options.dataRoot,
    instances: options.instances.map((instance) => ({
      id: instance.id,
      backend: 'fake' as const,
      accountId: instance.accountId,
      selfIds: [instance.accountId]
    })),
    channelFactory: captureChannels(options.channels),
    logger: silentLogger('core')
  });
  cores.push(core);
  return core;
}

describe('multi-core and multi-instance isolation', () => {
  it('keeps two cores on the same machine completely separate', async () => {
    const rootA = await tempRoot('accompany-core-a-');
    const rootB = await tempRoot('accompany-core-b-');
    const channelsA = new Map<string, FakeChannel>();
    const channelsB = new Map<string, FakeChannel>();
    const coreA = await makeCore({ dataRoot: rootA, instances: [{ id: 'main', accountId: '10001' }], channels: channelsA });
    const coreB = await makeCore({ dataRoot: rootB, instances: [{ id: 'main', accountId: '20002' }], channels: channelsB });

    await coreA.start();
    await coreB.start();

    expect(coreA).not.toBe(coreB);
    expect(coreA.status().dataRoot).not.toBe(coreB.status().dataRoot);
    expect(coreA.status().instances[0]?.state).toBe('online');
    expect(coreB.status().instances[0]?.accountId).toBe('20002');

    await coreA.send('main', { accountId: '10001', kind: 'private', peerId: '555' }, textMessage('from A'));
    expect(channelsA.get('main')?.sent).toHaveLength(1);
    expect(channelsB.get('main')?.sent).toHaveLength(0);

    const sentA = await fs.readdir(path.join(rootA, 'accounts', '10001', 'messages', 'private'));
    expect(sentA).toEqual(['555']);
    expect(await fs.readdir(path.join(rootA, 'accounts', '10001', 'messages', 'private', '555'))).toEqual(['000001.jsonl']);
    await expect(fs.access(path.join(rootB, 'accounts', '20002', 'messages', 'private'))).rejects.toThrow();

    await coreA.stop();
    expect(coreB.status().instances[0]?.state).toBe('online');
  });

  it('refuses to send as an account the instance does not own', async () => {
    const root = await tempRoot('accompany-core-');
    const channels = new Map<string, FakeChannel>();
    const core = await makeCore({ dataRoot: root, instances: [{ id: 'main', accountId: '10001' }], channels });
    await core.start();

    await expect(
      core.send('main', { accountId: '20002', kind: 'private', peerId: '555' }, textMessage('nope'))
    ).rejects.toBeInstanceOf(IsolationError);
    expect(channels.get('main')?.sent).toHaveLength(0);
  });

  it('gives every instance in one core its own channel, account and data dir', async () => {
    const root = await tempRoot('accompany-core-');
    const channels = new Map<string, FakeChannel>();
    const core = await makeCore({
      dataRoot: root,
      instances: [
        { id: 'a', accountId: '10001' },
        { id: 'b', accountId: '20002' }
      ],
      channels
    });
    await core.start();

    await core.send('a', { accountId: '10001', kind: 'group', peerId: '777' }, textMessage('hi group'));
    await core.send('b', { accountId: '20002', kind: 'private', peerId: '888' }, textMessage('hi friend'));

    expect(channels.get('a')?.sent).toHaveLength(1);
    expect(channels.get('b')?.sent).toHaveLength(1);
    expect((await fs.readdir(path.join(root, 'accounts'))).sort()).toEqual(['10001', '20002']);
    await expect(
      core.send('a', { accountId: '20002', kind: 'private', peerId: '888' }, textMessage('cross'))
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it('does not leak bus events between cores', async () => {
    const rootA = await tempRoot('accompany-core-a-');
    const rootB = await tempRoot('accompany-core-b-');
    const channelsA = new Map<string, FakeChannel>();
    const channelsB = new Map<string, FakeChannel>();
    const coreA = await makeCore({ dataRoot: rootA, instances: [{ id: 'main', accountId: '10001' }], channels: channelsA });
    const coreB = await makeCore({ dataRoot: rootB, instances: [{ id: 'main', accountId: '20002' }], channels: channelsB });
    await coreA.start();
    await coreB.start();

    const eventsA: CoreEvents['channel:outbound'][] = [];
    const eventsB: CoreEvents['channel:outbound'][] = [];
    coreA.bus.on('channel:outbound', (event) => eventsA.push(event));
    coreB.bus.on('channel:outbound', (event) => eventsB.push(event));

    await coreA.send('main', { accountId: '10001', kind: 'private', peerId: '555' }, textMessage('only A'));
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(0);
  });

  it('archives inbound messages in the instance namespace and emits them', async () => {
    const root = await tempRoot('accompany-core-');
    const channels = new Map<string, FakeChannel>();
    const core = await makeCore({ dataRoot: root, instances: [{ id: 'main', accountId: '10001' }], channels });
    await core.start();

    const inbound: CoreEvents['channel:inbound'][] = [];
    core.bus.on('channel:inbound', (event) => inbound.push(event));
    channels.get('main')?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: '9',
      at: 1,
      segments: [{ type: 'text', data: { text: 'hello' } }],
      selfEcho: false
    });

    await waitFor(() => inbound.length === 1);
    expect(inbound).toHaveLength(1);
    const file = path.join(root, 'accounts', '10001', 'messages', 'private', '555', '000001.jsonl');
    await waitFor(async () => {
      try {
        await fs.access(file);
        return true;
      } catch {
        return false;
      }
    });
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ direction: 'in', messageId: '9' });
  });
});
