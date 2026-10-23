import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './modal';
import { CancelButton, ConfirmButton } from './actions';

export type ConfirmOptions = { title: string; description: ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger' };
type Request = ConfirmOptions & { resolve: (accepted: boolean) => void };
const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | undefined>(undefined);

/** Queued confirmations; concurrent requests cannot resolve or overwrite one another. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const queue = useRef<Request[]>([]);
  const [active, setActive] = useState<Request>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; queue.current.splice(0).forEach((request) => request.resolve(false)); };
  }, []);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    if (!mounted.current) { resolve(false); return; }
    const request = { ...options, resolve };
    queue.current.push(request);
    if (queue.current.length === 1) setActive(request);
  }), []);
  const finish = (accepted: boolean) => {
    if (queue.current[0] !== active) return;
    const request = queue.current.shift();
    request?.resolve(accepted);
    setActive(queue.current[0]);
  };
  return <ConfirmContext.Provider value={confirm}>
    {children}
    <Modal open={Boolean(active)} title={active?.title} description={active?.description} role="alertdialog"
      className="ui-confirm-dialog" onClose={() => finish(false)}>
      <footer className="ui-dialog-actions">
        <CancelButton data-autofocus onClick={() => finish(false)}>{active?.cancelLabel ?? '取消'}</CancelButton>
        <ConfirmButton variant={active?.tone === 'danger' ? 'danger' : 'primary'} onClick={() => finish(true)}>{active?.confirmLabel ?? '确认'}</ConfirmButton>
      </footer>
    </Modal>
  </ConfirmContext.Provider>;
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmProvider');
  return confirm;
}
