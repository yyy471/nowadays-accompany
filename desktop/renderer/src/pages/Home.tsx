import { useEffect, useState } from 'react';
import type { AccountsResponse } from '../types';
import { Card, ControlButton, Icon } from '../ui';
import { AccountAvatar } from '../components/AccountAvatar';

export function HomePage({ accounts }: { accounts?: AccountsResponse }) {
  const list = accounts?.accounts ?? [];
  const [selected, setSelected] = useState('');
  const [hovered, setHovered] = useState<number>();
  const account = list.find((item) => item.accountId === selected);
  const nickname = account?.nickname ?? '';
  const signature = account?.signature ?? '';

  useEffect(() => {
    if (!selected && list.length) setSelected(list[0]!.accountId);
    if (selected && !list.some((item) => item.accountId === selected)) setSelected(list[0]?.accountId ?? '');
  }, [list, selected]);

  if (!list.length) {
    return <div className="page-stack home-page"><Card className="home-profile-card"><div className="home-empty"><Icon name="user" size={34} /><h2>还没有 QQ 账号</h2><p>账号登录后，主页会展示头像、昵称、QQ 号和签名。</p></div></Card></div>;
  }

  return (
    <div className="page-stack home-page">
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
            </div>
          </div>
        </Card>
      ) : null}

      <div className="account-dock" role="tablist" aria-label="选择主页 QQ 账号" onMouseLeave={() => setHovered(undefined)}>
        {list.map((item, index) => {
          const distance = hovered === undefined ? 0 : Math.abs(index - hovered);
          const nearby = hovered !== undefined && distance === 1;
          return (
            <ControlButton
              type="button"
              role="tab"
              aria-selected={selected === item.accountId}
              key={item.accountId}
              className={`dock-item${selected === item.accountId ? ' selected' : ''}${hovered === index ? ' hovered' : ''}${nearby ? ' nearby' : ''}`}
              onMouseEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onClick={() => setSelected(item.accountId)}
            >
              <AccountAvatar
                dataUrl={item.avatarDataUrl}
                label={item.avatarSource === 'local' ? `${item.accountId} 本地展示头像` : `${item.accountId} QQ 头像`}
              />
              <span>{(item.nickname ?? '').trim() || item.accountId}</span>
            </ControlButton>
          );
        })}
      </div>
    </div>
  );
}
