import { z } from "zod";
import {
  modelBaseConfigSchema,
  modelProtocolSchema,
  type ModelProtocol,
} from "./resource.js";

export { modelProtocolSchema, type ModelProtocol };

export const modelServiceConfigSchema = modelBaseConfigSchema;
export type ModelServiceConfig = z.infer<typeof modelServiceConfigSchema>;

/**
 * 候选配置探测：可以带一次性密钥，只用于本次列表或测试，不落库。
 * 已保存服务走按 resourceId 的接口，密钥从统一凭据解析读取。
 */
export const modelServiceProbeSchema = modelBaseConfigSchema.extend({
  secret: z.string().min(1).max(4000).optional(),
  /**
   * 复用已保存服务的密钥：以资源为基准解析，仅当协议与 origin 一致时允许
   * （同站点改路径可复用；换协议、主机或端口需另填密钥）。
   */
  resourceId: z.string().min(1).max(100).optional(),
});
export type ModelServiceProbe = z.infer<typeof modelServiceProbeSchema>;

export const modelServiceTestSchema = modelServiceProbeSchema
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

/** 随用户消息附带的底座图片载荷；供对话模型生成生图锚点提示词等多模态调用使用。 */
export interface ModelImageAttachment {
  mediaType: string;
  dataBase64: string;
}

export type ModelMessage =
  | {
      role: "user";
      content: string;
      images?: readonly ModelImageAttachment[];
    }
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
  /** 本次测试对应的配置与凭据版本；与当前配置不一致即视为过期。 */
  fingerprint: string;
  error?: { code: string; message: string };
}
