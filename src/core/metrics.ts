export type MetricLabels = Record<string, string | number | boolean | undefined>;

export class Metrics {
  readonly #values = new Map<string, number>();

  inc(name: string, value = 1, labels?: MetricLabels): void {
    const key = metricKey(name, labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + value);
  }

  set(name: string, value: number, labels?: MetricLabels): void {
    this.#values.set(metricKey(name, labels), value);
  }

  get(name: string, labels?: MetricLabels): number {
    return this.#values.get(metricKey(name, labels)) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.#values.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  clear(): void {
    this.#values.clear();
  }
}

function metricKey(name: string, labels?: MetricLabels): string {
  if (!labels) return name;
  const parts = Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
}
