import { ModelRequestFailedError } from "../domain/errors.js";
import type { ModelEvent, ModelRequest, ModelUsage } from "../domain/model.js";
import { endpoint, serializeModelRequest } from "./protocol-serializers.js";
import {
  isRecord,
  normalizeUsage,
  parseStreamJson,
  parseToolArguments,
  RawResponseCollector,
  readSse,
} from "./sse-reader.js";
import type { StreamTransportContext } from "./stream-transport.js";

export async function* streamAnthropic(
  request: ModelRequest,
  context: StreamTransportContext,
): AsyncGenerator<ModelEvent> {
  const response = await context.request(
    endpoint(context.config.baseUrl, "/messages"),
    {
      method: "POST",
      headers: context.baseHeaders("text/event-stream"),
      body: serializeModelRequest("anthropic-messages", context.config.baseUrl, request, context.config.provider),
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
    { callId: string; name: string; arguments: string; initial: unknown }
  >();
  const rawResponse = new RawResponseCollector(context.maxRawResponseBytes);
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
      idleTimeoutMs: context.streamIdleTimeoutMs,
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
            protocol: context.config.protocol,
            ...(context.config.provider === undefined ? {} : { provider: context.config.provider }),
            modelName: request.modelName,
            baseUrl: context.config.baseUrl,
            items: [...contentBlocks.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, block]) => block),
          },
        }),
  };
}
