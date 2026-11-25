import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { LIVE, T29, T32 } from './config-texts';
import { announceLive } from '../../ui/live-announcer';
import { ConfigNotice, type ConfigNoticeTone } from './ConfigNotice';

export type WriteFailure =
  | { phase: 'pause'; message: string }
  | { phase: 'commit'; message: string; paused: boolean };

type WriteInput = {
  roleIds?: string[];
  verb: string;
  commit: () => Promise<void>;
  toggle?: boolean;
  /** 特定结果由纸笺收回后的反馈统一播报。 */
  announceSuccess?: boolean;
};

interface WriteContextValue {
  busy: boolean;
  phase: 'pause' | 'commit' | null;
  pendingPauseIds: string[];
  pauseNotice: string;
  pausedRoleIds: string[];
  resuming: boolean;
  beginWrite: (pauseRoleIds?: string[], managedByBackend?: boolean) => (() => void) | null;
  runWrite: (input: WriteInput) => Promise<{ ok: true } | { ok: false; failure: WriteFailure }>;
  resumePaused: () => Promise<void>;
  clearPaused: () => void;
  forgetPaused: (roleId: string) => void;
  recordPaused: (roleIds: string[]) => void;
  statusError: string;
  reportFailure: (message: string) => void;
  reportResult: (message: string, tone?: ConfigNoticeTone) => void;
  result: { message: string; tone: ConfigNoticeTone; key: number } | null;
  dismissResult: (key?: number) => void;
}

const WriteContext = createContext<WriteContextValue | null>(null);
const sleep = (ms: number) => new Promise<void>(resolve => { window.setTimeout(resolve, ms); });

async function activityState(roleId: string): Promise<string> {
  const result = await api<{ activity: { state: string } }>(`/v1/roles/${encodeURIComponent(roleId)}/activity`);
  return result.activity.state;
}

