import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CredentialResolver } from "../application/resources/credential-resolver.js";
import { withVerifiedRoute } from "../application/resources/model-binding-resolver.js";
import type { TokenUsageService } from "../application/resources/token-usage-service.js";
import type { ResourceService } from "../application/resources/resource-service.js";
import { AppError } from "../domain/errors.js";
import type { ModelServiceConfig } from "../domain/model.js";
import { isVertexPublisherBaseUrl } from "../domain/model-providers.js";
import { modelConfigSchema } from "../domain/resource.js";
import { readJsonBody } from "../http/body.js";
import { buildGeminiStreamUrl, buildGoogleHeaders, normalizeGeminiModelId, vertexSafetySettings, type GoogleOAuthTokenCache } from "../model/google-gemini.js";
import { DEFAULT_STREAM_HEADER_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "../model/protocols.js";
import type { AppStore } from "../storage/core/app-store.js";
import { PiModelReceipt } from "./model-receipt.js";
import {
  DEFAULT_MAX_NON_STREAM_RESPONSE_BYTES,
  fetchWithHeaderTimeout,
  readBoundedResponseBody,
  readChunkWithIdleTimeout,
  releaseReader,
} from "./model-proxy-upstream.js";
import type { PiJobTools } from "./tool-proxy.js";

export function piApiFlavor(config: ModelServiceConfig) {
  switch (config.protocol) {
    case "openai-chat": return "openai-completions";
    case "openai-responses": return "openai-responses";
    case "anthropic-messages": return "anthropic-messages";
    case "google-gemini": return config.provider !== "google-ai-studio" && isVertexPublisherBaseUrl(config.baseUrl) ? "google-vertex" : "google-generative-ai";
  }
}

type Binding = { resourceId: string; modelName: string; config: ModelServiceConfig };
type Flavor = ReturnType<typeof piApiFlavor>;
type Lease = {
  roleId: string; resourceId: string; modelName: string; flavor: Flavor; autonomous: boolean; expiresAt: number;
  tools?: PiJobTools; onFailure?: (code: string) => void; failed?: boolean; controller: AbortController;
};
const denied = () => new AppError(403, "PI_LEASE_REVOKED", "工程租约或请求目标无效");

/** 工程上游网络边界；默认值与主对话 `HttpModelAdapter` 的流式超时保持一致。 */
export interface PiModelProxyOptions {
  /** 上游（含凭据获取）等待响应头的上限。 */
  streamHeaderTimeoutMs?: number;
  /** SSE 分片或非 SSE 正文相邻数据块之间的空闲上限。 */
  streamIdleTimeoutMs?: number;
  /** 非 SSE 成功响应的正文字节上限。 */
  maxResponseBytes?: number;
}

export class PiModelProxy {
  private readonly leases = new Map<string, Lease>();
  private readonly googleTokens: { current: GoogleOAuthTokenCache | undefined } = { current: undefined };
  private readonly streamHeaderTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private credentials: CredentialResolver, private usage: TokenUsageService, private resources: ResourceService,
    private store: AppStore, private onSourceFailure: (resourceId: string, modelName: string, status?: number, retryAfter?: string | null) => void,
    options: PiModelProxyOptions = {},
  ) {
    this.streamHeaderTimeoutMs = options.streamHeaderTimeoutMs ?? DEFAULT_STREAM_HEADER_TIMEOUT_MS;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_NON_STREAM_RESPONSE_BYTES;
  }

  issue(roleId: string, binding: Binding, autonomous: boolean, expiresAt: number, tools?: PiJobTools, onFailure?: (code: string) => void) {
    const token = randomUUID();
    this.leases.set(token, { roleId, resourceId: binding.resourceId, modelName: binding.modelName, flavor: piApiFlavor(binding.config),
      autonomous, expiresAt, controller: new AbortController(), ...(tools && { tools }), ...(onFailure && { onFailure }) });
    return token;
  }
  revoke(token: string) {
    this.leases.get(token)?.controller.abort();
    this.leases.delete(token);
  }
  resolve(request: IncomingMessage, header: "authorization" | "x-api-key" | "x-goog-api-key" = "authorization") {
    for (const alternative of ["authorization", "x-api-key", "x-goog-api-key"]) {
      if (alternative !== header && request.headers[alternative] !== undefined) throw denied();
    }
    const raw = request.headers[header];
    const token = typeof raw === "string" && (header === "authorization" ? /^Bearer ([\w-]+)$/.exec(raw)?.[1] : raw);
    const lease = token && this.leases.get(token);
    if (token && lease && Date.now() >= lease.expiresAt) { this.revoke(token); throw denied(); }
    if (!token || !lease || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) throw denied();
    return { token, lease };
  }
  release(request: IncomingMessage) { this.revoke(this.resolve(request).token); }

  async forward(request: IncomingMessage, response: ServerResponse, flavor: Flavor, modelAction?: string) {
    const google = flavor === "google-vertex" || flavor === "google-generative-ai";
    const header = google ? "x-goog-api-key" : flavor === "anthropic-messages" ? "x-api-key" : "authorization";
    const { lease } = this.resolve(request, header);
    const query = new URL(request.url!, "http://127.0.0.1").search;
    const expectedQuery = google ? "?alt=sse" : flavor === "anthropic-messages" ? "?beta=true" : "";
    if (flavor !== lease.flavor || query !== expectedQuery ||
        (google && modelAction !== normalizeGeminiModelId(lease.modelName) + ":streamGenerateContent")) throw denied();
    const body = z.record(z.string(), z.unknown()).parse(await readJsonBody(request, 16 * 1024 * 1024));
    this.resolve(request, header);
    if ((!google || body.model !== undefined) && body.model !== lease.modelName) throw denied();
    if (lease.failed) throw new AppError(409, "PI_UPSTREAM_FAILED", "本次工程的模型调用已失败");

    const { roleId, resourceId, modelName } = lease;
    const claim = this.resources.claimModelCall(roleId, resourceId);
    if (!claim.admitted) {
      lease.onFailure?.("MODEL_MAINTENANCE");
      throw new AppError(409, "MODEL_MAINTENANCE", "模型维护中");
    }
    try {
      // 领取以后才读取资源和密钥，排除旧地址与新密钥组合，已签任务可继续使用停用的成员。
      const resource = this.store.getResource(resourceId);
      const current = modelConfigSchema.safeParse(resource.config);
      if (resource.kind !== "model" || !current.success || piApiFlavor(current.data) !== flavor) {
        lease.onFailure?.("PI_MODEL_CONFIG_CHANGED");
        throw new AppError(409, "PI_MODEL_CONFIG_CHANGED", "工程模型协议已变更");
      }
      const config = withVerifiedRoute(this.store, this.credentials, current.data, resourceId, modelName);

      await this.dispatch(request, response, body, lease, config);
    } finally { claim.release(); }
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>, lease: Lease, config: ModelServiceConfig) {
    const { roleId, resourceId, modelName } = lease;
    const event = { sourceCallId: "pi:" + randomUUID(), roleId, resourceId, modelName, protocol: config.protocol,
      category: lease.autonomous ? "autonomy" as const : "dialogue" as const, occurredAt: new Date().toISOString() };
    const receipt = new PiModelReceipt(config.protocol);
    const disconnect = new AbortController();
    const abort = () => disconnect.abort();
    response.once("close", abort);
    // 仅租约与下游断开参与“取消”判定；首包/空闲超时与体积超限仍按上游失败记账。
    const cancelSignal = AbortSignal.any([lease.controller.signal, disconnect.signal]);
    let status: number | undefined;
    let retryAfter: string | null = null;
    let succeeded = false;
    if (response.destroyed) abort();
    this.usage.recordCall({ ...event, status: "unknown", usage: null });
    try {
      const credential = this.credentials.resolve(resourceId, config.credentialRef);
      let url: string;
      let headers: Record<string, string> = { "content-type": "application/json" };
      const base = config.baseUrl.replace(/\/+$/, "");
      if (config.protocol === "google-gemini") {
        url = buildGeminiStreamUrl(base, modelName);
        if (lease.flavor === "google-vertex") body.safetySettings = vertexSafetySettings(config.vertexSafety ?? "default");
        headers = await buildGoogleHeaders(credential, "text/event-stream", this.googleTokens, {
          request: (url, init, requestOptions) => fetchWithHeaderTimeout(url, init, {
            timeoutMs: requestOptions?.timeoutMs ?? this.streamHeaderTimeoutMs,
            signal: requestOptions?.signal ?? cancelSignal,
          }),
        }, { signal: cancelSignal, timeoutMs: this.streamHeaderTimeoutMs });
      } else if (config.protocol === "anthropic-messages") {
        url = base + "/messages?beta=true";
        headers["anthropic-version"] = "2023-06-01";
        const beta = request.headers["anthropic-beta"];
        if (typeof beta === "string") headers["anthropic-beta"] = beta;
        if (credential) headers["x-api-key"] = credential;
      } else {
        const chat = config.protocol === "openai-chat";
        url = base + (chat && config.provider === "opencode-go" ? "/openai/v1" : "") + (chat ? "/chat/completions" : "/responses");
        if (credential && config.provider === "mimo") headers["api-key"] = credential;
        else if (credential) headers.authorization = "Bearer " + credential;
        if (chat && body.stream) body.stream_options = { include_usage: true };
      }
      if (config.provider === "opencode-go") headers["user-agent"] = "Nowadays";
      const upstream = await fetchWithHeaderTimeout(url,
        { method: "POST", headers, body: JSON.stringify(body) },
        { timeoutMs: this.streamHeaderTimeoutMs, signal: cancelSignal });
      if (!upstream.ok || !upstream.body) {
        status = upstream.ok ? 502 : upstream.status;
        retryAfter = upstream.headers.get("retry-after");
        await upstream.body?.cancel();
        throw new Error("PI_UPSTREAM_HTTP");
      }
      const type = upstream.headers.get("content-type") ?? "application/json";
      response.setHeader("Content-Type", type);
      if (type.includes("text/event-stream")) {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await readChunkWithIdleTimeout(reader, this.streamIdleTimeoutMs);
            if (done) break;
            receipt.push(value);
            if (!response.write(value)) await once(response, "drain", { signal: cancelSignal });
          }
        } finally {
          // 循环若因处理异常中断，先取消上游读取（正常结束已 done，cancel 为空操作），再释放锁。
          void reader.cancel().catch(() => undefined);
          releaseReader(reader);
        }
        receipt.end();
      } else {
        const data = await readBoundedResponseBody(upstream,
          { maxBytes: this.maxResponseBytes, idleTimeoutMs: this.streamIdleTimeoutMs });
        receipt.json(data.toString("utf8"));
        if (!response.write(data)) await once(response, "drain", { signal: cancelSignal });
      }
      if (!receipt.completed || receipt.failed) throw new Error("PI_UPSTREAM_INCOMPLETE");
      succeeded = true;
      response.end();
    } catch (error) {
      if (cancelSignal.aborted || Date.now() >= lease.expiresAt || response.destroyed) throw denied();
      const localCredentialError = error instanceof AppError && error.code === "MODEL_CREDENTIAL_UNAVAILABLE";
      const code = localCredentialError ? error.code :
        status === 429 ? "PI_UPSTREAM_RATE_LIMITED" : "PI_UPSTREAM_FAILED";
      lease.failed = true;
      lease.onFailure?.(code);
      if (!localCredentialError) this.onSourceFailure(resourceId, modelName, status, retryAfter);
      throw new AppError(status && status >= 400 ? status : 502, code, "工程模型请求失败");
    } finally {
      response.off("close", abort);
      this.usage.recordCall({ ...event, status: succeeded ? "succeeded" : "failed", usage: receipt.usage });
    }
  }
}
