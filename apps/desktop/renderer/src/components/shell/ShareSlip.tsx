import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { backendBaseUrl } from '../../conversation/backend-base';
import { receiveCoplayShare, receiveShare, type ShareNotice } from '../../conversation/share-notice';
import { appearanceAssetUrl, type RoleListItem } from '../../types';
import { Button, IconButton, UiThemeScope } from '../../ui';
import { useSurfaceDismiss } from '../../ui/surface-dismiss';
import '../../styles/share-slip.css';

export function ShareSlip({ sender, notice, onDismiss, onOpen }: {
  sender: RoleListItem;
  notice: ShareNotice;
  onDismiss: () => void;
  onOpen: (notice: ShareNotice, dismiss: () => void) => void;
}) {
  const [brokenImage, setBrokenImage] = useState(false);
  const { surface, closing, close } = useSurfaceDismiss<HTMLElement>(onDismiss);
  return <UiThemeScope theme="xiacheng" className="share-slip">
    <aside ref={surface} className="ui-floating-surface" aria-label={sender.isBuiltin ? "主角色分享" : sender.displayName + "的分享"} data-closing={closing || undefined} inert={closing}>
      <div className="share-slip-summary">
        {notice.homeAssetId && !brokenImage ? <img alt="" src={appearanceAssetUrl(sender.roleId, notice.homeAssetId)} onError={() => setBrokenImage(true)} /> :
          <span className="share-monogram" aria-hidden="true">{Array.from(sender.displayName)[0]}</span>}
        <div aria-live="polite"><strong>{sender.displayName}</strong><p>{notice.summary}</p></div>
        <IconButton icon="close" label="关闭分享提示" onClick={close}/>
      </div>
      <Button onClick={() => onOpen(notice, close)}>查看对话</Button>
    </aside>
  </UiThemeScope>;
}

export function useShareNotices(roles: RoleListItem[], visibleWindow: string | null) {
  const [pending, setPending] = useState<ShareNotice[]>([]);
  const seen = useRef(new Set<string>());
  const seat = roles.find(role => role.isBuiltin && role.status === 'ready');
  const roleId = seat?.roleId;
  const defaultWindowId = seat?.defaultWindowId;
  function receive(event: MessageEvent, fromSeat?: { roleId: string; windowId: string }) {
    try {
      const data = JSON.parse(event.data);
      const notice = fromSeat
        ? receiveShare(data, fromSeat.roleId, fromSeat.windowId, visibleWindow, seen.current)
        : receiveCoplayShare(data, visibleWindow, seen.current);
      if (notice) setPending(previous => [...previous, notice]);
    } catch (error) { console.warn('Invalid share event', error); }
  }
  const onSeatShare = useEffectEvent(receive);
  useEffect(() => {
    if (visibleWindow) setPending(previous => previous.filter(item => item.windowId !== visibleWindow));
  }, [visibleWindow]);
  useEffect(() => {
    if (!roleId || !defaultWindowId) return;
    let active = true;
    let stream: EventSource | undefined;
    void backendBaseUrl().then(base => {
      if (!active) return;
      stream = new EventSource(`${base ?? ''}/v1/roles/${encodeURIComponent(roleId)}/share-events`);
      stream.addEventListener('share', event => {
        if (active) onSeatShare(event, { roleId, windowId: defaultWindowId });
      });
    });
    return () => { active = false; stream?.close(); };
  }, [roleId, defaultWindowId]);

  const notice = pending.find(item => item.windowId !== visibleWindow && roles.some(role => role.roleId === item.roleId));
  const sender = roles.find(role => role.roleId === notice?.roleId);
  return { notice, sender, receive, dismiss: () => setPending(previous => previous.filter(item => item !== notice)) };
}
