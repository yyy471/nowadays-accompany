import { useCallback, useEffect, useRef, useState } from 'react';
import type { PerfRow } from './history.js';

export interface VoiceHandle {
  /** 正在播放的句段 id；无则 null。 */
  playingId: number | null;
  play(row: PerfRow, automatic?: boolean): void;
  /** 取消仍在等待的自动播放请求，不打断已经开始的语音。 */
  cancelPending(): void;
  /** 离开窗口或卸载时清理播放与等待。 */
  stop(): void;
}

/**
 * 演示语音：使用本机中文朗读（FE-01 替身）。真实合成由后端 speech 路由按句提供，
 * 接入层替换本钩子实现，页面只读 playingId 并调用 play / cancelPending / stop。
 */
export function useLocalVoice(onToast: (message: string) => void): VoiceHandle {
  const [playingId, setPlayingId] = useState<number | null>(null);
  const pending = useRef<{ timer: number; row: PerfRow } | null>(null);
  const active = useRef<{ rowId: number; utterance: SpeechSynthesisUtterance } | null>(null);
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

  const clearActive = useCallback(() => {
    active.current = null;
    setPlayingId(null);
  }, []);

  const cancelPending = useCallback(() => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);

  const stop = useCallback(() => {
    cancelPending();
    if (active.current) {
      try { window.speechSynthesis.cancel(); } catch { /* 引擎不可用时静默清理 */ }
    }
    active.current = null;
    setPlayingId(null);
  }, [cancelPending]);

  useEffect(() => stop, [stop]);

  const play = useCallback((row: PerfRow, automatic = false) => {
    cancelPending();
    if (!supported) {
      if (!automatic) toastRef.current('这台设备暂时无法使用本地朗读。');
      return;
    }
    const request: { timer: number; row: PerfRow } = { row, timer: 0 };
    const voices = window.speechSynthesis.getVoices();
    const chinese = voices.find(voice => voice.localService && /^zh(?:[-_]|$)/i.test(voice.lang));
    if (!chinese) {
      if (!automatic) toastRef.current('本机没有可用的中文朗读音色。');
      return;
    }
    const selected = chinese;
    pending.current = request;
    request.timer = window.setTimeout(() => {
      if (pending.current !== request) return;
      pending.current = null;
      const utterance = new SpeechSynthesisUtterance(row.text);
      utterance.voice = selected;
      utterance.lang = selected.lang;
      const handle = { rowId: row.id, utterance };
      const finish = () => {
        if (active.current !== handle) return;
        clearActive();
      };
      utterance.onstart = () => {
        if (active.current === handle) setPlayingId(row.id);
      };
      utterance.onend = finish;
      utterance.onerror = () => {
        if (active.current !== handle) return;
        finish();
        if (!automatic) toastRef.current('这句语音暂时播不出来。');
      };
      active.current = handle;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    }, automatic ? 220 : 0);
  }, [cancelPending, clearActive, supported]);

  return { playingId, play, cancelPending, stop };
}
