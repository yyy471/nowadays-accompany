import { APPLICATION_TRIGGER_INPUT } from "../domain/model.js";
import { createHash, randomUUID } from "node:crypto";
import { isVertexPublisherBaseUrl, type ModelProvider } from "../domain/model-providers.js";
import { ChatReasoning } from "./chat-reasoning.js";
import {
  ModelListIncompatibleError,
  ModelRedirectBlockedError,
  ModelRequestFailedError,
  ModelRequestTimeoutError,
  ModelToolArgumentsError,
} from "../domain/errors.js";
import type {
  ModelEvent,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelServiceConfig,
  ModelUsage,
} from "../domain/model.js";
import {
  buildGeminiGenerateBody,
  listGoogleModels,
  mapGoogleErrorReason,
  streamGoogleGemini,
  vertexGlobalProbeBase, VertexEndpointNotFound,
  type GoogleGeminiTransport,
  type GoogleOAuthTokenCache,
} from "./google-gemini.js";

const DEFAULT_LIST_TIMEOUT_MS = 20_000;

/** 流式请求从建立连接到收到响应头的等待上限。 */
export const DEFAULT_STREAM_HEADER_TIMEOUT_MS = 90_000;
/** 流式请求相邻 SSE 数据块之间的空闲上限（不含已到达字节的读取时间）。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;
/** 单个流式调用最多保留的原始响应字节数，避免长流无限占用内存。 */
export const DEFAULT_MAX_RAW_RESPONSE_BYTES = 256 * 1024;

export interface HttpModelAdapterOptions {
  /** 列表等短请求的等待上限；流式请求沿用调用方提供的信号。 */
  listTimeoutMs?: number;
  /** 流式请求等待响应头的上限。 */
  streamHeaderTimeoutMs?: number;
  /** 流式请求相邻数据块的空闲上限。 */
  streamIdleTimeoutMs?: number;
  /** 流式请求保留的原始响应字节上限。 */
  maxRawResponseBytes?: number;
  /** 仅测试使用：允许服务账号 token_uri 指向本地 mock OAuth 服务。 */
  allowCustomGoogleTokenUri?: boolean;
}

export class HttpModelAdapter implements ModelPort {
  private readonly listTimeoutMs: number;
  private readonly streamHeaderTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly maxRawResponseBytes: number;
  private readonly allowCustomGoogleTokenUri: boolean;
  private readonly googleTokenCache: { current: GoogleOAuthTokenCache | undefined } = {
    current: undefined,
  };

