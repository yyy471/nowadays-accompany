import { BackendError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { InstanceSpec } from '../../instances/spec.js';
import type {
  BackendCapabilities,
  BackendStatus,
  InjectionBackend,
  ProbeInstance,
  ProbeReport,
  RuntimeEndpoints
} from '../contract.js';
import {
  formatHostPort,
  isLoopbackHost,
  listProfiles,
  probeTcp,
  readProfileTokens,
  readRuntimeInfo,
  type SnowLumaProfile
} from './config.js';

export interface SnowLumaBackendOptions {
  runtimeDir: string;
  accountId?: string;
  logger: Logger;
  probeTimeoutMs?: number;
  /** 仅本地开发使用：允许没有 accessToken 的 runtime。 */
  allowTokenless?: boolean;
}

/**
 * SnowLuma runtime 适配器（attach 模式）。
 * backend 是 runtime 作用域的：一个 runtimeDir 只创建一个 backend，多个账号会话通过
 * start(spec)/stop(spec) 分别 attach/detach，而不是每个实例各建一份运行时视图。
 */
export class SnowLumaBackend implements InjectionBackend {
  readonly kind = 'snowluma';
  readonly capabilities: BackendCapabilities = { launch: false, attach: true, multiInstance: true };

  readonly #runtimeDir: string;
  readonly #accountId: string | undefined;
  readonly #logger: Logger;
  readonly #probeTimeoutMs: number;
  readonly #allowTokenless: boolean;
  readonly #attached = new Map<string, SnowLumaProfile>();
  readonly #sessions = new Map<string, string>();

  constructor(options: SnowLumaBackendOptions) {
    this.#runtimeDir = options.runtimeDir;
    this.#accountId = options.accountId;
    this.#logger = options.logger;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 800;
    this.#allowTokenless = options.allowTokenless ?? false;
  }

  async probe(): Promise<ProbeReport> {
    const warnings: string[] = [];
    const runtime = await readRuntimeInfo(this.#runtimeDir);
    const profiles = await listProfiles(this.#runtimeDir);
    if (!runtime) warnings.push('runtime.json 缺失或 webuiPort 无效');
    if (profiles.length === 0) warnings.push('未找到 onebot_<uin>.json（账号尚未登录或配置目录不同）');
    if (profiles.length > 1) warnings.push(`发现 ${profiles.length} 个账号 profile：${profiles.map((p) => p.accountId).join(', ')}`);

    const portOwners = new Map<string, string[]>();
    for (const profile of profiles) {
      for (const [label, endpoint] of [['http', profile.http], ['ws', profile.ws]] as const) {
        const key = `${label}:${endpoint.host}:${endpoint.port}`;
        const owners = portOwners.get(key) ?? [];
        owners.push(profile.accountId);
        portOwners.set(key, owners);
        if (!isLoopbackHost(endpoint.host)) warnings.push(`${profile.accountId} ${label} 监听在非回环地址 ${endpoint.host}`);
        if (!endpoint.hasToken) warnings.push(`${profile.accountId} ${label} 未配置 accessToken`);
      }
    }
    for (const [key, owners] of portOwners) {
      if (owners.length > 1) warnings.push(`端口被多个账号共用 ${key} ← ${owners.join(' / ')}（多号必须拆端口）`);
    }

    const instances: ProbeInstance[] = [];
    for (const profile of profiles) {
      instances.push({
        accountId: profile.accountId,
        http: { ...profile.http, reachable: await probeTcp(profile.http.host, profile.http.port, this.#probeTimeoutMs) },
        ws: { ...profile.ws, reachable: await probeTcp(profile.ws.host, profile.ws.port, this.#probeTimeoutMs) }
      });
    }

    const webui = runtime
      ? {
          host: runtime.webuiHost,
          port: runtime.webuiPort,
          hasToken: false,
          reachable: await probeTcp(runtime.webuiHost, runtime.webuiPort, this.#probeTimeoutMs)
        }
      : undefined;

    return {
      backend: this.kind,
      ok: Boolean(runtime) && profiles.length > 0,
      warnings,
      instances,
      ...(webui ? { webui } : {})
    };
  }

  async start(spec: InstanceSpec, signal?: AbortSignal): Promise<RuntimeEndpoints> {
    signal?.throwIfAborted();
    const profiles = await listProfiles(this.#runtimeDir);
    if (profiles.length === 0) {
      throw new BackendError('snowluma_no_profile', `no onebot_<uin>.json under ${this.#runtimeDir}`, {
        retryable: false
      });
    }
    const wanted = spec.accountId ?? this.#accountId;
    const profile = wanted ? profiles.find((p) => p.accountId === wanted) : profiles.length === 1 ? profiles[0] : undefined;
    if (!profile) {
      throw new BackendError(
        'snowluma_profile_ambiguous',
        wanted
          ? `profile for account ${wanted} not found (have ${profiles.map((p) => p.accountId).join(', ')})`
          : `multiple profiles and no accountId selected: ${profiles.map((p) => p.accountId).join(', ')}`,
        { retryable: false }
      );
    }
    this.#assertEndpointTrusted(profile);

    const tokens = await readProfileTokens(profile);
    if (!this.#allowTokenless && (!tokens.wsToken || !tokens.httpToken)) {
      throw new BackendError(
        'snowluma_token_missing',
        `profile ${profile.accountId} has no accessToken; set one or explicitly allow tokenless local runtime`,
        { retryable: false }
      );
    }

    const reachable = await probeTcp(profile.ws.host, profile.ws.port, this.#probeTimeoutMs, signal);
    signal?.throwIfAborted();
    if (!reachable) {
      throw new BackendError(
        'snowluma_unreachable',
        `ws endpoint ${formatHostPort(profile.ws.host, profile.ws.port)} is not accepting connections (login required?)`
      );
    }

    this.#attached.set(profile.accountId, profile);
    this.#sessions.set(spec.id, profile.accountId);
    this.#logger.info('attached to snowluma profile', {
      accountId: profile.accountId,
      ws: formatHostPort(profile.ws.host, profile.ws.port),
      http: formatHostPort(profile.http.host, profile.http.port)
    });
    return {
      httpBaseUrl: `http://${formatHostPort(profile.http.host, profile.http.port)}`,
      wsUrl: `ws://${formatHostPort(profile.ws.host, profile.ws.port)}/`,
      httpToken: tokens.httpToken || undefined,
      wsToken: tokens.wsToken || undefined
    };
  }

  async stop(spec?: InstanceSpec): Promise<void> {
    // attach 模式：不拥有进程，只断开自己的引用。
    if (!spec) {
      this.#attached.clear();
      this.#sessions.clear();
      return;
    }
    const accountId = spec.accountId ?? this.#sessions.get(spec.id);
    if (accountId) this.#attached.delete(accountId);
    this.#sessions.delete(spec.id);
  }

  async status(spec?: InstanceSpec): Promise<BackendStatus> {
    const accountId = spec?.accountId ?? (spec ? this.#sessions.get(spec.id) : undefined);
    const profile = accountId ? this.#attached.get(accountId) : this.#attached.values().next().value;
    if (!profile) return { running: false };
    const running = await probeTcp(profile.ws.host, profile.ws.port, this.#probeTimeoutMs);
    return { running, detail: { accountId: profile.accountId, wsPort: profile.ws.port } };
  }

  async dispose(): Promise<void> {
    this.#attached.clear();
    this.#sessions.clear();
  }

  #assertEndpointTrusted(profile: SnowLumaProfile): void {
    for (const [label, endpoint] of [['http', profile.http], ['ws', profile.ws]] as const) {
      if (!isLoopbackHost(endpoint.host)) {
        throw new BackendError(
          'snowluma_non_loopback',
          `${profile.accountId} ${label} endpoint ${formatHostPort(endpoint.host, endpoint.port)} is not loopback`,
          { retryable: false }
        );
      }
    }
  }
}
