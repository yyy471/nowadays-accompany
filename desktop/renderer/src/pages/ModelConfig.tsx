import { useEffect, useState } from 'react';
import { ControlButton, Icon, Tag } from '../ui';
import type { AccountsResponse, CapabilityId, ProvidersResponse, SlotsResponse } from '../types';
import { ModelsPage } from './Models';
import { PolicyPage } from './Policy';
import { MODEL_CAPABILITY_ROWS, type ServiceStatusMap } from '../lib/model-capabilities';
import { createServiceWriteCoordinator, type ServiceWriteGuard } from '../lib/service-write-coordinator';

export type ModelConfigView = 'account' | 'services';

export function ModelConfigPage({
  view,
  onViewChange,
  providers,
  providersLoading,
  providersError,
  refreshProviders,
  accounts,
  accountsLoading,
  accountsError,
  slots,
  slotsLoading,
  slotsError,
  initialAccountId,
  onGoConnections,
  onRetryAccounts,
  onRetrySlots
}: {
  view: ModelConfigView;
  onViewChange: (view: ModelConfigView) => void;
  providers?: ProvidersResponse;
  providersLoading: boolean;
  providersError?: string;
  refreshProviders: () => Promise<unknown>;
  accounts?: AccountsResponse;
  accountsLoading: boolean;
  accountsError?: string;
  slots?: SlotsResponse;
  slotsLoading: boolean;
  slotsError?: string;
  initialAccountId?: string;
  onGoConnections: () => void;
  onRetryAccounts: () => Promise<void>;
  onRetrySlots: () => Promise<void>;
}) {
  const [capability, setCapability] = useState<CapabilityId>('chat');
  const [statuses, setStatuses] = useState<ServiceStatusMap>({});
  const [serviceBusy, setServiceBusy] = useState(false);
  const [writeCoordinator] = useState(createServiceWriteCoordinator);
  const [writeSnapshot, setWriteSnapshot] = useState(() => writeCoordinator.getSnapshot());
  useEffect(() => writeCoordinator.subscribe(() => setWriteSnapshot(writeCoordinator.getSnapshot())), [writeCoordinator]);
  const writeGuard: ServiceWriteGuard = {
    ...writeSnapshot,
    setIntents: writeCoordinator.setIntents,
    begin: writeCoordinator.begin,
    end: writeCoordinator.end
  };
  const primary = MODEL_CAPABILITY_ROWS.slice(0, 3);
  const extensions = MODEL_CAPABILITY_ROWS.slice(3);
  const renderCapability = (row: (typeof MODEL_CAPABILITY_ROWS)[number], index: number) => {
    const status = statuses[row.id];
    return <ControlButton key={row.id} type="button" className="model-capability-button" aria-pressed={capability === row.id}
      disabled={serviceBusy} onClick={() => setCapability(row.id)}>
      <span className="model-capability-icon" aria-hidden="true"><Icon name={index === 0 ? 'messages' : index === 1 ? 'overview' : index === 2 ? 'play' : index === 3 ? 'plus' : 'radio'} size={18} /></span>
      <span className="model-capability-copy"><strong>{row.title}</strong><small>{status?.summary ?? row.description}</small></span>
      <Tag tone={status?.tone ?? 'idle'}>{status?.label ?? '读取中'}</Tag>
    </ControlButton>;
  };
  return <div className="model-config-workspace">
    <nav className="model-config-views" aria-label="模型配置视图">
      <ControlButton type="button" aria-current={view === 'services' ? 'page' : undefined} onClick={() => onViewChange('services')}>服务与模型</ControlButton>
      <ControlButton type="button" aria-current={view === 'account' ? 'page' : undefined} onClick={() => onViewChange('account')}>账号使用</ControlButton>
      <span className="model-config-view-hint">先准备模型，再分配给需要它的账号。</span>
    </nav>
    <section className="model-config-view" hidden={view !== 'services'} inert={view !== 'services' || undefined} aria-label="服务与模型">
      <div className="model-workspace-grid">
        <aside className="model-capability-index" aria-label="模型能力索引">
          <div className="model-index-label"><span>日常所需</span><span>01—03</span></div>
          <div className="model-capability-list">
            {primary.map(renderCapability)}
            <div className="model-index-divider">按需添一点能力</div>
            {extensions.map((row, index) => renderCapability(row, index + 3))}
          </div>
          <div className="model-index-note"><Icon name="messages" size={18} /><h3>让回应，有自己的声音。</h3><p>文本模型负责日常对话。看图、读视频与生成内容，可以各选一位擅长的搭档。</p><span>一页配置，一点默契。<br />— Nowadays</span></div>
        </aside>
        <div className="model-paper-area">
          <ModelsPage
            data={providers}
            error={providersError}
            refresh={refreshProviders}
            writeGuard={writeGuard}
            capability={capability}
            onStatusChange={setStatuses}
            onBusyChange={setServiceBusy}
            onGoAccountModels={() => onViewChange('account')}
          />
        </div>
      </div>
    </section>
    <section className="model-config-view model-config-account" hidden={view !== 'account'} inert={view !== 'account' || undefined} aria-label="账号使用">
      <PolicyPage
        initialAccountId={initialAccountId}
        providers={providers}
        providersLoading={providersLoading}
        providersError={providersError}
        accounts={accounts}
        accountsLoading={accountsLoading}
        accountsError={accountsError}
        slots={slots}
        slotsLoading={slotsLoading}
        slotsError={slotsError}
        onGoModels={() => onViewChange('services')}
        onGoConnections={onGoConnections}
        onRetryAccounts={onRetryAccounts}
        onRetrySlots={onRetrySlots}
        onRetryProviders={async () => { await refreshProviders(); }}
      />
    </section>
  </div>;
}
