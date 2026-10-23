import { AccompanyError } from '../core/errors.js';

export class JobError extends AccompanyError {
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(code, message);
  }
}
