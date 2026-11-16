import type { VoiceProbeResult } from '../../voice-config.js';

export function voiceServiceCacheKey(service: unknown): string;
export function readVoiceProbeCache(key: string): VoiceProbeResult | null;
export function writeVoiceProbeCache(key: string, probe: VoiceProbeResult | null): void;
export function clearVoiceProbeCache(key: string): void;
export function getVoiceProbeCacheEpoch(key: string): number;
export function getVoiceProbeCacheVersion(): number;
export function subscribeVoiceProbeCache(listener: () => void): () => void;
