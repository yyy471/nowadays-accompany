import type { CapabilityId } from '../../policy/capabilities.js';
import type {
  ChatContentPart,
  ChatInputMessage,
  ChatRequest,
  ChatResponse,
  ChatToolCall,
  AudioGenerationRequest,
  AudioGenerationResult,
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageObservation,
  VideoObservation,
  ProviderAdapter,
  ProviderCallContext,
  ProviderMedia
} from '../contract.js';
import { ProviderError, sanitizeErrorText } from '../errors.js';
import { HttpBodyError, readResponseBytes, readResponseText } from '../../platform/http/bounded-body.js';
import type { CancelMode } from '../types.js';

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

interface OpenAiPayload {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  data?: Array<{
    b64_json?: string;
    url?: string;
    mime_type?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
  message?: string;
}

/**
 * 明确范围的 OpenAI-compatible 适配器：
 * - chat/completions（文本、图片输入、工具调用）
 * - images/generations（b64_json 或 url）
 * - audio/speech（raw bytes，具体模型能力仍需用户显式声明）
 * 不声称支持任意“兼容”API；模型能力仍以配置中的声明为准。
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id = 'openai-compatible-v1';

  supports(capability: CapabilityId): boolean {
    return capability === 'chat' || capability === 'image.understand' || capability === 'video.understand' || capability === 'image.generate' || capability === 'audio.generate';
  }

  cancelMode(capability: CapabilityId): CancelMode {
    if (capability === 'image.generate' || capability === 'audio.generate') return 'none';
    return 'localOnly';
  }

  async chat(context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse> {
    const messages = request.messages.map((message) => toOpenAiMessage(message, context));
    const body: Record<string, unknown> = {
      ...(request.parameters ?? {}),
      model: context.model.id,
      messages,
      stream: false
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    }
    const payload = await this.#post(context, '/chat/completions', body, 'chat');
    const choice = payload.choices?.[0];
    const message = choice?.message;
    if (!message) throw protocolError(context, 'chat', 'response has no choices[0].message');
    const text = extractText(message.content);
    const toolCalls: ChatToolCall[] = [];
    for (const call of message.tool_calls ?? []) {
      if (!call.function?.name) continue;
      let args: unknown = {};
      if (call.function.arguments) {
        try {
          args = JSON.parse(call.function.arguments) as unknown;
        } catch {
          args = { raw: call.function.arguments };
        }
      }
      toolCalls.push({
        ...(call.id ? { id: call.id } : {}),
        name: call.function.name,
        arguments: args
      });
    }
    return {
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(payload.usage ? { usage: mapUsage(payload.usage) } : {}),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {})
    };
  }

  async imageUnderstand(
    context: ProviderCallContext,
    media: ProviderMedia,
    prompt: string,
    parameters?: Record<string, unknown>
  ): Promise<ImageObservation> {
    const dataUrl = `data:${media.mimeType};base64,${media.data.toString('base64')}`;
    const body: Record<string, unknown> = {
      ...(parameters ?? {}),
      model: context.model.id,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      stream: false
    };
    const payload = await this.#post(context, '/chat/completions', body, 'image.understand');
    const text = extractText(payload.choices?.[0]?.message?.content);
    if (!text || !text.trim()) throw protocolError(context, 'image.understand', 'observation is empty');
    return {
      text,
      coverage: 'single image',
      ...(payload.usage ? { usage: mapUsage(payload.usage) } : {})
    };
  }

  /** Compatible multimodal APIs with video_url support (e.g. Qwen/NIM). */
  async videoUnderstand(context: ProviderCallContext, media: ProviderMedia, prompt: string, parameters?: Record<string, unknown>): Promise<VideoObservation> {
    const payload = await this.#post(context, '/chat/completions', {
      ...(parameters ?? {}), model: context.model.id, stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: `data:${media.mimeType};base64,${media.data.toString('base64')}` } }] }]
    }, 'video.understand');
    const summary = extractText(payload.choices?.[0]?.message?.content);
    if (!summary?.trim()) throw protocolError(context, 'video.understand', 'video observation is empty');
    return { summary, segments: [], coverage: 'submitted video', ...(payload.usage ? { usage: mapUsage(payload.usage) } : {}) };
  }

  async imageGenerate(
    context: ProviderCallContext,
    request: ImageGenerationRequest
  ): Promise<ImageGenerationResult> {
    const body: Record<string, unknown> = {
      ...(request.parameters ?? {}),
      model: context.model.id,
      prompt: request.prompt,
      n: Math.max(1, Math.min(request.count ?? 1, 4)),
      response_format: 'b64_json'
    };
    if (request.size) body.size = request.size;
    const payload = await this.#post(context, '/images/generations', body, 'image.generate');
    const images: GeneratedImage[] = [];
    for (const item of payload.data ?? []) {
      if (item.b64_json) {
        images.push({
          mimeType: item.mime_type ?? 'image/png',
          base64: item.b64_json
        });
      } else if (item.url) {
        images.push({
          ...(item.mime_type ? { mimeType: item.mime_type } : {}),
          url: item.url
        });
      }
    }
    if (images.length === 0) throw protocolError(context, 'image.generate', 'response contains no supported image');
    return {
      images,
      ...(payload.usage ? { usage: mapUsage(payload.usage) } : {})
    };
  }

  async audioGenerate(context: ProviderCallContext, request: AudioGenerationRequest): Promise<AudioGenerationResult> {
    const url = `${context.provider.baseUrl.replace(/\/+$/, '')}/audio/speech`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (context.credential) headers.authorization = `Bearer ${context.credential}`;
    const configuredVoice = request.parameters?.voice ?? context.model.parameters.voice;
    const voice = request.voice?.trim() || (typeof configuredVoice === 'string' ? configuredVoice.trim() : '');
    if (!voice) {
      throw new ProviderError(
        'provider_configuration_invalid',
        'audio generation requires a voice; configure a default voice in this model or pass a provider-supported voice',
        { providerId: context.provider.id, capability: 'audio.generate', retryable: false }
      );
    }
    const body = {
      ...(request.parameters ?? {}),
      model: context.model.id,
      input: request.text,
      voice,
      response_format: request.format ?? 'mp3'
    };
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: context.signal });
    } catch (error) {
      throw new ProviderError('provider_generate_unknown', 'audio generation was interrupted; remote result is unknown', {
        providerId: context.provider.id,
        capability: 'audio.generate',
        retryable: false,
        cause: error
      });
    }
    if (!response.ok) {
      const text = await readResponseText(response, { maxBytes: MAX_JSON_BYTES, signal: context.signal, label: 'audio error response' })
        .catch(() => '');
      throw httpError(context, 'audio.generate', response, text);
    }
    let data: Buffer;
    try {
      data = await readResponseBytes(response, {
        maxBytes: MAX_AUDIO_BYTES,
        signal: context.signal,
        label: 'audio response'
      });
    } catch (error) {
      if (error instanceof HttpBodyError && error.code === 'http_body_too_large') {
        throw new ProviderError('provider_protocol', `audio response exceeded ${MAX_AUDIO_BYTES} bytes`, {
          providerId: context.provider.id,
          capability: 'audio.generate',
          retryable: false
        });
      }
      throw new ProviderError('provider_generate_unknown', 'audio response was interrupted; remote result is unknown', {
        providerId: context.provider.id,
        capability: 'audio.generate',
        retryable: false,
        cause: error
      });
    }
    if (data.length === 0) throw protocolError(context, 'audio.generate', 'response contains no audio bytes');
    const mimeType = (response.headers.get('content-type') ?? audioMimeForFormat(request.format ?? 'mp3'))
      .split(';')[0]!.trim().toLowerCase();
    return { mimeType, data };
  }

  async #post(
    context: ProviderCallContext,
    pathname: string,
    body: Record<string, unknown>,
    capability: CapabilityId
  ): Promise<OpenAiPayload> {
    const url = `${context.provider.baseUrl.replace(/\/+$/, '')}${pathname}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (context.credential) headers.authorization = `Bearer ${context.credential}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: context.signal
      });
    } catch (error) {
      if (context.signal.aborted) {
        throw new ProviderError(
          capability === 'image.generate' || capability === 'audio.generate' ? 'provider_generate_unknown' : 'provider_timeout',
          capability === 'image.generate' || capability === 'audio.generate'
            ? `${capability === 'audio.generate' ? 'audio' : 'image'} generation request was aborted; remote result is unknown`
            : 'provider request timed out or was aborted',
          {
            providerId: context.provider.id,
            capability,
            retryable: capability !== 'image.generate' && capability !== 'audio.generate',
            cause: error
          }
        );
      }
      throw new ProviderError('provider_transport', `provider transport failure: ${sanitizeErrorText(String(error))}`, {
        providerId: context.provider.id,
        capability,
        retryable: capability !== 'image.generate' && capability !== 'audio.generate',
        cause: error
      });
    }
    let text: string;
    try {
      text = await readResponseText(response, { maxBytes: MAX_JSON_BYTES, signal: context.signal, label: 'provider response' });
    } catch (error) {
      if (!response.ok) throw httpError(context, capability, response, '');
      throw bodyError(context, capability, error);
    }
    if (!response.ok) throw httpError(context, capability, response, text);
    let payload: OpenAiPayload;
    try {
      payload = JSON.parse(text) as OpenAiPayload;
    } catch (error) {
      throw new ProviderError('provider_protocol', 'provider returned invalid JSON', {
        providerId: context.provider.id,
        capability,
        retryable: false,
        cause: error,
        httpStatus: response.status
      });
    }
    if (payload.error) {
      throw new ProviderError('provider_upstream', sanitizeErrorText(payload.error.message ?? 'provider returned an error'), {
        providerId: context.provider.id,
        capability,
        retryable: false,
        httpStatus: response.status
      });
    }
    return payload;
  }
}

