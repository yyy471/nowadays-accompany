import {
  ModelRequestFailedError,
  ModelRequestTimeoutError,
  ModelToolArgumentsError,
} from "../domain/errors.js";
import type { ModelUsage } from "../domain/model.js";

/** 单个流式调用最多保留的原始响应字节数，避免长流无限占用内存。 */
export const DEFAULT_MAX_RAW_RESPONSE_BYTES = 256 * 1024;

export interface SsePayload {
  event: string | undefined;
  data: string;
}

export interface SseState {
  done: boolean;
}

export async function* readSse(
  response: Response,
  state?: SseState,
  options: { idleTimeoutMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<SsePayload> {
  const body = response.body;
  if (!body) {
    throw new ModelRequestFailedError("模型响应缺少流正文");
  }
  // options.signal 已同时传给 fetch；外部取消会让 body reader 以 AbortError 结束，
  // 这里只需负责“相邻数据块之间的空闲超时”。
  const idleTimeoutMs = options.idleTimeoutMs;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let idleTimedOut = false;
      let done = false;
      let value: Uint8Array | undefined;
      try {
        const read = reader.read();
        if (idleTimeoutMs === undefined) {
          ({ done, value } = await read);
        } else {
          ({ done, value } = await Promise.race([
            read,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                idleTimedOut = true;
                const timeoutError = new ModelRequestTimeoutError(idleTimeoutMs);
                reject(timeoutError);
                // 先拒绝 race 再取消底层流，避免 reader.cancel() 先把 pending read 结算为 done: true。
                void reader.cancel(timeoutError).catch(() => undefined);
              }, idleTimeoutMs);
              timer.unref?.();
            }),
          ]));
        }
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
      if (idleTimedOut && idleTimeoutMs !== undefined) {
        throw new ModelRequestTimeoutError(idleTimeoutMs);
      }
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        if (line.length === 0) {
          eventName = undefined;
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            if (state) {
              state.done = true;
            }
            return;
          }
          if (data.length > 0) {
            yield { event: eventName, data };
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const data = tail.slice(5).trim();
      if (data === "[DONE]") {
        if (state) {
          state.done = true;
        }
      } else if (data.length > 0) {
        yield { event: eventName, data };
      }
    }
  } catch (error) {
    if (error instanceof ModelRequestTimeoutError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new ModelRequestFailedError("模型流中断", {
      reason: error instanceof Error ? error.name : "STREAM_ERROR",
    });
  } finally {
    reader.releaseLock();
  }
}

export function parseStreamJson(data: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ModelRequestFailedError("模型流响应不是有效 JSON");
  }
}

/**
 * 有界原始响应收集器：超过上限后停止收集，并在结尾附加截断标记。
 * 长流只保留前若干字节的协议帧，避免 rawResponse 无上限增长。
 */
export class RawResponseCollector {
  private readonly items: unknown[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes = DEFAULT_MAX_RAW_RESPONSE_BYTES) {}

  push(item: unknown, rawByteLength?: number): void {
    if (this.truncated) {
      return;
    }
    const size =
      rawByteLength ?? Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");
    if (this.bytes + size > this.maxBytes) {
      this.truncated = true;
      return;
    }
    this.bytes += size;
    this.items.push(item);
  }

  finish(): unknown[] | undefined {
    if (this.items.length === 0 && !this.truncated) {
      return undefined;
    }
    if (this.truncated) {
      return [...this.items, { _truncated: true, maxBytes: this.maxBytes }];
    }
    return this.items;
  }
}

export function normalizeUsage(input: {
  inputTokens?: unknown;
  cachedTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
}): ModelUsage | null {
  const inputTokens = finiteNonNeg(input.inputTokens);
  const rawCached = finiteNonNeg(input.cachedTokens);
  const outputTokens = finiteNonNeg(input.outputTokens);
  const cacheCreationTokens = finiteNonNeg(input.cacheCreationTokens);
  if (
    inputTokens === undefined &&
    rawCached === undefined &&
    outputTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return null;
  }
  const cachedTokens =
    rawCached !== undefined && inputTokens !== undefined
      ? Math.min(rawCached, inputTokens)
      : rawCached;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
  };
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function readUsage(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      }
    | undefined,
): ModelUsage | null {
  if (!usage) {
    return null;
  }
  return normalizeUsage({
    inputTokens: usage.input_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens,
    outputTokens: usage.output_tokens,
  });
}

export function parseToolArguments(name: string, raw: string): unknown {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ModelToolArgumentsError(name);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
