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
  onEnter,
  onCreate,
  onRetry,
}: {
  roles: RoleListItem[];
  loading: boolean;
  error: string;
  onEnter: (roleId: string) => void;
  onCreate: () => void;
  onRetry: () => void;
}) {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const motion = useMotionPolicy();
  const [selected, setSelected] = useState(() => defaultEntryChoice(roles));
  const firstCard = useRef<HTMLButtonElement | null>(null);
  const cards = entryRoles(roles);
  const choice = resolveEntryChoice(roles, selected);

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
    <div className="role-entry" data-theme={night ? 'night' : 'day'} data-motion={motion.reduced ? 'reduced' : 'full'}>
      <header className="role-entry-header">
        <span className="role-entry-brand"><BrandMark/><span>Nowadays<small>A NOTE FOR YOUR EVERYDAY.</small></span></span>
        <span className="role-entry-caption">选择之后，主页、关系与对话都会停在这一位。</span>
      </header>
      <main className="role-entry-stage" aria-label="选择角色">
        <div className="role-entry-copy">
          <span className="role-entry-eyebrow">ENTRY / 选择角色</span>
          <h1>从哪一页，<br />开始今天？</h1>
          <p>每一位角色都有自己的设定、经历和对话窗口。选定一位进入书房，之后可以随时换人。</p>
        </div>
        {loading && cards.length === 0 ? <p className="role-entry-note" role="status">正在读取角色…</p>
          : error && cards.length === 0 ? <div className="role-entry-note" role="alert"><p>{error}</p><Button onClick={onRetry}>重试</Button></div>
            : <div className="role-entry-grid" role="list">
              {cards.map((role, index) => <button
                type="button"
                role="listitem"
                key={role.roleId}
                ref={index === 0 ? firstCard : undefined}
                className="role-entry-card"
                aria-pressed={role.roleId === choice}
                data-builtin={role.isBuiltin ? '' : undefined}
                onClick={() => setSelected(role.roleId)}
                onDoubleClick={() => onEnter(role.roleId)}
              >
                <span className="role-entry-figure"><RolePortrait roleId={role.roleId}/></span>
                <span className="role-entry-meta">
                  <span className="role-entry-name">{role.displayName}{entryBadge(role) && <em>{entryBadge(role)}</em>}</span>
                  <span className="role-entry-bio">{entrySubtitle(role)}</span>
                </span>
                <span className="role-entry-mark" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              </button>)}
              <button type="button" role="listitem" className="role-entry-card role-entry-new" onClick={onCreate}>
                <span className="role-entry-figure"><i aria-hidden="true">＋</i></span>
                <span className="role-entry-meta"><span className="role-entry-name">创建角色</span><span className="role-entry-bio">先填显示名与人设，之后再配置外观和模型。</span></span>
              </button>
            </div>}
        {error && cards.length > 0 && <p className="role-entry-note" role="alert">{error}</p>}
      </main>
      <footer className="role-entry-actions">
        <span className="role-entry-hint">{cards.length > 0 ? `共 ${cards.length} 位角色` : '还没有角色'}</span>
        <div className="role-entry-buttons">
          <Button variant="ghost" onClick={onCreate}>创建角色</Button>
          <Button variant="entry" disabled={!choice} onClick={() => choice && onEnter(choice)}>进入书房</Button>
        </div>
      </footer>
    </div>
  </UiThemeScope>;
}
