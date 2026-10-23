import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/providers/config-store.js';
import { PolicyService } from '../src/policy/policy.js';
import { ExtensionRegistry, SkillRuntime } from '../src/extensions/registry.js';
import { registerBuiltInAgentTools } from '../src/agent/engine.js';
import { ProviderRouter } from '../src/providers/router.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import { silentLogger } from '../src/core/logger.js';
import {
  accountPolicy,
  bind,
  fakeMediaProvider,
  fakeProvider,
  writePhase1Config,
  type RawProvider
} from './phase1-helpers.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup(options: {
  providers: RawProvider[];
  accountPolicies?: Record<string, Record<string, unknown>>;
  skills?: Array<Record<string, unknown>>;
}): Promise<{ router: ProviderRouter; policy: PolicyService; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-p1-policy-'));
  roots.push(root);
  await writePhase1Config(root, options);
  const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
  const policy = new PolicyService(config);
  const extensions = new ExtensionRegistry();
  registerBuiltInAgentTools(extensions);
  const skills = new SkillRuntime(() => config.snapshot().skills);
  const router = new ProviderRouter({
    config,
    policy,
    skills,
    extensions,
    vault: new MemoryCredentialVault(),
    adapters: [new (await import('../src/providers/adapters/fake.js')).FakeProviderAdapter()],
    logger: silentLogger('policy-test')
  });
  return { router, policy, root };
}

function conversation(accountId: string, kind: 'private' | 'group' = 'private', peerId = '42'): ConversationRef {
  return { accountId, kind, peerId };
}

const providers: RawProvider[] = [
  {
    ...fakeProvider('local-chat'),
    models: [{ id: 'text-model', capabilities: ['chat'], input: ['text'], supportsTools: true }]
  },
  fakeMediaProvider('local-media'),
  {
    ...fakeMediaProvider('cloud-media'),
    location: 'cloud',
    baseUrl: 'https://example.invalid/api'
  }
];

