import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../src/providers/config-store.js';
import { PolicyService } from '../src/policy/policy.js';
import { ExtensionRegistry, SkillRuntime } from '../src/extensions/registry.js';
import { ProviderRouter } from '../src/providers/router.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import { silentLogger } from '../src/core/logger.js';
import { ProviderError } from '../src/providers/errors.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import type {
  ChatRequest,
  ChatResponse,
  ImageGenerationRequest,
  ImageGenerationResult,
  ProviderAdapter,
  ProviderCallContext,
  ProviderMedia
} from '../src/providers/contract.js';
import type { CancelMode } from '../src/providers/types.js';
import type { CapabilityId } from '../src/policy/capabilities.js';
import {
  accountPolicy,
  bind,
  fakeProvider,
  TINY_PNG,
  writePhase1Config,
  type RawProvider
} from './phase1-helpers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function routerFor(
  providers: RawProvider[],
  accountPolicies: Record<string, Record<string, unknown>>,
  adapters: ProviderAdapter[]
): Promise<ProviderRouter> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-p1-router-'));
  roots.push(root);
  await writePhase1Config(root, { providers, accountPolicies });
  const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
  const policy = new PolicyService(config);
  const extensions = new ExtensionRegistry();
  return new ProviderRouter({
    config,
    policy,
    skills: new SkillRuntime(() => config.snapshot().skills),
    extensions,
    vault: new MemoryCredentialVault(),
    adapters,
    logger: silentLogger('router-test')
  });
}

const allProvider: RawProvider = {
  id: 'all',
  adapterId: 'fake-v1',
  baseUrl: 'http://127.0.0.1:9/all',
  location: 'local',
  models: [
    { id: 'chat-m', capabilities: ['chat'], input: ['text'] },
    { id: 'vision-m', capabilities: ['image.understand'], input: ['text', 'image'] },
    { id: 'video-m', capabilities: ['video.understand'], input: ['text', 'video'] },
    { id: 'image-m', capabilities: ['image.generate'], input: ['text'] }
  ],
  options: { chatText: 'routed-chat', observation: 'routed-observation', videoSummary: 'routed-video' }
};

const allPolicy = {
  '10001': accountPolicy({
    allowedProviders: ['all'],
    bindings: {
      chat: bind('all', 'chat-m'),
      'image.understand': bind('all', 'vision-m'),
      'video.understand': bind('all', 'video-m'),
      'image.generate': bind('all', 'image-m')
    },
    media: { allowCloudUpload: true }
  })
};

function media(): ProviderMedia {
  return {
    mediaId: 'm1',
    accountId: '10001',
    mimeType: 'image/png',
    bytes: TINY_PNG.length,
    kind: 'image',
    data: TINY_PNG
  };
}

function conversation(accountId = '10001') {
  return { accountId, kind: 'private' as const, peerId: '42' };
}

