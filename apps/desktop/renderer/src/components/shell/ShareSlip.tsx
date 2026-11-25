import { useEffect, useRef, useState } from 'react';
import { backendBaseUrl } from '../../conversation/backend-base';
import { receiveShare, type ShareNotice } from '../../conversation/share-notice';
import { appearanceAssetUrl, type RoleListItem } from '../../types';
import { Button, IconButton, UiThemeScope } from '../../ui';
import { useSurfaceDismiss } from '../../ui/surface-dismiss';
import '../../styles/share-slip.css';

function ShareSlipCard({ seat, notice, onDismiss, onOpen }: {
  seat: RoleListItem;
  notice: ShareNotice;
  onDismiss: () => void;
  onOpen: (notice: ShareNotice, dismiss: () => void) => void;
}) {
  const [brokenImage, setBrokenImage] = useState(false);
  const { surface, closing, close } = useSurfaceDismiss<HTMLElement>(onDismiss);
  return <UiThemeScope theme="xiacheng" className="share-slip">
    <aside ref={surface} className="ui-floating-surface" aria-label="主角色分享" data-closing={closing || undefined} inert={closing}>
      {notice.homeAssetId && !brokenImage ? <img alt="" src={appearanceAssetUrl(seat.roleId, notice.homeAssetId)} onError={() => setBrokenImage(true)} /> :
        <span className="share-monogram" aria-hidden="true">{Array.from(seat.displayName)[0]}</span>}
      <div aria-live="polite"><strong>{seat.displayName}</strong><p>{notice.summary}</p></div>
      <IconButton icon="close" label="关闭分享提示" onClick={close}/>
      <Button onClick={() => onOpen(notice, close)}>查看对话</Button>
    </aside>
  </UiThemeScope>;
}

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
    if (visibleWindow && visibleWindow === defaultWindowId) setPending([]);
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
        try {
          const notice = receiveShare(JSON.parse(event.data), roleId, defaultWindowId, visible.current, seen.current);
          if (notice) setPending(previous => [...previous, notice]);
        } catch (error) { console.warn('Invalid share event', error); }
      });
    });
    return () => { active = false; stream?.close(); };
  }, [roleId, defaultWindowId]);

  const notice = pending[0];
  if (!notice || visibleWindow === defaultWindowId) return null;
  return <ShareSlipCard key={notice.messageId} seat={seat} notice={notice} onOpen={onOpen}
    onDismiss={() => setPending(previous => previous.filter(item => item.messageId !== notice.messageId))}/>;
}
