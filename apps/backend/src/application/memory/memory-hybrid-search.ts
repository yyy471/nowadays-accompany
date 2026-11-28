/**
 * 可选混合记忆检索的纯计算与外部端口（409 ARCH-03 / DL-51 方案 A）。
 *
 * 本模块只提供 Embedding 端口、向量编解码、余弦相似度与 RRF 融合，
 * 不持有任何模块级可变业务状态；未配置 Embedding 时检索完全走既有 FTS5。
 */

export interface EmbeddingPort {
  readonly modelKey: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface HttpOpenAiEmbeddingPortOptions {
  modelKey: string;
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface EmbeddingResponseItem {
  index?: unknown;
  embedding?: unknown;
}

interface EmbeddingResponse {
  data?: unknown;
}

/**
 * 兼容 OpenAI `/embeddings` 契约的 HTTP 端口。
 * 返回向量统一做 L2 归一化，调用方只需计算点积。
 */
export class HttpOpenAiEmbeddingPort implements EmbeddingPort {
  readonly modelKey: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: HttpOpenAiEmbeddingPortOptions) {
    this.modelKey = options.modelKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.modelName = options.modelName;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 4000;
  }

  async embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
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
      });
      if (!response.ok) {
        throw new Error(`EMBEDDING_HTTP_${response.status}`);
      }
      const payload = (await response.json()) as EmbeddingResponse;
      return parseEmbeddingResponse(payload, texts.length);
    } finally {
      clearTimeout(timer);
    }
  }
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
