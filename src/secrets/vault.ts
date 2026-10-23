import { AccompanyError } from '../core/errors.js';

/**
 * 凭据库只按 credentialRef 读写。普通插件、模型上下文、SSE 与日志拿不到本接口。
 * 没有可用的系统保护实现时必须明确失败，不能静默写明文。
 */
export interface CredentialVault {
  readonly kind: string;
  readonly available: boolean;
  get(ref: string): Promise<string | undefined>;
  has(ref: string): Promise<boolean>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
  /** 单调递增的按 ref 版本；用于拒绝排队任务继续使用已更换的凭据。 */
  revision?(ref: string): number;
}

export class CredentialVaultUnavailableError extends AccompanyError {
  constructor(message = 'system credential protection is unavailable; refusing to store a plaintext key') {
    super('credential_store_unavailable', message);
  }
}

export class UnavailableCredentialVault implements CredentialVault {
  readonly kind = 'unavailable';
  readonly available = false;

  get(ref: string): Promise<string | undefined> {
    void ref;
    return Promise.resolve(undefined);
  }

  has(ref: string): Promise<boolean> {
    void ref;
    return Promise.resolve(false);
  }

  revision(ref: string): number {
    void ref;
    return 0;
  }

  set(ref: string, secret: string): Promise<void> {
    void ref;
    void secret;
    return Promise.reject(new CredentialVaultUnavailableError());
  }

  delete(ref: string): Promise<void> {
    void ref;
    return Promise.reject(new CredentialVaultUnavailableError());
  }
}

/** 仅用于测试和显式注入；进程结束后内容消失。 */
export class MemoryCredentialVault implements CredentialVault {
  readonly kind = 'memory';
  readonly available = true;
  readonly #values = new Map<string, string>();
  readonly #revisions = new Map<string, number>();

  async get(ref: string): Promise<string | undefined> {
    return this.#values.get(ref);
  }

  async has(ref: string): Promise<boolean> {
    return this.#values.has(ref);
  }

  revision(ref: string): number {
    return this.#revisions.get(ref) ?? 0;
  }

  async set(ref: string, secret: string): Promise<void> {
    if (!ref.trim()) throw new AccompanyError('invalid_credential_ref', 'credential ref is required');
    if (!secret.trim()) throw new AccompanyError('invalid_credential', 'credential must be a non-empty string');
    if (secret.length > 16_384) throw new AccompanyError('invalid_credential', 'credential is too large');
    this.#values.set(ref, secret);
    this.#revisions.set(ref, this.revision(ref) + 1);
  }

  async delete(ref: string): Promise<void> {
    this.#values.delete(ref);
    this.#revisions.set(ref, this.revision(ref) + 1);
  }
}

export function defaultCredentialRef(providerId: string): string {
  return `provider/${providerId}`;
}
