import type { CapabilityId } from '../../policy/capabilities.js';
import { sleep } from '../../core/concurrency.js';
import type {
  ChatRequest,
  ChatResponse,
  AudioGenerationRequest,
  AudioGenerationResult,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageObservation,
  ProviderAdapter,
  ProviderCallContext,
  ProviderMedia,
  ProviderTestResult,
  VideoObservation
} from '../contract.js';
import { ProviderError, sanitizeErrorText } from '../errors.js';
import type { CancelMode } from '../types.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface FakeAdapterCall {
  capability: CapabilityId;
  providerId: string;
  modelId: string;
  at: number;
  promptText?: string;
  messageCount?: number;
  toolNames?: string[];
  requestText?: string;
}

interface FakeOptions {
  delayMs?: number;
  failCapability?: CapabilityId;
  failCode?: string;
  failMessage?: string;
  failRetryable?: boolean;
  failOnce?: boolean;
  chatText?: string;
  observation?: string;
  videoSummary?: string;
  imageBase64?: string;
  imageMimeType?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
}

/**
 * 可脚本化的假服务适配器：用于 A/I 级验收和桌面演示。
 * 通过 provider.options 控制延迟、失败与返回内容，不依赖任何外网。
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly id: string;
  readonly calls: FakeAdapterCall[] = [];
  readonly #failed = new Set<string>();

  constructor(options: { id?: string } = {}) {
    this.id = options.id ?? 'fake-v1';
  }

  supports(capability: CapabilityId): boolean {
    return (
      capability === 'chat' ||
      capability === 'image.understand' ||
      capability === 'video.understand' ||
      capability === 'image.generate' ||
      capability === 'audio.generate'
    );
  }

  cancelMode(capability: CapabilityId): CancelMode {
    if (capability === 'video.understand') return 'remote';
    if (capability === 'image.generate' || capability === 'audio.generate') return 'none';
    return 'localOnly';
  }

  async chat(context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    const options = this.#options(context);
    await this.#before(context, 'chat', options);
    this.calls.push({
      ...this.#call(context, 'chat'),
      messageCount: request.messages.length,
      ...(request.tools?.length ? { toolNames: request.tools.map((tool) => tool.name) } : {}),
      requestText: request.messages.map((message) => message.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('')).join('\n')
    });
    if (options.toolCall && !continuingRound(request) && request.tools?.some((tool) => tool.name === options.toolCall?.name)) {
      return { toolCalls: [{ id: `fake-tool-${this.calls.length}`, ...options.toolCall }] };
    }
    const text = options.chatText ?? `fake reply to ${messageLength(request.messages)} chars`;
    return { text, usage: { promptTokens: 10, completionTokens: Math.max(1, text.length) } };
  }

  async imageUnderstand(
    context: ProviderCallContext,
    media: ProviderMedia,
    _prompt: string
  ): Promise<ImageObservation> {
    const options = this.#options(context);
    await this.#before(context, 'image.understand', options);
    this.calls.push({ ...this.#call(context, 'image.understand'), promptText: media.mediaId });
    return {
      text: options.observation ?? `fake observation of ${media.mimeType} (${media.bytes} bytes)`,
      coverage: 'single image',
      usage: { promptTokens: 20, completionTokens: 12 }
    };
  }

  async videoUnderstand(
    context: ProviderCallContext,
    media: ProviderMedia,
    _prompt: string,
    _parameters?: Record<string, unknown>,
    onProgress?: (state: 'submitted' | 'waiting_remote') => void
  ): Promise<VideoObservation> {
    const options = this.#options(context);
    onProgress?.('submitted');
    await this.#before(context, 'video.understand', options);
    onProgress?.('waiting_remote');
    this.calls.push({ ...this.#call(context, 'video.understand'), promptText: media.mediaId });
    return {
      summary: options.videoSummary ?? `fake video summary of ${media.mimeType} (${media.bytes} bytes)`,
      segments: [{ startMs: 0, endMs: 1_000, text: 'fake segment' }],
      coverage: 'sampled summary',
      usage: { promptTokens: 30, completionTokens: 16 }
    };
  }

  async imageGenerate(
    context: ProviderCallContext,
    request: ImageGenerationRequest
  ): Promise<ImageGenerationResult> {
    const options = this.#options(context);
    await this.#before(context, 'image.generate', options);
    this.calls.push({ ...this.#call(context, 'image.generate'), promptText: request.prompt });
    const count = Math.max(1, Math.min(request.count ?? 1, 4));
    return {
      images: Array.from({ length: count }, () => ({
        mimeType: options.imageMimeType ?? 'image/png',
        base64: options.imageBase64 ?? PNG_1X1,
        width: 1,
        height: 1
      })),
      usage: { promptTokens: 8, completionTokens: 1 }
    };
  }

  async audioGenerate(
    context: ProviderCallContext,
    request: AudioGenerationRequest
  ): Promise<AudioGenerationResult> {
    const options = this.#options(context);
    await this.#before(context, 'audio.generate', options);
    this.calls.push({ ...this.#call(context, 'audio.generate'), promptText: request.text });
    return { mimeType: 'audio/wav', data: silentWave() };
  }

  async test(_context: ProviderCallContext, _capability: CapabilityId): Promise<ProviderTestResult> {
    return { ok: true, detail: 'fake adapter is always reachable' };
  }

  #options(context: ProviderCallContext): FakeOptions {
    const raw = context.provider.options;
    const options: FakeOptions = {};
    if (typeof raw.delayMs === 'number' && raw.delayMs >= 0) options.delayMs = raw.delayMs;
    if (typeof raw.failCapability === 'string') options.failCapability = raw.failCapability as CapabilityId;
    if (typeof raw.failCode === 'string') options.failCode = raw.failCode;
    if (typeof raw.failMessage === 'string') options.failMessage = raw.failMessage;
    if (typeof raw.failRetryable === 'boolean') options.failRetryable = raw.failRetryable;
    if (typeof raw.failOnce === 'boolean') options.failOnce = raw.failOnce;
    if (typeof raw.chatText === 'string') options.chatText = raw.chatText;
    if (typeof raw.observation === 'string') options.observation = raw.observation;
    if (typeof raw.videoSummary === 'string') options.videoSummary = raw.videoSummary;
    if (typeof raw.imageBase64 === 'string') options.imageBase64 = raw.imageBase64;
    if (typeof raw.imageMimeType === 'string') options.imageMimeType = raw.imageMimeType;
    if (raw.toolCall && typeof raw.toolCall === 'object' && !Array.isArray(raw.toolCall)) {
      const toolCall = raw.toolCall as { name?: unknown; arguments?: unknown };
      if (typeof toolCall.name === 'string') {
        options.toolCall = {
          name: toolCall.name,
          arguments:
            toolCall.arguments && typeof toolCall.arguments === 'object' && !Array.isArray(toolCall.arguments)
              ? (toolCall.arguments as Record<string, unknown>)
              : {}
        };
      }
    }
    return options;
  }

  async #before(context: ProviderCallContext, capability: CapabilityId, options: FakeOptions): Promise<void> {
    if (options.delayMs) await sleep(options.delayMs, context.signal);
    if (options.failCapability !== capability) return;
    const key = `${context.provider.id}:${context.model.id}:${capability}`;
    if (options.failOnce && this.#failed.has(key)) return;
    this.#failed.add(key);
    throw new ProviderError(options.failCode ?? 'fake_failure', sanitizeErrorText(options.failMessage ?? 'fake provider failure'), {
      providerId: context.provider.id,
      capability,
      retryable: options.failRetryable ?? false
    });
  }

  #call(context: ProviderCallContext, capability: CapabilityId): FakeAdapterCall {
    return {
      capability,
      providerId: context.provider.id,
      modelId: context.model.id,
      at: Date.now()
    };
  }
}

function silentWave(): Buffer {
  const sampleRate = 8_000;
  const samples = sampleRate / 10;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 已经在同一轮工具续答里：脚本化假服务不再重复发起工具调用，保证循环可终止。 */
function continuingRound(request: ChatRequest): boolean {
  return request.messages.some((message) => message.role === 'tool' || message.toolCalls !== undefined);
}

function messageLength(messages: ChatRequest['messages']): number {
  let length = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'text') length += part.text.length;
    }
  }
  return length;
}
