const cache = new Map();
/** 全局语音服务的探测结果缓存与失效代次，避免改地址／停用前在途探测回写。 */
const epochs = new Map();
let version = 0;
const listeners = new Set();

export function voiceServiceCacheKey(service) {
  const value = service ?? {};
  const config = value.config ?? {};
  return [
    String(value.serviceId ?? ""),
    String(config.protocol ?? "nowadays-tts-v1"),
    String(config.baseUrl ?? ""),
  ].join("|");
}

export function readVoiceProbeCache(key) {
  return cache.get(key) ?? null;
}

export function writeVoiceProbeCache(key, probe) {
  cache.set(key, probe ?? null);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function clearVoiceProbeCache(key) {
  cache.delete(key);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function getVoiceProbeCacheEpoch(key) {
  return epochs.get(key) ?? 0;
}

export function getVoiceProbeCacheVersion() {
  return version;
}

export function subscribeVoiceProbeCache(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