function toOpenAiMessage(message: ChatInputMessage, context: ProviderCallContext): Record<string, unknown> {
  if (message.role === 'tool' && !message.toolCallId) {
    throw new ProviderError('provider_protocol', 'tool message requires a tool call id', {
      providerId: context.provider.id,
      capability: 'chat',
      retryable: false
    });
  }
  if (message.toolCalls && message.role !== 'assistant') {
    throw new ProviderError('provider_protocol', 'tool calls are only allowed on an assistant message', {
      providerId: context.provider.id,
      capability: 'chat',
      retryable: false
    });
  }
  const textParts = message.content.filter((part) => part.type === 'text');
  const nonText = message.content.filter((part) => part.type !== 'text');
  if (message.toolCalls && nonText.length > 0) {
    throw new ProviderError('provider_protocol', 'an assistant tool-call message cannot carry media parts', {
      providerId: context.provider.id,
      capability: 'chat',
      retryable: false
    });
  }
  const body: Record<string, unknown> = {
    role: message.role,
    content: nonText.length === 0
      ? textParts.map((part) => part.text).join('')
      : message.content.map((part) => toOpenAiPart(part, context))
  };
  if (message.name) body.name = message.name;
  if (message.toolCallId) body.tool_call_id = message.toolCallId;
  if (message.toolCalls) {
    if (textParts.length === 0 && nonText.length === 0) body.content = null;
    body.tool_calls = message.toolCalls.map((call) => {
      if (!call.id) {
        throw new ProviderError('provider_protocol', 'assistant tool call requires a pairing id', {
          providerId: context.provider.id,
          capability: 'chat',
          retryable: false
        });
      }
      return {
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
      };
    });
  }
  return body;
}

