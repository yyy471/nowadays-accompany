import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { createCore } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import { silentLogger } from '../src/core/logger.js';
import type { CoreEvents } from '../src/core/events.js';
import type { AgentHost, AgentMessageContext, AgentSessionContext } from '../src/host/contract.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { textMessage } from '../src/routing/message.js';
import type { InboundMessageEvent } from '../src/channels/events.js';
import { bindTestConversation, createTestCore } from './helpers.js';
import { seedRoleCard, TEST_ROLE_CARD_ID } from './helpers.js';
import {
  accountPolicy,
  bind,
  fakeProvider,
  textInbound,
  waitFor,
  writePhase1Config
} from './phase1-helpers.js';

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

function channels(
  selfIds: Map<string, string>,
  bucket: Map<string, FakeChannel>
): ChannelFactory {
  return (context) => {
    const channel = new FakeChannel(context, {
      selfId: selfIds.get(context.instanceId) ?? context.spec.accountId
    });
    bucket.set(context.instanceId, channel);
    return channel;
  };
}

function inbound(instanceId: string, selfId: string, peerId: string, messageId: string): InboundMessageEvent {
  return {
    type: 'message',
    instanceId,
    selfId,
    kind: 'private',
    peerId,
    senderId: peerId,
    messageId,
    at: 1,
    segments: [{ type: 'text', data: { text: 'ping' } }],
    selfEcho: false
  };
}

