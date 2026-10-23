import type { TypedEventBus } from '../core/bus.js';
import type { CoreEvents } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { InvalidSpecError } from '../core/errors.js';
import { Semaphore } from '../core/concurrency.js';
import type { Metrics } from '../core/metrics.js';
import { DEFAULT_LIMITS, type Limits } from '../core/limits.js';
import type { DesiredStateStore } from '../storage/desired-state.js';
import type { QqInstance } from './instance.js';
import type { InstanceSpec, InstanceStatus, NormalizedInstanceSpec } from './spec.js';
import { normalizeSpec } from './spec.js';
import type { RuntimeRegistry } from './runtime-registry.js';

export interface SupervisorOptions {
  bus: TypedEventBus<CoreEvents>;
  logger: Logger;
  createInstance: (spec: NormalizedInstanceSpec) => QqInstance;
  now?: () => number;
  limits?: Limits;
  metrics?: Metrics;
  desiredStore?: DesiredStateStore;
  runtimeRegistry?: RuntimeRegistry;
}

export interface StartAllResult {
  started: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * 多实例收敛器：
 * - desired 状态持久化，observed 状态在内存；启动/tick/失败事件都触发收敛
 * - 每个实例一条操作链，start/stop/restart 不会并发打架
 * - 失败按各自 RestartPolicy 退避重启，带抖动、全局并发上限与 runtime 熔断
 */
export class InstanceSupervisor {
  readonly #instances = new Map<string, QqInstance>();
  readonly #restartTimers = new Map<string, NodeJS.Timeout>();
  readonly #attempts = new Map<string, number>();
  readonly #desired = new Map<string, 'running' | 'stopped'>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #bus: TypedEventBus<CoreEvents>;
  readonly #logger: Logger;
  readonly #createInstance: SupervisorOptions['createInstance'];
  readonly #now: () => number;
  readonly #limits: Limits;
  readonly #metrics?: Metrics;
  readonly #desiredStore?: DesiredStateStore;
  readonly #runtimeRegistry?: RuntimeRegistry;
  readonly #startSemaphore: Semaphore;
  readonly #restartSemaphore: Semaphore;
  readonly #unsubscribe: () => void;
  #shuttingDown = false;
  #disposed = false;

  constructor(options: SupervisorOptions) {
    this.#bus = options.bus;
    this.#logger = options.logger;
    this.#createInstance = options.createInstance;
    this.#now = options.now ?? Date.now;
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    this.#metrics = options.metrics;
    this.#desiredStore = options.desiredStore;
    this.#runtimeRegistry = options.runtimeRegistry;
    this.#startSemaphore = new Semaphore(this.#limits.startConcurrency);
    this.#restartSemaphore = new Semaphore(this.#limits.restartConcurrency);
    this.#unsubscribe = this.#bus.on('instance:state', (event) => this.#onInstanceState(event));
  }

  add(spec: InstanceSpec): QqInstance {
    const normalized = normalizeSpec(spec);
    if (this.#instances.has(normalized.id)) {
      throw new InvalidSpecError(`duplicate instance id: ${normalized.id}`);
    }
    if (this.#instances.size >= this.#limits.maxInstances) {
      throw new InvalidSpecError(`max instances (${this.#limits.maxInstances}) reached`);
    }
    const instance = this.#createInstance(normalized);
    const desired = this.#desiredStore?.get(normalized.id) ?? 'running';
    this.#desired.set(normalized.id, desired);
    instance.setDesiredState(desired);
    this.#instances.set(normalized.id, instance);
    this.#attempts.set(normalized.id, 0);
    return instance;
  }

  get(id: string): QqInstance | undefined {
    return this.#instances.get(id);
  }

  listSpecs(): InstanceSpec[] {
    return [...this.#instances.values()].map((instance) => structuredClone(instance.spec));
  }

  list(): InstanceStatus[] {
    return [...this.#instances.values()].map((instance) => {
      const status = instance.status();
      return {
        ...status,
        desiredState: this.#desired.get(instance.id) ?? status.desiredState,
        restartAttempts: this.#attempts.get(instance.id) ?? status.restartAttempts
      };
    });
  }

