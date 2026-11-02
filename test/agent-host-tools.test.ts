import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import { silentLogger } from '../src/core/logger.js';
import type { CapabilityId } from '../src/policy/capabilities.js';
import type { CancelMode } from '../src/providers/types.js';
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderCallContext } from '../src/providers/contract.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import {
  RECALL_HISTORY_TOOL_NAME,
  SEND_MEDIA_TOOL_NAME
} from '../src/agent/engine.js';
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
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

function userText(request: ChatRequest): string {
  const user = [...request.messages].reverse().find((message) => message.role === 'user');
  if (!user) return '';
  return user.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function lastToolText(request: ChatRequest): string {
  const tool = request.messages.filter((message) => message.role === 'tool').at(-1);
  return tool ? ((tool.content[0] as { text?: string }).text ?? '') : '';
}

class RouterAdapter implements ProviderAdapter {
  readonly id = 'router-v1';
  readonly requests: ChatRequest[] = [];

  supports(capability: CapabilityId): boolean {
    return capability === 'chat';
  }

  cancelMode(): CancelMode {
    return 'localOnly';
  }

  async chat(_context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    const text = userText(request);
    const toolsOffered = Boolean(request.tools && request.tools.length > 0);
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (text.includes('苹果')) return { text: '好的，记住了。' };
    if (text.includes('记得')) {
      if (!toolsOffered) return { text: '我记不清了。' };
      if (hasToolResult) return { text: '你上次说喜欢苹果。' };
      return {
        text: '',
        toolCalls: [{ id: 'recall-1', name: RECALL_HISTORY_TOOL_NAME, arguments: { query: '苹果' } }]
      };
    }
    if (text.includes('画')) {
      if (hasToolResult) return { text: '画好了。' };
      return {
        text: '',
        toolCalls: [{ id: 'image-1', name: 'generate_image', arguments: { prompt: '一只猫' } }]
      };
    }
    if (text.includes('再说一句')) {
      if (hasToolResult) return { text: '语音好了。' };
      return {
        text: '',
        toolCalls: [{ id: 'speech-1', name: 'generate_speech', arguments: { text: '你好' } }]
      };
    }
    if (text.includes('再发语音')) {
      if (hasToolResult) return { text: '这次不发语音。' };
      return {
        text: '',
        toolCalls: [{ id: 'send-audio-1', name: SEND_MEDIA_TOOL_NAME, arguments: { kind: 'audio' } }]
      };
    }
    if (text.includes('再发')) {
      if (hasToolResult) return { text: '又发了一次。' };
      return {
        text: '',
        toolCalls: [{ id: 'send-image-1', name: SEND_MEDIA_TOOL_NAME, arguments: { kind: 'image' } }]
      };
    }
    return { text: '好。' };
  }
}

async function setup(
  script: ProviderAdapter,
  options: {
    tools: string[];
    voice?: 'supported' | 'unsupported' | 'unknown';
    capabilities?: CapabilityId[];
  }
): Promise<{ core: Core; channel: FakeChannel; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-host-tools-'));
  roots.push(root);
  await seedRoleCard(root);
  const media = new FakeProviderAdapter();
  const capabilities = options.capabilities ?? ['chat', 'image.generate', 'audio.generate'];
  await writePhase1Config(root, {
    providers: [
      fakeProvider('router-chat', {}, {
        adapterId: 'router-v1',
        models: [{ id: 'chat-model', capabilities: ['chat'], input: ['text', 'image'], supportsTools: true }]
      }),
      fakeMediaProvider('fake-media')
    ],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['router-chat', 'fake-media'],
        enabledTools: options.tools,
        bindings: {
          chat: bind('router-chat', 'chat-model'),
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
    providerAdapters: [script, media],
    agent: { timeZone: 'Asia/Shanghai' },
    logger: silentLogger('host-tools')
  });
  cores.push(core);
  await bindTestConversation(core, '10001', 'private', '555');
  await core.start();
  await waitFor(() => core.status().instances[0]?.state === 'online');
  return { core, channel: bucket.get('a')!, root };
}

function sentTexts(channel: FakeChannel): string[] {
  return channel.sent.map((entry) =>
    entry.message.segments
      .filter((segment) => segment.type === 'text')
      .map((segment) => (segment.data as { text?: string }).text ?? '')
      .join('')
  );
}

describe('builtin host tools', () => {
  it('recall_history returns earlier messages from the same conversation', async () => {
    const script = new RouterAdapter();
    const { channel } = await setup(script, { tools: ['builtin.history.recall'] });

    channel.emitInbound(textInbound('a', '10001', '555', 'm-1', '我喜欢苹果'));
    await waitFor(() => channel.sent.length === 1);
    channel.emitInbound(textInbound('a', '10001', '555', 'm-2', '你还记得吗'));
    await waitFor(() => sentTexts(channel).includes('你上次说喜欢苹果。'));

    const continuation = script.requests.find((request) => lastToolText(request).includes('我喜欢苹果'));
    expect(continuation).toBeDefined();
    expect(lastToolText(continuation!)).toContain('检索到 1 条历史消息');
    expect(lastToolText(continuation!)).toContain('对方(555)：我喜欢苹果');

    const firstRequest = script.requests.find(
      (request) => userText(request).includes('你还记得吗') && !request.messages.some((message) => message.role === 'tool')
    );
    expect(firstRequest?.tools?.some((tool) => tool.name === RECALL_HISTORY_TOOL_NAME)).toBe(true);
    const system = firstRequest!.messages[0]!;
    const systemText = system.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    expect(systemText).toContain('## 当前时间');
    expect(systemText).toContain('Asia/Shanghai');
  });

  it('does not offer recall_history without authorization', async () => {
    const script = new RouterAdapter();
    const { channel } = await setup(script, { tools: [] });

    channel.emitInbound(textInbound('a', '10001', '555', 'm-1', '你还记得吗'));
    await waitFor(() => sentTexts(channel).includes('我记不清了。'));

    const request = script.requests.find((entry) => userText(entry).includes('你还记得吗'));
    expect(request?.tools ?? []).toEqual([]);
  });

  it('send_media resends the latest image generated in this conversation', async () => {
    const script = new RouterAdapter();
    const { core, channel } = await setup(script, { tools: ['builtin.image.generate', 'builtin.media.send'] });

    channel.emitInbound(textInbound('a', '10001', '555', 'm-1', '画一只猫'));
    await waitFor(async () => (await core.listJobs('10001'))[0]?.delivery === 'sent', 6_000);
    await waitFor(
      () => channel.sent.filter((entry) => entry.message.segments.some((segment) => segment.type === 'image')).length === 1,
      6_000
    );

    channel.emitInbound(textInbound('a', '10001', '555', 'm-2', '再发一次'));
    await waitFor(
      () => channel.sent.filter((entry) => entry.message.segments.some((segment) => segment.type === 'image')).length === 2,
      6_000
    );
    await waitFor(() => sentTexts(channel).includes('又发了一次。'));

    const images = channel.sent
      .flatMap((entry) => entry.message.segments.filter((segment) => segment.type === 'image'))
      .map((segment) => (segment.data as { mediaId?: string }).mediaId);
    expect(images[0]).toBeTruthy();
    expect(images[1]).toBe(images[0]);

    const continuation = script.requests.find((request) => lastToolText(request).includes('图片已发送'));
    expect(continuation).toBeDefined();
  });

  it('send_media refuses audio when the channel voice support is unknown', async () => {
    const script = new RouterAdapter();
    const { core, channel } = await setup(script, {
      tools: ['builtin.audio.generate', 'builtin.media.send'],
      voice: 'unknown'
    });

    channel.emitInbound(textInbound('a', '10001', '555', 'm-1', '再说一句'));
    await waitFor(async () => (await core.listJobs('10001'))[0]?.state === 'succeeded', 6_000);
    await waitFor(() => sentTexts(channel).includes('语音已生成，但当前通道尚未确认支持语音交付。'), 6_000);

    channel.emitInbound(textInbound('a', '10001', '555', 'm-2', '再发语音'));
    await waitFor(() => sentTexts(channel).includes('这次不发语音。'), 6_000);

    const continuation = script.requests.find((request) =>
      lastToolText(request).includes('当前通道尚未确认支持语音发送'));
    expect(continuation).toBeDefined();
    expect(channel.sent.every((entry) => entry.message.segments[0]?.type !== 'record')).toBe(true);
  });
});
