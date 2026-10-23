import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeConfigV2 } from '../src/providers/types.js';
import type { InboundMessageEvent } from '../src/channels/events.js';

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export const TINY_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2', 'ascii')
]);

export interface RawProvider {
  id: string;
  adapterId: string;
  baseUrl: string;
  location?: 'local' | 'cloud';
  credentialRef?: string;
  models: Array<{
    id: string;
    capabilities: string[];
    input?: string[];
    supportsTools?: boolean;
    parameters?: Record<string, unknown>;
  }>;
  mediaTransports?: string[];
  limits?: { maxConcurrent?: number; maxQueue?: number };
  timeouts?: { requestMs?: number; pollIntervalMs?: number; pollTimeoutMs?: number };
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  options?: Record<string, unknown>;
}

export function fakeProvider(
  id = 'fake-chat',
  options: Record<string, unknown> = {},
  overrides: Partial<RawProvider> = {}
): RawProvider {
  return {
    id,
    adapterId: 'fake-v1',
    baseUrl: 'http://127.0.0.1:9/fake',
    location: 'local',
    models: [
      {
        id: 'text-model',
        capabilities: ['chat'],
        input: ['text'],
        supportsTools: false
      }
    ],
    ...overrides,
    options
  };
}

export function fakeMediaProvider(id = 'fake-media', options: Record<string, unknown> = {}): RawProvider {
  return {
    id,
    adapterId: 'fake-v1',
    baseUrl: 'http://127.0.0.1:9/fake-media',
    location: 'local',
    models: [
      { id: 'vision-model', capabilities: ['image.understand'], input: ['text', 'image'] },
      { id: 'video-model', capabilities: ['video.understand'], input: ['text', 'video'] },
      { id: 'image-model', capabilities: ['image.generate'], input: ['text'] },
      { id: 'audio-model', capabilities: ['audio.generate'], input: ['text'] }
    ],
    options
  };
}

export function fakeToolChatProvider(id = 'fake-tool', options: Record<string, unknown> = {}): RawProvider {
  return {
    ...fakeProvider(id, options),
    models: [
      {
        id: 'tool-model',
        capabilities: ['chat'],
        input: ['text', 'image'],
        supportsTools: true
      }
    ]
  };
}

export function accountPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowedProviders: [],
    crossProviderFallback: false,
    media: { allowCloudUpload: false },
    ...overrides
  };
}

export function bind(
  providerId: string,
  modelId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { providerId, modelId, ...extra };
}

export async function writePhase1Config(
  dataRoot: string,
  config: {
    providers: RawProvider[];
    accountPolicies?: Record<string, Record<string, unknown>>;
    skills?: Array<Record<string, unknown>>;
    media?: { retentionDays: number };
  }
): Promise<RuntimeConfigV2> {
  const raw = {
    schemaVersion: 2,
    providers: config.providers,
    accountPolicies: config.accountPolicies ?? {},
    ...(config.skills ? { skills: config.skills } : {}),
    ...(config.media ? { media: config.media } : {})
  };
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'config.v2.json'), `${JSON.stringify(raw, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return raw as unknown as RuntimeConfigV2;
}

export function inbound(
  instanceId: string,
  accountId: string,
  peerId: string,
  messageId: string,
  segments: InboundMessageEvent['segments'],
  kind: 'private' | 'group' = 'private',
  senderId = peerId
): InboundMessageEvent {
  return {
    type: 'message',
    instanceId,
    selfId: accountId,
    kind,
    peerId,
    senderId,
    messageId,
    at: Date.now(),
    segments,
    selfEcho: false
  };
}

export function textInbound(
  instanceId: string,
  accountId: string,
  peerId: string,
  messageId: string,
  text: string,
  kind: 'private' | 'group' = 'private',
  senderId = peerId
): InboundMessageEvent {
  return inbound(instanceId, accountId, peerId, messageId, [{ type: 'text', data: { text } }], kind, senderId);
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met in time');
}

export function imageSegment(): InboundMessageEvent['segments'][number] {
  return {
    type: 'image',
    data: { file: `base64://${TINY_PNG.toString('base64')}`, url: undefined }
  };
}

export function videoSegment(): InboundMessageEvent['segments'][number] {
  return {
    type: 'video',
    data: { file: `base64://${TINY_MP4.toString('base64')}` }
  };
}
