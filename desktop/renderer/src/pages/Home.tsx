import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import type { AccountSummary, AccountsResponse } from '../types';
import { Card, ControlButton, ErrorNote, Icon } from '../ui';

interface DisplayProfile {
  nickname: string;
  signature: string;
  avatarDataUrl?: string;
}

const EMPTY_DISPLAY: DisplayProfile = { nickname: '', signature: '' };

export function HomePage({ accounts }: { accounts?: AccountsResponse }) {
  const list = accounts?.accounts ?? [];
  const idsKey = useMemo(() => list.map((item) => item.accountId).sort().join('|'), [list]);
  const [selected, setSelected] = useState('');
  const [hovered, setHovered] = useState<number>();
  const [displayByAccount, setDisplayByAccount] = useState<Record<string, DisplayProfile>>({});
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const account = list.find((item) => item.accountId === selected);
  const display = account ? displayByAccount[account.accountId] ?? EMPTY_DISPLAY : EMPTY_DISPLAY;

  useEffect(() => {
    if (!selected && list.length) setSelected(list[0]!.accountId);
    if (selected && !list.some((item) => item.accountId === selected)) setSelected(list[0]?.accountId ?? '');
  }, [list, selected]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const ids = idsKey ? idsKey.split('|') : [];
    if (!ids.length) return;
    void Promise.all(ids.map(async (accountId) => {
      if (displayByAccount[accountId]) return undefined;
      try {
        const result = await api<{ display: DisplayProfile }>(`/accounts/${encodeURIComponent(accountId)}/display`);
        return [accountId, result.display] as const;
      } catch (loadError) {
        if (requestGeneration === generation.current) setError(errorMessage(loadError));
        return undefined;
      }
    })).then((loaded) => {
      if (requestGeneration !== generation.current) return;
      const entries = loaded.filter((entry): entry is readonly [string, DisplayProfile] => Boolean(entry));
      if (entries.length) setDisplayByAccount((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => { generation.current += 1; };
  }, [displayByAccount, idsKey]);

  if (!list.length) {
    return <div className="page-stack home-page"><Card className="home-profile-card"><div className="home-empty"><Icon name="user" size={34} /><h2>还没有 QQ 账号</h2><p>账号登录后，主页会展示头像、昵称、QQ 号和签名。</p></div></Card></div>;
  }

  return (
    <div className="page-stack home-page">
      {error ? <ErrorNote message={error} /> : null}
      {account ? (
        <Card className="home-profile-card">
          <div className="home-profile">
            <AccountAvatar account={account} large />
            <div className="home-identity">
              <h2 className="home-nickname">{display.nickname || '本地昵称未设置'}</h2>
              <div className="home-qq-number">QQ 号 <strong>{account.accountId}</strong></div>
              <p className={`home-signature${display.signature ? '' : ' is-empty'}`}>{display.signature || '还没有设置签名'}</p>
              <span className="home-display-note">昵称与签名保存在本地；头像优先使用本地设置，未设置时显示 QQ 公开头像</span>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="account-dock" role="tablist" aria-label="选择主页 QQ 账号" onMouseLeave={() => setHovered(undefined)}>
        {list.map((item, index) => {
          const distance = hovered === undefined ? 0 : Math.abs(index - hovered);
          const nearby = hovered !== undefined && distance === 1;
          const itemDisplay = displayByAccount[item.accountId] ?? EMPTY_DISPLAY;
          return (
            <ControlButton
              type="button"
              role="tab"
              aria-selected={selected === item.accountId}
              key={item.accountId}
              className={`dock-item${selected === item.accountId ? ' selected' : ''}${hovered === index ? ' hovered' : ''}${nearby ? ' nearby' : ''}`}
              onMouseEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onClick={() => { setSelected(item.accountId); setError(undefined); }}
            >
              <AccountAvatar account={item} />
              <span>{itemDisplay.nickname.trim() || item.accountId}</span>
            </ControlButton>
          );
        })}
      </div>
    </div>
  );
}

function AccountAvatar({ account, large = false }: { account: AccountSummary; large?: boolean }) {
  const label = account.avatarSource === 'local'
    ? `${account.accountId} 本地展示头像`
    : account.avatarDataUrl ? `${account.accountId} QQ 头像` : 'QQ 默认头像占位';
  return (
    <span className={`account-avatar${large ? ' large' : ''}`} role="img" aria-label={label}>
      {account.avatarDataUrl ? <img src={account.avatarDataUrl} alt="" /> : <span className="avatar-fallback"><Icon name="user" size={large ? 42 : 23} /></span>}
    </span>
  );
}
