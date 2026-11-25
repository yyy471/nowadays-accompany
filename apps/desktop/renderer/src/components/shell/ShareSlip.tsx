import { useEffect, useRef, useState } from 'react';
import { backendBaseUrl } from '../../conversation/backend-base';
import { receiveShare, type ShareNotice } from '../../conversation/share-notice';
import { appearanceAssetUrl, type RoleListItem } from '../../types';
import { Button, ControlButton, UiThemeScope } from '../../ui';
import '../../styles/share-slip.css';

export function ShareSlip({ seat, visibleWindow, onOpen }: {
  seat: RoleListItem;
  visibleWindow: string | null;
  onOpen: (notice: ShareNotice, dismiss: () => void) => void;
}) {
  const [pending, setPending] = useState<ShareNotice[]>([]);
  const seen = useRef(new Set<string>());
  const visible = useRef(visibleWindow);
  visible.current = visibleWindow;
  const { roleId, defaultWindowId } = seat;
  useEffect(() => {
    if (visibleWindow === defaultWindowId) setPending([]);
  }, [visibleWindow, defaultWindowId]);
  useEffect(() => {
    if (!defaultWindowId) return;
    let active = true;
    let stream: EventSource | undefined;
    void backendBaseUrl().then(base => {
      if (!active) return;
      stream = new EventSource(`${base ?? ''}/v1/roles/${encodeURIComponent(roleId)}/share-events`);
      stream.addEventListener('share', event => {
        if (!active) return;
        const notice = receiveShare(JSON.parse(event.data), roleId, defaultWindowId, visible.current, seen.current);
        if (notice) setPending(previous => [...previous, notice]);
      });
    });
    return () => { active = false; stream?.close(); };
  }, [roleId, defaultWindowId]);

  const notice = pending[0];
  if (!notice || visibleWindow === defaultWindowId) return null;
  const dismiss = () => setPending(previous => previous.filter(item => item.messageId !== notice.messageId));
  return <UiThemeScope theme="xiacheng" className="share-slip">
    <aside aria-label="主角色分享">
      {notice.homeAssetId ? <img alt="" src={appearanceAssetUrl(roleId, notice.homeAssetId)} /> :
        <span className="share-monogram" aria-hidden="true">{Array.from(seat.displayName)[0]}</span>}
      <div aria-live="polite"><strong>{seat.displayName}</strong><p>{notice.summary}</p></div>
      <ControlButton aria-label="关闭分享提示" onClick={dismiss}>×</ControlButton>
      <Button onClick={() => onOpen(notice, dismiss)}>去看看</Button>
    </aside>
  </UiThemeScope>;
}
