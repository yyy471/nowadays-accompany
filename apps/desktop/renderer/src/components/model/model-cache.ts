const cache = new Map<string, string[]>();
/** 每个供应商的缓存代次：换密钥等失效操作会让在途探测无法写回。 */
const epochs = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();

interface ModelCacheResourceLike {
  resourceId?: unknown;
  config?: {
    protocol?: unknown;
    provider?: unknown;
    baseUrl?: unknown;
  } | null;
  credential?: {
    status?: unknown;
    reference?: unknown;
  } | null;
}

export function providerCacheKey(resource: unknown): string {
  const value = (resource ?? {}) as ModelCacheResourceLike;
  const config = value.config ?? {};
  const credential = value.credential;
  return [
    String(value.resourceId ?? ''),
    String(config.protocol ?? ''),
    String(config.provider ?? ''),
    String(config.baseUrl ?? ''),
    credential
      ? `${String(credential.status ?? '')}:${String(credential.reference ?? '')}`
      : '',
  ].join('|');
}

export function readModelCache(key: string): string[] | null {
  const entry = cache.get(key);
  return entry === undefined ? null : [...entry];
}

export function writeModelCache(key: string, models: readonly string[]): void {
  cache.set(key, [...models]);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeModelCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getModelCacheVersion(): number {
  return version;
}

export function getModelCacheEpoch(key: string): number {
  return epochs.get(key) ?? 0;
}

export function clearModelCache(key: string): void {
  cache.delete(key);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  version += 1;
  for (const listener of [...listeners]) listener();
}
