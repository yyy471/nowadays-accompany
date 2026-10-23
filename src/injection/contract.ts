import type { InstanceSpec, NormalizedInstanceSpec } from '../instances/spec.js';
import type { Logger } from '../core/logger.js';

export interface RuntimeEndpoints {
  httpBaseUrl: string;
  wsUrl: string;
  httpToken?: string;
  wsToken?: string;
}

export interface BackendCapabilities {
  /** 能否由核心拉起 QQ/注入运行时 */
  launch: boolean;
  /** 能否附着到已在运行的运行时 */
  attach: boolean;
  /** 是否天然支持多实例（每实例独立运行时/端口） */
  multiInstance: boolean;
}

export interface ProbeEndpoint {
  host: string;
  port: number;
  hasToken: boolean;
  reachable?: boolean;
}

export interface ProbeInstance {
  accountId: string;
  http: ProbeEndpoint;
  ws: ProbeEndpoint;
}

export interface ProbeReport {
  backend: string;
  ok: boolean;
  warnings: string[];
  instances: ProbeInstance[];
  webui?: ProbeEndpoint;
}

export interface BackendStatus {
  running: boolean;
  detail?: Record<string, unknown>;
}

/**
 * 一个 backend 对象服务一个 runtime。SnowLuma 这类 runtime 可以被多个账号会话共享；
 * 具体会话的 attach/detach 通过 start/stop 传入的 spec 区分。
 */
export interface InjectionBackend {
  readonly kind: string;
  readonly capabilities: BackendCapabilities;
  probe(): Promise<ProbeReport>;
  start(spec: InstanceSpec, signal?: AbortSignal): Promise<RuntimeEndpoints>;
  stop(spec?: InstanceSpec): Promise<void>;
  status(spec?: InstanceSpec): Promise<BackendStatus>;
  dispose?(): Promise<void>;
}

export interface BackendFactoryDeps {
  logger: Logger;
}

export type BackendFactory = (spec: NormalizedInstanceSpec, deps: BackendFactoryDeps) => InjectionBackend;
