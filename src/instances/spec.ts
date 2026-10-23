import { InvalidSpecError } from '../core/errors.js';
import { assertIdentifier } from '../routing/identity.js';
import type { InstanceState } from '../core/state.js';
import type { ProfileSummary } from '../artifacts/types.js';

export interface RestartPolicy {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface InstancePorts {
  http?: number;
  ws?: number;
}

export interface InstanceSpec {
  /** 逻辑实例 id，同时是数据目录名 */
  id: string;
  /** 该实例对应的 QQ 号；登录后可能被通道回报覆盖校验 */
  accountId?: string;
  backend: 'snowluma' | 'fake';
  /** SnowLuma runtime 目录（backend=snowluma 时必填） */
  runtimeDir?: string;
  /** 显式声明共享 runtime 的身份；默认 snowluma 按 runtimeDir 聚合，fake 按实例隔离 */
  runtimeId?: string;
  /** 数据根目录下的子目录覆盖；默认 <dataRoot>/instances/<id> */
  dataDir?: string;
  ports?: InstancePorts;
  /** 允许的 selfId 集合，用于回环判定；登录后可再追加 */
  selfIds?: string[];
  restart?: Partial<RestartPolicy>;
  /** 后端私有参数（fake 用它注入失败/延迟） */
  backendOptions?: Record<string, unknown>;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  enabled: true,
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000
};

export interface NormalizedInstanceSpec extends InstanceSpec {
  restart: RestartPolicy;
  selfIds: string[];
}

export function normalizeSpec(spec: InstanceSpec): NormalizedInstanceSpec {
  if (!spec || typeof spec !== 'object') throw new InvalidSpecError('instance spec must be an object');
  const id = assertIdentifier(spec.id, 'instance id');
  if (spec.backend !== 'snowluma' && spec.backend !== 'fake') {
    throw new InvalidSpecError(`instance ${id}: backend must be snowluma or fake`);
  }
  if (spec.backend === 'snowluma' && !spec.runtimeDir) {
    throw new InvalidSpecError(`instance ${id}: runtimeDir is required for snowluma backend`);
  }
  if (spec.accountId !== undefined) assertIdentifier(spec.accountId, 'accountId');
  if (spec.runtimeId !== undefined) assertIdentifier(spec.runtimeId, 'runtimeId');
  for (const selfId of spec.selfIds ?? []) assertIdentifier(selfId, 'selfId');
  for (const port of [spec.ports?.http, spec.ports?.ws]) {
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new InvalidSpecError(`instance ${id}: invalid port ${String(port)}`);
    }
  }
  return {
    ...spec,
    id,
    restart: { ...DEFAULT_RESTART_POLICY, ...spec.restart },
    selfIds: [...(spec.selfIds ?? [])]
  };
}

export interface InstanceStatus {
  id: string;
  accountId?: string;
  backend: InstanceSpec['backend'];
  runtimeKey?: string;
  desiredState?: 'running' | 'stopped';
  state: InstanceState;
  selfIds: string[];
  connected: boolean;
  endpoints?: { httpBaseUrl: string; wsUrl: string };
  ingress?: { pending: number; paused: boolean };
  egress?: { pending: number };
  restartAttempts: number;
  sessionEpoch?: number;
  hostEpoch?: number;
  profileFingerprint?: string;
  agent?: { mode: 'agent' | 'plugins' | 'custom'; configured: boolean };
  lastError?: { code: string; message: string; at: number; retryable?: boolean };
  profileState?: 'idle' | 'loading' | 'ready' | 'missing';
  profile?: ProfileSummary;
  profileError?: string;
  /** 账号级策略是否暂停了自动处理；暂停仍保留连接与历史接收。 */
  automaticPaused?: boolean;
}
