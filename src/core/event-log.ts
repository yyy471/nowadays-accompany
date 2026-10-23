export interface LoggedEvent {
  id: number;
  type: string;
  payload: unknown;
  at: number;
}

export type EventLogListener = (event: LoggedEvent) => void;

/** 有界事件日志：既是 SSE 的续传来源，也是观测侧的唯一事件序号。 */
export class EventLog {
  readonly #max: number;
  readonly #items: LoggedEvent[] = [];
  readonly #listeners = new Set<EventLogListener>();
  #nextId = 1;

  constructor(max = 1024) {
    this.#max = Math.max(1, max);
  }

  get latestId(): number {
    return this.#nextId - 1;
  }

  append(type: string, payload: unknown, at = Date.now()): LoggedEvent {
    const event: LoggedEvent = { id: this.#nextId, type, payload, at };
    this.#nextId += 1;
    this.#items.push(event);
    if (this.#items.length > this.#max) this.#items.shift();
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // 事件日志是观测面，单个订阅者失败不能反过来影响数据面。
      }
    }
    return event;
  }

  since(id: number): LoggedEvent[] {
    return this.#items.filter((event) => event.id > id);
  }

  onAppend(listener: EventLogListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  clear(): void {
    this.#items.length = 0;
    this.#listeners.clear();
  }
}
