import path from 'node:path';
import { BackendError, errorRetryable } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type {
  BackendCapabilities,
  BackendFactory,
  BackendStatus,
  InjectionBackend,
  ProbeReport,
  RuntimeEndpoints
} from '../injection/contract.js';
import type { InstanceSpec, NormalizedInstanceSpec } from './spec.js';

interface CircuitState {
  scope: string;
  failures: number;
  openUntil: number;
  lastError?: { code: string; message: string; at: number; retryable: boolean };
}

interface RuntimeRecord {
  key: string;
  backend: InjectionBackend;
  refs: number;
  circuits: Map<string, CircuitState>;
}

export interface RuntimeRegistryOptions {
  backendFactory: BackendFactory;
  logger: Logger;
  now?: () => number;
}

export interface RuntimeSnapshot {
  key: string;
  refs: number;
  circuits: CircuitState[];
}

export function runtimeKeyFor(spec: NormalizedInstanceSpec): string {
  if (spec.runtimeId) return `runtime:${spec.runtimeId}`;
  if (spec.backend === 'snowluma') return `snowluma:${path.resolve(spec.runtimeDir ?? '')}`;
  return `fake:${spec.id}`;
}

/**
 * Runtime 是比实例更重的资源：多个账号会话可以共享同一个 runtime。
 * backend 按 runtime 共享，熔断按账号隔离，避免一个号的 WS 掉线拖累同 runtime 的其他号。
 */
export class RuntimeRegistry {
  readonly #backendFactory: BackendFactory;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #records = new Map<string, RuntimeRecord>();
  #disposed = false;

  constructor(options: RuntimeRegistryOptions) {
    this.#backendFactory = options.backendFactory;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  acquire(spec: NormalizedInstanceSpec, deps: { logger: Logger }): RuntimeLease {
    if (this.#disposed) throw new BackendError('runtime_registry_closed', 'runtime registry is closed', { retryable: false });
    const key = runtimeKeyFor(spec);
    let record = this.#records.get(key);
    if (!record) {
      const backend = this.#backendFactory(spec, deps);
      record = { key, backend, refs: 0, circuits: new Map() };
      this.#records.set(key, record);
      this.#logger.debug('runtime created', { runtimeKey: key, backend: backend.kind });
    }
    record.refs += 1;
    return new RuntimeLease(this, record);
  }

  async start(record: RuntimeRecord, spec: InstanceSpec, signal?: AbortSignal): Promise<RuntimeEndpoints> {
    const circuitKey = this.#circuitKey(spec);
    this.#assertAttemptAllowed(record, circuitKey);
    try {
      const endpoints = await record.backend.start(spec, signal);
      this.#reportSuccess(record, circuitKey);
      return endpoints;
    } catch (error) {
      this.#reportFailure(record, circuitKey, error);
      throw error;
    }
  }

  async stop(record: RuntimeRecord, spec?: InstanceSpec): Promise<void> {
    await record.backend.stop(spec);
  }

  async status(record: RuntimeRecord, spec?: InstanceSpec): Promise<BackendStatus> {
    const circuitKey = this.#circuitKey(spec);
    try {
      const status = await record.backend.status(spec);
      if (!status.running) {
        this.#reportFailure(record, circuitKey, new BackendError('runtime_not_running', `runtime ${record.key} is not running`));
      } else {
        this.#reportSuccess(record, circuitKey);
      }
      return status;
    } catch (error) {
      this.#reportFailure(record, circuitKey, error);
      throw error;
    }
  }

  async release(record: RuntimeRecord, lease: RuntimeLease): Promise<void> {
    if (!lease.markReleased()) return;
    record.refs = Math.max(0, record.refs - 1);
    if (record.refs > 0) return;
    this.#records.delete(record.key);
    await record.backend.dispose?.().catch((error: unknown) => {
      this.#logger.warn('runtime dispose failed', {
        runtimeKey: record.key,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  canAttempt(key: string, accountId?: string): boolean {
    const record = this.#records.get(key);
    if (!record) return true;
    const circuit = record.circuits.get(accountId ?? '*');
    return !circuit || this.#now() >= circuit.openUntil;
  }

  cooldownRemaining(key: string, accountId?: string): number {
    const record = this.#records.get(key);
    if (!record) return 0;
    const circuit = record.circuits.get(accountId ?? '*');
    return circuit ? Math.max(0, circuit.openUntil - this.#now()) : 0;
  }

  snapshot(): RuntimeSnapshot[] {
    return [...this.#records.values()].map((record) => ({
      key: record.key,
      refs: record.refs,
      circuits: [...record.circuits.values()]
    }));
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const records = [...this.#records.values()];
    this.#records.clear();
    await Promise.allSettled(records.map((record) => record.backend.dispose?.()));
  }

  #circuitKey(spec?: InstanceSpec): string {
    return spec?.accountId ?? '*';
  }

  #assertAttemptAllowed(record: RuntimeRecord, circuitKey: string): void {
    const circuit = record.circuits.get(circuitKey);
    if (!circuit || this.#now() >= circuit.openUntil) return;
    throw new BackendError(
      'runtime_circuit_open',
      `account ${circuitKey} on runtime ${record.key} is cooling down for ${circuit.openUntil - this.#now()}ms`
    );
  }

  #reportSuccess(record: RuntimeRecord, circuitKey: string): void {
    record.circuits.delete(circuitKey);
  }

  #reportFailure(record: RuntimeRecord, circuitKey: string, error: unknown): void {
    const retryable = errorRetryable(error);
    const existing = record.circuits.get(circuitKey);
    const failures = (existing?.failures ?? 0) + 1;
    const now = this.#now();
    const circuit: CircuitState = {
      scope: circuitKey,
      failures,
      openUntil: existing?.openUntil ?? 0,
      lastError: {
        code: error instanceof BackendError ? error.code : 'runtime_failed',
        message: error instanceof Error ? error.message : String(error),
        at: now,
        retryable
      }
    };
    if (retryable) {
      const backoff = Math.min(30_000, 500 * 2 ** Math.min(6, failures - 1));
      circuit.openUntil = Math.max(circuit.openUntil, now + backoff);
    }
    record.circuits.set(circuitKey, circuit);
  }
}

export class RuntimeLease implements InjectionBackend {
  readonly #registry: RuntimeRegistry;
  readonly #record: RuntimeRecord;
  #released = false;

  constructor(registry: RuntimeRegistry, record: RuntimeRecord) {
    this.#registry = registry;
    this.#record = record;
  }

  get key(): string {
    return this.#record.key;
  }

  get kind(): string {
    return this.#record.backend.kind;
  }

  get capabilities(): BackendCapabilities {
    return this.#record.backend.capabilities;
  }

  probe(): Promise<ProbeReport> {
    return this.#record.backend.probe();
  }

  start(spec: InstanceSpec, signal?: AbortSignal): Promise<RuntimeEndpoints> {
    return this.#registry.start(this.#record, spec, signal);
  }

  stop(spec?: InstanceSpec): Promise<void> {
    return this.#registry.stop(this.#record, spec);
  }

  status(spec?: InstanceSpec): Promise<BackendStatus> {
    return this.#registry.status(this.#record, spec);
  }

  release(): Promise<void> {
    return this.#registry.release(this.#record, this);
  }

  markReleased(): boolean {
    if (this.#released) return false;
    this.#released = true;
    return true;
  }
}
