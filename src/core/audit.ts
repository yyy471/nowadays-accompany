export interface AuditRecord {
  at: number;
  action: string;
  ok: boolean;
  requestId?: string;
  instanceId?: string;
  remote?: string;
  detail?: Record<string, unknown>;
}

export class AuditLog {
  readonly #max: number;
  readonly #items: AuditRecord[] = [];

  constructor(max = 512) {
    this.#max = Math.max(1, max);
  }

  record(record: AuditRecord): void {
    this.#items.push(record);
    if (this.#items.length > this.#max) this.#items.shift();
  }

  recent(limit = 50): AuditRecord[] {
    if (limit <= 0) return [];
    return this.#items.slice(-limit);
  }

  clear(): void {
    this.#items.length = 0;
  }
}
