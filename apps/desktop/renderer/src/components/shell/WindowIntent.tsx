import { useLayoutEffect, useRef, useState } from 'react';
import { Modal, CancelButton, ConfirmButton } from '../../ui';

/** 只有主进程发起离窗；纸笺等待用户期间保持心跳，最终决定仅回传一次。 */
export function WindowIntent() {
  const [paper, setPaper] = useState({ action: 'hide', open: false });
  const active = useRef<DeskIntent | undefined>(undefined);
  useLayoutEffect(() => {
    const desk = window.nowadaysDesk;
    if (!desk) return;
    let pulse: number | undefined;
    const unsubscribe = desk.onIntent(next => {
      if (next.action === 'cancel' && active.current?.id !== next.id) return;
      clearInterval(pulse);
      if (next.action === 'cancel') {
        active.current = undefined;
        setPaper(previous => ({ ...previous, open: false }));
        return;
      }
      if (window.dispatchEvent(new Event('nowadays:check-drafts', { cancelable: true }))) {
        desk.reply(next.id, true);
        return;
      }
      active.current = next;
      setPaper({ action: next.action, open: true });
      desk.waiting(next.id);
      pulse = window.setInterval(() => {
        if (active.current === next) desk.waiting(next.id);
        else clearInterval(pulse);
      }, 1000);
    });
    return () => { clearInterval(pulse); unsubscribe(); };
  }, []);
  function finish(accepted: boolean) {
    if (!active.current) return;
    window.nowadaysDesk?.reply(active.current.id, accepted);
    active.current = undefined;
    setPaper(previous => ({ ...previous, open: false }));
  }
  const hide = paper.action === 'hide';
  const label = hide ? '保留草稿并隐藏' : '放弃修改并退出';
  return <Modal open={paper.open} role="alertdialog" className="ui-confirm-dialog desk-intent" title="配置还有未保存的修改"
    description={hide ? '窗口将收进托盘。再次打开书房，可从当前草稿继续编辑。' : '退出书房后，本次尚未保存的修改将丢失。'}
    onClose={() => finish(false)}>
    <footer className="ui-dialog-actions">
      <CancelButton data-autofocus onClick={() => finish(false)}>继续编辑</CancelButton>
      <ConfirmButton variant={hide ? 'primary' : 'danger'} onClick={() => finish(true)}>{label}</ConfirmButton>
    </footer>
  </Modal>;
}
