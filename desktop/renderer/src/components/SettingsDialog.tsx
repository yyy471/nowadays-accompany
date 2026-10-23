import { useEffect, useRef, useState } from 'react';
import type { ProvidersResponse } from '../types';
import { ModelsPage } from '../pages/Models';
import { SettingsPage } from '../pages/Settings';
import { ControlButton, Modal, useConfirm } from '../ui';

export type SettingsTab = 'models' | 'appearance' | 'snowluma';

const TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: 'models', label: '模型服务', description: '配置文本、视觉、视频和扩展模型服务。' },
  { id: 'appearance', label: '外观', description: '设置动效偏好。' },
  { id: 'snowluma', label: 'SnowLuma', description: '管理本地连接与运行信息。' }
];


export function SettingsDialog({
  open,
  initialTab,
  onRequestClose,
  providers,
  providersError,
  refreshProviders
}: {
  open: boolean;
  initialTab: SettingsTab;
  onRequestClose: () => void;
  providers?: ProvidersResponse;
  providersError?: string;
  refreshProviders: () => Promise<unknown>;
}) {
  const confirm = useConfirm();
  const closing = useRef(false);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [modelsDirty, setModelsDirty] = useState(false);
  const [snowlumaDirty, setSnowlumaDirty] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [snowlumaBusy, setSnowlumaBusy] = useState(false);
  const dirty = modelsDirty || snowlumaDirty;
  const busy = modelsBusy || snowlumaBusy;

  useEffect(() => { if (open) setTab(initialTab); }, [initialTab, open]);

  useEffect(() => {
    if (!open) {
      setModelsDirty(false);
      setSnowlumaDirty(false);
      setModelsBusy(false);
      setSnowlumaBusy(false);
    }
  }, [open]);

  const requestClose = async (): Promise<void> => {
    if (busy || closing.current) return;
    closing.current = true;
    try {
      if (dirty && !await confirm({ title: '放弃未保存的设置？', description: '关闭后，尚未保存的设置草稿会丢失。', confirmLabel: '放弃修改', cancelLabel: '继续编辑', tone: 'danger' })) return;
      setModelsDirty(false);
      setSnowlumaDirty(false);
      onRequestClose();
    } finally { closing.current = false; }
  };

  if (!open) return null;
  return (
    <Modal open={open} title="应用设置" eyebrow="NOWADAYS" className="settings-dialog" backdropClassName="settings-dialog-backdrop" headerClassName="settings-dialog-head"
      closeDisabled={busy} onClose={() => void requestClose()}
      headerExtra={busy ? <span className="settings-dialog-saving" role="status">正在处理，暂时无法关闭</span> : null}>
        <div className="settings-dialog-body">
          <nav className="settings-dialog-nav" aria-label="设置分类">
            {TABS.map((item) => (
              <ControlButton key={item.id} type="button" className={`settings-dialog-tab${tab === item.id ? ' active' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>
                <span>{item.label}</span><small>{item.description}</small>
              </ControlButton>
            ))}
          </nav>
          <div className="settings-dialog-content">
            <section hidden={tab !== 'models'} aria-label="模型服务设置">
              <ModelsPage data={providers} error={providersError} refresh={refreshProviders} onDirtyChange={setModelsDirty} onBusyChange={setModelsBusy} />
            </section>
            <section hidden={tab === 'models'} aria-label="外观与 SnowLuma 设置">
              <SettingsPage section={tab === 'appearance' ? 'appearance' : 'snowluma'} onDirtyChange={setSnowlumaDirty} onBusyChange={setSnowlumaBusy} />
            </section>
          </div>
        </div>
    </Modal>
  );
}
