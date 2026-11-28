import {
  ModelListIncompatibleError,
  ModelRedirectBlockedError,
  ModelRequestFailedError,
  ModelRequestTimeoutError,
} from "../domain/errors.js";
import type {
  ModelEvent,
  ModelPort,
  ModelRequest,
  ModelServiceConfig,
} from "../domain/model.js";
import { streamAnthropic } from "./anthropic-stream.js";
import {
  listGoogleModels,
  mapGoogleErrorReason,
  streamGoogleGemini,
  vertexGlobalProbeBase,
  VertexEndpointNotFound,
  type GoogleGeminiTransport,
  type GoogleOAuthTokenCache,
} from "./google-gemini.js";
import { streamOpenAiChat } from "./openai-chat-stream.js";
import { streamOpenAiResponses } from "./openai-responses-stream.js";
import {
  continuationItems,
  endpoint,
  serializeModelRequest,
} from "./protocol-serializers.js";
import {
  DEFAULT_MAX_RAW_RESPONSE_BYTES,
  isRecord,
  normalizeUsage,
  parseStreamJson,
  RawResponseCollector,
  readSse,
} from "./sse-reader.js";
import type { StreamTransportContext } from "./stream-transport.js";

export { serializeModelRequest, continuationItems };
export { DEFAULT_MAX_RAW_RESPONSE_BYTES, RawResponseCollector, normalizeUsage };

const DEFAULT_LIST_TIMEOUT_MS = 20_000;

/** 流式请求从建立连接到收到响应头的等待上限。 */
export const DEFAULT_STREAM_HEADER_TIMEOUT_MS = 90_000;
/** 流式请求相邻 SSE 数据块之间的空闲上限（不含已到达字节的读取时间）。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

export interface HttpModelAdapterOptions {
  /** 列表等短请求的等待上限；流式请求沿用调用方提供的信号。 */
  listTimeoutMs?: number;
  /** 流式请求等待响应头的上限。 */
  streamHeaderTimeoutMs?: number;
  /** 流式请求相邻数据块的空闲上限。 */
  streamIdleTimeoutMs?: number;
  /** 流式请求保留的原始响应字节上限。 */
  maxRawResponseBytes?: number;
  /** 仅测试使用：允许服务账号 token_uri 指向本地 mock OAuth 服务。 */
  allowCustomGoogleTokenUri?: boolean;
}

export class HttpModelAdapter implements ModelPort {
  private readonly listTimeoutMs: number;
  private readonly streamHeaderTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly maxRawResponseBytes: number;
  private readonly allowCustomGoogleTokenUri: boolean;
  private readonly googleTokenCache: { current: GoogleOAuthTokenCache | undefined } = {
    current: undefined,
  };

