/**
 * 可选混合记忆检索的纯计算与外部端口（409 ARCH-03 / DL-51 方案 A）。
 *
 * 本模块只提供 Embedding 端口、向量编解码、余弦相似度与 RRF 融合，
 * 不持有任何模块级可变业务状态；未配置 Embedding 时检索完全走既有 FTS5。
 */

import { createHash } from "node:crypto";
import type { ModelUsage } from "../../domain/model.js";

/** Embedding 响应体上限：16 MiB，防止恶意或异常服务返回超大正文拖垮进程。 */
export const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024;

/** 向量空间指纹版本；升级时改变前缀即可让全部旧缓存键自然失效。 */
export const EMBEDDING_SPACE_KEY_VERSION = 1;
export const EMBEDDING_SPACE_KEY_PREFIX = `emb-space-v${EMBEDDING_SPACE_KEY_VERSION}:`;

/**
 * 记忆语义检索只接受 OpenAI 兼容协议：
 * 两类协议都提供 `POST /embeddings` 与 Bearer 鉴权。
 */
export function isEmbeddingCompatibleProtocol(
  protocol: unknown,
): protocol is "openai-chat" | "openai-responses" {
  return protocol === "openai-chat" || protocol === "openai-responses";
}

/**
 * 校验并规范化 Embedding 基础地址。
 * 只允许 http/https，且不得把账号密码混进 URL；返回去掉末尾斜杠的地址。
 */
