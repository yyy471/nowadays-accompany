import { useEffect, useRef, useState } from 'react';
import type { ProvidersResponse } from '../types';
import { ModelsPage } from '../pages/Models';
import { SettingsPage } from '../pages/Settings';
import { ControlButton, Modal } from '../ui';
import { useDraftProtection } from './DraftProtectionProvider';

export type SettingsTab = 'models' | 'snowluma' | 'appearance' | 'diagnostics';

const TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: 'models', label: '模型服务', description: '配置文本、视觉、视频和扩展模型服务。' },
  { id: 'snowluma', label: '连接', description: '配置 SnowLuma 与监听恢复。' },
  { id: 'appearance', label: '外观', description: '设置动效偏好。' },
  { id: 'diagnostics', label: '诊断', description: '查看运行信息、容量与诊断快照。' }
];


export function SettingsDialog({
  open,
  locked = false,
  initialTab,
  onTabChange,
  onGoAccountModels,
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
            <section hidden={tab !== 'models'} aria-label="模型服务设置">
              <ModelsPage data={providers} error={providersError} refresh={refreshProviders} onGoAccountModels={onGoAccountModels} />
            </section>
            <section hidden={tab === 'models'} aria-label="连接、外观与诊断设置">
              <SettingsPage section={tab === 'models' ? 'snowluma' : tab} />
            </section>
          </div>
        </div>
    </Modal>
  );
}