  constructor(
    private readonly config: ModelServiceConfig,
    private readonly credential: string | undefined,
    options: HttpModelAdapterOptions = {},
  ) {
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.streamHeaderTimeoutMs =
      options.streamHeaderTimeoutMs ?? DEFAULT_STREAM_HEADER_TIMEOUT_MS;
    this.streamIdleTimeoutMs =
      options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.maxRawResponseBytes =
      options.maxRawResponseBytes ?? DEFAULT_MAX_RAW_RESPONSE_BYTES;
    this.allowCustomGoogleTokenUri = options.allowCustomGoogleTokenUri ?? false;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.config.protocol === "google-gemini") {
      return listGoogleModels({
        baseUrl: this.config.baseUrl,
        credential: this.credential,
        cacheRef: this.googleTokenCache,
        transport: this.googleTransport(),
        timeoutMs: this.listTimeoutMs,
        headerTimeoutMs: this.streamHeaderTimeoutMs,
        maxRawResponseBytes: this.maxRawResponseBytes,
        allowCustomTokenUri: this.allowCustomGoogleTokenUri,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    const { provider } = this.config;
    const listPath = provider === "opencode-go" ? "/v1/models"
      : provider === "xai" ? "/language-models"
      : provider === "openrouter" && this.credential ? "/models/user" : "/models";
    const headers = this.baseHeaders("application/json");
    const response = await this.request(
      endpoint(this.config.baseUrl, listPath),
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
    const data = provider === "xai" ? (parsed as { models?: unknown }).models : (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new ModelListIncompatibleError(provider === "xai" ? "MODELS_NOT_ARRAY" : "DATA_NOT_ARRAY");
    }
    const models = new Set<string>();
    for (const item of data) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
        throw new ModelListIncompatibleError("ITEMS_WITHOUT_ID");
      }
      // MiMo 目录也含独立的语音识别与合成服务。
      if (provider === "mimo" && /-(asr|tts)(?:-|$)/i.test(item.id)) continue;
      models.add(item.id);
      if (provider === "xai" && Array.isArray(item.aliases)) {
        for (const alias of item.aliases) if (typeof alias === "string" && alias.trim()) models.add(alias);
      }
    }
    return [...models];
  }

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (this.config.protocol === "openai-chat") {
      return streamOpenAiChat(request, this.streamContext());
    }
    if (this.config.protocol === "openai-responses") {
      return streamOpenAiResponses(request, this.streamContext());
    }
    if (this.config.protocol === "google-gemini") {
      return streamGoogleGemini({
        baseUrl: this.config.baseUrl,
        ...(this.config.provider === undefined ? {} : { provider: this.config.provider }),
        credential: this.credential,
        cacheRef: this.googleTokenCache,
        request,
        transport: this.googleTransport(),
        serializedBody: serializeModelRequest("google-gemini", this.config.baseUrl, request, this.config.provider, this.config.vertexSafety),
        headerTimeoutMs: this.streamHeaderTimeoutMs,
        maxRawResponseBytes: this.maxRawResponseBytes,
        allowCustomTokenUri: this.allowCustomGoogleTokenUri,
      });
    }
    return streamAnthropic(request, this.streamContext());
  }

  private streamContext(): StreamTransportContext {
    return {
      config: this.config,
      streamHeaderTimeoutMs: this.streamHeaderTimeoutMs,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      maxRawResponseBytes: this.maxRawResponseBytes,
      baseHeaders: (accept) => this.baseHeaders(accept),
      request: (url, init, options) => this.request(url, init, options),
    };
  }

  private googleTransport(): GoogleGeminiTransport {
    return {
      request: (url, init, options) => this.request(url, init, options),
      readSse: (response, options) =>
        readSse(response, undefined, {
          idleTimeoutMs: this.streamIdleTimeoutMs,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }),
      parseStreamJson,
      continuationItems: (message, protocol, model, base) => continuationItems(message, protocol, model, base, this.config.provider),
    };
  }

  private baseHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept,
    };
    if (this.config.provider === "opencode-go") headers["user-agent"] = "Nowadays";
    if (this.credential !== undefined) {
      if (this.config.protocol === "anthropic-messages") {
        headers["x-api-key"] = this.credential;
        headers["anthropic-version"] = "2023-06-01";
      } else if (this.config.provider === "mimo") {
        headers["api-key"] = this.credential;
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
    // 这里是“响应头/首字节”超时：一旦 fetch 解析出响应头就立即清除计时器，
    // 否则长时间持续输出的流会被总时长上限误杀。
    const timeoutMs = options.timeoutMs;
    const headerController =
      timeoutMs === undefined ? undefined : new AbortController();
    let headerTimedOut = false;
    const headerTimer =
      timeoutMs === undefined || headerController === undefined
        ? undefined
        : setTimeout(() => {
            headerTimedOut = true;
            headerController.abort(new ModelRequestTimeoutError(timeoutMs));
          }, timeoutMs);
    headerTimer?.unref?.();
    const signals = [init.signal, options.signal, headerController?.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== null && candidate !== undefined,
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
      if (headerTimedOut) {
        throw new ModelRequestTimeoutError(timeoutMs ?? 0);
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
    } finally {
      if (headerTimer !== undefined) {
        clearTimeout(headerTimer);
      }
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ModelRedirectBlockedError(response.status);
    }
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 404 && this.config.protocol === "google-gemini" && init.method === "POST" &&
          /^https:\/\/aiplatform\.googleapis\.com\/v1(?:beta1)?\/publishers\/google\/models\//.test(url)) {
        throw new VertexEndpointNotFound(vertexGlobalProbeBase(url, body));
      }
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
