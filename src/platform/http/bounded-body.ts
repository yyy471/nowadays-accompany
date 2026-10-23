export type HttpBodyErrorCode =
  | 'http_body_too_large'
  | 'http_body_timeout'
  | 'http_body_aborted'
  | 'http_body_failed';

export class HttpBodyError extends Error {
  readonly code: HttpBodyErrorCode;
  readonly label: string;
  readonly limit?: number;
  readonly bytes?: number;

  constructor(
    code: HttpBodyErrorCode,
    message: string,
    options: { label: string; limit?: number; bytes?: number; cause?: unknown } = { label: 'http response' }
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpBodyError';
    this.code = code;
    this.label = options.label;
    if (options.limit !== undefined) this.limit = options.limit;
    if (options.bytes !== undefined) this.bytes = options.bytes;
  }
}

export interface ReadBodyOptions {
  maxBytes: number;
  /** 调用方取消；已发出的请求体读取会被 cancel。 */
  signal?: AbortSignal;
  /** 覆盖响应体读取的阶段超时；已发出的读取会被 cancel。 */
  timeoutMs?: number;
  label?: string;
}

/**
 * 有界读取响应体：超限、调用方取消或阶段超时都会停止读取并取消流，
 * 不会先把完整响应缓冲到内存。错误信息只包含标签和字节数，不带 URL/凭据。
 */
export async function readResponseBytes(response: Response, options: ReadBodyOptions): Promise<Buffer> {
  const label = options.label ?? 'http response';
  const maxBytes = options.maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new HttpBodyError('http_body_failed', `${label} read limit is invalid`, { label });
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new HttpBodyError('http_body_too_large', `${label} is ${declared} bytes, limit is ${maxBytes}`, {
      label,
      limit: maxBytes,
      bytes: declared
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) {
      throw new HttpBodyError('http_body_too_large', `${label} is ${data.length} bytes, limit is ${maxBytes}`, {
        label,
        limit: maxBytes,
        bytes: data.length
      });
    }
    return data;
  }

  let timedOut = false;
  let callerAborted = false;
  let cancelRequested = false;
  const cancelReader = (reason?: unknown): void => {
    if (cancelRequested) return;
    cancelRequested = true;
    void reader.cancel(reason).catch(() => {});
  };
  const onAbort = (): void => {
    callerAborted = true;
    cancelReader(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    cancelReader(options.signal.reason);
    throw new HttpBodyError('http_body_aborted', `${label} read was aborted`, {
      label,
      cause: options.signal.reason
    });
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = options.timeoutMs !== undefined && options.timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        cancelReader(new HttpBodyError('http_body_timeout', `${label} read timed out`, { label }));
      }, options.timeoutMs)
    : undefined;
  timer?.unref?.();

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (callerAborted || options.signal?.aborted) {
        throw new HttpBodyError('http_body_aborted', `${label} read was aborted`, {
          label,
          bytes: total,
          cause: options.signal?.reason
        });
      }
      if (timedOut) {
        throw new HttpBodyError('http_body_timeout', `${label} read timed out after ${options.timeoutMs}ms`, {
          label,
          bytes: total
        });
      }
      if (item.done) break;
      if (!item.value) continue;
      total += item.value.byteLength;
      if (total > maxBytes) {
        cancelReader(new HttpBodyError('http_body_too_large', `${label} exceeded ${maxBytes} bytes`, { label }));
        throw new HttpBodyError('http_body_too_large', `${label} exceeded ${maxBytes} bytes`, {
          label,
          limit: maxBytes,
          bytes: total
        });
      }
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    cancelReader(error);
    if (error instanceof HttpBodyError) throw error;
    if (timedOut) {
      throw new HttpBodyError('http_body_timeout', `${label} read timed out after ${options.timeoutMs}ms`, {
        label,
        bytes: total,
        cause: error
      });
    }
    if (callerAborted || options.signal?.aborted) {
      throw new HttpBodyError('http_body_aborted', `${label} read was aborted`, {
        label,
        bytes: total,
        cause: error
      });
    }
    throw new HttpBodyError('http_body_failed', `${label} body read failed`, {
      label,
      bytes: total,
      cause: error
    });
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function readResponseText(response: Response, options: ReadBodyOptions): Promise<string> {
  return (await readResponseBytes(response, options)).toString('utf8');
}
