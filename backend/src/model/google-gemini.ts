import { createHash, createSign, randomUUID } from "node:crypto";
import {
  ModelListIncompatibleError,
  ModelRequestFailedError,
  ModelToolArgumentsError,
} from "../domain/errors.js";
import type {
  ModelContinuation,
  ModelEvent,
  ModelMessage,
  ModelProtocol,
  ModelRequest,
} from "../domain/model.js";

const DEFAULT_GOOGLE_OAUTH_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface GoogleOAuthTokenCache {
  keyHash: string;
  accessToken: string;
  expiresAtMs: number;
}

export interface GoogleGeminiTransport {
  request(
    url: string,
    init: RequestInit,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Response>;
  readSse(response: Response): AsyncIterable<{ event: string | undefined; data: string }>;
  parseStreamJson(data: string): Record<string, unknown>;
  continuationItems(
    message: Extract<ModelMessage, { role: "assistant" }>,
    protocol: ModelProtocol,
    modelName: string,
    baseUrl: string,
  ): Record<string, unknown>[] | null;
}

interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

const GOOGLE_STATUS_REASONS: Record<string, string> = {
  UNAUTHENTICATED: "authentication_error",
  PERMISSION_DENIED: "permission_error",
  RESOURCE_EXHAUSTED: "rate_limit_exceeded",
  INVALID_ARGUMENT: "invalid_request_error",
  FAILED_PRECONDITION: "invalid_request_error",
  NOT_FOUND: "not_found_error",
  DEADLINE_EXCEEDED: "timeout",
  UNAVAILABLE: "server_error",
  INTERNAL: "server_error",
  ABORTED: "api_error",
};

/** 将 Google RPC / HTTP 错误对象映射为不泄密的安全错误原因码。 */
export function mapGoogleErrorReason(error: unknown): string | null {
  if (!isPlainRecord(error)) {
    return null;
  }
  const status = error.status;
  if (typeof status === "string") {
    const mapped = GOOGLE_STATUS_REASONS[status];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return null;
}

/**
 * 规范化 Gemini 模型标识。
 * AI Studio 返回 `models/...`，Vertex 返回 `publishers/google/models/...`，
 * 请求统一拼接为 `{baseUrl}/models/{model}`。
 */
export function normalizeGeminiModelId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("publishers/google/models/")) {
    return trimmed.slice("publishers/google/models/".length);
  }
  if (trimmed.startsWith("models/")) {
    return trimmed.slice("models/".length);
  }
  return trimmed;
}

