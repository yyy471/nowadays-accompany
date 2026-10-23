import { AccompanyError } from '../core/errors.js';

export class MediaError extends AccompanyError {
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(code, message, options);
    this.retryable = options?.retryable ?? false;
  }
}
