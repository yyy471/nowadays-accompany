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

const TURN_CONTEXT_HEADER = "[系统本轮上下文（非用户发言）]";

/**
 * 计算本轮可变宿主上下文在消息序列中的安全插入位置（DL-202）：
 * - 优先放在本轮第一条 currentUserRequest 之前，确保已提交历史前缀 100% 不变；
 * - 若无 currentUserRequest（如自主活动），放在第一组活跃工具调用之前或消息尾部；
 * - 绝不插在 assistant(toolCalls) 与紧随其后的 tool 结果之间。
 */
export function findTurnContextInsertIndex(
  messages: readonly ModelMessage[],
): number {
  const firstCurrent = messages.findIndex(
    (message) => message.role === "user" && message.source?.currentUserRequest === true,
  );
  if (firstCurrent >= 0) return firstCurrent;
  const firstActiveTool = messages.findIndex(
    (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
  );
  return firstActiveTool >= 0 ? firstActiveTool : messages.length;
}

/** 与生成请求共用同一序列化路径，覆盖协议开销、显式缓存断点、本轮可变上下文和合法续轮块。 */
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
  const turnContext = request.turnContext?.trim() ?? "";
  const turnInsertAt = turnContext.length > 0 ? findTurnContextInsertIndex(messages) : -1;
  const needsSpeakerLabels = protocol === "openai-chat" && requiresChatReasoning &&
    messages.some(message => message.role === "assistant" && !message.toolCalls?.length &&
      !continuationItems(message, protocol, request.modelName, baseUrl, provider)?.[0]);
  switch (protocol) {
    case "openai-chat": {
      const wireMessages: unknown[] = [{ role: "system", content: request.system }];
      const turnChatMessage =
        turnContext.length === 0
          ? null
          : provider === "deepseek" || provider === "mimo" || provider === "zai"
            ? { role: "user", content: `${TURN_CONTEXT_HEADER}\n${turnContext}` }
            : { role: "system", content: turnContext };
      messages.forEach((message, index) => {
        if (turnChatMessage !== null && index === turnInsertAt) {
          wireMessages.push(turnChatMessage);
        }
        wireMessages.push(
          toOpenAiChatMessage(message, request.modelName, baseUrl, provider, requiresChatReasoning, needsSpeakerLabels),
        );
      });
      if (turnChatMessage !== null && turnInsertAt >= messages.length) {
        wireMessages.push(turnChatMessage);
      }
      return JSON.stringify({
        model: request.modelName,
        messages: wireMessages,
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
    }
    case "openai-responses": {
      const wireInput: unknown[] = [];
      const turnResponsesItem =
        turnContext.length === 0
          ? null
          : {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: turnContext }],
            };
      messages.forEach((message, index) => {
        if (turnResponsesItem !== null && index === turnInsertAt) {
          wireInput.push(turnResponsesItem);
        }
        wireInput.push(...toOpenAiResponsesInput(message, request.modelName, baseUrl, provider));
      });
      if (turnResponsesItem !== null && turnInsertAt >= messages.length) {
        wireInput.push(turnResponsesItem);
      }
      return JSON.stringify({
        model: request.modelName,
        instructions: request.system,
        input: wireInput,
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
    }
    case "anthropic-messages": {
      const promptCaching = request.promptCaching === true;
      const systemField =
        request.systemBlocks && request.systemBlocks.length > 0
          ? request.systemBlocks.map((block) => ({
              type: "text",
              text: block.text,
              ...(promptCaching && block.cacheControl
                ? { cache_control: { type: block.cacheControl } }
                : {}),
            }))
          : request.system;
      const toolsField =
        request.tools.length === 0
          ? undefined
          : request.tools.map((tool, index) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
              ...(promptCaching && index === request.tools.length - 1
                ? { cache_control: { type: "ephemeral" } }
                : {}),
            }));
      return JSON.stringify({
        model: request.modelName,
        system: systemField,
        messages: toAnthropicMessages(
          messages,
          request.modelName,
          baseUrl,
          provider,
          turnContext,
          turnInsertAt,
          promptCaching,
        ),
        ...(toolsField === undefined ? {} : { tools: toolsField }),
        max_tokens: request.maxOutputTokens ?? 1024,
        stream: true,
      });
    }
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

function attachAnthropicCacheControl(
  items: Array<{ role: "user" | "assistant"; content: unknown[] }>,
): void {
  const lastItem = items.at(-1);
  if (!lastItem || lastItem.content.length === 0) return;
  for (let i = lastItem.content.length - 1; i >= 0; i -= 1) {
    const block = lastItem.content[i];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      const record = block as Record<string, unknown>;
      // thinking 块不可附加 cache_control；向前回退到可缓存内容块。
      if (record.type === "thinking" || record.type === "redacted_thinking") continue;
      lastItem.content[i] = { ...record, cache_control: { type: "ephemeral" } };
      return;
    }
  }
}

function toAnthropicMessages(
  messages: readonly ModelMessage[],
  modelName: string,
  baseUrl: string,
  provider?: ModelProvider,
  turnContext = "",
  turnInsertAt = -1,
  promptCaching = false,
): unknown[] {
  const items: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  const turnBlock =
    turnContext.length > 0
      ? { type: "text", text: `${TURN_CONTEXT_HEADER}\n${turnContext}` }
      : null;
  // 自主触发可以没有用户消息。协议需要一项输入，由应用表明触发来源。
  if (messages.length === 0) {
    return [{
      role: "user",
      content: [
        ...(turnBlock ? [turnBlock] : []),
        { type: "text", text: APPLICATION_TRIGGER_INPUT },
      ],
    }];
  }
  let lastWasToolResult = false;
  let pendingTurnBlock: Record<string, unknown> | null = null;
  let historyCacheMarked = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (turnBlock !== null && index === turnInsertAt) {
      // 已提交历史正好在此结束：在历史尾部落第 4 个缓存断点，确保不把本轮动态内容卷入历史缓存。
      if (promptCaching && !historyCacheMarked && items.length > 0) {
        attachAnthropicCacheControl(items);
        historyCacheMarked = true;
      }
      pendingTurnBlock = turnBlock;
    }
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
      if (pendingTurnBlock !== null) {
        if (items.at(-1)?.role === "user") {
          items.at(-1)!.content.push(pendingTurnBlock);
        } else {
          items.push({ role: "user", content: [pendingTurnBlock] });
        }
        pendingTurnBlock = null;
      }
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
    const userContent: unknown[] = [
      ...(pendingTurnBlock ? [pendingTurnBlock] : []),
      ...(message.images?.map((image) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.dataBase64,
        },
      })) ?? []),
      { type: "text", text: message.content },
    ];
    pendingTurnBlock = null;
    items.push({
      role: "user",
      content: userContent,
    });
  }
  if (turnBlock !== null && turnInsertAt >= messages.length) {
    if (promptCaching && !historyCacheMarked && items.length > 0) {
      attachAnthropicCacheControl(items);
    }
    if (items.at(-1)?.role === "user") {
      items.at(-1)!.content.push(turnBlock);
    } else {
      items.push({ role: "user", content: [turnBlock] });
    }
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
