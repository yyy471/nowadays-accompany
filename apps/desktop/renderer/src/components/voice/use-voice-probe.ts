import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from '../../api';
import {
  describeVoiceFailure,
  summarizeProbe,
  toVoiceServiceConfig,
  type VoiceProbeResult,
  type VoiceProtocol,
} from '../../voice-config';
import {
  clearVoiceProbeCache,
  getVoiceProbeCacheEpoch,
  getVoiceProbeCacheVersion,
  readVoiceProbeCache,
  subscribeVoiceProbeCache,
  writeVoiceProbeCache,
} from './voice-cache';

export type VoiceProbeTarget =
  | {
      kind: 'draft';
      config: {
        protocol: VoiceProtocol;
        baseUrl: string;
        defaultEngine?: string;
      };
    }
  | {
      kind: 'savedService';
      serviceId: string;
      cacheKey?: string;
    };

export interface VoiceProbeNotice {
  kind: 'status' | 'alert';
  text: string;
  elapsedMs?: number;
  attempt: number;
}

export interface UseVoiceProbeOptions {
  shared?: boolean;
  onBeforeProbe?: () => void;
}

function voiceErrorText(reason: unknown): string {
  if (reason instanceof ApiError) {
    return describeVoiceFailure({ code: reason.code, message: reason.message });
  }
  if (reason instanceof Error) {
    return describeVoiceFailure({ message: reason.message });
  }
  return describeVoiceFailure({ message: String(reason) });
}

/**
 * 全局与角色共用语音连接测试与探测状态（逻辑与 useImageProbe 对齐）。
 * 后一次点击直接覆盖前一次日志；切换服务或离开页面自动清空日志并按代次丢弃晚到响应。
 */
export function useVoiceProbe(key: string, options: UseVoiceProbeOptions = {}) {
  const [result, setResult] = useState<VoiceProbeResult | null>(() =>
    options.shared ? readVoiceProbeCache(key) : null,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<VoiceProbeNotice | null>(null);
  const generation = useRef(0);
  const epochRef = useRef(getVoiceProbeCacheEpoch(key));
  const keyRef = useRef(key);
  keyRef.current = key;
  const hooksRef = useRef(options);
  hooksRef.current = options;

  const cacheVersion = useSyncExternalStore(
    subscribeVoiceProbeCache,
    getVoiceProbeCacheVersion,
  );

  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    setNotice(null);
    epochRef.current = getVoiceProbeCacheEpoch(key);
    setResult(options.shared ? readVoiceProbeCache(key) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, options.shared]);

  useEffect(() => {
    if (!options.shared) return;
    const epoch = getVoiceProbeCacheEpoch(key);
    if (epoch !== epochRef.current) {
      epochRef.current = epoch;
      generation.current += 1;
      setBusy(false);
      setNotice(null);
    }
    setResult(readVoiceProbeCache(key));
  }, [cacheVersion, options.shared, key]);

  const clearLog = useCallback(() => {
    setNotice(null);
  }, []);

  const cancelPending = useCallback(() => {
    generation.current += 1;
    setBusy(false);
    setNotice(null);
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    setBusy(false);
    setNotice(null);
    setResult(null);
  }, []);

  const run = useCallback(async (target: VoiceProbeTarget): Promise<VoiceProbeResult | null> => {
    hooksRef.current.onBeforeProbe?.();
    const currentGen = ++generation.current;
    const capturedKey = keyRef.current;
    const cacheKey = target.kind === 'savedService' ? target.cacheKey : undefined;
    const startEpoch = cacheKey ? getVoiceProbeCacheEpoch(cacheKey) : null;
    setBusy(true);
    setNotice(null);
    try {
      const response =
        target.kind === 'draft'
          ? await api<{ probe: VoiceProbeResult; elapsedMs?: number }>('/v1/voice-services/probe', {
              method: 'POST',
              body: { config: toVoiceServiceConfig(target.config) },
            })
          : await api<{ probe: VoiceProbeResult; elapsedMs?: number }>(
              `/v1/voice-services/${encodeURIComponent(target.serviceId)}/probe`,
              { method: 'POST' },
            );
      if (generation.current !== currentGen || keyRef.current !== capturedKey) return null;
      if (
        cacheKey &&
        startEpoch !== null &&
        getVoiceProbeCacheEpoch(cacheKey) !== startEpoch
      ) {
        return null;
      }
      if (cacheKey) {
        writeVoiceProbeCache(cacheKey, response.probe);
      }
      setResult(response.probe);
      const summary = summarizeProbe(response.probe);
      const voiceCount = summary?.supportsPreset ? `${summary.presetVoiceCount} 个预置音色` : '仅参考音频';
      const engineNames = summary?.engines ? Object.keys(summary.engines).join(' / ') : '';
      const elapsedMs = typeof response.elapsedMs === 'number' && Number.isFinite(response.elapsedMs)
        ? Math.max(0, Math.round(response.elapsedMs))
        : undefined;
      setNotice({
        kind: 'status',
        attempt: currentGen,
        elapsedMs,
        text: `连接成功：${summary?.service || '语音服务'}${engineNames ? ` · 引擎 ${engineNames}` : ''} · ${voiceCount}${elapsedMs === undefined ? '' : ` · ${elapsedMs} ms`}`,
      });
      return response.probe;
    } catch (reason) {
      if (generation.current !== currentGen || keyRef.current !== capturedKey) return null;
      if (
        cacheKey &&
        startEpoch !== null &&
        getVoiceProbeCacheEpoch(cacheKey) !== startEpoch
      ) {
        return null;
      }
      if (cacheKey) {
        const epoch = clearVoiceProbeCache(cacheKey);
        // 自己刚完成的失败应留在当前纸笺。其他实例仍会按代次清除旧结果。
        if (cacheKey === capturedKey) epochRef.current = epoch;
      }
      setResult(null);
      setNotice({ kind: 'alert', text: voiceErrorText(reason), attempt: currentGen });
      return null;
    } finally {
      if (generation.current === currentGen) setBusy(false);
    }
  }, []);

  return { result, busy, notice, run, clearLog, cancelPending, reset };
}