  constructor(
    private readonly config: ModelServiceConfig,
    private readonly credential: string | undefined,
    options: HttpModelAdapterOptions = {},
  ) {
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.streamHeaderTimeoutMs =
      options.streamHeaderTimeoutMs ?? DEFAULT_STREAM_HEADER_TIMEOUT_MS;
    this.streamIdleTimeoutMs =
      options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.maxRawResponseBytes =
      options.maxRawResponseBytes ?? DEFAULT_MAX_RAW_RESPONSE_BYTES;
    this.allowCustomGoogleTokenUri = options.allowCustomGoogleTokenUri ?? false;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.config.protocol === "google-gemini") {
      return listGoogleModels({
        baseUrl: this.config.baseUrl,
        credential: this.credential,
        cacheRef: this.googleTokenCache,
        transport: this.googleTransport(),
        timeoutMs: this.listTimeoutMs,
        headerTimeoutMs: this.streamHeaderTimeoutMs,
        maxRawResponseBytes: this.maxRawResponseBytes,
        allowCustomTokenUri: this.allowCustomGoogleTokenUri,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    const { provider } = this.config;
    const listPath = provider === "opencode-go" ? "/v1/models"
      : provider === "xai" ? "/language-models"
      : provider === "openrouter" && this.credential ? "/models/user" : "/models";
    const headers = this.baseHeaders("application/json");
    const response = await this.request(
      endpoint(this.config.baseUrl, listPath),
      { method: "GET", headers },
      { timeoutMs: this.listTimeoutMs, ...(signal === undefined ? {} : { signal }) },
    );
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ModelListIncompatibleError("INVALID_JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ModelListIncompatibleError("NOT_OBJECT");
    }
    const data = provider === "xai" ? (parsed as { models?: unknown }).models : (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new ModelListIncompatibleError(provider === "xai" ? "MODELS_NOT_ARRAY" : "DATA_NOT_ARRAY");
    }
    const models = new Set<string>();
    for (const item of data) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
        throw new ModelListIncompatibleError("ITEMS_WITHOUT_ID");
      }
      // MiMo 目录也含独立的语音识别与合成服务。
      if (provider === "mimo" && /-(asr|tts)(?:-|$)/i.test(item.id)) continue;
      models.add(item.id);
      if (provider === "xai" && Array.isArray(item.aliases)) {
        for (const alias of item.aliases) if (typeof alias === "string" && alias.trim()) models.add(alias);
      }
    }
    return [...models];
  }

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (this.config.protocol === "openai-chat") {
      return this.streamOpenAiChat(request);
    }
    if (this.config.protocol === "openai-responses") {
      return this.streamOpenAiResponses(request);
    }
    if (this.config.protocol === "google-gemini") {
      return streamGoogleGemini({
        baseUrl: this.config.baseUrl,
        ...(this.config.provider === undefined ? {} : { provider: this.config.provider }),
        credential: this.credential,
        cacheRef: this.googleTokenCache,
        request,
        transport: this.googleTransport(),
        serializedBody: serializeModelRequest("google-gemini", this.config.baseUrl, request, this.config.provider, this.config.vertexSafety),
        headerTimeoutMs: this.streamHeaderTimeoutMs,
        maxRawResponseBytes: this.maxRawResponseBytes,
        allowCustomTokenUri: this.allowCustomGoogleTokenUri,
      });
    }
    return this.streamAnthropic(request);
  }

  private googleTransport(): GoogleGeminiTransport {
    return {
      request: (url, init, options) => this.request(url, init, options),
      readSse: (response, options) =>
        readSse(response, undefined, {
          idleTimeoutMs: this.streamIdleTimeoutMs,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }),
      parseStreamJson,
      continuationItems: (message, protocol, model, base) => continuationItems(message, protocol, model, base, this.config.provider),
    };
  }

  private async *streamOpenAiChat(
    request: ModelRequest,
  ): AsyncGenerator<ModelEvent> {
    const { provider, baseUrl } = this.config;
    const headers = this.baseHeaders("text/event-stream");
    if (provider === "opencode-go") {
      const session = createHash("sha256").update(request.sessionId ?? randomUUID()).digest("hex");
      headers["x-opencode-session"] = `ses_${session.slice(0, 32)}`;
    }
    const response = await this.request(
      endpoint(baseUrl, provider === "opencode-go" ? "/openai/v1/chat/completions" : "/chat/completions"),
      {
        method: "POST",
        headers,
        body: serializeModelRequest("openai-chat", baseUrl, request, provider),
        ...(request.signal ? { signal: request.signal } : {}),
      },
      {
        timeoutMs: this.streamHeaderTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    request.onAccepted?.();
    const toolBuffers = new Map<
      number,
      { callId: string; name: string; arguments: string }
    >();
    const rawResponse = new RawResponseCollector(this.maxRawResponseBytes);
    const reasoning = provider ? new ChatReasoning(provider) : null;
    let finishReason: string | null = null;
    let usage: ModelUsage | null = null;
    const sseState: SseState = { done: false };
    let parsedTools: Array<{
      callId: string;
      name: string;
      arguments: unknown;
    }> = [];
    try {
      for await (const payload of readSse(response, sseState, {
        idleTimeoutMs: this.streamIdleTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      })) {
        const data = parseStreamJson(payload.data);
        rawResponse.push(data, Buffer.byteLength(payload.data, "utf8"));
        const choices = data.choices as
          | Array<{
              delta?: {
                content?: unknown;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: unknown };
                }>;
              };
              finish_reason?: string | null;
            }>
          | undefined;
        const choice = choices?.[0];
        if (data.error || choice?.finish_reason === "error") {
          throw new ModelRequestFailedError("模型流返回服务错误", { reason: "STREAM_ERROR" });
        }
        if (choice?.delta) reasoning?.append(choice.delta);
        const content = choice?.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          yield { type: "text_delta", text: content };
        }
        for (const [position, call] of (choice?.delta?.tool_calls ?? []).entries()) {
          const previous = call.id ? [...toolBuffers].find(([, value]) => value.callId === call.id) : undefined;
          const index = call.index ?? previous?.[0] ?? (call.id ? toolBuffers.size : position);
          const existing = toolBuffers.get(index) ?? {
            callId: "",
            name: "",
            arguments: "",
          };
          existing.callId = call.id ?? existing.callId;
          existing.name = call.function?.name ?? existing.name;
          const args = call.function?.arguments;
          if (typeof args === "string") existing.arguments += args;
          else if (provider === "zai" && isRecord(args)) existing.arguments = JSON.stringify(args);
          else if (args != null) throw new ModelToolArgumentsError(existing.name);
          toolBuffers.set(index, existing);
        }
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const usageValue = data.usage as
          | {
              prompt_tokens?: number;
              completion_tokens?: number;
              cached_tokens?: number;
              prompt_cache_hit_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            }
          | undefined;
        const parsedUsage = normalizeUsage({
          inputTokens: usageValue?.prompt_tokens,
          cachedTokens:
            usageValue?.prompt_tokens_details?.cached_tokens ??
            usageValue?.prompt_cache_hit_tokens ??
            usageValue?.cached_tokens,
          outputTokens: usageValue?.completion_tokens,
        });
        if (parsedUsage !== null) {
          usage = parsedUsage;
        }
      }
      if (finishReason === null || !sseState.done) {
        throw new ModelRequestFailedError("模型流提前结束，未收到完整终态", {
          reason: "STREAM_TRUNCATED",
        });
      }
      parsedTools = [...toolBuffers.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([index, call]) => ({
          callId: call.callId || `tool-${index}`,
          name: call.name,
          arguments: parseToolArguments(call.name, call.arguments),
        }));
    } catch (error) {
      if (usage !== null) {
        yield { type: "usage", ...usage };
      }
      throw error;
    }
    for (const call of parsedTools) {
      yield {
        type: "tool_call",
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      };
    }
    if (usage) {
      yield { type: "usage", ...usage };
    }
    const incomplete =
      finishReason === "length" || finishReason === "content_filter";
    const fields = reasoning?.fields() ?? {};
    yield {
      type: "completed",
      stopReason: finishReason,
      ...(incomplete ? { incomplete: true } : {}),
      rawResponse: rawResponse.finish(),
      ...(provider && (Object.keys(fields).length > 0 || parsedTools.length > 0) ? {
        continuation: { protocol: "openai-chat", provider, baseUrl, modelName: request.modelName, items: [fields] },
      } : {}),
    };
  }

  private async *streamOpenAiResponses(
    request: ModelRequest,
  ): AsyncGenerator<ModelEvent> {
    const response = await this.request(
      endpoint(this.config.baseUrl, "/responses"),
      {
        method: "POST",
        headers: this.baseHeaders("text/event-stream"),
        body: serializeModelRequest("openai-responses", this.config.baseUrl, request, this.config.provider),
        ...(request.signal ? { signal: request.signal } : {}),
      },
      {
        timeoutMs: this.streamHeaderTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    request.onAccepted?.();
    const toolBuffers = new Map<
      string,
      { callId: string; name: string; arguments: string }
    >();
    const rawResponse = new RawResponseCollector(this.maxRawResponseBytes);
    let usage: ModelUsage | null = null;
    let terminal:
      | {
          type: "completed" | "incomplete";
          status?: string;
          stopReason?: string;
        }
      | null = null;
    let outputItems: Record<string, unknown>[] | undefined;
    const finishedItems = new Map<number, Record<string, unknown>>();
    let parsedTools: Array<{
      callId: string;
      name: string;
      arguments: unknown;
    }> = [];
    try {
      for await (const payload of readSse(response, undefined, {
        idleTimeoutMs: this.streamIdleTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      })) {
        const data = parseStreamJson(payload.data);
        rawResponse.push(data, Buffer.byteLength(payload.data, "utf8"));
        const type = data.type as string | undefined;
        if (type === "response.output_text.delta") {
          if (typeof data.delta === "string") {
            yield { type: "text_delta", text: data.delta };
          }
          continue;
        }
        if (type === "response.output_item.done" && isRecord(data.item)) {
          const index =
            typeof data.output_index === "number"
              ? data.output_index
              : finishedItems.size;
          finishedItems.set(index, data.item);
          continue;
        }
        if (type === "response.output_item.added") {
          const item = data.item as
            | {
                id?: string;
                type?: string;
                call_id?: string;
                name?: string;
                arguments?: string;
              }
            | undefined;
          if (item?.type === "function_call") {
            const key = item.id ?? item.call_id ?? "tool";
            toolBuffers.set(key, {
              callId: item.call_id ?? key,
              name: item.name ?? "",
              arguments: item.arguments ?? "",
            });
          }
          continue;
        }
        if (
          type === "response.function_call_arguments.delta" ||
          type === "response.function_call_arguments.done"
        ) {
          const key = data.item_id as string | undefined;
          if (!key) {
            continue;
          }
          const existing = toolBuffers.get(key) ?? {
            callId: key,
            name: "",
            arguments: "",
          };
          if (typeof data.delta === "string") {
            existing.arguments += data.delta;
          }
          if (typeof data.arguments === "string") {
            existing.arguments = data.arguments;
          }
          toolBuffers.set(key, existing);
          continue;
        }
        if (type === "response.completed" || type === "response.incomplete") {
          const body = data.response as
            | {
                status?: string;
                stop_reason?: string;
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  input_tokens_details?: { cached_tokens?: number };
                };
                output?: unknown[];
              }
            | undefined;
          usage = readUsage(body?.usage) ?? usage;
          if (body?.status === "failed" || body?.status === "cancelled") {
            throw new ModelRequestFailedError("模型请求失败", {
              reason: "RESPONSE_FAILED",
            });
          }
          if (Array.isArray(body?.output)) {
            const output = body.output.filter(isRecord);
            if (output.length > 0) {
              outputItems = output;
            }
          }
          terminal = {
            type: type === "response.incomplete" ? "incomplete" : "completed",
            ...(body?.status === undefined ? {} : { status: body.status }),
            ...(body?.stop_reason === undefined
              ? {}
              : { stopReason: body.stop_reason }),
          };
          continue;
        }
        if (type === "response.failed" || type === "error") {
          const body = data.response as
            | {
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  input_tokens_details?: { cached_tokens?: number };
                };
              }
            | undefined;
          usage = readUsage(body?.usage) ?? usage;
          throw new ModelRequestFailedError("模型请求失败", {
            reason: "RESPONSE_FAILED",
          });
        }
      }
      if (terminal === null) {
        throw new ModelRequestFailedError("模型流提前结束，未收到完整终态", {
          reason: "STREAM_TRUNCATED",
        });
      }
      parsedTools = [...toolBuffers.values()].map((call) => ({
        callId: call.callId,
        name: call.name,
        arguments: parseToolArguments(call.name, call.arguments),
      }));
    } catch (error) {
      if (usage !== null) {
        yield { type: "usage", ...usage };
      }
      throw error;
    }
    for (const call of parsedTools) {
      yield {
        type: "tool_call",
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      };
    }
    if (usage) {
      yield { type: "usage", ...usage };
    }
    const incomplete =
      terminal.type === "incomplete" || terminal.status === "incomplete";
    yield {
      type: "completed",
      stopReason:
        terminal.stopReason ??
        terminal.status ??
        (incomplete ? "incomplete" : "completed"),
      ...(incomplete ? { incomplete: true } : {}),
      rawResponse: rawResponse.finish(),
      ...((outputItems ?? [...finishedItems.values()]).length === 0
        ? {}
        : {
            continuation: {
              protocol: this.config.protocol,
              ...(this.config.provider === undefined ? {} : { provider: this.config.provider }),
              modelName: request.modelName,
              baseUrl: this.config.baseUrl,
              items: outputItems ?? [...finishedItems.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
            },
          }),
    };
  }

  private async *streamAnthropic(
    request: ModelRequest,
  ): AsyncGenerator<ModelEvent> {
    const response = await this.request(
      endpoint(this.config.baseUrl, "/messages"),
      {
        method: "POST",
        headers: this.baseHeaders("text/event-stream"),
        body: serializeModelRequest("anthropic-messages", this.config.baseUrl, request, this.config.provider),
        ...(request.signal ? { signal: request.signal } : {}),
      },
      {
        timeoutMs: this.streamHeaderTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    request.onAccepted?.();
    const toolBuffers = new Map<
      number,
      { callId: string; name: string; arguments: string; initial: unknown }
    >();
    const rawResponse = new RawResponseCollector(this.maxRawResponseBytes);
    let rawInputTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheCreationTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | null = null;
    let sawMessageStop = false;
    const contentBlocks = new Map<number, Record<string, unknown>>();
    const buildAnthropicUsage = (): ModelUsage | null => {
      const hasAnyInput =
        rawInputTokens !== undefined ||
        cacheReadTokens !== undefined ||
        cacheCreationTokens !== undefined;
      const inputTokens = hasAnyInput
        ? (rawInputTokens ?? 0) +
          (cacheReadTokens ?? 0) +
          (cacheCreationTokens ?? 0)
        : undefined;
      return normalizeUsage({
        inputTokens,
        cachedTokens: cacheReadTokens,
        outputTokens,
        cacheCreationTokens,
      });
    };
    let parsedTools: Array<{
      index: number;
      callId: string;
      name: string;
      arguments: unknown;
    }> = [];
    try {
      for await (const payload of readSse(response, undefined, {
        idleTimeoutMs: this.streamIdleTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      })) {
        const data = parseStreamJson(payload.data);
        rawResponse.push(data, Buffer.byteLength(payload.data, "utf8"));
        const type = data.type as string | undefined;
        if (type === "message_start") {
          const messageUsage = (
            data.message as
              | {
                  usage?: {
                    input_tokens?: number;
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                    output_tokens?: number;
                  };
                }
              | undefined
          )?.usage;
          if (typeof messageUsage?.input_tokens === "number") {
            rawInputTokens = messageUsage.input_tokens;
          }
          if (typeof messageUsage?.cache_read_input_tokens === "number") {
            cacheReadTokens = messageUsage.cache_read_input_tokens;
          }
          if (typeof messageUsage?.cache_creation_input_tokens === "number") {
            cacheCreationTokens = messageUsage.cache_creation_input_tokens;
          }
          if (typeof messageUsage?.output_tokens === "number") {
            outputTokens = messageUsage.output_tokens;
          }
          continue;
        }
        if (type === "content_block_start") {
          const index = data.index as number | undefined;
          const block = data.content_block as
            | {
                type?: string;
                id?: string;
                name?: string;
                input?: unknown;
              }
            | undefined;
          if (index !== undefined && isRecord(block)) {
            contentBlocks.set(index, { ...block });
          }
          if (index !== undefined && block?.type === "tool_use") {
            toolBuffers.set(index, {
              callId: block.id ?? `tool-${index}`,
              name: block.name ?? "",
              arguments: "",
              initial: block.input,
            });
          }
          continue;
        }
        if (type === "content_block_delta") {
          const index = data.index as number | undefined;
          const delta = data.delta as
            | {
                type?: string;
                text?: string;
                partial_json?: string;
                thinking?: string;
                signature?: string;
              }
            | undefined;
          const block = index === undefined ? undefined : contentBlocks.get(index);
          if (block && delta) {
            for (const [kind, field] of [
              ["text_delta", "text"],
              ["thinking_delta", "thinking"],
              ["signature_delta", "signature"],
            ] as const) {
              if (delta.type === kind && typeof delta[field] === "string") {
                block[field] = String(block[field] ?? "") + delta[field];
              }
            }
          }
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text_delta", text: delta.text };
          }
          if (
            delta?.type === "input_json_delta" &&
            typeof delta.partial_json === "string" &&
            index !== undefined
          ) {
            const existing = toolBuffers.get(index);
            if (existing) {
              existing.arguments += delta.partial_json;
            }
          }
          continue;
        }
        if (type === "message_delta") {
          const delta = data.delta as
            | { stop_reason?: string | null }
            | undefined;
          const deltaUsage = data.usage as
            | {
                input_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
                output_tokens?: number;
              }
            | undefined;
          if (typeof delta?.stop_reason === "string") {
            stopReason = delta.stop_reason;
          }
          if (typeof deltaUsage?.input_tokens === "number") {
            rawInputTokens = deltaUsage.input_tokens;
          }
          if (typeof deltaUsage?.cache_read_input_tokens === "number") {
            cacheReadTokens = deltaUsage.cache_read_input_tokens;
          }
          if (typeof deltaUsage?.cache_creation_input_tokens === "number") {
            cacheCreationTokens = deltaUsage.cache_creation_input_tokens;
          }
          if (typeof deltaUsage?.output_tokens === "number") {
            outputTokens = deltaUsage.output_tokens;
          }
          continue;
        }
        if (type === "message_stop") {
          sawMessageStop = true;
          continue;
        }
        if (type === "error") {
          throw new ModelRequestFailedError("模型请求失败", {
            reason: "MESSAGE_ERROR",
          });
        }
      }
      if (!sawMessageStop || stopReason === null) {
        throw new ModelRequestFailedError("模型流提前结束，未收到完整终态", {
          reason: "STREAM_TRUNCATED",
        });
      }
      parsedTools = [...toolBuffers.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([index, call]) => ({
          index,
          callId: call.callId,
          name: call.name,
          arguments:
            call.arguments.trim().length > 0
              ? parseToolArguments(call.name, call.arguments)
              : (call.initial ?? {}),
        }));
    } catch (error) {
      const partialUsage = buildAnthropicUsage();
      if (partialUsage !== null) {
        yield { type: "usage", ...partialUsage };
      }
      throw error;
    }
    const anthropicUsage = buildAnthropicUsage();
    for (const call of parsedTools) {
      const block = contentBlocks.get(call.index);
      if (block) block.input = call.arguments;
      yield {
        type: "tool_call",
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      };
    }
    if (anthropicUsage !== null) {
      yield { type: "usage", ...anthropicUsage };
    }
    const incomplete =
      stopReason === "max_tokens" || stopReason === "pause_turn";
    yield {
      type: "completed",
      stopReason,
      ...(incomplete ? { incomplete: true } : {}),
      rawResponse: rawResponse.finish(),
      ...(contentBlocks.size === 0
        ? {}
        : {
            continuation: {
              protocol: this.config.protocol,
              ...(this.config.provider === undefined ? {} : { provider: this.config.provider }),
              modelName: request.modelName,
              baseUrl: this.config.baseUrl,
              items: [...contentBlocks.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, block]) => block),
            },
          }),
    };
  }

  private baseHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept,
    };
    if (this.config.provider === "opencode-go") headers["user-agent"] = "Nowadays";
    if (this.credential !== undefined) {
      if (this.config.protocol === "anthropic-messages") {
        headers["x-api-key"] = this.credential;
        headers["anthropic-version"] = "2023-06-01";
      } else if (this.config.provider === "mimo") {
        headers["api-key"] = this.credential;
      } else {
        headers.authorization = `Bearer ${this.credential}`;
      }
    }
    return headers;
  }

  private async request(
    url: string,
    init: RequestInit,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Response> {
    // 这里是“响应头/首字节”超时：一旦 fetch 解析出响应头就立即清除计时器，
    // 否则长时间持续输出的流会被总时长上限误杀。
    const timeoutMs = options.timeoutMs;
    const headerController =
      timeoutMs === undefined ? undefined : new AbortController();
    let headerTimedOut = false;
    const headerTimer =
      timeoutMs === undefined || headerController === undefined
        ? undefined
        : setTimeout(() => {
            headerTimedOut = true;
            headerController.abort(new ModelRequestTimeoutError(timeoutMs));
          }, timeoutMs);
    headerTimer?.unref?.();
    const signals = [init.signal, options.signal, headerController?.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== null && candidate !== undefined,
    );
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        // 带凭据的请求不跟随重定向，避免密钥被带到未预期的地址。
        redirect: "manual",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (headerTimedOut) {
        throw new ModelRequestTimeoutError(timeoutMs ?? 0);
      }
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ModelRequestFailedError("模型请求已取消", {
          reason: "ABORTED",
        });
      }
      throw new ModelRequestFailedError("模型服务不可达", {
        reason: error instanceof Error ? error.name : "NETWORK_ERROR",
      });
    } finally {
      if (headerTimer !== undefined) {
        clearTimeout(headerTimer);
      }
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ModelRedirectBlockedError(response.status);
    }
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 404 && this.config.protocol === "google-gemini" && init.method === "POST" &&
          /^https:\/\/aiplatform\.googleapis\.com\/v1(?:beta1)?\/publishers\/google\/models\//.test(url)) {
        throw new VertexEndpointNotFound(vertexGlobalProbeBase(url, body));
      }
      throw new ModelRequestFailedError(
        `模型服务返回 HTTP ${response.status}`,
        {
          status: response.status,
          reason: safeUpstreamReason(response.status, body),
        },
      );
    }
    return response;
  }
}

