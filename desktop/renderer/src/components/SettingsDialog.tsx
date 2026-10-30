import { useEffect, useRef, useState } from 'react';
import type { ProvidersResponse } from '../types';
import { Button, ControlButton, ErrorNote, Icon, Modal, Tag } from '../ui';
import { SettingsPage } from '../pages/Settings';
import { useDraftProtection } from './DraftProtectionProvider';

export type SettingsTab = 'models' | 'snowluma' | 'appearance' | 'diagnostics';

const TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: 'models', label: '模型服务', description: '查看服务摘要，或打开统一模型工作区。' },
  { id: 'snowluma', label: '连接', description: '配置 SnowLuma 与监听恢复。' },
  { id: 'appearance', label: '外观', description: '设置动效偏好。' },
  { id: 'diagnostics', label: '诊断', description: '查看运行信息、容量与诊断快照。' }
];

function ModelServicesSummary({
  providers,
  error,
  refresh,
  onOpen,
  onGoAccountModels,
  locked
}: {
  providers?: ProvidersResponse;
  error?: string;
  refresh: () => Promise<unknown>;
  onOpen?: () => Promise<{ ok: boolean; message?: string }>;
  onGoAccountModels?: () => void;
  locked?: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const open = async (): Promise<void> => {
    if (!onOpen || opening || locked) return;
    setOpening(true);
    setNotice(undefined);
    try {
      const result = await onOpen();
      if (!result.ok && result.message) setNotice(result.message);
    } finally { setOpening(false); }
  };
  const retry = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setNotice(undefined);
    try { await refresh(); } finally { setRefreshing(false); }
  };
  return <div className="settings-model-summary">
    <div className="settings-model-summary-head">
      <div>
        <h3>服务与模型已移到统一工作区</h3>
        <p>这里只保留只读摘要，避免设置和模型页面各维护一份服务草稿。</p>
      </div>
      <Tag tone="idle">只读摘要</Tag>
    </div>
    {error ? <ErrorNote message={providers ? `模型服务刷新失败：${error}，当前显示上次读取的数据。` : `无法读取模型服务：${error}`} onRetry={() => void retry()} /> : null}
    {notice ? <div className="notice notice-warn" role="status">{notice}</div> : null}
    {!providers ? (error ? null : <p className="muted">正在读取模型服务…</p>) : providers.providers.length === 0
      ? <p className="muted">还没有保存的模型服务。打开工作区后可以配置文本、视觉、视频与扩展模型。</p>
      : <ul className="settings-model-summary-list">{providers.providers.map((provider) => <li key={provider.id}>
        <span className="settings-model-summary-icon" aria-hidden="true"><Icon name="bolt" size={17} /></span>
        <span className="settings-model-summary-copy"><strong>{provider.id}</strong><small>{provider.baseUrl} · {provider.models.length} 个模型</small></span>
        <Tag tone={provider.credential.configured ? 'ok' : 'idle'}>{provider.credential.configured ? '密钥已保存' : '未保存密钥'}</Tag>
      </li>)}</ul>}
    <div className="settings-model-summary-actions">
      <Button variant="primary" disabled={locked || !onOpen} busy={opening} onClick={() => void open()}>打开服务与模型</Button>
      {onGoAccountModels ? <Button disabled={locked || opening} onClick={onGoAccountModels}>去账号使用</Button> : null}
      <Button variant="ghost" disabled={refreshing} busy={refreshing} onClick={() => void retry()}>刷新摘要</Button>
    </div>
    <p className="muted">保存服务后会回到账号使用；账号授权、模型绑定和工具开放仍需按账号单独配置。</p>
  </div>;
}


export function SettingsDialog({
  open,
  locked = false,
  initialTab,
  onTabChange,
  onGoAccountModels,
  onOpenModelServices,
  onRequestClose,
  providers,
  providersError,
  refreshProviders
}: {
  open: boolean;
  locked?: boolean;
  initialTab: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  onGoAccountModels?: () => void;
  onOpenModelServices?: () => Promise<{ ok: boolean; message?: string }>;
  onRequestClose: () => void;
  providers?: ProvidersResponse;
  providersError?: string;
  refreshProviders: () => Promise<unknown>;
}) {
  const { requestTransition } = useDraftProtection();
  const closing = useRef(false);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [closeNotice, setCloseNotice] = useState<string>();

  useEffect(() => { if (open) setTab(initialTab); }, [initialTab, open]);
  useEffect(() => { if (open) setCloseNotice(undefined); }, [open]);

  const requestClose = async (): Promise<void> => {
    if (locked || closing.current) return;
    closing.current = true;
    try {
      const result = await requestTransition({ scope: { kind: 'settings' }, actionLabel: '关闭设置' });
      if (result.ok) {
        setCloseNotice(undefined);
        onRequestClose();
      } else if (result.message) {
        setCloseNotice(result.message);
      }
    } finally { closing.current = false; }
  };

  return (
    <Modal open={open} title="应用设置" eyebrow="NOWADAYS" className="settings-dialog" backdropClassName="settings-dialog-backdrop" headerClassName="settings-dialog-head"
      closeDisabled={locked} onClose={() => void requestClose()}>
        <div className="settings-dialog-body" inert={locked || undefined}>
          {closeNotice ? <div className="notice notice-warn settings-dialog-notice" role="status">{closeNotice}</div> : null}
          <nav className="settings-dialog-nav" aria-label="设置分类">
            {TABS.map((item) => (
              <ControlButton key={item.id} type="button" className={`settings-dialog-tab${tab === item.id ? ' active' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => { if (locked) return; setTab(item.id); onTabChange?.(item.id); }}>
                <span>{item.label}</span><small>{item.description}</small>
              </ControlButton>
            ))}
          </nav>
          <div className="settings-dialog-content">
            <section hidden={tab !== 'models'} aria-label="模型服务摘要">
              <ModelServicesSummary providers={providers} error={providersError} refresh={refreshProviders}
                onOpen={onOpenModelServices} onGoAccountModels={onGoAccountModels} locked={locked} />
            </section>
            <section hidden={tab === 'models'} aria-label="连接、外观与诊断设置">
              <SettingsPage section={tab === 'models' ? 'snowluma' : tab} />
            </section>
          </div>
        </div>
    </Modal>
  );
}
