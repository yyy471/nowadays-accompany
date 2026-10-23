export class AccompanyError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidStateTransitionError extends AccompanyError {
  constructor(from: string, to: string) {
    super('invalid_state_transition', `cannot transition from ${from} to ${to}`);
  }
}

export class InvalidSpecError extends AccompanyError {
  constructor(message: string) {
    super('invalid_spec', message);
  }
}

export class UnsupportedCapabilityError extends AccompanyError {
  constructor(kind: string, capability: string) {
    super('unsupported_capability', `backend ${kind} does not support ${capability}`);
  }
}

export class BackendError extends AccompanyError {
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(code, message, options);
    this.retryable = options?.retryable ?? true;
  }
}

export class ChannelError extends AccompanyError {
  readonly retryable: boolean;
  readonly retcode?: number;

  constructor(code: string, message: string, options?: { cause?: unknown; retryable?: boolean; retcode?: number }) {
    super(code, message, options);
    this.retryable = options?.retryable ?? true;
    this.retcode = options?.retcode;
  }
}

export class IsolationError extends AccompanyError {
  constructor(message: string) {
    super('isolation_violation', message);
  }
}

export class BackpressureError extends AccompanyError {
  constructor(message: string) {
    super('backpressure', message);
  }
}

/** 账号档案不完整（最常见的是缺角色卡）；不是故障，实例应停在 awaiting_profile。 */
export class ProfileNotReadyError extends AccompanyError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('profile_not_ready', message, options);
  }
}

export function errorRetryable(error: unknown): boolean {
  if (error instanceof BackendError || error instanceof ChannelError) return error.retryable;
  if (error instanceof AccompanyError && 'retryable' in error && typeof error.retryable === 'boolean') {
    return error.retryable;
  }
  if (
    error instanceof IsolationError ||
    error instanceof InvalidSpecError ||
    error instanceof InvalidStateTransitionError ||
    error instanceof ProfileNotReadyError
  ) {
    return false;
  }
  return true;
}
