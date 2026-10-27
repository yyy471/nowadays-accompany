import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import { silentLogger } from '../src/core/logger.js';
import type { CapabilityId } from '../src/policy/capabilities.js';
import type { CancelMode } from '../src/providers/types.js';
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderCallContext } from '../src/providers/contract.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { GENERATE_AUDIO_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME } from '../src/agent/engine.js';
import { bindTestConversation, seedRoleCard } from './helpers.js';
import {
  accountPolicy,
  bind,
  fakeMediaProvider,
  fakeProvider,
  textInbound,
  waitFor,
  writePhase1Config
} from './phase1-helpers.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

class ScriptedChatAdapter implements ProviderAdapter {
  readonly id = 'scripted-v1';
  readonly requests: ChatRequest[] = [];
  #round = 0;

  constructor(private readonly script: ChatResponse[]) {}

  supports(capability: CapabilityId): boolean {
    return capability === 'chat';
  }

  cancelMode(): CancelMode {
    return 'localOnly';
  }

  async chat(_context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    const continuing = request.messages.some((message) => message.role === 'tool' || message.toolCalls !== undefined);
    if (continuing) this.#round += 1;
    else this.#round = 0;
    return structuredClone(this.script[Math.min(this.#round, this.script.length - 1)] ?? { text: '脚本结束' });
  }
}

async function setup(
  script: ChatResponse[],
  options: { voice?: 'unsupported' | 'unknown'; tools?: string[] } = {}
): Promise<{ core: Core; channel: FakeChannel; chat: ScriptedChatAdapter; media: FakeProviderAdapter; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-media-tools-'));
  roots.push(root);
  await seedRoleCard(root);
  const chat = new ScriptedChatAdapter(script);
  const media = new FakeProviderAdapter();
  const tools = options.tools ?? ['builtin.image.generate', 'builtin.audio.generate'];
  await writePhase1Config(root, {
    providers: [
      fakeProvider('scripted-chat', {}, {
        adapterId: 'scripted-v1',
        models: [{ id: 'chat-model', capabilities: ['chat'], input: ['text', 'image'], supportsTools: true }]
      }),
      fakeMediaProvider('fake-media')
    ],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['scripted-chat', 'fake-media'],
        enabledTools: tools,
        bindings: {
          chat: bind('scripted-chat', 'chat-model'),
          'image.generate': bind('fake-media', 'image-model'),
          'audio.generate': bind('fake-media', 'audio-model')
        }
      })
    }
  });
  const bucket = new Map<string, FakeChannel>();
  const channelFactory: ChannelFactory = (context) => {
    const channel = new FakeChannel(context, {
      selfId: context.spec.accountId,
      ...(options.voice ? { voiceDeliverySupport: options.voice } : {})
    });
    bucket.set(context.instanceId, channel);
    return channel;
  };
  const core = await createCore({
    dataRoot: root,
    instances: [{ id: 'a', backend: 'fake', accountId: '10001', restart: { enabled: false } }],
    channelFactory,
    providerAdapters: [chat, media],
    logger: silentLogger('media-tools')
  });
  cores.push(core);
  await bindTestConversation(core, '10001', 'private', '555');
  await core.start();
  await waitFor(() => core.status().instances[0]?.state === 'online');
  return { core, channel: bucket.get('a')!, chat, media, root };
}

function speechCall(id: string, text = 'hello out loud'): { id: string; name: string; arguments: Record<string, unknown> } {
  return { id, name: GENERATE_AUDIO_TOOL_NAME, arguments: { text } };
}

function imageCall(id: string, prompt = 'a cat'): { id: string; name: string; arguments: Record<string, unknown> } {
  return { id, name: GENERATE_IMAGE_TOOL_NAME, arguments: { prompt } };
}

function lastToolText(request: ChatRequest): string {
  const tool = request.messages.filter((message) => message.role === 'tool').at(-1);
  return tool ? ((tool.content[0] as { text?: string }).text ?? '') : '';
}

function sentTexts(channel: FakeChannel): string[] {
  return channel.sent.map((entry) =>
    entry.message.segments
      .filter((segment) => segment.type === 'text')
      .map((segment) => (segment.data as { text?: string }).text ?? '')
      .join('')
  );
}

