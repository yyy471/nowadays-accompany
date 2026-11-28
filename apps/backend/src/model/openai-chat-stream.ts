import { createHash, randomUUID } from "node:crypto";
import {
  ModelRequestFailedError,
  ModelToolArgumentsError,
} from "../domain/errors.js";
import type { ModelEvent, ModelRequest, ModelUsage } from "../domain/model.js";
import { ChatReasoning } from "./chat-reasoning.js";
import { endpoint, serializeModelRequest } from "./protocol-serializers.js";
import {
  isRecord,
  normalizeUsage,
  parseStreamJson,
  parseToolArguments,
  RawResponseCollector,
  readSse,
  type SseState,
} from "./sse-reader.js";
import type { StreamTransportContext } from "./stream-transport.js";

export async function* streamOpenAiChat(
  request: ModelRequest,
  context: StreamTransportContext,
): AsyncGenerator<ModelEvent> {
  const { provider, baseUrl } = context.config;
  const headers = context.baseHeaders("text/event-stream");
  if (provider === "opencode-go") {
    const session = createHash("sha256").update(request.sessionId ?? randomUUID()).digest("hex");
    headers["x-opencode-session"] = `ses_${session.slice(0, 32)}`;
  }
  const response = await context.request(
    endpoint(baseUrl, provider === "opencode-go" ? "/openai/v1/chat/completions" : "/chat/completions"),
    {
      method: "POST",
      headers,
      body: serializeModelRequest("openai-chat", baseUrl, request, provider),
      ...(request.signal ? { signal: request.signal } : {}),
    },
    {
      timeoutMs: context.streamHeaderTimeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    },
  );
  request.onAccepted?.();
  const toolBuffers = new Map<
    number,
    { callId: string; name: string; arguments: string }
  >();
  const rawResponse = new RawResponseCollector(context.maxRawResponseBytes);
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
      idleTimeoutMs: context.streamIdleTimeoutMs,
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
