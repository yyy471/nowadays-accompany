const cache = new Map<string, string[]>();
/** 每个生图服务的缓存代次：换密钥/改站点或失效操作后，在途探测不得写回旧结果。 */
const epochs = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();

interface ImageCacheServiceLike {
  serviceId?: unknown;
  config?: {
    protocol?: unknown;
    baseUrl?: unknown;
    timeoutMs?: unknown;
  } | null;
  credential?: {
    status?: unknown;
    reference?: unknown;
  } | null;
}

export function imageServiceCacheKey(service: unknown): string {
  const value = (service ?? {}) as ImageCacheServiceLike;
  const config = value.config ?? {};
  const credential = value.credential;
  return [
    String(value.serviceId ?? ""),
    String(config.protocol ?? "comfyui"),
    String(config.baseUrl ?? ""),
    String(config.timeoutMs ?? ""),
    credential
      ? `${String(credential.status ?? "")}:${String(credential.reference ?? "")}`
      : "",
  ].join("|");
}

export function readImageModelCache(key: string): string[] | null {
  const entry = cache.get(key);
  return entry === undefined ? null : [...entry];
}

export function writeImageModelCache(key: string, models: readonly string[]): void {
  cache.set(key, [...models]);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeImageModelCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getImageModelCacheVersion(): number {
  return version;
}

export function getImageModelCacheEpoch(key: string): number {
  return epochs.get(key) ?? 0;
}

export function clearImageModelCache(key: string): void {
  cache.delete(key);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  version += 1;
  for (const listener of [...listeners]) listener();
}
