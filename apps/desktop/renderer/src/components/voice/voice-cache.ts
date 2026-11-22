import type { VoiceProbeResult } from '../../voice-config';

const cache = new Map<string, VoiceProbeResult | null>();
/** 全局语音服务的探测结果缓存与失效代次，避免改地址／停用前在途探测回写。 */
const epochs = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();

interface VoiceCacheServiceLike {
  serviceId?: unknown;
  config?: {
    protocol?: unknown;
    baseUrl?: unknown;
  } | null;
}

export function voiceServiceCacheKey(service: unknown): string {
  const value = (service ?? {}) as VoiceCacheServiceLike;
  const config = value.config ?? {};
  return [
    String(value.serviceId ?? ""),
    String(config.protocol ?? "nowadays-tts-v1"),
    String(config.baseUrl ?? ""),
  ].join("|");
}

export function readVoiceProbeCache(key: string): VoiceProbeResult | null {
  return cache.get(key) ?? null;
}

export function writeVoiceProbeCache(key: string, probe: VoiceProbeResult | null): void {
  cache.set(key, probe ?? null);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function clearVoiceProbeCache(key: string): void {
  cache.delete(key);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function getVoiceProbeCacheEpoch(key: string): number {
  return epochs.get(key) ?? 0;
}

export function getVoiceProbeCacheVersion(): number {
  return version;
}

export function subscribeVoiceProbeCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
