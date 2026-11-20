import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createMotionScope, readMotionTime, readMotionValue, useMotionPolicy } from '../../../ui';
import { focusableControls } from '../../../ui/focus';
import { captureSavedSummary } from './save-feedback';
import { animateSheetExit } from './sheet-motion';

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
  /** 显式焦点返回控件，允许锚定整行与触发按钮分开。 */
  focusReturn?: HTMLElement | null;
}

export interface SheetContextValue {
  sheet: SheetState | null;
  dirty: boolean;
  /** 纸笺内未保存的改动数（T8 / T9 文案用）。 */
  dirtyCount: number;
  busy: boolean;
  confirming: boolean;
  closing: boolean;
  /** 每次纸笺关闭后递增（含「放弃修改」与保存后关闭）；宿主据此把草稿回滚到已保存值（R11-2）。 */
  discardToken: number;
  closedId: string | null;
  closedSaved: boolean;
  open: (next: SheetState) => void;
  requestClose: (then?: () => void) => void;
  closeNow: (then?: () => void) => void;
  discardNow: (then?: () => void) => void;
  setDirty: (value: boolean, count?: number) => void;
  setBusy: (value: boolean) => void;
  resolveConfirm: (keepEditing: boolean) => void;
}

const SheetContext = createContext<SheetContextValue | null>(null);

/**
 * 单纸笺状态（规范 §2 / §7.3）：同一时间最多一张；关闭时有改动先出 T9 确认；
 * 关闭后焦点回到触发元素，找不到时回该行的「编辑」按钮。
 */
/**
 * `controller` 让 Provider 之上的工作区（如分区页签）能在不重建组件树的前提下
 * 读到当前纸笺并按关闭规则收尾——纸笺开着时切分区必须先关纸笺（验收 29）。
 */
