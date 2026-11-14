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
} from "../domain/model.js";
import {
  listGoogleModels,
  mapGoogleErrorReason,
  streamGoogleGemini,
  type GoogleGeminiTransport,
  type GoogleOAuthTokenCache,
} from "./google-gemini.js";

const DEFAULT_LIST_TIMEOUT_MS = 20_000;

export interface HttpModelAdapterOptions {
  /** 列表等短请求的等待上限；流式请求沿用调用方提供的信号。 */
  listTimeoutMs?: number;
}

export class HttpModelAdapter implements ModelPort {
  private readonly listTimeoutMs: number;
  private readonly googleTokenCache: { current: GoogleOAuthTokenCache | undefined } = {
    current: undefined,
  };

  constructor(
    private readonly config: ModelServiceConfig,
    private readonly credential: string | undefined,
    options: HttpModelAdapterOptions = {},
  ) {
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.config.protocol === "google-gemini") {
      return listGoogleModels({
        baseUrl: this.config.baseUrl,
        credential: this.credential,
        cacheRef: this.googleTokenCache,
        transport: this.googleTransport(),
        timeoutMs: this.listTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    const headers = this.baseHeaders("application/json");
    const response = await this.request(
      endpoint(this.config.baseUrl, "/models"),
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
    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new ModelListIncompatibleError("DATA_NOT_ARRAY");
    }
    const models = data
      .map((item) =>
        item !== null && typeof item === "object"
          ? (item as { id?: unknown }).id
          : undefined,
      )
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (models.length !== data.length) {
      // 有条目但取不到 id 时按格式不兼容处理，不静默丢弃半个列表。
      throw new ModelListIncompatibleError("ITEMS_WITHOUT_ID");
    }
    return models;
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
        credential: this.credential,
        cacheRef: this.googleTokenCache,
        request,
        transport: this.googleTransport(),
      });
    }
    return this.streamAnthropic(request);
  }

  private googleTransport(): GoogleGeminiTransport {
    return {
      request: (url, init, options) => this.request(url, init, options),
      readSse: (response) => readSse(response),
      parseStreamJson,
      continuationItems,
    };
  }

  private async *streamOpenAiChat(
    request: ModelRequest,
  ): AsyncGenerator<ModelEvent> {
    const response = await this.request(
      endpoint(this.config.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: this.baseHeaders("text/event-stream"),
        body: JSON.stringify({
          model: request.modelName,
          messages: [
            { role: "system", content: request.system },
            ...request.messages.map(toOpenAiChatMessage),
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
          stream_options: { include_usage: true },
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    const toolBuffers = new Map<
      number,
      { callId: string; name: string; arguments: string }
    >();
    const rawResponse: unknown[] = [];
    let finishReason: string | null = null;
    let usage: { inputTokens?: number; outputTokens?: number } | null = null;
    const sseState: SseState = { done: false };
    for await (const payload of readSse(response, sseState)) {
      const data = parseStreamJson(payload.data);
      rawResponse.push(data);
      const choices = data.choices as
        | Array<{
            delta?: {
              content?: unknown;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>
        | undefined;
      const choice = choices?.[0];
      const content = choice?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        yield { type: "text_delta", text: content };
      }
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? toolBuffers.size;
        const existing = toolBuffers.get(index) ?? {
          callId: "",
          name: "",
          arguments: "",
        };
        existing.callId = call.id ?? existing.callId;
        existing.name = call.function?.name ?? existing.name;
        existing.arguments += call.function?.arguments ?? "";
        toolBuffers.set(index, existing);
      }
      if (typeof choice?.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      const usageValue = data.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;
      if (usageValue) {
        usage = {
          ...(typeof usageValue.prompt_tokens === "number"
            ? { inputTokens: usageValue.prompt_tokens }
            : {}),
          ...(typeof usageValue.completion_tokens === "number"
            ? { outputTokens: usageValue.completion_tokens }
            : {}),
        };
      }
    }
    if (finishReason === null || !sseState.done) {
      throw new ModelRequestFailedError("模型流提前结束，未收到完整终态", {
        reason: "STREAM_TRUNCATED",
      });
    }
    for (const [index, call] of [...toolBuffers.entries()].sort(
      (left, right) => left[0] - right[0],
    )) {
      yield {
        type: "tool_call",
        callId: call.callId || `tool-${index}`,
        name: call.name,
        arguments: parseToolArguments(call.name, call.arguments),
      };
    }
    if (usage) {
      yield { type: "usage", ...usage };
    }
    const incomplete =
      finishReason === "length" || finishReason === "content_filter";
    yield {
      type: "completed",
      stopReason: finishReason,
      ...(incomplete ? { incomplete: true } : {}),
      rawResponse: rawResponse.length === 0 ? undefined : rawResponse,
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
        body: JSON.stringify({
          model: request.modelName,
          instructions: request.system,
          input: request.messages.flatMap((message) =>
            toOpenAiResponsesInput(message, request.modelName, this.config.baseUrl),
          ),
          include: ["reasoning.encrypted_content"],
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
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    const toolBuffers = new Map<
      string,
      { callId: string; name: string; arguments: string }
    >();
    const rawResponse: unknown[] = [];
    let usage: { inputTokens?: number; outputTokens?: number } | null = null;
    let terminal:
      | {
          type: "completed" | "incomplete";
          status?: string;
          stopReason?: string;
        }
      | null = null;
    let outputItems: Record<string, unknown>[] | undefined;
    const finishedItems = new Map<number, Record<string, unknown>>();
    for await (const payload of readSse(response)) {
      const data = parseStreamJson(payload.data);
      rawResponse.push(data);
      const type = data.type as string | undefined;
      if (type === "response.output_text.delta") {
        if (typeof data.delta === "string") {
          yield { type: "text_delta", text: data.delta };
        }
        continue;
      }
      if (type === "response.output_item.done" && isRecord(data.item)) {
        const index = typeof data.output_index === "number" ? data.output_index : finishedItems.size;
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
              usage?: { input_tokens?: number; output_tokens?: number };
              output?: unknown[];
            }
          | undefined;
        if (body?.status === "failed" || body?.status === "cancelled") {
          throw new ModelRequestFailedError("模型请求失败", {
            reason: "RESPONSE_FAILED",
          });
        }
        usage = readUsage(body?.usage);
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
    for (const call of toolBuffers.values()) {
      yield {
        type: "tool_call",
        callId: call.callId,
        name: call.name,
        arguments: parseToolArguments(call.name, call.arguments),
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
      rawResponse: rawResponse.length === 0 ? undefined : rawResponse,
      ...((outputItems ?? [...finishedItems.values()]).length === 0
        ? {}
        : {
            continuation: {
              protocol: this.config.protocol,
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
        body: JSON.stringify({
          model: request.modelName,
          system: request.system,
          messages: toAnthropicMessages(request.messages, request.modelName, this.config.baseUrl),
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
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    const toolBuffers = new Map<
      number,
      { callId: string; name: string; arguments: string; initial: unknown }
    >();
    const rawResponse: unknown[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | null = null;
    let sawMessageStop = false;
    const contentBlocks = new Map<number, Record<string, unknown>>();
    for await (const payload of readSse(response)) {
      const data = parseStreamJson(payload.data);
      rawResponse.push(data);
      const type = data.type as string | undefined;
      if (type === "message_start") {
        const usage = (data.message as { usage?: { input_tokens?: number } })
          ?.usage;
        inputTokens = usage?.input_tokens;
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
        const usage = data.usage as
          | { output_tokens?: number }
          | undefined;
        if (typeof delta?.stop_reason === "string") {
          stopReason = delta.stop_reason;
        }
        if (typeof usage?.output_tokens === "number") {
          outputTokens = usage.output_tokens;
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
    for (const [index, call] of [...toolBuffers.entries()].sort(
      (left, right) => left[0] - right[0],
    )) {
      const parsed =
        call.arguments.trim().length > 0
          ? parseToolArguments(call.name, call.arguments)
          : (call.initial ?? {});
      const block = contentBlocks.get(index);
      if (block) block.input = parsed;
      yield {
        type: "tool_call",
        callId: call.callId,
        name: call.name,
        arguments: parsed,
      };
    }
    if (inputTokens !== undefined || outputTokens !== undefined) {
      yield {
        type: "usage",
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      };
    }
    const incomplete =
      stopReason === "max_tokens" || stopReason === "pause_turn";
    yield {
      type: "completed",
      stopReason,
      ...(incomplete ? { incomplete: true } : {}),
      rawResponse: rawResponse.length === 0 ? undefined : rawResponse,
      ...(contentBlocks.size === 0
        ? {}
        : {
            continuation: {
              protocol: this.config.protocol,
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
    if (this.credential !== undefined) {
      if (this.config.protocol === "anthropic-messages") {
        headers["x-api-key"] = this.credential;
        headers["anthropic-version"] = "2023-06-01";
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
    const timeout =
      options.timeoutMs === undefined
        ? null
        : AbortSignal.timeout(options.timeoutMs);
    const signals = [init.signal, options.signal, timeout].filter(
      (signal): signal is AbortSignal => signal !== null && signal !== undefined,
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
      if (timeout?.aborted === true) {
        throw new ModelRequestTimeoutError(options.timeoutMs ?? 0);
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
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ModelRedirectBlockedError(response.status);
    }
    if (!response.ok) {
      const body = await response.text();
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

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function toOpenAiChatMessage(message: ModelMessage): unknown {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    const calls = message.toolCalls ?? [];
    return {
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
  if (!message.images?.length) {
    return { role: "user", content: message.content };
  }
  return {
    role: "user",
    content: [
      { type: "text", text: message.content },
      ...message.images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` },
      })),
    ],
  };
}

function toOpenAiResponsesInput(message: ModelMessage, modelName: string, baseUrl: string): unknown[] {
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
    const replay = continuationItems(message, "openai-responses", modelName, baseUrl);
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

function toAnthropicMessages(messages: readonly ModelMessage[], modelName: string, baseUrl: string): unknown[] {
  const items: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
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
      const replay = continuationItems(message, "anthropic-messages", modelName, baseUrl);
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

function continuationItems(
  message: Extract<ModelMessage, { role: "assistant" }>,
  protocol: ModelServiceConfig["protocol"],
  modelName: string,
  baseUrl: string,
): Record<string, unknown>[] | null {
  const continuation = message.continuation;
  // 配置变化时不向另一协议／服务／模型发送原服务的加密或签名块。
  if (continuation?.protocol !== protocol || continuation.modelName !== modelName || continuation.baseUrl !== baseUrl) return null;
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

function readUsage(
  usage:
    | { input_tokens?: number; output_tokens?: number }
    | undefined,
): { inputTokens?: number; outputTokens?: number } | null {
  if (!usage) {
    return null;
  }
  return {
    ...(typeof usage.input_tokens === "number"
      ? { inputTokens: usage.input_tokens }
      : {}),
    ...(typeof usage.output_tokens === "number"
      ? { outputTokens: usage.output_tokens }
      : {}),
  };
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
): AsyncGenerator<SsePayload> {
  const body = response.body;
  if (!body) {
    throw new ModelRequestFailedError("模型响应缺少流正文");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
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
