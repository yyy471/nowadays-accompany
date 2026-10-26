import { AccompanyError } from '../../../core/errors.js';

/** A safe, classifier-friendly failure from one extraction attempt; messages never contain chat text. */
export class ExtractionAttemptError extends AccompanyError {
  readonly fatal: boolean;
  /** Benign means no provider attempt happened (scope/session changed); no cooldown is recorded. */
  readonly benign: boolean;

  constructor(code: string, message: string, options: { fatal?: boolean; benign?: boolean; cause?: unknown } = {}) {
    super(code, message, options.cause === undefined ? undefined : { cause: options.cause });
    this.fatal = options.fatal ?? false;
    this.benign = options.benign ?? false;
  }
}