/** 保留本次真实暂停的角色以供用户恢复，设置与角色纸笺共用一个写入锁。 */
export function WriteProvider({ children, roleName, onActivityChanged }: { children: ReactNode; roleName?: (roleId: string) => string; onActivityChanged?: () => void }) {
  const [phase, setPhase] = useState<WriteContextValue['phase']>(null);
  const [pendingPauseIds, setPendingPauseIds] = useState<string[]>([]);
  const [pausedRoleIds, setPausedRoleIds] = useState<string[]>([]);
  const [resuming, setResuming] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [result, setResult] = useState<WriteContextValue['result']>(null);
  const resultKey = useRef(0);
  const lock = useRef(false);
  const rolesRef = useRef<string[]>([]);
  const resumeLock = useRef(false);
  const callbacks = useRef({ roleName, onActivityChanged });
  callbacks.current = { roleName, onActivityChanged };

  const reportResult = useCallback((message: string, tone: ConfigNoticeTone = 'success') => {
    const key = ++resultKey.current;
    setResult({ message, tone, key });
    announceLive(message);
  }, []);

  const dismissResult = useCallback((key?: number) => setResult(previous => previous?.key === key ? null : previous), []);

  const recordPaused = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    rolesRef.current = [...new Set([...rolesRef.current, ...ids])];
    setPausedRoleIds(rolesRef.current);
    callbacks.current.onActivityChanged?.();
  }, []);

  const forgetPaused = useCallback((id: string) => {
    if (!rolesRef.current.includes(id)) return;
    rolesRef.current = rolesRef.current.filter(roleId => roleId !== id);
    setPausedRoleIds(rolesRef.current);
  }, []);

  const beginWrite = useCallback((pauseRoleIds: string[] = [], managedByBackend = true) => {
    if (lock.current || resumeLock.current) return null;
    lock.current = true;
    setStatusError('');
    setPendingPauseIds(pauseRoleIds);
    setPhase(pauseRoleIds.length ? 'pause' : 'commit');
    const request = new AbortController();
    if (managedByBackend && pauseRoleIds.length > 0) {
      const names = pauseRoleIds.map(id => callbacks.current.roleName?.(id) ?? id);
      announceLive(T29.pausingRoles(names));
      // 维护接口在同一次请求内暂停和提交；只观察后端已确认的活动状态。
      const monitor = async () => {
        while (!request.signal.aborted) {
          await sleep(250);
          if (request.signal.aborted) return;
          try {
            const data = await api<{ items: Array<{ roleId: string; state: string }> }>('/v1/activities', { signal: request.signal });
            if (request.signal.aborted) return;
            const pending = pauseRoleIds.filter(id => data.items.find(role => role.roleId === id)?.state !== 'stopped');
            setPendingPauseIds(pending);
            if (pending.length === 0) {
              setPhase('commit');
              callbacks.current.onActivityChanged?.();
              return;
            }
          } catch {
            // 写入响应仍提供真实暂停名单；读取错误不会中断后端维护请求。
          }
        }
      };
      void monitor();
    }
    return () => {
      request.abort();
      lock.current = false;
      setPendingPauseIds([]);
      setPhase(null);
    };
  }, []);

  const runWrite = useCallback(async (input: WriteInput) => {
    const targets = [...new Set(input.roleIds ?? [])];
    const finish = beginWrite(targets, false);
    if (!finish) return { ok: false as const, failure: { phase: 'commit' as const, message: '', paused: false } };
    const label = (id: string) => callbacks.current.roleName?.(id) ?? id;
    const paused: string[] = [];
    let pausingRole: string | null = null;
    try {
      for (const roleId of targets) {
        pausingRole = roleId;
        let state = await activityState(roleId);
        if (state === 'stopped') {
          setPendingPauseIds(previous => previous.filter(id => id !== roleId));
          continue;
        }
        announceLive(T29.pausingRoles([label(roleId)]));
        const ownStop = state === 'active';
        if (ownStop) {
          const { activity } = await api<{ activity?: { state: string } }>(`/v1/roles/${encodeURIComponent(roleId)}/activity/stop`, { method: 'POST' });
          state = activity?.state ?? state;
        }
        const deadline = Date.now() + 20_000;
        while (state !== 'stopped' && Date.now() < deadline) {
          state = await activityState(roleId);
          if (state !== 'stopped') await sleep(250);
        }
        if (state !== 'stopped') throw new Error('角色没有确认停止。');
        if (ownStop) paused.push(roleId);
      }
      pausingRole = null;
      setPendingPauseIds([]);
      setPhase('commit');
      if (targets.length) callbacks.current.onActivityChanged?.();
      await input.commit();
      if (input.announceSuccess !== false) reportResult(LIVE.saved(input.verb));
      return { ok: true as const };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (pausingRole) {
        return { ok: false as const, failure: { phase: 'pause' as const, message: input.toggle ? T32.toggleFail(input.verb, reason) : T32.pauseFail([label(pausingRole)]) } };
      }
      const message = input.toggle ? T32.toggleFail(input.verb, reason)
        : paused.length ? T32.saveFailPaused(input.verb, reason, paused.map(label)) : T32.saveFail(input.verb, reason);
      return { ok: false as const, failure: { phase: 'commit' as const, message, paused: paused.length > 0 } };
    } finally {
      recordPaused(paused);
      if (targets.length && paused.length === 0 && pausingRole) callbacks.current.onActivityChanged?.();
      finish();
    }
  }, [beginWrite, recordPaused, reportResult]);

  const resumePaused = useCallback(async () => {
    if (lock.current || resumeLock.current || rolesRef.current.length === 0) return;
    resumeLock.current = true;
    setResuming(true);
    setStatusError('');
    const failed: string[] = [];
    const restored: string[] = [];
    try {
      for (const roleId of [...rolesRef.current]) {
        if (!rolesRef.current.includes(roleId)) continue;
        try {
          const state = await activityState(roleId);
          if (state !== 'active') await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' });
          forgetPaused(roleId);
          restored.push(callbacks.current.roleName?.(roleId) ?? roleId);
        } catch { failed.push(callbacks.current.roleName?.(roleId) ?? roleId); }
      }
      if (failed.length) setStatusError(`${failed.join('、')}恢复活动失败，请重试。`);
      if (restored.length) reportResult(`${restored.join('、')} ${LIVE.resumed}`, failed.length ? 'warning' : 'success');
    } finally {
      callbacks.current.onActivityChanged?.();
      resumeLock.current = false;
      setResuming(false);
    }
  }, [forgetPaused, reportResult]);

  const clearPaused = useCallback(() => {
    rolesRef.current = [];
    setPausedRoleIds([]);
  }, []);

  const value = useMemo<WriteContextValue>(() => ({
    busy: phase !== null, phase, pendingPauseIds,
    pauseNotice: pendingPauseIds.length ? T29.pausingRoles(pendingPauseIds.map(id => callbacks.current.roleName?.(id) ?? id)) : '',
    pausedRoleIds, resuming, beginWrite, runWrite, resumePaused, clearPaused, forgetPaused, recordPaused, statusError, reportFailure: setStatusError, reportResult, result, dismissResult,
  }), [phase, pendingPauseIds, pausedRoleIds, resuming, beginWrite, runWrite, resumePaused, clearPaused, forgetPaused, recordPaused, statusError, reportResult, result, dismissResult]);

  return <WriteContext.Provider value={value}>{children}</WriteContext.Provider>;
}

export function useWrite(): WriteContextValue {
  const value = useContext(WriteContext);
  if (!value) throw new Error('WRITE_PROVIDER_MISSING');
  return value;
}

export function WriteResultNotice() {
  const { result, dismissResult } = useWrite();
  return <ConfigNotice key={result?.key} message={result?.message ?? ''} noticeKey={result?.key} tone={result?.tone} onDismiss={() => dismissResult(result?.key)}/>;
}