describe('builtin media tools through the unified executor', () => {
  it('submits speech as a media job and reports the job id without claiming delivery', async () => {
    const { core, channel, chat, media, root } = await setup([
      { text: '', toolCalls: [speechCall('speech-1')] },
      { text: '语音马上就好。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'speech-1', 'say it out loud'));
    await waitFor(() => chat.requests.length === 2, 6_000);
    await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent', 6_000);
    expect(channel.sent).toHaveLength(2);

    const toolText = lastToolText(chat.requests[1]!);
    expect(toolText).toContain('正在生成语音；完成后会尝试按当前通道能力发送。');
    expect(toolText).not.toContain('已经发送');
    expect(media.calls.filter((call) => call.capability === 'audio.generate')).toHaveLength(1);

    const jobs = await core.listJobs('10001');
    expect(jobs).toMatchObject([{ capability: 'audio.generate', state: 'succeeded', delivery: 'sent' }]);
    const ledger = await fs.readFile(path.join(root, 'accounts', '10001', 'state', 'tool-invocations.json'), 'utf8');
    expect(ledger).toContain('"status":"submitted"');
    expect(/\"jobId\":\"([^\"]+)\"/.exec(ledger)?.[1]).toBe(jobs[0]!.id);
    expect(sentTexts(channel)[0]).toBe('语音马上就好。');
    expect(channel.sent[1]!.message.segments[0]?.type).toBe('record');
  });

  it('bills each host invocation once and keeps every speech round paired', async () => {
    const { core, channel, chat, media } = await setup([
      { text: '', toolCalls: [speechCall('same-speech')] },
      { text: '', toolCalls: [speechCall('same-speech')] },
      { text: '', toolCalls: [speechCall('same-speech')] },
      { text: '好的。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'same-speech', 'say it three times'));
    await waitFor(() => channel.sent.length === 4, 10_000);

    // 宿主键包含消息、回合与序号：不同模型回合是三次独立动作；只有同一宿主调用的重投才复用账本。
    expect(media.calls.filter((call) => call.capability === 'audio.generate')).toHaveLength(3);
    expect(await core.listJobs('10001')).toHaveLength(3);
    expect(lastToolText(chat.requests[3]!)).toContain('正在生成语音；完成后会尝试按当前通道能力发送。');

    channel.emitInbound(textInbound('a', '10001', '555', 'same-speech', 'say it three times'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(media.calls.filter((call) => call.capability === 'audio.generate')).toHaveLength(3);
    expect(await core.listJobs('10001')).toHaveLength(3);
  });

  it('keeps the channel boundary when voice support is unknown', async () => {
    const { core, channel, chat } = await setup(
      [
        { text: '', toolCalls: [speechCall('speech-unknown')] },
        { text: '语音生成中。' }
      ],
      { voice: 'unknown' }
    );
    channel.emitInbound(textInbound('a', '10001', '555', 'speech-unknown', 'say it out loud'));
    await waitFor(() => chat.requests.length === 2, 6_000);
    await waitFor(
      () => sentTexts(channel).includes('语音已生成，但当前通道尚未确认支持语音交付。'),
      6_000
    );

    const jobs = await core.listJobs('10001');
    expect(jobs).toMatchObject([{ capability: 'audio.generate', state: 'succeeded', delivery: 'skipped' }]);
    expect(channel.sent.every((entry) => entry.message.segments[0]?.type !== 'record')).toBe(true);
  });

  it('does not deliver generated images after the agent is paused mid-generation', async () => {
    const { core, channel, media } = await setup([
      { text: '', toolCalls: [imageCall('pause-image')] },
      { text: '图片生成中。' }
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const original = media.imageGenerate.bind(media);
    vi.spyOn(media, 'imageGenerate').mockImplementationOnce(async (context, request) => {
      entered();
      await gate;
      return original(context, request);
    });

    channel.emitInbound(textInbound('a', '10001', '555', 'pause-image', 'draw a cat'));
    await started;
    await core.patchAgentEnabled('10001', false);
    await waitFor(() => core.status().instances[0]?.hostEpoch === 2, 6_000);
    release();

    await waitFor(async () => {
      const job = (await core.listJobs('10001'))[0];
      return job !== undefined && job.state !== 'running' && job.delivery !== 'sent';
    }, 8_000);
    expect(channel.sent.every((entry) => entry.message.segments[0]?.type !== 'image')).toBe(true);
  });
});
