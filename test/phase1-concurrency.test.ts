import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import { textMessage } from '../src/routing/message.js';
import { bindTestConversation, createTestCore, seedRoleCard, TEST_ROLE_CARD_ID } from './helpers.js';
import { accountPolicy, bind, fakeProvider, textInbound, waitFor, writePhase1Config } from './phase1-helpers.js';
import type { ProviderAdapter, ProviderCallContext, ChatRequest, ChatResponse } from '../src/providers/contract.js';
import type { CapabilityId } from '../src/policy/capabilities.js';
import type { CancelMode } from '../src/providers/types.js';

const roots: string[] = [];
const cores: Core[] = [];

const SLOW_PLUGIN = String.raw`
import fs from 'node:fs';
export async function onMessage(ctx) {
  fs.writeFileSync(ctx.config.started, '1');
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ctx.config.release) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { segments: [{ type: 'text', data: { text: 'slow plugin done' } }] };
}
`;

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

class GatedChatAdapter implements ProviderAdapter {
  readonly id = 'gated-v1';
  readonly texts: string[] = [];
  startedSlow = false;
  #release: () => void = () => {};
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  supports(capability: CapabilityId): boolean {
    return capability === 'chat';
  }

  cancelMode(): CancelMode {
    return 'localOnly';
  }

  async chat(context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    const text = request.messages
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    this.texts.push(`${context.provider.id}:${text}`);
    if (context.provider.id === 'slow-a') {
      this.startedSlow = true;
      await this.#gate;
      return { text: 'late-A' };
    }
    return { text: 'fast-B' };
  }

  release(): void {
    this.#release();
  }
}

class PeerGatedChatAdapter implements ProviderAdapter {
  readonly id = 'peer-gated-v1';
  readonly texts: string[] = [];
  startedSlow = false;
  #release: () => void = () => {};
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  supports(capability: CapabilityId): boolean {
    return capability === 'chat';
  }

  cancelMode(): CancelMode {
    return 'localOnly';
  }

  async chat(_context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    const text = request.messages
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    this.texts.push(text);
    if (text.includes('slow-peer')) {
      this.startedSlow = true;
      await this.#gate;
      return { text: 'late-same-account' };
    }
    return { text: 'fast-same-account' };
  }

  release(): void {
    this.#release();
  }
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('phase 1 cross-session scheduling', () => {
  it('does not let a slow v1 plugin on one account block the modern agent on another', async () => {
    const root = await tempRoot('accompany-con07-');
    await seedRoleCard(root);
    const started = path.join(root, 'slow.started');
    const release = path.join(root, 'slow.release');
    await seedPlugin(root, 'slow', SLOW_PLUGIN);
    await writeProfile(root, '10001', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: [{ source: 'public', id: 'slow', config: { started, release } }]
    });
    await writePhase1Config(root, {
      providers: [fakeProvider('fake-chat', { chatText: 'fast agent on B' })],
      accountPolicies: {
        '10002': accountPolicy({
          allowedProviders: ['fake-chat'],
          bindings: { chat: bind('fake-chat', 'text-model') }
        })
      }
    });

    const bucket = new Map<string, FakeChannel>();
    const factory: ChannelFactory = (context) => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      bucket.set(context.instanceId, channel);
      return channel;
    };
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [
          { id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } },
          { id: 'b', backend: 'fake', accountId: '10002', restart: { enabled: false } }
        ],
        channelFactory: factory,
        limits: { pluginTimeoutMs: 15_000 },
        logger: silentLogger('con07')
      },
      ['10001', '10002']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await bindTestConversation(core, '10002', 'private', '777');
    await core.start();
    await waitFor(() => core.status().instances.every((instance) => instance.state === 'online'));

    bucket.get('a')?.emitInbound(textInbound('a', '10001', '555', 'slow-1', 'run slow plugin'));
    await waitFor(async () => {
      try {
        await fs.access(started);
        return true;
      } catch {
        return false;
      }
    });

    bucket.get('b')?.emitInbound(textInbound('b', '10002', '777', 'fast-1', 'hello agent'));
    await waitFor(() => (bucket.get('b')?.sent.length ?? 0) === 1);
    expect(bucket.get('b')?.sent[0]?.message.segments).toEqual([
      { type: 'text', data: { text: 'fast agent on B' } }
    ]);
    expect(bucket.get('a')?.sent).toHaveLength(0);

