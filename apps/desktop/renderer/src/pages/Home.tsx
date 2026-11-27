import type { ReactNode } from 'react';
import type { AccountsResponse } from '../types';
import { Button, ErrorNote, LoadingNote } from '../ui';
import { RoleFace, type RoleFaceImage } from '../components/RoleFace';
import { HomeScene } from '../components/home/HomeScene';
import { useThemePreset } from '../ui/presets';

export interface HomePageProps {
  accounts?: AccountsResponse;
  selectedAccountId: string;
  faceImage?: RoleFaceImage;
  outfitHomeUrl?: string | null;
  outfitName?: string | null;
  loading: boolean;
  appearanceLoading: boolean;
  hasOutfits: boolean;
  error?: string;
  locked?: boolean;
  retrying?: boolean;
  onRetry: () => Promise<void>;
  onGoWorkbench: () => void;
  onCreateRole?: () => void;
}

function ReadingGroup({ index, children }: { index: 0 | 1 | 2; children: ReactNode }) {
  return <div data-home-reading={index}>{children}</div>;
}

/** 首页只承载主题与查看关系，不在此读取策略、绑定或修改账号。 */
export function HomePage({ accounts, selectedAccountId, faceImage, outfitHomeUrl, outfitName, hasOutfits, loading, appearanceLoading, error, locked, retrying, onRetry, onGoWorkbench, onCreateRole }: HomePageProps) {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const account = accounts?.accounts.find(item => item.accountId === selectedAccountId);
  return <div className="home-studio">
    <section className="home-hero" aria-label={night ? '晚风电台桌面' : '白昼来信桌面'}>
      <HomeScene key={selectedAccountId} outfitHomeUrl={appearanceLoading ? null : outfitHomeUrl} outfitName={outfitName} hasOutfits={hasOutfits}
        ready={!!account && !loading && !appearanceLoading && !error} />
      <div className="home-copy">
        <ReadingGroup index={0}>
          <p className="home-eyebrow">{night ? 'STAY A LITTLE, LISTEN A LITTLE' : 'MAKE ROOM FOR EVERYDAY'}</p>
          <h1>书房</h1>
        </ReadingGroup>
        {error ? <ErrorNote busy={retrying} message={accounts?.accounts.length ? '角色资料暂时无法更新，仍显示上次的内容。' : '暂时无法读取角色资料。'} onRetry={() => { void onRetry(); }} /> : null}
        <ReadingGroup index={1}>
          {!accounts && loading ? <div className="home-state-panel"><LoadingNote label="正在读取角色资料…" /></div> : account ? <>
            <div className="home-account"><RoleFace name={account.nickname || '未命名角色'} image={faceImage} />
              <div><h2 title={account.nickname?.trim() || account.accountId}>{account.nickname?.trim() || '未命名角色'}</h2></div>
            </div>
            {account.signature && <p className="home-account-signature" title={account.signature}>{account.signature}</p>}
          </> : !error && <p className="home-welcome">还没有角色。</p>}
        </ReadingGroup>
        <ReadingGroup index={2}>
          <div className="home-primary-actions">{!loading && accounts && accounts.accounts.length === 0 && onCreateRole ? <Button variant="entry" onClick={onCreateRole} disabled={locked}>创建角色</Button> : null}<Button variant="entry" onClick={onGoWorkbench} disabled={locked}>查看关系</Button></div>
        </ReadingGroup>
      </div>
    </section>
  </div>;
}
