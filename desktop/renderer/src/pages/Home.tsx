import type { AccountsResponse } from '../types';
import { Button, ErrorNote, LoadingNote } from '../ui';
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

/** 首页只承载主题与进入工作台，不在此读取策略、绑定或修改账号。 */
export function HomePage({ accounts, selectedAccountId, loading, error, locked, onRetry, onGoWorkbench }: HomePageProps) {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const account = accounts?.accounts.find(item => item.accountId === selectedAccountId);
  return <div className="home-studio">
    <section className="home-hero" aria-label={night ? '晚风电台桌面' : '白昼来信桌面'}>
      <HomeScene />
      <div className="home-copy">
        <p className="home-eyebrow">{night ? 'STAY A LITTLE, LISTEN A LITTLE' : 'MAKE ROOM FOR EVERYDAY'}</p>
        <h1>{night ? <>把心事，<br /><span>交给今晚的风。</span></> : <>把日常，<br /><span>写成喜欢的样子。</span></>}</h1>
        {error ? <ErrorNote message={`账号资料更新失败${accounts ? '，当前显示上次资料' : ''}。`} onRetry={() => { void onRetry(); }} /> : null}
        {!accounts && loading ? <div className="home-state-panel"><LoadingNote label="正在读取账号资料…" /></div> : account ? <>
          <div className="home-account"><AccountAvatar dataUrl={account.avatarDataUrl} label={`${account.accountId} ${account.avatarSource === 'local' ? '本地展示' : 'QQ'}头像`} className="home-avatar" iconSize={28} />
            <div><h2 title={account.nickname?.trim() || account.accountId}>{account.nickname?.trim() || '本地昵称未设置'}</h2><p>QQ {account.accountId}</p></div>
          </div>
          <p className="home-account-signature" title={account.signature || undefined}>{account.signature || (night ? '灯还亮着，今晚的话可以慢慢说。' : '把小事慢慢说，把普通的日子认真过。')}</p>
          {!account.signature ? <span className="home-quiet-caption">主题寄语</span> : null}
        </> : <p className="home-welcome">{night ? '晚风已经到站，留一盏灯给自己。' : '新的一天，为日常留一个位置。'}</p>}
        <div className="home-primary-actions"><Button variant="entry" onClick={onGoWorkbench} disabled={locked}>进入工作台</Button></div>
      </div>
    </section>
  </div>;
}
