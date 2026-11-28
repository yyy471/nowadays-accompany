import type { ModelServiceConfig } from "../domain/model.js";

/** 流式生成所需的传输与配置上下文；由 `HttpModelAdapter` 提供。 */
export interface StreamTransportContext {
  readonly config: ModelServiceConfig;
  readonly streamHeaderTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly maxRawResponseBytes: number;
  baseHeaders(accept: string): Record<string, string>;
  request(
    url: string,
    init: RequestInit,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Response>;
}
