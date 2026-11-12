const cache = new Map();
/** 每个供应商的缓存代次：换密钥等失效操作会让在途探测无法写回。 */
const epochs = new Map();
let version = 0;
const listeners = new Set();

export function providerCacheKey(resource) {
  const value = resource ?? {};
  const config = value.config ?? {};
  const credential = value.credential;
  return [
    String(value.resourceId ?? ''),
    String(config.protocol ?? ''),
    String(config.baseUrl ?? ''),
    credential
      ? `${String(credential.status ?? '')}:${String(credential.reference ?? '')}`
      : '',
  ].join('|');
}

export function readModelCache(key) {
  const entry = cache.get(key);
  return entry === undefined ? null : [...entry];
}

export function writeModelCache(key, models) {
  cache.set(key, [...models]);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeModelCache(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getModelCacheVersion() {
  return version;
}

export function getModelCacheEpoch(key) {
  return epochs.get(key) ?? 0;
}

export function clearModelCache(key) {
  cache.delete(key);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  version += 1;
  for (const listener of [...listeners]) listener();
}
