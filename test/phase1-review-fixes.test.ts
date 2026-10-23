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
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import type { Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import type {
  ChatResponse,
  ImageGenerationResult,
  ProviderAdapter,
  ProviderCallContext,
  ProviderMedia
} from '../src/providers/contract.js';
import type { CancelMode } from '../src/providers/types.js';
import type { CapabilityId } from '../src/policy/capabilities.js';
import type { JobState } from '../src/jobs/types.js';
import { MediaJobService } from '../src/jobs/service.js';
import { MediaService } from '../src/media/service.js';
import { bindTestConversation, createTestCore, seedRoleCard } from './helpers.js';
import {
  accountPolicy,
  bind,
  fakeProvider,
  TINY_PNG,
  type RawProvider,
  textInbound,
  waitFor,
  writePhase1Config
} from './phase1-helpers.js';

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
  skills: Array<Record<string, unknown>> = []
): Promise<{ router: ProviderRouter; config: ConfigStore }> {
  const root = await tempRoot('accompany-review-fix-');
  await writePhase1Config(root, { providers, accountPolicies, skills });
  const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
  disposables.push(config);
  const router = new ProviderRouter({
    config,
    policy: new PolicyService(config),
    skills: new SkillRuntime(() => config.snapshot().skills),
    extensions: new ExtensionRegistry(),
    vault: new MemoryCredentialVault(),
    adapters,
    logger: silentLogger('review-fixes')
  });
  return { router, config };
}

function imageMedia(accountId = '10001'): ProviderMedia {
  return {
    mediaId: 'm1',
    accountId,
    mimeType: 'image/png',
    bytes: TINY_PNG.length,
    kind: 'image',
    data: TINY_PNG
  };
}

function videoMedia(accountId = '10001'): ProviderMedia {
  return {
    mediaId: 'v1',
    accountId,
    mimeType: 'video/mp4',
    bytes: 8,
    kind: 'video',
    data: Buffer.from('00000000')
  };
}

function conversation(accountId = '10001', peerId = '42') {
  return { accountId, kind: 'private' as const, peerId };
}

const mediaCapability: RawProvider = {
  id: 'p',
  adapterId: 'review-v1',
  baseUrl: 'http://127.0.0.1:9/review',
  location: 'local',
  models: [
    { id: 'image-m', capabilities: ['image.generate'], input: ['text'] },
    { id: 'video-m', capabilities: ['video.understand'], input: ['text', 'video'] }
  ]
};

function mediaPolicy(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return accountPolicy({
    allowedProviders: ['p'],
    bindings: {
      'image.generate': bind('p', 'image-m'),
      'video.understand': bind('p', 'video-m')
    },
    ...extra
  });
}

class CountingAdapter implements ProviderAdapter {
  readonly id = 'review-v1';
  readonly calls: string[] = [];

  supports(capability: CapabilityId): boolean {
    return capability === 'image.generate' || capability === 'video.understand';
  }

  cancelMode(): CancelMode {
    return 'none';
  }

  async imageGenerate(context: ProviderCallContext): Promise<ImageGenerationResult> {
    this.calls.push(`image:${context.model.id}`);
    return { images: [{ data: TINY_PNG, mimeType: 'image/png' }] };
  }

  async videoUnderstand(context: ProviderCallContext) {
    this.calls.push(`video:${context.model.id}`);
    return { summary: 'summary' };
  }
}