describe('phase 1 identity, epochs and artifact isolation', () => {
  it('rejects a second slot for an already owned account and keeps the session usable', async () => {
    const root = await tempRoot('accompany-iso03-');
    const selfIds = new Map([['a', '10001']]);
    const bucket = new Map<string, FakeChannel>();
    const core = await createTestCore({
      dataRoot: root,
      instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
      channelFactory: channels(selfIds, bucket),
      logger: silentLogger()
    });
    cores.push(core);
    await core.start();

    await expect(
      core.addSlot({ id: 'b', backend: 'fake', accountId: '10001', restart: { enabled: false } })
    ).rejects.toMatchObject({ code: 'isolation_violation' });

    expect(core.status().instances.map((item) => item.id)).toEqual(['a']);
    expect(core.status().instances[0]).toMatchObject({ state: 'online', accountId: '10001' });
    await core.send('a', { accountId: '10001', kind: 'private', peerId: '555' }, textMessage('still here'));
    expect(bucket.get('a')?.sent).toHaveLength(1);
  });

  it('refuses a channel selfId that contradicts the configured account without touching the other account', async () => {
    const root = await tempRoot('accompany-iso04-');
    const selfIds = new Map([['main', '20002']]);
    const bucket = new Map<string, FakeChannel>();
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [{ id: 'main', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
        channelFactory: channels(selfIds, bucket),
        logger: silentLogger()
      },
      ['20002']
    );
    cores.push(core);
    const errors: CoreEvents['instance:error'][] = [];
    core.bus.on('instance:error', (event) => errors.push(event));

    await expect(core.startInstance('main')).rejects.toBeInstanceOf(Error);

    expect(core.status().instances[0]).toMatchObject({ state: 'failed' });
    expect(core.status().instances[0]?.accountId).toBeUndefined();
    expect(errors.some((event) => event.code === 'isolation_violation')).toBe(true);
    expect(bucket.get('main')?.sent).toHaveLength(0);
    await expect(
      fs.access(path.join(root, 'accounts', '20002', 'messages'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('changes the profile fingerprint on a config reload and rejects writes from the old host epoch', async () => {
    const root = await tempRoot('accompany-con09-');
    const sessions: AgentSessionContext[] = [];
    const hostFactory = (): AgentHost => ({
      onSessionStart: (context) => {
        sessions.push(context);
      },
      onMessage: () => textMessage('ok')
    });
    const core = await createTestCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
      channelFactory: channels(new Map([['main', '10001']]), new Map()),
      hostFactory,
      logger: silentLogger()
    });
    cores.push(core);
    await core.start();
    await waitFor(() => core.status().instances[0]?.state === 'online');
    const before = core.status().instances[0]!;
    expect(before.hostEpoch).toBe(1);
    expect(before.sessionEpoch).toBe(1);
    expect(before.profileFingerprint).toBeTruthy();

    await core.patchAgentEnabled('10001', false);
    await waitFor(() => core.status().instances[0]?.hostEpoch === 2 && sessions.length === 2);

    const after = core.status().instances[0]!;
    expect(after.sessionEpoch).toBe(before.sessionEpoch);
    expect(after.profileFingerprint).not.toBe(before.profileFingerprint);

    const [oldSession, newSession] = sessions;
    await oldSession!.state('probe').write({ who: 'old' });
    const stateFile = path.join(root, 'accounts', '10001', 'plugin-state', 'probe.json');
    await expect(fs.access(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });

    await newSession!.state('probe').write({ who: 'new' });
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual({ who: 'new' });
  });

  it('invalidates a late reply and stale writes after rebinding the slot to another account', async () => {
    const root = await tempRoot('accompany-iso05-');
    const selfIds = new Map([['main', '10001']]);
    const bucket = new Map<string, FakeChannel>();
    const allChannels: FakeChannel[] = [];
    const factory: ChannelFactory = (context) => {
      const channel = new FakeChannel(context, { selfId: selfIds.get(context.instanceId) });
      bucket.set(context.instanceId, channel);
      allChannels.push(channel);
      return channel;
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invoked = false;
    let messageContext: AgentMessageContext | undefined;
    const hostFactory = (): AgentHost => ({
      onMessage: async (context) => {
        invoked = true;
        messageContext = context;
        await gate;
        return textMessage('late-A');
      }
    });
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [{ id: 'main', backend: 'fake', restart: { enabled: false } }],
        channelFactory: factory,
        hostFactory,
        limits: { drainTimeoutMs: 40, hostTimeoutMs: 2_000 },
        logger: silentLogger()
      },
      ['10001', '10002']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await core.start();
    await waitFor(() => core.status().instances[0]?.state === 'online');
    const first = bucket.get('main')!;
    first.emitInbound(inbound('main', '10001', '555', 'late-1'));
    await waitFor(() => invoked);
    expect(core.status().instances[0]?.accountId).toBe('10001');

    await core.stopInstance('main');
    selfIds.set('main', '10002');
    await core.startInstance('main');
    await waitFor(
      () => core.status().instances[0]?.state === 'online' && core.status().instances[0]?.accountId === '10002'
    );

    await expect(
      messageContext!.deliver(textMessage('late-A'), { operationId: 'late-A' })
    ).rejects.toMatchObject({ code: 'isolation_violation' });
    await messageContext!.state('late').write({ from: 'A' });

    release();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(allChannels[0]?.sent).toHaveLength(0);
    expect(allChannels[1]?.sent).toHaveLength(0);
    await expect(
      fs.access(path.join(root, 'accounts', '10002', 'messages'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.access(path.join(root, 'accounts', '10002', 'plugin-state', 'late.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the built-in agent as the only reply owner when a plugin is installed', async () => {
    const root = await tempRoot('accompany-owner-');
    await seedRoleCard(root);
    await seedPlugin(
      root,
      'public',
      'echo',
      "export async function onMessage() { return { segments: [{ type: 'text', data: { text: 'plugin-reply' } }] }; }"
    );
    await writeProfile(root, '10001', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: [{ source: 'public', id: 'echo' }]
    });
    await writePhase1Config(root, {
      providers: [fakeProvider('fake-chat', { chatText: 'agent-reply' })],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat'],
          bindings: { chat: bind('fake-chat', 'text-model') }
        })
      }
    });
    const adapter = new FakeProviderAdapter();
    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
      channelFactory: channels(new Map([['main', '10001']]), bucket),
      providerAdapters: [adapter],
      logger: silentLogger('owner')
    });
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await core.start();
    await waitFor(() => core.status().instances[0]?.state === 'online');
    expect(core.status().instances[0]?.agent).toMatchObject({ mode: 'agent' });

    bucket.get('main')?.emitInbound(textInbound('main', '10001', '555', 'own-1', 'first'));
    await waitFor(() => (bucket.get('main')?.sent.length ?? 0) === 1);
    expect(bucket.get('main')?.sent[0]?.message.segments).toEqual([
      { type: 'text', data: { text: 'agent-reply' } }
    ]);
    expect(adapter.calls.filter((call) => call.capability === 'chat')).toHaveLength(1);

    // 旧 onMessage 导出不再是回复者，也不会创建旧插件状态文件。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.stringify(bucket.get('main')?.sent ?? [])).not.toContain('plugin-reply');
    await expect(fs.access(path.join(root, 'accounts', '10001', 'plugin-state', 'echo.json'))).rejects.toThrow();
  });

});

async function seedPlugin(
  root: string,
  source: 'public' | 'private',
  id: string,
  code: string
): Promise<void> {
  const base = source === 'public' ? path.join(root, 'public') : path.join(root, 'accounts', '10001');
  const dir = path.join(base, 'artifacts', 'plugin', id, 'r1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ id, kind: 'plugin', revision: 'r1', entry: `${id}.mjs`, apiVersion: 1 }, null, 2)}\n`
  );
  await fs.writeFile(path.join(dir, `${id}.mjs`), code);
  const catalogFile = path.join(base, 'catalog.json');
  let catalog: { version: number; artifacts: Record<string, string> } = { version: 1, artifacts: {} };
  try {
    catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8')) as typeof catalog;
  } catch {
    // 首次写入
  }
  catalog.artifacts[`plugin:${id}`] = 'r1';
  await fs.writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
}

async function writeProfile(
  root: string,
  accountId: string,
  profile: Record<string, unknown>
): Promise<void> {
  const dir = path.join(root, 'accounts', accountId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
}
