import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import { silentLogger } from '../src/core/logger.js';
import { textMessage } from '../src/routing/message.js';
import { createTestCore } from './helpers.js';
import { accountPolicy, bind, fakeProvider, waitFor } from './phase1-helpers.js';

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

function channelFactory(bucket: Map<string, FakeChannel>): ChannelFactory {
  return (context) => {
    const channel = new FakeChannel(context, { selfId: context.spec.accountId });
    bucket.set(context.instanceId, channel);
    return channel;
  };
}

describe('phase 1 migration and restart', () => {
  it('keeps v1 files, provider bindings and account history across a restart', async () => {
    const root = await tempRoot('accompany-p1-migration-');
    const legacyFile = path.join(root, 'config.json');
    const legacy = '{"plugin":{"enabled":true}}\n';
    await fs.writeFile(legacyFile, legacy, 'utf8');

    const firstChannels = new Map<string, FakeChannel>();
    const first = await createTestCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
      channelFactory: channelFactory(firstChannels),
      logger: silentLogger('migration-1')
    });
    cores.push(first);
    await first.start();
    await waitFor(() => first.status().instances[0]?.state === 'online');

    await first.upsertProvider(fakeProvider('persist-chat', { chatText: 'persisted reply' }));
    await first.setAccountPolicy(
      '10001',
      accountPolicy({
        allowedProviders: ['persist-chat'],
        bindings: { chat: bind('persist-chat', 'text-model') }
      })
    );
    const conversation = { accountId: '10001', kind: 'private' as const, peerId: '555' };
    await first.send('main', conversation, textMessage('persist me'));
    await first.stop();

    expect(await fs.readFile(legacyFile, 'utf8')).toBe(legacy);
    expect(await fs.readFile(`${legacyFile}.backup.json`, 'utf8')).toBe(legacy);
    expect(await fs.readFile(path.join(root, 'config.v2.json'), 'utf8')).toContain('persist-chat');
    expect(await fs.readFile(path.join(root, 'accounts', '10001', 'profile.json'), 'utf8')).toContain(
      'roleCard'
    );

    const secondChannels = new Map<string, FakeChannel>();
    const second = await createTestCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
      channelFactory: channelFactory(secondChannels),
      logger: silentLogger('migration-2')
    });
    cores.push(second);
    await second.start();
    await waitFor(() => second.status().instances[0]?.state === 'online');

    expect((await second.listProviders()).map((provider) => provider.id)).toEqual(['persist-chat']);
    const effective = await second.effectiveCapabilities('10001', conversation);
    expect(effective.capabilities.find((capability) => capability.capability === 'chat')).toMatchObject({
      enabled: true,
      providerId: 'persist-chat',
      modelId: 'text-model',
      bindingSource: 'account'
    });
    expect(second.getAccountPolicy('10001').allowedProviders).toEqual(['persist-chat']);

    const history = await second.readMessages('10001', conversation);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      direction: 'out',
      segments: [{ type: 'text', data: { text: 'persist me' } }]
    });
    expect(await fs.readFile(legacyFile, 'utf8')).toBe(legacy);
  });

  it('keeps the original config and backup usable when a v2 file is corrupt', async () => {
    const root = await tempRoot('accompany-p1-migration-bad-');
    const configFile = path.join(root, 'config.v2.json');
    await fs.writeFile(configFile, '{"schemaVersion":2,"providers":[', 'utf8');
    await expect(
      createTestCore({
        dataRoot: root,
        instances: [],
        logger: silentLogger('migration-bad')
      })
    ).rejects.toMatchObject({ code: 'invalid_config' });
    expect(await fs.readFile(configFile, 'utf8')).toBe('{"schemaVersion":2,"providers":[');
  });
});
