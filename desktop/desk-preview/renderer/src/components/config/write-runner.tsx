import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { LIVE, T29, T30, T32 } from './config-texts.js';
import { announceLive } from '../../ui/live-announcer';

export type WriteFailure =
  | { phase: 'pause'; message: string }
  | { phase: 'commit'; message: string; paused: boolean };

interface WriteContextValue {
  busy: boolean;
  /** 为保存而暂停、尚未恢复的角色编号（T30）。 */
  pausedRoleIds: string[];
  resuming: boolean;
  runWrite: (input: { roleIds?: string[]; verb: string; commit: () => Promise<void> }) => Promise<{ ok: true } | { ok: false; failure: WriteFailure }>;
  resumePaused: () => Promise<void>;
  clearPaused: () => void;
}

const WriteContext = createContext<WriteContextValue | null>(null);

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

async function activityState(roleId: string): Promise<string> {
  const result = await api<{ activity: { state: string } }>(`/v1/roles/${encodeURIComponent(roleId)}/activity`);
  return result.activity.state;
}

/**
 * 统一写入管线（规范 §7.5 / D5）：保存前按需暂停相关角色，等待后端确认 stopped 后写入；
 * 写入失败时区分「暂停失败」与「已暂停但保存失败」，并保留 T30 供用户手动恢复。
 */
export function WriteProvider({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [pausedRoleIds, setPausedRoleIds] = useState<string[]>([]);
  const [resuming, setResuming] = useState(false);
  const lock = useRef(false);
  const rolesRef = useRef<string[]>([]);

  const runWrite = useCallback(async (input: { roleIds?: string[]; verb: string; commit: () => Promise<void> }) => {
    if (lock.current) return { ok: false as const, failure: { phase: 'commit' as const, message: '', paused: false } };
    lock.current = true;
    setBusy(true);
    const targets = [...new Set(input.roleIds ?? [])];
    const paused: string[] = [];
    try {
      for (const roleId of targets) {
        let state = await activityState(roleId);
        if (state === 'stopped') continue;
        announceLive(T29.pausing);
        await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/stop`, { method: 'POST' });
        const deadline = Date.now() + 20_000;
        while (state !== 'stopped' && Date.now() < deadline) {
          await sleep(250);
          state = await activityState(roleId);
        }
        if (state !== 'stopped') {
          const names = [roleId];
          return { ok: false as const, failure: { phase: 'pause' as const, message: T32.pauseFail(names) } };
        }
        paused.push(roleId);
      }
      if (paused.length > 0) announceLive(T29.saving);
      await input.commit();
      announceLive(LIVE.saved(input.verb));
      if (paused.length > 0) {
        rolesRef.current = [...new Set([...rolesRef.current, ...paused])];
        setPausedRoleIds(rolesRef.current);
      }
      return { ok: true as const };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (paused.length > 0) {
        rolesRef.current = [...new Set([...rolesRef.current, ...paused])];
        setPausedRoleIds(rolesRef.current);
        return { ok: false as const, failure: { phase: 'commit' as const, message: T32.saveFailPaused(input.verb, reason, paused), paused: true } };
      }
      return { ok: false as const, failure: { phase: 'commit' as const, message: T32.saveFail(input.verb, reason), paused: false } };
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);

  const resumePaused = useCallback(async () => {
    if (resuming || rolesRef.current.length === 0) return;
    setResuming(true);
    try {
      for (const roleId of rolesRef.current) {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' });
      }
      announceLive(LIVE.resumed);
      rolesRef.current = [];
      setPausedRoleIds([]);
    } finally {
      setResuming(false);
    }
  }, [resuming]);

  const clearPaused = useCallback(() => {
    rolesRef.current = [];
    setPausedRoleIds([]);
  }, []);

  const value = useMemo<WriteContextValue>(() => ({
    busy, pausedRoleIds, resuming, runWrite, resumePaused, clearPaused,
  }), [busy, pausedRoleIds, resuming, runWrite, resumePaused, clearPaused]);

  return <WriteContext.Provider value={value}>{children}</WriteContext.Provider>;
}

export function useWrite(): WriteContextValue {
  const value = useContext(WriteContext);
  if (!value) throw new Error('WRITE_PROVIDER_MISSING');
  return value;
}
