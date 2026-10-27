import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import { silentLogger } from '../src/core/logger.js';
import type { CapabilityId } from '../src/policy/capabilities.js';
import type { CancelMode } from '../src/providers/types.js';
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderCallContext } from '../src/providers/contract.js';
import { bindTestConversation, seedRoleCard } from './helpers.js';
import { accountPolicy, bind, fakeMediaProvider, fakeProvider, textInbound, waitFor, writePhase1Config } from './phase1-helpers.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

class CapturingChatAdapter implements ProviderAdapter {
  readonly id = 'capture-e05';
  readonly requests: ChatRequest[] = [];

  supports(capability: CapabilityId): boolean {
    return capability === 'chat';
  }

  cancelMode(): CancelMode {
    return 'localOnly';
  }

  async chat(_context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    return { text: '收到。' };
  }
}

async function setup(): Promise<{ core: Core; channel: FakeChannel; chat: CapturingChatAdapter }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-skill-e05-'));
  roots.push(root);
  await seedRoleCard(root);
  const chat = new CapturingChatAdapter();
  await writePhase1Config(root, {
    providers: [
      fakeProvider('capture-chat', {}, {
        adapterId: 'capture-e05',
        models: [{ id: 'chat-model', capabilities: ['chat'], input: ['text'], supportsTools: true }]
      }),
      fakeMediaProvider('fake-media')
    ],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['capture-chat', 'fake-media'],
        enabledTools: ['builtin.image.generate'],
        bindings: {
          chat: bind('capture-chat', 'chat-model'),
          'image.generate': bind('fake-media', 'image-model')
        }
      })
    }
  });
  const bucket = new Map<string, FakeChannel>();
  const channelFactory: ChannelFactory = (context) => {
    const channel = new FakeChannel(context, { selfId: context.spec.accountId });
    bucket.set(context.instanceId, channel);
    return channel;
  };
  const core = await createCore({
    dataRoot: root,
    instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
    channelFactory,
    providerAdapters: [chat],
    logger: silentLogger('skill-e05')
  });
  cores.push(core);
  await bindTestConversation(core, '10001', 'group', '90001');
  await core.start();
  await waitFor(() => core.status().instances[0]?.state === 'online');
  return { core, channel: bucket.get('a')!, chat };
}

function serialized(request: ChatRequest): string {
  return JSON.stringify({ messages: request.messages, tools: request.tools ?? [] });
}

it('injects a copied private Skill into the real request and stops after its tool is revoked', async () => {
  const { core, channel, chat } = await setup();

  const publicRevision = core.listPublicSkills().revision;
  await core.savePublicSkill({
    id: 'e05-skill',
    name: 'E05 group summary',
    instructions: 'SKILL_E05_MARKER: summarize the group context.',
    tools: ['builtin.image.generate'],
    kinds: ['group']
  }, publicRevision);
  const privateBefore = core.listPrivateSkills('10001');
  await core.copyPublicSkillToPrivate('10001', 'e05-skill', privateBefore.revision);

  const view = await core.getExtensionPolicy('10001');
  await core.updateExtensionPolicy('10001', {
    expectedRevision: view.revision,
    expectedProfileRevision: view.profileRevision,
    patch: { byKind: { group: { skills: { 'e05-skill': 'on' } } } }
  });

  channel.emitInbound(textInbound('a', '10001', '90001', 'e05-1', '整理一下群里的内容', 'group'));
  await waitFor(() => channel.sent.length === 1, 6_000);
  expect(chat.requests).toHaveLength(1);
  expect(serialized(chat.requests[0]!)).toContain('SKILL_E05_MARKER');
  expect(chat.requests[0]!.tools?.map((tool) => tool.name)).toContain('generate_image');

  const preview = await core.previewSkills('10001', { accountId: '10001', kind: 'group', peerId: '90001' });
  expect(preview.included).toContain('e05-skill');
  expect(preview.skills.find((skill) => skill.id === 'e05-skill')).toMatchObject({
    source: 'private',
    overrides: 'public',
    selected: true,
    enabled: true
  });

  const current = await core.getExtensionPolicy('10001');
  await core.updateExtensionPolicy('10001', { expectedRevision: current.revision, patch: { authorizedTools: [] } });
  const revoked = await core.previewSkills('10001', { accountId: '10001', kind: 'group', peerId: '90001' });
  const entry = revoked.skills.find((skill) => skill.id === 'e05-skill');
  expect(entry).toMatchObject({ enabled: false, selected: false });
  expect(entry!.issues).toContainEqual({ code: 'skill_tool_unavailable', detail: 'builtin.image.generate' });
  expect(revoked.included).not.toContain('e05-skill');

  channel.emitInbound(textInbound('a', '10001', '90001', 'e05-2', '再整理一次', 'group'));
  await waitFor(() => channel.sent.length === 2, 6_000);
  expect(chat.requests).toHaveLength(2);
  expect(serialized(chat.requests[1]!)).not.toContain('SKILL_E05_MARKER');
  expect(chat.requests[1]!.tools?.map((tool) => tool.name) ?? []).not.toContain('generate_image');
});
