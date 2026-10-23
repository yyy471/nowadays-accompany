import { AccompanyError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { isLoopbackHost } from '../../core/net.js';
import type { CredentialVault } from '../../secrets/vault.js';
import { formatHostPort, probeTcp, readRuntimeInfo, readRuntimeVersion } from './config.js';

export const SNOWLUMA_MANAGEMENT_CREDENTIAL_REF = 'snowluma/management';
export const SUPPORTED_SNOWLUMA_VERSION = '1.14.x';

export class SnowLumaError extends AccompanyError {
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(code, message, options);
    this.retryable = options?.retryable ?? false;
  }
}

export interface SnowLumaManagerSettings {
  runtimeDir?: string;
  baseUrl?: string;
}

export interface SnowLumaProcess {
  pid: number;
  /** Local Accompany connection, never inferred from an unverified process account. */
  instanceId?: string;
  name?: string;
  path?: string;
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin?: string;
  status: string;
  error?: string;
  method?: string;
}

export interface SnowLumaRuntimeStatus {
  configured: boolean;
  runtimeDir?: string;
  baseUrl?: string;
  version?: string;
  supportedVersion: string;
  compatible: boolean;
  running: boolean;
  authenticated: boolean;
  passwordConfigured: boolean;
  consentRequired: boolean;
  autoLoadEnabled: boolean;
  autoLoadKnown: boolean;
  owner: 'external' | 'managed' | 'none';
  startupState?: 'unconfigured' | 'starting' | 'managed' | 'external' | 'error';
  error?: string;
}

export interface SnowLumaManagerOptions {
  vault: CredentialVault;
  logger: Logger;
  settings?: SnowLumaManagerSettings;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  now?: () => number;
}

interface LoginPayload {
  success?: unknown;
  token?: unknown;
  message?: unknown;
  needsTotp?: unknown;
  mustChangePassword?: unknown;
  consentRequired?: unknown;
}

const MAX_PID = 4_194_304;
const VERSION_RE = /^1\.14\.\d+(?:[-+].*)?$/;

/**
 * SnowLuma 1.14.x WebUI 管理客户端。只连接用户已运行的本地 runtime，
 * 不启动 QQ、不自动注入；管理密码只从凭据库读取。
 */
export class SnowLumaManager {
  readonly #vault: CredentialVault;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  #settings: SnowLumaManagerSettings;
  #token: string | undefined;
  #lastError: string | undefined;
  #consentRequired = false;

  constructor(options: SnowLumaManagerOptions) {
    this.#vault = options.vault;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#settings = { ...(options.settings ?? {}) };
  }

  configure(settings: SnowLumaManagerSettings): void {
    this.#settings = { ...settings };
    this.#token = undefined;
    this.#lastError = undefined;
    this.#consentRequired = false;
  }

