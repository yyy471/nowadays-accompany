import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { VoiceResponse } from './api-types';
import type { PerfRow } from './history.js';

export interface SegmentVoiceHandle {
  playingId: number | null;
  play(row: PerfRow, automatic?: boolean): void;
  cancelPending(): void;
  stop(): void;
  /** 预取当前及后续可播放句段；失败保持静默，等点播时再提示。 */
  prefetch(rows: PerfRow[]): void;
}

const MAX_CACHE = 48;
const AUTO_DEBOUNCE_MS = 220;

async function fetchSpeech(roleId: string, windowId: string, segmentId: string): Promise<Blob> {
  const response = await fetch(
    `/v1/roles/${encodeURIComponent(roleId)}/windows/${encodeURIComponent(windowId)}/segments/${encodeURIComponent(segmentId)}/speech`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }
  );
  if (!response.ok) {
    let message = `语音请求失败（${response.status}）`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // 非 JSON 错误沿用状态码提示。
    }
    throw new Error(message);
  }
  return response.blob();
}

/**
 * 真实按句合成：以角色、窗口、音色配置与句段为键缓存音频，
 * 点播始终可用；自动播放与预取失败不阻塞文字阅读。
 * FE-02 暂不传 emotion，由服务端按文本判断。
 */
export function useSegmentVoice({ roleId, windowId, onToast }: { roleId: string; windowId: string | null; onToast: (message: string) => void }): SegmentVoiceHandle {
  const [playingId, setPlayingId] = useState<number | null>(null);
  const cache = useRef(new Map<string, string>());
  const promises = useRef(new Map<string, Promise<string | null>>());
  const audio = useRef<HTMLAudioElement | null>(null);
  const candidate = useRef<HTMLAudioElement | null>(null);
  const pendingTimer = useRef<number | undefined>(undefined);
  const playToken = useRef(0);
  const cacheGeneration = useRef(0);
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
    element.onplaying = null;
    element.onerror = null;
    element.pause();
    element.src = '';
  }, []);

  const releaseAll = useCallback(() => {
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = undefined;
    playToken.current += 1;
    cacheGeneration.current += 1;
    discardCandidate();
    const element = audio.current;
    if (element) {
      element.pause();
      element.src = '';
      audio.current = null;
    }
    for (const url of cache.current.values()) URL.revokeObjectURL(url);
    cache.current.clear();
    promises.current.clear();
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

  const ensureAudio = useCallback((row: PerfRow, manual: boolean): Promise<string | null> => {
    const key = keyFor(row);
    const cached = cache.current.get(key);
    if (cached) return Promise.resolve(cached);
    const running = promises.current.get(key);
    if (running) {
      if (!manual) return running;
      const generation = cacheGeneration.current;
      return running.then(url => {
        if (!url && cacheGeneration.current === generation) notify('这句语音暂时无法合成，请稍后重试。');
        return url;
      });
    }
    const role = roleRef.current;
    const win = windowRef.current;
    if (!role || !win) return Promise.resolve(null);
    const generation = cacheGeneration.current;
    const task: Promise<string | null> = fetchSpeech(role, win, row.segmentId).then(blob => {
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
      return url;
    }).catch(error => {
      if (promises.current.get(key) === task) promises.current.delete(key);
      if (manual && cacheGeneration.current === generation) notify(error instanceof Error ? error.message : String(error));
      return null;
    });
    promises.current.set(key, task);
    return task;
  }, [notify]);

  const prefetch = useCallback((rows: PerfRow[]) => {
    for (const row of rows) {
      if (row.role !== 'assistant' || !row.segmentId || row.action || !row.text) continue;
      void ensureAudio(row, false);
    }
  }, [ensureAudio]);

  const cancelPending = useCallback(() => {
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = undefined;
    playToken.current += 1;
    discardCandidate();
  }, [discardCandidate]);

  const stop = useCallback(() => {
    cancelPending();
    const element = audio.current;
    if (element) {
      element.pause();
      element.src = '';
      audio.current = null;
    }
    setPlayingId(null);
  }, [cancelPending]);

  const play = useCallback((row: PerfRow, automatic = false) => {
    if (row.role !== 'assistant' || !row.segmentId || row.action || !row.text) return;
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    discardCandidate();
    const token = ++playToken.current;
    const start = () => {
      if (playToken.current !== token) return;
      void ensureAudio(row, !automatic).then(url => {
        if (!url || playToken.current !== token) return;
        const element = new Audio(url);
        candidate.current = element;
        element.onplaying = () => {
          if (candidate.current !== element || playToken.current !== token) return;
          candidate.current = null;
          const previous = audio.current;
          audio.current = element;
          if (previous) { previous.pause(); previous.src = ''; }
          setPlayingId(row.id);
        };
        const finish = () => { if (audio.current === element) { audio.current = null; setPlayingId(null); } };
        const fail = (message: string) => {
          if (candidate.current === element) {
            discardCandidate();
          } else if (audio.current === element) {
            finish();
          } else return;
          if (!automatic && playToken.current === token) notify(message);
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
  }, [discardCandidate, ensureAudio, notify]);

  return { playingId, play, cancelPending, stop, prefetch };
}
