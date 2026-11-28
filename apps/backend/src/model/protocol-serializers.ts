import {
  APPLICATION_TRIGGER_INPUT,
  type ModelMessage,
  type ModelRequest,
  type ModelServiceConfig,
} from "../domain/model.js";
import { isVertexPublisherBaseUrl, type ModelProvider } from "../domain/model-providers.js";
import { buildGeminiGenerateBody } from "./google-gemini.js";

export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
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
