import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountsResponse } from '../types';
import { Button, ErrorNote, LoadingNote, createMotionScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy } from '../ui';
import { AccountAvatar } from '../components/AccountAvatar';
import { HomeScene } from '../components/home/HomeScene';
import { useThemePreset } from '../ui/presets';

export interface HomePageProps {
  accounts?: AccountsResponse;
  selectedAccountId: string;
  loading: boolean;
  error?: string;
  locked?: boolean;
  onRetry: () => Promise<void>;
  onGoWorkbench: () => void;
}

function ReadingGroup({ index, children }: { index: 0 | 1 | 2; children: ReactNode }) {
  return <div data-home-reading={index}>{children}</div>;
}

/** 首页只承载主题与进入工作台，不在此读取策略、绑定或修改账号。 */
export function HomePage({ accounts, selectedAccountId, loading, error, locked, onRetry, onGoWorkbench }: HomePageProps) {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const account = accounts?.accounts.find(item => item.accountId === selectedAccountId);
  const policy = useMotionPolicy();
  const reduced = useRef(policy.reduced);
  reduced.current = policy.reduced;
  const host = useRef<HTMLDivElement>(null);
  const [scope] = useState(createMotionScope);
  useEffect(() => {
    const element = host.current;
    if (!element || reduced.current) return;
    const groups = [...element.querySelectorAll<HTMLElement>('[data-home-reading]')];
    const total = readMotionTime(element, '--nd-component-motion-page', 280);
    const stagger = readMotionTime(element, '--nd-component-motion-reading-stagger', 24);
    const maxDelay = readMotionTime(element, '--nd-component-motion-reading-delay-max', 72);
    const offset = readMotionPx(element, '--nd-component-motion-page-offset', 4);
    const ease = readMotionValue(element, '--nd-component-motion-ease', 'cubic-bezier(0.2, 0, 0, 1)');
    for (const [index, group] of groups.entries()) {
      const delay = Math.min(index * stagger, maxDelay);
      scope.run(group, [
        { opacity: 0.35, transform: `translateY(${offset}px)` },
        { opacity: 1, transform: 'translateY(0)' }
      ], { duration: Math.max(0, total - delay), delay, easing: ease, fill: 'backwards' });
    }
    return () => scope.cancelAll();
  }, [scope]);
  useEffect(() => {
    if (policy.reduced) scope.cancelAll();
  }, [policy.reduced, scope]);
  return <div className="home-studio" ref={host}>
    <section className="home-hero" aria-label={night ? '晚风电台桌面' : '白昼来信桌面'}>
      <HomeScene />
      <div className="home-copy">
        <ReadingGroup index={0}>
          <p className="home-eyebrow">{night ? 'STAY A LITTLE, LISTEN A LITTLE' : 'MAKE ROOM FOR EVERYDAY'}</p>
          <h1>{night ? <>把心事，<br /><span>交给今晚的风。</span></> : <>把日常，<br /><span>写成喜欢的样子。</span></>}</h1>
        </ReadingGroup>
        {error ? <ErrorNote message={`账号资料更新失败${accounts ? '，当前显示上次资料' : ''}。`} onRetry={() => { void onRetry(); }} /> : null}
        <ReadingGroup index={1}>
          {!accounts && loading ? <div className="home-state-panel"><LoadingNote label="正在读取账号资料…" /></div> : account ? <>
            <div className="home-account"><AccountAvatar dataUrl={account.avatarDataUrl} label={`${account.accountId} ${account.avatarSource === 'local' ? '本地展示' : 'QQ'}头像`} className="home-avatar" iconSize={28} />
              <div><h2 title={account.nickname?.trim() || account.accountId}>{account.nickname?.trim() || '本地昵称未设置'}</h2><p>QQ {account.accountId}</p></div>
            </div>
            <p className="home-account-signature" title={account.signature || undefined}>{account.signature || (night ? '灯还亮着，今晚的话可以慢慢说。' : '把小事慢慢说，把普通的日子认真过。')}</p>
            {!account.signature ? <span className="home-quiet-caption">主题寄语</span> : null}
          </> : <p className="home-welcome">{night ? '晚风已经到站，留一盏灯给自己。' : '新的一天，为日常留一个位置。'}</p>}
        </ReadingGroup>
        <ReadingGroup index={2}>
          <div className="home-primary-actions"><Button variant="entry" onClick={onGoWorkbench} disabled={locked}>进入工作台</Button></div>
        </ReadingGroup>
      </div>
    </section>
  </div>;
}