describe('phase 1 capability policy', () => {
  it('migrates the legacy image.generate Skill tool reference to the namespaced built-in tool', async () => {
    const { router } = await setup({
      providers,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['local-chat', 'local-media'],
          enabledTools: ['builtin.image.generate'],
          bindings: {
            chat: bind('local-chat', 'text-model'),
            'image.generate': bind('local-media', 'image-model')
          },
          skills: { enabled: ['draw'] }
        })
      },
      skills: [{ id: 'draw', name: 'Draw', instructions: 'Draw only when asked.', tools: ['image.generate'], requires: ['image.generate'] }]
    });
    const effective = await router.effective('10001', conversation('10001'));
    expect(effective.skills.available).toMatchObject([{ id: 'draw', tools: ['builtin.image.generate'], available: true }]);
  });

  it('ignores legacy scoped model and capability settings', async () => {
    const { router } = await setup({
      providers,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['local-chat', 'local-media'],
          enabledTools: ['builtin.image.generate'],
          bindings: {
            chat: bind('local-chat', 'text-model'),
            'image.generate': bind('local-media', 'image-model')
          },
          byKind: { group: { capabilities: { 'image.generate': false } } }
        })
      }
    });
    const privateScope = await router.effective('10001', conversation('10001', 'private'));
    const groupScope = await router.effective('10001', conversation('10001', 'group'));
    expect(privateScope.capabilities.find((capability) => capability.capability === 'image.generate')?.enabled).toBe(true);
    expect(privateScope.capabilities.find((capability) => capability.capability === 'chat')?.enabled).toBe(true);

    const groupGenerate = groupScope.capabilities.find((capability) => capability.capability === 'image.generate');
    expect(groupGenerate).toMatchObject({ enabled: true, providerId: 'local-media', modelId: 'image-model', bindingSource: 'account' });
    expect(groupScope.capabilities.find((capability) => capability.capability === 'chat')?.enabled).toBe(true);
  });

  it('does not let a conversation override the account model binding', async () => {
    const { router } = await setup({
      providers,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['local-chat'],
          bindings: { chat: bind('local-chat', 'text-model') },
          byConversation: {
            'private/42': { bindings: { chat: bind('cloud-media', 'vision-model') } }
          }
        })
      }
    });
    const resolution = router.resolve('10001', conversation('10001'), 'chat');
    expect(resolution).toMatchObject({ enabled: true, providerId: 'local-chat', modelId: 'text-model', bindingSource: 'account' });
  });

  it('blocks cloud media upload unless the account explicitly allows it, and scopes cannot bypass that', async () => {
    const { router } = await setup({
      providers,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['cloud-media'],
          bindings: { 'image.understand': bind('cloud-media', 'vision-model') },
          byKind: { private: { capabilities: { 'image.understand': true } } }
        })
      }
    });
    const blocked = router.resolve('10001', conversation('10001'), 'image.understand', { media: 'image' });
    expect(blocked).toMatchObject({ enabled: false, reason: 'cloud_media_blocked' });

    const { router: allowedRouter } = await setup({
      providers,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['cloud-media'],
          bindings: { 'image.understand': bind('cloud-media', 'vision-model') },
          media: { allowCloudUpload: true }
        })
      }
    });
    const allowed = allowedRouter.resolve('10001', conversation('10001'), 'image.understand', { media: 'image' });
    expect(allowed.enabled).toBe(true);
  });

  it('supports agent pause with a narrower conversation override', async () => {
    const { router } = await setup({
      providers,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['local-chat'],
          bindings: { chat: bind('local-chat', 'text-model') },
          agentEnabled: false,
          byConversation: { 'private/42': { agentEnabled: true } }
        })
      }
    });
    expect((await router.effective('10001', conversation('10001', 'private', '43'))).agentEnabled).toBe(false);
    expect((await router.effective('10001', conversation('10001', 'private', '42'))).agentEnabled).toBe(true);
  });

  it('keeps a scoped legacy capability switch from removing an account-authorized Skill', async () => {
    const { router } = await setup({
      providers,
      skills: [
        {
          id: 'drawer',
          name: 'Image drawer',
          instructions: 'Use the image generation tool only when asked.',
          tools: ['image.generate'],
          requires: ['image.generate']
        }
      ],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['local-chat', 'local-media'],
          enabledTools: ['builtin.image.generate'],
          bindings: {
            chat: bind('local-chat', 'text-model'),
            'image.generate': bind('local-media', 'image-model')
          },
          byKind: { group: { capabilities: { 'image.generate': false } } }
        })
      }
    });
    const privateScope = await router.effective('10001', conversation('10001', 'private'));
    expect(privateScope.skills.available.map((skill) => skill.id)).toEqual(['drawer']);
    const groupScope = await router.effective('10001', conversation('10001', 'group'));
    expect(groupScope.skills.available.map((skill) => skill.id)).toEqual(['drawer']);
    expect(groupScope.skills.unavailable).toEqual([]);
  });

  it('keeps cross-provider fallback disabled by default and reports why', async () => {
    const { router } = await setup({
      providers,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['local-chat', 'cloud-media'],
          bindings: {
            chat: bind('local-chat', 'text-model', {
              fallback: [{ providerId: 'cloud-media', modelId: 'vision-model' }]
            })
          }
        })
      }
    });
    const resolution = router.resolve('10001', conversation('10001'), 'chat');
    expect(resolution.fallback).toEqual([
      {
        providerId: 'cloud-media',
        modelId: 'vision-model',
        valid: false,
        reason: 'cross_provider_fallback_disabled'
      }
    ]);
  });

  it('requires image input support only for explicit direct vision mode', async () => {
    const { router } = await setup({
      providers: [fakeProvider('text-only')],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['text-only'],
          bindings: { chat: bind('text-only', 'text-model') }
        })
      }
    });
    expect(router.resolve('10001', conversation('10001'), 'chat').enabled).toBe(true);
    expect(
      router.resolve('10001', conversation('10001'), 'chat', { media: 'image', directVision: true })
    ).toMatchObject({ enabled: false, reason: 'model_no_image_input' });
  });
});
