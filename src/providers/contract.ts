import type { Logger } from '../core/logger.js';
import type { CapabilityId } from '../policy/capabilities.js';
import type { CancelMode, ProviderConfig, ProviderModelConfig } from './types.js';

export interface ProviderMedia {
  mediaId: string;
  accountId: string;
  mimeType: string;
  bytes: number;
  kind: 'image' | 'video';
  data: Buffer;
}

export interface ProviderCallContext {
  provider: ProviderConfig;
  model: ProviderModelConfig;
  credential?: string;
  signal: AbortSignal;
  logger: Logger;
  /** 单次调用的总超时；适配器内部轮询不能超过它。 */
  requestTimeoutMs: number;
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; media: ProviderMedia }
  | { type: 'video'; media: ProviderMedia };

export interface ChatInputMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContentPart[];
  name?: string;
  toolCallId?: string;
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  id?: string;
  name: string;
  /** 解析后的 JSON；解析失败时保留原始字符串由上层明确拒绝。 */
  arguments: unknown;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatRequest {
  messages: ChatInputMessage[];
  tools?: ChatToolDefinition[];
  parameters?: Record<string, unknown>;
}

export interface ChatResponse {
  text?: string;
  toolCalls?: ChatToolCall[];
  usage?: ChatUsage;
  finishReason?: string;
}

export interface ImageObservation {
  text: string;
  /** 明确说明看的是哪一张/哪些区域，避免把局部观察说成完整理解。 */
  coverage?: string;
  usage?: ChatUsage;
}

export interface VideoObservationSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface VideoObservation {
  summary: string;
  segments?: VideoObservationSegment[];
  coverage?: string;
  usage?: ChatUsage;
}

export interface GeneratedImage {
  mimeType?: string;
  data?: Buffer;
  base64?: string;
  url?: string;
  assetId?: string;
  width?: number;
  height?: number;
}

export interface ImageGenerationRequest {
  prompt: string;
  count?: number;
  size?: string;
  parameters?: Record<string, unknown>;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  usage?: ChatUsage;
  /** 远端提交结果未知时由适配器报告；调用方不得自动重复付费提交。 */
  remoteRequestId?: string;
}

export interface AudioGenerationRequest {
  text: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac';
  parameters?: Record<string, unknown>;
}

export interface AudioGenerationResult {
  mimeType: string;
  data: Buffer;
  usage?: ChatUsage;
  remoteRequestId?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  detail?: string;
  /** Short-lived, bounded sample returned only for the current test response. */
  sample?: { kind: 'image' | 'audio'; mimeType: string; base64: string };
  capability?: CapabilityId;
  providerId?: string;
  modelId?: string;
  durationMs?: number;
}

export interface ProviderAdapter {
  readonly id: string;
  supports(capability: CapabilityId): boolean;
  cancelMode(capability: CapabilityId): CancelMode;
  chat?(context: ProviderCallContext, request: ChatRequest): Promise<ChatResponse>;
  imageUnderstand?(
    context: ProviderCallContext,
    media: ProviderMedia,
    prompt: string,
    parameters?: Record<string, unknown>
  ): Promise<ImageObservation>;
  videoUnderstand?(
    context: ProviderCallContext,
    media: ProviderMedia,
    prompt: string,
    parameters?: Record<string, unknown>,
    onProgress?: (state: 'submitted' | 'waiting_remote') => void
  ): Promise<VideoObservation>;
  imageGenerate?(
    context: ProviderCallContext,
    request: ImageGenerationRequest
  ): Promise<ImageGenerationResult>;
  audioGenerate?(
    context: ProviderCallContext,
    request: AudioGenerationRequest
  ): Promise<AudioGenerationResult>;
  /** 仅用于适配器返回 assetId 时，按声明的方式获取资产。 */
  fetchAsset?(context: ProviderCallContext, assetId: string): Promise<{ mimeType: string; data: Buffer }>;
  test?(
    context: ProviderCallContext,
    capability: CapabilityId,
    confirmCost: boolean
  ): Promise<ProviderTestResult>;
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}