/**
 * 有界原始响应收集器：超过上限后停止收集，并在结尾附加截断标记。
 * 长流只保留前若干字节的协议帧，避免 rawResponse 无上限增长。
 */
export class RawResponseCollector {
  private readonly items: unknown[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes = DEFAULT_MAX_RAW_RESPONSE_BYTES) {}

  push(item: unknown, rawByteLength?: number): void {
    if (this.truncated) {
      return;
    }
    const size =
      rawByteLength ?? Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");
    if (this.bytes + size > this.maxBytes) {
      this.truncated = true;
      return;
    }
    this.bytes += size;
    this.items.push(item);
  }

  finish(): unknown[] | undefined {
    if (this.items.length === 0 && !this.truncated) {
      return undefined;
    }
    if (this.truncated) {
      return [...this.items, { _truncated: true, maxBytes: this.maxBytes }];
    }
    return this.items;
  }
}

/** 与生成请求共用同一序列化路径，覆盖协议开销和合法续轮块。 */
export function serializeModelRequest(
  protocol: ModelServiceConfig["protocol"],
  baseUrl: string,
  request: ModelRequest,
  provider?: ModelProvider,
  vertexSafety?: ModelServiceConfig["vertexSafety"],
): string {
  const requiresChatReasoning = request.tools.length > 0 && (provider === "deepseek" || provider === "mimo");
  const messages = request.messages.map((message): ModelMessage => {
    if (message.role === "assistant" && message.continuation?.resourceId !== undefined &&
        message.continuation.resourceId !== request.resourceId) {
      const { continuation: _previous, ...text } = message;
      return text;
    }
    if (message.role !== "tool" || message.source?.historical !== true) return message;
    return {
      // Messages API 合并相邻 assistant 内容。历史回执若与当前原生调用相邻，
      // 会把无签名文本拼到 thinking 块之前；回执属于应用交给模型的数据。
      role: protocol === "anthropic-messages" || protocol === "google-gemini" || requiresChatReasoning ? "user" : "assistant",
      content: `已保存的工具事实 [${message.source.toolCallId ?? message.source.internalStepKey ?? message.toolCallId}]（${message.toolName ?? "工具"}）：${message.content}`,
    };
  });
  const needsSpeakerLabels = protocol === "openai-chat" && requiresChatReasoning &&
    messages.some(message => message.role === "assistant" && !message.toolCalls?.length &&
      !continuationItems(message, protocol, request.modelName, baseUrl, provider)?.[0]);
  switch (protocol) {
    case "openai-chat":
      return JSON.stringify({
        model: request.modelName,
        messages: [
          { role: "system", content: request.system },
          ...messages.map(message => toOpenAiChatMessage(message, request.modelName, baseUrl, provider, requiresChatReasoning, needsSpeakerLabels)),
        ],
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { max_tokens: request.maxOutputTokens }),
        stream: true,
        ...(provider === "zai" ? {} : { stream_options: { include_usage: true } }),
      });
    case "openai-responses":
      return JSON.stringify({
        model: request.modelName,
        instructions: request.system,
        input: messages.flatMap((message) =>
          toOpenAiResponsesInput(message, request.modelName, baseUrl, provider),
        ),
        include: ["reasoning.encrypted_content"],
        ...(provider === "xai" ? { store: false } : {}),
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
            }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: request.maxOutputTokens }),
        stream: true,
      });
    case "anthropic-messages":
      return JSON.stringify({
        model: request.modelName,
        system: request.system,
        messages: toAnthropicMessages(messages, request.modelName, baseUrl, provider),
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }),
        max_tokens: request.maxOutputTokens ?? 1024,
        stream: true,
      });
    case "google-gemini":
      return JSON.stringify(buildGeminiGenerateBody(
        { ...request, messages }, request.modelName, baseUrl,
        (message, protocol, model, base) => continuationItems(message, protocol, model, base, provider),
        provider !== "google-ai-studio" && isVertexPublisherBaseUrl(baseUrl) ? vertexSafety ?? "default" : undefined,
      ));
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function toOpenAiChatMessage(
  message: ModelMessage, modelName: string, baseUrl: string, provider: ModelProvider | undefined, requiresReasoning: boolean, needsSpeakerLabels: boolean,
): unknown {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    const calls = message.toolCalls ?? [];
    const saved = provider ? continuationItems(message, "openai-chat", modelName, baseUrl, provider)?.[0] : undefined;
    // 这些服务会校验历史 assistant 的推理。来自本地的历史正文以引用送入。
    if (requiresReasoning && saved === undefined && calls.length === 0) {
      return { role: "user", content: `[角色先前的回复]\n${JSON.stringify({ sender: "assistant", text: message.content })}` };
    }
    const reasoningContent = typeof saved?.reasoning_content === "string" ? saved.reasoning_content
      : requiresReasoning ? "" : undefined;
    return {
      ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
      ...(Array.isArray(saved?.reasoning_details) ? { reasoning_details: saved.reasoning_details } : {}),
      ...(typeof saved?.reasoning === "string" ? { reasoning: saved.reasoning } : {}),
      role: "assistant",
      content:
        message.content.length > 0
          ? message.content
          : calls.length > 0
            ? null
            : "",
      ...(calls.length === 0
        ? {}
        : {
            tool_calls: calls.map((call) => ({
              id: call.callId,
              type: "function",
              function: {
                name: call.name,
                arguments: serializeToolArguments(call.arguments),
              },
            })),
          }),
    };
  }
  let content = message.content;
  if (needsSpeakerLabels && (message.source?.messageId || message.source?.currentUserRequest)) {
    const marker = message.source.currentUserRequest ? "[本轮用户消息]" : "[用户先前的发言]";
    content = `${marker}\n${JSON.stringify({ sender: "user", text: content })}`;
  }
  if (!message.images?.length) {
    return { role: "user", content };
  }
  return {
    role: "user",
    content: [
      { type: "text", text: content },
      ...message.images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` },
      })),
    ],
  };
}

function toOpenAiResponsesInput(message: ModelMessage, modelName: string, baseUrl: string, provider?: ModelProvider): unknown[] {
  if (message.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      },
    ];
  }
  if (message.role === "assistant") {
    const replay = continuationItems(message, "openai-responses", modelName, baseUrl, provider);
    if (replay) return replay;
    const items: unknown[] = [];
    const calls = message.toolCalls ?? [];
    if (message.content.length > 0 || calls.length === 0) {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      });
    }
    for (const call of calls) {
      items.push({
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: serializeToolArguments(call.arguments),
      });
    }
    return items;
  }
  return [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: message.content },
        ...(message.images?.map((image) => ({
          type: "input_image",
          image_url: `data:${image.mediaType};base64,${image.dataBase64}`,
        })) ?? []),
      ],
    },
  ];
}

function toAnthropicMessages(
  messages: readonly ModelMessage[],
  modelName: string,
  baseUrl: string,
  provider?: ModelProvider,
): unknown[] {
  const items: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  // 自主触发可以没有用户消息。协议需要一项输入，由应用表明触发来源。
  if (messages.length === 0) {
    return [{ role: "user", content: [{ type: "text", text: APPLICATION_TRIGGER_INPUT }] }];
  }
  let lastWasToolResult = false;
  for (const message of messages) {
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      };
      if (lastWasToolResult && items.length > 0) {
        items[items.length - 1]?.content.push(block);
      } else {
        items.push({ role: "user", content: [block] });
      }
      lastWasToolResult = true;
      continue;
    }
    lastWasToolResult = false;
    if (message.role === "assistant") {
      const replay = continuationItems(message, "anthropic-messages", modelName, baseUrl, provider);
      if (replay) {
        items.push({ role: "assistant", content: replay });
        continue;
      }
      const content: unknown[] = [];
      const calls = message.toolCalls ?? [];
      if (message.content.length > 0 || calls.length === 0) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of calls) {
        content.push({
          type: "tool_use",
          id: call.callId,
          name: call.name,
          input: anthropicToolInput(call.arguments),
        });
      }
      items.push({ role: "assistant", content });
      continue;
    }
    items.push({
      role: "user",
      content: [
        ...(message.images?.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.dataBase64,
          },
        })) ?? []),
        { type: "text", text: message.content },
      ],
    });
  }
  return items;
}

export function continuationItems(
  message: Extract<ModelMessage, { role: "assistant" }>,
  protocol: ModelServiceConfig["protocol"],
  modelName: string,
  baseUrl: string,
  provider?: ModelProvider,
): Record<string, unknown>[] | null {
  const continuation = message.continuation;
  // 配置变化时不向另一协议／服务／模型发送原服务的加密或签名块。
  if (continuation?.protocol !== protocol || continuation.provider !== provider ||
      continuation.modelName !== modelName || continuation.baseUrl !== baseUrl) return null;
  return continuation.items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeToolArguments(args: unknown): string {
  if (typeof args === "string") {
    return args;
  }
  if (args === undefined) {
    return "{}";
  }
  const text = JSON.stringify(args);
  return text === undefined ? "{}" : text;
}

function anthropicToolInput(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to an empty object
    }
  }
  return {};
}

const SAFE_UPSTREAM_REASONS = new Set([
  "api_error",
  "authentication_error",
  "content_policy_violation",
  "context_length_exceeded",
  "insufficient_quota",
  "invalid_api_key",
  "invalid_request_error",
  "not_found_error",
  "overloaded_error",
  "permission_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "server_error",
  "timeout",
]);

function safeUpstreamReason(status: number, body: string): string {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return `http_${status}`;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `http_${status}`;
  }
  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return `http_${status}`;
  }
  const googleReason = mapGoogleErrorReason(error);
  if (googleReason !== null) {
    return googleReason;
  }
  for (const candidate of [
    (error as { code?: unknown }).code,
    (error as { type?: unknown }).type,
  ]) {
    if (
      typeof candidate === "string" &&
      SAFE_UPSTREAM_REASONS.has(candidate)
    ) {
      return candidate;
    }
  }
  return `http_${status}`;
}

function parseToolArguments(name: string, raw: string): unknown {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ModelToolArgumentsError(name);
  }
}

export function normalizeUsage(input: {
  inputTokens?: unknown;
  cachedTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
}): ModelUsage | null {
  const inputTokens = finiteNonNeg(input.inputTokens);
  const rawCached = finiteNonNeg(input.cachedTokens);
  const outputTokens = finiteNonNeg(input.outputTokens);
  const cacheCreationTokens = finiteNonNeg(input.cacheCreationTokens);
  if (
    inputTokens === undefined &&
    rawCached === undefined &&
    outputTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return null;
  }
  const cachedTokens =
    rawCached !== undefined && inputTokens !== undefined
      ? Math.min(rawCached, inputTokens)
      : rawCached;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
  };
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readUsage(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      }
    | undefined,
): ModelUsage | null {
  if (!usage) {
    return null;
  }
  return normalizeUsage({
    inputTokens: usage.input_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens,
    outputTokens: usage.output_tokens,
  });
}

interface SsePayload {
  event: string | undefined;
  data: string;
}

interface SseState {
  done: boolean;
}

async function* readSse(
  response: Response,
  state?: SseState,
  options: { idleTimeoutMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<SsePayload> {
  const body = response.body;
  if (!body) {
    throw new ModelRequestFailedError("模型响应缺少流正文");
  }
  // options.signal 已同时传给 fetch；外部取消会让 body reader 以 AbortError 结束，
  // 这里只需负责“相邻数据块之间的空闲超时”。
  const idleTimeoutMs = options.idleTimeoutMs;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let idleTimedOut = false;
      let done = false;
      let value: Uint8Array | undefined;
      try {
        const read = reader.read();
        if (idleTimeoutMs === undefined) {
          ({ done, value } = await read);
        } else {
          ({ done, value } = await Promise.race([
            read,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                idleTimedOut = true;
                const timeoutError = new ModelRequestTimeoutError(idleTimeoutMs);
                reject(timeoutError);
                // 先拒绝 race 再取消底层流，避免 reader.cancel() 先把 pending read 结算为 done: true。
                void reader.cancel(timeoutError).catch(() => undefined);
              }, idleTimeoutMs);
              timer.unref?.();
            }),
          ]));
        }
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
      if (idleTimedOut && idleTimeoutMs !== undefined) {
        throw new ModelRequestTimeoutError(idleTimeoutMs);
      }
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        if (line.length === 0) {
          eventName = undefined;
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            if (state) {
              state.done = true;
            }
            return;
          }
          if (data.length > 0) {
            yield { event: eventName, data };
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const data = tail.slice(5).trim();
      if (data === "[DONE]") {
        if (state) {
          state.done = true;
        }
      } else if (data.length > 0) {
        yield { event: eventName, data };
      }
    }
  } catch (error) {
    if (error instanceof ModelRequestTimeoutError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new ModelRequestFailedError("模型流中断", {
      reason: error instanceof Error ? error.name : "STREAM_ERROR",
    });
  } finally {
    reader.releaseLock();
  }
}

function parseStreamJson(data: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ModelRequestFailedError("模型流响应不是有效 JSON");
  }
}
