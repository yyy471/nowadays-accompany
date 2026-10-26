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
import { AGENT_TOOL_BUDGET, GENERATE_IMAGE_TOOL_NAME } from '../src/agent/engine.js';
import { TOOL_EXECUTION_LIMITS } from '../src/extensions/execution/executor.js';
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

/** 脚本按“每个回合内的一轮模型调用”消费；新回合从头开始，续答轮次继续往后走。 */
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
    const entry = this.script[Math.min(this.#round, this.script.length - 1)];
    return structuredClone(entry ?? { text: '脚本结束' });
  }
}

function imageCall(id: string | undefined, prompt: string): { id?: string; name: string; arguments: Record<string, unknown> } {
  return { ...(id ? { id } : {}), name: GENERATE_IMAGE_TOOL_NAME, arguments: { prompt } };
}

async function setup(
  script: ChatResponse[],
  options: { supportsTools?: boolean; authorizedTools?: string[]; maxHistoryChars?: number } = {}
): Promise<{
  core: Core;
  channel: FakeChannel;
  chat: ScriptedChatAdapter;
  media: FakeProviderAdapter;
  root: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-tool-loop-'));
  roots.push(root);
  await seedRoleCard(root);
  const chat = new ScriptedChatAdapter(script);
  const media = new FakeProviderAdapter();
  await writePhase1Config(root, {
    providers: [
      fakeProvider('scripted-chat', {}, {
        adapterId: 'scripted-v1',
        models: [{
          id: 'chat-model',
          capabilities: ['chat'],
          input: ['text', 'image'],
          ...(options.supportsTools === false ? {} : { supportsTools: true })
        }]
      }),
      fakeMediaProvider('fake-media')
    ],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['scripted-chat', 'fake-media'],
        ...(options.authorizedTools || options.supportsTools === false
          ? { enabledTools: options.authorizedTools ?? [] }
          : { enabledTools: ['builtin.image.generate'] }),
        bindings: {
          chat: bind('scripted-chat', 'chat-model'),
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
    providerAdapters: [chat, media],
    ...(options.maxHistoryChars ? { agent: { maxHistoryChars: options.maxHistoryChars } } : {}),
    logger: silentLogger('tool-loop')
  });
  cores.push(core);
  await bindTestConversation(core, '10001', 'private', '555');
  await core.start();
  await waitFor(() => core.status().instances[0]?.state === 'online');
  return { core, channel: bucket.get('a')!, chat, media, root };
}

function sentTexts(channel: FakeChannel): string[] {
  return channel.sent.map((entry) =>
    entry.message.segments
      .filter((segment) => segment.type === 'text')
      .map((segment) => (segment.data as { text?: string }).text ?? '')
      .join('')
  );
}

function protocolMessages(request: ChatRequest) {
  return request.messages.filter((message) => message.role === 'assistant' || message.role === 'tool');
}

function lastTool(request: ChatRequest) {
  return protocolMessages(request).filter((message) => message.role === 'tool').at(-1);
}

describe('agent tool loop', () => {
  it('pairs assistant tool_calls with tool results and continues with the returned data', async () => {
    const { core, channel, chat, media } = await setup([
      { text: '', toolCalls: [imageCall('call-1', 'first cat'), imageCall('call-2', 'second cat')] },
      { text: '两张图都在生成中。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'pair-1', 'draw two cats'));
    await waitFor(() => chat.requests.length === 2, 6_000);
    await waitFor(() => channel.sent.length === 3, 6_000);

    const followUp = protocolMessages(chat.requests[1]!);
    expect(followUp).toHaveLength(3);
    const assistant = followUp[0]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.toolCalls?.map((call) => call.id)).toEqual(['call-1', 'call-2']);
    expect(assistant.toolCalls?.map((call) => call.arguments.prompt)).toEqual(['first cat', 'second cat']);
    expect(followUp[1]).toMatchObject({ role: 'tool', toolCallId: 'call-1' });
    expect(followUp[2]).toMatchObject({ role: 'tool', toolCallId: 'call-2' });
    expect(chat.requests[0]!.tools?.map((tool) => tool.name)).toContain(GENERATE_IMAGE_TOOL_NAME);

    expect(media.calls.filter((call) => call.capability === 'image.generate')).toHaveLength(2);
    expect(await core.listJobs('10001')).toHaveLength(2);
    expect(sentTexts(channel)[0]).toBe('两张图都在生成中。');
    expect(channel.sent.slice(1).every((entry) => entry.message.segments[0]?.type === 'image')).toBe(true);
  });

  it('keeps intermediate assistant text out of the conversation and sends one final reply', async () => {
    const { channel, chat } = await setup([
      { text: '让我先画一张图。', toolCalls: [imageCall('mid-1', 'cat')] },
      { text: '图已经安排上了。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'mid-1', 'draw a cat'));
    await waitFor(() => chat.requests.length === 2, 6_000);
    await waitFor(() => channel.sent.length === 2, 6_000);

    expect(sentTexts(channel)).toEqual(['图已经安排上了。', '']);
    const assistant = protocolMessages(chat.requests[1]!).find((message) => message.role === 'assistant')!;
    expect(assistant.content).toEqual([{ type: 'text', text: '让我先画一张图。' }]);
    expect(assistant.toolCalls).toHaveLength(1);
  });

  it('treats identical provider call ids on distinct rounds as distinct host actions', async () => {
    const { core, channel, chat, media } = await setup([
      { text: '', toolCalls: [imageCall('same-id', 'once only')] }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'dedupe-1', 'draw a cat'));
    await waitFor(() => chat.requests.length === AGENT_TOOL_BUDGET.maxModelCalls, 8_000);
    await waitFor(() => channel.sent.length === 4, 6_000);

    expect(media.calls.filter((call) => call.capability === 'image.generate')).toHaveLength(3);
    expect(await core.listJobs('10001')).toHaveLength(3);
    // call_1 is provider-local. The host invocation key includes this model round, so it does not
    // collapse three separately requested actions into one; true replays share the same host key.
    expect((lastTool(chat.requests[2]!)!.content[0] as { text: string }).text).not.toContain('已经提交过');
    expect(chat.requests[3]!.tools).toBeUndefined();
  });

  it('stops at the model-call budget and never offers tools on the last request', async () => {
    const { core, channel, chat, media } = await setup([
      { text: '', toolCalls: [imageCall('loop-1', 'p1')] },
      { text: '', toolCalls: [imageCall('loop-2', 'p2')] },
      { text: '', toolCalls: [imageCall('loop-3', 'p3')] },
      { text: '先聊到这里。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'budget-1', 'keep drawing'));
    await waitFor(() => channel.sent.length === 4, 8_000);

    expect(chat.requests).toHaveLength(AGENT_TOOL_BUDGET.maxModelCalls);
    expect(chat.requests[0]!.tools).toBeDefined();
    expect(chat.requests[1]!.tools).toBeDefined();
    expect(chat.requests[2]!.tools).toBeDefined();
    expect(chat.requests[3]!.tools).toBeUndefined();
    expect(media.calls.filter((call) => call.capability === 'image.generate')).toHaveLength(AGENT_TOOL_BUDGET.maxToolRounds);
    expect(await core.listJobs('10001')).toHaveLength(AGENT_TOOL_BUDGET.maxToolRounds);
    expect(sentTexts(channel)[0]).toBe('先聊到这里。');
  });

  it('counts a full batch against the call budget and closes the loop on the next round', async () => {
    const { channel, chat } = await setup([
      {
        text: '',
        toolCalls: [imageCall('b-1', 'p1'), imageCall('b-2', 'p2'), imageCall('b-3', 'p3'), imageCall('b-4', 'p4')]
      },
      { text: '四张图都在路上。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'batch-1', 'draw four cats'));
    await waitFor(() => channel.sent.length >= 1, 6_000);

    expect(sentTexts(channel)[0]).toBe('四张图都在路上。');
    expect(chat.requests[1]!.tools).toBeUndefined();
    await waitFor(() => channel.sent.length === 5, 8_000);
  });

  it('rejects an unknown tool without side effects but keeps the protocol pair', async () => {
    const { channel, chat, media } = await setup([
      { text: '', toolCalls: [{ id: 'ghost', name: 'generate_ghost', arguments: {} }] },
      { text: '那个工具现在用不了。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'unknown-1', 'summon a ghost'));
    await waitFor(() => chat.requests.length === 2, 6_000);
    await waitFor(() => channel.sent.length === 1, 6_000);

    expect(media.calls.filter((call) => call.capability === 'image.generate')).toHaveLength(0);
    const tool = protocolMessages(chat.requests[1]!).find((message) => message.role === 'tool')!;
    expect(tool.toolCallId).toBe('ghost');
    expect((tool.content[0] as { text: string }).text).toContain('unknown_tool');
  });

  it('assigns a deterministic call id when the model omits one', async () => {
    const { channel, chat } = await setup([
      { text: '', toolCalls: [imageCall(undefined, 'no id')] },
      { text: '收到。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'noid-1', 'draw without an id'));
    await waitFor(() => chat.requests.length === 2, 6_000);

    const assistant = protocolMessages(chat.requests[1]!).find((message) => message.role === 'assistant')!;
    const tool = protocolMessages(chat.requests[1]!).find((message) => message.role === 'tool')!;
    expect(assistant.toolCalls?.[0]?.id).toMatch(/:r0:c0$/);
    expect(tool.toolCallId).toBe(assistant.toolCalls?.[0]?.id);
    await waitFor(() => channel.sent.length === 2, 6_000);
  });

  it('does not offer tools or execute anything for a model without tool support', async () => {
    const { channel, chat, media } = await setup(
      [{ text: '纯文本回复。', toolCalls: [imageCall('nope', 'cat')] }],
      { supportsTools: false }
    );
    channel.emitInbound(textInbound('a', '10001', '555', 'notools-1', 'draw a cat'));
    await waitFor(() => channel.sent.length === 1, 6_000);

    expect(chat.requests).toHaveLength(1);
    expect(chat.requests[0]!.tools).toBeUndefined();
    expect(media.calls.filter((call) => call.capability === 'image.generate')).toHaveLength(0);
    expect(sentTexts(channel)).toEqual(['纯文本回复。']);
  });

  it('records a submitted tool result with its job id instead of claiming delivery', async () => {
    const { core, channel, chat, root } = await setup([
      { text: '', toolCalls: [imageCall('ledger-1', 'cat')] },
      { text: '稍后发送给你。' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'ledger-1', 'draw a cat'));
    await waitFor(() => chat.requests.length === 2, 6_000);

    const tool = protocolMessages(chat.requests[1]!).find((message) => message.role === 'tool')!;
    const text = (tool.content[0] as { text: string }).text;
    expect(text).toContain('正在生成图片，完成后会发送。');
    expect(text).not.toContain('已经发送');

    await waitFor(async () => {
      const raw = await fs.readFile(path.join(root, 'accounts', '10001', 'state', 'tool-invocations.json'), 'utf8');
      return raw.includes('"status":"submitted"');
    }, 6_000);
    const raw = await fs.readFile(path.join(root, 'accounts', '10001', 'state', 'tool-invocations.json'), 'utf8');
    const jobId = /"jobId":"([^"]+)"/.exec(raw)?.[1];
    expect(jobId).toBeTruthy();
    const jobs = await core.listJobs('10001');
    expect(jobs.map((job) => job.id)).toContain(jobId);
    await waitFor(() => channel.sent.length === 2, 6_000);
  });

  it('does not merge the same provider call id across conversations', async () => {
    const { core, channel, media } = await setup([
      { text: '', toolCalls: [imageCall('call_1', 'cat')] },
      { text: '好的。' }
    ]);
    await bindTestConversation(core, '10001', 'private', '556');
    channel.emitInbound(textInbound('a', '10001', '555', 'shared-555', 'draw a cat'));
    await waitFor(() => channel.sent.length === 2, 6_000);
    channel.emitInbound(textInbound('a', '10001', '556', 'shared-556', 'draw a cat'));
    await waitFor(() => channel.sent.length === 4, 6_000);

    // 服务方按请求内 call_1 编号；动作 ID 必须带会话作用域，否则第二个会话会被说成“已经提交过”。
    expect(media.calls.filter((call) => call.capability === 'image.generate')).toHaveLength(2);
    expect(await core.listJobs('10001')).toHaveLength(2);
  });

  it('tells the user the bounded reason when a rejected tool leaves no final text', async () => {
    const { channel } = await setup([
      { text: '', toolCalls: [{ id: 'ghost', name: 'generate_ghost', arguments: {} }] },
      { text: '' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'silent-reject', 'summon a ghost'));
    await waitFor(() => channel.sent.length === 1, 6_000);

    expect(sentTexts(channel)).toEqual(['模型请求了本轮未提供的工具。']);
  });

  it('keeps the engine call budget aligned with the executor batch limit', () => {
    expect(AGENT_TOOL_BUDGET.maxToolCalls).toBe(TOOL_EXECUTION_LIMITS.maxCallsPerBatch);
  });

  it('loses only the tools when the account profile cannot be resolved', async () => {
    const { channel, chat, root } = await setup([
      { text: '先回答文字部分。', toolCalls: [imageCall('broken-1', 'cat')] }
    ]);
    await fs.writeFile(
      path.join(root, 'accounts', '10001', 'profile.json'),
      `${JSON.stringify({ version: 1, plugins: [{ source: 'public', id: 'ghost-plugin', revision: 'r9' }] }, null, 2)}\n`,
      'utf8'
    );
    channel.emitInbound(textInbound('a', '10001', '555', 'broken-1', 'draw a cat'));
    await waitFor(() => channel.sent.length === 1, 6_000);

    expect(chat.requests).toHaveLength(1);
    expect(chat.requests[0]!.tools).toBeUndefined();
    expect(sentTexts(channel)).toEqual(['先回答文字部分。']);
  });
});

describe('agent context budget at the Provider boundary', () => {
  it('bounds escaped tool results against the actual serialized continuation request', async () => {
    const { channel, chat, core } = await setup([
      { text: '', toolCalls: [imageCall('escaped-result', 'cat')] },
      { text: 'BOUNDED_REPLY' }
    ]);
    core.extensionTools.executeBatch = async calls => ({
      results: calls.map(call => ({ invocationId: call.callId!, status: 'ok', text: '文"\\\n😀'.repeat(500) })),
      executed: calls.length, replayed: 0, bytes: 8_000, preflightFailed: false
    });
    channel.emitInbound(textInbound('a', '10001', '555', 'escaped-budget', 'a'.repeat(9_000)));
    await waitFor(() => channel.sent.length === 1);
    expect(chat.requests).toHaveLength(2);
    for (const request of chat.requests) expect(JSON.stringify(request).length).toBeLessThanOrEqual(12_000);
    expect((lastTool(chat.requests[1]!)!.content[0] as { text: string }).text).toContain('[结果已截断]');
    expect(sentTexts(channel)).toEqual(['BOUNDED_REPLY']);
  });

  it('shares the 24 KiB result budget across multiple batches', async () => {
    const { channel, chat, core } = await setup([
      { text: '', toolCalls: [imageCall('one', 'cat'), imageCall('two', 'cat')] },
      { text: '', toolCalls: [imageCall('three', 'cat'), imageCall('four', 'cat')] },
      { text: 'ALL_BATCHES_REPLY' }
    ], { maxHistoryChars: 120_000 });
    let callsExecuted = 0;
    core.extensionTools.executeBatch = async calls => {
      callsExecuted += calls.length;
      return {
        results: calls.map(call => ({ invocationId: call.callId!, status: 'ok', text: '文'.repeat(2_700) })),
        executed: calls.length, replayed: 0, bytes: calls.length * 8_150, preflightFailed: false
      };
    };
    channel.emitInbound(textInbound('a', '10001', '555', 'cumulative-result-budget', 'look up four items'));
    await waitFor(() => channel.sent.length === 1);
    expect(callsExecuted).toBe(4);
    expect(chat.requests).toHaveLength(3);
    const results = chat.requests[2]!.messages.filter(message => message.role === 'tool');
    expect(results).toHaveLength(4);
    const texts = results.map(message => (message.content[0] as { text: string }).text);
    expect(texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0)).toBeLessThanOrEqual(24 * 1024);
    expect(texts.at(-1)).toContain('[结果已截断]');
    expect(sentTexts(channel)).toEqual(['ALL_BATCHES_REPLY']);
  });

  it('rejects oversized intermediate protocol before any media action', async () => {
    const { channel, chat, media, core } = await setup([
      { text: '\\"\n'.repeat(8_000), toolCalls: [imageCall('huge', 'cat')] },
      { text: 'must not be requested' }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'oversized-protocol', 'draw a cat'));
    await waitFor(() => channel.sent.length === 1);
    expect(chat.requests).toHaveLength(1);
    expect(media.calls.filter(call => call.capability === 'image.generate')).toHaveLength(0);
    expect(await core.listJobs('10001')).toHaveLength(0);
    expect(sentTexts(channel)[0]).toContain('未执行工具');
  });

  it('preserves oversized original input and continues text without new tools', async () => {
    const original = '长'.repeat(13_000);
    const { channel, chat, media } = await setup([
      { text: 'LONG_TEXT_REPLY', toolCalls: [imageCall('unoffered', 'cat')] }
    ]);
    channel.emitInbound(textInbound('a', '10001', '555', 'long-input', original));
    await waitFor(() => channel.sent.length === 1);
    expect(chat.requests).toHaveLength(1);
    expect(chat.requests[0]!.tools).toBeUndefined();
    expect(chat.requests[0]!.messages.flatMap(message => message.content)
      .some(part => part.type === 'text' && part.text === original)).toBe(true);
    expect(sentTexts(channel)).toEqual(['LONG_TEXT_REPLY']);
    expect(media.calls.filter(call => call.capability === 'image.generate')).toHaveLength(0);
  });

  it('makes space for protocol after history fills the context instead of permanently disabling tools', async () => {
    const script: ChatResponse[] = [{ text: '往'.repeat(500) }];
    const { channel, chat } = await setup(script);
    for (let index = 0; index < 12; index += 1) {
      channel.emitInbound(textInbound('a', '10001', '555', `history-${index}`, '史'.repeat(1_000)));
      await waitFor(() => channel.sent.length === index + 1);
    }
    const start = chat.requests.length;
    script.splice(0, script.length,
      { text: '', toolCalls: [imageCall('history-tool', 'cat')] },
      { text: 'HISTORY_TOOL_REPLY' });
    channel.emitInbound(textInbound('a', '10001', '555', 'after-history', 'draw a cat'));
    await waitFor(() => chat.requests.length === start + 2);
    const requests = chat.requests.slice(start);
    expect(requests[0]!.tools?.map(tool => tool.name)).toContain(GENERATE_IMAGE_TOOL_NAME);
    expect(requests[1]!.messages.some(message => message.role === 'tool' && message.toolCallId === 'history-tool')).toBe(true);
    for (const request of requests) expect(JSON.stringify(request).length).toBeLessThanOrEqual(12_000);
    await waitFor(() => sentTexts(channel).includes('HISTORY_TOOL_REPLY'));
  });
});