export function SheetProvider({ children, controller }: { children: ReactNode; controller?: MutableRefObject<SheetContextValue | null> }) {
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [busy, setBusyState] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [discardToken, setDiscardToken] = useState(0);
  const [closedId, setClosedId] = useState<string | null>(null);
  const [closedSaved, setClosedSaved] = useState(false);
  const { reduced } = useMotionPolicy();
  const lastTrigger = useRef<HTMLElement | null>(null);
  const pendingThen = useRef<(() => void) | null>(null);
  const current = useRef<SheetState | null>(null);
  const savedFeedback = useRef<ReturnType<typeof captureSavedSummary> | null>(null);
  const leaving = useRef(false);
  const busyRef = useRef(false);
  const pendingFinalization = useRef<(() => void) | null>(null);
  const [exitMotion] = useState(createMotionScope);
  // 新纸笺可在卸载后立刻打开，旧焦点回调须识别这次打开。
  const closeSeq = useRef(0);

  const focusAfterClose = useCallback((target: SheetState | null) => {
    const trigger = lastTrigger.current;
    if (trigger && trigger.isConnected && trigger !== document.body && trigger.tabIndex >= 0 && !trigger.matches(':disabled')) {
      trigger.focus({ preventScroll: true });
      return;
    }
    if (target) {
      const rowId = target.id.replace(/:(service|test)$/, '');
      const edit = [...document.querySelectorAll<HTMLElement>(`[data-edit="${CSS.escape(rowId)}"]`)].find(element => element.offsetParent !== null);
      const control = edit?.querySelector<HTMLElement>('button.config-sum-edit') ?? edit;
      if (control) {
        control.focus({ preventScroll: true });
        return;
      }
    }
    [...document.querySelectorAll<HTMLElement>('.config-leaf-body h2')].find(element => element.offsetParent !== null)?.focus({ preventScroll: true });
  }, []);

  const setDirty = useCallback((next: boolean, count = 0) => {
    setDirtyState(next);
    setDirtyCount(next ? count : 0);
  }, []);

  const setBusy = useCallback((next: boolean) => {
    busyRef.current = next;
    setBusyState(next);
  }, []);

  const close = useCallback((saved: boolean, after?: () => void) => {
    const target = current.current;
    if (!target || leaving.current) return;
    const then = after ?? pendingThen.current;
    pendingThen.current = null;
    leaving.current = true;
    setClosing(true);
    setDirtyState(false);
    setDirtyCount(0);
    setBusy(false);
    setConfirming(false);
    // 退出动画结束后再广播丢弃信号：否则淡出中的纸笺会立刻显示回滚后的值。
    const seq = ++closeSeq.current;
    const finalize = () => {
      if (closeSeq.current !== seq || !leaving.current) return;
      pendingFinalization.current = null;
      current.current = null;
      leaving.current = false;
      flushSync(() => {
        setSheet(null);
        setClosing(false);
        setClosedId(target.id);
        setClosedSaved(saved);
        setDiscardToken(token => token + 1);
      });
      exitMotion.cancelAll();
      if (saved) savedFeedback.current?.();
      savedFeedback.current = null;
      if (then) then();
      else requestAnimationFrame(() => {
        if (closeSeq.current === seq && !current.current) focusAfterClose(target);
      });
    };
    pendingFinalization.current = finalize;
    const frame = document.querySelector<HTMLElement>('.config-sheet');
    const panelExit = !reduced && frame ? animateSheetExit(frame, exitMotion) : null;
    if (!panelExit) { finalize(); return; }

    const exits = [panelExit];
    for (const node of document.querySelectorAll<HTMLElement>('.config-scrim, .config-book-scrim')) {
      const duration = readMotionTime(node, '--nd-semantic-motion-page-exit', 260);
      if (duration <= 0) continue;
      exits.push(exitMotion.run(node, [{ opacity: getComputedStyle(node).opacity }, { opacity: 0 }], {
        duration, easing: readMotionValue(node, '--nd-semantic-motion-ease-in', 'ease-in'), fill: 'both',
      }));
    }
    if (saved) requestAnimationFrame(() => {
      if (leaving.current && closeSeq.current === seq) savedFeedback.current?.hold();
    });
    // M2/M6 用三层实际动画完成信号；同一提交卸载三个节点，再开始保存反馈或下一步。
    void Promise.allSettled(exits.map(animation => animation.finished)).then(finalize);
  }, [exitMotion, focusAfterClose, reduced, setBusy]);

  const closeNow = useCallback((then?: () => void) => close(true, then), [close]);
  const discardNow = useCallback((then?: () => void) => close(false, then), [close]);

  const open = useCallback((next: SheetState) => {
    if (leaving.current) return;
    const active = document.activeElement;
    const trigger = next.focusReturn ?? (active instanceof HTMLElement ? active : null);
    lastTrigger.current = trigger?.matches('.config-chip-v,.config-chip-k')
      ? trigger.closest('.config-sum')?.querySelector<HTMLElement>('.config-sum-edit') ?? trigger
      : trigger;
    // 重新打开时作废上一次关闭尚未广播的丢弃信号，避免把新纸笺的草稿清掉。
    closeSeq.current += 1;
    current.current = next;
    savedFeedback.current = captureSavedSummary();
    pendingThen.current = null;
    setConfirming(false);
    setDirtyState(false);
    setDirtyCount(0);
    setBusy(false);
    setSheet(next);
  }, [setBusy]);

  const requestClose = useCallback((then?: () => void) => {
    if (busyRef.current || leaving.current || !current.current) return;
    if (dirty) {
      if (confirming) {
        document.querySelector<HTMLElement>('.config-sheet-confirm [data-sheet-focus]')?.focus({ preventScroll: true });
        return;
      }
      pendingThen.current = then ?? null;
      setConfirming(true);
      return;
    }
    if (then) pendingThen.current = then;
    close(false);
  }, [confirming, dirty, close]);

  useEffect(() => {
    const finalize = pendingFinalization.current;
    if (reduced && finalize) queueMicrotask(finalize);
  }, [reduced]);

  useEffect(() => () => {
    pendingFinalization.current = null;
    leaving.current = false;
    exitMotion.cancelAll();
  }, [exitMotion]);

  const resolveConfirm = useCallback((keepEditing: boolean) => {
    if (keepEditing) {
      setConfirming(false);
      pendingThen.current = null;
      // 取消关闭后回到第一个字段（demo 行为），而不是停在关闭按钮上（§17.6 观察项 3）。
      requestAnimationFrame(() => {
        const frame = document.querySelector<HTMLElement>('.config-sheet');
        if (!frame) return;
        const first = frame.querySelector<HTMLElement>('[data-sheet-focus]')
          ?? focusableControls(frame).find(element => !element.classList.contains('config-sheet-x'))
          ?? frame;
        first.focus({ preventScroll: true });
      });
      return;
    }
    close(false);
  }, [close]);

  const value = useMemo<SheetContextValue>(() => ({
    sheet,
    dirty,
    dirtyCount,
    busy,
    confirming,
    closing,
    discardToken,
    closedId,
    closedSaved,
    open,
    requestClose,
    closeNow,
    discardNow,
    setDirty,
    setBusy,
    resolveConfirm,
  }), [sheet, dirty, dirtyCount, busy, confirming, closing, discardToken, closedId, closedSaved, open, requestClose, closeNow, discardNow, resolveConfirm, setBusy, setDirty]);

  useEffect(() => {
    if (!controller) return;
    controller.current = value;
    return () => {
      if (controller.current === value) controller.current = null;
    };
  }, [controller, value]);

  return <SheetContext.Provider value={value}>{children}</SheetContext.Provider>;
}

export function useSheet(): SheetContextValue {
  const value = useContext(SheetContext);
  if (!value) throw new Error('SHEET_PROVIDER_MISSING');
  return value;
}
