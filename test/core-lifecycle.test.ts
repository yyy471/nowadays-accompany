import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { createCore as createRuntimeCore } from '../src/core/core.js';
import { createTestCore as createCore } from './helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { textMessage } from '../src/routing/message.js';
import type { InjectionBackend, BackendStatus, ProbeReport, RuntimeEndpoints } from '../src/injection/contract.js';
import type { ChannelContext } from '../src/channels/contract.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';

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

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class BlockingCredentialVault extends MemoryCredentialVault {
  readonly entered = gate();
  readonly hold = gate();

  override async set(ref: string, secret: string): Promise<void> {
    this.entered.release();
    await this.hold.promise;
    await super.set(ref, secret);
  }
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

  it('closes Core facade writes and drains an accepted credential operation before releasing the root lock', async () => {
    const root = await tempRoot('accompany-review-core-write-');
    const vault = new BlockingCredentialVault();
    const first = await createRuntimeCore({ dataRoot: root, instances: [], credentialVault: vault, logger: silentLogger() });
    cores.push(first);

    const accepted = first.setInjectionSettings({ runtimeDir: path.join(root, 'runtime') }, 'accepted-secret');
    await vault.entered.promise;
    let stopFinished = false;
    const stopping = first.stop().then(() => { stopFinished = true; });
    await Promise.resolve();
    expect(stopFinished).toBe(false);
    await expect(createRuntimeCore({ dataRoot: root, instances: [], logger: silentLogger() }))
      .rejects.toMatchObject({ code: 'data_root_locked' });

    vault.hold.release();
    await expect(accepted).resolves.toMatchObject({ settings: { runtimeDir: path.join(root, 'runtime') } });
    await stopping;
    expect(stopFinished).toBe(true);

    const settingsFile = path.join(root, 'injection.json');
    const committedSettings = await fs.readFile(settingsFile, 'utf8');
    const second = await createRuntimeCore({ dataRoot: root, instances: [], logger: silentLogger() });
    cores.push(second);

    const closedCalls = [
      first.upsertProvider({ id: 'late-provider' }),
      first.setInjectionSettings({ runtimeDir: path.join(root, 'late-runtime') }, 'late-secret'),
      first.clearInjectionPassword(),
      first.saveAccountDisplay('10001', { nickname: 'late-name' }),
      first.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: 'peer' }, null),
      first.saveAccountProfile('10001', {}),
      first.addSlot({ id: 'late-slot', backend: 'fake' }),
      first.removeSlot('missing-slot'),
      first.deployArtifact('role-card', 'missing', 'r1'),
      first.rollbackArtifacts(),
      first.cancelJob('10001', 'missing-job'),
      first.deleteMedia('10001', 'missing-media'),
      first.send('missing-instance', { accountId: '10001', kind: 'private', peerId: 'peer' }, textMessage('late')),
      first.injectAndListen({}),
      first.resumeInjectionListening(),
      first.injectionProcesses()
    ];
    for (const call of closedCalls) await expect(call).rejects.toMatchObject({ code: 'core_stopped' });

    expect(await fs.readFile(settingsFile, 'utf8')).toBe(committedSettings);
    expect(await second.listProviders()).toEqual([]);
    expect(second.slotSpecs()).toEqual([]);
    await second.stop();
  });

  it('blocks legacy job and message reads that would initialize files after Core handover', async () => {
    const root = await tempRoot('accompany-review-read-side-effects-');
    const accountDir = path.join(root, 'accounts', '10001');
    const jobsFile = path.join(accountDir, 'jobs', 'jobs.json');
    const messageDir = path.join(accountDir, 'messages', 'private', 'peer');
    const missingJobsFile = path.join(root, 'accounts', '10002', 'jobs', 'jobs.json');
    await fs.mkdir(path.dirname(jobsFile), { recursive: true });
    const originalJobs = `${JSON.stringify({
      version: 1,
      jobs: {
        'job-legacy': {
          id: 'job-legacy',
          accountId: '10001',
          conversation: { accountId: '10001', kind: 'private', peerId: 'peer' },
          capability: 'chat',
          turnId: 'turn-legacy',
          sessionEpoch: 1,
          state: 'running',
          cancelMode: 'interruptible',
          cancelRequested: false,
          remoteCancelled: false,
          delivery: 'pending',
          createdAt: 1,
          updatedAt: 1
        }
      }
    }, null, 2)}\n`;
    await fs.writeFile(jobsFile, originalJobs, 'utf8');

    const oldCore = await createRuntimeCore({ dataRoot: root, instances: [], logger: silentLogger() });
    cores.push(oldCore);
    await oldCore.stop();
    const newCore = await createRuntimeCore({ dataRoot: root, instances: [], logger: silentLogger() });
    cores.push(newCore);

    await expect(oldCore.listJobs('10001')).rejects.toMatchObject({ code: 'core_stopped' });
    await expect(oldCore.getJob('10001', 'job-legacy')).rejects.toMatchObject({ code: 'core_stopped' });
    await expect(oldCore.listJobs('10002')).rejects.toMatchObject({ code: 'core_stopped' });
    await expect(oldCore.readMessages('10001', { accountId: '10001', kind: 'private', peerId: 'peer' }))
      .rejects.toMatchObject({ code: 'core_stopped' });

    expect(await fs.readFile(jobsFile, 'utf8')).toBe(originalJobs);
    await expect(fs.access(messageDir)).rejects.toThrow();
    await expect(fs.access(missingJobsFile)).rejects.toThrow();

    const recoveredJobs = await newCore.listJobs('10001');
    expect(recoveredJobs).toMatchObject([{ id: 'job-legacy', state: 'interrupted' }]);
    expect(JSON.parse(await fs.readFile(jobsFile, 'utf8'))).toMatchObject({
      jobs: { 'job-legacy': { state: 'interrupted' } }
    });
    await newCore.stop();
  });

  it('waits for all concurrent Core.stop callers and disposes each resource once', async () => {
    const root = await tempRoot('accompany-review-stop-');
    const entered = gate();
    const hold = gate();
    let disposeCount = 0;
    const core = await createRuntimeCore({
      dataRoot: root,
      instances: [],
      host: {
        onMessage: () => undefined,
        dispose: async () => {
          disposeCount += 1;
          entered.release();
          await hold.promise;
        }
      },
      logger: silentLogger()
    });
    cores.push(core);

    let firstFinished = false;
    let secondFinished = false;
    const first = core.stop().then(() => { firstFinished = true; });
    await entered.promise;
    const second = core.stop().then(() => { secondFinished = true; });
    await Promise.resolve();

    expect(firstFinished).toBe(false);
    expect(secondFinished).toBe(false);
    expect(disposeCount).toBe(1);
    await expect(createRuntimeCore({ dataRoot: root, instances: [], logger: silentLogger() }))
      .rejects.toMatchObject({ code: 'data_root_locked' });

    hold.release();
    await Promise.all([first, second]);
    expect(firstFinished).toBe(true);
    expect(secondFinished).toBe(true);
    expect(disposeCount).toBe(1);
  });

  it('continues media and config disposal when media cleanup fails', async () => {
    const root = await tempRoot('accompany-review-dispose-');
    const core = await createRuntimeCore({ dataRoot: root, instances: [], logger: silentLogger() });
    cores.push(core);
    let cleanupCalls = 0;
    let mediaDisposeCalls = 0;
    let configDisposeCalls = 0;
    const disposeMedia = core.media.dispose.bind(core.media);
    const disposeConfig = core.configV2.dispose.bind(core.configV2);
    core.media.cleanup = async () => {
      cleanupCalls += 1;
      throw new Error('cleanup failed');
    };
    core.media.dispose = async () => {
      mediaDisposeCalls += 1;
      await disposeMedia();
    };
    core.configV2.dispose = async () => {
      configDisposeCalls += 1;
      await disposeConfig();
    };

    await expect(core.stop()).resolves.toBeUndefined();
    expect(cleanupCalls).toBe(1);
    expect(mediaDisposeCalls).toBe(1);
    expect(configDisposeCalls).toBe(1);
    const next = await createRuntimeCore({ dataRoot: root, instances: [], logger: silentLogger() });
    cores.push(next);
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