export function validateEmbeddingBaseUrl(baseUrl: unknown): string {
  if (typeof baseUrl !== "string") {
    throw new Error("EMBEDDING_BASE_URL_INVALID");
  }
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("EMBEDDING_BASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("EMBEDDING_BASE_URL_INVALID");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("EMBEDDING_BASE_URL_INVALID");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("EMBEDDING_BASE_URL_INVALID");
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * 用「资源 + 有效地址 + 协议 + 服务商 + 模型」生成带版本的向量空间指纹。
 *
 * 缓存键只描述向量空间本身：同一资源只改别名但实际指向同一空间可继续命中，
 * 而资源、地址、协议或服务商变化会得到全新键，旧向量不会被新查询复用。
 * 资源 ID 区分共享同一地址／模型但凭据上下文不同的服务；指纹绝不含凭据或引用，
 * 避免把密钥信息写入角色库。
 */
export function embeddingSpaceKey(input: {
  resourceId?: string | null;
  baseUrl: string;
  protocol: string;
  provider?: string | null;
  modelName: string;
}): string {
  const endpoint = canonicalEmbeddingEndpoint(
    validateEmbeddingBaseUrl(input.baseUrl),
  );
  const canonical = JSON.stringify({
    version: EMBEDDING_SPACE_KEY_VERSION,
    resource: input.resourceId ?? null,
    endpoint,
    protocol: input.protocol,
    provider: input.provider ?? null,
    model: input.modelName.trim(),
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${EMBEDDING_SPACE_KEY_PREFIX}${digest}`;
}

/** 规范化端点：去掉末尾斜杠并按 URL 规则统一小写主机名与默认端口。 */
function canonicalEmbeddingEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

export interface EmbeddingPort {
  readonly modelKey: string;
  /** 实际提供服务的全局资源 ID；离线注入端口可省略。 */
  readonly resourceId?: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
  /** 可选：同时返回上游用量，供 Token 账本记账；未实现时视为无用量。 */
  embedWithUsage?(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ vectors: Float32Array[]; usage: ModelUsage | null }>;
}

export interface HttpOpenAiEmbeddingPortOptions {
  modelKey: string;
  baseUrl: string;
  modelName: string;
  /** 实际提供服务的全局资源 ID，供后台回填登记在途依赖。 */
  resourceId?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** 响应正文字节上限，默认 16 MiB。 */
  maxResponseBytes?: number;
}

interface EmbeddingResponseItem {
  index?: unknown;
  embedding?: unknown;
}

interface EmbeddingResponse {
  data?: unknown;
  usage?: unknown;
}

/**
 * 兼容 OpenAI `/embeddings` 契约的 HTTP 端口。
 * 返回向量统一做 L2 归一化，调用方只需计算点积。
 *
 * 安全口径：禁止跟随重定向（避免 Bearer 凭据被带到非预期主机），
 * 并在 JSON.parse 之前限制响应正文字节数。
 */
export class HttpOpenAiEmbeddingPort implements EmbeddingPort {
  readonly modelKey: string;
  readonly resourceId?: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: HttpOpenAiEmbeddingPortOptions) {
    this.modelKey = options.modelKey;
    if (options.resourceId !== undefined) {
      this.resourceId = options.resourceId;
    }
    this.baseUrl = validateEmbeddingBaseUrl(options.baseUrl);
    this.modelName = options.modelName;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.maxResponseBytes =
      options.maxResponseBytes ?? MAX_EMBEDDING_RESPONSE_BYTES;
  }

  async embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    return (await this.embedWithUsage(texts, signal)).vectors;
  }

  async embedWithUsage(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ vectors: Float32Array[]; usage: ModelUsage | null }> {
    if (texts.length === 0) {
      return { vectors: [], usage: null };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("EMBEDDING_TIMEOUT"));
    }, this.timeoutMs);
    timer.unref?.();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify({
          model: this.modelName,
          input: [...texts],
          encoding_format: "float",
        }),
        signal: combined,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        throw new Error("EMBEDDING_REDIRECT_BLOCKED");
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`EMBEDDING_HTTP_${response.status}`);
      }
      const declaredLength = parseContentLength(
        response.headers.get("content-length"),
      );
      if (declaredLength !== null && declaredLength > this.maxResponseBytes) {
        await cancelResponseBody(response);
        throw new Error("EMBEDDING_RESPONSE_TOO_LARGE");
      }
      const text = await readResponseTextWithLimit(
        response,
        this.maxResponseBytes,
      );
      let payload: EmbeddingResponse;
      try {
        payload = JSON.parse(text) as EmbeddingResponse;
      } catch {
        throw new Error("EMBEDDING_RESPONSE_INVALID");
      }
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        throw new Error("EMBEDDING_RESPONSE_INVALID");
      }
      return {
        vectors: parseEmbeddingResponse(payload, texts.length),
        usage: parseEmbeddingUsage(payload),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseContentLength(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 取消正文失败不影响错误码判定。
  }
}

/**
 * 增量读取正文并维护字节计数；一旦超过上限立即取消流并报错，
 * 保证超限正文在 JSON.parse 之前就被拒绝。
 */
async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("EMBEDDING_RESPONSE_TOO_LARGE");
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("EMBEDDING_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** `prompt_tokens` 优先、`total_tokens` 兜底；缺失或非法时返回 null。 */
function parseEmbeddingUsage(payload: EmbeddingResponse): ModelUsage | null {
  const usage = payload.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const record = usage as Record<string, unknown>;
  for (const candidate of [record.prompt_tokens, record.total_tokens]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return { inputTokens: Math.floor(candidate) };
    }
  }
  return null;
}

function parseEmbeddingResponse(
  payload: EmbeddingResponse,
  expected: number,
): Float32Array[] {
  if (!Array.isArray(payload.data)) {
    throw new Error("EMBEDDING_RESPONSE_INVALID");
  }
  const items = payload.data as EmbeddingResponseItem[];
  if (items.length !== expected) {
    throw new Error("EMBEDDING_RESPONSE_LENGTH_MISMATCH");
  }
  const sorted = [...items].sort(
    (left, right) => embeddingIndex(left) - embeddingIndex(right),
  );
  let dimensions = 0;
  const vectors: Float32Array[] = [];
  for (const [position, item] of sorted.entries()) {
    if (embeddingIndex(item) !== position) {
      throw new Error("EMBEDDING_RESPONSE_INDEX_INVALID");
    }
    if (!Array.isArray(item.embedding)) {
      throw new Error("EMBEDDING_RESPONSE_VECTOR_INVALID");
    }
    const values = item.embedding as unknown[];
    if (values.length === 0) {
      throw new Error("EMBEDDING_RESPONSE_VECTOR_INVALID");
    }
    if (dimensions === 0) {
      dimensions = values.length;
    } else if (values.length !== dimensions) {
      throw new Error("EMBEDDING_RESPONSE_DIMENSION_MISMATCH");
    }
    const vector = new Float32Array(values.length);
    for (const [index, value] of values.entries()) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("EMBEDDING_RESPONSE_VECTOR_INVALID");
      }
      vector[index] = value;
    }
    vectors.push(normalizeVector(vector));
  }
  return vectors;
}

function embeddingIndex(item: EmbeddingResponseItem): number {
  return typeof item.index === "number" && Number.isInteger(item.index) && item.index >= 0
    ? item.index
    : -1;
}

/** 非零向量做 L2 归一化；零向量或含非有限值时返回同维全零。 */
export function normalizeVector(
  values: Float32Array | readonly number[],
): Float32Array {
  const result = new Float32Array(values.length);
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    if (!Number.isFinite(value)) {
      return result;
    }
    result[index] = value;
    sumSquares += value * value;
  }
  if (sumSquares === 0) {
    return result;
  }
  const norm = Math.sqrt(sumSquares);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = (result[index] ?? 0) / norm;
  }
  return result;
}

/** 小端 Float32 编码，便于与 SQLite BLOB 直接互转。 */
export function encodeVectorBlob(vector: Float32Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index] ?? 0, index * 4);
  }
  return buffer;
}

/** 解码前校验字节长度，避免维度漂移读取到错位数据。 */
export function decodeVectorBlob(
  blob: Buffer,
  dimensions: number,
): Float32Array | null {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    return null;
  }
  if (blob.byteLength !== dimensions * 4) {
    return null;
  }
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = blob.readFloatLE(index * 4);
  }
  return vector;
}

/** 维度不等或空向量返回 0，避免脏缓存放大不相关结果。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RrfOptions {
  k?: number;
  ftsWeight?: number;
  vectorWeight?: number;
  minSimilarity?: number;
}

export interface VectorRankedDocument {
  documentId: number;
  similarity: number;
}

/**
 * Reciprocal Rank Fusion：FTS 与向量排名各按 0 基位次累加。
 * 只有达到最低相似度的向量才进入排名，避免语义噪声挤掉字面命中。
 */
export function fuseRrfRankings(
  ftsRankedIds: readonly number[],
  vectorRanked: ReadonlyArray<VectorRankedDocument>,
  options: RrfOptions = {},
): Map<number, number> {
  const k = options.k ?? 60;
  const ftsWeight = options.ftsWeight ?? 1;
  const vectorWeight = options.vectorWeight ?? 1;
  const minSimilarity = options.minSimilarity ?? 0.25;
  const scores = new Map<number, number>();
  const add = (documentId: number, score: number): void => {
    scores.set(documentId, (scores.get(documentId) ?? 0) + score);
  };
  ftsRankedIds.forEach((documentId, rank) => {
    add(documentId, ftsWeight / (k + rank + 1));
  });
  let eligibleRank = 0;
  for (const item of vectorRanked) {
    if (item.similarity < minSimilarity) {
      continue;
    }
    add(item.documentId, vectorWeight / (k + eligibleRank + 1));
    eligibleRank += 1;
  }
  return scores;
}
