import { BackendError } from '../core/errors.js';
import { sleep } from '../core/concurrency.js';
import type { InstanceSpec } from '../instances/spec.js';
import type {
  BackendCapabilities,
  BackendStatus,
  InjectionBackend,
  ProbeReport,
  RuntimeEndpoints
} from './contract.js';

export interface FakeBackendOptions {
  /** 启动时直接抛错（用于验证监督器隔离） */
  failOnStart?: boolean;
  /** 启动成功后在指定毫秒数后进入失败（模拟运行时崩溃） */
  crashAfterMs?: number;
  startupDelayMs?: number;
  httpPort?: number;
  wsPort?: number;
  selfId?: string;
}

/**
 * 假注入后端：模拟“拉起一个独立进程”的生命周期，含独立 pid 与端口。
 * 用于在没有 QQ 的环境里跑通编排、隔离与重启逻辑。
 */
export class FakeInjectionBackend implements InjectionBackend {
  readonly kind = 'fake';
  readonly capabilities: BackendCapabilities = { launch: true, attach: false, multiInstance: true };

  readonly #options: FakeBackendOptions;
  readonly #onCrash?: (error: BackendError) => void;
  #pid: number | undefined;
  #running = false;
  #crashTimer: NodeJS.Timeout | undefined;
  #endpoints: RuntimeEndpoints | undefined;

  constructor(options: FakeBackendOptions = {}, onCrash?: (error: BackendError) => void) {
    this.#options = options;
    this.#onCrash = onCrash;
  }

  async probe(): Promise<ProbeReport> {
    return {
      backend: this.kind,
      ok: true,
      warnings: [],
      instances: []
    };
  }

  async start(spec: InstanceSpec, signal?: AbortSignal): Promise<RuntimeEndpoints> {
    if (this.#options.failOnStart) {
      throw new BackendError('fake_start_failed', `fake backend refused to start ${spec.id}`);
    }
    signal?.throwIfAborted();
    if (this.#options.startupDelayMs) {
      await sleep(this.#options.startupDelayMs, signal);
    }
    signal?.throwIfAborted();
    this.#pid = 10_000 + Math.floor(Math.random() * 40_000);
    this.#running = true;
    const httpPort = this.#options.httpPort ?? spec.ports?.http ?? 3000;
    const wsPort = this.#options.wsPort ?? spec.ports?.ws ?? 3001;
    this.#endpoints = {
      httpBaseUrl: `http://127.0.0.1:${httpPort}`,
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      httpToken: 'fake-http-token',
      wsToken: 'fake-ws-token'
    };
    if (this.#options.crashAfterMs) {
      this.#crashTimer = setTimeout(() => {
        this.#running = false;
        this.#onCrash?.(new BackendError('fake_crashed', `fake backend for ${spec.id} crashed`));
      }, this.#options.crashAfterMs);
      this.#crashTimer.unref?.();
    }
    return this.#endpoints;
  }

  async stop(_spec?: InstanceSpec): Promise<void> {
    if (this.#crashTimer) clearTimeout(this.#crashTimer);
    this.#crashTimer = undefined;
    this.#running = false;
    this.#pid = undefined;
    this.#endpoints = undefined;
  }

  async status(_spec?: InstanceSpec): Promise<BackendStatus> {
    return { running: this.#running, detail: { pid: this.#pid, endpoints: this.#endpoints } };
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}
