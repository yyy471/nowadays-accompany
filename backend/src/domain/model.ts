import { z } from "zod";

export const modelProtocolSchema = z.enum([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
]);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;

export const modelServiceConfigSchema = z
  .object({
    protocol: modelProtocolSchema,
    baseUrl: z.string().url().max(2000),
    credentialRef: z
      .string()
      .trim()
      .regex(/^(env|file):[^\s]+$/, "凭据只允许 env: 或 file: 引用")
      .max(500)
      .optional(),
    /** 可核实的模型容量声明（字符口径），供记忆整理按容量分批。 */
    maxInputChars: z.number().int().positive().max(10_000_000).optional(),
    maxOutputChars: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();
export type ModelServiceConfig = z.infer<typeof modelServiceConfigSchema>;

export const modelServiceTestSchema = modelServiceConfigSchema
  .extend({
    model: z.string().trim().min(1).max(300),
  })
  .strict();
export type ModelServiceTest = z.infer<typeof modelServiceTestSchema>;

export interface ModelToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

// 适配层的可序列化续轮材料；业务层保存和回传，不解释厂商内容块。
export interface ModelContinuation {
  protocol: ModelProtocol;
  modelName: string;
  baseUrl: string;
  items: Record<string, unknown>[];
}

export type ModelMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ModelToolCall[];
      continuation?: ModelContinuation;
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName?: string;
      content: string;
    };

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  modelName: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: "completed";
      stopReason: string;
      incomplete?: boolean;
      rawResponse?: unknown;
      continuation?: ModelContinuation;
    };

export interface ModelPort {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

const INCOMPLETE_STOP_REASONS = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "incomplete",
  "response.incomplete",
]);

export function isIncompleteCompletion(event: {
  stopReason: string;
  incomplete?: boolean;
}): boolean {
  return (
    event.incomplete === true ||
    INCOMPLETE_STOP_REASONS.has(event.stopReason.toLowerCase())
  );
}

export interface ModelListResult {
  models: string[];
}

export interface ModelTestResult {
  ok: boolean;
  elapsedMs: number;
  error?: { code: string; message: string };
}
