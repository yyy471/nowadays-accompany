import type { Logger } from '../../core/logger.js';

export type LifecyclePhase = 'stop' | 'drain' | 'dispose';

interface LifecycleStep {
  name: string;
  run: () => Promise<void> | void;
}

export interface RuntimeLifecycleOptions {
  logger: Logger;
}

/**
 * 运行容器关闭顺序：stop（拒绝新工作/停定时器）→ drain（排空在途）
 * → dispose（释放依赖）。步骤只登记一次，close() 幂等；单个步骤失败只记录，
 * 不让后续资源释放被跳过。
 */
export class RuntimeLifecycle {
  readonly #logger: Logger;
  readonly #steps: Record<LifecyclePhase, LifecycleStep[]> = { stop: [], drain: [], dispose: [] };
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(options: RuntimeLifecycleOptions) {
    this.#logger = options.logger;
  }

  add(phase: LifecyclePhase, name: string, run: () => Promise<void> | void): void {
    if (this.#closing) throw new Error(`cannot add lifecycle step ${name} after close`);
    this.#steps[phase].push({ name, run });
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#run();
    return this.#closing;
  }

  async #run(): Promise<void> {
    for (const phase of ['stop', 'drain', 'dispose'] as const) {
      for (const step of this.#steps[phase]) {
        try {
          await step.run();
        } catch (error) {
          this.#logger.warn('lifecycle step failed', {
            phase,
            step: step.name,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    this.#closed = true;
  }
}
