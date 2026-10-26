import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/providers/config-store.js';
import { PolicyService } from '../src/policy/policy.js';
import { ExtensionRegistry, SkillRuntime } from '../src/extensions/registry.js';
import { ProviderRouter } from '../src/providers/router.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import { silentLogger } from '../src/core/logger.js';
import { ProviderError } from '../src/providers/errors.js';
import type { Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import type {
  ChatResponse,
  ProviderAdapter,
  ProviderCallContext,
  ProviderMedia
} from '../src/providers/contract.js';
import type { CancelMode } from '../src/providers/types.js';
import type { CapabilityId } from '../src/policy/capabilities.js';
import { createCore } from '../src/core/core.js';
import { bindTestConversation, createTestCore, seedRoleCard, TEST_ROLE_CARD_ID } from './helpers.js';
import {
  accountPolicy,
  bind,
  fakeProvider,
  TINY_PNG,
  textInbound,
  waitFor,
  writePhase1Config,
  type RawProvider
} from './phase1-helpers.js';
import { textMessage } from '../src/routing/message.js';

const roots: string[] = [];
const cores: Core[] = [];
const disposables: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const entry of disposables.splice(0)) await entry.dispose().catch(() => {});
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function routerFor(
  providers: RawProvider[],
  accountPolicies: Record<string, Record<string, unknown>>,
  adapters: ProviderAdapter[],
  vault: MemoryCredentialVault = new MemoryCredentialVault()
): Promise<{ router: ProviderRouter; config: ConfigStore }> {
  const root = await tempRoot('accompany-p2-router-');
  await writePhase1Config(root, { providers, accountPolicies });
  const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
  disposables.push(config);
  return {
    config,
    router: new ProviderRouter({
      config,
      policy: new PolicyService(config),
      skills: new SkillRuntime(() => config.snapshot().skills),
      extensions: new ExtensionRegistry(),
      vault,
      adapters,
      logger: silentLogger('p2-fixes')
    })
  };
}

function conversation(accountId = '10001', peerId = '42', kind: 'private' | 'group' = 'private') {
  return { accountId, kind, peerId };
}

function media(accountId = '10001'): ProviderMedia {
  return {
    mediaId: 'm1',
    accountId,
    mimeType: 'image/png',
    bytes: TINY_PNG.length,
    kind: 'image',
    data: TINY_PNG
  };
}

const visionProvider: RawProvider = {
  id: 'p',
  adapterId: 'vision-v1',
  baseUrl: 'https://old-cloud.example.test/v1',
  location: 'cloud',
  models: [{ id: 'vision', capabilities: ['image.understand'], input: ['text', 'image'] }]
};

const visionPolicy = accountPolicy({
  allowedProviders: ['p'],
  bindings: { 'image.understand': bind('p', 'vision') },
  media: { allowCloudUpload: true }
});

function visionAdapter(calls: Array<{ url: string; location: string }>): ProviderAdapter {
  return {
    id: 'vision-v1',
    supports: (capability) => capability === 'image.understand',
    cancelMode: () => 'localOnly',
    async imageUnderstand(context: ProviderCallContext) {
      calls.push({ url: context.provider.baseUrl, location: context.provider.location });
      return { text: 'observation' };
    }
  };
}

