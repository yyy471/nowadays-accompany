const cache = new Map();
/** 每个生图服务的缓存代次：换密钥/改站点或失效操作后，在途探测不得写回旧结果。 */
const epochs = new Map();
let version = 0;
const listeners = new Set();

export function imageServiceCacheKey(service) {
  const value = service ?? {};
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

export function readImageModelCache(key) {
  const entry = cache.get(key);
  return entry === undefined ? null : [...entry];
}

export function writeImageModelCache(key, models) {
  cache.set(key, [...models]);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeImageModelCache(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getImageModelCacheVersion() {
  return version;
}

export function getImageModelCacheEpoch(key) {
  return epochs.get(key) ?? 0;
}

export function clearImageModelCache(key) {
  cache.delete(key);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  version += 1;
  for (const listener of [...listeners]) listener();
}
