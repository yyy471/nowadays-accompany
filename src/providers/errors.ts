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

// 旧路径兼容：错误类仍是同一个构造器，领域模块已改用各自路径。
export { MediaError } from '../media/errors.js';
export { JobError } from '../jobs/errors.js';
export { sanitizeErrorText, sanitizeUrl } from '../platform/security/redaction.js';
