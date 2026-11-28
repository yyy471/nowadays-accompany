import { ModelRequestFailedError } from "../domain/errors.js";
import type { ModelEvent, ModelRequest, ModelUsage } from "../domain/model.js";
import { endpoint, serializeModelRequest } from "./protocol-serializers.js";
import {
  isRecord,
  parseStreamJson,
  parseToolArguments,
  RawResponseCollector,
  readSse,
  readUsage,
} from "./sse-reader.js";
import type { StreamTransportContext } from "./stream-transport.js";

export async function* streamOpenAiResponses(
  request: ModelRequest,
  context: StreamTransportContext,
): AsyncGenerator<ModelEvent> {
  const response = await context.request(
    endpoint(context.config.baseUrl, "/responses"),
    {
      method: "POST",
      headers: context.baseHeaders("text/event-stream"),
      body: serializeModelRequest("openai-responses", context.config.baseUrl, request, context.config.provider),
      ...(request.signal ? { signal: request.signal } : {}),
    },
    {
      timeoutMs: context.streamHeaderTimeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    },
  );
  request.onAccepted?.();
  const toolBuffers = new Map<
    string,
    { callId: string; name: string; arguments: string }
  >();
  const rawResponse = new RawResponseCollector(context.maxRawResponseBytes);
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
      idleTimeoutMs: context.streamIdleTimeoutMs,
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
            protocol: context.config.protocol,
            ...(context.config.provider === undefined ? {} : { provider: context.config.provider }),
            modelName: request.modelName,
            baseUrl: context.config.baseUrl,
            items: outputItems ?? [...finishedItems.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, item]) => item),
          },
        }),
  };
}
