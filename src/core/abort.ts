export class AbortScope {
  readonly #controller = new AbortController();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get aborted(): boolean {
    return this.#controller.signal.aborted;
  }

  abort(reason?: unknown): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }

  throwIfAborted(): void {
    if (this.#controller.signal.aborted) {
      throw this.#controller.signal.reason instanceof Error
        ? this.#controller.signal.reason
        : new Error('operation aborted');
    }
  }

  /** 组合外部取消与单次超时，避免两套 signal 在调用点手工合并。 */
  timeout(ms: number): AbortSignal {
    return AbortSignal.any([this.#controller.signal, AbortSignal.timeout(ms)]);
  }
}
