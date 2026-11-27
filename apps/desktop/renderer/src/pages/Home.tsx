import { useEffect, useState, type ReactNode } from 'react';
import type { AccountsResponse } from '../types';
import { api } from '../api';
import { Button, ErrorNote, LoadingNote } from '../ui';
import { RoleFace, type RoleFaceImage } from '../components/RoleFace';
import { HomeScene } from '../components/home/HomeScene';
import { deriveOnboardingState, hasUsableChatBinding, type OnboardingSnapshot } from '../components/home/onboarding-steps';
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
  onOpenModelSettings?: () => void;
  onConfigureRoleModel?: () => void;
  onStartConversation?: () => void;
}

function ReadingGroup({ index, children }: { index: 0 | 1 | 2; children: ReactNode }) {
  return <div data-home-reading={index}>{children}</div>;
}

type OnboardingResource = { kind: string; enabled: boolean };
type OnboardingActivity = { roleId: string; state: string };
type OnboardingBinding = { capability?: string; resourceId?: string; modelName?: string | null; enabled?: boolean };

/** 首页承载主题与查看关系；起手引导只做只读旁路探测，不改动账号或绑定。 */
export function HomePage({ accounts, selectedAccountId, faceImage, outfitHomeUrl, outfitName, hasOutfits, loading, appearanceLoading, error, locked, retrying, onRetry, onGoWorkbench, onCreateRole, onOpenModelSettings, onConfigureRoleModel, onStartConversation }: HomePageProps) {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const account = accounts?.accounts.find(item => item.accountId === selectedAccountId);
  const accountCount = accounts?.accounts.length ?? 0;
  const [onboardingSnapshot, setOnboardingSnapshot] = useState<OnboardingSnapshot | null>(null);
  // 起手快照只做静默旁路读取：成功才展示，读取中或失败保持 null，不闪烁也不报红。
  useEffect(() => {
    const request = new AbortController();
    const { signal } = request;
    setOnboardingSnapshot(null);
    const bindings = selectedAccountId
      ? api<{ items: OnboardingBinding[] }>(`/v1/roles/${encodeURIComponent(selectedAccountId)}/bindings`, { signal })
      : Promise.resolve({ items: [] as OnboardingBinding[] });
    Promise.all([
      api<{ items: OnboardingResource[] }>('/v1/resources', { signal }),
      api<{ items: OnboardingActivity[] }>('/v1/activities', { signal }),
      bindings,
    ]).then(([resources, activities, roleBindings]) => {
      if (signal.aborted) return;
      setOnboardingSnapshot({
        hasRole: Boolean(selectedAccountId),
        roleId: selectedAccountId,
        hasEnabledModelService: resources.items.some(item => item.kind === 'model' && item.enabled),
        hasChatBinding: hasUsableChatBinding(roleBindings.items),
        roleActive: activities.items.some(item => item.roleId === selectedAccountId && item.state === 'active'),
      });
    }).catch(() => { /* 起手引导是辅助信息，读取失败时安静地不展示。 */ });
    return () => request.abort();
  }, [selectedAccountId, accountCount]);
  const onboarding = onboardingSnapshot ? deriveOnboardingState(onboardingSnapshot) : null;
  const showOnboarding = !!onboarding && onboarding.visible && !loading && !error;
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
          {showOnboarding && onboarding ? <section className="home-onboarding" aria-label="起手引导">
            <div className="home-onboarding-head">
              <strong>起手三步</strong>
              <span className="home-onboarding-progress">已完成 {onboarding.completedCount}/2 项准备</span>
            </div>
            <ol className="home-onboarding-steps">
              {onboarding.steps.map(step => {
                const action = step.id === 'model-service' ? onOpenModelSettings
                  : step.id === 'role-binding' ? (onboardingSnapshot?.hasRole ? onConfigureRoleModel : onCreateRole)
                  : onStartConversation;
                return <li key={step.id} className="home-onboarding-step" data-done={step.done ? 'true' : undefined} data-current={step.current ? 'true' : undefined}>
                  <span className="home-onboarding-badge" aria-hidden="true">{step.done ? '✓' : step.index}</span>
                  <div className="home-onboarding-copy">
                    <strong title={step.title}>{step.title}</strong>
                    <span className="home-onboarding-detail">{step.detail}</span>
                  </div>
                  <Button size="sm" variant={step.current ? 'primary' : 'default'} disabled={locked || step.disabled} onClick={() => action?.()}>{step.actionLabel}</Button>
                </li>;
              })}
            </ol>
          </section> : null}
        </ReadingGroup>
      </div>
    </section>
  </div>;
}
