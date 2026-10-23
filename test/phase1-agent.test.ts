import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { createTestCore, TEST_ROLE_CARD_CONTENT } from './helpers.js';
import {
  accountPolicy,
  bind,
  fakeMediaProvider,
  fakeProvider,
  fakeToolChatProvider,
  imageSegment,
  textInbound,
  inbound,
  videoSegment,
  waitFor,
  writePhase1Config,
  type RawProvider
} from './phase1-helpers.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Setup {
  core: Core;
  channels: Map<string, FakeChannel>;
  adapter: FakeProviderAdapter;
  root: string;
}

async function setupAgent(options: {
  providers: RawProvider[];
  accountPolicies: Record<string, Record<string, unknown>>;
  adapter?: FakeProviderAdapter;
  limits?: Record<string, number>;
  agent?: { maxHistoryMessages?: number; maxHistoryChars?: number };
}): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-p1-agent-'));
  roots.push(root);
  await writePhase1Config(root, {
    providers: options.providers,
    accountPolicies: options.accountPolicies
  });
  const adapter = options.adapter ?? new FakeProviderAdapter();
  const channels = new Map<string, FakeChannel>();
  const core = await createTestCore(
    {
      dataRoot: root,
      instances: [
        { id: 'a', backend: 'fake', accountId: '10001' },
        { id: 'b', backend: 'fake', accountId: '10002' }
      ],
      channelFactory: (context) => {
        const channel = new FakeChannel(context, { selfId: context.spec.accountId });
        channels.set(context.instanceId, channel);
        return channel;
      },
      providerAdapters: [adapter],
      credentialVault: new MemoryCredentialVault(),
      limits: { hostTimeoutMs: 5_000, ...(options.limits ?? {}) },
      ...(options.agent ? { agent: options.agent } : {}),
      logger: silentLogger('p1-agent')
    },
    ['10001', '10002']
  );
  cores.push(core);
  // These tests deliberately model explicitly bound conversations; roleCard in
  // profile.json is migration-only and must not supply an automatic fallback.
  for (const accountId of ['10001', '10002']) {
    await core.setConversationRoleBinding(
      { accountId, kind: 'private', peerId: '555' },
      { source: 'public', id: 'default' }
    );
    await core.setConversationRoleBinding(
      { accountId, kind: 'group', peerId: '777' },
      { source: 'public', id: 'default' }
    );
  }
  await core.start();
  await waitFor(() => core.status().instances.every((instance) => instance.state === 'online'));
  return { core, channels, adapter, root };
}

function chatPolicy(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return accountPolicy({
    allowedProviders: ['fake-chat'],
    bindings: { chat: bind('fake-chat', 'text-model') },
    ...extra
  });
}

function accountProviders(): RawProvider[] {
  return [fakeProvider('fake-chat', { chatText: 'agent reply' })];
}