describe('phase 2 S1 execution plan consistency', () => {
  it('rejects a queued cloud plan after the provider moves local and upload is revoked', async () => {
    const calls: Array<{ url: string; location: string }> = [];
    const { router, config } = await routerFor([visionProvider], { '10001': visionPolicy }, [visionAdapter(calls)]);
    const old = router.resolve('10001', conversation(), 'image.understand', { media: 'image' });
    expect(old.enabled).toBe(true);

    await config.upsertProvider({
      ...visionProvider,
      baseUrl: 'http://127.0.0.1:8000/v1',
      location: 'local'
    });
    await config.setAccountPolicy(
      '10001',
      accountPolicy({
        allowedProviders: ['p'],
        bindings: { 'image.understand': bind('p', 'vision') },
        media: { allowCloudUpload: false }
      })
    );

    await expect(
      router.imageUnderstand(
        '10001',
        conversation(),
        media(),
        'describe',
        new AbortController().signal,
        undefined,
        old
      )
    ).rejects.toMatchObject({ reason: 'execution_plan_stale' });
    expect(calls).toHaveLength(0);
    expect(config.provider('p')).toMatchObject({
      baseUrl: 'http://127.0.0.1:8000/v1',
      location: 'local'
    });
  });

  it('rejects a plan after model parameters or the account binding changes', async () => {
    const calls: string[] = [];
    const adapter: ProviderAdapter = {
      id: 'params-v1',
      supports: (capability) => capability === 'image.generate',
      cancelMode: () => 'none',
      async imageGenerate(context: ProviderCallContext) {
        calls.push(context.model.id);
        return { images: [{ data: TINY_PNG, mimeType: 'image/png' }] };
      }
    };
    const provider: RawProvider = {
      id: 'p',
      adapterId: 'params-v1',
      baseUrl: 'http://127.0.0.1:9/p',
      location: 'local',
      models: [{ id: 'image', capabilities: ['image.generate'], input: ['text'], parameters: { size: '512x512' } }]
    };
    const policy = accountPolicy({
      allowedProviders: ['p'],
      bindings: { 'image.generate': bind('p', 'image') }
    });
    const { router, config } = await routerFor([provider], { '10001': policy }, [adapter]);
    const old = router.resolve('10001', conversation(), 'image.generate');

    await config.upsertProvider({
      ...provider,
      models: [
        { id: 'image', capabilities: ['image.generate'], input: ['text'], parameters: { size: '1024x1024' } }
      ]
    });
    await expect(
      router.imageGenerate('10001', conversation(), { prompt: 'a dot' }, new AbortController().signal, undefined, old)
    ).rejects.toMatchObject({ reason: 'execution_plan_stale' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a plan after the credential is replaced', async () => {
    const calls: string[] = [];
    const vault = new MemoryCredentialVault();
    await vault.set('provider/p', 'old-secret');
    const adapter: ProviderAdapter = {
      id: 'cred-v1',
      supports: (capability) => capability === 'chat',
      cancelMode: () => 'none',
      async chat(): Promise<ChatResponse> {
        calls.push('chat');
        return { text: 'ok' };
      }
    };
    const provider: RawProvider = {
      id: 'p',
      adapterId: 'cred-v1',
      baseUrl: 'http://127.0.0.1:9/cred',
      location: 'local',
      credentialRef: 'provider/p',
      models: [{ id: 'chat', capabilities: ['chat'], input: ['text'] }]
    };
    const policy = accountPolicy({ allowedProviders: ['p'], bindings: { chat: bind('p', 'chat') } });
    const { router } = await routerFor([provider], { '10001': policy }, [adapter], vault);
    const old = router.resolve('10001', conversation(), 'chat');
    await vault.set('provider/p', 'new-secret');
    await expect(
      router.chat(
        '10001',
        conversation(),
        { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
        new AbortController().signal,
        old
      )
    ).rejects.toMatchObject({ reason: 'credential_stale' });
    expect(calls).toHaveLength(0);
  });

  it('re-checks the plan version before a retry submits again', async () => {
    let configRef: ConfigStore | undefined;
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: 'retry-v1',
      supports: (capability) => capability === 'chat',
      cancelMode: () => 'none',
      async chat(): Promise<ChatResponse> {
        calls += 1;
        await configRef!.upsertProvider({
          ...provider,
          baseUrl: 'http://127.0.0.1:9/changed'
        });
        throw new ProviderError('provider_rate_limit', 'slow down', {
          providerId: 'p',
          capability: 'chat',
          retryable: true,
          retryAfterMs: 1
        });
      }
    };
    const provider: RawProvider = {
      id: 'p',
      adapterId: 'retry-v1',
      baseUrl: 'http://127.0.0.1:9/retry',
      location: 'local',
      models: [{ id: 'chat', capabilities: ['chat'], input: ['text'] }],
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
    };
    const setup = await routerFor(
      [provider],
      { '10001': accountPolicy({ allowedProviders: ['p'], bindings: { chat: bind('p', 'chat') } }) },
      [adapter]
    );
    configRef = setup.config;
    await expect(
      setup.router.chat(
        '10001',
        conversation(),
        { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ reason: 'execution_plan_stale' });
    expect(calls).toBe(1);
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
    // first write
  }
  catalog.artifacts[`plugin:${id}`] = 'r1';
  await fs.writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
}

async function writeProfile(root: string, accountId: string, profile: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, 'accounts', accountId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
}

function channelFactory(bucket: Map<string, FakeChannel>): ChannelFactory {
  return (context) => {
    const channel = new FakeChannel(context, { selfId: context.spec.accountId });
    bucket.set(context.instanceId, channel);
    return channel;
  };
}

class GatedChatAdapter implements ProviderAdapter {
  readonly id = 'gated-v1';
  started = 0;
  readonly #gate: Promise<void>;
  #release: () => void = () => {};

  constructor() {
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  supports(capability: CapabilityId): boolean {
    return capability === 'chat';
  }

  cancelMode(): CancelMode {
    return 'localOnly';
  }

  async chat(): Promise<ChatResponse> {
    this.started += 1;
    await this.#gate;
    return { text: 'late agent reply' };
  }

  release(): void {
    this.#release();
  }
}

describe('phase 2 S2 pause across hosts', () => {
  it('stops automatic agent replies while paused and keeps messages and manual sends', async () => {
    const root = await tempRoot('accompany-p2-agent-pause-');
    await seedRoleCard(root);
    await writePhase1Config(root, {
      providers: [fakeProvider('fake-chat', { chatText: 'agent reply' })],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat'],
          bindings: { chat: bind('fake-chat', 'text-model') }
        })
      }
    });
    const bucket = new Map<string, FakeChannel>();
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
        channelFactory: channelFactory(bucket),
        logger: silentLogger('p2-agent-pause')
      },
      ['10001']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '42');
    await core.start();
    await waitFor(() => core.status().instances[0]?.state === 'online');
    const channel = bucket.get('a')!;

    channel.emitInbound(textInbound('a', '10001', '42', 'before-pause', 'hello'));
    await waitFor(() => channel.sent.length === 1);
    expect(channel.sent[0]?.message.segments).toEqual([{ type: 'text', data: { text: 'agent reply' } }]);

    await core.patchAgentEnabled('10001', false);
    await waitFor(() => core.status().instances[0]?.hostEpoch === 2);
    channel.emitInbound(textInbound('a', '10001', '42', 'while-paused', 'hello'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(channel.sent).toHaveLength(1);

    const messages = await core.readMessages('10001', conversation());
    expect(messages.some((message) => message.messageId === 'while-paused')).toBe(true);

    await core.send('a', conversation(), textMessage('manual send'));
    expect(channel.sent).toHaveLength(2);
    await core.patchAgentEnabled('10001', true);
    channel.emitInbound(textInbound('a', '10001', '42', 'after-resume', 'hello'));
    await waitFor(() => channel.sent.length === 3);
    expect(channel.sent[2]?.message.segments).toEqual([{ type: 'text', data: { text: 'agent reply' } }]);
    expect(JSON.stringify(channel.sent)).not.toContain('while-paused');
  });

  it('applies a group-scope pause while private replies continue', async () => {
    const root = await tempRoot('accompany-p2-scope-pause-');
    await seedRoleCard(root);
    await writePhase1Config(root, {
      providers: [fakeProvider('fake-chat', { chatText: 'agent reply' })],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat'],
          bindings: { chat: bind('fake-chat', 'text-model') },
          byKind: { group: { agentEnabled: false } }
        })
      }
    });
    const bucket = new Map<string, FakeChannel>();
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
        channelFactory: channelFactory(bucket),
        logger: silentLogger('p2-scope-pause')
      },
      ['10001']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'group', '900');
    await bindTestConversation(core, '10001', 'private', '900');
    await core.start();
    await waitFor(() => core.status().instances[0]?.state === 'online');
    const channel = bucket.get('a')!;

    channel.emitInbound(textInbound('a', '10001', '900', 'group-1', 'group hello', 'group'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(channel.sent).toHaveLength(0);
    expect((await core.readMessages('10001', conversation('10001', '900', 'group'))).length).toBeGreaterThan(0);

    channel.emitInbound(textInbound('a', '10001', '900', 'private-1', 'private hello'));
    await waitFor(() => channel.sent.length === 1);
    expect(channel.sent[0]?.conversation.kind).toBe('private');
  });

  it('drops an in-flight agent reply after pause and does not replay it on resume', async () => {
    const root = await tempRoot('accompany-p2-inflight-pause-');
    await seedRoleCard(root);
    const adapter = new GatedChatAdapter();
    await writePhase1Config(root, {
      providers: [fakeProvider('gated-chat', {}, { adapterId: 'gated-v1' })],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['gated-chat'],
          bindings: { chat: bind('gated-chat', 'text-model') }
        })
      }
    });
    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
      channelFactory: channelFactory(bucket),
      providerAdapters: [adapter],
      logger: silentLogger('p2-inflight')
    });
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '42');
    await core.start();
    await waitFor(() => core.status().instances[0]?.state === 'online');
    const channel = bucket.get('a')!;

    channel.emitInbound(textInbound('a', '10001', '42', 'slow-1', 'slow'));
    await waitFor(() => adapter.started === 1);
    await core.patchAgentEnabled('10001', false);
    adapter.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(channel.sent).toHaveLength(0);

    await core.patchAgentEnabled('10001', true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(channel.sent).toHaveLength(0);
  });
});
