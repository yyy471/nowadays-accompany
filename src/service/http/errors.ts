import { AccompanyError, BackpressureError } from '../../core/errors.js';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable?: boolean;

  constructor(status: number, message: string, code = 'http_error', retryable?: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function statusForError(error: unknown): number {
  if (error instanceof BackpressureError) return 429;
  if (!(error instanceof AccompanyError)) return 500;
  switch (error.code) {
    case 'message_too_large':
    case 'media_too_large':
    case 'body_too_large':
    case 'memory_capacity':
      return 413;
    case 'media_unsupported_type':
      return 415;
    case 'job_backpressure':
    case 'backpressure':
      return 429;
    case 'job_state_invalid':
    case 'worldbook_conflict':
    case 'worldbook_unavailable':
    case 'memory_conflict':
    case 'memory_extraction_disabled':
    case 'memory_extraction_unavailable':
    case 'credential_store_unavailable':
    case 'capability_unavailable':
    case 'snowluma_runtime_unavailable':
    case 'snowluma_password_missing':
    case 'snowluma_version_incompatible':
    case 'snowluma_autoload_enabled':
    case 'snowluma_autoload_unknown':
    case 'snowluma_auth_failed':
    case 'snowluma_consent_required':
    case 'snowluma_totp_required':
    case 'snowluma_password_change_required':
    case 'injection_slot_busy':
    case 'injection_settings_busy':
    case 'injection_slot_bound':
    case 'injection_backend_unsupported':
    case 'injection_identity_mismatch':
    case 'injection_not_loaded':
    case 'injection_account_in_use':
    case 'skill_conflict':
    case 'extension_conflict':
      return 409;
    case 'snowluma_unreachable':
    case 'worldbook_io_error':
    case 'memory_io_error':
    case 'snowluma_http_error':
    case 'snowluma_process_action_failed':
    case 'injection_failed':
    case 'injection_login_timeout':
      return 503;
    case 'media_not_found':
    case 'worldbook_not_found':
    case 'memory_record_not_found':
    case 'memory_scope_missing':
    case 'job_not_found':
    case 'unknown_provider':
    case 'injection_slot_not_found':
    case 'injection_process_stale':
    case 'injection_operation_not_found':
    case 'skill_not_found':
      return 404;
    default:
      return 400;
  }
}
