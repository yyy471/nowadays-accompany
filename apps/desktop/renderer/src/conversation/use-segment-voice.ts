import { useCallback, useEffect, useRef, useState } from 'react';
import { api, desktopFetch } from '../api';
import type { VoiceResponse } from './api-types';
import type { PerfRow } from './history';

export interface SegmentVoiceHandle {
  pendingId: number | null;
  playingId: number | null;
  play(row: PerfRow, automatic?: boolean): void;
  cancelPending(): void;
  stop(): void;
  /** 预取当前及后续可播放句段；失败保持静默，等点播时再提示。 */
  prefetch(rows: PerfRow[]): void;
}

const MAX_CACHE = 48;
const AUTO_DEBOUNCE_MS = 220;
/** 与后端 VOICE_DISABLED 的提示保持一致。 */
const DISABLED_MESSAGE = '角色语音已停用，启用后才能播放对话语音。';

type SpeechResult = { url: string } | { error: string } | null;

class SpeechRequestError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = 'SpeechRequestError';
  }
}

function releasePlayer(element: HTMLAudioElement) {
  element.onplaying = null;
  element.onended = null;
  element.onerror = null;
  const releaseSource = () => {
    element.removeAttribute('src');
    element.load();
  };
  if (element.paused) {
    releaseSource();
  } else {
    element.addEventListener('pause', releaseSource, { once: true });
    element.pause();
  }
}

async function fetchSpeech(
  roleId: string,
  windowId: string,
  segmentId: string,
  emotion?: string | null,
): Promise<Blob> {
  const response = await desktopFetch(
    `/v1/roles/${encodeURIComponent(roleId)}/windows/${encodeURIComponent(windowId)}/segments/${encodeURIComponent(segmentId)}/speech`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(emotion ? { emotion } : {})
    }
  );
  if (!response.ok) {
    let message = `语音请求失败（${response.status}）`;
    let code: string | null = null;
    try {
      const body = await response.json() as { error?: { message?: string; code?: string } };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // 非 JSON 错误沿用状态码提示。
    }
    throw new SpeechRequestError(message, code);
  }
  return response.blob();
}

/**
 * 真实按句合成：以角色、窗口、音色配置与句段为键缓存音频，
 * 点播始终可用；自动播放与预取失败不阻塞文字阅读。
 * FE-02 暂不传 emotion，由服务端按文本判断。
 */
