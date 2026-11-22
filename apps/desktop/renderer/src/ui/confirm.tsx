import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './modal';
import { CancelButton, ConfirmButton } from './actions';
import { UiAppearanceProvider, useUiAppearance, type UiAppearance } from './appearance';

export type ConfirmOptions = { title: string; description: ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger'; signal?: AbortSignal };
type Request = ConfirmOptions & { id: number; appearance: UiAppearance; source?: HTMLElement; resolve: (accepted: boolean) => void; cleanup: () => void };
const ConfirmContext = createContext<((options: ConfirmOptions, appearance: UiAppearance) => Promise<boolean>) | undefined>(undefined);

/** Queued confirmations; concurrent requests cannot resolve or overwrite one another. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const queue = useRef<Request[]>([]);
  const [active, setActive] = useState<Request>();
  const [showing, setShowing] = useState(false);
  const finishing = useRef(false);
  const mounted = useRef(true);
  const nextId = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; queue.current.splice(0).forEach((request) => { request.cleanup(); request.resolve(false); }); };
  }, []);
  const present = useCallback((request: Request | undefined): void => {
    finishing.current = false;
    setActive(request);
    setShowing(Boolean(request));
  }, []);
  const confirm = useCallback((options: ConfirmOptions, appearance: UiAppearance) => new Promise<boolean>((resolve) => {
    if (!mounted.current || options.signal?.aborted) { resolve(false); return; }
    const abort = (): void => {
      const index = queue.current.indexOf(request);
      if (index < 0) return;
      queue.current.splice(index, 1);
      request.cleanup();
      request.resolve(false);
      // 外部作废不等待退出动画，立即呈现下一条；排队请求直接移除。
      if (index === 0 && !finishing.current) present(queue.current[0]);
    };
    const source = typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : undefined;
    const request: Request = { ...options, id: ++nextId.current, appearance, source, resolve, cleanup: () => options.signal?.removeEventListener('abort', abort) };
    options.signal?.addEventListener('abort', abort, { once: true });
    queue.current.push(request);
    if (queue.current.length === 1 && !finishing.current) present(request);
  }), [present]);
  const finish = (accepted: boolean): void => {
    if (finishing.current || queue.current[0] !== active) return;
    finishing.current = true;
    const request = queue.current.shift();
    request?.cleanup();
    request?.resolve(accepted);
    // 退出动画结束后再呈现下一条；期间Modal保持隔离，不提前换内容。
    setShowing(false);
  };
  const exited = (): void => { present(queue.current[0]); };
  return <ConfirmContext.Provider value={confirm}>
    {children}
    <UiAppearanceProvider value={active?.appearance ?? {}}>
    <Modal key={active?.id ?? 'closed'} open={showing && Boolean(active)} title={active?.title} description={active?.description} role="alertdialog"
      className="ui-confirm-dialog" source={active?.source} onExited={exited} onClose={() => finish(false)}>
      <footer className="ui-dialog-actions">
        <CancelButton data-autofocus onClick={() => finish(false)}>{active?.cancelLabel ?? '取消'}</CancelButton>
        <ConfirmButton variant={active?.tone === 'danger' ? 'danger' : 'primary'} onClick={() => finish(true)}>{active?.confirmLabel ?? '确认'}</ConfirmButton>
      </footer>
    </Modal>
    </UiAppearanceProvider>
  </ConfirmContext.Provider>;
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  const appearance = useUiAppearance();
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmProvider');
  return useCallback((options: ConfirmOptions) => confirm(options, appearance), [confirm, appearance.theme, appearance.motion, appearance.preset]);
}
