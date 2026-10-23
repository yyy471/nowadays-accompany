import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { createTestCore as createCore } from './helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { textMessage } from '../src/routing/message.js';
import type { InjectionBackend, BackendStatus, ProbeReport, RuntimeEndpoints } from '../src/injection/contract.js';
import type { ChannelContext } from '../src/channels/contract.js';

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

function fakeChannels(bucket: Map<string, FakeChannel>) {
  return (context: ChannelContext) => {
    const channel = new FakeChannel(context, { selfId: context.spec.accountId });
    bucket.set(context.instanceId, channel);
    return channel;
  };
}

class RemoteBackend implements InjectionBackend {
  readonly kind = 'remote';
  readonly capabilities = { launch: true, attach: false, multiInstance: true };
  async probe(): Promise<ProbeReport> {
    return { backend: this.kind, ok: true, warnings: [], instances: [] };
  }
  async start(): Promise<RuntimeEndpoints> {
    return { httpBaseUrl: 'http://example.invalid:3000', wsUrl: 'ws://example.invalid:3001' };
  }
  async stop(): Promise<void> {}
  async status(): Promise<BackendStatus> {
    return { running: true };
  }
}

describe('Core lifecycle guards', () => {
  it('enforces maxInstances', async () => {
    const root = await tempRoot('accompany-limit-');
    await expect(
      createCore({
        dataRoot: root,
        instances: [
          { id: 'a', backend: 'fake', accountId: '10001' },
          { id: 'b', backend: 'fake', accountId: '10002' }
        ],
        limits: { maxInstances: 1 },
        logger: silentLogger()
      })
    ).rejects.toThrow(/max instances/);
  });

  it('refuses two instances owning the same account', async () => {
    const root = await tempRoot('accompany-account-');
    await expect(
      createCore({
        dataRoot: root,
        instances: [
          { id: 'a', backend: 'fake', accountId: '10001' },
          { id: 'b', backend: 'fake', accountId: '10001' }
        ],
        logger: silentLogger()
      })
    ).rejects.toThrow(/already owned/);
  });

  it('locks a data root to a single writer and releases it on stop', async () => {
    const root = await tempRoot('accompany-lock-');
    const first = await createCore({
      dataRoot: root,
      instances: [{ id: 'a', backend: 'fake', accountId: '10001' }],
      logger: silentLogger()
    });
    cores.push(first);
    await expect(
      createCore({ dataRoot: root, instances: [], logger: silentLogger() })
    ).rejects.toThrow(/already locked/);

    await first.stop();
    cores.splice(cores.indexOf(first), 1);
    const second = await createCore({ dataRoot: root, instances: [], logger: silentLogger() });
    cores.push(second);
  });

  it('rejects non-loopback runtime endpoints', async () => {
    const root = await tempRoot('accompany-trust-');
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      backendFactory: () => new RemoteBackend(),
      logger: silentLogger()
    });
    cores.push(core);
    const errors: Array<{ code: string }> = [];
    core.bus.on('instance:error', (event) => errors.push(event));
    await core.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const status = core.status().instances[0];
    expect(status?.state).toBe('failed');
    expect(status?.lastError?.code).toBe('endpoint_non_loopback');
    expect(status?.lastError?.retryable).toBe(false);
    expect(status?.restartAttempts).toBe(0);
    expect(errors.some((event) => event.code === 'restart_suppressed')).toBe(true);
  });

  it('restores desired=stopped across a process restart', async () => {
    const root = await tempRoot('accompany-desired-');
    const channelsA = new Map<string, FakeChannel>();
    const first = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: fakeChannels(channelsA),
      logger: silentLogger()
    });
    cores.push(first);
    await first.start();
    await first.stopInstance('main');
    expect(first.status().instances[0]).toMatchObject({ state: 'stopped', desiredState: 'stopped' });
    await first.stop();
    cores.splice(cores.indexOf(first), 1);

    const channelsB = new Map<string, FakeChannel>();
    const second = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: fakeChannels(channelsB),
      logger: silentLogger()
    });
    cores.push(second);
    await second.start();
    expect(second.status().instances[0]).toMatchObject({ state: 'stopped', desiredState: 'stopped' });
    expect(channelsB.size).toBe(0);

    await second.startInstance('main');
    expect(second.status().instances[0]?.state).toBe('online');
    expect(channelsB.size).toBe(1);
  });

  it('enforces message size limits', async () => {
    const root = await tempRoot('accompany-message-limit-');
    const channels = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: fakeChannels(channels),
      limits: { maxMessageBytes: 32 },
      logger: silentLogger()
    });
    cores.push(core);
    await core.start();
    await expect(
      core.send('main', { accountId: '10001', kind: 'private', peerId: '555' }, textMessage('x'.repeat(100)))
    ).rejects.toMatchObject({ code: 'message_too_large' });
    expect(channels.get('main')?.sent).toHaveLength(0);
  });
});
