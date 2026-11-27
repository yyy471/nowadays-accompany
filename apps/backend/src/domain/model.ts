import { z } from "zod";
import type { ModelProvider } from "./model-providers.js";
import {
  modelBaseConfigSchema,
  modelProtocolSchema,
  type ModelProtocol,
} from "./resource.js";

export { modelProtocolSchema, type ModelProtocol };

/** 仅用于要求至少一条输入的厂商协议，不写入窗口消息或记忆证据。 */
export const APPLICATION_TRIGGER_INPUT = "〔应用触发，无用户新发言〕请按本次系统指令处理。";

export const modelServiceConfigSchema = modelBaseConfigSchema;
export type ModelServiceConfig = z.infer<typeof modelServiceConfigSchema>;

/**
 * 候选配置探测：可以带一次性密钥，只用于本次列表或测试，不落库。
 * 已保存服务走按 resourceId 的接口，密钥从统一凭据解析读取。
 */
export const modelServiceProbeSchema = modelBaseConfigSchema.safeExtend({
  secret: z.string().min(1).max(4000).optional(),
  /**
   * 复用已保存服务的密钥：以资源为基准解析，仅当协议与 origin 一致时允许
   * （同站点改路径可复用；换协议、主机或端口需另填密钥）。
   */
  resourceId: z.string().min(1).max(100).optional(),
});
export type ModelServiceProbe = z.infer<typeof modelServiceProbeSchema>;

export const modelServiceTestSchema = modelServiceProbeSchema
  .safeExtend({
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
  provider?: ModelProvider;
  /** 角色图写入实际调用的资源编号，供后续轮次核对同地址下的不同账户。 */
  resourceId?: string;
  modelName: string;
  baseUrl: string;
  items: Record<string, unknown>[];
}

/** 随用户消息附带的底座图片载荷；供对话模型生成生图锚点提示词等多模态调用使用。 */
export interface ModelImageAttachment {
  mediaType: string;
  dataBase64: string;
}

export interface ModelMessageSource {
  /** 本条实际包含的记忆，供出站确认记账，不进入厂商协议。 */
  memoryReads?: MemoryDelivery[];
  messageId?: string;
  /** 原消息发送时间。跨日时用于本次出站投影，原文及回查引用保持独立。 */
  sentAt?: string;
  toolCallId?: string;
  internalStepKey?: string;
  evidenceId?: string;
  scope?: "window" | "task";
  /** 历史事实以文本送出，只有当前合法调用组才发厂商工具结果。 */
  historical?: boolean;
  /** 同一原任务在续行中收取刚结算的后台网页结果。 */
  webPrefetch?: boolean;
  summary?: boolean;
  currentUserRequest?: boolean;
}

export interface MemoryDelivery {
  type: "event" | "daily_summary" | "diary";
  id: string;
  retrievalId?: string;
}

export type ModelMessage = { source?: ModelMessageSource } & (
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
    });

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  modelName: string;
  resourceId?: string;
  /** 一段对话的稳定标识，仅供要求会话请求头的网关使用。 */
  sessionId?: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** 生成请求被提供方接收。可流式离线适配器也可显式通知。 */
  onAccepted?: () => void;
}

export interface ModelUsage {
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      arguments: unknown;
    }
  | ({
      type: "usage";
    } & ModelUsage)
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
  source?: "preset";
}

export interface ModelTestResult {
  vertexRegion?: string;
  ok: boolean;
  elapsedMs: number;
  /** 本次测试对应的配置与凭据版本；与当前配置不一致即视为过期。 */
  fingerprint: string;
  /** 本次测试落库的记录标识；草稿测试后直接保存服务时用于安全关联（308 §4.5）。 */
  testCallId?: string;
  error?: { code: string; message: string };
}