    await fs.writeFile(release, '1');
    await waitFor(() => (bucket.get('a')?.sent.length ?? 0) === 1);
    expect(bucket.get('a')?.sent[0]?.message.segments).toEqual([
      { type: 'text', data: { text: 'slow plugin done' } }
    ]);
  });

  it('keeps one account online when the other is stopped and restarted', async () => {
    const root = await tempRoot('accompany-iso02-');
    const bucket = new Map<string, FakeChannel>();
    const factory: ChannelFactory = (context) => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      bucket.set(context.instanceId, channel);
      return channel;
    };
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [
          { id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } },
          { id: 'b', backend: 'fake', accountId: '10002', restart: { enabled: false } }
        ],
        channelFactory: factory,
        logger: silentLogger('iso02')
      },
      ['10001', '10002']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await bindTestConversation(core, '10001', 'private', '777');
    await core.start();
    await waitFor(() => core.status().instances.every((instance) => instance.state === 'online'));

    await core.stopInstance('a');
    expect(core.status().instances.find((instance) => instance.id === 'a')?.state).toBe('stopped');
    expect(core.status().instances.find((instance) => instance.id === 'b')).toMatchObject({
      state: 'online',
      accountId: '10002'
    });
    await core.send('b', { accountId: '10002', kind: 'private', peerId: '777' }, textMessage('still online'));
    expect(bucket.get('b')?.sent).toHaveLength(1);

    await core.startInstance('a');
    await waitFor(() => core.status().instances.find((instance) => instance.id === 'a')?.state === 'online');
    expect(core.status().instances.find((instance) => instance.id === 'a')?.accountId).toBe('10001');
    expect(core.status().instances.find((instance) => instance.id === 'b')?.state).toBe('online');
  });

  it('runs a second conversation of the same account while the first is blocked', async () => {
    const root = await tempRoot('accompany-con02-same-account-');
    const adapter = new PeerGatedChatAdapter();
    await writePhase1Config(root, {
      providers: [{ ...fakeProvider('same-account'), adapterId: 'peer-gated-v1' }],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['same-account'],
          bindings: { chat: bind('same-account', 'text-model') }
        })
      }
    });
    const bucket = new Map<string, FakeChannel>();
    const factory: ChannelFactory = (context) => {
      const fake = new FakeChannel(context, { selfId: context.spec.accountId });
      bucket.set(context.instanceId, fake);
      return fake;
    };
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
        channelFactory: factory,
        providerAdapters: [adapter],
        logger: silentLogger('con02-same')
      },
      ['10001']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await bindTestConversation(core, '10001', 'private', '777');
    await core.start();
    await waitFor(() => core.status().instances[0]?.state === 'online');
    const channel = bucket.get('a')!;

    channel.emitInbound(textInbound('a', '10001', '555', 'same-slow', 'slow-peer question'));
    await waitFor(() => adapter.startedSlow);
    channel.emitInbound(textInbound('a', '10001', '777', 'same-fast', 'fast-peer question'));
    await waitFor(() => channel.sent.some((entry) => entry.conversation.peerId === '777'));
    expect(channel.sent.filter((entry) => entry.conversation.peerId === '555')).toHaveLength(0);
    expect(channel.sent.find((entry) => entry.conversation.peerId === '777')?.message.segments).toEqual([
      { type: 'text', data: { text: 'fast-same-account' } }
    ]);
    expect(adapter.texts).toHaveLength(2);
    expect(adapter.texts[0]).toContain('slow-peer question');
    expect(adapter.texts[0]).not.toContain('fast-peer question');
    expect(adapter.texts[1]).toContain('fast-peer question');
    expect(adapter.texts[1]).not.toContain('slow-peer question');

    adapter.release();
    await waitFor(() => channel.sent.some((entry) => entry.conversation.peerId === '555'));
    expect(channel.sent.find((entry) => entry.conversation.peerId === '555')?.message.segments).toEqual([
      { type: 'text', data: { text: 'late-same-account' } }
    ]);
  });

  it('runs a fast account chat while another account request is still blocked', async () => {
    const root = await tempRoot('accompany-con02-');
    const adapter = new GatedChatAdapter();
    await writePhase1Config(root, {
      providers: [
        { ...fakeProvider('slow-a'), adapterId: 'gated-v1' },
        { ...fakeProvider('fast-b'), adapterId: 'gated-v1' }
      ],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['slow-a'],
          bindings: { chat: bind('slow-a', 'text-model') }
        }),
        '10002': accountPolicy({
          allowedProviders: ['fast-b'],
          bindings: { chat: bind('fast-b', 'text-model') }
        })
      }
    });
    const bucket = new Map<string, FakeChannel>();
    const factory: ChannelFactory = (context) => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      bucket.set(context.instanceId, channel);
      return channel;
    };
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [
          { id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } },
          { id: 'b', backend: 'fake', accountId: '10002', restart: { enabled: false } }
        ],
        channelFactory: factory,
        providerAdapters: [adapter],
        logger: silentLogger('con02')
      },
      ['10001', '10002']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await bindTestConversation(core, '10002', 'private', '777');
    await core.start();
    await waitFor(() => core.status().instances.every((instance) => instance.state === 'online'));

    bucket.get('a')?.emitInbound(textInbound('a', '10001', '555', 'slow-1', 'account A question'));
    await waitFor(() => adapter.startedSlow);
    bucket.get('b')?.emitInbound(textInbound('b', '10002', '777', 'fast-1', 'account B question'));
    await waitFor(() => (bucket.get('b')?.sent.length ?? 0) === 1);

    expect(bucket.get('b')?.sent[0]?.message.segments).toEqual([
      { type: 'text', data: { text: 'fast-B' } }
    ]);
    expect(bucket.get('a')?.sent).toHaveLength(0);
    expect(adapter.texts.find((text) => text.startsWith('fast-b:'))).toContain('account B question');
    expect(adapter.texts.find((text) => text.startsWith('fast-b:'))).not.toContain('account A question');

    adapter.release();
    await waitFor(() => (bucket.get('a')?.sent.length ?? 0) === 1);
    expect(bucket.get('a')?.sent[0]?.message.segments).toEqual([
      { type: 'text', data: { text: 'late-A' } }
    ]);
    expect(adapter.texts.find((text) => text.startsWith('slow-a:'))).toContain('account A question');
    expect(adapter.texts.find((text) => text.startsWith('slow-a:'))).not.toContain('account B question');
  });
});

async function seedPlugin(root: string, id: string, code: string): Promise<void> {
  const dir = path.join(root, 'public', 'artifacts', 'plugin', id, 'r1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ id, kind: 'plugin', revision: 'r1', entry: `${id}.mjs`, apiVersion: 1 }, null, 2)}\n`
  );
  await fs.writeFile(path.join(dir, `${id}.mjs`), code);
  const catalogFile = path.join(root, 'public', 'catalog.json');
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