describe('phase 1 review fixes', () => {
  it('rejects a cached resolution after the capability is disabled', async () => {
    const adapter = new CountingAdapter();
    const { router, config } = await routerFor([mediaCapability], { '10001': mediaPolicy() }, [adapter]);
    const old = router.resolve('10001', conversation(), 'image.generate');
    expect(old.enabled).toBe(true);
    await config.setAccountPolicy('10001', mediaPolicy({ capabilities: { 'image.generate': false } }));
    await expect(
      router.imageGenerate('10001', conversation(), { prompt: 'a dot' }, new AbortController().signal, undefined, old)
    ).rejects.toMatchObject({ capability: 'image.generate', reason: 'scope_disabled' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('rejects a cached resolution after provider authorization is revoked', async () => {
    const adapter = new CountingAdapter();
    const { router, config } = await routerFor([mediaCapability], { '10001': mediaPolicy() }, [adapter]);
    const old = router.resolve('10001', conversation(), 'image.generate');
    await config.setAccountPolicy('10001', mediaPolicy({ allowedProviders: [] }));
    await expect(
      router.imageGenerate('10001', conversation(), { prompt: 'a dot' }, new AbortController().signal, undefined, old)
    ).rejects.toMatchObject({ reason: 'provider_not_authorized' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('rejects a cached cloud-media resolution after upload permission is revoked', async () => {
    const adapter = new CountingAdapter();
    const cloudProvider: RawProvider = {
      ...mediaCapability,
      baseUrl: 'https://media.example.test/v1',
      location: 'cloud',
      models: [{ id: 'video-m', capabilities: ['video.understand'], input: ['text', 'video'] }]
    };
    const policy = accountPolicy({
      allowedProviders: ['p'],
      bindings: { 'video.understand': bind('p', 'video-m') },
      media: { allowCloudUpload: true }
    });
    const { router, config } = await routerFor([cloudProvider], { '10001': policy }, [adapter]);
    const old = router.resolve('10001', conversation(), 'video.understand', { media: 'video' });
    expect(old.enabled).toBe(true);
    await config.setAccountPolicy(
      '10001',
      accountPolicy({
        allowedProviders: ['p'],
        bindings: { 'video.understand': bind('p', 'video-m') },
        media: { allowCloudUpload: false }
      })
    );
    await expect(
      router.videoUnderstand('10001', conversation(), videoMedia(), 'summarize', new AbortController().signal, () => {}, undefined, old)
    ).rejects.toMatchObject({ reason: 'cloud_media_blocked' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('re-checks authorization before a retry attempt', async () => {
    const provider: RawProvider = {
      id: 'p',
      adapterId: 'retry-revoke-v1',
      baseUrl: 'http://127.0.0.1:9/retry',
      location: 'local',
      models: [{ id: 'chat-m', capabilities: ['chat'], input: ['text'] }],
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
    };
    let calls = 0;
    let configRef: ConfigStore | undefined;
    const adapter: ProviderAdapter = {
      id: 'retry-revoke-v1',
      supports: (capability) => capability === 'chat',
      cancelMode: () => 'none',
      async chat(): Promise<ChatResponse> {
        calls += 1;
        await configRef!.setAccountPolicy(
          '10001',
          accountPolicy({
            allowedProviders: ['p'],
            bindings: { chat: bind('p', 'chat-m') },
            capabilities: { chat: false }
          })
        );
        throw new ProviderError('provider_rate_limit', 'slow down', {
          providerId: 'p',
          capability: 'chat',
          retryable: true,
          retryAfterMs: 1
        });
      }
    };
    const setup = await routerFor(
      [provider],
      { '10001': accountPolicy({ allowedProviders: ['p'], bindings: { chat: bind('p', 'chat-m') } }) },
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
    ).rejects.toMatchObject({ reason: 'scope_disabled' });
    expect(calls).toBe(1);
  });

  it('does not fall back after an image generation outcome is unknown', async () => {
    const called: string[] = [];
    const adapter: ProviderAdapter = {
      id: 'unknown-v1',
      supports: (capability) => capability === 'image.generate' || capability === 'video.understand',
      cancelMode: () => 'none',
      async imageGenerate(context: ProviderCallContext): Promise<ImageGenerationResult> {
        called.push(context.model.id);
        if (context.model.id === 'primary') {
          throw new ProviderError('provider_generate_unknown', 'remote accepted the request', {
            providerId: 'p',
            capability: 'image.generate',
            retryable: false
          });
        }
        return { images: [{ data: TINY_PNG, mimeType: 'image/png' }] };
      },
      async videoUnderstand(context: ProviderCallContext) {
        called.push(`video:${context.model.id}`);
        if (context.model.id === 'video-primary') {
          throw new ProviderError('provider_job_unknown', 'remote job state is unknown', {
            providerId: 'p',
            capability: 'video.understand',
            retryable: false
          });
        }
        return { summary: 'backup' };
      }
    };
    const provider: RawProvider = {
      ...mediaCapability,
      adapterId: 'unknown-v1',
      models: [
        { id: 'primary', capabilities: ['image.generate'], input: ['text'] },
        { id: 'backup', capabilities: ['image.generate'], input: ['text'] },
        { id: 'video-primary', capabilities: ['video.understand'], input: ['text', 'video'] },
        { id: 'video-backup', capabilities: ['video.understand'], input: ['text', 'video'] }
      ]
    };
    const policy = accountPolicy({
      allowedProviders: ['p'],
      bindings: {
        'image.generate': bind('p', 'primary', { fallback: [bind('p', 'backup')] }),
        'video.understand': bind('p', 'video-primary', { fallback: [bind('p', 'video-backup')] })
      }
    });
    const { router } = await routerFor([provider], { '10001': policy }, [adapter]);

    await expect(
      router.imageGenerate('10001', conversation(), { prompt: 'a dot' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'provider_generate_unknown' });
    expect(called).toEqual(['primary']);

    await expect(
      router.videoUnderstand('10001', conversation(), videoMedia(), 'summarize', new AbortController().signal, () => {})
    ).rejects.toMatchObject({ code: 'provider_job_unknown' });
    expect(called).toEqual(['primary', 'video:video-primary']);
  });

  it('creates one job for concurrent submissions of the same actionId', async () => {
    const root = await tempRoot('accompany-fix-jobs-');
    const jobs = new MediaJobService({ accountDir: (accountId) => path.join(root, accountId) });
    disposables.push(jobs);
    let executions = 0;
    const input = {
      accountId: '10001',
      conversation: conversation(),
      capability: 'image.generate' as const,
      turnId: 't1',
      sessionEpoch: 1,
      cancelMode: 'none' as const,
      actionId: 'same-action',
      executor: async () => {
        executions += 1;
        return { text: 'done' };
      }
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => jobs.submit(input)));
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    await waitFor(async () => (await jobs.get('10001', results[0]!.job.id))?.state === 'succeeded');
    expect(executions).toBe(1);
  });

  it('applies account and global job capacity to concurrent submissions', async () => {
    const root = await tempRoot('accompany-fix-jobs-cap-');
    const jobs = new MediaJobService({
      accountDir: (accountId) => path.join(root, accountId),
      maxPerAccountPending: 1,
      maxPendingJobs: 1
    });
    disposables.push(jobs);
    const base = {
      conversation: conversation(),
      capability: 'image.generate' as const,
      turnId: 't',
      sessionEpoch: 1,
      cancelMode: 'none' as const,
      executor: async () => ({ text: 'done' })
    };
    const accountSettled = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        jobs.submit({ ...base, accountId: '10001', actionId: `account-${index}` })
      )
    );
    expect(accountSettled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = accountSettled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected'
    );
    expect(rejected.every((entry) => (entry.reason as { code?: string }).code === 'job_backpressure')).toBe(true);
    const accepted = accountSettled.find(
      (entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof jobs.submit>>> =>
        entry.status === 'fulfilled'
    );
    await waitFor(async () => (await jobs.get('10001', accepted!.value.job.id))?.state === 'succeeded');

    const globalSettled = await Promise.allSettled([
      jobs.submit({ ...base, accountId: '10002', conversation: conversation('10002'), actionId: 'global-a' }),
      jobs.submit({ ...base, accountId: '10003', conversation: conversation('10003'), actionId: 'global-b' })
    ]);
    expect(globalSettled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(
      globalSettled.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')[0]?.reason
    ).toMatchObject({ code: 'job_backpressure' });
  });

  it('keeps concurrent config updates from different callers', async () => {
    const root = await tempRoot('accompany-fix-config-');
    await writePhase1Config(root, { providers: [] });
    const filePath = path.join(root, 'config.v2.json');
    const config = await ConfigStore.load({ filePath });
    disposables.push(config);

    await Promise.all([
      config.setAccountPolicy('20001', accountPolicy({ agentEnabled: false })),
      config.setAccountPolicy('20002', accountPolicy({ agentEnabled: false })),
      config.upsertProvider(mediaCapability),
      config.upsertProvider({
        id: 'second',
        adapterId: 'review-v1',
        baseUrl: 'http://127.0.0.1:9/second',
        location: 'local',
        models: [{ id: 'chat-m', capabilities: ['chat'], input: ['text'] }]
      })
    ]);
    expect(config.accountPolicy('20001')).toBeDefined();
    expect(config.accountPolicy('20002')).toBeDefined();
    expect(config.snapshot().providers.map((provider) => provider.id).sort()).toEqual(['p', 'second']);

    await config.dispose();
    const reloaded = await ConfigStore.load({ filePath });
    disposables.push(reloaded);
    expect(reloaded.accountPolicy('20001')?.agentEnabled).toBe(false);
    expect(reloaded.accountPolicy('20002')?.agentEnabled).toBe(false);
    expect(reloaded.snapshot().providers.map((provider) => provider.id).sort()).toEqual(['p', 'second']);
  });

  it('scopes public skills per account and lets private definitions override them', async () => {
    const { router } = await routerFor(
      [],
      {
        '10001': accountPolicy({
          skills: {
            definitions: [
              { id: 'personal', name: 'Personal A', instructions: 'A private instructions', tools: [] }
            ]
          }
        }),
        '10002': accountPolicy({ skills: { disabled: ['personal'] } })
      },
      [],
      [
        { id: 'personal', name: 'Personal', instructions: 'public instructions', tools: [] },
        { id: 'shared', name: 'Shared', instructions: 'shared instructions', tools: [] }
      ]
    );

    const a = await router.effective('10001', conversation('10001', '555'));
    const b = await router.effective('10002', conversation('10002', '555'));
    const aPersonal = a.skills.available.find((skill) => skill.id === 'personal');
    expect(aPersonal).toMatchObject({ source: 'private', available: true, instructions: 'A private instructions' });
    expect(b.skills.available.map((skill) => skill.id)).toEqual(['shared']);
    expect(b.skills.unavailable.find((skill) => skill.id === 'personal')).toMatchObject({
      source: 'public',
      reason: 'skill_disabled'
    });
    expect(a.skills.available.find((skill) => skill.id === 'shared')?.source).toBe('public');
  });

  it('applies the account skill selection to the actual agent prompt', async () => {
    const root = await tempRoot('accompany-fix-skill-prompt-');
    await seedRoleCard(root);
    const policy = (extra: Record<string, unknown>) =>
      accountPolicy({
        allowedProviders: ['fake-chat'],
        bindings: { chat: bind('fake-chat', 'text-model') },
        ...extra
      });
    await writePhase1Config(root, {
      providers: [fakeProvider('fake-chat', { chatText: 'ok' })],
      accountPolicies: {
        '10001': policy({
          skills: {
            definitions: [
              { id: 'personal', name: 'Personal A', instructions: 'A-only-skill-instructions', tools: [] }
            ]
          }
        }),
        '10002': policy({ skills: { disabled: ['personal'] } })
      },
      skills: [{ id: 'personal', name: 'Personal', instructions: 'public-skill-instructions', tools: [] }]
    });
    const adapter = new FakeProviderAdapter();
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
        logger: silentLogger('fix-skill-prompt')
      },
      ['10001', '10002']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await bindTestConversation(core, '10002', 'private', '555');
    await core.start();
    await waitFor(() => core.status().instances.every((instance) => instance.state === 'online'));

    bucket.get('a')?.emitInbound(textInbound('a', '10001', '555', 'skill-a', 'hello-a'));
    bucket.get('b')?.emitInbound(textInbound('b', '10002', '555', 'skill-b', 'hello-b'));
    await waitFor(
      () => (bucket.get('a')?.sent.length ?? 0) === 1 && (bucket.get('b')?.sent.length ?? 0) === 1
    );
    const promptA = adapter.calls.find((call) => call.requestText?.includes('hello-a'))?.requestText ?? '';
    const promptB = adapter.calls.find((call) => call.requestText?.includes('hello-b'))?.requestText ?? '';
    expect(promptA).toContain('A-only-skill-instructions');
    expect(promptA).not.toContain('public-skill-instructions');
    expect(promptB).not.toContain('A-only-skill-instructions');
    expect(promptB).not.toContain('public-skill-instructions');
  });

  it('times out a slow response body and aborts generated downloads on cancel', async () => {
    const root = await tempRoot('accompany-fix-media-');
    const media = new MediaService({
      accountDir: (accountId) => path.join(root, accountId),
      maxDownloadMs: 25,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(TINY_PNG);
            }
          }),
          { status: 200, headers: { 'content-type': 'image/png' } }
        )
    });
    disposables.push(media);

    const startedAt = Date.now();
    await expect(
      media.ingestInbound('10001', conversation(), {
        type: 'message',
        instanceId: 'a',
        selfId: '10001',
        kind: 'private',
        peerId: '42',
        senderId: '42',
        messageId: 'slow-body',
        at: 1,
        segments: [{ type: 'image', data: { file: 'https://93.184.216.34/image.png' } }],
        selfEcho: false
      })
    ).rejects.toMatchObject({ code: 'media_download_timeout' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    const controller = new AbortController();
    const pending = media.ingestGenerated(
      '10001',
      conversation(),
      'job-1',
      [{ url: 'https://93.184.216.34/generated.png' }],
      controller.signal
    );
    setTimeout(() => controller.abort(new Error('job cancelled')), 10);
    await expect(pending).rejects.toMatchObject({ code: 'media_aborted' });
    expect(await media.list('10001')).toHaveLength(0);
  });

  it('cancels queued media jobs after the capability is revoked and never calls the provider again', async () => {
    const root = await tempRoot('accompany-fix-revoke-');
    await seedRoleCard(root);
    const adapter = new GatedImageAdapter();
    await writePhase1Config(root, {
      providers: [
        {
          id: 'gated-images',
          adapterId: 'gated-image-v1',
          baseUrl: 'http://127.0.0.1:9/gated',
          location: 'local',
          models: [{ id: 'image-m', capabilities: ['image.generate'], input: ['text'] }]
        }
      ],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['gated-images'],
        enabledTools: ['builtin.image.generate'],
          bindings: { 'image.generate': bind('gated-images', 'image-m') }
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
        instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
        channelFactory: factory,
        providerAdapters: [adapter],
        logger: silentLogger('fix-revoke')
      },
      ['10001']
    );
    cores.push(core);
    await bindTestConversation(core, '10001', 'private', '555');
    await core.start();
    await waitFor(() => core.status().instances[0]?.state === 'online');

    bucket.get('a')?.emitInbound(textInbound('a', '10001', '555', 'draw-1', '/draw first'));
    await waitFor(() => adapter.started);
    bucket.get('a')?.emitInbound(textInbound('a', '10001', '555', 'draw-2', '/draw second'));
    await waitFor(async () => (await core.listJobs('10001')).length === 2);

    await core.setAccountPolicy('10001', {
      ...core.getAccountPolicy('10001'),
      capabilities: { 'image.generate': false }
    });
    await waitFor(async () => {
      const jobs = await core.listJobs('10001');
      return jobs.length === 2 && jobs.every((job) => job.state === 'cancelled');
    });
    adapter.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(adapter.calls).toBe(1);
    const sent = bucket.get('a')?.sent ?? [];
    expect(sent.some((entry) => entry.message.segments.some((segment) => segment.type === 'image'))).toBe(false);
    const states: JobState[] = (await core.listJobs('10001')).map((job) => job.state);
    expect(states).toEqual(['cancelled', 'cancelled']);
  });
});

class GatedImageAdapter implements ProviderAdapter {
  readonly id = 'gated-image-v1';
  calls = 0;
  started = false;
  #release: () => void = () => {};
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  supports(capability: CapabilityId): boolean {
    return capability === 'image.generate';
  }

  cancelMode(): CancelMode {
    return 'localOnly';
  }

  async imageGenerate(context: ProviderCallContext): Promise<ImageGenerationResult> {
    this.calls += 1;
    this.started = true;
    await Promise.race([
      this.#gate,
      new Promise<never>((_, reject) => {
        if (context.signal.aborted) {
          reject(context.signal.reason instanceof Error ? context.signal.reason : new Error('aborted'));
          return;
        }
        context.signal.addEventListener(
          'abort',
          () => reject(context.signal.reason instanceof Error ? context.signal.reason : new Error('aborted')),
          { once: true }
        );
      })
    ]);
    return { images: [{ data: TINY_PNG, mimeType: 'image/png' }] };
  }

  release(): void {
    this.#release();
  }
}