/** 构造 Google Gemini / Vertex AI 流式生成接口地址。 */
export function buildGeminiStreamUrl(baseUrl: string, modelName: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const modelId = normalizeGeminiModelId(modelName);
  return `${cleanBase}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
}

/** 解析 Google AI Studio (`models`) 或 Vertex AI (`publisherModels`) 模型列表响应。 */
export function parseGoogleModelsList(parsed: unknown): string[] {
  if (!isPlainRecord(parsed)) {
    throw new ModelListIncompatibleError("NOT_OBJECT");
  }
  if ("models" in parsed) {
    if (!Array.isArray(parsed.models)) {
      throw new ModelListIncompatibleError("MODELS_NOT_ARRAY");
    }
    return extractGoogleModelNames(parsed.models, true);
  }
  if ("publisherModels" in parsed) {
    if (!Array.isArray(parsed.publisherModels)) {
      throw new ModelListIncompatibleError("MODELS_NOT_ARRAY");
    }
    return extractGoogleModelNames(parsed.publisherModels, false);
  }
  throw new ModelListIncompatibleError("MODELS_NOT_ARRAY");
}

function extractGoogleModelNames(
  items: readonly unknown[],
  filterGenerateContent: boolean,
): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (!isPlainRecord(item) || typeof item.name !== "string" || item.name.length === 0) {
      // 与 OpenAI 列表策略一致：任一条目结构缺失直接报不兼容，不静默截断列表。
      throw new ModelListIncompatibleError("ITEMS_WITHOUT_NAME");
    }
    if (filterGenerateContent && Array.isArray(item.supportedGenerationMethods)) {
      if (!item.supportedGenerationMethods.includes("generateContent")) {
        continue;
      }
    }
    const normalized = normalizeGeminiModelId(item.name);
    if (normalized.length > 0) {
      names.push(normalized);
    }
  }
  return names;
}

/**
 * 构造 Google 请求头：
 * - 普通 API Key（Vertex Express `AQ...` / AI Studio `AIza...`）走 `x-goog-api-key`
 * - GCP 服务账号 JSON 自动签发并缓存短效 OAuth2 Bearer Token（实例内缓存，无全局可变状态）
 */
export async function buildGoogleHeaders(
  credential: string | undefined,
  accept: string,
  cacheRef: { current: GoogleOAuthTokenCache | undefined },
  transport: Pick<GoogleGeminiTransport, "request">,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept,
  };
  if (credential === undefined) {
    return headers;
  }
  const serviceAccount = parseServiceAccountCredential(credential);
  if (serviceAccount === null) {
    headers["x-goog-api-key"] = credential;
    return headers;
  }
  const token = await resolveServiceAccountToken(
    credential,
    serviceAccount,
    cacheRef,
    transport,
    options,
  );
  headers.authorization = `Bearer ${token}`;
  return headers;
}

/** 判断是否为 Vertex AI Publisher 接口前缀（Express Mode 不提供列出模型目录端点）。 */
function isVertexPublisherBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    const host = parsed.hostname.toLowerCase();
    return (
      pathname.endsWith("/publishers/google") ||
      host === "aiplatform.googleapis.com" ||
      host.endsWith("-aiplatform.googleapis.com")
    );
  } catch {
    return false;
  }
}

/** 拉取 Google Gemini / Vertex AI 可用模型列表。 */
export async function listGoogleModels(input: {
  baseUrl: string;
  credential: string | undefined;
  cacheRef: { current: GoogleOAuthTokenCache | undefined };
  transport: Pick<GoogleGeminiTransport, "request">;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const headers = await buildGoogleHeaders(
    input.credential,
    "application/json",
    input.cacheRef,
    input.transport,
    {
      timeoutMs: input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  const cleanBase = input.baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await input.transport.request(
      `${cleanBase}/models`,
      { method: "GET", headers },
      {
        timeoutMs: input.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  } catch (error) {
    if (error instanceof ModelRequestFailedError && isVertexPublisherBaseUrl(cleanBase)) {
      const details = isPlainRecord(error.details) ? error.details : undefined;
      const status = typeof details?.status === "number" ? details.status : undefined;
      const isExpressAuth = headers.authorization === undefined;
      if (status === 404 || (status === 401 && isExpressAuth)) {
        // Vertex Express 仅开放推理与计数端点，不提供模型目录查询；返回明确提示方便用户手填模型名。
        throw new ModelRequestFailedError(
          `Vertex AI Express 不提供自动读取模型目录接口（HTTP ${String(status)}），请直接手填模型名称（如 gemini-3.8-flash、gemini-2.5-flash）后点击测试连接`,
          error.details,
        );
      }
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ModelListIncompatibleError("INVALID_JSON");
  }
  return parseGoogleModelsList(parsed);
}

/** 执行 Google Gemini / Vertex AI 原生 SSE 流式生成，并输出标准 `ModelEvent`。 */
export async function* streamGoogleGemini(input: {
  baseUrl: string;
  credential: string | undefined;
  cacheRef: { current: GoogleOAuthTokenCache | undefined };
  request: ModelRequest;
  transport: GoogleGeminiTransport;
}): AsyncGenerator<ModelEvent> {
  const { request, transport } = input;
  const headers = await buildGoogleHeaders(
    input.credential,
    "text/event-stream",
    input.cacheRef,
    transport,
    request.signal === undefined ? {} : { signal: request.signal },
  );
  const response = await transport.request(
    buildGeminiStreamUrl(input.baseUrl, request.modelName),
    {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildGeminiGenerateBody(
          request,
          request.modelName,
          input.baseUrl,
          transport.continuationItems,
        ),
      ),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    },
  );

  const accumulatedParts: Record<string, unknown>[] = [];
  const toolCalls: Array<{ callId: string; name: string; arguments: unknown }> = [];
  const rawResponse: unknown[] = [];
  let rawFinishReason: string | null = null;
  let promptBlockReason: string | null = null;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const frame of transport.readSse(response)) {
    const payload = transport.parseStreamJson(frame.data);
    rawResponse.push(payload);
    if (isPlainRecord(payload.error)) {
      throw new ModelRequestFailedError("模型请求失败", {
        reason: mapGoogleErrorReason(payload.error) ?? "MESSAGE_ERROR",
      });
    }
    const usage = readGeminiUsage(payload.usageMetadata);
    if (usage.inputTokens !== undefined) {
      inputTokens = usage.inputTokens;
    }
    if (usage.outputTokens !== undefined) {
      outputTokens = usage.outputTokens;
    }
    if (
      isPlainRecord(payload.promptFeedback) &&
      typeof payload.promptFeedback.blockReason === "string" &&
      payload.promptFeedback.blockReason.length > 0
    ) {
      promptBlockReason = payload.promptFeedback.blockReason;
    }
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const candidate = candidates[0];
    if (!isPlainRecord(candidate)) {
      continue;
    }
    const content = isPlainRecord(candidate.content) ? candidate.content : null;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const part of parts) {
      if (!isPlainRecord(part)) {
        continue;
      }
      if (isPlainRecord(part.functionCall)) {
        const fc = part.functionCall;
        const name = typeof fc.name === "string" ? fc.name.trim() : "";
        if (name.length === 0) {
          throw new ModelToolArgumentsError("unknown");
        }
        const args = parseGeminiFunctionArgs(name, fc.args);
        const wireId =
          typeof fc.id === "string" && fc.id.length > 0 ? fc.id : undefined;
        const callId = wireId ?? randomUUID();
        toolCalls.push({ callId, name, arguments: args });
        accumulatedParts.push(structuredClone(part));
        continue;
      }
      if (typeof part.text === "string") {
        // 思考链 part (`thought: true`) 不对外吐字，但保留在 continuation 里供后续原样回传。
        if (part.thought !== true && part.text.length > 0) {
          yield { type: "text_delta", text: part.text };
        }
        mergeGeminiTextPart(accumulatedParts, part);
        continue;
      }
      if (typeof part.thoughtSignature === "string") {
        accumulatedParts.push(structuredClone(part));
      }
    }
    if (
      typeof candidate.finishReason === "string" &&
      candidate.finishReason.length > 0
    ) {
      rawFinishReason = candidate.finishReason;
    }
  }

  if (rawFinishReason === null) {
    if (promptBlockReason !== null) {
      throw new ModelRequestFailedError("模型拒绝处理该输入", {
        reason: "content_policy_violation",
      });
    }
    throw new ModelRequestFailedError("模型流提前结束，未收到完整终态", {
      reason: "STREAM_TRUNCATED",
    });
  }

  for (const call of toolCalls) {
    yield {
      type: "tool_call",
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
    };
  }
  if (inputTokens !== undefined || outputTokens !== undefined) {
    yield {
      type: "usage",
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    };
  }

  const normalized = normalizeGeminiFinishReason(rawFinishReason);
  const continuation: ModelContinuation | undefined =
    accumulatedParts.length === 0
      ? undefined
      : {
          protocol: "google-gemini",
          modelName: request.modelName,
          baseUrl: input.baseUrl,
          items: accumulatedParts,
        };

  yield {
    type: "completed",
    stopReason: normalized.stopReason,
    ...(normalized.incomplete ? { incomplete: true } : {}),
    rawResponse: rawResponse.length === 0 ? undefined : rawResponse,
    ...(continuation === undefined ? {} : { continuation }),
  };
}

/** 构造 Google Gemini `generateContent` 请求体。 */
export function buildGeminiGenerateBody(
  request: ModelRequest,
  modelName: string,
  baseUrl: string,
  continuationItems: GoogleGeminiTransport["continuationItems"],
): Record<string, unknown> {
  return {
    ...(request.system.length > 0
      ? { systemInstruction: { parts: [{ text: request.system }] } }
      : {}),
    contents: toGoogleGeminiContents(
      request.messages,
      modelName,
      baseUrl,
      continuationItems,
    ),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.inputSchema,
              })),
            },
          ],
        }),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { generationConfig: { maxOutputTokens: request.maxOutputTokens } }),
  };
}

function toGoogleGeminiContents(
  messages: readonly ModelMessage[],
  modelName: string,
  baseUrl: string,
  continuationItems: GoogleGeminiTransport["continuationItems"],
): Array<{ role: "user" | "model"; parts: unknown[] }> {
  const contents: Array<{ role: "user" | "model"; parts: unknown[] }> = [];
  // 记录每个内部 callId 对应的工具名和上游是否真正下发了 functionCall.id，
  // 避免向严格校验 schema 的 Vertex v1 回传伪造 id 触发 400 错误。
  const callMeta = new Map<string, { name: string; wireId?: string }>();

  const pushParts = (role: "user" | "model", parts: readonly unknown[]) => {
    if (parts.length === 0) {
      return;
    }
    const last = contents[contents.length - 1];
    if (last?.role === role) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role, parts: [...parts] });
  };

  for (const message of messages) {
    if (message.role === "user") {
      const parts: Record<string, unknown>[] = [];
      for (const image of message.images ?? []) {
        parts.push({
          inlineData: {
            mimeType: image.mediaType,
            data: image.dataBase64,
          },
        });
      }
      parts.push({ text: message.content });
      pushParts("user", parts);
      continue;
    }
    if (message.role === "assistant") {
      const replay = continuationItems(
        message,
        "google-gemini",
        modelName,
        baseUrl,
      );
      const calls = message.toolCalls ?? [];
      const wireFunctionCalls =
        replay === null
          ? []
          : replay
              .map((part) => (isPlainRecord(part.functionCall) ? part.functionCall : null))
              .filter((fc): fc is Record<string, unknown> => fc !== null);

      calls.forEach((call, index) => {
        const wireFc = wireFunctionCalls[index];
        const wireId =
          wireFc !== undefined &&
          typeof wireFc.id === "string" &&
          wireFc.id.length > 0
            ? wireFc.id
            : undefined;
        callMeta.set(call.callId, {
          name: call.name,
          ...(wireId === undefined ? {} : { wireId }),
        });
      });

      if (replay !== null && replay.length > 0) {
        pushParts("model", replay);
        continue;
      }
      const fallbackParts: unknown[] = [];
      if (message.content.length > 0 || calls.length === 0) {
        fallbackParts.push({ text: message.content });
      }
      for (const call of calls) {
        fallbackParts.push({
          functionCall: {
            name: call.name,
            args: toolArgsObject(call.arguments),
          },
        });
      }
      pushParts("model", fallbackParts);
      continue;
    }

    const meta = callMeta.get(message.toolCallId);
    const toolName = meta?.name ?? message.toolName;
    if (typeof toolName !== "string" || toolName.length === 0) {
      throw new ModelRequestFailedError("工具结果缺少工具名称，无法发送给 Gemini", {
        reason: "MISSING_TOOL_NAME",
      });
    }
    pushParts("user", [
      {
        functionResponse: {
          name: toolName,
          ...(meta?.wireId === undefined ? {} : { id: meta.wireId }),
          response: wrapGeminiToolResponse(message.content),
        },
      },
    ]);
  }
  return contents;
}

function mergeGeminiTextPart(
  parts: Record<string, unknown>[],
  incoming: Record<string, unknown>,
): void {
  const isThought = incoming.thought === true;
  const previous = parts[parts.length - 1];
  const incomingSignature =
    typeof incoming.thoughtSignature === "string"
      ? incoming.thoughtSignature
      : undefined;
  const canMerge =
    previous !== undefined &&
    typeof previous.text === "string" &&
    Boolean(previous.thought) === isThought &&
    previous.thoughtSignature === undefined &&
    hasOnlyTextPartKeys(previous) &&
    hasOnlyTextPartKeys(incoming);

  if (canMerge) {
    previous.text = `${previous.text}${String(incoming.text)}`;
    if (incomingSignature !== undefined) {
      previous.thoughtSignature = incomingSignature;
    }
    return;
  }
  parts.push(structuredClone(incoming));
}

function hasOnlyTextPartKeys(part: Record<string, unknown>): boolean {
  for (const key of Object.keys(part)) {
    if (key !== "text" && key !== "thought" && key !== "thoughtSignature") {
      return false;
    }
  }
  return true;
}

function parseGeminiFunctionArgs(
  name: string,
  rawArgs: unknown,
): Record<string, unknown> {
  if (rawArgs === undefined || rawArgs === null) {
    return {};
  }
  if (!isPlainRecord(rawArgs)) {
    throw new ModelToolArgumentsError(name);
  }
  return rawArgs;
}

function toolArgsObject(args: unknown): Record<string, unknown> {
  if (isPlainRecord(args)) {
    return args;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (isPlainRecord(parsed)) {
        return parsed;
      }
    } catch {
      // ignore invalid JSON fallback
    }
  }
  return {};
}

function wrapGeminiToolResponse(content: string): Record<string, unknown> {
  if (content.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (isPlainRecord(parsed)) {
        return parsed;
      }
    } catch {
      // fall back to string wrapper
    }
  }
  return { output: content };
}

function readGeminiUsage(raw: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!isPlainRecord(raw)) {
    return {};
  }
  const inputTokens =
    typeof raw.promptTokenCount === "number" ? raw.promptTokenCount : undefined;
  const candidatesTokens =
    typeof raw.candidatesTokenCount === "number"
      ? raw.candidatesTokenCount
      : undefined;
  const thoughtsTokens =
    typeof raw.thoughtsTokenCount === "number"
      ? raw.thoughtsTokenCount
      : undefined;
  const outputTokens =
    candidatesTokens !== undefined || thoughtsTokens !== undefined
      ? (candidatesTokens ?? 0) + (thoughtsTokens ?? 0)
      : undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function normalizeGeminiFinishReason(rawFinishReason: string): {
  stopReason: string;
  incomplete: boolean;
} {
  if (rawFinishReason === "STOP") {
    return { stopReason: "stop", incomplete: false };
  }
  if (rawFinishReason === "MAX_TOKENS") {
    return { stopReason: "max_tokens", incomplete: true };
  }
  return {
    stopReason: rawFinishReason.toLowerCase(),
    incomplete: true,
  };
}

function parseServiceAccountCredential(
  credential: string,
): GoogleServiceAccount | null {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || parsed.type !== "service_account") {
    return null;
  }
  const clientEmail =
    typeof parsed.client_email === "string" ? parsed.client_email.trim() : "";
  const privateKey =
    typeof parsed.private_key === "string" ? parsed.private_key : "";
  const tokenUriRaw =
    typeof parsed.token_uri === "string" && parsed.token_uri.trim().length > 0
      ? parsed.token_uri.trim()
      : DEFAULT_GOOGLE_OAUTH_TOKEN_URI;
  if (clientEmail.length === 0 || privateKey.length === 0) {
    throw new ModelRequestFailedError("Google 服务账号凭据缺少必需字段", {
      reason: "invalid_api_key",
    });
  }
  let parsedTokenUrl: URL;
  try {
    parsedTokenUrl = new URL(tokenUriRaw);
  } catch {
    throw new ModelRequestFailedError("Google 服务账号 token_uri 无效", {
      reason: "invalid_api_key",
    });
  }
  if (
    (parsedTokenUrl.protocol !== "https:" && parsedTokenUrl.protocol !== "http:") ||
    parsedTokenUrl.username.length > 0 ||
    parsedTokenUrl.password.length > 0
  ) {
    throw new ModelRequestFailedError("Google 服务账号 token_uri 协议不受支持", {
      reason: "invalid_api_key",
    });
  }
  return { clientEmail, privateKey, tokenUri: parsedTokenUrl.toString() };
}

async function resolveServiceAccountToken(
  rawCredential: string,
  account: GoogleServiceAccount,
  cacheRef: { current: GoogleOAuthTokenCache | undefined },
  transport: Pick<GoogleGeminiTransport, "request">,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  const keyHash = createHash("sha256").update(rawCredential).digest("hex");
  const nowMs = Date.now();
  if (
    cacheRef.current !== undefined &&
    cacheRef.current.keyHash === keyHash &&
    nowMs < cacheRef.current.expiresAtMs
  ) {
    return cacheRef.current.accessToken;
  }

  const assertion = signServiceAccountJwt(account, Math.floor(nowMs / 1000));
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await transport.request(
    account.tokenUri,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
    },
    options,
  );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelRequestFailedError("Google OAuth2 令牌响应不是有效 JSON", {
      reason: "authentication_error",
    });
  }
  if (
    !isPlainRecord(payload) ||
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0
  ) {
    throw new ModelRequestFailedError("Google OAuth2 令牌响应缺少 access_token", {
      reason: "authentication_error",
    });
  }
  const expiresInSec =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : 3600;
  cacheRef.current = {
    keyHash,
    accessToken: payload.access_token,
    expiresAtMs:
      Date.now() + Math.max(0, expiresInSec * 1000 - TOKEN_REFRESH_SKEW_MS),
  };
  return payload.access_token;
}

function signServiceAccountJwt(
  account: GoogleServiceAccount,
  issuedAtSec: number,
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: DEFAULT_CLOUD_PLATFORM_SCOPE,
      aud: account.tokenUri,
      iat: issuedAtSec,
      exp: issuedAtSec + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(account.privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  } catch {
    throw new ModelRequestFailedError("Google 服务账号私钥签名失败", {
      reason: "invalid_api_key",
    });
  }
}

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
