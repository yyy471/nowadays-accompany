import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestCore } from './helpers.js';
import {
  accountPolicy,
  bind,
  fakeProvider,
  textInbound,
  waitFor,
  writePhase1Config
} from './phase1-helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { ProviderError } from '../src/providers/errors.js';
import { silentLogger } from '../src/core/logger.js';
import { textMessage } from '../src/routing/message.js';
import { DEFAULT_MEMORY_SETTINGS } from '../src/memory/types.js';
import type { ChatRequest, ChatResponse, ProviderCallContext } from '../src/providers/contract.js';
import type { AgentHost } from '../src/host/contract.js';
import type { Core } from '../src/core/core.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [], cores: Core[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-extraction-policy-')) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const conversation: ConversationRef = { accountId: '10001', kind: 'private', peerId: '555' };

function isExtractionRequest(request: ChatRequest): boolean {
  return request.messages.some(message =>
    message.role === 'system'
    && message.content.some(part => part.type === 'text' && part.text.includes('长期事实提取器'))
  );
}

class PolicyAdapter extends FakeProviderAdapter {
  primaryCalls = 0;
  fallbackCalls = 0;

  override async chat(context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    if (!isExtractionRequest(request)) return super.chat(context, request);
    if (context.provider.id === 'primary') {
      this.primaryCalls += 1;
      throw new ProviderError('provider_rate_limited', 'limited', {
        providerId: 'primary',
        capability: 'chat',
        retryable: true
      });
    }
    this.fallbackCalls += 1;
    return { text: JSON.stringify({ facts: [] }) };
  }
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extraction-policy-'));
  roots.push(root);
  let clock = 1_700_000_000_000;
  await writePhase1Config(root, {
    providers: [
      fakeProvider('primary', {}, { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 } }),
      fakeProvider('fallback')
    ],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['primary', 'fallback'],
        crossProviderFallback: true,
        bindings: {
          chat: bind('primary', 'text-model', {
            fallback: [{ providerId: 'fallback', modelId: 'text-model' }]
          })
        }
      })
    }
  });
  const channels = new Map<string, FakeChannel>();
  const adapter = new PolicyAdapter();
  const host: AgentHost = {
    async onMessage(context) {
      context.markExtractable?.();
      return textMessage('HOST_REPLY');
    }
  };
  const core = await createTestCore({
    dataRoot: root,
    instances: [{ id: 'a', backend: 'fake', accountId: '10001' }],
    channelFactory: context => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      channels.set(context.instanceId, channel);
      return channel;
    },
    providerAdapters: [adapter],
    host,
    limits: { hostTimeoutMs: 5_000 },
    now: () => clock,
    logger: silentLogger()
  }, ['10001']);
  cores.push(core);
  await core.setConversationRoleBinding(conversation, { source: 'public', id: 'default', revision: 'r1' });
  await core.start();
  await waitFor(() => core.status().instances.every(status => status.state === 'online'));

  const settings = await core.memorySettings(conversation);
  await core.saveMemorySettings(conversation, {
    settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true },
    expectedScope: settings.scopeToken,
    expectedRevision: settings.revision
  });
  const status = await core.memoryExtraction(conversation);
  await core.activateMemoryExtraction(conversation, {
    expectedScope: status.scopeToken,
    expectedRevision: status.revision,
    startFrom: 'now',
    confirmModelUse: true
  });

  const channel = channels.get('a')!;
  let turns = 0;
  const turn = async (): Promise<void> => {
    const before = channel.sent.length;
    turns += 1;
    channel.emitInbound(textInbound('a', '10001', '555', `policy-${turns}`, `message-${turns}`));
    await waitFor(() => channel.sent.length === before + 1);
  };
  return { core, adapter, channel, turn, advance: (ms: number) => { clock += ms; } };
}

it('R2: extraction uses one primary attempt without fallback and enters cooldown', async () => {
  const { core, adapter, channel, turn, advance } = await setup();
  for (let index = 0; index < 6; index += 1) await turn();
  await waitFor(() => adapter.primaryCalls === 1);
  await waitFor(async () => (await core.memoryExtraction(conversation)).extraction.effectiveStatus === 'cooldown');

  let status = await core.memoryExtraction(conversation);
  expect(adapter.fallbackCalls).toBe(0);
  expect(status.extraction).toMatchObject({
    effectiveStatus: 'cooldown',
    throughSeq: 0,
    lastFailure: { code: 'provider_rate_limited' }
  });
  expect(status.quota).toMatchObject({ accountUsed: 1, accountLimit: 12 });
  expect((await core.listMemoryRecords(conversation)).total).toBe(0);
  expect(channel.sent).toHaveLength(6);

  await turn();
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(adapter.primaryCalls).toBe(1);
  expect(channel.sent).toHaveLength(7);

  advance(11 * 60_000);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(adapter.primaryCalls).toBe(1);

  await turn();
  await waitFor(() => adapter.primaryCalls === 2);
  await waitFor(async () => (await core.memoryExtraction(conversation)).extraction.effectiveStatus === 'cooldown');
  status = await core.memoryExtraction(conversation);
  expect(adapter.fallbackCalls).toBe(0);
  expect(status.extraction.throughSeq).toBe(0);
  expect(status.quota).toMatchObject({ accountUsed: 2 });
  expect((await core.listMemoryRecords(conversation)).total).toBe(0);
});
