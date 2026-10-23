import { AccompanyError } from '../core/errors.js';
import type { CapabilityId } from '../policy/capabilities.js';

export class ConfigError extends AccompanyError {
  readonly retryable = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super('invalid_config', message, options);
  }
}

export class CapabilityUnavailableError extends AccompanyError {
  readonly retryable = false;
  readonly capability: CapabilityId;
  readonly reason: string;

  constructor(capability: CapabilityId, reason: string, message: string) {
    super('capability_unavailable', message);
    this.capability = capability;
    this.reason = reason;
  }
}

export class ProviderError extends AccompanyError {
  readonly retryable: boolean;
  readonly providerId: string;
  readonly capability?: CapabilityId;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: string,
    message: string,
    options: {
      providerId: string;
      capability?: CapabilityId;
      retryable: boolean;
      cause?: unknown;
      httpStatus?: number;
      retryAfterMs?: number;
    }
  ) {
    super(code, message, { cause: options.cause });
    this.providerId = options.providerId;
    this.retryable = options.retryable;
    if (options.capability) this.capability = options.capability;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export class MediaError extends AccompanyError {
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(code, message, options);
    this.retryable = options?.retryable ?? false;
  }
}

export class JobError extends AccompanyError {
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** 错误文本里可能出现带鉴权的 URL，不能原样进入日志或 API。 */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export function sanitizeErrorText(raw: string, limit = 300): string {
  let text = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => sanitizeUrl(match));
  if (text.length > limit) text = `${text.slice(0, limit)}…`;
  return text;
}