function toOpenAiPart(part: ChatContentPart, context: ProviderCallContext): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image') return { type: 'image_url', image_url: { url: mediaDataUrl(part) } };
  throw new ProviderError('provider_protocol', 'chat adapter does not accept direct video input', {
    providerId: context.provider.id,
    capability: 'chat',
    retryable: false
  });
}

function mediaDataUrl(part: Extract<ChatContentPart, { type: 'image' }>): string {
  return `data:${part.media.mimeType};base64,${part.media.data.toString('base64')}`;
}

function extractText(content: string | Array<{ type?: string; text?: string }> | null | undefined): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part) => part.type === 'text' || part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
  return text.length > 0 ? text : undefined;
}

function mapUsage(usage: NonNullable<OpenAiPayload['usage']>): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} {
  return {
    ...(usage.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { completionTokens: usage.completion_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {})
  };
}

function protocolError(context: ProviderCallContext, capability: CapabilityId, message: string): ProviderError {
  return new ProviderError('provider_protocol', message, {
    providerId: context.provider.id,
    capability,
    retryable: false
  });
}

function bodyError(context: ProviderCallContext, capability: CapabilityId, error: unknown): ProviderError {
  const body = error instanceof HttpBodyError ? error : undefined;
  if (body?.code === 'http_body_too_large') {
    return new ProviderError('provider_protocol', `${capability} response exceeded ${body.limit ?? 'the'} byte limit`, {
      providerId: context.provider.id,
      capability,
      retryable: false,
      cause: error
    });
  }
  const unknown = capability === 'image.generate' || capability === 'audio.generate';
  const interrupted = body?.code === 'http_body_aborted'
    || body?.code === 'http_body_timeout'
    || body?.code === 'http_body_failed';
  if (interrupted) {
    return new ProviderError(
      unknown ? 'provider_generate_unknown' : 'provider_timeout',
      unknown
        ? `${capability === 'audio.generate' ? 'audio' : 'image'} response was interrupted; remote result is unknown`
        : 'provider request timed out or was aborted while reading the response',
      {
        providerId: context.provider.id,
        capability,
        retryable: !unknown,
        cause: error
      }
    );
  }
  return new ProviderError(
    'provider_transport',
    `provider response read failed: ${sanitizeErrorText(body?.message ?? String(error))}`,
    {
      providerId: context.provider.id,
      capability,
      retryable: !unknown,
      cause: error
    }
  );
}

function httpError(
  context: ProviderCallContext,
  capability: CapabilityId,
  response: Response,
  body: string
): ProviderError {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as OpenAiPayload;
    detail = parsed.error?.message ?? parsed.message ?? '';
  } catch {
    // 非 JSON 错误体不进入错误信息，避免把带鉴权 URL 原样带出。
  }
  const message = detail ? sanitizeErrorText(detail) : `provider returned HTTP ${response.status}`;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  if (response.status === 401 || response.status === 403) {
    return new ProviderError('provider_auth', `provider authentication failed: ${message}`, {
      providerId: context.provider.id,
      capability,
      retryable: false,
      httpStatus: response.status
    });
  }
  if (response.status === 429) {
    return new ProviderError('provider_rate_limit', `provider rate limit: ${message}`, {
      providerId: context.provider.id,
      capability,
      retryable: true,
      httpStatus: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
    });
  }
  if ((capability === 'image.generate' || capability === 'audio.generate') && response.status >= 500) {
    return new ProviderError('provider_generate_unknown', `${capability === 'audio.generate' ? 'audio' : 'image'} generation returned HTTP ${response.status}; remote result is unknown`, {
      providerId: context.provider.id,
      capability,
      retryable: false,
      httpStatus: response.status
    });
  }
  return new ProviderError(
    response.status >= 500 ? 'provider_upstream' : 'provider_rejected',
    `provider returned HTTP ${response.status}: ${message}`,
    {
      providerId: context.provider.id,
      capability,
      retryable: response.status >= 500,
      httpStatus: response.status
    }
  );
}

function audioMimeForFormat(format: NonNullable<AudioGenerationRequest['format']>): string {
  switch (format) {
    case 'wav': return 'audio/wav';
    case 'opus': return 'audio/opus';
    case 'aac': return 'audio/aac';
    case 'flac': return 'audio/flac';
    default: return 'audio/mpeg';
  }
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
