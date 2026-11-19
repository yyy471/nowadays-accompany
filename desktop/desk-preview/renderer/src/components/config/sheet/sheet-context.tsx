import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/** 纸笺形态（规范 §2）：完整表单 / 只含一组的紧凑表单 / 删除确认。 */
export type SheetShape = 'full' | 'compact' | 'confirm';

export interface SheetState {
  /** 项编号（如 chat / memory / image / voice / ext / quota / outfit:<id> / delete-role）。 */
  id: string;
  title: string;
  shape: SheetShape;
  /** 紧凑纸笺对应的组名；同一项不同组视为不同纸笺。 */
  group?: string;
  /** 紧凑形态对齐的触发元素。 */
  anchor?: HTMLElement | null;
}

interface SheetContextValue {
  sheet: SheetState | null;
  dirty: boolean;
  /** 纸笺内未保存的改动数（T8 / T9 文案用）。 */
  dirtyCount: number;
  busy: boolean;
  confirming: boolean;
  open: (next: SheetState) => void;
  requestClose: (then?: () => void) => void;
  closeNow: () => void;
  setDirty: (value: boolean, count?: number) => void;
  setBusy: (value: boolean) => void;
  resolveConfirm: (keepEditing: boolean) => void;
}

const SheetContext = createContext<SheetContextValue | null>(null);

/**
 * 单纸笺状态（规范 §2 / §7.3）：同一时间最多一张；关闭时有改动先出 T9 确认；
 * 关闭后焦点回到触发元素，找不到时回该行的「编辑」按钮。
 */
export function SheetProvider({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const pendingThen = useRef<(() => void) | null>(null);
  const current = useRef<SheetState | null>(null);

  const focusAfterClose = useCallback((target: SheetState | null) => {
    const trigger = lastTrigger.current;
    if (trigger && trigger.isConnected) {
      trigger.focus({ preventScroll: true });
      return;
    }
    if (target) {
      const edit = document.querySelector<HTMLElement>(`[data-edit="${target.id}"]`);
      if (edit) {
        edit.focus({ preventScroll: true });
        return;
      }
    }
    document.querySelector<HTMLElement>('.config-leaf-body h2')?.focus({ preventScroll: true });
  }, []);

  const setDirty = useCallback((next: boolean, count = 0) => {
    setDirtyState(next);
    setDirtyCount(next ? count : 0);
  }, []);

  const closeNow = useCallback(() => {
    const closing = current.current;
    const then = pendingThen.current;
    pendingThen.current = null;
    current.current = null;
    setSheet(null);
    setDirtyState(false);
    setDirtyCount(0);
    setBusy(false);
    setConfirming(false);
    if (then) {
      // 导航到新内容：焦点交给新页面的 h2，由接管方处理。
      then();
      return;
    }
    focusAfterClose(closing);
  }, [focusAfterClose]);

  const open = useCallback((next: SheetState) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) lastTrigger.current = active;
    current.current = next;
    pendingThen.current = null;
    setConfirming(false);
    setDirtyState(false);
    setDirtyCount(0);
    setBusy(false);
    setSheet(next);
  }, []);

  const requestClose = useCallback((then?: () => void) => {
    if (busy) return;
    if (dirty) {
      pendingThen.current = then ?? null;
      setConfirming(true);
      return;
    }
    if (then) pendingThen.current = then;
    closeNow();
  }, [busy, dirty, closeNow]);

  const resolveConfirm = useCallback((keepEditing: boolean) => {
    if (keepEditing) {
      setConfirming(false);
      pendingThen.current = null;
      return;
    }
    closeNow();
  }, [closeNow]);

  const value = useMemo<SheetContextValue>(() => ({
    sheet,
    dirty,
    dirtyCount,
    busy,
    confirming,
    open,
    requestClose,
    closeNow,
    setDirty,
    setBusy,
    resolveConfirm,
  }), [sheet, dirty, dirtyCount, busy, confirming, open, requestClose, closeNow, resolveConfirm, setDirty]);

  return <SheetContext.Provider value={value}>{children}</SheetContext.Provider>;
}

export function useSheet(): SheetContextValue {
  const value = useContext(SheetContext);
  if (!value) throw new Error('SHEET_PROVIDER_MISSING');
  return value;
}
