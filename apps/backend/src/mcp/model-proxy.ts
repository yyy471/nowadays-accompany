import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { CredentialResolver } from "../application/resources/credential-resolver.js";
import type { ResolvedModelBinding } from "../application/resources/model-binding-resolver.js";
import type { TokenUsageService } from "../application/resources/token-usage-service.js";
import type { ResourceService } from "../application/resources/resource-service.js";
import type { ModelUsage } from "../domain/model.js";
import { mergeModelUsage } from "../domain/token-usage.js";
import { AppError } from "../domain/errors.js";
import { normalizeUsage } from "../model/protocols.js";
import { readJsonBody } from "../http/body.js";

type Lease = { roleId: string; binding: ResolvedModelBinding; autonomous: boolean; expiresAt: number; controller: AbortController };
const denied = () => new AppError(403, "PI_LEASE_REVOKED", "工程模型租约已失效");
export class PiModelProxy {
  private readonly leases = new Map<string, Lease>();
  constructor(private credentials: CredentialResolver, private usage: TokenUsageService, private resources: ResourceService) {}
  issue(roleId: string, binding: ResolvedModelBinding, autonomous: boolean, expiresAt: number) {
    if (!["openai-chat", "openai-responses"].includes(binding.config.protocol))
      throw new AppError(400, "PI_PROTOCOL_UNSUPPORTED", "工程任务需要 OpenAI Chat 或 Responses 模型绑定");
    const token = randomUUID();
    this.leases.set(token, { roleId, binding, autonomous, expiresAt, controller: new AbortController() });
    return token;
  }
  revoke(token: string) {
    this.leases.get(token)?.controller.abort();
    this.leases.delete(token);
  }
  private resolve(request: IncomingMessage) {
    const token = request.headers.authorization?.match(/^Bearer ([\w-]+)$/)?.[1];
    const lease = token && this.leases.get(token);
    if (token && lease && Date.now() >= lease.expiresAt) { this.revoke(token); throw denied(); }
    if (!token || !lease ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) throw denied();
    return { token, lease };
  }
  release(request: IncomingMessage) { this.revoke(this.resolve(request).token); }
  async forward(request: IncomingMessage, response: ServerResponse, route: string) {
    this.resolve(request);
    const body = z.record(z.string(), z.unknown()).parse(await readJsonBody(request, 16 * 1024 * 1024));
    const { lease } = this.resolve(request);
    const { binding, roleId } = lease;
    const { config } = binding;
    if (route !== (config.protocol === "openai-chat" ? "chat/completions" : "responses")) throw denied();
    const credential = this.credentials.resolve(binding.resourceId, config.credentialRef);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (credential) {
      if (config.provider === "mimo") headers["api-key"] = credential;
      else headers.authorization = "Bearer " + credential;
    }
    body.model = binding.modelName;
    if (route === "chat/completions" && body.stream) body.stream_options = { include_usage: true };
    const base = config.baseUrl.replace(/\/+$/, "");
    const url = base + (config.provider === "opencode-go" ? "/openai/v1/" : "/") + route;
    const claim = this.resources.claimModelCall(roleId, binding.resourceId);
    if (!claim.admitted) throw new AppError(409, "MODEL_MAINTENANCE", "模型维护中");
    const event = { sourceCallId: "pi:" + randomUUID(), roleId, resourceId: binding.resourceId, modelName: binding.modelName,
      protocol: config.protocol, category: lease.autonomous ? "autonomy" as const : "dialogue" as const, occurredAt: new Date().toISOString() };
    let usage: ModelUsage | null = null;
    let succeeded = false;
    let chatFinished = false;
    const disconnect = new AbortController();
    const abort = () => disconnect.abort();
    response.once("close", abort);
    this.usage.recordCall({ ...event, status: "unknown", usage });
    try {
      const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error",
        signal: AbortSignal.any([lease.controller.signal, disconnect.signal]) });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        throw new AppError(upstream.ok ? 502 : upstream.status, "PI_UPSTREAM_FAILED", "模型服务请求失败");
      }
      const type = upstream.headers.get("content-type") ?? "application/json";
      response.setHeader("Content-Type", type);
      function inspect(data: string) {
        if (data === "[DONE]") { if (route === "chat/completions") succeeded = chatFinished; return; }
        const chunk = JSON.parse(data);
        const u = chunk.response?.usage ?? chunk.usage;
        const reported = u && normalizeUsage({ inputTokens: u.input_tokens ?? u.prompt_tokens, outputTokens: u.output_tokens ?? u.completion_tokens,
          cachedTokens: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens });
        if (reported) usage = mergeModelUsage(usage, reported);
        if (chunk.choices?.some((choice: { finish_reason?: string }) => choice.finish_reason)) chatFinished = true;
        if (chunk.type === "response.completed") succeeded = true;
      }
      if (type.includes("text/event-stream")) {
        let pending = "";
        const decoder = new TextDecoder();
        const eventData: string[] = [];
        function line(text: string) {
          const value = text.replace(/\r$/, "");
          if (!value && eventData.length) inspect(eventData.splice(0).join("\n"));
          else if (value.startsWith("data:")) eventData.push(value.slice(5).trimStart());
        }
        async function* capture(source: AsyncIterable<Uint8Array>) {
          for await (const bytes of source) {
            pending += decoder.decode(bytes, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop()!;
            for (const text of lines) line(text);
            yield bytes;
          }
          pending += decoder.decode();
          line(pending);
          line("");
        }
        await pipeline(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>), capture, response);
      } else {
        const data = await upstream.text();
        inspect(data);
        const parsed = JSON.parse(data);
        succeeded = !parsed.error && !["failed", "incomplete", "cancelled"].includes(parsed.status);
        response.end(data);
      }
    } catch (error) {
      succeeded = false;
      if (lease.controller.signal.aborted) throw denied();
      if (error instanceof AppError) throw error;
      throw new AppError(502, "PI_UPSTREAM_FAILED", "工程模型连接中断");
    } finally {
      response.off("close", abort);
      this.usage.recordCall({ ...event, status: succeeded ? "succeeded" : "failed", usage });
      claim.release();
    }
  }
}