  /** 手工 start 是运维意图，会持久化 desired=running。 */
  async start(id: string): Promise<void> {
    this.#assertNotDisposed();
    const instance = this.#require(id);
    this.#shuttingDown = false;
    await this.#setDesired(id, 'running', true);
    this.#clearRestart(id);
    this.#attempts.set(id, 0);
    instance.setRestartAttempts(0);
    await this.#enqueue(id, () => this.#startNow(instance));
  }

  async startAll(): Promise<StartAllResult> {
    this.#assertNotDisposed();
    this.#shuttingDown = false;
    const result: StartAllResult = { started: [], failed: [] };
    const ids = [...this.#instances.keys()];
    const outcomes = await Promise.all(
      ids.map(async (id) => {
        const instance = this.#instances.get(id);
        if (!instance) return { id, ok: false as const, error: 'unknown instance' };
        const desired = this.#desiredStore?.get(id) ?? this.#desired.get(id) ?? 'running';
        this.#desired.set(id, desired);
        instance.setDesiredState(desired);
        if (desired === 'stopped') return { id, ok: true as const, skipped: true };
        this.#attempts.set(id, 0);
        instance.setRestartAttempts(0);
        try {
          await this.#enqueue(id, () => this.#startNow(instance));
          return { id, ok: true as const, skipped: false };
        } catch (error) {
          return { id, ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
      })
    );
    for (const outcome of outcomes) {
      if (outcome.ok) {
        if (!outcome.skipped) result.started.push(outcome.id);
      } else {
        result.failed.push({ id: outcome.id, error: outcome.error });
      }
    }
    return result;
  }

  /** 手工 stop 是运维意图，会持久化 desired=stopped。 */
  async stop(id: string): Promise<void> {
    this.#assertNotDisposed();
    const instance = this.#instances.get(id);
    if (!instance) return;
    await this.#setDesired(id, 'stopped', true);
    this.#clearRestart(id);
    this.#attempts.set(id, 0);
    instance.setRestartAttempts(0);
    instance.requestStop();
    await this.#enqueue(id, () => this.#stopNow(instance));
  }

  /** 进程退出用：只收敛到 stopped，不改变运维意图。 */
  async stopAll(): Promise<void> {
    this.#shuttingDown = true;
    for (const id of this.#instances.keys()) {
      this.#clearRestart(id);
      const instance = this.#instances.get(id);
      if (instance) {
        this.#desired.set(id, 'stopped');
        instance.setDesiredState('stopped');
        instance.requestStop();
      }
    }
    await Promise.allSettled(
      [...this.#instances.values()].map((instance) => this.#enqueue(instance.id, () => this.#stopNow(instance)))
    );
  }

  async remove(id: string): Promise<void> {
    this.#assertNotDisposed();
    const instance = this.#instances.get(id);
    if (!instance) return;
    if (!instance.state.is('stopped')) {
      throw new InvalidSpecError(`instance ${id} must be stopped before removal`);
    }
    this.#clearRestart(id);
    this.#attempts.delete(id);
    this.#desired.delete(id);
    this.#operations.delete(id);
    this.#instances.delete(id);
    await this.#desiredStore?.delete(id);
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
    for (const id of [...this.#restartTimers.keys()]) this.#clearRestart(id);
  }

  #require(id: string): QqInstance {
    const instance = this.#instances.get(id);
    if (!instance) throw new InvalidSpecError(`unknown instance: ${id}`);
    return instance;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new InvalidSpecError('supervisor is disposed');
  }

  async #setDesired(id: string, state: 'running' | 'stopped', persist: boolean): Promise<void> {
    this.#desired.set(id, state);
    this.#instances.get(id)?.setDesiredState(state);
    if (persist && this.#desiredStore) {
      await this.#desiredStore.set(id, state).catch((error: unknown) => {
        this.#logger.error('failed to persist desired state', {
          instanceId: id,
          state,
          message: error instanceof Error ? error.message : String(error)
        });
        throw error;
      });
    }
  }