describe('phase 1 built-in agent loop', () => {
  it('replies with the role card, includes the current message once and isolates account history', async () => {
    const { core, channels, adapter } = await setupAgent({
      providers: accountProviders(),
      accountPolicies: { '10001': chatPolicy(), '10002': chatPolicy() }
    });

    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'm1', 'first message'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 1);
    expect(channels.get('a')?.sent[0]?.message.segments[0]).toEqual({ type: 'text', data: { text: 'agent reply' } });
    expect(adapter.calls[0]?.requestText).toContain(TEST_ROLE_CARD_CONTENT);
    expect(adapter.calls[0]?.requestText?.split('first message').length).toBe(2);

    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'm2', 'second message'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 2);
    const secondPrompt = adapter.calls[1]?.requestText ?? '';
    expect(secondPrompt).toContain('first message');
    expect(secondPrompt.split('second message').length).toBe(2);

    channels.get('b')?.emitInbound(textInbound('b', '10002', '555', 'm1', 'only-b'));
    await waitFor(() => (channels.get('b')?.sent.length ?? 0) === 1);
    const bPrompt = adapter.calls[2]?.requestText ?? '';
    expect(bPrompt).toContain('only-b');
    expect(bPrompt).not.toContain('second message');

    expect(core.status().instances.find((instance) => instance.id === 'a')?.agent).toEqual({
      mode: 'agent',
      configured: true
    });
  });

  it('sends images to external image understanding and gives chat a provenance-tagged observation', async () => {
    const adapter = new FakeProviderAdapter();
    const { channels } = await setupAgent({
      providers: [...accountProviders(), fakeMediaProvider('fake-media', { observation: 'a red square' })],
      adapter,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-media'],
          bindings: {
            chat: bind('fake-chat', 'text-model'),
            'image.understand': bind('fake-media', 'vision-model')
          }
        })
      }
    });
    channels.get('a')?.emitInbound(
      inbound('a', '10001', '555', 'img-1', [imageSegment(), { type: 'text', data: { text: 'what is this?' } }])
    );
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 1);
    const imageCall = adapter.calls.find((call) => call.capability === 'image.understand');
    expect(imageCall?.providerId).toBe('fake-media');
    const chatCall = adapter.calls.find((call) => call.capability === 'chat');
    expect(chatCall?.requestText).toContain('a red square');
    expect(chatCall?.requestText).toContain('<observation');
    expect(chatCall?.requestText).not.toContain('[image]');
  });

  it('blocks both external and direct image input when image understanding is disabled', async () => {
    const adapter = new FakeProviderAdapter();
    const provider: RawProvider = {
      ...fakeProvider('fake-chat', { chatText: 'should not run' }),
      models: [{ id: 'text-model', capabilities: ['chat'], input: ['text', 'image'], supportsTools: false }]
    };
    const { channels } = await setupAgent({
      providers: [provider, fakeMediaProvider('fake-media')],
      adapter,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-media'],
          bindings: {
            chat: bind('fake-chat', 'text-model'),
            'image.understand': bind('fake-media', 'vision-model')
          },
          visionMode: 'direct',
          capabilities: { 'image.understand': false }
        })
      }
    });
    channels.get('a')?.emitInbound(
      inbound('a', '10001', '555', 'img-disabled', [imageSegment(), { type: 'text', data: { text: 'look' } }])
    );
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 1);
    const reply = channels.get('a')?.sent[0]?.message.segments[0]?.data as { text?: string };
    expect(reply.text).toContain('图片理解');
    expect(adapter.calls.some((call) => call.capability === 'image.understand')).toBe(false);
    const chat = adapter.calls.find((call) => call.capability === 'chat');
    expect(chat?.requestText).not.toContain('[image]');
    expect(chat?.requestText).toContain('look');
  });

  it('does not leak a private observation or history into a group conversation', async () => {
    const { channels, adapter } = await setupAgent({
      providers: [...accountProviders(), fakeMediaProvider('fake-media', { observation: 'PRIVATE-OBSERVATION' })],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-media'],
          bindings: {
            chat: bind('fake-chat', 'text-model'),
            'image.understand': bind('fake-media', 'vision-model')
          }
        })
      }
    });

    channels.get('a')?.emitInbound(
      inbound('a', '10001', '555', 'private-obs', [imageSegment(), { type: 'text', data: { text: 'private question' } }])
    );
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 1);
    expect(adapter.calls.find((call) => call.capability === 'chat')?.requestText).toContain('PRIVATE-OBSERVATION');

    channels.get('a')?.emitInbound(textInbound('a', '10001', '777', 'group-msg', 'group question', 'group', '20001'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 2);
    const groupChat = adapter.calls.filter((call) => call.capability === 'chat')[1];
    expect(groupChat?.requestText).toContain('group question');
    expect(groupChat?.requestText).not.toContain('PRIVATE-OBSERVATION');
    expect(groupChat?.requestText).not.toContain('private question');
  });

  it('runs video understanding as a media job and returns to the original conversation', async () => {
    const { core, channels } = await setupAgent({
      providers: [...accountProviders(), fakeMediaProvider('fake-media', { videoSummary: 'video summary' })],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-media'],
          bindings: {
            chat: bind('fake-chat', 'text-model'),
            'video.understand': bind('fake-media', 'video-model')
          }
        })
      }
    });
    channels.get('a')?.emitInbound(inbound('a', '10001', '555', 'vid-1', [videoSegment()]));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) >= 1);
    expect((channels.get('a')?.sent[0]?.message.segments[0]?.data as { text?: string }).text).toContain('正在理解视频');

    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 2, 6_000);
    const finalText = (channels.get('a')?.sent[1]?.message.segments[0]?.data as { text?: string }).text ?? '';
    expect(finalText).toContain('agent reply');
    await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent');
    const jobs = await core.listJobs('10001');
    expect(jobs[0]).toMatchObject({
      capability: 'video.understand',
      state: 'succeeded',
      delivery: 'sent'
    });
    expect(jobs[0]?.conversation).toEqual({ accountId: '10001', kind: 'private', peerId: '555' });
  });

  it('generates images from an explicit command and sends through the instance outlet', async () => {
    const { core, channels, root } = await setupAgent({
      providers: [...accountProviders(), fakeMediaProvider('fake-media')],
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-media'],
          enabledTools: ['builtin.image.generate'],
          bindings: {
            chat: bind('fake-chat', 'text-model'),
            'image.generate': bind('fake-media', 'image-model')
          }
        })
      }
    });
    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'draw-1', '/draw a tiny cat'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) >= 1);
    expect((channels.get('a')?.sent[0]?.message.segments[0]?.data as { text?: string }).text).toContain('正在生成图片');

    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 2, 6_000);
    const image = channels.get('a')?.sent[1]?.message.segments[0];
    expect(image?.type).toBe('image');
    expect(String((image?.data as { file?: unknown }).file)).toMatch(/^base64:\/\//);
    await waitFor(async () => (await core.listMedia('10001')).length === 1);
    const media = await core.listMedia('10001');
    expect(media[0]).toMatchObject({ accountId: '10001', kind: 'image' });

    await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent');
    const job = (await core.listJobs('10001'))[0];
    expect(job).toMatchObject({ state: 'succeeded', delivery: 'sent', capability: 'image.generate' });

    const historyFile = path.join(root, 'accounts', '10001', 'messages', 'private', '555', '000001.jsonl');
    const lines = (await fs.readFile(historyFile, 'utf8')).trim().split('\n');
    const outboundImages = lines
      .map((line) => JSON.parse(line) as { direction: string; segments: unknown[] })
      .filter((record) => record.direction === 'out')
      .flatMap((record) => record.segments)
      .filter((segment) => (segment as { type?: string }).type === 'image');
    expect(outboundImages).toHaveLength(1);
    expect(JSON.stringify(outboundImages[0])).toContain('media://');
    expect(JSON.stringify(outboundImages[0])).not.toContain('base64://');
  });

  it('executes a model tool call for image generation only when the tool is authorized', async () => {
    const adapter = new FakeProviderAdapter();
    const toolChat = fakeToolChatProvider('fake-chat', {
      chatText: '',
      toolCall: { name: 'generate_image', arguments: { prompt: 'tool cat' } }
    });
    const { core, channels } = await setupAgent({
      providers: [toolChat, fakeMediaProvider('fake-media')],
      adapter,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-media'],
          enabledTools: ['builtin.image.generate'],
          bindings: {
            chat: bind('fake-chat', 'tool-model'),
            'image.generate': bind('fake-media', 'image-model')
          }
        })
      }
    });
    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'tool-1', 'please draw a cat'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 2, 6_000);
    expect(channels.get('a')?.sent[1]?.message.segments[0]?.type).toBe('image');
    expect(adapter.calls.find((call) => call.capability === 'image.generate')?.promptText).toBe('tool cat');
    await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent');
    expect((await core.listJobs('10001'))[0]).toMatchObject({ state: 'succeeded', delivery: 'sent' });
  });

  it('generates authorized speech as account media and delivers a record segment on a capable channel', async () => {
    const adapter = new FakeProviderAdapter();
    const toolChat = fakeToolChatProvider('fake-chat', {
      toolCall: { name: 'generate_speech', arguments: { text: 'hello in a voice' } }
    });
    const { core, channels } = await setupAgent({
      providers: [toolChat, fakeMediaProvider('fake-audio')],
      adapter,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-audio'],
          enabledTools: ['builtin.audio.generate'],
          bindings: {
            chat: bind('fake-chat', 'tool-model'),
            'audio.generate': bind('fake-audio', 'audio-model')
          }
        })
      }
    });

    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'audio-tool-1', 'say hello aloud'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 2, 6_000);
    expect(channels.get('a')?.sent[1]?.message.segments[0]?.type).toBe('record');
    expect(adapter.calls.find((call) => call.capability === 'audio.generate')?.promptText).toBe('hello in a voice');
    const media = await core.listMedia('10001');
    expect(media).toMatchObject([{ accountId: '10001', kind: 'audio', mimeType: 'audio/wav' }]);
    await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent');
    expect((await core.listJobs('10001'))[0]).toMatchObject({ capability: 'audio.generate', state: 'succeeded', delivery: 'sent' });
  });

  it('does not execute speech when AI tool permission is not enabled', async () => {
    const adapter = new FakeProviderAdapter();
    const toolChat = fakeToolChatProvider('fake-chat', {
      toolCall: { name: 'generate_speech', arguments: { text: 'unapproved speech' } }
    });
    const { channels } = await setupAgent({
      providers: [toolChat, fakeMediaProvider('fake-audio')],
      adapter,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-audio'],
          bindings: {
            chat: bind('fake-chat', 'tool-model'),
            'audio.generate': bind('fake-audio', 'audio-model')
          }
        })
      }
    });
    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'audio-tool-denied', 'say hello aloud'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) >= 1, 6_000);
    expect(adapter.calls.some((call) => call.capability === 'audio.generate')).toBe(false);
    expect(channels.get('a')?.sent.some((item) => item.message.segments.some((segment) => segment.type === 'record'))).toBe(false);
  });

  it('pauses agent replies while keeping QQ online and manual sends available', async () => {
    const { core, channels } = await setupAgent({
      providers: accountProviders(),
      accountPolicies: { '10001': chatPolicy({ agentEnabled: false }) }
    });
    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'paused-1', 'hello?'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(channels.get('a')?.sent).toHaveLength(0);
    expect(core.status().instances.find((instance) => instance.id === 'a')?.state).toBe('online');

    await core.send(
      'a',
      { accountId: '10001', kind: 'private', peerId: '555' },
      { segments: [{ type: 'text', data: { text: 'manual message' } }] }
    );
    expect(channels.get('a')?.sent).toHaveLength(1);

    await core.patchAgentEnabled('10001', true);
    await waitFor(() => core.status().instances.find((instance) => instance.id === 'a')?.agent?.configured === true);
    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'paused-2', 'now reply'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 2);
    expect((channels.get('a')?.sent[1]?.message.segments[0]?.data as { text?: string }).text).toBe('agent reply');
  });

  it('keeps text chat working when image understanding fails, without marking QQ offline', async () => {
    const adapter = new FakeProviderAdapter();
    const { core, channels } = await setupAgent({
      providers: [
        ...accountProviders(),
        fakeMediaProvider('fake-media', { failCapability: 'image.understand', failMessage: 'vision unavailable' })
      ],
      adapter,
      accountPolicies: {
        '10001': accountPolicy({
          allowedProviders: ['fake-chat', 'fake-media'],
          bindings: {
            chat: bind('fake-chat', 'text-model'),
            'image.understand': bind('fake-media', 'vision-model')
          }
        })
      }
    });
    channels.get('a')?.emitInbound(
      inbound('a', '10001', '555', 'img-fail', [imageSegment(), { type: 'text', data: { text: 'caption this' } }])
    );
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 1);
    const reply = (channels.get('a')?.sent[0]?.message.segments[0]?.data as { text?: string }).text ?? '';
    expect(reply).toContain('agent reply');
    expect(reply).toContain('图片理解失败');
    expect(core.status().instances.find((instance) => instance.id === 'a')?.state).toBe('online');

    channels.get('a')?.emitInbound(textInbound('a', '10001', '555', 'text-after', 'plain text'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 2);
  });

  it('does not pretend to understand a video when no video capability is configured', async () => {
    const { core, channels } = await setupAgent({
      providers: accountProviders(),
      accountPolicies: { '10001': chatPolicy() }
    });
    channels.get('a')?.emitInbound(inbound('a', '10001', '555', 'vid-missing', [videoSegment()]));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 1);
    const reply = (channels.get('a')?.sent[0]?.message.segments[0]?.data as { text?: string }).text ?? '';
    expect(reply).toContain('视频理解');
    expect(reply).toContain('未配置');
    expect(core.status().instances.find((instance) => instance.id === 'a')?.state).toBe('online');
  });

  it('preserves group sender identity in context and keeps history bounded', async () => {
    const { channels, adapter } = await setupAgent({
      providers: accountProviders(),
      accountPolicies: { '10001': chatPolicy() },
      agent: { maxHistoryMessages: 2, maxHistoryChars: 4_000 }
    });
    channels.get('a')?.emitInbound(textInbound('a', '10001', '777', 'g1', 'group hello', 'group', '20001'));
    await waitFor(() => (channels.get('a')?.sent.length ?? 0) === 1);
    expect(adapter.calls[0]?.requestText).toContain('[20001] group hello');
    expect(adapter.calls[0]?.messageCount).toBeLessThanOrEqual(4);
  });
});
