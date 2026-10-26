import { useEffect, useRef, useState } from 'react';
import type { AccountsResponse, SlotsResponse } from '../types';
import { AsyncBoundary, Button, Card, ControlButton, ErrorNote, Icon } from '../ui';
import { AccountAvatar } from '../components/AccountAvatar';

export function HomePage({
  accounts,
  slots,
  loading,
  error,
  onRetry,
  onGoConnections,
  onEditProfile
}: {
  accounts?: AccountsResponse;
  slots?: SlotsResponse;
  loading: boolean;
  error?: string;
  onRetry: () => Promise<void>;
  onGoConnections: () => void;
  onEditProfile: (accountId: string) => void;
}) {
  const list = accounts?.accounts ?? [];
  const [selected, setSelected] = useState('');
  const [hovered, setHovered] = useState<number>();
  const dockButtons = useRef(new Map<string, HTMLButtonElement>());
  const tabStop = list.some(item => item.accountId === selected) ? selected : list[0]?.accountId;
  const account = list.find((item) => item.accountId === selected);
  const nickname = account?.nickname ?? '';
  const signature = account?.signature ?? '';
  const onlineAccounts = new Set(
    (slots?.slots ?? [])
      .filter((instance) => instance.accountId && instance.state === 'online')
      .map((instance) => instance.accountId as string)
  );

  useEffect(() => {
    if (!selected && list.length) setSelected(list[0]!.accountId);
    if (selected && !list.some((item) => item.accountId === selected)) setSelected(list[0]?.accountId ?? '');
  }, [list, selected]);

  if (!accounts) {
    return (
      <div className="page-stack home-page">
        <Card className="home-profile-card">
          <AsyncBoundary loading={loading} error={error} hasData={false} onRetry={() => void onRetry()} loadingText="正在读取账号…" errorPrefix="账号读取失败">
            <></>
          </AsyncBoundary>
        </Card>
      </div>
    );
  }

  if (!list.length) {
    return (
      <div className="page-stack home-page">
        {error ? <ErrorNote message={`账号读取失败：${error}，当前显示上次读取的结果。`} onRetry={() => void onRetry()} /> : null}
        <Card className="home-profile-card">
          <div className="home-empty">
            <Icon name="user" size={34} />
            <h2>还没有 QQ 账号</h2>
            <p>在“实例与监听”中注入并开始监听后，账号会出现在这里。</p>
            <Button variant="primary" icon="slots" onClick={onGoConnections}>去实例与监听</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-stack home-page">
      {error ? <ErrorNote message={`账号读取失败：${error}，当前显示上次读取的数据。`} onRetry={() => void onRetry()} /> : null}
      {account ? (
        <Card className="home-profile-card">
          <div className="home-profile">
            <AccountAvatar
              dataUrl={account.avatarDataUrl}
              label={account.avatarSource === 'local' ? `${account.accountId} 本地展示头像` : `${account.accountId} QQ 头像`}
              className="account-avatar large"
              iconSize={42}
            />
            <div className="home-identity">
              <h2 className="home-nickname">{nickname || '本地昵称未设置'}</h2>
              <div className="home-qq-number">QQ 号 <strong>{account.accountId}</strong></div>
              <p className={`home-signature${signature ? '' : ' is-empty'}`}>{signature || '还没有设置签名'}</p>
              <span className="home-display-note">昵称与签名保存在本地；头像优先使用本地设置，未设置时显示 QQ 公开头像</span>
              <div className="home-profile-actions">
                <Button size="sm" variant="ghost" icon="settings" onClick={() => onEditProfile(account.accountId)}>编辑展示资料</Button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="account-dock" role="toolbar" aria-orientation="horizontal" aria-label="选择主页 QQ 账号（左右方向键切换，Home 和 End 跳至首尾）"
        onMouseLeave={() => setHovered(undefined)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(undefined); }}>
        {list.map((item, index) => {
          const distance = hovered === undefined ? 0 : Math.abs(index - hovered);
          const nearby = hovered !== undefined && distance === 1;
          const online = onlineAccounts.has(item.accountId);
          const label = (item.nickname ?? '').trim() || item.accountId;
          return (
            <ControlButton
              type="button"
              aria-pressed={selected === item.accountId}
              aria-label={`${label}，${online ? '在线' : '未连接'}`}
              title={`${label} · QQ ${item.accountId} · ${online ? '在线' : '未连接'}`}
              tabIndex={tabStop === item.accountId ? 0 : -1}
              ref={element => { if (element) dockButtons.current.set(item.accountId, element); else dockButtons.current.delete(item.accountId); }}
              key={item.accountId}
              className={`dock-item${selected === item.accountId ? ' selected' : ''}${hovered === index ? ' hovered' : ''}${nearby ? ' nearby' : ''}`}
              onMouseEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onClick={() => setSelected(item.accountId)}
              onKeyDown={event => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                const next = event.key === 'ArrowRight' ? (index + 1) % list.length
                  : event.key === 'ArrowLeft' ? (index - 1 + list.length) % list.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : undefined;
                if (next === undefined) return;
                event.preventDefault();
                const id = list[next]!.accountId;
                setSelected(id);
                const button = dockButtons.current.get(id);
                button?.focus({ preventScroll: true });
                button?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
              }}
            >
              <AccountAvatar
                dataUrl={item.avatarDataUrl}
                label={item.avatarSource === 'local' ? `${item.accountId} 本地展示头像` : `${item.accountId} QQ 头像`}
              />
              <span className="dock-label">{label}</span>
              <span className={`dock-state${online ? ' is-online' : ''}`} aria-hidden="true" />
            </ControlButton>
          );
        })}
      </div>
    </div>
  );
}