  async #startNow(instance: QqInstance): Promise<void> {
    if (this.#desired.get(instance.id) !== 'running') return;
    if (instance.state.is('online', 'provisioning', 'starting', 'awaiting_login', 'degraded')) return;
    await this.#startSemaphore.run(async () => {
      // 等信号量期间可能已经被 stop，重新检查意图和状态。
      if (this.#desired.get(instance.id) !== 'running') return;
      if (!instance.state.is('stopped', 'failed')) return;
      await instance.start();
    });
    this.#logger.info('instance started', { instanceId: instance.id });
  }

  async #stopNow(instance: QqInstance): Promise<void> {
    if (instance.state.is('stopped')) return;
    await instance.stop();
    this.#logger.info('instance stopped', { instanceId: instance.id });
  }

  #onInstanceState(event: CoreEvents['instance:state']): void {
    const instance = this.#instances.get(event.instanceId);
    if (!instance) return;
    if (event.to === 'online') {
      this.#clearRestart(instance.id);
      this.#attempts.set(instance.id, 0);
      instance.setRestartAttempts(0);
      return;
    }
    if (event.to !== 'failed') return;
    if (this.#shuttingDown || this.#desired.get(instance.id) !== 'running') return;
    this.#scheduleRestart(instance);
  }

  #scheduleRestart(instance: QqInstance): void {
    if (this.#shuttingDown || this.#desired.get(instance.id) !== 'running') return;
    const policy = instance.spec.restart;
    if (!policy.enabled) return;
    if (this.#restartTimers.has(instance.id)) return;

    const retryable = instance.status().lastError?.retryable ?? true;
    if (!retryable) {
      this.#metrics?.inc('restart.suppressed', 1, { instance: instance.id });
      this.#bus.emit('instance:error', {
        instanceId: instance.id,
        code: 'restart_suppressed',
        message: 'failure is not retryable; manual intervention required',
        retryable: false,
        at: this.#now()
      });
      return;
    }

    const attempt = (this.#attempts.get(instance.id) ?? 0) + 1;
    this.#attempts.set(instance.id, attempt);
    instance.setRestartAttempts(attempt);
    if (attempt > policy.maxAttempts) {
      this.#logger.error('restart attempts exhausted', { instanceId: instance.id, attempts: attempt });
      this.#metrics?.inc('restart.exhausted', 1, { instance: instance.id });
      this.#bus.emit('instance:error', {
        instanceId: instance.id,
        code: 'restart_exhausted',
        message: `gave up after ${policy.maxAttempts} attempts`,
        retryable: false,
        at: this.#now()
      });
      return;
    }

    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    const jitter = 0.8 + Math.random() * 0.4;
    const circuit = this.#runtimeRegistry?.cooldownRemaining(instance.runtimeKey, instance.status().accountId) ?? 0;
    const delay = Math.max(Math.min(Math.round(exponential * jitter), policy.maxDelayMs), circuit);
    this.#logger.warn('scheduling restart', { instanceId: instance.id, attempt, delayMs: delay });
    this.#metrics?.inc('restart.scheduled', 1, { instance: instance.id });
    const timer = setTimeout(() => {
      this.#restartTimers.delete(instance.id);
      if (this.#shuttingDown || this.#desired.get(instance.id) !== 'running') return;
      if (instance.state.state !== 'failed') return;
      void this.#restartSemaphore
        .run(() => this.#enqueue(instance.id, () => this.#startNow(instance)))
        .catch((error: unknown) => {
          this.#logger.warn('restart failed', {
            instanceId: instance.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
    }, delay);
    timer.unref?.();
    this.#restartTimers.set(instance.id, timer);
  }

  #enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(id) ?? Promise.resolve();
    const run = previous.then(
      () => task(),
      () => task()
    );
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.#operations.set(id, settled);
    void settled.then(() => {
      if (this.#operations.get(id) === settled) this.#operations.delete(id);
    });
    return run;
  }

  #clearRestart(id: string): void {
    const timer = this.#restartTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#restartTimers.delete(id);
  }
}
