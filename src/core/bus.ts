export type EventHandler<T> = (payload: T) => void;

export interface TypedEventBusOptions {
  onHandlerError?: (error: unknown, info: { type: string; handlerCount: number }) => void;
}

export class TypedEventBus<Events extends Record<string, unknown>> {
  readonly #handlers = new Map<keyof Events, Set<EventHandler<never>>>();
  readonly #anyHandlers = new Set<(type: keyof Events, payload: unknown) => void>();
  readonly #onHandlerError?: TypedEventBusOptions['onHandlerError'];

  constructor(options: TypedEventBusOptions = {}) {
    this.#onHandlerError = options.onHandlerError;
  }

  on<K extends keyof Events>(type: K, handler: EventHandler<Events[K]>): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler as EventHandler<never>);
    return () => {
      set?.delete(handler as EventHandler<never>);
    };
  }

  onAny(handler: (type: keyof Events, payload: unknown) => void): () => void {
    this.#anyHandlers.add(handler);
    return () => {
      this.#anyHandlers.delete(handler);
    };
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.#handlers.get(type);
    if (set) {
      for (const handler of [...set]) {
        try {
          (handler as EventHandler<Events[K]>)(payload);
        } catch (error) {
          this.#onHandlerError?.(error, { type: String(type), handlerCount: set.size });
        }
      }
    }
    for (const handler of [...this.#anyHandlers]) {
      try {
        handler(type, payload);
      } catch (error) {
        this.#onHandlerError?.(error, { type: String(type), handlerCount: this.#anyHandlers.size });
      }
    }
  }

  clear(): void {
    this.#handlers.clear();
    this.#anyHandlers.clear();
  }
}