export function useSegmentVoice({ roleId, windowId, onToast }: { roleId: string; windowId: string | null; onToast: (message: string) => void }): SegmentVoiceHandle {
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const cache = useRef(new Map<string, string>());
  const promises = useRef(new Map<string, Promise<SpeechResult>>());
  const audio = useRef<HTMLAudioElement | null>(null);
  const candidate = useRef<HTMLAudioElement | null>(null);
  const pendingTimer = useRef<number | undefined>(undefined);
  const playToken = useRef(0);
  const cacheGeneration = useRef(0);
  /** 服务端已明确告知停用：预取与自动播放不再发请求，手动点播视为重试。 */
  const voiceDisabled = useRef(false);
  const revision = useRef('unknown');
  const roleRef = useRef(roleId); roleRef.current = roleId;
  const windowRef = useRef(windowId); windowRef.current = windowId;
  const toastRef = useRef(onToast);
  toastRef.current = onToast;

  const notify = useCallback((message: string) => { toastRef.current(message); }, []);

  const discardCandidate = useCallback(() => {
    const element = candidate.current;
    candidate.current = null;
    if (!element) return;
    releasePlayer(element);
  }, []);

  const releaseAll = useCallback(() => {
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = undefined;
    playToken.current += 1;
    cacheGeneration.current += 1;
    voiceDisabled.current = false;
    discardCandidate();
    const element = audio.current;
    if (element) {
      releasePlayer(element);
      audio.current = null;
    }
    for (const url of cache.current.values()) URL.revokeObjectURL(url);
    cache.current.clear();
    promises.current.clear();
    setPendingId(null);
    setPlayingId(null);
  }, [discardCandidate]);

  useEffect(() => {
    revision.current = 'unknown';
    releaseAll();
    if (!roleId) return;
    let active = true;
    void api<VoiceResponse>(`/v1/roles/${encodeURIComponent(roleId)}/voice`).then(result => {
      if (!active) return;
      revision.current = result.voice?.updatedAt ?? 'none';
    }).catch(() => { /* 配置读取失败时仍尝试合成，错误在点播时提示 */ });
    return () => { active = false; };
  }, [roleId, releaseAll]);

  useEffect(() => {
    releaseAll();
  }, [windowId, releaseAll]);

  useEffect(() => releaseAll, [releaseAll]);

  const keyFor = (row: PerfRow) => JSON.stringify([roleRef.current, windowRef.current, revision.current, row.segmentId, row.text]);

  const ensureAudio = useCallback((row: PerfRow, manual = false): Promise<SpeechResult> => {
    // 手动点播是显式重试：清掉停用标记重新问一次服务端，启用后立刻恢复。
    if (manual) voiceDisabled.current = false;
    if (voiceDisabled.current) return Promise.resolve(null);
    const key = keyFor(row);
    const cached = cache.current.get(key);
    if (cached) return Promise.resolve({ url: cached });
    const running = promises.current.get(key);
    if (running) return running;
    const role = roleRef.current;
    const win = windowRef.current;
    if (!role || !win) return Promise.resolve(null);
    const generation = cacheGeneration.current;
    const task: Promise<SpeechResult> = fetchSpeech(role, win, row.segmentId, row.voiceEmotion).then(blob => {
      if (promises.current.get(key) === task) promises.current.delete(key);
      if (cacheGeneration.current !== generation) return null;
      if (blob.size === 0) throw new Error('这段语音暂时是空的。');
      const url = URL.createObjectURL(blob);
      if (cache.current.size >= MAX_CACHE) {
        const oldest = cache.current.keys().next().value;
        if (oldest !== undefined) {
          const stale = cache.current.get(oldest);
          cache.current.delete(oldest);
          if (stale) URL.revokeObjectURL(stale);
        }
      }
      cache.current.set(key, url);
      return { url };
    }).catch(error => {
      if (promises.current.get(key) === task) promises.current.delete(key);
      // 旧角色或旧窗口的响应不能影响当前范围。
      if (cacheGeneration.current !== generation) return null;
      if (error instanceof SpeechRequestError && error.code === 'VOICE_DISABLED') {
        voiceDisabled.current = true;
        return { error: DISABLED_MESSAGE };
      }
      return { error: error instanceof Error ? error.message : String(error) };
    });
    promises.current.set(key, task);
    return task;
  }, []);

  const prefetch = useCallback((rows: PerfRow[]) => {
    for (const row of rows) {
      if (row.role !== 'assistant' || row.format || !row.segmentId || row.action || !row.text) continue;
      void ensureAudio(row);
    }
  }, [ensureAudio]);

  const cancelPending = useCallback(() => {
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = undefined;
    playToken.current += 1;
    discardCandidate();
    setPendingId(null);
  }, [discardCandidate]);

  const stop = useCallback(() => {
    cancelPending();
    const element = audio.current;
    if (element) {
      releasePlayer(element);
      audio.current = null;
    }
    setPlayingId(null);
  }, [cancelPending]);

  const play = useCallback((row: PerfRow, automatic = false) => {
    if (row.role !== 'assistant' || row.format || !row.segmentId || row.action || !row.text) return;
    cancelPending();
    const token = playToken.current;
    const notifyCurrent = (message: string) => { if (playToken.current === token) notify(message); };
    const start = () => {
      if (playToken.current !== token || (automatic && voiceDisabled.current)) return;
      setPendingId(row.id);
      void ensureAudio(row, !automatic).then(result => {
        if (playToken.current !== token) return;
        if (!result || 'error' in result) {
          setPendingId(null);
          if (result && !automatic) notifyCurrent(result.error);
          return;
        }
        const element = new Audio(result.url);
        candidate.current = element;
        element.onplaying = () => {
          if (candidate.current !== element || playToken.current !== token) return;
          candidate.current = null;
          const previous = audio.current;
          audio.current = element;
          if (previous) releasePlayer(previous);
          setPendingId(null);
          setPlayingId(row.id);
        };
        const finish = () => { if (audio.current === element) { audio.current = null; setPlayingId(null); } };
        const fail = (message: string) => {
          if (candidate.current === element) {
            discardCandidate();
            setPendingId(null);
          } else if (audio.current === element) {
            finish();
          } else return;
          if (!automatic) notifyCurrent(message);
        };
        element.onended = finish;
        element.onerror = () => fail('这句语音暂时播不出来。');
        void element.play().catch(error => fail(error instanceof Error ? error.message : '这句语音暂时播不出来。'));
      });
    };
    if (automatic) {
      pendingTimer.current = window.setTimeout(() => { pendingTimer.current = undefined; start(); }, AUTO_DEBOUNCE_MS);
    } else {
      start();
    }
  }, [cancelPending, discardCandidate, ensureAudio, notify]);

  return { pendingId, playingId, play, cancelPending, stop, prefetch };
}
