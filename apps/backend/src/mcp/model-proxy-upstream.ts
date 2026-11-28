import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
import { ModelRequestTimeoutError } from "../domain/errors.js";

/** 非流式模型响应的正文字节上限；流式响应的正文由下游背压控制，不在此累积。 */
export const DEFAULT_MAX_NON_STREAM_RESPONSE_BYTES = 16 * 1024 * 1024;

/** 上游正文超过上限；调用方按上游失败记账，不视为下游取消。 */
export class UpstreamResponseTooLargeError extends Error {
  readonly code = "UPSTREAM_RESPONSE_TOO_LARGE";

  constructor(readonly maxBytes: number) {
    super(`upstream response exceeds ${maxBytes} bytes`);
    this.name = "UpstreamResponseTooLargeError";
  }
}

/**
 * 带响应头截止时间的 fetch：计时器在解析出响应头后立即清除，不限制持续输出的正文。
 * 凭据获取等辅助请求也复用它，使密钥相关网络 I/O 同样受首包期限约束。
 */
export async function fetchWithHeaderTimeout(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, {
      ...init,
      // 带凭据的请求不跟随重定向，与既有 Pi 代理一致。
      redirect: "error",
      signal: AbortSignal.any([options.signal, controller.signal]),
    });
  } catch (error) {
    if (timedOut) {
      throw new ModelRequestTimeoutError(options.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取下一个正文分片，并在相邻分片之间施加空闲上限。
 * 超时先拒绝竞态再取消底层 reader，避免 pending read 先被结算为正常结束。
 */
export async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = reader.read();
    if (idleTimeoutMs <= 0) {
      return await read;
    }
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const timeoutError = new ModelRequestTimeoutError(idleTimeoutMs);
          reject(timeoutError);
          void reader.cancel(timeoutError).catch(() => undefined);
        }, idleTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** 释放 reader 锁；超时取消时底层流可能仍在结算，不让清理异常覆盖超时错误。 */
export function releaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    reader.releaseLock();
  } catch {
    // 锁由流取消流程自行结算。
  }
}

/**
 * 有界读取非流式正文：先按 Content-Length 提前拒绝，再逐分片累计校验，
 * 超限时立即取消 reader 关闭上游连接。
 */
export async function readBoundedResponseBody(
  response: Response,
  options: { maxBytes: number; idleTimeoutMs: number },
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamResponseTooLargeError(options.maxBytes);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readChunkWithIdleTimeout(
        reader,
        options.idleTimeoutMs,
      );
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamResponseTooLargeError(options.maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    releaseReader(reader);
  }
  return Buffer.concat(chunks, total);
}