  settings(): SnowLumaManagerSettings {
    return { ...this.#settings };
  }

  async status(): Promise<SnowLumaRuntimeStatus> {
    const info = await this.#inspectRuntime();
    if (!info) {
      return {
        configured: false,
        supportedVersion: SUPPORTED_SNOWLUMA_VERSION,
        compatible: false,
        running: false,
        authenticated: false,
        passwordConfigured: await this.#passwordConfigured(),
        consentRequired: false,
        autoLoadEnabled: false,
        autoLoadKnown: false,
        owner: 'external',
        ...(this.#lastError ? { error: this.#lastError } : {})
      };
    }
    const passwordConfigured = await this.#passwordConfigured();
    const running = await probeTcp(info.host, info.port, 1_000);
    return {
      configured: true,
      ...(this.#settings.runtimeDir ? { runtimeDir: this.#settings.runtimeDir } : {}),
      baseUrl: info.baseUrl,
      ...(info.version ? { version: info.version } : {}),
      supportedVersion: SUPPORTED_SNOWLUMA_VERSION,
      compatible: info.compatible,
      running,
      authenticated: Boolean(this.#token),
      passwordConfigured,
      consentRequired: this.#consentRequired,
      autoLoadEnabled: info.autoLoadEnabled,
      autoLoadKnown: info.autoLoadKnown,
      owner: 'external',
      ...(this.#lastError
        ? { error: this.#lastError }
        : !info.compatible
          ? { error: `SnowLuma ${info.version ?? 'unknown'} is outside supported ${SUPPORTED_SNOWLUMA_VERSION}` }
          : info.autoLoadEnabled
            ? { error: 'SnowLuma hookAutoLoad is enabled; disable automatic injection before using manual mode' }
            : !passwordConfigured
              ? { error: 'SnowLuma management password is not configured' }
              : {})
    };
  }

  async listProcesses(): Promise<SnowLumaProcess[]> {
    const payload = await this.#request('/api/processes');
    const list = (payload as { list?: unknown }).list;
    if (!Array.isArray(list)) throw new SnowLumaError('snowluma_protocol', 'process list response has no list');
    return list.map((entry) => normalizeProcess(entry));
  }

  async load(pid: number): Promise<SnowLumaProcess | undefined> {
    const payload = await this.#processAction(pid, 'load');
    return payload;
  }

  async unload(pid: number): Promise<SnowLumaProcess | undefined> {
    return this.#processAction(pid, 'unload');
  }

  async refresh(pid: number): Promise<SnowLumaProcess | undefined> {
    return this.#processAction(pid, 'refresh');
  }

  async probeLogin(pid: number): Promise<{ uin?: string; nickname?: string }> {
    assertPid(pid);
    const payload = await this.#request(`/api/processes/${pid}/probe-login`, {}, true);
    const info = (payload as { info?: unknown }).info;
    if (!info || typeof info !== 'object') return {};
    const record = info as Record<string, unknown>;
    return {
      ...(typeof record.uin === 'string' || typeof record.uin === 'number' ? { uin: String(record.uin) } : {}),
      ...(typeof record.nickname === 'string' ? { nickname: record.nickname } : {})
    };
  }

  async #processAction(pid: number, action: 'load' | 'unload' | 'refresh'): Promise<SnowLumaProcess | undefined> {
    assertPid(pid);
    const payload = await this.#request(`/api/processes/${pid}/${action}`, { method: 'POST' }, true);
    const result = payload as { success?: unknown; message?: unknown; process?: unknown };
    const process = result.process ? normalizeProcess(result.process) : undefined;
    if (result.success === false) {
      const message =
        typeof result.message === 'string'
          ? result.message
          : process?.error ?? `${action} failed for pid ${pid}`;
      throw new SnowLumaError('snowluma_process_action_failed', sanitize(message), { retryable: false });
    }
    return process;
  }

  async #request(pathname: string, init: RequestInit = {}, mutation = false): Promise<unknown> {
    const info = await this.#inspectRuntime();
    if (!info) throw new SnowLumaError('snowluma_runtime_unavailable', 'SnowLuma runtime is not configured');
    if (!info.compatible) {
      throw new SnowLumaError(
        'snowluma_version_incompatible',
        `SnowLuma ${info.version ?? 'unknown'} is outside supported ${SUPPORTED_SNOWLUMA_VERSION}`
      );
    }
    if (mutation && !info.autoLoadKnown) {
      throw new SnowLumaError('snowluma_autoload_unknown', 'SnowLuma hookAutoLoad 状态未知，请先明确关闭自动注入。');
    }
    if (mutation && info.autoLoadEnabled) {
      throw new SnowLumaError(
        'snowluma_autoload_enabled',
        'SnowLuma hookAutoLoad is enabled; disable automatic injection before using manual mode'
      );
    }
    const token = await this.#login();
    let response = await this.#fetch(`${info.baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(this.#requestTimeoutMs)
    });
    if (response.status === 401) {
      this.#token = undefined;
      const fresh = await this.#login();
      response = await this.#fetch(`${info.baseUrl}${pathname}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
          authorization: `Bearer ${fresh}`
        },
        signal: AbortSignal.timeout(this.#requestTimeoutMs)
      });
    }
    const text = await response.text().catch(() => '');
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new SnowLumaError('snowluma_protocol', `SnowLuma returned invalid JSON for ${pathname}`);
    }
    if (!response.ok) {
      const record = (payload ?? {}) as { message?: unknown; consentRequired?: unknown };
      if (record.consentRequired === true) {
        this.#consentRequired = true;
        throw new SnowLumaError(
          'snowluma_consent_required',
          'SnowLuma requires the user to accept its agreements in its own WebUI first'
        );
      }
      throw new SnowLumaError(
        response.status === 401 ? 'snowluma_auth_failed' : 'snowluma_http_error',
        sanitize(typeof record.message === 'string' ? record.message : `SnowLuma HTTP ${response.status}`),
        { retryable: response.status >= 500 }
      );
    }
    return payload;
  }

  async #login(): Promise<string> {
    if (this.#token) return this.#token;
    const info = await this.#inspectRuntime();
    if (!info) throw new SnowLumaError('snowluma_runtime_unavailable', 'SnowLuma runtime is not configured');
    const password = await this.#vault.get(SNOWLUMA_MANAGEMENT_CREDENTIAL_REF);
    if (!password) {
      throw new SnowLumaError('snowluma_password_missing', 'SnowLuma management password is not configured');
    }
    let response: Response;
    try {
      response = await this.#fetch(`${info.baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(this.#requestTimeoutMs)
      });
    } catch (error) {
      throw new SnowLumaError('snowluma_unreachable', 'cannot reach SnowLuma management service', {
        retryable: true,
        cause: error
      });
    }
    const text = await response.text().catch(() => '');
    let payload: LoginPayload = {};
    try {
      payload = text ? (JSON.parse(text) as LoginPayload) : {};
    } catch {
      throw new SnowLumaError('snowluma_protocol', 'SnowLuma login returned invalid JSON');
    }
    if (payload.needsTotp === true) {
      throw new SnowLumaError('snowluma_totp_required', 'SnowLuma account requires a TOTP code; use its WebUI first');
    }
    if (payload.consentRequired === true) {
      this.#consentRequired = true;
      throw new SnowLumaError(
        'snowluma_consent_required',
        'SnowLuma requires the user to accept its agreements in its own WebUI first'
      );
    }
    if (payload.mustChangePassword === true) {
      throw new SnowLumaError(
        'snowluma_password_change_required',
        'SnowLuma requires changing its WebUI password before the API can be used'
      );
    }
    if (payload.success !== true || typeof payload.token !== 'string' || !payload.token) {
      throw new SnowLumaError(
        response.status === 429 ? 'snowluma_login_rate_limited' : 'snowluma_auth_failed',
        sanitize(typeof payload.message === 'string' ? payload.message : 'SnowLuma login failed'),
        { retryable: response.status === 429 }
      );
    }
    this.#token = payload.token;
    this.#lastError = undefined;
    this.#logger.info('authenticated to snowluma management', {
      baseUrl: info.baseUrl,
      version: info.version
    });
    return payload.token;
  }

  async #passwordConfigured(): Promise<boolean> {
    return this.#vault.has(SNOWLUMA_MANAGEMENT_CREDENTIAL_REF);
  }

  async #inspectRuntime(): Promise<
    | {
        baseUrl: string;
        host: string;
        port: number;
        version?: string;
        compatible: boolean;
        autoLoadEnabled: boolean;
        autoLoadKnown: boolean;
      }
    | undefined
  > {
    const runtimeDir = this.#settings.runtimeDir;
    const runtime = runtimeDir ? await readRuntimeInfo(runtimeDir) : null;
    const version = runtimeDir ? await readRuntimeVersion(runtimeDir) : undefined;
    const explicit = this.#settings.baseUrl?.trim();
    if (!runtime && !explicit) return undefined;
    const baseUrl = explicit || (runtime ? `${runtime.tlsEnabled ? 'https' : 'http'}://${formatHostPort(runtime.webuiHost, runtime.webuiPort)}` : '');
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      this.#lastError = 'invalid SnowLuma management baseUrl';
      return undefined;
    }
    if (!isLoopbackHost(parsed.hostname)) {
      this.#lastError = 'SnowLuma management address must be loopback';
      return undefined;
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      this.#lastError = 'SnowLuma management baseUrl must not contain credentials or query parameters';
      return undefined;
    }
    const clean = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    return {
      baseUrl: clean,
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      ...(version ? { version } : {}),
      compatible: version !== undefined && VERSION_RE.test(version),
      autoLoadEnabled: runtime?.hookAutoLoad ?? false,
      autoLoadKnown: runtime?.autoLoadKnown ?? false
    };
  }
}

export function normalizeProcess(raw: unknown): SnowLumaProcess {
  if (!raw || typeof raw !== 'object') throw new SnowLumaError('snowluma_protocol', 'invalid process entry');
  const value = raw as Record<string, unknown>;
  const pid = Number(value.pid);
  assertPid(pid);
  const uin = value.uin === undefined || value.uin === null || value.uin === '' ? undefined : String(value.uin);
  return {
    pid,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    injected: value.injected === true,
    connected: value.connected === true,
    loggedIn: value.loggedIn === true,
    ...(uin ? { uin } : {}),
    status: typeof value.status === 'string' ? value.status : 'unknown',
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.method === 'string' ? { method: value.method } : {})
  };
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) {
    throw new SnowLumaError('snowluma_invalid_pid', 'invalid QQ process id');
  }
}

function sanitize(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300);
}