describe('phase 1 provider routing', () => {
  it('routes the four capabilities to the bound provider/model', async () => {
    const fake = new FakeProviderAdapter();
    const router = await routerFor([allProvider], allPolicy, [fake]);
    const sid = new AbortController().signal;

    const chat = await router.chat('10001', conversation(), {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    }, sid);
    expect(chat.result.text).toBe('routed-chat');

    const image = await router.imageUnderstand('10001', conversation(), media(), 'what is this?', sid);
    expect(image.result.text).toBe('routed-observation');

    const videoMedia = { ...media(), kind: 'video' as const, mimeType: 'video/mp4' };
    const video = await router.videoUnderstand('10001', conversation(), videoMedia, 'summarize', sid, () => {});
    expect(video.result.summary).toBe('routed-video');

    const generated = await router.imageGenerate('10001', conversation(), { prompt: 'a dot' }, sid);
    expect(generated.result.images).toHaveLength(1);

    expect(fake.calls.map((call) => [call.capability, call.providerId, call.modelId])).toEqual([
      ['chat', 'all', 'chat-m'],
      ['image.understand', 'all', 'vision-m'],
      ['video.understand', 'all', 'video-m'],
      ['image.generate', 'all', 'image-m']
    ]);
  });

  it('retries retryable provider failures within the configured bound', async () => {
    const fake = new FakeProviderAdapter();
    const provider: RawProvider = {
      id: 'flaky',
      adapterId: 'fake-v1',
      baseUrl: 'http://127.0.0.1:9/flaky',
      location: 'local',
      models: [{ id: 'chat-m', capabilities: ['chat'], input: ['text'] }],
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      options: { failCapability: 'chat', failRetryable: true, failOnce: true, chatText: 'after-retry' }
    };
    const router = await routerFor(
      [provider],
      { '10001': accountPolicy({ allowedProviders: ['flaky'], bindings: { chat: bind('flaky', 'chat-m') } }) },
      [fake]
    );
    const result = await router.chat('10001', conversation(), {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    }, new AbortController().signal);
    expect(result.result.text).toBe('after-retry');
    expect(result.used.modelId).toBe('chat-m');
  });

  it('uses an explicitly allowed fallback model', async () => {
    const selector: ProviderAdapter = {
      id: 'selector-v1',
      supports: (capability) => capability === 'chat',
      cancelMode: () => 'localOnly',
      async chat(context: ProviderCallContext): Promise<ChatResponse> {
        if (context.model.id === 'primary') {
          throw new ProviderError('provider_auth', 'primary rejected', {
            providerId: context.provider.id,
            capability: 'chat',
            retryable: false
          });
        }
        return { text: 'fallback-reply' };
      }
    };
    const provider: RawProvider = {
      id: 'selector',
      adapterId: 'selector-v1',
      baseUrl: 'http://127.0.0.1:9/selector',
      location: 'local',
      models: [
        { id: 'primary', capabilities: ['chat'], input: ['text'] },
        { id: 'backup', capabilities: ['chat'], input: ['text'] }
      ]
    };
    const router = await routerFor(
      [provider],
      {
        '10001': accountPolicy({
          allowedProviders: ['selector'],
          bindings: { chat: bind('selector', 'primary', { fallback: [{ providerId: 'selector', modelId: 'backup' }] }) }
        })
      },
      [selector]
    );
    const result = await router.chat('10001', conversation(), {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    }, new AbortController().signal);
    expect(result.result.text).toBe('fallback-reply');
    expect(result.used.modelId).toBe('backup');
  });

  it('applies an explicit single-attempt/no-fallback policy without changing normal retry and fallback', async () => {
    let primaryMode: 'fail-once' | 'always-fail' = 'fail-once';
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const adapter: ProviderAdapter = {
      id: 'fake-v1',
      supports: (capability) => capability === 'chat',
      cancelMode: () => 'localOnly',
      async chat(context: ProviderCallContext): Promise<ChatResponse> {
        if (context.provider.id === 'primary') {
          primaryCalls += 1;
          if (primaryMode === 'fail-once' && primaryCalls > 1) return { text: 'primary-after-retry' };
          throw new ProviderError('provider_rate_limited', 'limited', {
            providerId: 'primary',
            capability: 'chat',
            retryable: true
          });
        }
        fallbackCalls += 1;
        return { text: 'fallback-reply' };
      }
    };
    const primary = fakeProvider('primary', {}, { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 } });
    const fallback = fakeProvider('fallback');
    const router = await routerFor(
      [primary, fallback],
      {
        '10001': accountPolicy({
          allowedProviders: ['primary', 'fallback'],
          crossProviderFallback: true,
          bindings: {
            chat: bind('primary', 'text-model', {
              fallback: [{ providerId: 'fallback', modelId: 'text-model' }]
            })
          }
        })
      },
      [adapter]
    );
    const request = { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] };

    const normal = await router.chat('10001', conversation(), request, new AbortController().signal);
    expect(normal.result.text).toBe('primary-after-retry');
    expect([primaryCalls, fallbackCalls]).toEqual([2, 0]);

    primaryMode = 'always-fail';
    primaryCalls = 0;
    fallbackCalls = 0;
    await expect(router.chat('10001', conversation(), request, new AbortController().signal, undefined, {}, undefined, {
      retry: false,
      fallback: false
    })).rejects.toMatchObject({ code: 'provider_rate_limited' });
    expect([primaryCalls, fallbackCalls]).toEqual([1, 0]);

    primaryCalls = 0;
    fallbackCalls = 0;
    const fallbackResult = await router.chat('10001', conversation(), request, new AbortController().signal);
    expect(fallbackResult.result.text).toBe('fallback-reply');
    expect([primaryCalls, fallbackCalls]).toEqual([2, 1]);
  });

  it('shares endpoint concurrency across providers with the same baseUrl', async () => {
    let active = 0;
    let maxActive = 0;
    const adapter: ProviderAdapter = {
      id: 'concurrency-v1',
      supports: (capability) => capability === 'chat',
      cancelMode: () => 'localOnly',
      async chat(): Promise<ChatResponse> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return { text: 'ok' };
      }
    };
    const sharedUrl = 'http://127.0.0.1:9/shared';
    const providers: RawProvider[] = ['p1', 'p2'].map((id) => ({
      id,
      adapterId: 'concurrency-v1',
      baseUrl: sharedUrl,
      location: 'local',
      models: [{ id: 'chat-m', capabilities: ['chat'], input: ['text'] }],
      limits: { maxConcurrent: 1, maxQueue: 4 }
    }));
    const policies = Object.fromEntries(
      ['10001', '10002'].map((accountId, index) => [
        accountId,
        accountPolicy({
          allowedProviders: [providers[index]!.id],
          bindings: { chat: bind(providers[index]!.id, 'chat-m') }
        })
      ])
    );
    const router = await routerFor(providers, policies, [adapter]);
    const signal = new AbortController().signal;
    await Promise.all([
      router.chat('10001', conversation('10001'), {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }]
      }, signal),
      router.chat('10002', conversation('10002'), {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'b' }] }]
      }, signal)
    ]);
    expect(maxActive).toBe(1);
  });

  it('rechecks tool authorization after waiting for the provider endpoint limiter', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-tool-queue-'));
    roots.push(root);
    const provider: RawProvider = {
      ...allProvider,
      limits: { maxConcurrent: 1, maxQueue: 4 }
    };
    const rawPolicy = accountPolicy({
      allowedProviders: ['all'],
      enabledTools: ['builtin.image.generate'],
      bindings: {
        chat: bind('all', 'chat-m'),
        'image.generate': bind('all', 'image-m')
      }
    });
    await writePhase1Config(root, { providers: [provider], accountPolicies: { '10001': rawPolicy } });
    const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
    let releaseChat!: () => void;
    let enteredChat!: () => void;
    const chatBlocked = new Promise<void>((resolve) => { releaseChat = resolve; });
    const chatEntered = new Promise<void>((resolve) => { enteredChat = resolve; });
    let imageCalls = 0;
    const adapter: ProviderAdapter = {
      id: 'fake-v1',
      supports: (capability) => capability === 'chat' || capability === 'image.generate',
      cancelMode: () => 'localOnly',
      async chat(_context: ProviderCallContext, _request: ChatRequest): Promise<ChatResponse> {
        enteredChat();
        await chatBlocked;
        return { text: 'done' };
      },
      async imageGenerate(_context: ProviderCallContext, _request: ImageGenerationRequest): Promise<ImageGenerationResult> {
        imageCalls += 1;
        return { images: [{ mimeType: 'image/png', base64: TINY_PNG.toString('base64') }] };
      }
    };
    const router = new ProviderRouter({
      config,
      policy: new PolicyService(config),
      skills: new SkillRuntime(() => config.snapshot().skills),
      extensions: new ExtensionRegistry(),
      vault: new MemoryCredentialVault(),
      adapters: [adapter],
      logger: silentLogger('router-test')
    });
    const signal = new AbortController().signal;
    const blocker = router.chat('10001', conversation(), {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hold endpoint' }] }]
    }, signal);
    await chatEntered;
    const queuedImage = router.imageGenerate(
      '10001', conversation(), { prompt: 'a paid image' }, signal, undefined,
      router.resolve('10001', conversation(), 'image.generate'), 'builtin.image.generate'
    );
    await vi.waitFor(() => expect(router.endpoints().some((entry) => entry.queued === 1)).toBe(true));
    await config.setAccountPolicy('10001', accountPolicy({
      allowedProviders: ['all'],
      bindings: {
        chat: bind('all', 'chat-m'),
        'image.generate': bind('all', 'image-m')
      }
    }));
    releaseChat();
    await blocker;
    await expect(queuedImage).rejects.toMatchObject({ reason: 'tool_not_authorized' });
    expect(imageCalls).toBe(0);
  });

  it('does not start a queued media generation after the conversation role changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-role-queue-'));
    roots.push(root);
    const provider: RawProvider = { ...allProvider, limits: { maxConcurrent: 1, maxQueue: 4 } };
    const policyData = accountPolicy({
      allowedProviders: ['all'],
      enabledTools: ['builtin.image.generate'],
      bindings: { chat: bind('all', 'chat-m'), 'image.generate': bind('all', 'image-m') }
    });
    await writePhase1Config(root, { providers: [provider], accountPolicies: { '10001': policyData } });
    const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
    let releaseChat!: () => void;
    let enteredChat!: () => void;
    const chatBlocked = new Promise<void>((resolve) => { releaseChat = resolve; });
    const chatEntered = new Promise<void>((resolve) => { enteredChat = resolve; });
    let imageCalls = 0;
    const adapter: ProviderAdapter = {
      id: 'fake-v1',
      supports: (capability) => capability === 'chat' || capability === 'image.generate',
      cancelMode: () => 'localOnly',
      async chat(): Promise<ChatResponse> { enteredChat(); await chatBlocked; return { text: 'done' }; },
      async imageGenerate(): Promise<ImageGenerationResult> {
        imageCalls += 1;
        return { images: [{ mimeType: 'image/png', base64: TINY_PNG.toString('base64') }] };
      }
    };
    const router = new ProviderRouter({
      config,
      policy: new PolicyService(config),
      skills: new SkillRuntime(() => config.snapshot().skills),
      extensions: new ExtensionRegistry(),
      vault: new MemoryCredentialVault(),
      adapters: [adapter],
      logger: silentLogger('router-test')
    });
    const signal = new AbortController().signal;
    const blocker = router.chat('10001', conversation(), {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hold endpoint' }] }]
    }, signal);
    await chatEntered;
    let roleCurrent = true;
    const queuedImage = router.imageGenerate(
      '10001', conversation(), { prompt: 'queued under old role' }, signal, undefined,
      router.resolve('10001', conversation(), 'image.generate'), 'builtin.image.generate',
      async () => roleCurrent
    );
    await vi.waitFor(() => expect(router.endpoints().some((entry) => entry.queued === 1)).toBe(true));
    roleCurrent = false;
    releaseChat();
    await blocker;
    await expect(queuedImage).rejects.toMatchObject({ reason: 'role_binding_changed' });
    expect(imageCalls).toBe(0);
  });

  it('surfaces missing capability without disabling other capabilities', async () => {
    const fake = new FakeProviderAdapter();
    const provider = {
      ...allProvider,
      models: allProvider.models.filter((model) => !model.capabilities.includes('video.understand'))
    };
    const policy = {
      '10001': accountPolicy({
        allowedProviders: ['all'],
        bindings: {
          chat: bind('all', 'chat-m'),
          'video.understand': bind('all', 'video-m')
        }
      })
    };
    const router = await routerFor([provider], policy, [fake]);
    const effective = await router.effective('10001', conversation());
    expect(effective.capabilities.find((entry) => entry.capability === 'chat')?.enabled).toBe(true);
    expect(effective.capabilities.find((entry) => entry.capability === 'video.understand')).toMatchObject({
      enabled: false,
      reason: 'model_not_found'
    });
  });
});
