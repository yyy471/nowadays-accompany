import { useEffect, useRef, useState } from 'react';
import type { RoleListItem } from '../types';
import { Button, BrandMark, UiThemeScope, useMotionPolicy } from '../ui';
import { useThemePreset } from '../ui/presets';
import { RolePortrait } from '../components/RolePortrait';
import { defaultEntryChoice, entryBadge, entryRoles, entrySubtitle, resolveEntryChoice } from '../entry/role-entry';

/**
 * 冷启动选角页（DL-147）：进入工作区前先选一位角色。
 * 与关系页、对话页共享同一个「当前角色」，只在此处决定初始值。
 */
export function RoleEntry({
  roles,
  loading,
  error,
  errorSource,
  onEnter,
  onCreate,
  onRetry,
  retrying,
}: {
  roles: RoleListItem[];
  loading: boolean;
  error: string;
  errorSource: 'list' | 'details';
  onEnter: (roleId: string) => void;
  onCreate: () => void;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const motion = useMotionPolicy();
  const [selected, setSelected] = useState(() => defaultEntryChoice(roles));
  const firstCard = useRef<HTMLButtonElement | null>(null);
  const cards = entryRoles(roles);
  const choice = resolveEntryChoice(roles, selected);
  const errorTitle = errorSource === 'details' ? '角色资料暂时无法更新。'
    : cards.length ? '暂时无法更新角色列表。' : '暂时无法读取角色列表。';
  const reason = error.trim().split(/\r?\n/, 1)[0];
  const errorReason = reason === 'Failed to fetch' ? '无法连接本机服务。'
    : reason.length > 100 ? `${reason.slice(0, 100)}…` : reason;

  useEffect(() => {
    const next = resolveEntryChoice(roles, selected);
    if (next !== selected) setSelected(next);
  }, [roles, selected]);

  useEffect(() => {
    if (!loading && cards.length > 0) firstCard.current?.focus();
    // 只在首次载入后聚焦一次，避免轮询刷新抢走键盘焦点。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, cards.length === 0]);

  return <UiThemeScope theme="xiacheng" preset={preset} motion={motion.reduced ? 'reduced' : 'full'} className="role-entry-host">
    <div className="role-entry" data-ui-preset={preset} data-theme={night ? 'night' : 'day'} data-motion={motion.reduced ? 'reduced' : 'full'}>
      <header className="role-entry-header">
        <span className="role-entry-brand"><BrandMark/><span>Nowadays<small>A NOTE FOR YOUR EVERYDAY.</small></span></span>
      </header>
      <main className="role-entry-stage" aria-label="选择角色">
        <div className="role-entry-copy">
          <h1>选择角色</h1>
          <p>进书房后也可以换角色。</p>
        </div>
        <div className="role-entry-choices">
          {loading && cards.length === 0 && <p className="role-entry-note" role="status">正在读取角色…</p>}
          {error && <div className="role-entry-note" role="alert">
            <p>{errorTitle}{errorReason && <span className="role-entry-error-reason">{errorReason}</span>}</p>
            <Button busy={retrying} onClick={onRetry}>重试</Button>
          </div>}
          {cards.length > 0 && <div className="role-entry-grid" role="group" aria-label="角色列表">
              {cards.map((role, index) => <button
                type="button"
                key={role.roleId}
                ref={index === 0 ? firstCard : undefined}
                className="role-entry-card"
                aria-pressed={role.roleId === choice}
                data-builtin={role.isBuiltin ? '' : undefined}
                onClick={() => setSelected(role.roleId)}
                onDoubleClick={() => onEnter(role.roleId)}
              >
                <span className="role-entry-figure"><RolePortrait roleId={role.roleId}/><span className="role-entry-seal" aria-hidden="true">此位</span></span>
                <span className="role-entry-meta">
                  <span className="role-entry-name"><strong title={role.displayName}>{role.displayName}</strong>{entryBadge(role) && <em>{entryBadge(role)}</em>}</span>
                  <span className="role-entry-bio">{entrySubtitle(role)}</span>
                </span>
              </button>)}
            </div>}
        </div>
      </main>
      <footer className="role-entry-actions">
        <span className="role-entry-hint">{cards.length > 0 ? `${cards.length} 位角色` : null}</span>
        <div className="role-entry-buttons">
          <Button variant="ghost" onClick={onCreate}>创建角色</Button>
          <Button variant="entry" disabled={!choice} onClick={() => choice && onEnter(choice)}>进入书房</Button>
        </div>
      </footer>
    </div>
  </UiThemeScope>;
}
